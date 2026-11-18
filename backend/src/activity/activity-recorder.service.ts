import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { ActivityActionName } from '@aceva/contracts';
import { CityLocator } from '../common/city-locator';
import { OutboxService } from '../events/outbox.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { deviceLabel } from './rules/activity-classify';
import { flagFor } from './rules/alert-rules';

/** One activity record, as a module hands it to the recorder. */
export interface ActivityRecord {
  /** The person it is about (internal id) and their Emp-ID. */
  employeeId: string;
  empId: string;
  occurredAt: Date;
  action: ActivityActionName;
  /** The module people see on screen: People, Tasks, Ledger, Login... */
  module: string;
  description: string;
  /** What it was about, as people see it: an Emp-ID, TSK-0142, a department code. */
  target?: string | null;
  /** The session it happened in (signals from it count as use in the active-time calculation). */
  sessionId?: string | null;
  /** "aceva" (default) or the sales tool's name for Module 16 (lower case letters, digits and _). */
  source?: string;
  ip?: string | null;
  /** Left out (undefined): filled from the session, or from the internet address. null: none. */
  city?: string | null;
  /** Left out (undefined): filled from the session. null: none. */
  device?: string | null;
  /** The HTTP request that did it: activity search joins the audit log rows of the same request ("Changes"). */
  requestId?: string | null;
  /** A unique key that makes a retried write harmless (for example "outbox:<event id>"). */
  dedupeKey?: string | null;
  /** Linked to finance data (kept as long as the finance records). */
  financeLinked?: boolean;
  /** Small structured extras. NEVER secrets, request bodies or pay figures. */
  details?: Record<string, unknown> | null;
}

/** The "still here" signal: only whether the mouse or keyboard was used in the minute before `at`. */
export interface HeartbeatRecord {
  sessionId: string;
  employeeId: string;
  at: Date;
  active: boolean;
}

interface Prepared extends ActivityRecord {
  id: string;
  failures: number;
}

interface PreparedBeat extends HeartbeatRecord {
  id: string;
  failures: number;
}

/** How often the buffer is written to the database. */
export const ACTIVITY_FLUSH_MS = 1000;
/** Never keep more than this many records in memory (if the database is down for a long time the oldest are dropped). */
const MAX_BUFFERED = 10_000;
/** A record the database keeps refusing (it cannot be valid) is dropped after this many tries, with an error in the log. */
const MAX_FAILURES = 3;
const SOURCE_FORMAT = /^[a-z][a-z0-9_]{1,30}$/;

const cut = (value: string | null | undefined, max: number): string | null => (value ? value.slice(0, max) : null);

/**
 * Saves activity records OFF the request path (plan section 8: "events go into a queue and are saved in the background,
 * so the app stays fast"). record() and heartbeat() only add to an in-memory buffer; the buffer is written every second,
 * in one transaction, together with an `activity.flagged` outbox event for every record an alert rule must look at
 * (refused finance attempts, salary/bank/payslip views, exports). The tables are insert-only.
 *
 * The trade-off, written down on purpose: if the server process dies hard, up to about one second of activity records
 * can be lost. The audit log (written inside the request's own transaction) stays the legal record of every change.
 * A normal shutdown writes the buffer first.
 *
 * Other modules usually never call this: the action recorder (a global interceptor) records their requests. Call
 * record() for things that happen outside a request, or inject it to record something the route cannot describe.
 * Tests call flush() to write the buffer at once.
 */
@Injectable()
export class ActivityRecorder implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('ActivityRecorder');
  private events: Prepared[] = [];
  private beats: PreparedBeat[] = [];
  private timer: NodeJS.Timeout | null = null;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly cities: CityLocator,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(() => void this.flush().catch(() => undefined), ACTIVITY_FLUSH_MS);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush().catch((error) => this.logger.error(`Could not write the last activity records: ${(error as Error).message}`));
  }

  /** Adds a record to the buffer. Returns at once; the record is saved within about a second. */
  record(entry: ActivityRecord): void {
    if (entry.source !== undefined && !SOURCE_FORMAT.test(entry.source)) {
      throw new Error(`Activity source "${entry.source}" must be lower-case letters, digits or _ (for example "apollo")`);
    }
    this.events.push({ ...entry, id: randomUUID(), failures: 0 });
    if (this.events.length > MAX_BUFFERED) {
      const dropped = this.events.splice(0, this.events.length - MAX_BUFFERED);
      this.logger.error(`Activity buffer full: dropped ${dropped.length} record(s) (is the database reachable?)`);
    }
  }

  /** Adds a heartbeat to the buffer. */
  heartbeat(beat: HeartbeatRecord): void {
    this.beats.push({ ...beat, id: randomUUID(), failures: 0 });
    if (this.beats.length > MAX_BUFFERED) this.beats.splice(0, this.beats.length - MAX_BUFFERED);
  }

  /** How many records wait in the buffer (for tests and diagnostics). */
  pending(): number {
    return this.events.length + this.beats.length;
  }

  /** Writes everything buffered so far. Calls never overlap. Returns how many rows were written. */
  flush(): Promise<number> {
    const run = this.chain.then(() => this.writeBuffered());
    this.chain = run.catch(() => undefined);
    return run;
  }

  /**
   * Writes records at once inside the caller's transaction (used by the outbox consumers, which must save the activity
   * record and any alert together). Records with a dedupeKey that already exists are skipped silently.
   * Returns the ids of the rows actually inserted.
   */
  async write(tx: Prisma.TransactionClient, entries: ActivityRecord[]): Promise<string[]> {
    const prepared = await this.complete(entries.map((e) => ({ ...e, id: randomUUID(), failures: 0 })));
    return this.insert(tx, prepared, []);
  }

  // ------------------------------------------------------------------------------------------------- internals

  private async writeBuffered(): Promise<number> {
    const events = this.events.splice(0);
    const beats = this.beats.splice(0);
    if (!events.length && !beats.length) return 0;
    try {
      const completed = await this.complete(events);
      await this.prisma.$transaction((tx) => this.insert(tx, completed, beats));
      return events.length + beats.length;
    } catch (error) {
      if (!(await this.databaseReachable())) {
        // Keep everything for the next try, in the same order.
        this.events.unshift(...events);
        this.beats.unshift(...beats);
        this.logger.warn(`Activity records kept for later, the database is not reachable: ${(error as Error).message}`);
        return 0;
      }
      return this.writeOneByOne(events, beats);
    }
  }

  /**
   * The database works but refused the batch, so one record is probably bad: write them one by one. The records that
   * still fail go back in front of the buffer in their original order (a record refused MAX_FAILURES times is dropped).
   * If the database goes away while this runs, the rest is kept without blaming any record.
   */
  private async writeOneByOne(events: Prepared[], beats: PreparedBeat[]): Promise<number> {
    let written = 0;
    let down = false;
    const keptEvents: Prepared[] = [];
    const keptBeats: PreparedBeat[] = [];
    const attempt = async <T extends { failures: number }>(item: T, kept: T[], write: () => Promise<void>): Promise<void> => {
      if (down) {
        kept.push(item);
        return;
      }
      try {
        await write();
        written++;
      } catch (error) {
        if (!(await this.databaseReachable())) {
          down = true;
          kept.push(item);
          this.logger.warn(`Activity records kept for later, the database is not reachable: ${(error as Error).message}`);
        } else if (this.countFailure(item, error as Error)) {
          kept.push(item);
        }
      }
    };
    for (const e of events) {
      await attempt(e, keptEvents, async () => {
        const [completed] = await this.complete([e]);
        await this.prisma.$transaction((tx) => this.insert(tx, [completed], []));
      });
    }
    for (const b of beats) {
      await attempt(b, keptBeats, async () => {
        await this.prisma.$transaction((tx) => this.insert(tx, [], [b]));
      });
    }
    this.events.unshift(...keptEvents);
    this.beats.unshift(...keptBeats);
    return written;
  }

  /** Counts one more refusal of this record. False when it has been refused too often and is dropped. */
  private countFailure(item: { failures: number }, error: Error): boolean {
    item.failures++;
    if (item.failures >= MAX_FAILURES) {
      this.logger.error(`Dropped an activity record the database refused ${MAX_FAILURES} times: ${error.message}`);
      return false;
    }
    return true;
  }

  private async databaseReachable(): Promise<boolean> {
    try {
      await this.prisma.$queryRaw`SELECT 1`;
      return true;
    } catch {
      return false;
    }
  }

  /** Fills the device and city from the session (one query for the whole batch), or the city from the address. */
  private async complete(events: Prepared[]): Promise<Prepared[]> {
    const sessionIds = [...new Set(events.filter((e) => e.sessionId && (e.device === undefined || e.city === undefined)).map((e) => e.sessionId!))];
    const sessions = sessionIds.length
      ? await this.prisma.session.findMany({ where: { id: { in: sessionIds } }, select: { id: true, device: true, browser: true, os: true, city: true, ip: true } })
      : [];
    const byId = new Map(sessions.map((s) => [s.id, s]));
    return events.map((e) => {
      const s = e.sessionId ? byId.get(e.sessionId) : undefined;
      return {
        ...e,
        device: e.device !== undefined ? e.device : s ? deviceLabel(s) : null,
        city: e.city !== undefined ? e.city : (s?.city ?? this.cities.cityFor(e.ip ?? s?.ip)),
        ip: e.ip ?? s?.ip ?? null,
      };
    });
  }

  /** Inserts the rows and, for the new ones, the alert-rule events. Returns the ids inserted. */
  private async insert(tx: Prisma.TransactionClient, events: Prepared[], beats: PreparedBeat[]): Promise<string[]> {
    let inserted: string[] = [];
    if (events.length) {
      const rows = await tx.activityEvent.createManyAndReturn({
        data: events.map((e) => ({
          id: e.id,
          occurredAt: e.occurredAt,
          employeeId: e.employeeId,
          sessionId: e.sessionId ?? null,
          source: e.source ?? 'aceva',
          action: e.action,
          module: (e.module || 'System').slice(0, 80),
          target: cut(e.target, 120),
          description: (e.description || e.action).slice(0, 500),
          ip: cut(e.ip, 64),
          city: cut(e.city, 80),
          device: cut(e.device, 120),
          requestId: e.requestId ?? null,
          dedupeKey: cut(e.dedupeKey, 200),
          financeLinked: !!e.financeLinked,
          details: e.details ? (e.details as Prisma.InputJsonValue) : undefined,
        })),
        skipDuplicates: true,
        select: { id: true },
      });
      inserted = rows.map((r) => r.id);
      const fresh = new Set(inserted);
      for (const e of events) {
        if (!fresh.has(e.id)) continue;
        const kind = flagFor({ action: e.action, financeLinked: !!e.financeLinked, details: e.details, target: e.target, empId: e.empId });
        if (!kind) continue;
        const exported = kind === 'export' && typeof e.details?.rows === 'number' ? Math.max(0, Math.floor(e.details.rows)) : null;
        await this.outbox.emit(
          {
            type: 'activity.flagged',
            actor: e.empId as `ACV-${string}`,
            payload: { eventId: e.id, empId: e.empId as `ACV-${string}`, kind, at: e.occurredAt.toISOString(), module: (e.module || 'System').slice(0, 80), rows: exported },
          },
          tx,
        );
      }
    }
    if (beats.length) {
      await tx.activityHeartbeat.createMany({
        data: beats.map((b) => ({ id: b.id, sessionId: b.sessionId, employeeId: b.employeeId, at: b.at, active: b.active })),
        skipDuplicates: true,
      });
    }
    return inserted;
  }
}
