import { hostname } from 'node:os';
import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { Clock } from '../common/clock';
import { PrismaService } from '../prisma/prisma.service';

export type JobHandler = (payload: Record<string, unknown>) => Promise<void>;

interface ClaimedJob {
  id: string;
  type: string;
  payload: Record<string, unknown>;
  attempts: number;
  max_attempts: number;
}

/** A job that stays "running" this long was left behind by a crashed server and is picked up again. */
export const STALE_LOCK_MS = 5 * 60_000;
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000, 6 * 3600_000];

/**
 * Runs scheduled jobs stored in PostgreSQL (the scheduled_jobs table). Several server copies can run at once:
 * each job is claimed with FOR UPDATE SKIP LOCKED so it runs once. Failed jobs retry with a growing delay and the
 * last error is kept; a job that is still "running" after a crash is recovered once its lock is stale.
 *
 * One instance for the whole application (provided by the global CommonModule): every module registers its job types
 * on it in onModuleInit, for example `this.jobs.register('activity.daily_summary', (payload) => ...)`.
 */
@Injectable()
export class JobRunner {
  private readonly logger = new Logger('Jobs');
  private readonly handlers = new Map<string, JobHandler>();
  private readonly workerId = `${hostname()}:${process.pid}`;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
  ) {}

  register(type: string, handler: JobHandler): void {
    this.handlers.set(type, handler);
  }

  /** Creates or re-arms a job. The dedupe key keeps one job per thing (e.g. one leaving job per employee). */
  async schedule(type: string, dedupeKey: string, runAt: Date, payload: Record<string, unknown>, actorId: string | null, tx?: Pick<PrismaService, 'scheduledJob'>): Promise<void> {
    const db = tx ?? this.prisma;
    await db.scheduledJob.upsert({
      where: { dedupeKey },
      create: { type, dedupeKey, runAt, payload: payload as never, createdBy: actorId },
      update: { runAt, payload: payload as never, status: 'pending', attempts: 0, lockedAt: null, lockedBy: null, lastError: null, completedAt: null, updatedBy: actorId },
    });
  }

  /**
   * Creates a job only if no job with this dedupe key exists yet, and never re-arms one that already ran (unlike
   * schedule). For work that must happen once per period, for example one nightly summary per day: when several servers
   * try to create it, exactly one job exists. Returns true if this call created it.
   */
  async scheduleOnce(type: string, dedupeKey: string, runAt: Date, payload: Record<string, unknown>, actorId: string | null): Promise<boolean> {
    const { count } = await this.prisma.scheduledJob.createMany({
      data: [{ type, dedupeKey, runAt, payload: payload as never, createdBy: actorId }],
      skipDuplicates: true,
    });
    return count === 1;
  }

  @Interval(30_000)
  async scheduledTick(): Promise<void> {
    await this.tick().catch((e) => this.logger.error(`Job tick failed: ${(e as Error).message}`));
  }

  /** Runs everything that is due. Returns how many jobs ran. */
  async tick(): Promise<number> {
    if (this.ticking) return 0;
    this.ticking = true;
    try {
      let ran = 0;
      for (;;) {
        const job = await this.claim();
        if (!job) return ran;
        ran++;
        await this.run(job);
      }
    } finally {
      this.ticking = false;
    }
  }

  private async claim(): Promise<ClaimedJob | null> {
    const now = this.clock.now();
    const stale = new Date(now.getTime() - STALE_LOCK_MS);
    const rows = await this.prisma.$queryRaw<ClaimedJob[]>`
      UPDATE scheduled_jobs SET status = 'running', locked_at = ${now}, locked_by = ${this.workerId}, attempts = attempts + 1, updated_at = ${now}
      WHERE id = (
        SELECT id FROM scheduled_jobs
        WHERE (status = 'pending' AND run_at <= ${now}) OR (status = 'running' AND locked_at < ${stale})
        ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, type, payload, attempts, max_attempts`;
    return rows[0] ?? null;
  }

  private async run(job: ClaimedJob): Promise<void> {
    const handler = this.handlers.get(job.type);
    try {
      if (!handler) throw new Error(`No handler for job type ${job.type}`);
      await handler(job.payload);
      await this.prisma.scheduledJob.update({ where: { id: job.id }, data: { status: 'succeeded', completedAt: this.clock.now(), lockedAt: null, lockedBy: null, lastError: null } });
    } catch (error) {
      const message = (error as Error).message.slice(0, 500);
      const final = job.attempts >= job.max_attempts;
      const line = `Job ${job.type} ${job.id} failed (attempt ${job.attempts}/${job.max_attempts}): ${message}`;
      // A retry is expected noise (warning); the last failure leaves the job dead until somebody re-arms it, so it is an error.
      if (final) this.logger.error(`${line}. It stays failed and will not run again until it is re-armed by hand.`);
      else this.logger.warn(line);
      await this.prisma.scheduledJob.update({
        where: { id: job.id },
        data: {
          status: final ? 'failed' : 'pending',
          lastError: message,
          lockedAt: null,
          lockedBy: null,
          runAt: final ? undefined : new Date(this.clock.now().getTime() + BACKOFF_MS[Math.min(job.attempts - 1, BACKOFF_MS.length - 1)]),
        },
      });
    }
  }
}
