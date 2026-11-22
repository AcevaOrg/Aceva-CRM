import { Injectable, Logger } from '@nestjs/common';
import { CityLocator } from '../../common/city-locator';
import { Clock } from '../../common/clock';
import { OutboxService } from '../../events/outbox.service';
import { PrismaService } from '../../prisma/prisma.service';
import { RealtimeBus } from '../../redis/realtime-bus.service';
import { CryptoService } from '../crypto.service';
import { parseUserAgent } from '../user-agent';
import { FINANCE_IDLE_LIMIT_MS, IDLE_LIMIT_MS, MAX_SESSION_MS } from './session-limits';
import { CachedSession, SessionStore } from './session-store';

/** The fixed session limits (plan section 6) live in session-limits.ts; they are also exported from here. */
export { FINANCE_IDLE_LIMIT_MS, IDLE_LIMIT_MS, MAX_SESSION_MS };
/** PostgreSQL gets the "last active" time at most this often (Redis always has the exact value). */
const PG_SYNC_EVERY_MS = 60_000;
/** Relay topic: a session has ended (payload: the session id only). Every server closes that session's sockets. */
export const SESSION_ENDED_TOPIC = 'session-ended';

export type EndReason =
  | 'user'
  | 'idle_timeout'
  | 'max_duration'
  | 'password_changed'
  | 'forced'
  | 'employee_left'
  | 'user_other_device'
  | 'too_many_wrong_codes';

export type SessionCheck =
  | { ok: true; session: CachedSession }
  | { ok: false; reason: 'invalid' | 'expired' };

/**
 * The idle limit that applies to a session right now, for checks that are not tied to a screen (a live socket): the
 * finance limit when the person's last activity was on a finance screen, the normal one otherwise. When that is not known
 * (Redis lost the session and it was rebuilt from PostgreSQL) `financeFallback` decides: true for people with Finance
 * duty, so the stricter limit is never lost.
 */
export function idleLimitOf(session: CachedSession, financeFallback = false): number {
  return (session.financeActivity ?? financeFallback) ? FINANCE_IDLE_LIMIT_MS : IDLE_LIMIT_MS;
}

/** When this session ends if nothing happens: the idle limit above, or the 12-hour end, whichever comes first. */
export function sessionDeadline(session: CachedSession, financeFallback = false): number {
  return Math.min(session.lastActiveAt + idleLimitOf(session, financeFallback), session.absoluteExpiresAt);
}

export interface NewSession {
  employeeId: string;
  empId: string;
  rememberMe: boolean;
  twoFactorVerified: boolean;
  ip: string | null;
  userAgent: string | null;
}

/**
 * Sessions (plan section 6).
 *  - The browser holds a random token in an HttpOnly cookie. Only the SHA-256 hash of it is stored.
 *  - Every live session is kept in Redis (fast check) AND in the PostgreSQL `sessions` table (permanent record).
 *  - Verified on every request: 30 minutes idle (10 on finance screens), 12 hours in total.
 *  - Ending a session removes it from both stores at once, on every device when asked.
 *  - Every ending is passed to Module 4 as an `auth.logout` event.
 */
@Injectable()
export class SessionService {
  private readonly logger = new Logger('Sessions');

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: SessionStore,
    private readonly crypto: CryptoService,
    private readonly clock: Clock,
    private readonly outbox: OutboxService,
    private readonly cities: CityLocator,
    private readonly bus: RealtimeBus,
  ) {}

  /** Creates a session. Returns the secret token (for the cookie) and the CSRF token (for the page); neither is stored. */
  async create(input: NewSession): Promise<{ token: string; csrfToken: string; session: CachedSession }> {
    const now = this.clock.now();
    const token = this.crypto.randomToken(32);
    const csrfToken = this.crypto.csrfTokenFor(token);
    const tokenHash = this.crypto.sha256(token);
    const csrfHash = this.crypto.sha256(csrfToken);
    const device = parseUserAgent(input.userAgent);
    const absoluteExpiresAt = new Date(now.getTime() + MAX_SESSION_MS);

    const row = await this.prisma.session.create({
      data: {
        employeeId: input.employeeId,
        tokenHash,
        csrfTokenHash: csrfHash,
        rememberMe: input.rememberMe,
        twoFactorVerifiedAt: input.twoFactorVerified ? now : null,
        ip: input.ip,
        userAgent: input.userAgent?.slice(0, 300) ?? null,
        device: device.device,
        browser: device.browser,
        os: device.os,
        // Module 4: the approximate city from the internet address only (a local list, never GPS, no outside service).
        city: this.cities.cityFor(input.ip),
        lastActiveAt: now,
        absoluteExpiresAt,
        createdAt: now,
        createdBy: input.employeeId,
      },
      select: { id: true },
    });

    const session: CachedSession = {
      id: row.id,
      employeeId: input.employeeId,
      empId: input.empId,
      createdAt: now.getTime(),
      lastActiveAt: now.getTime(),
      absoluteExpiresAt: absoluteExpiresAt.getTime(),
      rememberMe: input.rememberMe,
      twoFactorVerified: input.twoFactorVerified,
      csrfHash,
      pgSyncedAt: now.getTime(),
    };
    await this.store.set(tokenHash, session, MAX_SESSION_MS / 1000);
    return { token, csrfToken, session };
  }

  /**
   * Checks the cookie token. On success the "last active" time moves to now, unless `touch` is false. An expired or
   * unknown session is ended (if it exists) and refused.
   *
   * `touch: false` does NOT count as activity and writes nothing: a heartbeat from an unused tab (Module 4), the WebSocket
   * handshake and the reads a screen makes on its own (Module 14), so an open screen never keeps a session alive without
   * the person doing anything. Such a check applies the limit of the screen the person was last active on (idleLimitOf),
   * or the finance limit when the request itself is for a finance screen.
   */
  async authenticate(token: string, options: { financeScreen: boolean; touch?: boolean; financeFallback?: boolean }): Promise<SessionCheck> {
    const now = this.clock.now().getTime();
    const tokenHash = this.crypto.sha256(token);

    let session = await this.store.get(tokenHash);
    if (!session) session = await this.restoreFromDatabase(tokenHash);
    if (!session) return { ok: false, reason: 'invalid' };

    const touch = options.touch !== false;
    const idleLimit = touch
      ? options.financeScreen ? FINANCE_IDLE_LIMIT_MS : IDLE_LIMIT_MS
      : Math.min(idleLimitOf(session, options.financeFallback), options.financeScreen ? FINANCE_IDLE_LIMIT_MS : IDLE_LIMIT_MS);
    const expired = await this.endIfExpired(session, now, idleLimit);
    if (expired) return expired;
    if (!touch) return { ok: true, session };

    session.lastActiveAt = now;
    session.financeActivity = options.financeScreen;
    if (now - session.pgSyncedAt >= PG_SYNC_EVERY_MS) {
      session.pgSyncedAt = now;
      await this.prisma.session.updateMany({ where: { id: session.id, revokedAt: null }, data: { lastActiveAt: new Date(now) } });
    }
    await this.store.set(tokenHash, session, (session.absoluteExpiresAt - now) / 1000);
    return { ok: true, session };
  }

  /**
   * The read-only check without the token: used to re-check a live socket's session (by its id). Never counts as
   * activity. Applies the idle limit of the screen the person was last active on (idleLimitOf).
   */
  async validateById(sessionId: string, options: { financeFallback?: boolean } = {}): Promise<SessionCheck> {
    const row = await this.prisma.session.findUnique({ where: { id: sessionId }, select: { tokenHash: true, revokedAt: true } });
    if (!row || row.revokedAt) return { ok: false, reason: 'invalid' };
    const session = (await this.store.get(row.tokenHash)) ?? (await this.restoreFromDatabase(row.tokenHash));
    if (!session) return { ok: false, reason: 'invalid' };
    const expired = await this.endIfExpired(session, this.clock.now().getTime(), idleLimitOf(session, options.financeFallback));
    return expired ?? { ok: true, session };
  }

  private async endIfExpired(session: CachedSession, now: number, idleLimit: number): Promise<SessionCheck | null> {
    if (now > session.absoluteExpiresAt) {
      await this.end(session.id, 'max_duration');
      return { ok: false, reason: 'expired' };
    }
    if (now - session.lastActiveAt > idleLimit) {
      await this.end(session.id, 'idle_timeout');
      return { ok: false, reason: 'expired' };
    }
    return null;
  }

  /** Redis lost the session (restart, flush, outage): the PostgreSQL record is the truth, so rebuild from it. */
  private async restoreFromDatabase(tokenHash: string): Promise<CachedSession | null> {
    const row = await this.prisma.session.findUnique({
      where: { tokenHash },
      select: {
        id: true,
        employeeId: true,
        rememberMe: true,
        twoFactorVerifiedAt: true,
        csrfTokenHash: true,
        lastActiveAt: true,
        absoluteExpiresAt: true,
        createdAt: true,
        revokedAt: true,
        employee: { select: { empId: true } },
      },
    });
    if (!row || row.revokedAt || !row.csrfTokenHash) return null;
    return {
      id: row.id,
      employeeId: row.employeeId,
      empId: row.employee.empId,
      createdAt: row.createdAt.getTime(),
      lastActiveAt: row.lastActiveAt.getTime(),
      absoluteExpiresAt: row.absoluteExpiresAt.getTime(),
      rememberMe: row.rememberMe,
      twoFactorVerified: row.twoFactorVerifiedAt !== null,
      csrfHash: row.csrfTokenHash,
      pgSyncedAt: row.lastActiveAt.getTime(),
    };
  }

  /** The person has proved their authenticator code in this session. */
  async markTwoFactorVerified(sessionId: string): Promise<void> {
    const now = this.clock.now();
    const row = await this.prisma.session.update({
      where: { id: sessionId },
      data: { twoFactorVerifiedAt: now },
      select: { tokenHash: true },
    });
    const cached = await this.store.get(row.tokenHash);
    if (cached) {
      cached.twoFactorVerified = true;
      await this.store.set(row.tokenHash, cached, (cached.absoluteExpiresAt - now.getTime()) / 1000);
    }
  }

/** How long a "confirm again" stays valid. */
  static readonly STEP_UP_VALID_MS = 5 * 60_000;

  /** The person has confirmed their password (and code) again in this session. */
  async markStepUp(sessionId: string): Promise<void> {
    await this.prisma.session.updateMany({ where: { id: sessionId, revokedAt: null }, data: { stepUpAt: this.clock.now() } });
  }

  /** True if this session confirmed again within the last 5 minutes (checked in PostgreSQL, the permanent record). */
  async hasRecentStepUp(sessionId: string | null): Promise<boolean> {
    if (!sessionId) return false;
    const row = await this.prisma.session.findFirst({ where: { id: sessionId, revokedAt: null }, select: { stepUpAt: true } });
    return !!row?.stepUpAt && this.clock.now().getTime() - row.stepUpAt.getTime() <= SessionService.STEP_UP_VALID_MS;
  }

  /**
   * When a live session last counted as active (Redis has the exact time, PostgreSQL a slightly older one), or null if it
   * has ended. Reading it does not count as activity.
   */
  async lastActiveAt(sessionId: string): Promise<number | null> {
    const row = await this.prisma.session.findUnique({ where: { id: sessionId }, select: { tokenHash: true, lastActiveAt: true, revokedAt: true } });
    if (!row || row.revokedAt) return null;
    const cached = await this.store.get(row.tokenHash);
    return cached?.lastActiveAt ?? row.lastActiveAt.getTime();
  }

  /** Ends one session everywhere and tells Module 4. Safe to call twice. */
  async end(sessionId: string, reason: EndReason): Promise<boolean> {
    const row = await this.prisma.session.findUnique({
      where: { id: sessionId },
      select: { id: true, tokenHash: true, revokedAt: true, employee: { select: { empId: true } } },
    });
    if (!row) return false;
    // Database first (the permanent record), then the fast copy.
    const { count } = await this.prisma.session.updateMany({
      where: { id: sessionId, revokedAt: null },
      data: { revokedAt: this.clock.now(), revokedReason: reason },
    });
    await this.store.delete(row.tokenHash);
    // Close this session's live sockets on every server (Module 14, part 2). Sent even when the session had already
    // ended (harmless), never with anything but the id. If Redis is down the signal is lost: each server also re-checks
    // its sockets' sessions every minute against PostgreSQL.
    await this.bus.publish(SESSION_ENDED_TOPIC, { sessionId: row.id });
    if (count > 0) {
      await this.outbox.emit({
        type: 'auth.logout',
        actor: row.employee.empId as `ACV-${string}`,
        payload: { empId: row.employee.empId, sessionId: row.id, reason },
      });
    }
    return count > 0;
  }

  /** Ends every session of a person (every device), optionally keeping one. Returns how many were ended. */
  async endAllFor(employeeId: string, reason: EndReason, exceptSessionId?: string): Promise<number> {
    const active = await this.prisma.session.findMany({
      where: { employeeId, revokedAt: null, ...(exceptSessionId ? { id: { not: exceptSessionId } } : {}) },
      select: { id: true },
    });
    let ended = 0;
    for (const { id } of active) {
      if (await this.end(id, reason)) ended++;
    }
    return ended;
  }

  /** Live sessions of one person, newest first (for "My devices"). */
  async listActive(employeeId: string) {
    return this.prisma.session.findMany({
      where: { employeeId, revokedAt: null, absoluteExpiresAt: { gt: this.clock.now() } },
      orderBy: { createdAt: 'desc' },
      select: { id: true, device: true, browser: true, os: true, city: true, ip: true, createdAt: true, lastActiveAt: true, tokenHash: true },
    });
  }

  /**
   * Ends sessions that ran out of time while nobody was making requests (nothing else would notice).
   * Runs every minute. Redis has the exact "last active" time, PostgreSQL a slightly older one.
   */
  async sweepExpired(): Promise<number> {
    const now = this.clock.now();
    const candidates = await this.prisma.session.findMany({
      where: {
        revokedAt: null,
        OR: [{ absoluteExpiresAt: { lt: now } }, { lastActiveAt: { lt: new Date(now.getTime() - IDLE_LIMIT_MS) } }],
      },
      select: { id: true, tokenHash: true, lastActiveAt: true, absoluteExpiresAt: true },
      take: 500,
    });
    let ended = 0;
    for (const row of candidates) {
      if (now > row.absoluteExpiresAt) {
        if (await this.end(row.id, 'max_duration')) ended++;
        continue;
      }
      const cached = await this.store.get(row.tokenHash);
      const lastActive = cached?.lastActiveAt ?? row.lastActiveAt.getTime();
      if (now.getTime() - lastActive > IDLE_LIMIT_MS && (await this.end(row.id, 'idle_timeout'))) ended++;
    }
    if (ended) this.logger.log(`Ended ${ended} expired session(s)`);
    return ended;
  }
}
