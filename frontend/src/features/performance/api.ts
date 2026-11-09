/**
 * Module 6 service functions. Mock today; each JSDoc names the real endpoint (spec §7.3).
 * Live figures are computed from Module 5 tasks and Module 7 attendance; nobody types a score in.
 */
import { ApiError, mock, notFound } from "@/lib/api/mock";
import { chainAbove, descendantsOf, isInScope } from "@/lib/auth/scope";
import { getViewer } from "@/lib/auth/viewer";
import { employeesTable } from "@/lib/directory";
import { monthKey } from "@/lib/dates";
import { uid } from "@/lib/utils";
import { table } from "@/mocks/db";
import { hash01 } from "@/mocks/seed/attendance";
import { seedDisputes, seedScorecards, WEIGHT_VERSIONS } from "@/mocks/seed/performance";
import { attendanceRate } from "@/features/attendance/api";
import { tasksTable } from "@/features/tasks/api";
import { openHours } from "@/features/tasks/logic";
import type { Task } from "@/features/tasks/types";
import { bandOf, computeScore, salesMetrics, SMALL_SAMPLE, taskMetrics } from "./logic";
import type {
  LivePerformance, MetricSet, RatingDispute, SalesDetail, Scorecard, ScorecardDetail, ScorecardTask, TeamPerformanceRow, TrendPoint, WeightsVersion,
} from "./types";

export const scorecardsTable = () => table<Scorecard>("performance.scorecards", seedScorecards);
export const disputesTable = () => table<RatingDispute>("performance.disputes", () => seedDisputes(scorecardsTable()));
const weightsTable = () => table<WeightsVersion>("performance.weights", () => structuredClone(WEIGHT_VERSIONS));

const isSalesPerson = (empId: string) => employeesTable().find((e) => e.empId === empId)?.departmentId === "dep-sales";

/** The newest weights of a kind (live month uses the current version). */
function currentWeights(kind: "standard" | "sales") {
  return weightsTable()
    .filter((w) => w.kind === kind)
    .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
}

function latestFor(empId: string, includeDraft: boolean) {
  return scorecardsTable()
    .filter((s) => s.empId === empId && (includeDraft || s.status !== "draft"))
    .sort((a, b) => b.month.localeCompare(a.month))[0];
}

/** Who may see a person's scorecards: themselves, the levels above (scope), and level 1–3 with view_all. */
function canSeePerson(empId: string) {
  const v = getViewer();
  const me = v.employee.empId;
  if (me === empId) return true;
  if (isInScope(me, empId)) return true;
  if (v.can("performance.view_all")) {
    const target = employeesTable().find((e) => e.empId === empId);
    return !!target && target.level >= v.employee.level;
  }
  return false;
}

function taskToScorecardTask(t: Task): ScorecardTask {
  const reworked = t.status === "rework" || !!(t.reviewComment && t.status !== "approved" && t.status !== "cancelled");
  const wasSubmitted = ["submitted", "under_review", "approved", "rework"].includes(t.status);
  // On time is measured at submission, against the approved (possibly extended) deadline.
  const onTime = t.submittedAt ? new Date(t.submittedAt) <= new Date(t.deadline) : wasSubmitted || new Date(t.deadline) >= new Date();
  return {
    taskId: t.id,
    number: t.number,
    title: t.title,
    size: t.size,
    points: t.points,
    rating: t.rating,
    onTime,
    reworked,
    extensions: t.extensionsCount,
    status: t.status === "approved" ? "approved" : t.status === "cancelled" ? "cancelled" : t.status === "submitted" || t.status === "under_review" ? "submitted" : "open",
    deadline: t.deadline,
  };
}

/** Sales numbers for the live month (from Module 15 in production; mocked here). */
function liveSalesDetail(empId: string): SalesDetail {
  const k = `${empId}|live`;
  const today = new Date().getDate();
  const workingDays = Math.max(1, Math.round((today / 30) * 21));
  return {
    workingDays,
    targetDaysMet: Math.round(workingDays * (empId === "ACV-0012" ? 0.6 : 0.85)),
    meetingTarget: 8,
    meetings: Math.round((empId === "ACV-0012" ? 2 : 3) + hash01(`${k}|m`) * 2),
    wonTargetUsd: empId === "ACV-0014" ? 12000 : 4000,
    wonValueUsd: empId === "ACV-0012" ? 0 : Math.round((800 + hash01(`${k}|w`) * 1600) / 50) * 50,
    bounceRate: empId === "ACV-0012" ? 3.6 : 2.2,
    duplicates: empId === "ACV-0012" ? 1 : 0,
  };
}

function computeLive(empId: string): LivePerformance {
  const month = monthKey(new Date());
  const sales = isSalesPerson(empId);
  const kind = sales ? "sales" : "standard";
  const weights = currentWeights(kind);
  const latest = latestFor(empId, true);
  const att = attendanceRate(empId, month).rate ?? (latest ? (latest.metrics as MetricSet).attendance : 100);
  let metrics: LivePerformance["metrics"];
  let tasks: ScorecardTask[] = [];
  let salesDetail: SalesDetail | undefined;
  let taskCount = 0;
  if (sales) {
    salesDetail = liveSalesDetail(empId);
    metrics = salesMetrics(salesDetail, att);
    taskCount = salesDetail.workingDays;
  } else {
    const now = new Date();
    tasks = tasksTable()
      .filter((t) => t.assignee === empId && !t.personal)
      .filter((t) => monthKey(t.deadline) === month || (t.status === "approved" && monthKey(t.updatedAt) === month) || (t.status !== "approved" && t.status !== "cancelled" && new Date(t.deadline) < now))
      .map(taskToScorecardTask);
    const tm = taskMetrics(tasks.filter((t) => t.status !== "open" || new Date(t.deadline) <= now || t.reworked));
    const prev = latest && latest.kind === "standard" ? (latest.metrics as MetricSet) : undefined;
    metrics = {
      quality: tm.quality ?? prev?.quality ?? 80,
      onTime: tm.onTime ?? prev?.onTime ?? 100,
      completion: tm.completion ?? prev?.completion ?? 100,
      rework: tm.rework ?? prev?.rework ?? 0,
      attendance: Math.round(att * 10) / 10,
      workloadHours: openHours(tasksTable(), empId),
    };
    taskCount = tasks.filter((t) => t.status !== "cancelled").length;
  }
  const score = computeScore(kind, metrics, weights.weights);
  const trend: TrendPoint[] = scorecardsTable()
    .filter((s) => s.empId === empId)
    .sort((a, b) => a.month.localeCompare(b.month))
    .slice(-6)
    .map((s) => ({ month: s.month, score: s.score }));
  trend.push({ month, score });
  return { empId, month, kind, metrics, salesDetail, weights, score, band: bandOf(score), taskCount, smallSample: !sales && taskCount < SMALL_SAMPLE, trend, tasks };
}

function recompute(sc: Scorecard) {
  if (sc.kind !== "standard") return;
  const w = weightsTable().find((x) => x.id === sc.weightsVersionId)!;
  const tm = taskMetrics(sc.tasks);
  const m = sc.metrics as MetricSet;
  sc.metrics = { ...m, quality: tm.quality ?? m.quality, onTime: tm.onTime ?? m.onTime, completion: tm.completion ?? m.completion, rework: tm.rework ?? m.rework };
  sc.score = computeScore("standard", sc.metrics, w.weights);
  sc.band = bandOf(sc.score);
}

/** Apply a dispute decision (shared by the Disputes tab and the Approvals inbox). */
export function applyDisputeDecision(d: RatingDispute, change: boolean, me: string, decision: string, newRating?: number) {
  d.status = change ? "changed" : "upheld";
  d.decidedBy = me;
  d.decidedAt = new Date().toISOString();
  d.decision = decision;
  if (change && newRating) {
    d.newRating = newRating;
    const sc = scorecardsTable().find((s) => s.id === d.scorecardId);
    const task = sc?.tasks.find((t) => t.number === d.taskNumber);
    if (sc && task) {
      task.rating = newRating;
      recompute(sc);
    }
  }
}

export function applyRelease(sc: Scorecard, remark?: string) {
  const now = new Date().toISOString();
  if (remark) {
    sc.reviewerRemark = remark;
    sc.remarkAt = now;
  }
  sc.status = "released";
  sc.releasedAt = now;
}

export const performanceApi = {
  /** GET /performance/live?empId */
  live: (empId?: string) =>
    mock(() => {
      const id = empId ?? getViewer().employee.empId;
      if (!canSeePerson(id)) throw new ApiError("forbidden", "You can only see your own results and your team's.", 403);
      return computeLive(id);
    }),

  /** GET /scorecards?empId&latest=1 — the newest scorecard the viewer may see (drafts only for the reviewer) */
  latest: (empId?: string) =>
    mock(() => {
      const me = getViewer().employee.empId;
      const id = empId ?? me;
      if (!canSeePerson(id)) throw new ApiError("forbidden", "You can only see your own results and your team's.", 403);
      return latestFor(id, id !== me) ?? null;
    }),

  /** GET /scorecards?empId */
  list: (empId?: string) =>
    mock(() => {
      const me = getViewer().employee.empId;
      const id = empId ?? me;
      if (!canSeePerson(id)) throw new ApiError("forbidden", "You can only see your own results and your team's.", 403);
      return scorecardsTable()
        .filter((s) => s.empId === id && (id !== me || s.status !== "draft"))
        .sort((a, b) => b.month.localeCompare(a.month));
    }),

  /** GET /scorecards/:id */
  get: (id: string) =>
    mock<ScorecardDetail>(() => {
      const me = getViewer().employee.empId;
      const sc = scorecardsTable().find((s) => s.id === id);
      if (!sc || !canSeePerson(sc.empId) || (sc.empId === me && sc.status === "draft")) notFound("Scorecard");
      return {
        scorecard: sc,
        weights: weightsTable().find((w) => w.id === sc.weightsVersionId)!,
        disputes: disputesTable().filter((d) => d.scorecardId === sc.id),
      };
    }),

  /** GET /performance/team — side by side, no ranking (plan §10) */
  team: () =>
    mock<TeamPerformanceRow[]>(() => {
      const v = getViewer();
      const me = v.employee.empId;
      const ids = v.can("performance.view_all")
        ? employeesTable().filter((e) => e.empId !== me && e.reportsTo && e.level >= v.employee.level && e.status !== "left").map((e) => e.empId)
        : descendantsOf(me);
      return ids.map((empId) => {
        const live = computeLive(empId);
        return {
          empId,
          kind: live.kind,
          latest: latestFor(empId, true) ?? null,
          live: { score: live.score, band: live.band, smallSample: live.smallSample },
          trend: live.trend,
        };
      });
    }),

  /** POST /scorecards/:id/remark — the reviewer can add a remark but never change the numbers */
  remark: (id: string, remark: string) =>
    mock(() => {
      const sc = scorecardsTable().find((s) => s.id === id);
      if (!sc) notFound("Scorecard");
      if (sc.reviewerEmpId !== getViewer().employee.empId) throw new ApiError("forbidden", "Only the reviewer adds a remark.", 403);
      sc.reviewerRemark = remark;
      sc.remarkAt = new Date().toISOString();
    }),

  /** POST /scorecards/:id/release */
  release: (id: string, remark?: string) =>
    mock(() => {
      const sc = scorecardsTable().find((s) => s.id === id);
      if (!sc) notFound("Scorecard");
      if (sc.reviewerEmpId !== getViewer().employee.empId) throw new ApiError("forbidden", "Only the reviewer releases a scorecard.", 403);
      applyRelease(sc, remark);
    }),

  /** POST /scorecards/:id/acknowledge */
  acknowledge: (id: string, comment?: string) =>
    mock(() => {
      const sc = scorecardsTable().find((s) => s.id === id);
      if (!sc || sc.empId !== getViewer().employee.empId) notFound("Scorecard");
      sc.status = "acknowledged";
      sc.acknowledgedAt = new Date().toISOString();
      if (comment) sc.employeeComment = comment;
    }),

  /** GET /disputes?scope */
  disputes: () =>
    mock(() => {
      const me = getViewer().employee.empId;
      const below = new Set(descendantsOf(me));
      return disputesTable()
        .filter((d) => d.empId === me || d.deciderEmpId === me || below.has(d.empId))
        .sort((a, b) => b.at.localeCompare(a.at));
    }),

  /** POST /disputes */
  raiseDispute: (scorecardId: string, taskNumber: string, reason: string) =>
    mock(() => {
      const me = getViewer().employee.empId;
      const sc = scorecardsTable().find((s) => s.id === scorecardId);
      if (!sc || sc.empId !== me) notFound("Scorecard");
      const task = sc.tasks.find((t) => t.number === taskNumber);
      if (!task?.rating) throw new ApiError("validation", "Choose a rated task.");
      if (disputesTable().some((d) => d.scorecardId === scorecardId && d.taskNumber === taskNumber && d.status === "open"))
        throw new ApiError("validation", "This rating is already disputed.");
      const chain = chainAbove(me);
      const decider = chain[1] ?? chain[0];
      const d: RatingDispute = {
        id: uid("dsp"),
        scorecardId,
        empId: me,
        taskNumber,
        taskTitle: task.title,
        currentRating: task.rating,
        reason,
        status: "open",
        deciderEmpId: decider?.empId ?? me,
        at: new Date().toISOString(),
      };
      disputesTable().unshift(d);
      return d;
    }),

  /** POST /disputes/:id/decide */
  decideDispute: (id: string, change: boolean, decision: string, newRating?: number) =>
    mock(() => {
      const me = getViewer().employee.empId;
      const d = disputesTable().find((x) => x.id === id);
      if (!d) notFound("Dispute");
      if (d.deciderEmpId !== me) throw new ApiError("forbidden", "This dispute is decided by the next level up.", 403);
      applyDisputeDecision(d, change, me, decision, newRating);
    }),

  /** GET /settings/score-weights */
  weights: () => mock(() => weightsTable(), { delay: 60 }),
};
