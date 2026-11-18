import { z } from 'zod';
import { empIdSchema, SCORECARD_KINDS, scorecardMonthSchema, TASK_SIZES } from './events';

// ---------------------------------------------------------------------------
// Module 6: performance and results (plan section 10, spec section 9.6)
// The response shapes are frontend/src/features/performance/types.ts, with the changes marked "new" (see docs/M6-ACCEPTANCE.md):
//  * a metric that could not be measured is null (never a made-up number) and is named in `unmeasured`;
//  * the score and the band are null when nothing could be measured;
//  * score weights are WHOLE PERCENTS that add up to exactly 100 (35, 25 ...), not fractions (0.35 ...): the performance
//    screens divide by 100 in their live branch.
// ---------------------------------------------------------------------------

export const scorecardKindSchema = z.enum(SCORECARD_KINDS);
export type ScorecardKindName = z.infer<typeof scorecardKindSchema>;

export const STANDARD_METRIC_KEYS = ['quality', 'onTime', 'completion', 'rework', 'attendance'] as const;
export const SALES_METRIC_KEYS = ['activity', 'meetings', 'won', 'dataQuality', 'attendance'] as const;

export const SCORECARD_BANDS = ['excellent', 'good', 'needs_improvement', 'poor'] as const;
export type BandName = (typeof SCORECARD_BANDS)[number];

export const SCORECARD_STATUSES = ['draft', 'released', 'acknowledged'] as const;
export type ScorecardStatusName = (typeof SCORECARD_STATUSES)[number];

export const SCORECARD_TASK_STATUSES = ['approved', 'submitted', 'open', 'cancelled'] as const;
export type ScorecardTaskStatusName = (typeof SCORECARD_TASK_STATUSES)[number];

export const DISPUTE_STATUSES = ['open', 'upheld', 'changed'] as const;
export type DisputeStatusName = (typeof DISPUTE_STATUSES)[number];

/** Why a metric has no value: Module 7 / Module 15 do not exist yet, or no counted task gives it one this month. */
export const UNMEASURED_REASONS = ['attendance_not_available', 'sales_not_available', 'nothing_to_measure'] as const;
export type UnmeasuredReasonName = (typeof UNMEASURED_REASONS)[number];

/** Query strings arrive as text; an empty filter means no filter. */
const optionalFilter = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());
const yesNo = z.enum(['1', '0', 'true', 'false']).transform((v) => v === '1' || v === 'true');

// ---------- requests ----------

/** GET /performance/live?empId= (default: the caller). */
export const liveQuerySchema = z.object({ empId: optionalFilter(empIdSchema) });
export type LiveQuery = z.infer<typeof liveQuerySchema>;

/**
 * GET /scorecards?empId=&latest=1&month=&limit=  The person (default: the caller), newest month first. `latest=1` answers
 * a list with at most one scorecard (the newest the caller may see). The employee never gets a draft; people above do.
 */
export const scorecardListQuerySchema = z.object({
  empId: optionalFilter(empIdSchema),
  latest: optionalFilter(yesNo),
  month: optionalFilter(scorecardMonthSchema),
  limit: optionalFilter(z.coerce.number().int().min(1).max(60)),
});
export type ScorecardListQuery = z.infer<typeof scorecardListQuerySchema>;

/** POST /scorecards/:id/remark: the reviewer adds a remark (several can be added; the newest is shown). */
export const scorecardRemarkRequestSchema = z.object({ remark: z.string().trim().min(3, 'Write a remark (at least 3 characters)').max(1000) }).strict();
export type ScorecardRemarkRequest = z.infer<typeof scorecardRemarkRequestSchema>;

/** POST /scorecards/:id/release: an optional remark goes with the release. */
export const releaseScorecardRequestSchema = z.object({ remark: z.string().trim().min(3).max(1000).optional() }).strict().default({});
export type ReleaseScorecardRequest = z.infer<typeof releaseScorecardRequestSchema>;

/** POST /scorecards/:id/acknowledge: an optional comment. */
export const acknowledgeScorecardRequestSchema = z.object({ comment: z.string().trim().min(1).max(1000).optional() }).strict().default({});
export type AcknowledgeScorecardRequest = z.infer<typeof acknowledgeScorecardRequestSchema>;

/** POST /disputes: the employee disputes the rating of one task (by its number) on their own released scorecard. */
export const raiseDisputeRequestSchema = z
  .object({
    scorecardId: z.uuid(),
    taskNumber: z.string().trim().regex(/^TSK-\d{4,}$/, 'A task number looks like TSK-0142'),
    reason: z.string().trim().min(10, 'Tell us why you disagree (at least 10 characters)').max(1000),
  })
  .strict();
export type RaiseDisputeRequest = z.infer<typeof raiseDisputeRequestSchema>;

/**
 * POST /disputes/:id/decide. `change: false` keeps the rating (upheld). `change: true` needs `newRating` (1 to 5, not the
 * same as now); the scorecard is then recomputed with the weights version it was made with. A decision text is required.
 */
export const decideDisputeRequestSchema = z
  .object({
    change: z.boolean(),
    decision: z.string().trim().min(3, 'Give a reason for your decision').max(1000),
    newRating: z.number().int().min(1).max(5).optional(),
  })
  .strict();
export type DecideDisputeRequest = z.infer<typeof decideDisputeRequestSchema>;

/** GET /disputes?status= (default: all). The rows the caller may see: their own, ones they decide, ones of people below them. */
export const disputeListQuerySchema = z.object({ status: optionalFilter(z.enum(['open', 'upheld', 'changed'])) });
export type DisputeListQuery = z.infer<typeof disputeListQuerySchema>;

/** GET /settings/score-weights?kind=&departmentId= (default: every version, newest first). */
export const scoreWeightsQuerySchema = z.object({ kind: optionalFilter(scorecardKindSchema), departmentId: optionalFilter(z.uuid()) });
export type ScoreWeightsQuery = z.infer<typeof scoreWeightsQuerySchema>;

/**
 * POST /settings/score-weights: the Director (performance.weights) saves a NEW version (versions are never edited; old
 * scorecards keep theirs). `weights` are whole percents by metric key, exactly the metrics of the kind, adding up to
 * exactly 100 (the server answers 400 weights_sum / weights_keys / weights_whole / weights_range). `departmentId` makes it
 * that department's own set (optional; without it the company-wide set). `reason` is logged.
 */
export const saveScoreWeightsRequestSchema = z
  .object({
    kind: scorecardKindSchema,
    departmentId: z.uuid().optional(),
    weights: z.record(z.string(), z.number()),
    reason: z.string().trim().min(3, 'A reason is required').max(500),
  })
  .strict();
export type SaveScoreWeightsRequest = z.infer<typeof saveScoreWeightsRequestSchema>;

// ---------- responses ----------

/** A set of score weights (frontend system WeightsVersion and performance WeightsVersion, merged). */
export interface ScoreWeightsVersionView {
  id: string;
  /** "Standard v2" / "Sales v1". */
  label: string;
  kind: ScorecardKindName;
  /** The department this set is for; absent = the company-wide set. */
  departmentId?: string;
  departmentName?: string;
  /** WHOLE PERCENTS by metric key, adding up to exactly 100. */
  weights: Record<string, number>;
  versionNo: number;
  effectiveFrom: string;
  /** Emp-ID of the Director who saved it; null = the starting version that came with the system. */
  createdBy: string | null;
  /** The Director's reason for saving it (the audit reason). */
  note?: string;
}

/**
 * The weights as the performance screens (GET /performance/live, GET /scorecards/:id) get them, which every employee may call:
 * the set itself (what the score used) and its label, WITHOUT `createdBy` and `note`. Who saved a set and the Director's private
 * reason for it belong to Settings (settings.view: GET /settings/score-weights), which the other employees may not read.
 */
export type PerformanceWeightsView = Omit<ScoreWeightsVersionView, 'createdBy' | 'note'>;

/** Standard metrics: each 0 to 100 or null (not measured). Rework: lower is better. workloadHours is information only. */
export interface StandardMetricsView {
  quality: number | null;
  onTime: number | null;
  completion: number | null;
  rework: number | null;
  attendance: number | null;
  workloadHours: number;
}

/** Sales metrics (plan section 20), each 0 to 100 or null. */
export interface SalesMetricsView {
  activity: number | null;
  meetings: number | null;
  won: number | null;
  dataQuality: number | null;
  attendance: number | null;
}

export interface SalesDetailView {
  targetDaysMet: number;
  workingDays: number;
  meetings: number;
  meetingTarget: number;
  wonValueUsd: number;
  wonTargetUsd: number;
  bounceRate: number;
  duplicates: number;
}

/** A metric with no value, and why. The screen shows "Not available yet" and the reason. */
export interface UnmeasuredView {
  key: string;
  reason: UnmeasuredReasonName;
}

export interface ScorecardTaskView {
  /** New: the task id (for the link to the task). */
  taskId?: string;
  number: string;
  title: string;
  size: (typeof TASK_SIZES)[number];
  points: number;
  /** The rating now (after a dispute that changed it). */
  rating?: number;
  /** New: the rating before a dispute changed it. */
  originalRating?: number;
  /** Submitted by the approved deadline. */
  onTime: boolean;
  /** Sent back at least once. */
  reworked: boolean;
  extensions: number;
  status: ScorecardTaskStatusName;
  deadline: string;
  /** New: this task took part in the metrics (cancelled ones, and open ones not yet due, did not). */
  counted: boolean;
}

export interface ScorecardView {
  id: string;
  empId: string;
  month: string;
  kind: ScorecardKindName;
  metrics: StandardMetricsView | SalesMetricsView;
  salesDetail?: SalesDetailView;
  /** New: the metrics that have no value and why (attendance until Module 7, sales until Module 15, no counted tasks). */
  unmeasured: UnmeasuredView[];
  weightsVersionId: string;
  /** Null when nothing could be measured. */
  score: number | null;
  band: BandName | null;
  taskCount: number;
  smallSample: boolean;
  status: ScorecardStatusName;
  /** Emp-ID of the person who reviews and releases it; absent for the Director (released by the system). */
  reviewerEmpId?: string;
  /** The newest remark of the reviewer. */
  reviewerRemark?: string;
  remarkAt?: string;
  releasedAt?: string;
  /** New: Emp-ID of who released it; absent when the system did. */
  releasedBy?: string;
  acknowledgedAt?: string;
  /** The employee's comment on acknowledging. */
  employeeComment?: string;
  /** New: how many times the numbers were recomputed after a dispute that changed a rating. */
  recomputeCount: number;
  tasks: ScorecardTaskView[];
  createdAt: string;
}

export interface RatingDisputeView {
  id: string;
  scorecardId: string;
  empId: string;
  taskNumber: string;
  taskTitle: string;
  /** The rating when the dispute was raised. */
  currentRating: number;
  reason: string;
  status: DisputeStatusName;
  /** Emp-ID of the person who must decide. */
  deciderEmpId: string;
  /** Emp-ID of who decided. */
  decidedBy?: string;
  decision?: string;
  newRating?: number;
  at: string;
  decidedAt?: string;
  /** New: the scorecard's score before and after the recompute (when the rating was changed). */
  scoreBefore?: number;
  scoreAfter?: number;
  /** New: the month of the scorecard (for the lists). */
  month: string;
}

export interface TrendPointView {
  month: string;
  score: number;
}

/** GET /performance/live: this month so far, with the last 6 closed months and this month as the trend. */
export interface LivePerformanceView {
  empId: string;
  month: string;
  kind: ScorecardKindName;
  metrics: StandardMetricsView | SalesMetricsView;
  salesDetail?: SalesDetailView;
  unmeasured: UnmeasuredView[];
  weights: PerformanceWeightsView;
  score: number | null;
  band: BandName | null;
  taskCount: number;
  smallSample: boolean;
  trend: TrendPointView[];
  tasks: ScorecardTaskView[];
}

/** GET /performance/team: one row per person below the caller, sorted by name. NEVER sorted by score: there is no ranking. */
export interface TeamPerformanceRowView {
  empId: string;
  kind: ScorecardKindName;
  latest: ScorecardView | null;
  live: { score: number | null; band: BandName | null; smallSample: boolean };
  trend: TrendPointView[];
}

/** One remark or comment in the history of a scorecard. */
export interface ScorecardCommentView {
  id: string;
  kind: 'reviewer_remark' | 'employee_comment';
  /** Emp-ID. */
  author: string;
  body: string;
  at: string;
}

/** GET /scorecards/:id */
export interface ScorecardDetailView {
  scorecard: ScorecardView;
  /** The weights version the scorecard was made with. */
  weights: PerformanceWeightsView;
  disputes: RatingDisputeView[];
  /** New: every remark and comment, oldest first. */
  comments: ScorecardCommentView[];
}
