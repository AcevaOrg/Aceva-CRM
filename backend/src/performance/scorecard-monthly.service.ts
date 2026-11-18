import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../access/audit.service';
import { Clock } from '../common/clock';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { OutboxService } from '../events/outbox.service';
import { JobRunner } from '../jobs/job-runner.service';
import { PrismaService } from '../prisma/prisma.service';
import { PerformanceCalculator } from './performance-calculator.service';
import { draftedPayload, isUniqueViolation, PERF_AUDIT, releasedPayload, scorecardCreateData, SCORECARD_INCLUDE, scorecardTarget } from './performance-data';
import { PerformanceDirectory, type DirectoryPerson } from './performance-directory.service';
import { PerformanceMail } from './performance-mail.service';
import { checkRunnable, ensureRunAt, failureMessage, runSummary, splitExisting } from './rules/auto-monthly';
import { monthsToEnsure, monthWindow, scorecardJobKey, SCORECARD_JOB } from './rules/perf-month';

/** What one run of the monthly job did. */
export interface MonthlyRunResult {
  month: string;
  /** Draft scorecards made now (the Director's, released at once, included). */
  created: number;
  /** People who already had a scorecard for the month (a re-run): left exactly as they are. */
  existing: number;
  /** The ones released by the system because the person has no reviewer (the Director). */
  autoReleased: number;
  /** People whose scorecard could not be made (the run goes on; the job fails at the end so it is retried). */
  failed: number;
}

/** On start-up and every hour the server makes sure the jobs of the month that just closed and of the current month exist. */
const ENSURE_EVERY_MS = 3_600_000;

/** What making one person's scorecard came to. */
type MadeOne = { made: false } | { made: true; autoReleased: boolean; reviewerEmpId: string | null };

/**
 * Module 6, the monthly scorecard job (plan section 10): on the 1st of each month, at 00:10 Pakistan time, a draft scorecard for
 * every person who is still with the company (and has a manager: the CEO / Founder / Owner is not scored), for the month that
 * just closed, with the weights version in force for their kind and department.
 *
 *  - The figures come from PerformanceCalculator (the one place that works a month out); this service only stores them: the
 *    scorecard, the snapshot of the tasks it was made from, the audit entry and the outbox events are written in ONE transaction
 *    per person.
 *  - IDEMPOTENT: one scorecard per person and month (a unique key). A person who has one is skipped and never overwritten, so
 *    a re-run, a retry after a partial failure, or two servers running it at once make nothing twice.
 *  - The Director's scorecard has no reviewer (the CEO / Founder / Owner reviews nothing): it is released at once by the system.
 *  - Each reviewer gets ONE mail for all their drafts. Mail trouble never fails the job (the drafts are in the Approvals inbox
 *    anyway); it is logged.
 *  - The job of a month is one scheduled_jobs row, keyed `scorecard.monthly:<month>` (never made twice). On start-up and hourly the
 *    server makes sure the job of the month that just closed (due now if its moment passed: catching up after downtime) and of the
 *    current month exist. Older months are never made up for. Scheduling is off when background work is off
 *    (OUTBOX_DISPATCH_INTERVAL_MS <= 0, as in the tests).
 *
 * Run by hand (the hand-check): a scheduled_jobs row of type `scorecard.monthly` with payload {"month":"2026-11"} and run_at in the
 * past, or `run(month)` from a test. A month that has not started is refused.
 */
@Injectable()
export class ScorecardMonthly implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('ScorecardMonthly');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobRunner,
    private readonly clock: Clock,
    private readonly directory: PerformanceDirectory,
    private readonly calculator: PerformanceCalculator,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly mail: PerformanceMail,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** Registers the job type SCORECARD_JOB on the JobRunner: its handler calls `run(String(payload.month))`. Never throws. */
  onModuleInit(): void {
    this.jobs.register(SCORECARD_JOB, async (payload) => {
      await this.run(String(payload.month));
    });
  }

  /**
   * Makes sure the jobs exist (ensureScheduled) when the server starts and every hour after, unless background work is off
   * (OUTBOX_DISPATCH_INTERVAL_MS <= 0). Catches up after downtime on the 1st. Never throws (the error is logged).
   */
  onApplicationBootstrap(): void {
    if (this.env.OUTBOX_DISPATCH_INTERVAL_MS <= 0) return;
    const ensure = () => this.ensureScheduled().catch((error) => this.logger.error(`Could not schedule the monthly scorecards: ${(error as Error).message}`));
    void ensure();
    this.timer = setInterval(() => void ensure(), ENSURE_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Creates the jobs of monthsToEnsure(now) that do not exist yet: the month that just closed (run at 00:10 on the 1st, or right
   * away when that moment has passed) and the current month (due 00:10 Pakistan time on the 1st of next month). One job per
   * month (scheduleOnce: never made twice, never re-armed once it ran). Returns how many jobs it created. Older months are never
   * made up for.
   */
  async ensureScheduled(): Promise<number> {
    const now = this.clock.now();
    let created = 0;
    for (const month of monthsToEnsure(now)) {
      if (await this.jobs.scheduleOnce(SCORECARD_JOB, scorecardJobKey(month), ensureRunAt(month, now), { month }, null)) created++;
    }
    return created;
  }

  /**
   * Makes the draft scorecards of `month` ("2026-10") for everybody. Called by the job and directly by tests. IDEMPOTENT: a second
   * run never duplicates or overwrites anything (it checks first, and the unique key person + month is the safety net).
   * `now` is the moment of measuring (which open tasks are already due); the job uses the clock.
   *
   * For every person from directory.scorable (not left, has a manager, joined before the month ended): skip when they already
   * have a scorecard for the month; otherwise work the figures out (calculator, the weights version in force for their kind and
   * department), find the reviewer, and in ONE transaction store the scorecard with its task snapshot, the audit entry and the
   * events (`scorecard.drafted`; for a person with no reviewer, the Director, also `scorecard.released` by the system, and the
   * scorecard is created released). One person failing is logged and counted; the others still get theirs. Afterwards each reviewer
   * who got new drafts gets one mail. When somebody failed the run throws at the end so the job runner retries (the retry skips
   * everyone already done).
   */
  async run(month: string, now: Date = this.clock.now()): Promise<MonthlyRunResult> {
    const runnable = checkRunnable(month, now);
    if (!runnable.ok) throw new Error(runnable.message);

    const people = await this.directory.people();
    const scorable = await this.directory.scorable(monthWindow(month).end, people);
    const have = new Set((await this.prisma.scorecard.findMany({ where: { month }, select: { employeeId: true } })).map((r) => r.employeeId));
    const { todo, existing } = splitExisting(scorable, have);

    const result: MonthlyRunResult = { month, created: 0, existing: existing.length, autoReleased: 0, failed: 0 };
    const reviewersWithNewDrafts = new Set<string>();
    for (const person of todo) {
      try {
        const outcome = await this.makeOne(person, month, now, people);
        if (!outcome.made) {
          result.existing++; // another server made it between the check and now
          continue;
        }
        result.created++;
        if (outcome.autoReleased) result.autoReleased++;
        else if (outcome.reviewerEmpId) reviewersWithNewDrafts.add(outcome.reviewerEmpId);
      } catch (error) {
        result.failed++;
        this.logger.error(`The scorecard of ${person.empId} for ${month} could not be made: ${(error as Error).message}`);
      }
    }

    if (reviewersWithNewDrafts.size) {
      try {
        await this.mail.draftsWaiting(month, { reviewers: reviewersWithNewDrafts });
      } catch (error) {
        // The drafts exist and wait in the Approvals inbox; a mail that did not go out must not undo or repeat the run.
        this.logger.warn(`The "drafts are waiting" mail was not sent to everybody: ${(error as Error).message}`);
      }
    }

    this.logger.log(runSummary(result));
    if (result.failed > 0) throw new Error(failureMessage(result));
    return result;
  }

  /** One person's scorecard for the month: figures, then one transaction. `made: false` = somebody else made it first. */
  private async makeOne(person: DirectoryPerson, month: string, now: Date, people: DirectoryPerson[]): Promise<MadeOne> {
    const reviewer = await this.directory.reviewerOf(person.empId, people);
    const computed = await this.calculator.compute({ id: person.id, empId: person.empId, departmentId: person.departmentId, roleKey: person.roleKey }, month, now);
    const autoRelease = reviewer === null;
    try {
      await this.prisma.$transaction(async (tx) => {
        const row = await tx.scorecard.create({
          data: scorecardCreateData({ employeeId: person.id, month, weightsVersionId: computed.weights.id, reviewerId: reviewer?.id ?? null, figures: computed.figures, now, autoRelease }),
          include: SCORECARD_INCLUDE,
        });
        await this.audit.record(
          {
            actorId: null,
            action: PERF_AUDIT.drafted,
            targetType: 'scorecard',
            targetId: scorecardTarget(row),
            details: { scorecardId: row.id, employee: person.empId, month, kind: row.kind, weightsVersionId: row.weightsVersionId, reviewer: reviewer?.empId ?? null, taskCount: row.taskCount, smallSample: row.smallSample },
          },
          tx,
        );
        await this.outbox.emit({ type: 'scorecard.drafted', actor: 'system', payload: draftedPayload(row, reviewer?.empId ?? null) }, tx);
        if (autoRelease) {
          await this.audit.record(
            { actorId: null, action: PERF_AUDIT.released, targetType: 'scorecard', targetId: scorecardTarget(row), reason: 'The person has no reviewer: released by the system', details: { scorecardId: row.id, employee: person.empId, month, automatic: true } },
            tx,
          );
          await this.outbox.emit({ type: 'scorecard.released', actor: 'system', payload: releasedPayload(row, null, false) }, tx);
        }
      });
    } catch (error) {
      if (isUniqueViolation(error)) return { made: false };
      throw error;
    }
    return { made: true, autoReleased: autoRelease, reviewerEmpId: reviewer?.empId ?? null };
  }
}
