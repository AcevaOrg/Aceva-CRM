/**
 * Module 6 · Performance and results (plan §10; sales scorecard from §20)
 * Built by: Developer C (cycle 2). Spec §9.6.
 * API contract for the module.
 *
 * Live (NEXT_PUBLIC_LIVE_MODULES contains m6) the server answers these shapes (packages/contracts/src/performance.ts);
 * live.ts maps them, so the screens never see the server's own types. Three things differ from the first mock:
 *  - a metric nobody can measure is null (attendance until Module 7, sales figures until Module 15, or no counted task
 *    gives it a value) and is named in `unmeasured`; the score and the band are null when nothing can be measured;
 *  - the weights here are FRACTIONS (0.35) for the score maths; the server and the Settings screen use whole percents (35);
 *  - a few optional fields (counted, originalRating, releasedBy, recomputeCount, comments, scoreBefore/scoreAfter).
 */
import type { TaskSize } from "@/features/tasks/types";

export type ScorecardKind = "standard" | "sales";
export type Band = "excellent" | "good" | "needs_improvement" | "poor";

/**
 * Each metric is 0–100, or null when it can't be measured (never a made-up number). Rework is "lower is better";
 * workload is information only.
 */
export interface MetricSet {
  quality: number | null;
  onTime: number | null;
  completion: number | null;
  rework: number | null;
  attendance: number | null;
  workloadHours: number;
}

/** Sales metrics (plan §20), each 0–100 and capped at 100, or null when the sales figures don't exist yet. */
export interface SalesMetricSet {
  activity: number | null;
  meetings: number | null;
  won: number | null;
  dataQuality: number | null;
  attendance: number | null;
}

/** Why a metric has no value. */
export type UnmeasuredReason = "attendance_not_available" | "sales_not_available" | "nothing_to_measure";

/** A metric with no value and why (live only; the first mock never has one). */
export interface UnmeasuredMetric {
  key: string;
  reason: UnmeasuredReason;
}

/** The raw sales numbers behind a sales scorecard. */
export interface SalesDetail {
  targetDaysMet: number;
  workingDays: number;
  meetings: number;
  meetingTarget: number;
  wonValueUsd: number;
  wonTargetUsd: number;
  bounceRate: number;
  duplicates: number;
}

export interface ScorecardTask {
  taskId?: string;
  number: string;
  title: string;
  size: TaskSize;
  points: number;
  /** The rating now (after a dispute that changed it). */
  rating?: number;
  /** Live only: the rating before a dispute changed it. */
  originalRating?: number;
  /** Submitted by the approved deadline. */
  onTime: boolean;
  /** Sent back at least once before approval. */
  reworked: boolean;
  extensions: number;
  /** "submitted" = waiting for review (counts as submitted, not yet completed). */
  status: "approved" | "submitted" | "open" | "cancelled";
  deadline: string;
  /** Live only: this task took part in the metrics (cancelled ones, and open ones not yet due, did not). */
  counted?: boolean;
}

export type ScorecardStatus = "draft" | "released" | "acknowledged";

export interface Scorecard {
  id: string;
  empId: string;
  /** "2026-10" */
  month: string;
  kind: ScorecardKind;
  metrics: MetricSet | SalesMetricSet;
  salesDetail?: SalesDetail;
  /** Live only: the metrics with no value and why. */
  unmeasured?: UnmeasuredMetric[];
  weightsVersionId: string;
  /** Null when nothing could be measured (no score is shown, never a made-up one). */
  score: number | null;
  band: Band | null;
  taskCount: number;
  smallSample: boolean;
  status: ScorecardStatus;
  /**
   * The reviewer, who releases it: the person's manager (the CTO for Development, the Director for the CTO, Sales and
   * Finance), or the next level up who reviews work when the manager has left or does not review work. Empty for the
   * Director: the CEO / Founder / Owner reviews nothing, so the Director's scorecard is
   * released automatically when it is created and the CEO / Founder / Owner views it.
   */
  reviewerEmpId?: string;
  reviewerRemark?: string;
  remarkAt?: string;
  releasedAt?: string;
  /** Live only: who released it; empty when the system did. */
  releasedBy?: string;
  acknowledgedAt?: string;
  employeeComment?: string;
  /** Live only: how many times the numbers were recomputed after a dispute that changed a rating. */
  recomputeCount?: number;
  tasks: ScorecardTask[];
  createdAt: string;
}

/** A set of score weights. `weights` are FRACTIONS that add up to 1 (0.35); the Settings screen has its own whole-percent type. */
export interface WeightsVersion {
  id: string;
  label: string;
  kind: ScorecardKind;
  departmentId?: string;
  /** Live only. */
  departmentName?: string;
  weights: Record<string, number>;
  effectiveFrom: string;
  /** Live only. */
  versionNo?: number;
  /** Live only: Emp-ID of the Director who saved it; null = the starting version that came with the system. */
  createdBy?: string | null;
  note?: string;
}

export interface RatingDispute {
  id: string;
  scorecardId: string;
  empId: string;
  taskNumber: string;
  taskTitle: string;
  /** The rating when the dispute was raised. */
  currentRating: number;
  reason: string;
  status: "open" | "upheld" | "changed";
  /**
   * The level above the reviewer decides (plan §10): CTO reviewed → the Director decides. The CEO / Founder / Owner
   * decides nothing, so a rating the Director gave is looked at again by the Director (the CEO / Founder / Owner can view it).
   */
  deciderEmpId: string;
  decidedBy?: string;
  decision?: string;
  newRating?: number;
  at: string;
  decidedAt?: string;
  /** Live only: the scorecard's score before and after the recompute (a changed rating). */
  scoreBefore?: number;
  scoreAfter?: number;
  /** Live only: the month of the scorecard. */
  month?: string;
}

/** One remark or comment in the history of a scorecard (live only). */
export interface ScorecardComment {
  id: string;
  kind: "reviewer_remark" | "employee_comment";
  /** Emp-ID. */
  author: string;
  body: string;
  at: string;
}

export interface TrendPoint {
  month: string;
  score: number;
}

export interface LivePerformance {
  empId: string;
  month: string;
  kind: ScorecardKind;
  metrics: MetricSet | SalesMetricSet;
  salesDetail?: SalesDetail;
  /** Live only: the metrics with no value and why. */
  unmeasured?: UnmeasuredMetric[];
  weights: WeightsVersion;
  /** Null when nothing could be measured. */
  score: number | null;
  band: Band | null;
  taskCount: number;
  smallSample: boolean;
  /** Last 6 closed months that have a score + this month (live) when it has one. */
  trend: TrendPoint[];
  tasks: ScorecardTask[];
}

export interface TeamPerformanceRow {
  empId: string;
  kind: ScorecardKind;
  latest: Scorecard | null;
  live: { score: number | null; band: Band | null; smallSample: boolean };
  trend: TrendPoint[];
}

export interface ScorecardDetail {
  scorecard: Scorecard;
  weights: WeightsVersion;
  disputes: RatingDispute[];
  /** Live only: every remark and comment, oldest first. */
  comments?: ScorecardComment[];
}
