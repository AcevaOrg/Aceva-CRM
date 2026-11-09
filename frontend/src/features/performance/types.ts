/**
 * Module 6 · Performance and results (plan §10; sales scorecard from §20)
 * Owner: Developer C (cycle 2). Spec §9.6.
 * API contract for the module.
 */
import type { TaskSize } from "@/features/tasks/types";

export type ScorecardKind = "standard" | "sales";
export type Band = "excellent" | "good" | "needs_improvement" | "poor";

/** Each metric is 0–100. Rework is "lower is better"; workload is information only. */
export interface MetricSet {
  quality: number;
  onTime: number;
  completion: number;
  rework: number;
  attendance: number;
  workloadHours: number;
}

/** Sales metrics (plan §20), each 0–100 and capped at 100. */
export interface SalesMetricSet {
  activity: number;
  meetings: number;
  won: number;
  dataQuality: number;
  attendance: number;
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
  rating?: number;
  /** Submitted by the approved deadline. */
  onTime: boolean;
  /** Sent back at least once before approval. */
  reworked: boolean;
  extensions: number;
  /** "submitted" = waiting for review (counts as submitted, not yet completed). */
  status: "approved" | "submitted" | "open" | "cancelled";
  deadline: string;
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
  weightsVersionId: string;
  score: number;
  band: Band;
  taskCount: number;
  smallSample: boolean;
  status: ScorecardStatus;
  reviewerEmpId: string;
  reviewerRemark?: string;
  remarkAt?: string;
  releasedAt?: string;
  acknowledgedAt?: string;
  employeeComment?: string;
  tasks: ScorecardTask[];
  createdAt: string;
}

export interface WeightsVersion {
  id: string;
  label: string;
  kind: ScorecardKind;
  departmentId?: string;
  weights: Record<string, number>;
  effectiveFrom: string;
}

export interface RatingDispute {
  id: string;
  scorecardId: string;
  empId: string;
  taskNumber: string;
  taskTitle: string;
  currentRating: number;
  reason: string;
  status: "open" | "upheld" | "changed";
  /** Next level above the reviewer decides (plan §10). */
  deciderEmpId: string;
  decidedBy?: string;
  decision?: string;
  newRating?: number;
  at: string;
  decidedAt?: string;
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
  weights: WeightsVersion;
  score: number;
  band: Band;
  taskCount: number;
  smallSample: boolean;
  /** Last 6 closed months + this month (live). */
  trend: TrendPoint[];
  tasks: ScorecardTask[];
}

export interface TeamPerformanceRow {
  empId: string;
  kind: ScorecardKind;
  latest: Scorecard | null;
  live: { score: number; band: Band; smallSample: boolean };
  trend: TrendPoint[];
}

export interface ScorecardDetail {
  scorecard: Scorecard;
  weights: WeightsVersion;
  disputes: RatingDispute[];
}
