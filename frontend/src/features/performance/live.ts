/**
 * Module 6 against the REAL API: maps what the server answers (packages/contracts/src/performance.ts) to the shapes the
 * screens use (types.ts). Pure functions, no requests. The one real change is the weights: the server keeps and sends
 * WHOLE PERCENTS (35); the performance screens do their maths and show "Weight 35%" from fractions (0.35), so every
 * weights version is divided by 100 here. Nothing else is converted and nothing is made up: a metric the server could
 * not measure stays null, a score it could not work out stays null.
 */
import type {
  LivePerformanceView,
  PerformanceWeightsView,
  RatingDisputeView,
  ScoreWeightsVersionView,
  ScorecardCommentView,
  ScorecardDetailView,
  ScorecardTaskView,
  ScorecardView,
  TeamPerformanceRowView,
} from "@aceva/contracts";
import { percentsToFractions } from "./logic";
import type { LivePerformance, RatingDispute, Scorecard, ScorecardComment, ScorecardDetail, ScorecardTask, TeamPerformanceRow, WeightsVersion } from "./types";

/**
 * A weights version for the performance screens: whole percents become fractions. Takes the slim weights of the live view and
 * the scorecard detail (no createdBy, no note) and the full Settings items alike; the performance screens never read note or
 * createdBy, which stay undefined for the slim ones.
 */
export function mapWeights(v: PerformanceWeightsView & Partial<Pick<ScoreWeightsVersionView, "createdBy" | "note">>): WeightsVersion {
  return {
    id: v.id,
    label: v.label,
    kind: v.kind,
    departmentId: v.departmentId,
    departmentName: v.departmentName,
    weights: percentsToFractions(v.weights),
    effectiveFrom: v.effectiveFrom,
    versionNo: v.versionNo,
    createdBy: v.createdBy,
    note: v.note,
  };
}

export function mapTask(t: ScorecardTaskView): ScorecardTask {
  return {
    taskId: t.taskId,
    number: t.number,
    title: t.title,
    size: t.size,
    points: t.points,
    rating: t.rating,
    originalRating: t.originalRating,
    onTime: t.onTime,
    reworked: t.reworked,
    extensions: t.extensions,
    status: t.status,
    deadline: t.deadline,
    counted: t.counted,
  };
}

export function mapScorecard(s: ScorecardView): Scorecard {
  return {
    id: s.id,
    empId: s.empId,
    month: s.month,
    kind: s.kind,
    metrics: s.metrics,
    salesDetail: s.salesDetail,
    unmeasured: s.unmeasured,
    weightsVersionId: s.weightsVersionId,
    score: s.score,
    band: s.band,
    taskCount: s.taskCount,
    smallSample: s.smallSample,
    status: s.status,
    reviewerEmpId: s.reviewerEmpId,
    reviewerRemark: s.reviewerRemark,
    remarkAt: s.remarkAt,
    releasedAt: s.releasedAt,
    releasedBy: s.releasedBy,
    acknowledgedAt: s.acknowledgedAt,
    employeeComment: s.employeeComment,
    recomputeCount: s.recomputeCount,
    tasks: s.tasks.map(mapTask),
    createdAt: s.createdAt,
  };
}

export function mapDispute(d: RatingDisputeView): RatingDispute {
  return {
    id: d.id,
    scorecardId: d.scorecardId,
    empId: d.empId,
    taskNumber: d.taskNumber,
    taskTitle: d.taskTitle,
    currentRating: d.currentRating,
    reason: d.reason,
    status: d.status,
    deciderEmpId: d.deciderEmpId,
    decidedBy: d.decidedBy,
    decision: d.decision,
    newRating: d.newRating,
    at: d.at,
    decidedAt: d.decidedAt,
    scoreBefore: d.scoreBefore,
    scoreAfter: d.scoreAfter,
    month: d.month,
  };
}

export const mapComment = (c: ScorecardCommentView): ScorecardComment => ({ id: c.id, kind: c.kind, author: c.author, body: c.body, at: c.at });

export function mapDetail(d: ScorecardDetailView): ScorecardDetail {
  return { scorecard: mapScorecard(d.scorecard), weights: mapWeights(d.weights), disputes: d.disputes.map(mapDispute), comments: d.comments.map(mapComment) };
}

export function mapLive(v: LivePerformanceView): LivePerformance {
  return {
    empId: v.empId,
    month: v.month,
    kind: v.kind,
    metrics: v.metrics,
    salesDetail: v.salesDetail,
    unmeasured: v.unmeasured,
    weights: mapWeights(v.weights),
    score: v.score,
    band: v.band,
    taskCount: v.taskCount,
    smallSample: v.smallSample,
    trend: v.trend.map((t) => ({ month: t.month, score: t.score })),
    tasks: v.tasks.map(mapTask),
  };
}

export function mapTeamRow(r: TeamPerformanceRowView): TeamPerformanceRow {
  return {
    empId: r.empId,
    kind: r.kind,
    latest: r.latest ? mapScorecard(r.latest) : null,
    live: { score: r.live.score, band: r.live.band, smallSample: r.live.smallSample },
    trend: r.trend.map((t) => ({ month: t.month, score: t.score })),
  };
}
