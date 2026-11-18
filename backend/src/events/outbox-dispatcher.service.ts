import { hostname } from 'node:os';
import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy } from '@nestjs/common';
import { outboxEventSchema, type OutboxEvent, type OutboxEventType } from '@aceva/contracts';
import { Clock } from '../common/clock';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { PrismaService } from '../prisma/prisma.service';
import {
  ConsumerTimeoutError,
  eventKey,
  OUTBOX_BATCH,
  OUTBOX_CONSUMER_TIMEOUT_MS,
  OUTBOX_LEASE_MS,
  OUTBOX_MAX_ATTEMPTS,
  OUTBOX_SLOW_FAILURE_MS,
  outboxRetryDelayMs,
  SlowConsumerPause,
  withTimeout,
} from './outbox-rules';

/** An event as it is stored, handed to a consumer next to the parsed event. */
export interface StoredOutboxEvent {
  id: string;
  type: string;
  version: number;
  actor: string;
  payload: unknown;
  occurredAt: Date;
  /** Delivery attempts so far, this one included. */
  attempts: number;
}

/**
 * Something that reacts to outbox events (Module 4 turns auth.* events into activity records; Module 5 will consume
 * task.transfer.requested; Module 8 payroll.final_settlement.requested...).
 *
 * Rules for a consumer:
 *  - `name` is unique and never renamed: deliveries are recorded per consumer name (outbox_deliveries).
 *  - `handle` MUST be idempotent. The dispatcher gives an event to a consumer until the consumer has succeeded once,
 *    but a server can crash between "handled" and "recorded as handled", so the same event may arrive twice. Use a
 *    unique key for what you write (for example activity_events.dedupe_key = "outbox:<event id>:login") and
 *    createMany({ skipDuplicates: true }), or check before writing.
 *  - Throwing means "try again later": the event is retried with a growing delay (10 s, 30 s, 2 min ... 12 h), at most
 *    OUTBOX_MAX_ATTEMPTS times. Consumers that already succeeded for that event are not called again.
 *  - Do not wait for something slow without a time limit of your own (a mail server, another service). A call that is
 *    still running after OUTBOX_CONSUMER_TIMEOUT_MS (20 s) counts as failed and the dispatcher moves on; the call is NOT
 *    cancelled, so it can still finish later and the retry can run next to it (one more reason for idempotency). A
 *    consumer that fails after 5 s or more is left alone for a minute, so one dead mail server cannot hold up the
 *    events of every other module.
 *  - Events are claimed oldest first, but two servers may handle neighbouring events at the same time: do not rely on
 *    a strict order between events.
 *  - A consumer registered later only sees events that were not yet fully processed when it arrived.
 */
export interface OutboxConsumer {
  name: string;
  handles: ReadonlyArray<{ type: OutboxEventType; version: number }>;
  handle(event: OutboxEvent, stored: StoredOutboxEvent): Promise<void>;
}

interface ClaimedRow {
  id: string;
  type: string;
  version: number;
  actor: string;
  payload: unknown;
  occurred_at: Date;
  attempts: number;
}

/**
 * Delivers outbox events to the consumers registered for them (docs/EVENTS.md, "Consuming events").
 *
 * Several server copies can run it at once, like the job runner: each batch is claimed with FOR UPDATE SKIP LOCKED
 * and a lease (locked_until), so an event is handled by one server at a time and a crashed server's claim runs out.
 * When every consumer of an event has handled it, processed_at is set. Events nobody consumes (yet) are left alone.
 *
 * Polls every OUTBOX_DISPATCH_INTERVAL_MS (default 5 s). Tests switch polling off and call tick().
 * Register consumers in onModuleInit:  this.dispatcher.register({ name, handles, handle })
 */
@Injectable()
export class OutboxDispatcher implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('OutboxDispatcher');
  private readonly consumers: OutboxConsumer[] = [];
  private readonly workerId = `${hostname()}:${process.pid}:outbox`;
  private readonly slow = new SlowConsumerPause();
  private running: Promise<number> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopped = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  register(consumer: OutboxConsumer): void {
    if (this.consumers.some((c) => c.name === consumer.name)) throw new Error(`Outbox consumer "${consumer.name}" is registered twice`);
    this.consumers.push(consumer);
  }

  onApplicationBootstrap(): void {
    const every = this.env.OUTBOX_DISPATCH_INTERVAL_MS;
    if (every <= 0) return;
    this.timer = setInterval(() => {
      this.tick().catch((error) => this.logger.error(`Outbox tick failed: ${(error as Error).message}`));
    }, every);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }

  /** Delivers everything that is due. Returns how many events were looked at. Never runs twice at once in one server. */
  tick(): Promise<number> {
    if (this.stopped) return Promise.resolve(0);
    if (this.running) return this.running;
    this.running = this.drain().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async drain(): Promise<number> {
    let handled = 0;
    while (!this.stopped) {
      const rows = await this.claim();
      if (!rows.length) break;
      let renewedAt = this.clock.now().getTime();
      for (const [index, row] of rows.entries()) {
        if (this.stopped) {
          await this.release(rows.slice(index)); // shutting down: hand the rest of the batch back untouched
          break;
        }
        const now = this.clock.now().getTime();
        if (index > 0 && now - renewedAt >= OUTBOX_LEASE_MS / 4) {
          await this.renewLease(rows.slice(index)); // a slow batch must not run out of lease while this server is alive
          renewedAt = now;
        }
        await this.deliver(row);
        handled++;
      }
    }
    return handled;
  }

  /** Keeps the claim on events of the batch that are still waiting for their turn. */
  private async renewLease(rows: ClaimedRow[]): Promise<void> {
    await this.prisma.outboxEvent.updateMany({
      where: { id: { in: rows.map((r) => r.id) }, lockedBy: this.workerId, processedAt: null },
      data: { lockedUntil: new Date(this.clock.now().getTime() + OUTBOX_LEASE_MS) },
    });
  }

  /** Gives claimed events back without having tried them (the claim counted a try, which is taken back). */
  private async release(rows: ClaimedRow[]): Promise<void> {
    await this.prisma.outboxEvent
      .updateMany({
        where: { id: { in: rows.map((r) => r.id) }, lockedBy: this.workerId, processedAt: null },
        data: { lockedUntil: null, lockedBy: null, attempts: { decrement: 1 } },
      })
      .catch((error) => this.logger.warn(`Could not hand back ${rows.length} outbox event(s): ${(error as Error).message}`)); // the claim runs out by itself
  }

  private keys(): string[] {
    return [...new Set(this.consumers.flatMap((c) => c.handles.map((h) => eventKey(h.type, h.version))))];
  }

  private async claim(): Promise<ClaimedRow[]> {
    const keys = this.keys();
    if (!keys.length) return [];
    const now = this.clock.now();
    const leaseUntil = new Date(now.getTime() + OUTBOX_LEASE_MS);
    return this.prisma.$queryRaw<ClaimedRow[]>`
      UPDATE outbox_events SET locked_until = ${leaseUntil}, locked_by = ${this.workerId}, attempts = attempts + 1
      WHERE id IN (
        SELECT id FROM outbox_events
        WHERE processed_at IS NULL
          AND (type || ':' || version::text) = ANY(${keys}::text[])
          AND attempts < ${OUTBOX_MAX_ATTEMPTS}
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
          AND (locked_until IS NULL OR locked_until < ${now})
        ORDER BY occurred_at
        LIMIT ${OUTBOX_BATCH}
        FOR UPDATE SKIP LOCKED)
      RETURNING id, type, version, actor, payload, occurred_at, attempts`;
  }

  private async deliver(row: ClaimedRow): Promise<void> {
    const stored: StoredOutboxEvent = { id: row.id, type: row.type, version: row.version, actor: row.actor, payload: row.payload, occurredAt: row.occurred_at, attempts: row.attempts };
    const parsed = outboxEventSchema.safeParse({ id: row.id, type: row.type, version: row.version, occurredAt: row.occurred_at.toISOString(), actor: row.actor, payload: row.payload });
    if (!parsed.success) {
      // Cannot happen for events written by OutboxService (it validates first). Never retried: kept for a person to look at.
      await this.finish(row, { error: `invalid event: ${parsed.error.issues.map((i) => i.message).join(', ')}`.slice(0, 1000), giveUp: true });
      return;
    }

    const consumers = this.consumers.filter((c) => c.handles.some((h) => h.type === row.type && h.version === row.version));
    const delivered = new Set(
      (await this.prisma.outboxDelivery.findMany({ where: { eventId: row.id }, select: { consumer: true } })).map((d) => d.consumer),
    );
    const errors: string[] = [];
    const paused: string[] = [];
    let pausedUntil = 0;
    for (const consumer of consumers) {
      if (delivered.has(consumer.name)) continue;
      const until = this.slow.pausedUntil(consumer.name, this.clock.now());
      if (until) {
        paused.push(consumer.name);
        pausedUntil = Math.max(pausedUntil, until.getTime());
        continue;
      }
      const startedAt = Date.now();
      try {
        await withTimeout(() => consumer.handle(parsed.data, stored), OUTBOX_CONSUMER_TIMEOUT_MS, () => new ConsumerTimeoutError(consumer.name, OUTBOX_CONSUMER_TIMEOUT_MS));
        await this.prisma.outboxDelivery.createMany({ data: [{ eventId: row.id, consumer: consumer.name, deliveredAt: this.clock.now() }], skipDuplicates: true });
      } catch (error) {
        const message = (error as Error).message ?? String(error);
        errors.push(`${consumer.name}: ${message}`);
        this.logger.warn(`Consumer ${consumer.name} failed on ${row.type} ${row.id} (attempt ${row.attempts}/${OUTBOX_MAX_ATTEMPTS}): ${message}`);
        if (Date.now() - startedAt >= OUTBOX_SLOW_FAILURE_MS) {
          this.slow.pause(consumer.name, this.clock.now());
          this.logger.warn(`Consumer ${consumer.name} is paused for a while after a slow failure`);
        }
      }
    }
    if (errors.length) await this.finish(row, { error: errors.join('; ').slice(0, 1000), giveUp: false });
    else if (paused.length) await this.wait(row, new Date(pausedUntil), paused);
    else await this.finish(row, null);
  }

  /** A consumer is paused: the event waits for it without a failed try being counted, and the others carry on. */
  private async wait(row: ClaimedRow, until: Date, paused: string[]): Promise<void> {
    await this.prisma.outboxEvent.updateMany({
      where: { id: row.id, lockedBy: this.workerId },
      data: { lastError: `waiting for ${paused.join(', ')}: paused after a slow failure`, lockedUntil: null, lockedBy: null, nextAttemptAt: until, attempts: { decrement: 1 } },
    });
  }

  /** Marks the event processed, or schedules the next try. Only while this server still holds the claim. */
  private async finish(row: ClaimedRow, failure: { error: string; giveUp: boolean } | null): Promise<void> {
    const now = this.clock.now();
    if (!failure) {
      await this.prisma.outboxEvent.updateMany({
        where: { id: row.id, lockedBy: this.workerId },
        data: { processedAt: now, lockedUntil: null, lockedBy: null, lastError: null, nextAttemptAt: null },
      });
      return;
    }
    const final = failure.giveUp || row.attempts >= OUTBOX_MAX_ATTEMPTS;
    if (final) this.logger.error(`Gave up on outbox event ${row.type} ${row.id} after ${row.attempts} attempt(s): ${failure.error}`);
    await this.prisma.outboxEvent.updateMany({
      where: { id: row.id, lockedBy: this.workerId },
      data: {
        lastError: failure.error,
        lockedUntil: null,
        lockedBy: null,
        nextAttemptAt: final ? null : new Date(now.getTime() + outboxRetryDelayMs(row.attempts)),
        ...(failure.giveUp ? { attempts: OUTBOX_MAX_ATTEMPTS } : {}),
      },
    });
  }
}
