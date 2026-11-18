import { Injectable, NotFoundException } from '@nestjs/common';
import type { ScorecardDetailView, ScorecardListQuery, ScorecardView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import type { RequestInfo } from '../access/decorators';
import { AuditService } from '../access/audit.service';
import { Clock } from '../common/clock';
import { noteActivity } from '../common/request-context';
import { OutboxService } from '../events/outbox.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PerformanceCalculator, type ScoreSubject } from './performance-calculator.service';
import { PerformanceDirectory, type DirectoryPerson } from './performance-directory.service';
import {
  acknowledgedPayload,
  DISPUTE_INCLUDE,
  forbidden,
  PERF_AUDIT,
  refusal,
  releasedPayload,
  SCORECARD_INCLUDE,
  scorecardNotFound,
  scorecardTarget,
  toCommentViews,
  toDisputeView,
  toScorecardView,
  toPerformanceWeightsView,
  type ScorecardRow,
} from './performance-data';
import { reviewerShown } from './rules/core-view';
import { canAcknowledge, canAddRemark, canRelease, canViewScorecard, type RuleResult, type ScorecardStatusName } from './rules/perf-actions';
import { monthLabel } from './rules/perf-month';

/** Answers the rule's refusal as the right HTTP error (403 / 409 / 400); does nothing when the rule says yes. */
export function must(result: RuleResult): void {
  if (!result.ok) throw refusal(result);
}

/**
 * Locks the scorecard row until the end of the transaction, so two people acting on it at the same moment are served one
 * after the other, and returns its status as it is now (the caller checks the rule again with it).
 */
export async function lockScorecard(tx: Prisma.TransactionClient, id: string): Promise<ScorecardStatusName> {
  const rows = await tx.$queryRaw<Array<{ status: string }>>`SELECT status::text AS status FROM scorecards WHERE id = ${id}::uuid FOR UPDATE`;
  if (rows.length === 0) throw scorecardNotFound();
  return rows[0].status as ScorecardStatusName;
}

/** The audit target of a scorecard, and the words in logs: "ACV-0006 2026-10" (the same key the monthly job uses). */
const targetOf = scorecardTarget;

/**
 * Module 6, scorecards. The rules of who may do what are written and tested in rules/perf-actions.ts (canViewScorecard,
 * canAddRemark, canRelease, canAcknowledge); a refusal becomes the HTTP error with `refusal(result)`. The mappers and the
 * event payload builders are in performance-data.ts.
 *
 * THE NUMBERS OF A SCORECARD NEVER CHANGE here: this service never writes metrics, score, band, weights version, task count or
 * tasks (the database trigger `scorecards_protect` would refuse it; the one exception is DisputesService.decide). It only moves
 * the status forward (release, acknowledge) and adds remarks and comments (an insert-only history). Every change is one
 * transaction with its audit entry and its outbox event.
 *
 * Who sees what: the employee sees released scorecards only (a draft answers 404, as if it did not exist); the people above the
 * employee in the reporting line see drafts too, view only (the CTO: Development and SQA; the Director: everyone below; the
 * CEO / Founder / Owner: everyone). Beside or below, nobody.
 */
@Injectable()
export class ScorecardsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly directory: PerformanceDirectory,
    private readonly calculator: PerformanceCalculator,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------------------------------------ shared by the core services

  /**
   * The person a request is about: `empId`, or the caller. 404 for an Emp-ID nobody has; 403 `forbidden` unless it is the
   * caller or somebody below the caller in the reporting line ("You can only see your own results and your team's.").
   */
  async resolvePerson(actor: Actor, empId?: string): Promise<ScoreSubject & { isOwn: boolean }> {
    const wanted = empId ?? actor.empId;
    const row = await this.prisma.employee.findUnique({ where: { empId: wanted }, select: { id: true, empId: true, departmentId: true, role: { select: { key: true } } } });
    if (!row) throw new NotFoundException({ statusCode: 404, code: 'not_found', message: 'Person not found' });
    const isOwn = row.id === actor.id;
    if (!isOwn && !(await this.directory.canSeePerson(actor.id, row.id))) throw forbidden('forbidden', "You can only see your own results and your team's.");
    return { id: row.id, empId: row.empId, departmentId: row.departmentId, roleKey: row.role.key, isOwn };
  }

  /** The contract view of a scorecard, with the reviewer shown as `reviewerShown` says. Pass `people` to save a query. */
  async viewOf(row: ScorecardRow, people?: DirectoryPerson[]): Promise<ScorecardView> {
    const current = row.status === 'draft' ? ((await this.directory.reviewerOf(row.employee.empId, people))?.empId ?? null) : null;
    const reviewerEmpId = reviewerShown({ status: row.status, currentReviewer: current, storedReviewer: row.reviewer?.empId ?? null, releasedBy: row.releasedBy?.empId ?? null });
    return toScorecardView(row, { reviewerEmpId });
  }

  private async loadView(id: string): Promise<ScorecardView> {
    return this.viewOf(await this.prisma.scorecard.findUniqueOrThrow({ where: { id }, include: SCORECARD_INCLUDE }));
  }

  /**
   * The scorecard if the actor may see it (the person after release, or someone above them), else 404. A scorecard that exists
   * but is somebody else's, outside the actor's line, is a BLOCKED ATTEMPT (plan section 8): the answer is a 404 (never a 403,
   * which would confirm that it exists), so this tells the activity recorder itself (noteActivity blocked). An id that does not
   * exist is not an attempt, and neither is the employee asking for their own draft (hidden from them by design).
   */
  private async visible(actor: Actor, id: string): Promise<{ row: ScorecardRow; isOwner: boolean }> {
    const row = await this.prisma.scorecard.findUnique({ where: { id }, include: SCORECARD_INCLUDE });
    if (!row) throw scorecardNotFound();
    const isOwner = row.employeeId === actor.id;
    const isAbove = !isOwner && (await this.directory.isAbove(actor.id, row.employeeId));
    if (!canViewScorecard({ isOwner, isAbove, status: row.status })) {
      if (!isOwner) noteActivity({ blocked: true });
      throw scorecardNotFound();
    }
    return { row, isOwner };
  }

  /** Is the actor the person who reviews and releases this scorecard now (the manager, or the next level up when the manager left or does not review work; holds task.review)? */
  private async isReviewer(actor: Actor, row: ScorecardRow): Promise<boolean> {
    return (await this.directory.reviewerOf(row.employee.empId))?.empId === actor.empId;
  }

  // ------------------------------------------------------------------------------------------------ reading

  /**
   * GET /scorecards?empId=&latest=&month=&limit= : a person's scorecards, newest month first. The person is `empId` or the
   * caller. The employee NEVER gets a draft of their own; people above them do. `latest` = at most the newest one (an empty list
   * when there is none, never a null body).
   */
  async list(actor: Actor, query: ScorecardListQuery): Promise<ScorecardView[]> {
    const person = await this.resolvePerson(actor, query.empId);
    const where: Prisma.ScorecardWhereInput = { employeeId: person.id };
    if (person.isOwn) where.status = { not: 'draft' };
    if (query.month) where.month = query.month;
    const rows = await this.prisma.scorecard.findMany({ where, include: SCORECARD_INCLUDE, orderBy: { month: 'desc' }, take: query.latest ? 1 : (query.limit ?? 36) });
    const people = rows.some((r) => r.status === 'draft') ? await this.directory.people() : undefined;
    const views: ScorecardView[] = [];
    for (const row of rows) views.push(await this.viewOf(row, people));
    return views;
  }

  /**
   * GET /scorecards/:id : { scorecard, weights, disputes, comments }. 404 (never 403) when the caller may not see it. `weights` is
   * the version the scorecard was MADE with, never the current one.
   */
  async get(actor: Actor, id: string): Promise<ScorecardDetailView> {
    const { row } = await this.visible(actor, id);
    const [weights, disputes] = await Promise.all([
      this.calculator.weightsById(row.weightsVersionId),
      this.prisma.ratingDispute.findMany({ where: { scorecardId: row.id }, include: DISPUTE_INCLUDE, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }] }),
    ]);
    return { scorecard: await this.viewOf(row), weights: toPerformanceWeightsView(weights), disputes: disputes.map(toDisputeView), comments: toCommentViews(row) };
  }

  // ------------------------------------------------------------------------------------------------ the reviewer

  /**
   * POST /scorecards/:id/remark { remark } : the reviewer adds a remark; the numbers are untouched. Several remarks are kept (the
   * history), the newest is shown. A draft or a released scorecard takes one; an acknowledged one does not (409).
   */
  async addRemark(actor: Actor, id: string, remark: string, client: RequestInfo): Promise<ScorecardView> {
    const { row } = await this.visible(actor, id);
    const isReviewer = await this.isReviewer(actor, row);
    must(canAddRemark({ isReviewer, status: row.status }));
    const now = this.clock.now();

    await this.prisma.$transaction(async (tx) => {
      const status = await lockScorecard(tx, id);
      must(canAddRemark({ isReviewer, status }));
      await tx.scorecardComment.create({ data: { scorecardId: id, kind: 'reviewer_remark', authorId: actor.id, body: remark, createdAt: now } });
      await this.audit.record({ actorId: actor.id, action: PERF_AUDIT.remark, targetType: 'scorecard', targetId: targetOf(row), details: { scorecardId: id, length: remark.length }, ...client }, tx);
    });
    noteActivity({ target: targetOf(row), description: `Added a remark to the ${monthLabel(row.month)} scorecard of ${row.employee.empId}` });
    return this.loadView(id);
  }

  /**
   * POST /scorecards/:id/release { remark? } : the reviewer releases a draft to the employee (with an optional remark). Never
   * for the reviewer's own scorecard (403 `own_scorecard`), only a draft (409 once released). The employee is mailed from the
   * `scorecard.released` event. (The Director's scorecard has no reviewer: the monthly job releases it, never this route.)
   */
  async release(actor: Actor, id: string, remark: string | undefined, client: RequestInfo): Promise<ScorecardView> {
    const { row } = await this.visible(actor, id);
    const isOwn = row.employeeId === actor.id;
    const isReviewer = await this.isReviewer(actor, row);
    must(canRelease({ isReviewer, isOwn, status: row.status }));
    const now = this.clock.now();

    await this.prisma.$transaction(async (tx) => {
      const status = await lockScorecard(tx, id);
      must(canRelease({ isReviewer, isOwn, status }));
      await tx.scorecard.update({ where: { id }, data: { status: 'released', releasedAt: now, releasedById: actor.id } });
      if (remark) await tx.scorecardComment.create({ data: { scorecardId: id, kind: 'reviewer_remark', authorId: actor.id, body: remark, createdAt: now } });
      const fresh = await tx.scorecard.findUniqueOrThrow({ where: { id }, include: SCORECARD_INCLUDE });
      await this.audit.record(
        { actorId: actor.id, action: PERF_AUDIT.released, targetType: 'scorecard', targetId: targetOf(row), details: { scorecardId: id, before: { status: 'draft' }, after: { status: 'released' }, withRemark: Boolean(remark) }, ...client },
        tx,
      );
      await this.outbox.emit({ type: 'scorecard.released', actor: actor.empId, payload: releasedPayload(fresh, actor.empId, Boolean(remark)) }, tx);
    });
    noteActivity({ target: targetOf(row), description: `Released the ${monthLabel(row.month)} scorecard of ${row.employee.empId}` });
    return this.loadView(id);
  }

  // ------------------------------------------------------------------------------------------------ the employee

  /**
   * POST /scorecards/:id/acknowledge { comment? } : the employee acknowledges a released scorecard. A scorecard the caller may
   * not see is 404; one they may see but is not theirs is 403 `not_owner`; a draft or an acknowledged one is 409.
   */
  async acknowledge(actor: Actor, id: string, comment: string | undefined, client: RequestInfo): Promise<ScorecardView> {
    const { row, isOwner } = await this.visible(actor, id);
    must(canAcknowledge({ isOwn: isOwner, status: row.status }));
    const now = this.clock.now();
    const reviewer = (await this.directory.reviewerOf(row.employee.empId))?.empId ?? null;

    await this.prisma.$transaction(async (tx) => {
      const status = await lockScorecard(tx, id);
      must(canAcknowledge({ isOwn: isOwner, status }));
      await tx.scorecard.update({ where: { id }, data: { status: 'acknowledged', acknowledgedAt: now } });
      if (comment) await tx.scorecardComment.create({ data: { scorecardId: id, kind: 'employee_comment', authorId: actor.id, body: comment, createdAt: now } });
      const fresh = await tx.scorecard.findUniqueOrThrow({ where: { id }, include: SCORECARD_INCLUDE });
      await this.audit.record(
        { actorId: actor.id, action: PERF_AUDIT.acknowledged, targetType: 'scorecard', targetId: targetOf(row), details: { scorecardId: id, before: { status: 'released' }, after: { status: 'acknowledged' }, withComment: Boolean(comment) }, ...client },
        tx,
      );
      await this.outbox.emit({ type: 'scorecard.acknowledged', actor: actor.empId, payload: acknowledgedPayload(fresh, reviewer, Boolean(comment)) }, tx);
    });
    noteActivity({ target: targetOf(row), description: `Acknowledged the ${monthLabel(row.month)} scorecard` });
    return this.loadView(id);
  }
}
