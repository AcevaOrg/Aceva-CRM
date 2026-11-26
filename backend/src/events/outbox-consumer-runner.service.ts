import { Inject, Injectable, Logger, type OnApplicationBootstrap } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { outboxEventSchemas, type OutboxEvent, type OutboxEventType } from '@aceva/contracts';
import { Clock } from '../common/clock';
import { ENV } from '../config/config.module';
import { backgroundWorkersOn, type Env } from '../config/env';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * A module that reads outbox events (Cycle 3 shared foundation). `handle` runs inside the same transaction that records
 * the event as processed for this reader: whatever it writes there is committed exactly once, or not at all.
 * Anything sent outside the database (email) must be queued in that transaction and sent later (see notifications).
 */
export interface OutboxConsumerDefinition {
  /** Stable, unique name, for example "notifications". Never reuse a name for a different reader. */
  name: string;
  types: OutboxEventType[];
  handle: (event: OutboxEvent, tx: Prisma.TransactionClient) => Promise<void>;
}

export interface DrainResult {
  done: number;
  failed: number;
  skipped: number;
}

interface PendingRow {
  id: string;
  type: string;
  version: number;
  actor: string;
  payload: unknown;
  occurred_at: Date;
}

/** Attempts per reader and event before it is given up (status dead; it stays visible and can be re-armed by hand). */
export const MAX_CONSUMER_ATTEMPTS = 5;
const BACKOFF_MS = [30_000, 2 * 60_000, 10 * 60_000, 60 * 60_000];
const BATCH = 50;

/**
 * Runs every registered outbox reader. Each reader sees each event at most once:
 *  - progress is one row per (reader, event) in outbox_consumptions, unique, written in the handler's transaction;
 *  - two servers (or two calls) racing for the same event: the second insert waits on the unique key, then sees the
 *    first one's committed row and skips; if the first one failed and rolled back, the second one takes over;
 *  - a failing handler is rolled back completely and tried again later with a growing delay, MAX_CONSUMER_ATTEMPTS times;
 *  - a reader only sees events written after it was first registered, so a new reader never replays the past;
 *  - outbox_events.processed_at is never touched here: it belongs to the final-settlement reader that predates this.
 */
@Injectable()
export class OutboxConsumerRunner implements OnApplicationBootstrap {
  private readonly logger = new Logger('OutboxConsumers');
  private readonly consumers = new Map<string, OutboxConsumerDefinition>();
  private readonly known = new Set<string>();
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  register(definition: OutboxConsumerDefinition): void {
    if (this.consumers.has(definition.name)) throw new Error(`Outbox consumer "${definition.name}" is registered twice`);
    this.consumers.set(definition.name, definition);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.ensureKnown();
  }

  @Interval(10_000)
  async scheduledTick(): Promise<void> {
    if (!backgroundWorkersOn(this.env)) return; // tests drive drain() themselves
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.drain();
    } catch (e) {
      this.logger.error(`Outbox consumer tick failed: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  /** Processes everything waiting, for one reader or all of them. */
  async drain(only?: string): Promise<Record<string, DrainResult>> {
    await this.ensureKnown();
    const out: Record<string, DrainResult> = {};
    for (const consumer of this.consumers.values()) {
      if (only && consumer.name !== only) continue;
      const result: DrainResult = { done: 0, failed: 0, skipped: 0 };
      const tried = new Set<string>();
      for (;;) {
        const rows = (await this.pending(consumer)).filter((r) => !tried.has(r.id));
        if (!rows.length) break;
        for (const row of rows) {
          tried.add(row.id);
          const outcome = await this.process(consumer, row);
          if (outcome) result[outcome]++;
        }
      }
      out[consumer.name] = result;
    }
    return out;
  }

  /**
   * Records every registered reader once, with the moment it started reading. That moment is written through Prisma,
   * exactly like outbox_events.created_at, so the two always compare correctly (never mix in the database's now():
   * see docs/CYCLE3-FOUNDATION.md, "Time zone"). Real time, not the test clock: created_at is real time too.
   */
  private async ensureKnown(): Promise<void> {
    for (const name of this.consumers.keys()) {
      if (this.known.has(name)) continue;
      await this.prisma.outboxConsumer.createMany({ data: [{ name, startedAt: new Date() }], skipDuplicates: true });
      this.known.add(name);
    }
  }

  private pending(consumer: OutboxConsumerDefinition): Promise<PendingRow[]> {
    const now = this.clock.now();
    return this.prisma.$queryRaw<PendingRow[]>`
      SELECT e.id, e.type, e.version, e.actor, e.payload, e.occurred_at
      FROM outbox_events e
      JOIN outbox_consumers c ON c.name = ${consumer.name}
      LEFT JOIN outbox_consumptions oc ON oc.consumer = ${consumer.name} AND oc.event_id = e.id
      WHERE e.type = ANY(${consumer.types}::text[])
        AND e.created_at >= c.started_at
        AND (oc.id IS NULL OR (oc.status = 'failed' AND oc.next_attempt_at <= ${now}))
      ORDER BY e.created_at, e.id
      LIMIT ${BATCH}`;
  }

  private async process(consumer: OutboxConsumerDefinition, row: PendingRow): Promise<keyof DrainResult | null> {
    const parsed = this.parse(row);
    if (!parsed) {
      await this.mark(consumer.name, row.id, 'skipped', 'unreadable: payload or version does not match its contract');
      this.logger.warn(`${consumer.name}: skipped unreadable event ${row.id} (${row.type} v${row.version})`);
      return 'skipped';
    }
    const now = this.clock.now();
    try {
      const claimed = await this.prisma.$transaction(async (tx) => {
        // Claim: new row, or take over a failed one. Nothing comes back when another run already handled it.
        const rows = await tx.$queryRaw<Array<{ id: string }>>`
          INSERT INTO outbox_consumptions (consumer, event_id, status, attempts, processed_at, created_at, updated_at)
          VALUES (${consumer.name}, ${row.id}::uuid, 'done', 1, ${now}, ${now}, ${now})
          ON CONFLICT (consumer, event_id) DO UPDATE
            SET status = 'done', attempts = outbox_consumptions.attempts + 1, processed_at = ${now},
                last_error = NULL, next_attempt_at = NULL, updated_at = ${now}
            WHERE outbox_consumptions.status = 'failed'
          RETURNING id`;
        if (!rows.length) return false;
        await consumer.handle(parsed, tx);
        return true;
      });
      return claimed ? 'done' : null;
    } catch (error) {
      const message = `${(error as Error).name}: ${(error as Error).message}`.slice(0, 300);
      this.logger.warn(`${consumer.name}: event ${row.id} (${row.type}) failed: ${message}`);
      await this.recordFailure(consumer.name, row.id, message);
      return 'failed';
    }
  }

  private parse(row: PendingRow): OutboxEvent | null {
    const versions = (outboxEventSchemas as Record<string, Record<number, { safeParse: (v: unknown) => { success: boolean; data?: unknown } }>>)[row.type];
    const schema = versions?.[row.version];
    if (!schema) return null;
    const result = schema.safeParse({ id: row.id, type: row.type, version: row.version, occurredAt: row.occurred_at.toISOString(), actor: row.actor, payload: row.payload });
    return result.success ? (result.data as OutboxEvent) : null;
  }

  private async mark(consumer: string, eventId: string, status: 'skipped', note: string): Promise<void> {
    const now = this.clock.now();
    await this.prisma.$executeRaw`
      INSERT INTO outbox_consumptions (consumer, event_id, status, attempts, last_error, processed_at, created_at, updated_at)
      VALUES (${consumer}, ${eventId}::uuid, ${status}::outbox_consumption_status, 0, ${note}, ${now}, ${now}, ${now})
      ON CONFLICT (consumer, event_id) DO NOTHING`;
  }

  /** Outside the rolled-back transaction: count the attempt, and give up after the last one. */
  private async recordFailure(consumer: string, eventId: string, message: string): Promise<void> {
    const now = this.clock.now();
    const rows = await this.prisma.$queryRaw<Array<{ attempts: number }>>`
      INSERT INTO outbox_consumptions (consumer, event_id, status, attempts, last_error, created_at, updated_at)
      VALUES (${consumer}, ${eventId}::uuid, 'failed', 1, ${message}, ${now}, ${now})
      ON CONFLICT (consumer, event_id) DO UPDATE
        SET attempts = outbox_consumptions.attempts + 1, last_error = ${message}, updated_at = ${now}
        WHERE outbox_consumptions.status = 'failed'
      RETURNING attempts`;
    const attempts = rows[0]?.attempts;
    if (attempts === undefined) return; // handled meanwhile by another run
    const dead = attempts >= MAX_CONSUMER_ATTEMPTS;
    const next = new Date(now.getTime() + BACKOFF_MS[Math.min(attempts - 1, BACKOFF_MS.length - 1)]);
    await this.prisma.outboxConsumption.update({
      where: { consumer_eventId: { consumer, eventId } },
      data: { status: dead ? 'dead' : 'failed', nextAttemptAt: dead ? null : next },
    });
    if (dead) this.logger.error(`${consumer}: gave up on event ${eventId} after ${attempts} attempts`);
  }
}
