/**
 * Shared Module 6 data helpers, used by the core and the automation code alike: the Prisma "include"s that load a
 * scorecard, a dispute or a weights version with everything the screens show, the mappers from database rows to the
 * contract shapes (packages/contracts/src/performance.ts), the rows a new scorecard is made of, the standard answers
 * (404 / 403 / 409 / 400) and the event payload builders. Plain functions, no Nest.
 *
 * What a scorecard row stores and how it is read back:
 *  - `metrics` (json): the five metrics, each 0 to 100 or null (not measured); standard scorecards also hold workloadHours.
 *  - `unmeasured` (json): [{ key, reason }] for every null metric.
 *  - `tasks`: the tasks it was made from. Their rating is the rating at that moment; a "changed" dispute may have set a
 *    new one since, so the views always show `withCurrentRatings` (the latest changed dispute wins) and keep the original.
 *  - The newest reviewer remark and the employee comment are the latest rows of `comments` (an insert-only history).
 */
import type {
  BandName,
  OutboxEvent,
  PerformanceWeightsView,
  RatingDisputeView,
  SalesDetailView,
  SalesMetricsView,
  ScoreWeightsVersionView,
  ScorecardCommentView,
  ScorecardTaskView,
  ScorecardView,
  StandardMetricsView,
  UnmeasuredView,
} from '@aceva/contracts';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import type { Refusal } from './rules/perf-actions';
import { withCurrentRatings, type FigureTask, type MonthFigures, type RatingChange, type StoredMetrics, type Unmeasured } from './rules/perf-figures';
import type { ScorecardKind } from './rules/perf-score';
import { weightsLabel } from './rules/perf-score';

export type Db = PrismaService | Prisma.TransactionClient;

/** A Prisma Decimal (score) as a plain number. */
export const num = (value: Prisma.Decimal | number | string): number => Number(value);
const iso = (d: Date): string => d.toISOString();

// ---------------------------------------------------------------------------------------------------------- errors

/** 404 for a scorecard that does not exist or that the person may not see (never revealed which). */
export const scorecardNotFound = (): NotFoundException => new NotFoundException({ statusCode: 404, code: 'not_found', message: 'Scorecard not found' });
export const disputeNotFound = (): NotFoundException => new NotFoundException({ statusCode: 404, code: 'not_found', message: 'Dispute not found' });
/** 403: may see it, may not do this. */
export const forbidden = (code: string, message: string): ForbiddenException => new ForbiddenException({ statusCode: 403, code, message });
/** 400: broken input and rule errors; `code` is the rule's code. */
export const invalid = (code: string, message: string): BadRequestException => new BadRequestException({ statusCode: 400, code, message });
/** 409: state conflicts (already released, already decided, already disputed). */
export const conflict = (code: string, message: string): ConflictException => new ConflictException({ statusCode: 409, code, message });

/** A refusal from rules/perf-actions.ts as the right HTTP error. */
export function refusal(r: Refusal): ForbiddenException | ConflictException | BadRequestException {
  if (r.kind === 'forbidden') return forbidden(r.code, r.message);
  if (r.kind === 'conflict') return conflict(r.code, r.message);
  return invalid(r.code, r.message);
}

/** True when the error is the database refusing a duplicate (unique index). */
export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  return e?.code === 'P2002' || /duplicate key|unique constraint/i.test(e?.message ?? '');
}

/** The audit log actions of this module (audit_log.action). Settings changes are recorded as `settings.score_weights.created` on target settings / score-weights. */
export const PERF_AUDIT = {
  weightsCreated: 'settings.score_weights.created',
  drafted: 'scorecard.drafted',
  remark: 'scorecard.remark',
  released: 'scorecard.released',
  acknowledged: 'scorecard.acknowledged',
  disputeRaised: 'scorecard.dispute.raised',
  disputeDecided: 'scorecard.dispute.decided',
} as const;

/**
 * The audit target of EVERY scorecard entry (drafted, remark, released, acknowledged; by a person or by the system):
 * "<Emp-ID> <month>", e.g. "ACV-0006 2026-10". One key, so a search by target returns a scorecard's whole history; the
 * scorecard id is in the details of the entries that are made from the row.
 */
export const scorecardTarget = (row: { month: string; employee: { empId: string } }): string => `${row.employee.empId} ${row.month}`;

// ---------------------------------------------------------------------------------------------------------- weights

export const WEIGHTS_INCLUDE = {
  createdBy: { select: { empId: true } },
  department: { select: { name: true } },
} satisfies Prisma.ScoreWeightVersionInclude;
export type WeightsRow = Prisma.ScoreWeightVersionGetPayload<{ include: typeof WEIGHTS_INCLUDE }>;

/** The weights as a plain record of whole percents. */
export const weightsOf = (row: { weights: Prisma.JsonValue }): Record<string, number> => row.weights as Record<string, number>;

export function toWeightsView(row: WeightsRow): ScoreWeightsVersionView {
  return {
    id: row.id,
    label: weightsLabel(row.kind, row.versionNo),
    kind: row.kind,
    departmentId: row.departmentId ?? undefined,
    departmentName: row.department?.name,
    weights: weightsOf(row),
    versionNo: row.versionNo,
    effectiveFrom: iso(row.effectiveFrom),
    createdBy: row.createdBy?.empId ?? null,
    note: row.note ?? undefined,
  };
}

/**
 * The weights as the live figures and a scorecard carry them (PerformanceWeightsView): the set and its label only. WITHOUT
 * createdBy and note: the Director's reason for a change is what Settings (settings.view) shows, and every employee may read
 * their own live figures and scorecards.
 */
export function toPerformanceWeightsView(row: WeightsRow): PerformanceWeightsView {
  return {
    id: row.id,
    label: weightsLabel(row.kind, row.versionNo),
    kind: row.kind,
    departmentId: row.departmentId ?? undefined,
    departmentName: row.department?.name,
    weights: weightsOf(row),
    versionNo: row.versionNo,
    effectiveFrom: iso(row.effectiveFrom),
  };
}

// ---------------------------------------------------------------------------------------------------------- scorecards

/** Everything a scorecard screen needs, in one query (the changed disputes only: they set the current ratings). */
export const SCORECARD_INCLUDE = {
  employee: { select: { empId: true } },
  reviewer: { select: { empId: true } },
  releasedBy: { select: { empId: true } },
  tasks: { orderBy: { position: 'asc' } },
  comments: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }], include: { author: { select: { empId: true } } } },
  disputes: { where: { status: 'changed' }, orderBy: { decidedAt: 'asc' } },
} satisfies Prisma.ScorecardInclude;
export type ScorecardRow = Prisma.ScorecardGetPayload<{ include: typeof SCORECARD_INCLUDE }>;

/** The stored metrics as the screens get them: null = not measured. */
export function toMetricsView(kind: ScorecardKind, json: Prisma.JsonValue): StandardMetricsView | SalesMetricsView {
  const m = (json ?? {}) as Record<string, number | null | undefined>;
  const n = (key: string): number | null => (typeof m[key] === 'number' ? (m[key] as number) : null);
  if (kind === 'sales') return { activity: n('activity'), meetings: n('meetings'), won: n('won'), dataQuality: n('dataQuality'), attendance: n('attendance') };
  return { quality: n('quality'), onTime: n('onTime'), completion: n('completion'), rework: n('rework'), attendance: n('attendance'), workloadHours: n('workloadHours') ?? 0 };
}

export const storedMetricsOf = (row: { metrics: Prisma.JsonValue }): StoredMetrics => row.metrics as StoredMetrics;
export const unmeasuredOf = (row: { unmeasured: Prisma.JsonValue }): UnmeasuredView[] => (row.unmeasured as unknown as Unmeasured[]) ?? [];
const salesDetailOf = (row: { salesDetail: Prisma.JsonValue | null }): SalesDetailView | undefined => (row.salesDetail ? (row.salesDetail as unknown as SalesDetailView) : undefined);

type SnapshotRow = ScorecardRow['tasks'][number];

/** One snapshot row as the views show it, with the rating a changed dispute set (the original is kept next to it). */
export function toScorecardTaskView(t: SnapshotRow, current: { rating: number | null; originalRating: number | null }): ScorecardTaskView {
  return {
    taskId: t.taskId,
    number: t.number,
    title: t.title,
    size: t.size,
    points: t.points,
    rating: current.rating ?? undefined,
    originalRating: current.originalRating ?? undefined,
    onTime: t.onTime,
    reworked: t.reworked,
    extensions: t.extensions,
    status: t.status,
    deadline: iso(t.deadline),
    counted: t.counted,
  };
}

/** The tasks of a scorecard with their current ratings (snapshot, or the newest changed dispute for the task). */
export function currentTasks(row: ScorecardRow): Array<{ row: SnapshotRow; rating: number | null; originalRating: number | null }> {
  const changes = row.disputes.filter((d) => d.newRating !== null && d.decidedAt !== null).map((d) => ({ taskId: d.taskId, newRating: d.newRating as number, decidedAt: d.decidedAt as Date }));
  const withRatings = withCurrentRatings(row.tasks.map((t) => ({ taskId: t.taskId, rating: t.rating, row: t })), changes);
  return withRatings.map((t) => ({ row: t.row, rating: t.rating, originalRating: t.originalRating }));
}

/**
 * The stored task list of a scorecard as rule inputs (rules/perf-figures.ts rescoreStandard), with the current ratings.
 * `extraChanges` = a rating change that is being decided right now (not yet saved), so the recompute sees it.
 */
export function figureTasksOf(row: ScorecardRow, extraChanges: readonly RatingChange[] = []): FigureTask[] {
  const saved = row.disputes.filter((d) => d.newRating !== null && d.decidedAt !== null).map((d) => ({ taskId: d.taskId, newRating: d.newRating as number, decidedAt: d.decidedAt as Date }));
  const rated = withCurrentRatings(row.tasks.map((t) => ({ taskId: t.taskId, rating: t.rating, snapshot: t })), [...saved, ...extraChanges]);
  return rated.map(({ snapshot: t, rating }) => ({
    taskId: t.taskId,
    number: t.number,
    title: t.title,
    size: t.size,
    points: t.points,
    rating,
    onTime: t.onTime,
    reworked: t.reworked,
    extensions: t.extensions,
    status: t.status,
    deadline: t.deadline,
    counted: t.counted,
  }));
}

/**
 * The contract view of a scorecard. `reviewerEmpId` is the person who reviews and releases it NOW (the services work it
 * out: the stored reviewer, or the next one up when that person left or does not review work); without it the stored reviewer, or for a released
 * scorecard who released it, is shown. A scorecard without a reviewer (the Director's) has none.
 */
export function toScorecardView(row: ScorecardRow, options: { reviewerEmpId?: string | null } = {}): ScorecardView {
  const remarks = row.comments.filter((c) => c.kind === 'reviewer_remark');
  const comments = row.comments.filter((c) => c.kind === 'employee_comment');
  const remark = remarks.at(-1);
  const comment = comments.at(-1);
  const reviewerEmpId = options.reviewerEmpId === undefined ? (row.reviewer?.empId ?? undefined) : (options.reviewerEmpId ?? undefined);
  return {
    id: row.id,
    empId: row.employee.empId,
    month: row.month,
    kind: row.kind,
    metrics: toMetricsView(row.kind, row.metrics),
    salesDetail: salesDetailOf(row),
    unmeasured: unmeasuredOf(row),
    weightsVersionId: row.weightsVersionId,
    score: row.score === null ? null : num(row.score),
    band: row.band as BandName | null,
    taskCount: row.taskCount,
    smallSample: row.smallSample,
    status: row.status,
    reviewerEmpId,
    reviewerRemark: remark?.body,
    remarkAt: remark ? iso(remark.createdAt) : undefined,
    releasedAt: row.releasedAt ? iso(row.releasedAt) : undefined,
    releasedBy: row.releasedBy?.empId,
    acknowledgedAt: row.acknowledgedAt ? iso(row.acknowledgedAt) : undefined,
    employeeComment: comment?.body,
    recomputeCount: row.recomputeCount,
    tasks: currentTasks(row).map((t) => toScorecardTaskView(t.row, t)),
    createdAt: iso(row.createdAt),
  };
}

export function toCommentViews(row: ScorecardRow): ScorecardCommentView[] {
  return row.comments.map((c) => ({ id: c.id, kind: c.kind, author: c.author.empId, body: c.body, at: iso(c.createdAt) }));
}

/**
 * The rows a new scorecard is made of, from the figures of the month (the monthly job inserts exactly this, in one
 * transaction with its comments and events). `autoRelease` = the person has no reviewer: the system releases it at once
 * (status released, released_by null). The unique (employee, month) makes a second run a no-op.
 */
export function scorecardCreateData(input: {
  employeeId: string;
  month: string;
  weightsVersionId: string;
  reviewerId: string | null;
  figures: MonthFigures;
  now: Date;
  autoRelease: boolean;
}): Prisma.ScorecardUncheckedCreateInput {
  const f = input.figures;
  return {
    employeeId: input.employeeId,
    month: input.month,
    kind: f.kind,
    weightsVersionId: input.weightsVersionId,
    metrics: f.metrics as Prisma.InputJsonValue,
    salesDetail: f.salesDetail ? (f.salesDetail as unknown as Prisma.InputJsonValue) : Prisma.JsonNull,
    unmeasured: f.unmeasured as unknown as Prisma.InputJsonValue,
    score: f.score,
    band: f.band,
    taskCount: f.taskCount,
    smallSample: f.smallSample,
    status: input.autoRelease ? 'released' : 'draft',
    reviewerId: input.reviewerId,
    releasedAt: input.autoRelease ? input.now : null,
    releasedById: null,
    createdAt: input.now,
    tasks: {
      create: f.tasks.map((t, position) => ({
        taskId: t.taskId,
        position,
        number: t.number,
        title: t.title,
        size: t.size,
        points: t.points,
        rating: t.rating,
        onTime: t.onTime,
        reworked: t.reworked,
        extensions: t.extensions,
        status: t.status,
        counted: t.counted,
        deadline: t.deadline,
      })),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------- disputes

export const DISPUTE_INCLUDE = {
  employee: { select: { empId: true } },
  decider: { select: { empId: true } },
  decidedBy: { select: { empId: true } },
  scorecard: { select: { month: true } },
  scorecardTask: { select: { number: true, title: true } },
} satisfies Prisma.RatingDisputeInclude;
export type DisputeRow = Prisma.RatingDisputeGetPayload<{ include: typeof DISPUTE_INCLUDE }>;

export function toDisputeView(d: DisputeRow): RatingDisputeView {
  return {
    id: d.id,
    scorecardId: d.scorecardId,
    empId: d.employee.empId,
    taskNumber: d.scorecardTask.number,
    taskTitle: d.scorecardTask.title,
    currentRating: d.ratingAtRaise,
    reason: d.reason,
    status: d.status,
    deciderEmpId: d.decider.empId,
    decidedBy: d.decidedBy?.empId,
    decision: d.decision ?? undefined,
    newRating: d.newRating ?? undefined,
    at: iso(d.createdAt),
    decidedAt: d.decidedAt ? iso(d.decidedAt) : undefined,
    scoreBefore: d.scoreBefore === null ? undefined : num(d.scoreBefore),
    scoreAfter: d.scoreAfter === null ? undefined : num(d.scoreAfter),
    month: d.scorecard.month,
  };
}

// ---------------------------------------------------------------------------------------------------------- event payloads

type Payload<T extends OutboxEvent['type']> = Extract<OutboxEvent, { type: T }>['payload'];

const refOf = (row: ScorecardRow) => ({ scorecardId: row.id, empId: row.employee.empId, month: row.month, kind: row.kind });

export function draftedPayload(row: ScorecardRow, reviewerEmpId: string | null): Payload<'scorecard.drafted'> {
  return { ...refOf(row), reviewer: reviewerEmpId, score: row.score === null ? null : num(row.score), taskCount: row.taskCount, smallSample: row.smallSample };
}

/** `releasedBy` null = the system released it (no reviewer). */
export function releasedPayload(row: ScorecardRow, releasedByEmpId: string | null, hasRemark: boolean): Payload<'scorecard.released'> {
  return { ...refOf(row), releasedBy: releasedByEmpId, automatic: releasedByEmpId === null, hasRemark };
}

export function acknowledgedPayload(row: ScorecardRow, reviewerEmpId: string | null, hasComment: boolean): Payload<'scorecard.acknowledged'> {
  return { ...refOf(row), reviewer: reviewerEmpId, hasComment };
}

export function disputeRaisedPayload(d: DisputeRow): Payload<'scorecard.dispute_raised'> {
  return { disputeId: d.id, scorecardId: d.scorecardId, empId: d.employee.empId, month: d.scorecard.month, taskId: d.taskId, taskNumber: d.scorecardTask.number, ratingAtRaise: d.ratingAtRaise, decider: d.decider.empId };
}

export function disputeDecidedPayload(d: DisputeRow): Payload<'scorecard.dispute_decided'> {
  return {
    disputeId: d.id,
    scorecardId: d.scorecardId,
    empId: d.employee.empId,
    month: d.scorecard.month,
    taskNumber: d.scorecardTask.number,
    decision: d.status === 'changed' ? 'changed' : 'upheld',
    decidedBy: (d.decidedBy as { empId: string }).empId,
    ratingBefore: d.ratingAtRaise,
    ratingAfter: d.newRating,
    scoreBefore: d.scoreBefore === null ? null : num(d.scoreBefore),
    scoreAfter: d.scoreAfter === null ? null : num(d.scoreAfter),
  };
}

export function weightsCreatedPayload(row: WeightsRow, previousVersionId: string | null): Payload<'score_weights.created'> {
  return { versionId: row.id, kind: row.kind, departmentId: row.departmentId, versionNo: row.versionNo, weights: weightsOf(row), previousVersionId };
}
