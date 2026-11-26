import { Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import type { LiveMessageView } from '@aceva/contracts';
import type { Actor } from '../../access/access.types';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeBus } from '../../redis/realtime-bus.service';
import { CommsAccessService, conversationInclude, type ConversationRow } from '../comms-access.service';
import { commsDb } from '../comms-errors';
import { ConversationService } from '../conversation.service';
import { MessageViewBuilder, messageSelect, type MessageRow } from '../message-views';
import { COMMS_TOPIC, type CommsSignal } from './comms-realtime.publisher';
import { COMMS_USE, CommsGateway, conversationRoom, employeeRoom, type CommsSocket } from './comms.gateway';

/** Nobody: a message rendered "for nobody" has savedByMe = false and nothing else personal. */
const NO_VIEWER = '00000000-0000-0000-0000-000000000000';
/** How long a browser has to acknowledge a new message before it is simply not marked delivered. */
const ACK_TIMEOUT_MS = 30_000;
/** Acknowledgements are written together, at most this often per person and conversation. */
const DELIVERED_FLUSH_MS = 250;

/**
 * Module 14, part 2: what each server does when a change signal arrives (from itself or another server).
 *
 * The signal is only a pointer. This server reads the CURRENT state from PostgreSQL (M14.1 stays the source of truth),
 * renders the message once, and then decides for EVERY recipient socket, from the database, at this moment:
 *  - is this person a member now (member rows, or the department's current people and head)? if not, the socket leaves
 *    the room and is told the conversation is gone;
 *  - does their history start before this message (seq > fromSeq: joined_seq / department_channel_access.from_seq)?
 *    if not, they get nothing (a message from before they joined does not exist for them).
 * Signals for one conversation are handled one after another, so a later state is never overwritten by an earlier one.
 */
@Injectable()
export class CommsRealtimeDelivery implements OnApplicationBootstrap {
  private readonly logger = new Logger('CommsDelivery');
  private readonly chains = new Map<string, Promise<void>>();
  private readonly pendingDelivered = new Map<string, { actor: Actor; conversationId: string; seq: number; timer: NodeJS.Timeout }>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CommsAccessService,
    private readonly views: MessageViewBuilder,
    private readonly conversations: ConversationService,
    private readonly gateway: CommsGateway,
    private readonly bus: RealtimeBus,
  ) {}

  onApplicationBootstrap(): void {
    this.bus.on(COMMS_TOPIC, (payload) => this.enqueue(payload as CommsSignal));
  }

  /** Waits until everything queued so far has been delivered (tests). */
  async idle(): Promise<void> {
    while (this.chains.size) await Promise.all([...this.chains.values()]);
  }

  private enqueue(signal: CommsSignal): Promise<void> {
    if (!signal || typeof signal.conversationId !== 'string') return Promise.resolve();
    const key = signal.conversationId;
    const previous = this.chains.get(key) ?? Promise.resolve();
    const next = previous
      .then(() => this.handle(signal))
      .catch((error: unknown) => this.logger.warn(`Delivery failed: ${(error as Error).name}`))
      .finally(() => {
        if (this.chains.get(key) === next) this.chains.delete(key);
      });
    this.chains.set(key, next);
    return next;
  }

  private async handle(signal: CommsSignal): Promise<void> {
    if (!this.gateway.localSockets().length) return; // nobody connected here
    const conversation = await commsDb(() => this.prisma.conversation.findUnique({ where: { id: signal.conversationId }, include: conversationInclude }));
    if (!conversation) return;
    switch (signal.kind) {
      case 'message':
        return this.message(conversation, signal.messageId, signal.created);
      case 'receipt':
        return this.receipt(conversation, signal.employeeId);
      case 'conversation':
        return this.conversationChanged(conversation);
    }
  }

  /**
   * Current members who may use messaging now (who has left the company is not a member; who lost comms.use is not
   * either), with where each one's history starts. Read from the database for every delivery, so a revoked permission
   * stops delivery at once, whatever made the change; that person's sockets here are closed straight away.
   */
  private async members(conversation: ConversationRow): Promise<Map<string, number>> {
    const list = (await this.access.effectiveMembers(conversation)).filter((m) => m.active);
    const allowed = await this.withMessaging(list.map((m) => m.employeeId));
    for (const m of list) {
      if (allowed.has(m.employeeId)) continue;
      for (const s of this.gateway.socketsIn(employeeRoom(m.employeeId))) this.gateway.close(s, 'forbidden');
    }
    return new Map(list.filter((m) => allowed.has(m.employeeId)).map((m) => [m.employeeId, m.fromSeq]));
  }

  /** Which of these people hold comms.use right now (through their role or an active duty). One query. */
  private async withMessaging(employeeIds: string[]): Promise<Set<string>> {
    if (!employeeIds.length) return new Set();
    const permission = { permission: { key: COMMS_USE } };
    const rows = await commsDb(() =>
      this.prisma.employee.findMany({
        where: {
          id: { in: employeeIds },
          OR: [{ role: { rolePermissions: { some: permission } } }, { duties: { some: { endedAt: null, duty: { dutyPermissions: { some: permission } } } } }],
        },
        select: { id: true },
      }),
    );
    return new Set(rows.map((r) => r.id));
  }

  /**
   * This server's sockets that may be concerned: those in the conversation's room, and those of every current member
   * (someone who just joined, by hand or by moving into the department, is not in the room yet).
   * Sockets of people who are no longer members are taken out of the room and told.
   */
  private recipients(conversation: ConversationRow, members: Map<string, number>): Array<{ socket: CommsSocket; fromSeq: number }> {
    const room = conversationRoom(conversation.id);
    const candidates = new Map<string, CommsSocket>();
    for (const s of this.gateway.socketsIn(room)) candidates.set(s.id, s);
    for (const employeeId of members.keys()) for (const s of this.gateway.socketsIn(employeeRoom(employeeId))) candidates.set(s.id, s);
    const out: Array<{ socket: CommsSocket; fromSeq: number }> = [];
    for (const socket of candidates.values()) {
      const fromSeq = members.get(socket.data?.employeeId);
      if (fromSeq === undefined) {
        if (socket.rooms.has(room)) {
          socket.leave(room);
          socket.emit('conversation.removed', { conversationId: conversation.id });
        }
        continue;
      }
      if (!socket.rooms.has(room)) socket.join(room);
      out.push({ socket, fromSeq });
    }
    return out;
  }

  private async message(conversation: ConversationRow, messageId: string, created: boolean): Promise<void> {
    const row = await commsDb(() => this.prisma.message.findUnique({ where: { id: messageId }, select: { ...messageSelect, revision: true } }));
    if (!row || row.conversationId !== conversation.id) return;
    const members = await this.members(conversation);
    await this.deliver(conversation, row, created, members);
    // A new, deleted or removed reply changes its thread's first message (the reply count): send that too, from the
    // database, so it is also right when this signal is a late re-send.
    if (row.parentId) {
      const parent = await commsDb(() => this.prisma.message.findUnique({ where: { id: row.parentId! }, select: { ...messageSelect, revision: true } }));
      if (parent && parent.conversationId === conversation.id) await this.deliver(conversation, parent, false, members);
    }
  }

  private async deliver(conversation: ConversationRow, row: MessageRow & { revision: number }, created: boolean, members: Map<string, number>): Promise<void> {
    const targets = this.recipients(conversation, members).filter((t) => row.seq > t.fromSeq);
    if (!targets.length) return;
    const [view] = await this.views.build(NO_VIEWER, [row], [conversation]);
    // The same view for everyone, without the one per-person field (each screen keeps its own "saved").
    const live: LiveMessageView = { ...view };
    delete (live as Partial<typeof view>).savedByMe;
    for (const { socket } of targets) {
      if (!created) {
        socket.emit('message.updated', { conversationId: conversation.id, seq: row.seq, revision: row.revision, message: live });
        continue;
      }
      const event = { conversationId: conversation.id, seq: row.seq, message: live };
      if (socket.data.actor.empId === row.author.empId) {
        socket.emit('message.created', event, () => undefined);
        continue;
      }
      // Decision D3: "delivered" is recorded when the screen acknowledges the message (never by a REST call, which
      // would count as activity and keep the session alive).
      socket.timeout(ACK_TIMEOUT_MS).emit('message.created', event, (error: Error | null, reply?: { ok?: boolean }) => {
        if (!error && reply?.ok) this.queueDelivered(socket.data.actor, conversation.id, row.seq);
      });
    }
  }

  private async receipt(conversation: ConversationRow, employeeId: string): Promise<void> {
    const [read, person] = await Promise.all([
      commsDb(() => this.prisma.conversationRead.findUnique({ where: { conversationId_employeeId: { conversationId: conversation.id, employeeId } } })),
      commsDb(() => this.prisma.employee.findUnique({ where: { id: employeeId }, select: { empId: true } })),
    ]);
    if (!read || !person) return;
    const members = await this.members(conversation);
    if (!members.has(employeeId)) return;
    const event = { conversationId: conversation.id, empId: person.empId, lastDeliveredSeq: read.lastDeliveredSeq, lastReadSeq: read.lastReadSeq };
    // Channels show nobody's position but your own: only that person's sockets hear it.
    const targets = conversation.kind === 'channel' ? this.recipients(conversation, members).filter((t) => t.socket.data.employeeId === employeeId) : this.recipients(conversation, members);
    for (const { socket } of targets) socket.emit('receipt.updated', event);
  }

  private async conversationChanged(conversation: ConversationRow): Promise<void> {
    const members = await this.members(conversation);
    for (const { socket } of this.recipients(conversation, members)) socket.emit('conversation.changed', { conversationId: conversation.id, kind: conversation.kind });
  }

  // ---------------------------------------------------------------- delivered receipts

  private queueDelivered(actor: Actor, conversationId: string, seq: number): void {
    const key = `${actor.id}:${conversationId}`;
    const pending = this.pendingDelivered.get(key);
    if (pending) {
      pending.seq = Math.max(pending.seq, seq);
      return;
    }
    const timer = setTimeout(() => void this.flushOne(key), DELIVERED_FLUSH_MS);
    timer.unref();
    this.pendingDelivered.set(key, { actor, conversationId, seq, timer });
  }

  private async flushOne(key: string): Promise<void> {
    const pending = this.pendingDelivered.get(key);
    if (!pending) return;
    this.pendingDelivered.delete(key);
    clearTimeout(pending.timer);
    try {
      // The same rule as POST /delivered: members only, positions only move forward. Then every server is told.
      await this.conversations.mark(pending.actor, pending.conversationId, pending.seq, 'delivered');
    } catch {
      // no longer a member: nothing to record
    }
  }

  /** Writes every waiting acknowledgement now (tests). */
  async flushDelivered(): Promise<void> {
    await Promise.all([...this.pendingDelivered.keys()].map((k) => this.flushOne(k)));
  }
}
