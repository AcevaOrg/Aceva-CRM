/**
 * Pure performance rules (plan §10, §20). Mirrored on the server (backend/src/performance/rules/perf-score.ts, whose
 * unit test copies this file's outputs): unit-test these.
 *   Score       = 0.35 Q + 0.25 T + 0.20 C + 0.10 (100 − R) + 0.10 A
 *   Sales score = 0.20 V + 0.25 M + 0.30 W + 0.10 D + 0.15 A
 *
 * A metric nobody can measure is null and is LEFT OUT: the weights of the measured metrics are scaled up to share the
 * whole (score = sum of points ÷ sum of the measured weights), so nobody gains or loses points for a missing figure.
 * With every metric measured it is exactly the formula above. Nothing measurable at all gives no score (null).
 */
import { permissionsFor } from "@/lib/auth/permissions";
import type { Employee } from "@/types";
import type { Band, MetricSet, SalesDetail, SalesMetricSet, ScorecardKind, ScorecardTask, UnmeasuredMetric, UnmeasuredReason } from "./types";

/** true when this person reviews work (the Director and the CTO; never the CEO / Founder / Owner, who only views). */
export function canReviewWork(e: Employee | undefined | null) {
  return !!e && e.status !== "left" && permissionsFor(e.role, e.duties).has("task.review");
}

/**
 * Who reviews and releases a person's monthly scorecard (plan §10): the nearest person above who is still with the company
 * and reviews work (holds task.review): the manager, or further up when the manager has left or does not review work. This
 * is the same walk-up the server uses (backend/src/performance/rules/perf-people.ts). CTO → Development; Director → the CTO,
 * Sales and Finance. The Director's manager is the CEO / Founder / Owner, who reviews nothing, so the Director has no
 * reviewer (null): the scorecard is released automatically and the CEO / Founder / Owner views it. Anyone whose whole line
 * above reviews no work gets null the same way.
 */
export function scorecardReviewer(empId: string, employees: Employee[]): Employee | null {
  const find = (id?: string | null) => (id ? employees.find((e) => e.empId === id) : undefined);
  // The managers above the person, nearest first; stops at a loop or a missing manager.
  const chain: Employee[] = [];
  const seen = new Set([empId]);
  let cur = find(empId);
  while (cur?.reportsTo && !seen.has(cur.reportsTo)) {
    const boss = find(cur.reportsTo);
    if (!boss) break;
    chain.push(boss);
    seen.add(boss.empId);
    cur = boss;
  }
  return chain.find((m) => m.status !== "left" && canReviewWork(m)) ?? null;
}

export const SMALL_SAMPLE = 5;

/** A reviewer remark is at least this many characters (the same minimum as the server's contract). */
export const REMARK_MIN_LENGTH = 3;

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
/** The server's score rounding (backend perf-score.ts roundScore): one decimal, half up on an exact tie. */
const roundScore = (n: number) => Math.round(n * 10 + 1e-9) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** A metric's value, or null when it has none (null, missing or not a number). */
function metricValue(metrics: MetricSet | SalesMetricSet, key: string): number | null {
  const v = (metrics as unknown as Record<string, number | null | undefined>)[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The share of the score one metric carries. `raw`, `used` and `points` are null when the metric is not measured. */
export interface Contribution {
  def: MetricDef;
  raw: number | null;
  /** What the score uses: 100 − R for rework, the value (kept within 0–100) for the others. */
  used: number | null;
  /** The weight the score really uses, as a fraction: the version's weight, scaled up when some metrics are not measured. */
  weight: number;
  /** The weight the version gives it (the one the Director set). */
  baseWeight: number;
  /** used x weight, to two decimals (the score adds the unrounded values and rounds once, to one decimal). */
  points: number | null;
  measured: boolean;
}

/** Contribution of each metric to the overall score with the given weights (fractions). Unmeasured metrics are left out. */
export function contributions(kind: ScorecardKind, metrics: MetricSet | SalesMetricSet, weights: Record<string, number>): Contribution[] {
  const defs = metricDefs(kind);
  const measured = defs.filter((d) => metricValue(metrics, d.key) !== null);
  const measuredTotal = measured.reduce((s, d) => s + (weights[d.key] ?? 0), 0);
  const all = measured.length === defs.length;
  return defs.map((def) => {
    const baseWeight = weights[def.key] ?? 0;
    const raw = metricValue(metrics, def.key);
    if (raw === null) return { def, raw: null, used: null, weight: 0, baseWeight, points: null, measured: false };
    const used = def.lowerIsBetter ? 100 - raw : clamp100(raw);
    // A full set uses the version's weights as they are; a partial set shares the whole among the measured metrics.
    const weight = all ? baseWeight : measuredTotal > 0 ? baseWeight / measuredTotal : 0;
    return { def, raw, used, weight, baseWeight, points: round2(used * weight), measured: true };
  });
}

/**
 * The overall score (one decimal), or null when no metric could be measured (or the measured ones carry no weight).
 * Worked out exactly as the server does (perf-score.ts computeScore): one sum of metric x whole-percent weight, divided once
 * (by 100, or by the weights of the measured metrics when some are left out), then rounded half up once. contributions()
 * is for display only.
 */
export function computeScore(kind: ScorecardKind, metrics: MetricSet | SalesMetricSet, weights: Record<string, number>): number | null {
  const rows = contributions(kind, metrics, weights);
  const measured = rows.filter((r) => r.measured);
  if (measured.length === 0) return null;
  const pct = (key: string) => Math.round((weights[key] ?? 0) * 100);
  const all = measured.length === rows.length;
  const total = measured.reduce((s, r) => s + pct(r.def.key), 0);
  if (!all && total <= 0) return null;
  return roundScore(measured.reduce((s, r) => s + (r.used as number) * pct(r.def.key), 0) / (all ? 100 : total));
}

export function bandOf(score: number): Band;
export function bandOf(score: number | null): Band | null;
export function bandOf(score: number | null): Band | null {
  if (score === null) return null;
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

/** "86 (Excellent)", or "no score yet" when nothing could be measured. */
export function scoreText(score: number | null, band: Band | null) {
  return score === null ? "no score yet" : `${Math.round(score)}${band ? ` (${BAND_LABEL[band]})` : ""}`;
}

/** The weights as the screens use them: the server's whole percents (35) become fractions (0.35). */
export const percentsToFractions = (weights: Record<string, number>): Record<string, number> =>
  Object.fromEntries(Object.entries(weights).map(([k, v]) => [k, v / 100]));

/** In words, why a metric has no value. */
export const UNMEASURED_TEXT: Record<UnmeasuredReason, string> = {
  attendance_not_available: "Attendance arrives with the Attendance module.",
  sales_not_available: "Sales figures arrive with the Sales module.",
  nothing_to_measure: "Nothing to measure yet: no task counted this month gives it a value.",
};

/** The reason a metric has no value (from the list the server sent), or a plain default. */
export function unmeasuredReason(unmeasured: UnmeasuredMetric[] | undefined, key: string): string {
  const r = unmeasured?.find((u) => u.key === key)?.reason;
  return r ? UNMEASURED_TEXT[r] : "Not available yet.";
}

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
