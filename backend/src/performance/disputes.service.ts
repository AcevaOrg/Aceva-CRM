import { Injectable } from '@nestjs/common';
import type { DecideDisputeRequest, DisputeListQuery, RaiseDisputeRequest, RatingDisputeView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import type { RequestInfo } from '../access/decorators';
import { AuditService } from '../access/audit.service';
import { PermissionService } from '../access/permission.service';
import { ScopeService } from '../access/scope.service';
import { Clock } from '../common/clock';
import { noteActivity } from '../common/request-context';
import { OutboxService } from '../events/outbox.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PerformanceCalculator } from './performance-calculator.service';
import { PerformanceDirectory } from './performance-directory.service';
import {
  conflict,
  currentTasks,
  disputeDecidedPayload,
  disputeNotFound,
  DISPUTE_INCLUDE,
  disputeRaisedPayload,
  figureTasksOf,
  invalid,
  isUniqueViolation,
  num,
  PERF_AUDIT,
  SCORECARD_INCLUDE,
  scorecardNotFound,
  storedMetricsOf,
  toDisputeView,
  weightsOf,
} from './performance-data';
import { canViewDispute } from './rules/core-view';
import { canDecideDispute, canRaiseDispute, canViewScorecard, validateDecision } from './rules/perf-actions';
import { rescoreStandard } from './rules/perf-figures';
import { lockScorecard, must } from './scorecards.service';

/**
 * Module 6, rating disputes. The rules are written and tested in rules/perf-actions.ts (canRaiseDispute, canDecideDispute,
 * validateDecision), rules/perf-people.ts (disputeDecider) and rules/perf-figures.ts (withCurrentRatings, rescoreStandard).
 *
 * A decided dispute IS the rating-change history: it keeps the rating at the time, the new rating, who decided and why, and the
 * score before and after. Nothing is overwritten: the scorecard's task list is never edited (the database refuses it), the
 * current rating of a task is the newest changed dispute's new rating, and a changed rating also adds a new (approved) review to
 * the task so the task page shows it. The scorecard's numbers move only in the one place below, `decide`.
 */
@Injectable()
export class DisputesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly directory: PerformanceDirectory,
    private readonly calculator: PerformanceCalculator,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  /**
   * GET /disputes?status= : the disputes the caller may see, newest first: their own, the ones they must decide, and the ones of
   * people BELOW them in the reporting line (the CEO / Founder / Owner sees all, view only).
   */
  async list(actor: Actor, query: DisputeListQuery): Promise<RatingDisputeView[]> {
    const rows = await this.prisma.ratingDispute.findMany({
      where: {
        AND: [
          { OR: [{ employeeId: actor.id }, { deciderId: actor.id }, { employee: this.scope.employeeWhere(actor.id, 'below') }] },
          ...(query.status ? [{ status: query.status }] : []),
        ],
      },
      include: DISPUTE_INCLUDE,
      orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    });
    return rows.map(toDisputeView);
  }

  /**
   * POST /disputes { scorecardId, taskNumber, reason } (201): the employee disputes the rating of one task on their OWN released
   * scorecard. Who decides is worked out now: the person above the one who GAVE the rating (the newest approved review of the
   * task) who reviews work and is not the employee; the Director when the Director rated it. One open dispute per task.
   */
  async raise(actor: Actor, body: RaiseDisputeRequest, client: RequestInfo): Promise<RatingDisputeView> {
    const card = await this.prisma.scorecard.findUnique({ where: { id: body.scorecardId }, include: SCORECARD_INCLUDE });
    // Somebody else's scorecard, and your own draft, are "not found": a draft is not revealed to the employee. Somebody else's
    // scorecard that exists is a blocked attempt (plan section 8) and is recorded as one, because the answer is a 404 and not a
    // 403; an id that does not exist, and the employee's own draft, are not.
    if (!card) throw scorecardNotFound();
    if (card.employeeId !== actor.id) {
      noteActivity({ blocked: true });
      throw scorecardNotFound();
    }
    if (!canViewScorecard({ isOwner: true, isAbove: false, status: card.status })) throw scorecardNotFound();

    const entry = currentTasks(card).find((t) => t.row.number === body.taskNumber);
    const rating = entry?.rating ?? null;
    const taskId = entry?.row.taskId ?? null;
    const ratedBy = taskId ? ((await this.prisma.taskReview.findFirst({ where: { taskId, decision: 'approved' }, orderBy: [{ createdAt: 'desc' }, { id: 'desc' }], select: { reviewer: { select: { empId: true } } } }))?.reviewer.empId ?? null) : null;
    const decider = entry ? await this.directory.deciderOf({ ratedBy, employee: actor.empId }) : null;
    const hasOpenDispute = taskId ? (await this.prisma.ratingDispute.count({ where: { scorecardId: card.id, taskId, status: 'open' } })) > 0 : false;
    must(canRaiseDispute({ isOwn: true, status: card.status, kind: card.kind, rating, onScorecard: entry !== undefined, hasOpenDispute, decider: decider?.empId ?? null }));
    if (taskId === null || rating === null || decider === null) throw invalid('not_rated', 'Choose a rated task.'); // the rule already refused; this keeps the types honest

    const now = this.clock.now();
    let created: string;
    try {
      created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.ratingDispute.create({
          data: { scorecardId: card.id, taskId, employeeId: actor.id, reason: body.reason, ratingAtRaise: rating, deciderId: decider.id, createdAt: now },
          include: DISPUTE_INCLUDE,
        });
        await this.audit.record(
          { actorId: actor.id, action: PERF_AUDIT.disputeRaised, targetType: 'dispute', targetId: row.scorecardTask.number, reason: body.reason, details: { scorecard: `${card.employee.empId} ${card.month}`, rating, decider: decider.empId }, ...client },
          tx,
        );
        await this.outbox.emit({ type: 'scorecard.dispute_raised', actor: actor.empId, payload: disputeRaisedPayload(row) }, tx);
        return row.id;
      });
    } catch (error) {
      // The unique index "one open dispute per task" settles two clicks at the same moment.
      if (isUniqueViolation(error)) throw conflict('already_disputed', 'This rating is already disputed.');
      throw error;
    }
    noteActivity({ target: body.taskNumber, description: `Disputed the rating of ${body.taskNumber}` });
    return toDisputeView(await this.prisma.ratingDispute.findUniqueOrThrow({ where: { id: created }, include: DISPUTE_INCLUDE }));
  }

  /**
   * POST /disputes/:id/decide { change, decision, newRating? } (200): upheld (keep the rating) or changed (a new rating 1 to 5).
   * Also called by the approvals provider for "dispute" items: same rules, same code path.
   *
   * Upheld: the dispute is closed, nothing else changes. Changed: in ONE transaction, in this order (the database trigger checks it):
   *   1. lock the scorecard (so two decisions on it follow each other) and make sure the dispute is still open;
   *   2. work out the new numbers with the weights version the scorecard was MADE with (never the current one), from the stored
   *      task list with the new rating (rescoreStandard);
   *   3. close the dispute as `changed` with the old and new rating, who, why, and the score and metrics before and after;
   *   4. THEN move the scorecard's numbers and raise recompute_count by one (the trigger accepts that only while a changed
   *      dispute has not been applied yet: this is the one way the numbers can change);
   *   5. add an approved review with the new rating to the task (the old review stays, the Module 5 task page shows the new one);
   *   6. audit with before and after, and the `scorecard.dispute_decided` event.
   * The scorecard stays released / acknowledged: only its numbers move.
   */
  async decide(actor: Actor, id: string, body: DecideDisputeRequest, client: RequestInfo): Promise<RatingDisputeView> {
    const dispute = await this.prisma.ratingDispute.findUnique({ where: { id }, include: DISPUTE_INCLUDE });
    if (!dispute) throw disputeNotFound();
    const isEmployee = dispute.employeeId === actor.id;
    const isDecider = dispute.deciderId === actor.id;
    const isAboveEmployee = !isEmployee && (await this.directory.isAbove(actor.id, dispute.employeeId));
    if (!canViewDispute({ isEmployee, isDecider, isAboveEmployee })) {
      noteActivity({ blocked: true }); // it exists and the caller may not see it, but the answer is a 404: record the blocked attempt (plan section 8)
      throw disputeNotFound();
    }

    const reviewsWork = await this.permissions.can(actor.id, 'task.review');
    must(canDecideDispute({ isDecider, reviewsWork, isEmployee, status: dispute.status }));
    must(validateDecision({ change: body.change, decision: body.decision, newRating: body.newRating, currentRating: dispute.ratingAtRaise }));
    const now = this.clock.now();
    const decision = body.decision.trim();

    await this.prisma.$transaction(async (tx) => {
      await lockScorecard(tx, dispute.scorecardId);
      const open = await tx.ratingDispute.findUniqueOrThrow({ where: { id }, select: { status: true } });
      must(canDecideDispute({ isDecider, reviewsWork, isEmployee, status: open.status }));

      if (!body.change || body.newRating === undefined) {
        await tx.ratingDispute.update({ where: { id }, data: { status: 'upheld', decidedById: actor.id, decision, decidedAt: now } });
        await this.finish(tx, actor, id, client, { rating: dispute.ratingAtRaise }, { rating: dispute.ratingAtRaise }, decision);
        return;
      }

      const card = await tx.scorecard.findUniqueOrThrow({ where: { id: dispute.scorecardId }, include: SCORECARD_INCLUDE });
      const weights = await this.calculator.weightsById(card.weightsVersionId, tx);
      const tasks = figureTasksOf(card, [{ taskId: dispute.taskId, newRating: body.newRating, decidedAt: now }]);
      const before = storedMetricsOf(card);
      const scoreBefore = card.score === null ? null : num(card.score);
      const after = rescoreStandard(before, tasks, weightsOf(weights));

      // (3) the dispute first: it is the record that lets the trigger accept the change of numbers below.
      await tx.ratingDispute.update({
        where: { id },
        data: {
          status: 'changed',
          decidedById: actor.id,
          decision,
          newRating: body.newRating,
          decidedAt: now,
          scoreBefore,
          scoreAfter: after.score,
          metricsBefore: before as Prisma.InputJsonValue,
          metricsAfter: after.metrics as Prisma.InputJsonValue,
        },
      });
      // (4) then the numbers, together with recompute_count + 1.
      await tx.scorecard.update({ where: { id: card.id }, data: { metrics: after.metrics as Prisma.InputJsonValue, score: after.score, band: after.band, recomputeCount: { increment: 1 } } });
      // (5) the task page (Module 5) shows the newest approved review; the earlier reviews are never edited.
      const task = await tx.task.findUniqueOrThrow({ where: { id: dispute.taskId }, select: { submittedAt: true, deadline: true } });
      await tx.taskReview.create({
        data: {
          taskId: dispute.taskId,
          reviewerId: actor.id,
          decision: 'approved',
          rating: body.newRating,
          comment: `Rating changed after a dispute: ${decision}`,
          submittedAt: task.submittedAt,
          deadlineAtReview: task.deadline,
          createdAt: now,
        },
      });
      await this.finish(tx, actor, id, client, { rating: dispute.ratingAtRaise, score: scoreBefore }, { rating: body.newRating, score: after.score }, decision);
    });

    noteActivity({ target: dispute.scorecardTask.number, description: `${body.change ? 'Changed' : 'Kept'} the rating of ${dispute.scorecardTask.number} after a dispute` });
    return toDisputeView(await this.prisma.ratingDispute.findUniqueOrThrow({ where: { id }, include: DISPUTE_INCLUDE }));
  }

  /** Step 6 of a decision: the audit entry and the event, in the same transaction as the decision. */
  private async finish(
    tx: Prisma.TransactionClient,
    actor: Actor,
    id: string,
    client: RequestInfo,
    before: { rating: number; score?: number | null },
    after: { rating: number; score?: number | null },
    decision: string,
  ): Promise<void> {
    const row = await tx.ratingDispute.findUniqueOrThrow({ where: { id }, include: DISPUTE_INCLUDE });
    await this.audit.record(
      { actorId: actor.id, action: PERF_AUDIT.disputeDecided, targetType: 'dispute', targetId: row.scorecardTask.number, reason: decision, details: { before, after, decision: row.status, scorecard: `${row.employee.empId} ${row.scorecard.month}` }, ...client },
      tx,
    );
    await this.outbox.emit({ type: 'scorecard.dispute_decided', actor: actor.empId, payload: disputeDecidedPayload(row) }, tx);
  }
}
