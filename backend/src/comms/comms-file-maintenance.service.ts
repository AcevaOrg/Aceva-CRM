import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { COMMS_UNSENT_FILE_GRACE_HOURS } from '@aceva/contracts';
import { AuditService } from '../access/audit.service';
import { Clock } from '../common/clock';
import { ENV } from '../config/config.module';
import { backgroundWorkersOn, type Env } from '../config/env';
import { JobRunner } from '../jobs/job-runner.service';
import { PrismaService } from '../prisma/prisma.service';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage';
import { commsDb } from './comms-errors';
import { COMMS_FILE_SCAN_JOB } from './comms-file.service';

/** How often the sweep runs on each server (it is safe to run on several at once). */
export const COMMS_FILE_SWEEP_MS = 15 * 60_000;
/** A file still "scanning" this long after its upload is looked at by the sweep (a normal re-check is much sooner). */
export const STUCK_SCAN_AFTER_MS = 10 * 60_000;
/**
 * The scan job gives up after its five attempts (the job runner's limit: retries after 1 minute, 5 minutes, 30 minutes
 * and 2 hours, about 2.6 hours in all). The sweep then arms it again, at most once in this period, for as long as the
 * file is still unchecked: the file stays closed (fail closed) but is never forgotten.
 */
export const RESCAN_REARM_AFTER_MS = 6 * 3_600_000;
const BATCH = 200;

export interface SweepResult {
  /** Scan jobs armed again for files still waiting for their malware check. */
  rearmed: number;
  /** Unsent files whose bytes were discarded after the grace period. */
  discarded: number;
}

/**
 * Module 14 file upkeep (review of the file sharing part):
 *  1. Files stuck in "scanning" after their scan job used up its retries get the job armed again (never opened meanwhile).
 *  2. Files uploaded to a conversation but never sent within COMMS_UNSENT_FILE_GRACE_HOURS are discarded: the record is
 *     marked (it is never deleted), THEN the bytes are removed. A file attached to a message, or added to a meeting, is
 *     never touched. A race with a send is decided by the database (see the m14_file_safety migration): the mark is set
 *     only while the file is unattached, and an attach only takes an undiscarded file, under the same row lock.
 */
@Injectable()
export class CommsFileMaintenance {
  private readonly logger = new Logger(CommsFileMaintenance.name);
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobRunner,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Interval(COMMS_FILE_SWEEP_MS)
  async scheduledSweep(): Promise<void> {
    if (!backgroundWorkersOn(this.env)) return; // tests call sweep() themselves
    if (this.running) return;
    this.running = true;
    try {
      const r = await this.sweep();
      if (r.rearmed || r.discarded) this.logger.log(`comms files: ${r.rearmed} scan job(s) armed again, ${r.discarded} unsent file(s) discarded`);
    } catch (e) {
      this.logger.error(`comms file sweep failed: ${(e as Error).message}`);
    } finally {
      this.running = false;
    }
  }

  async sweep(): Promise<SweepResult> {
    return { rearmed: await this.rearmStuckScans(), discarded: await this.discardUnsent() };
  }

  /** Files still unchecked whose scan job is gone or failed for good (and not re-armed lately): arm it again, now. */
  private async rearmStuckScans(): Promise<number> {
    const now = this.clock.now();
    const stuck = await commsDb(() =>
      this.prisma.commsFile.findMany({
        where: { scanStatus: 'scanning', discardedAt: null, createdAt: { lt: new Date(now.getTime() - STUCK_SCAN_AFTER_MS) } },
        select: { id: true },
        orderBy: { createdAt: 'asc' },
        take: BATCH,
      }),
    );
    if (!stuck.length) return 0;
    const jobs = await this.prisma.scheduledJob.findMany({
      where: { dedupeKey: { in: stuck.map((f) => `${COMMS_FILE_SCAN_JOB}:${f.id}`) } },
      // runAt: when its last attempt was due (the app clock; a failed job keeps it).
      select: { dedupeKey: true, status: true, runAt: true },
    });
    const jobOf = new Map(jobs.map((j) => [j.dedupeKey, j]));
    let rearmed = 0;
    for (const f of stuck) {
      const key = `${COMMS_FILE_SCAN_JOB}:${f.id}`;
      const job = jobOf.get(key);
      // A job still pending or running will try by itself; one that failed lately waits for the re-arm period.
      if (job && (job.status !== 'failed' || now.getTime() - job.runAt.getTime() < RESCAN_REARM_AFTER_MS)) continue;
      await this.jobs.schedule(COMMS_FILE_SCAN_JOB, key, now, { fileId: f.id }, null);
      rearmed++;
    }
    return rearmed;
  }

  /** Unsent conversation files older than the grace period: mark them discarded, then remove their bytes. */
  private async discardUnsent(): Promise<number> {
    const now = this.clock.now();
    const due = await commsDb(() =>
      this.prisma.commsFile.findMany({
        where: { conversationId: { not: null }, messageId: null, meetingId: null, discardedAt: null, createdAt: { lt: new Date(now.getTime() - COMMS_UNSENT_FILE_GRACE_HOURS * 3_600_000) } },
        select: { id: true, storageKey: true, conversationId: true, scanStatus: true },
        orderBy: { createdAt: 'asc' },
        take: BATCH,
      }),
    );
    let discarded = 0;
    for (const f of due) {
      // Marked only while still unattached; a send that attached it meanwhile makes this match nothing.
      const marked = await commsDb(() =>
        this.prisma.$transaction(async (tx) => {
          const { count } = await tx.commsFile.updateMany({ where: { id: f.id, messageId: null, discardedAt: null }, data: { discardedAt: now } });
          if (count) {
            await this.audit.record({ actorId: null, action: 'comms.file.discarded', targetType: 'comms_file', targetId: f.id, details: { conversationId: f.conversationId, graceHours: COMMS_UNSENT_FILE_GRACE_HOURS } }, tx);
          }
          return count === 1;
        }),
      );
      if (!marked) continue;
      discarded++;
      // A blocked file's bytes were never stored. Removing is idempotent; a failure leaves private bytes behind, never a
      // file anyone can open (a discarded file is refused for download and for sending).
      if (f.scanStatus !== 'blocked') await this.storage.remove(f.storageKey).catch(() => this.logger.error(`comms file ${f.id}: discarded, but its bytes could not be removed`));
    }
    return discarded;
  }
}
