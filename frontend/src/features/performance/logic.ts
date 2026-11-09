/**
 * Pure performance rules (plan §10, §20). Mirrored on the server; unit-test these.
 *   Score       = 0.35 Q + 0.25 T + 0.20 C + 0.10 (100 − R) + 0.10 A
 *   Sales score = 0.20 V + 0.25 M + 0.30 W + 0.10 D + 0.15 A
 */
import { permissionsFor } from "@/lib/auth/permissions";
import type { Employee } from "@/types";
import type { Band, MetricSet, SalesDetail, SalesMetricSet, ScorecardKind, ScorecardTask } from "./types";

/** true when this person reviews work (the Director and the CTO; never the CEO / Founder / Owner, who only views). */
export function canReviewWork(e: Employee | undefined | null) {
  return !!e && e.status !== "left" && permissionsFor(e.role, e.duties).has("task.review");
}

/**
 * Who reviews and releases a person's monthly scorecard (plan §10): their manager, one level further up if the
 * manager has left. CTO → Development; Director → the CTO, Sales and Finance. The Director's manager is the
 * CEO / Founder / Owner, who reviews nothing, so the Director has no reviewer (null): their scorecard is released
 * automatically and the CEO / Founder / Owner views it.
 */
export function scorecardReviewer(empId: string, employees: Employee[]): Employee | null {
  const find = (id?: string | null) => (id ? employees.find((e) => e.empId === id) : undefined);
  let manager = find(find(empId)?.reportsTo);
  while (manager && manager.status === "left") manager = find(manager.reportsTo);
  return manager && manager.empId !== empId && canReviewWork(manager) ? manager : null;
}

export const SMALL_SAMPLE = 5;

export interface MetricDef {
  key: string;
  letter: string;
  label: string;
  how: string;
  lowerIsBetter?: boolean;
}

export const STANDARD_METRICS: MetricDef[] = [
  { key: "quality", letter: "Q", label: "Quality", how: "Average reviewer rating, weighted by task points. 5 stars = 100." },
  { key: "onTime", letter: "T", label: "On time", how: "Tasks submitted by their approved deadline ÷ tasks submitted." },
  { key: "completion", letter: "C", label: "Completion", how: "Points of approved tasks ÷ points of tasks due in the month." },
  { key: "rework", letter: "R", label: "Rework", how: "Tasks sent back ÷ tasks submitted. Lower is better; the score uses 100 − R.", lowerIsBetter: true },
  { key: "attendance", letter: "A", label: "Attendance", how: "Days present on time ÷ working days (from Attendance)." },
];

export const SALES_METRICS: MetricDef[] = [
  { key: "activity", letter: "V", label: "Activity", how: "Working days on which the daily targets were met ÷ working days." },
  { key: "meetings", letter: "M", label: "Meetings", how: "Meetings booked ÷ the monthly meeting target (capped at 100)." },
  { key: "won", letter: "W", label: "Deals won", how: "Value of deals won ÷ the monthly sales target (capped at 100)." },
  { key: "dataQuality", letter: "D", label: "Data quality", how: "100 when bounce rate ≤ 3% and no duplicate leads; 10 points off per 1% above 3% and per duplicate." },
  { key: "attendance", letter: "A", label: "Attendance", how: "Days present on time ÷ working days (same as everyone)." },
];

export const metricDefs = (kind: ScorecardKind) => (kind === "sales" ? SALES_METRICS : STANDARD_METRICS);

const clamp100 = (n: number) => Math.max(0, Math.min(100, n));
const round1 = (n: number) => Math.round(n * 10) / 10;

/** Contribution of each metric to the overall score with the given weights. */
export function contributions(kind: ScorecardKind, metrics: MetricSet | SalesMetricSet, weights: Record<string, number>) {
  return metricDefs(kind).map((d) => {
    const raw = (metrics as unknown as Record<string, number>)[d.key] ?? 0;
    const used = d.lowerIsBetter ? 100 - raw : clamp100(raw);
    const w = weights[d.key] ?? 0;
    return { def: d, raw, used, weight: w, points: round1(used * w) };
  });
}

export function computeScore(kind: ScorecardKind, metrics: MetricSet | SalesMetricSet, weights: Record<string, number>) {
  return round1(contributions(kind, metrics, weights).reduce((s, c) => s + c.used * c.weight, 0));
}

export function bandOf(score: number): Band {
  if (score >= 85) return "excellent";
  if (score >= 70) return "good";
  if (score >= 50) return "needs_improvement";
  return "poor";
}

export const BAND_LABEL: Record<Band, string> = {
  excellent: "Excellent",
  good: "Good",
  needs_improvement: "Needs improvement",
  poor: "Poor",
};

export const BAND_TONE: Record<Band, "success" | "primary" | "warning" | "danger"> = {
  excellent: "success",
  good: "primary",
  needs_improvement: "warning",
  poor: "danger",
};

/**
 * Task metrics from a month's tasks (plan §10 fairness: cancelled tasks don't count;
 * an extension approved before the deadline is not late).
 * Returns null for a metric when there's nothing to measure yet.
 */
export function taskMetrics(tasks: ScorecardTask[]) {
  const counted = tasks.filter((t) => t.status !== "cancelled");
  const approved = counted.filter((t) => t.status === "approved");
  const rated = approved.filter((t) => t.rating);
  const ratedPoints = rated.reduce((s, t) => s + Math.max(1, t.points), 0);
  const quality = ratedPoints ? (rated.reduce((s, t) => s + (t.rating ?? 0) * Math.max(1, t.points), 0) / ratedPoints) * 20 : null;
  const submitted = counted.filter((t) => t.status === "approved" || t.status === "submitted" || t.reworked);
  const onTime = submitted.length ? (submitted.filter((t) => t.onTime).length / submitted.length) * 100 : null;
  const duePoints = counted.reduce((s, t) => s + t.points, 0);
  const completion = duePoints ? (approved.reduce((s, t) => s + t.points, 0) / duePoints) * 100 : null;
  const rework = submitted.length ? (submitted.filter((t) => t.reworked).length / submitted.length) * 100 : null;
  return {
    quality: quality === null ? null : round1(quality),
    onTime: onTime === null ? null : round1(onTime),
    completion: completion === null ? null : round1(completion),
    rework: rework === null ? null : round1(rework),
    taskCount: counted.length,
  };
}

export function salesMetrics(d: SalesDetail, attendance: number): SalesMetricSet {
  const dq = 100 - Math.max(0, d.bounceRate - 3) * 10 - d.duplicates * 10;
  return {
    activity: round1(d.workingDays ? (d.targetDaysMet / d.workingDays) * 100 : 0),
    meetings: round1(clamp100(d.meetingTarget ? (d.meetings / d.meetingTarget) * 100 : 0)),
    won: round1(clamp100(d.wonTargetUsd ? (d.wonValueUsd / d.wonTargetUsd) * 100 : 0)),
    dataQuality: round1(clamp100(dq)),
    attendance: round1(attendance),
  };
}

export function isSalesMetrics(m: MetricSet | SalesMetricSet): m is SalesMetricSet {
  return "activity" in m;
}
