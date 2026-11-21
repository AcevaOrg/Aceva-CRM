import { Inject, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { type OnGatewayConnection, type OnGatewayDisconnect, type OnGatewayInit, WebSocketGateway, WebSocketServer } from '@nestjs/websockets';
import {
  CLIENT_EVENTS,
  REALTIME_PATH,
  SOCKET_EVENTS_PER_SECOND,
  type ClientToServerEvents,
  type ConversationKind,
  type RealtimeCloseReason,
  type RealtimeRefusal,
  type ServerToClientEvents,
  type SyncReply,
} from '@aceva/contracts';
import type { Server, Socket } from 'socket.io';
import type { Actor } from '../../access/access.types';
import { PermissionService } from '../../access/permission.service';
import { AuthStateService } from '../../auth/auth-state.service';
import { SESSION_COOKIE } from '../../auth/session/session-cookie';
import { SESSION_ENDED_TOPIC, SessionService, sessionDeadline } from '../../auth/session/session.service';
import { ACCESS_CHANGED_TOPIC } from '../../access/access-change.notifier';
import { Clock } from '../../common/clock';
import { ENV } from '../../config/config.module';
import { backgroundWorkersOn, type Env } from '../../config/env';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeBus } from '../../redis/realtime-bus.service';
import { CommsAccessService } from '../comms-access.service';
import { commsDb } from '../comms-errors';
import { ConnectionRegistry, RegistryUnavailableError } from './connection-registry.service';
import { RefusalCounter, TokenBucket, clientAddress, originAllowed, readCookie } from './socket-rules';

export const COMMS_USE = 'comms.use';
/** Relay topic: someone's presence may have changed (payload: their internal id only). */
export const PRESENCE_TOPIC = 'presence';

/** Connection attempts allowed per client address and per session in one minute (reconnect storms, scripted abuse). */
export const ATTEMPTS_PER_MINUTE_PER_ADDRESS = 300;
export const ATTEMPTS_PER_MINUTE_PER_SESSION = 30;
/** Every packet (events and acknowledgements) from one socket: a flood past this closes the socket. */
const PACKETS_PER_SECOND = SOCKET_EVENTS_PER_SECOND * 2;
const REVALIDATE_EVERY_MS = 60_000;
const PRESENCE_REFRESH_EVERY_MS = 30_000;

export interface CommsSocketData {
  actor: Actor;
  employeeId: string;
  sessionId: string;
  /** This socket's entry in the connection registry. */
  member: string;
  /** When the session ends if nothing happens (its idle limit, or its 12-hour end): the socket is re-checked then. */
  deadline: number;
  /** The socket finished connecting (from then on, handleDisconnect gives its place back). */
  joined?: boolean;
  expiryTimer?: NodeJS.Timeout;
}

export type CommsSocket = Socket<ClientToServerEvents, ServerToClientEvents, Record<string, never>, CommsSocketData>;
export type CommsServer = Server<ClientToServerEvents, ServerToClientEvents, Record<string, never>, CommsSocketData>;

export const conversationRoom = (conversationId: string) => `conv:${conversationId}`;
export const employeeRoom = (employeeId: string) => `emp:${employeeId}`;
const sessionRoom = (sessionId: string) => `sess:${sessionId}`;

function refusal(code: RealtimeRefusal): Error {
  const error = new Error(code) as Error & { data: { code: RealtimeRefusal } };
  error.data = { code };
  return error;
}

/**
 * Module 14, part 2: the live connection (Socket.IO over WebSocket only, see RealtimeAdapter).
 *
 * Connecting: the HttpOnly session cookie is checked exactly like a REST request (not ended, within the idle and the
 * 12-hour limits, login finished, still employed, has comms.use) but WITHOUT counting as activity: an open socket never
 * keeps a session alive. Each person may have five sockets across every server; Redis being down refuses new ones.
 *
 * Staying connected: the session is re-checked (read-only) every minute and at its 12-hour end; and whenever a session
 * ends anywhere (logout, timeout, forced logout, password change, leaving), every server closes its sockets at once.
 *
 * Rooms are joined only by the server, from the database: never on the browser's request. They are a convenience;
 * CommsRealtimeDelivery still checks every recipient against the database on every delivery.
 */
@WebSocketGateway({ path: REALTIME_PATH })
export class CommsGateway implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('CommsGateway');
  @WebSocketServer() server!: CommsServer;
  private timers: NodeJS.Timeout[] = [];

  constructor(
    private readonly sessions: SessionService,
    private readonly authState: AuthStateService,
    private readonly permissions: PermissionService,
    private readonly prisma: PrismaService,
    private readonly access: CommsAccessService,
    private readonly registry: ConnectionRegistry,
    private readonly bus: RealtimeBus,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  afterInit(server: CommsServer): void {
    server.use((socket, next) => {
      this.admit(socket as CommsSocket).then(
        () => next(),
        (error: unknown) => {
          const code = (error as { data?: { code?: RealtimeRefusal } }).data?.code;
          if (!code) this.logger.warn(`Connection check failed: ${(error as Error).name}`);
          next(refusal(code ?? 'realtime_unavailable'));
        },
      );
    });
  }

  onApplicationBootstrap(): void {
    this.bus.on(SESSION_ENDED_TOPIC, (payload) => this.onSessionEnded(payload));
    this.bus.on(PRESENCE_TOPIC, (payload) => this.onPresence(payload));
    this.bus.on(ACCESS_CHANGED_TOPIC, (payload) => this.onAccessChanged(payload));
    this.bus.onResume(() => this.server?.emit('sync.required', { reason: 'relay_reconnected' }));
    if (backgroundWorkersOn(this.env)) {
      this.timers.push(setInterval(() => void this.revalidate().catch(() => undefined), REVALIDATE_EVERY_MS).unref());
      this.timers.push(setInterval(() => void this.refreshPresence().catch(() => undefined), PRESENCE_REFRESH_EVERY_MS).unref());
    }
  }

  onModuleDestroy(): void {
    for (const t of this.timers) clearInterval(t);
    this.timers = [];
  }

  /** The sockets connected to THIS server. */
  localSockets(): CommsSocket[] {
    return this.server ? [...this.server.sockets.sockets.values()] : [];
  }

  /** This server's sockets in a room. */
  socketsIn(room: string): CommsSocket[] {
    const ids = this.server?.sockets.adapter.rooms.get(room);
    if (!ids) return [];
    return [...ids].map((id) => this.server.sockets.sockets.get(id)).filter((s): s is CommsSocket => !!s);
  }

  // ---------------------------------------------------------------- connecting

  private async admit(socket: CommsSocket): Promise<void> {
    const request = socket.request;
    if (!originAllowed(request.headers.origin, this.env.CORS_ORIGIN)) throw refusal('origin_not_allowed');
    try {
      if (!(await this.registry.attempt(`addr:${clientAddress(request, this.env.TRUST_PROXY)}`, ATTEMPTS_PER_MINUTE_PER_ADDRESS, 60_000))) throw refusal('too_many_attempts');
    } catch (error) {
      if (error instanceof RegistryUnavailableError) throw refusal('realtime_unavailable');
      throw error;
    }

    const token = readCookie(request.headers.cookie, SESSION_COOKIE);
    if (!token) throw refusal('unauthenticated');
    const check = await this.sessions.authenticate(token, { financeScreen: false, passive: true });
    if (!check.ok) throw refusal('unauthenticated');
    const session = check.session;

    try {
      if (!(await this.registry.attempt(`sess:${session.id}`, ATTEMPTS_PER_MINUTE_PER_SESSION, 60_000))) throw refusal('too_many_attempts');
    } catch (error) {
      if (error instanceof RegistryUnavailableError) throw refusal('realtime_unavailable');
      throw error;
    }

    const { actor, hasFinanceDuty } = await this.checkPerson(session.employeeId, session.id, session.twoFactorVerified);
    // Redis lost the session (rebuilt from PostgreSQL): where the last activity was is unknown, so people with Finance
    // duty get the finance limit.
    if (session.financeActivity === undefined && hasFinanceDuty) {
      const strict = await this.sessions.validateById(session.id, { financeFallback: true });
      if (!strict.ok) throw refusal('unauthenticated');
    }
    const member = `${this.bus.instanceId}:${socket.id}`;
    let claimed: { cameOnline: boolean } | null;
    try {
      claimed = await this.registry.claim(actor.id, member, this.clock.now().getTime());
    } catch {
      throw refusal('realtime_unavailable');
    }
    if (!claimed) throw refusal('too_many_connections');
    socket.data = { actor, employeeId: actor.id, sessionId: session.id, member, deadline: sessionDeadline(session, hasFinanceDuty) };
    // The browser may go away while it is being checked (a page that navigates on). Socket.IO then drops the socket
    // without any disconnect event, so the place taken above is given back here (otherwise the person would look
    // online, and hold one of their five places, until the entry expires).
    const giveBack = () => {
      if (socket.data.joined) return;
      void this.release(actor.id, member);
    };
    if (socket.conn.readyState !== 'open') {
      giveBack();
      throw refusal('unauthenticated');
    }
    socket.conn.once('close', giveBack);
    if (claimed.cameOnline) void this.bus.publish(PRESENCE_TOPIC, { employeeId: actor.id });
  }

  /** The same person rules as AccessGuard: login allowed and finished, not left, and permission to use Module 14. */
  private async checkPerson(employeeId: string, sessionId: string, twoFactorVerified: boolean): Promise<{ actor: Actor; hasFinanceDuty: boolean }> {
    const state = await this.authState.get(employeeId);
    if (!state || !state.canLogIn) {
      await this.sessions.end(sessionId, 'employee_left');
      throw refusal('unauthenticated');
    }
    if (this.authState.stage(state, twoFactorVerified) !== 'ok') throw refusal('auth_incomplete');
    const employee = await this.prisma.employee.findUnique({
      where: { id: employeeId },
      select: { id: true, empId: true, fullName: true, status: true, level: { select: { number: true } }, role: { select: { key: true } } },
    });
    if (!employee || employee.status === 'left') throw refusal('unauthenticated');
    const access = await this.permissions.getEffectiveAccess(employee.id);
    if (!access.permissions.has(COMMS_USE)) throw refusal('forbidden');
    return {
      actor: { id: employee.id, empId: employee.empId, fullName: employee.fullName, levelNumber: employee.level.number, roleKey: employee.role.key },
      hasFinanceDuty: state.hasFinanceDuty,
    };
  }

  async handleConnection(socket: CommsSocket): Promise<void> {
    if (!socket.data?.actor) {
      socket.disconnect(true);
      return;
    }
    socket.data.joined = true;
    this.installLimits(socket);
    socket.on('sync', (ack) => void this.onSync(socket, ack));
    const { employeeId, sessionId } = socket.data;
    socket.join([employeeRoom(employeeId), sessionRoom(sessionId)]);
    this.armExpiry(socket);
    try {
      await this.refreshRooms(socket, false);
      const peers = await this.sharedPeers(employeeId);
      const online = await this.registry.onlineAmong(peers.map((p) => p.id), this.clock.now().getTime());
      socket.emit('presence.snapshot', { online: peers.filter((p) => online.has(p.id)).map((p) => p.empId).sort() });
    } catch (error) {
      this.logger.warn(`Socket setup failed: ${(error as Error).name}`);
    }
  }

  async handleDisconnect(socket: CommsSocket): Promise<void> {
    const data = socket.data;
    if (!data?.member) return;
    if (data.expiryTimer) clearTimeout(data.expiryTimer);
    await this.release(data.employeeId, data.member);
  }

  private async release(employeeId: string, member: string): Promise<void> {
    const wentOffline = await this.registry.release(employeeId, member, this.clock.now().getTime());
    if (wentOffline) await this.bus.publish(PRESENCE_TOPIC, { employeeId });
  }

  /** 20 events a second per socket (decision: socket limits); unknown events and floods close the socket. */
  private installLimits(socket: CommsSocket): void {
    const events = new TokenBucket(SOCKET_EVENTS_PER_SECOND, SOCKET_EVENTS_PER_SECOND, Date.now());
    const eventRefusals = new RefusalCounter(SOCKET_EVENTS_PER_SECOND);
    const packets = new TokenBucket(PACKETS_PER_SECOND, PACKETS_PER_SECOND, Date.now());
    const packetRefusals = new RefusalCounter(PACKETS_PER_SECOND);
    socket.use((packet, next) => {
      const [event, ...args] = packet as [string, ...unknown[]];
      if (!(CLIENT_EVENTS as readonly string[]).includes(event)) {
        this.close(socket, 'unknown_event');
        return;
      }
      if (!events.take(Date.now())) {
        const ack = args[args.length - 1];
        if (typeof ack === 'function') (ack as (r: unknown) => void)({ error: 'rate_limited' });
        if (eventRefusals.hit(Date.now())) this.close(socket, 'rate_limited');
        return;
      }
      next();
    });
    socket.conn.on('packet', (p: { type: string }) => {
      if (p.type !== 'message') return;
      if (!packets.take(Date.now()) && packetRefusals.hit(Date.now())) this.close(socket, 'rate_limited');
    });
  }

  private async onSync(socket: CommsSocket, ack: unknown): Promise<void> {
    if (typeof ack !== 'function') return;
    const reply = ack as (r: SyncReply | { error: 'invalid' }) => void;
    try {
      // The conversation list is only for someone who may still use messaging (checked now, not at the last re-check).
      if (!(await this.permissions.can(socket.data.employeeId, COMMS_USE))) {
        this.close(socket, 'forbidden');
        return;
      }
      const rows = await this.refreshRooms(socket, true);
      reply({ conversations: rows.map((r) => ({ id: r.id, lastSeq: r.last_seq })) });
    } catch {
      reply({ error: 'invalid' });
    }
  }

  // ---------------------------------------------------------------- rooms

  /** Conversations this person can see now (the same rule as every REST list). */
  async visibleConversations(actor: Actor): Promise<Array<{ id: string; last_seq: number; kind: ConversationKind }>> {
    const ctx = await this.access.actorContext(actor);
    return commsDb(() =>
      this.prisma.$queryRaw<Array<{ id: string; last_seq: number; kind: ConversationKind }>>`
        SELECT c."id", c."last_seq", c."kind"::text AS "kind" FROM "conversations" c WHERE ${this.access.visibleSql(actor.id, ctx.departmentId)}`,
    );
  }

  /**
   * Puts the socket in exactly the rooms of the conversations its person can see now. With `announce`, the screen is
   * told about every conversation it lost (`conversation.removed`) or gained (`conversation.changed`).
   */
  private async refreshRooms(socket: CommsSocket, announce: boolean): Promise<Array<{ id: string; last_seq: number; kind: ConversationKind }>> {
    const rows = await this.visibleConversations(socket.data.actor);
    const want = new Map(rows.map((r) => [conversationRoom(r.id), r]));
    for (const room of [...socket.rooms]) {
      if (room.startsWith('conv:') && !want.has(room)) {
        socket.leave(room);
        if (announce) socket.emit('conversation.removed', { conversationId: room.slice(5) });
      }
    }
    const joined = [...want.keys()].filter((room) => !socket.rooms.has(room));
    if (joined.length) {
      socket.join(joined);
      if (announce) for (const room of joined) socket.emit('conversation.changed', { conversationId: want.get(room)!.id, kind: want.get(room)!.kind });
    }
    return rows;
  }

  // ---------------------------------------------------------------- staying valid

  /**
   * Re-checks this server's sockets (read-only: nothing here counts as activity). Runs every minute; tests call it.
   * Catches anything a lost "session ended" signal would have missed, and follows department moves for the rooms.
   */
  async revalidate(): Promise<void> {
    await this.recheck(this.localSockets());
  }

  private async recheck(sockets: CommsSocket[]): Promise<void> {
    const bySession = new Map<string, CommsSocket[]>();
    for (const s of sockets) {
      if (!s.data?.sessionId || !s.connected) continue;
      bySession.set(s.data.sessionId, [...(bySession.get(s.data.sessionId) ?? []), s]);
    }
    for (const [sessionId, group] of bySession) {
      try {
        const state = await this.authState.get(group[0].data.employeeId);
        const financeFallback = !!state?.hasFinanceDuty;
        const check = await this.sessions.validateById(sessionId, { financeFallback });
        if (!check.ok) {
          group.forEach((s) => this.close(s, 'session_ended'));
          continue;
        }
        try {
          await this.checkPerson(check.session.employeeId, sessionId, check.session.twoFactorVerified);
          // Still valid (the person was active meanwhile): the next check is at the new deadline.
          const deadline = sessionDeadline(check.session, financeFallback);
          for (const s of group) {
            s.data.deadline = deadline;
            this.armExpiry(s);
          }
        } catch (error) {
          const code = (error as { data?: { code?: RealtimeRefusal } }).data?.code;
          group.forEach((s) => this.close(s, code === 'forbidden' ? 'forbidden' : 'session_ended'));
          continue;
        }
        for (const s of group) await this.refreshRooms(s, true);
      } catch (error) {
        this.logger.warn(`Re-check failed: ${(error as Error).name}`);
      }
    }
  }

  /** A session ends exactly when its idle limit or its 12-hour end is reached: the socket is re-checked at that moment. */
  private armExpiry(socket: CommsSocket): void {
    if (socket.data.expiryTimer) clearTimeout(socket.data.expiryTimer);
    const delay = Math.min(Math.max(socket.data.deadline - this.clock.now().getTime() + 1_000, 1_000), 2_147_000_000);
    socket.data.expiryTimer = setTimeout(() => void this.recheck([socket]), delay).unref();
  }

  /**
   * Someone's access changed (a department move, a new department head, a level, role or duty change): their sockets on
   * this server are re-checked at once. Losing comms.use closes them; gained or lost conversations are announced.
   */
  private async onAccessChanged(payload: unknown): Promise<void> {
    const empIds = (payload as { empIds?: unknown })?.empIds;
    if (!Array.isArray(empIds) || !empIds.length) return;
    const wanted = new Set(empIds.filter((e): e is string => typeof e === 'string'));
    const sockets = this.localSockets().filter((s) => s.data?.actor && wanted.has(s.data.actor.empId));
    if (sockets.length) await this.recheck(sockets);
  }

  private async onSessionEnded(payload: unknown): Promise<void> {
    const sessionId = (payload as { sessionId?: unknown })?.sessionId;
    if (typeof sessionId !== 'string') return;
    for (const s of this.socketsIn(sessionRoom(sessionId))) this.close(s, 'session_ended');
  }

  close(socket: CommsSocket, reason: RealtimeCloseReason): void {
    if (!socket.connected) return;
    if (reason === 'session_ended') socket.emit('session.ended', { reason: 'session_ended' });
    else socket.emit('closing', { reason });
    socket.disconnect(true);
  }

  // ---------------------------------------------------------------- presence

  /** People who share a DM or a group with this person (presence is shown to them only: decision D4). */
  async sharedPeers(employeeId: string): Promise<Array<{ id: string; empId: string }>> {
    return commsDb(() =>
      this.prisma.$queryRaw<Array<{ id: string; empId: string }>>`
        SELECT DISTINCT e."id", e."emp_id" AS "empId"
        FROM "conversation_members" a
        JOIN "conversations" c ON c."id" = a."conversation_id" AND c."kind" IN ('dm', 'group')
        JOIN "conversation_members" b ON b."conversation_id" = a."conversation_id" AND b."left_at" IS NULL AND b."employee_id" <> a."employee_id"
        JOIN "employees" e ON e."id" = b."employee_id" AND e."status" <> 'left'
        WHERE a."employee_id" = ${employeeId}::uuid AND a."left_at" IS NULL`,
    );
  }

  /** Someone's presence may have changed: tell this server's sockets of the people who may see it, with the CURRENT state. */
  private async onPresence(payload: unknown): Promise<void> {
    const employeeId = (payload as { employeeId?: unknown })?.employeeId;
    if (typeof employeeId !== 'string' || !this.localSockets().length) return;
    const peers = await this.sharedPeers(employeeId);
    const targets = peers.map((p) => employeeRoom(p.id)).filter((room) => this.server.sockets.adapter.rooms.has(room));
    if (!targets.length) return;
    const person = await this.prisma.employee.findUnique({ where: { id: employeeId }, select: { empId: true } });
    if (!person) return;
    const online = (await this.registry.onlineAmong([employeeId], this.clock.now().getTime())).has(employeeId);
    this.server.to(targets).emit('presence', { empId: person.empId, online });
  }

  /** Keeps this server's connection entries alive and reports people whose entries ran out (a server that stopped). */
  async refreshPresence(): Promise<void> {
    await this.keepAlive();
    await this.sweepPresence();
  }

  /** Refreshes this server's own connection entries (every 30 seconds). */
  async keepAlive(): Promise<void> {
    await this.registry.refresh(
      this.localSockets()
        .filter((s) => s.data?.member)
        .map((s) => ({ employeeId: s.data.employeeId, member: s.data.member })),
      this.clock.now().getTime(),
    );
  }

  /** People whose every entry ran out (their server stopped without saying goodbye) are announced offline. */
  async sweepPresence(): Promise<void> {
    for (const employeeId of await this.registry.sweepExpired(this.clock.now().getTime())) await this.bus.publish(PRESENCE_TOPIC, { employeeId });
  }
}
