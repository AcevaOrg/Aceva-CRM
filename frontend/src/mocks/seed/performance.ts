/**
 * Seed: monthly scorecards (6 closed months), score-weight versions and rating disputes (Module 6).
 * Task-based metrics are computed from the generated task list, so every scorecard adds up.
 * Each scorecard is reviewed and released by the person's manager: Engineering → CTO; CTO, Sales and Finance →
 * Director. The CEO / Founder / Owner reviews nothing, so the Director's scorecard has no reviewer: it is released
 * automatically when the month closes and the CEO / Founder / Owner views it. Sales use the sales weights.
 */
import type { MetricSet, RatingDispute, SalesDetail, Scorecard, ScorecardStatus, ScorecardTask, WeightsVersion } from "@/features/performance/types";
import { bandOf, computeScore, salesMetrics, scorecardReviewer, SMALL_SAMPLE, taskMetrics } from "@/features/performance/logic";
import type { TaskSize } from "@/features/tasks/types";
import { hash01 } from "./attendance";
import { EMPLOYEES } from "./people";
import { dayOfMonth, minutesAgo, monthFromNow } from "../time";

export const WEIGHT_VERSIONS: WeightsVersion[] = [
  { id: "wv-std-1", label: "Standard v1", kind: "standard", weights: { quality: 0.4, onTime: 0.25, completion: 0.2, rework: 0.05, attendance: 0.1 }, effectiveFrom: monthFromNow(-12) },
  { id: "wv-std-2", label: "Standard v2", kind: "standard", weights: { quality: 0.35, onTime: 0.25, completion: 0.2, rework: 0.1, attendance: 0.1 }, effectiveFrom: monthFromNow(-2) },
  { id: "wv-sales-1", label: "Sales v1", kind: "sales", weights: { activity: 0.2, meetings: 0.25, won: 0.3, dataQuality: 0.1, attendance: 0.15 }, effectiveFrom: monthFromNow(-12) },
];

/** Profile per person: mean rating, on-time chance, rework chance, completion chance, attendance, task count range. */
const PROFILE: Record<string, { rating: number; onTime: number; rework: number; done: number; att: number; n: [number, number] }> = {
  "ACV-0003": { rating: 4.3, onTime: 0.9, rework: 0.06, done: 0.92, att: 95, n: [5, 8] },
  "ACV-0004": { rating: 4.4, onTime: 0.92, rework: 0.05, done: 0.94, att: 97, n: [5, 8] },
  "ACV-0006": { rating: 4.3, onTime: 0.9, rework: 0.06, done: 0.92, att: 95, n: [6, 9] },
  "ACV-0007": { rating: 4.5, onTime: 0.94, rework: 0.06, done: 0.95, att: 97, n: [6, 9] },
  "ACV-0008": { rating: 3.5, onTime: 0.7, rework: 0.2, done: 0.8, att: 82, n: [6, 9] },
  "ACV-0010": { rating: 4.2, onTime: 0.9, rework: 0.08, done: 0.92, att: 95, n: [5, 8] },
  "ACV-0011": { rating: 4.1, onTime: 0.86, rework: 0.1, done: 0.88, att: 93, n: [5, 8] },
  "ACV-0013": { rating: 3.8, onTime: 0.82, rework: 0.15, done: 0.85, att: 90, n: [3, 6] },
};

const SALES: Record<string, { met: number; meet: [number, number]; won: [number, number]; bounce: number; dups: number; att: number }> = {
  "ACV-0009": { met: 0.85, meet: [7, 8], won: [3200, 4000], bounce: 2.4, dups: 0, att: 95 },
  "ACV-0012": { met: 0.62, meet: [4, 8], won: [900, 4000], bounce: 4.1, dups: 1, att: 86 },
  "ACV-0014": { met: 0.8, meet: [12, 14], won: [9500, 12000], bounce: 2.8, dups: 0, att: 91 },
};

const TITLES: Record<string, string[]> = {
  "dep-eng": ["Login screen polish", "API pagination", "Fix date bug in reports", "Dashboard cards", "Unit tests for scores", "Release notes", "Database migration", "Accessibility pass", "Client demo build", "Error states for lists", "Refactor table component", "Upload limits"],
  // Finance: the Finance person prepares; the Director approves.
  "dep-fin": ["Bank reconciliation", "Vendor bill entry", "Month-end checklist", "Payroll draft check", "Tax summary", "Invoice follow-ups", "Expense receipts audit", "Opening balances"],
  // Management: the Director's own work (HR and sales-manager duty). The Director prepares no finance items.
  "dep-mgmt": ["Quarterly plan", "Client review meeting", "Hiring plan", "Vendor negotiation", "Onboarding pack", "Sales target review", "Policy update", "Interview schedule"],
};

const SIZES: TaskSize[] = ["XS", "S", "S", "M", "M", "M", "L"];
const POINTS: Record<TaskSize, number> = { XS: 1, S: 2, M: 3, L: 5, XL: 0 };

function genTasks(empId: string, dept: string, offset: number): ScorecardTask[] {
  const p = PROFILE[empId];
  const key = `${empId}|${offset}`;
  const n = p.n[0] + Math.floor(hash01(`${key}|n`) * (p.n[1] - p.n[0] + 1));
  const titles = TITLES[dept] ?? TITLES["dep-eng"];
  return Array.from({ length: n }, (_, i) => {
    const k = `${key}|${i}`;
    const size = SIZES[Math.floor(hash01(`${k}|size`) * SIZES.length)];
    const cancelled = hash01(`${k}|cancel`) < 0.05;
    const done = hash01(`${k}|done`) < p.done;
    const rating = Math.max(1, Math.min(5, Math.round(p.rating + (hash01(`${k}|rating`) - 0.5) * 2.2)));
    const reworked = hash01(`${k}|rework`) < p.rework;
    const extensions = hash01(`${k}|ext`) < 0.12 ? 1 : 0;
    return {
      number: `TSK-${String(10 + ((Math.abs(offset) * 37 + i * 7 + empId.charCodeAt(7) * 3) % 99)).padStart(4, "0")}`,
      title: titles[(i + Math.abs(offset) + empId.charCodeAt(7)) % titles.length],
      size,
      points: POINTS[size],
      rating: !cancelled && done ? rating : undefined,
      onTime: hash01(`${k}|ontime`) < p.onTime || extensions > 0,
      reworked: !cancelled && reworked,
      extensions,
      status: cancelled ? "cancelled" : done ? "approved" : "open",
      deadline: dayOfMonth(offset, 3 + ((i * 4) % 25), "18:00"),
    } satisfies ScorecardTask;
  });
}

function statusFor(empId: string, offset: number, hasReviewer: boolean): ScorecardStatus {
  if (offset < -1) return "acknowledged";
  // The Director's scorecard has no reviewer: released automatically, the CEO / Founder / Owner views it.
  if (!hasReviewer) return "released";
  // Last month's drafts wait for the manager: engineers for the CTO, the CTO and Sales for the Director.
  if (["ACV-0013", "ACV-0012", "ACV-0006", "ACV-0004"].includes(empId)) return "draft";
  if (["ACV-0007", "ACV-0011", "ACV-0009", "ACV-0008", "ACV-0010"].includes(empId)) return "released";
  return "acknowledged";
}

const REMARKS = [
  "Steady month. Keep the same pace on reviews.",
  "Great ownership of the release work.",
  "Please raise blockers earlier; two tasks slipped quietly.",
  "Good quality. Fewer extensions next month, please.",
];

export function seedScorecards(): Scorecard[] {
  const out: Scorecard[] = [];
  for (const e of EMPLOYEES) {
    if (!e.reportsTo || e.status === "left") continue;
    const sales = e.role === "sales";
    for (let offset = -6; offset <= -1; offset++) {
      const month = monthFromNow(offset);
      if (new Date(e.joiningDate) > new Date(dayOfMonth(offset, 28))) continue;
      const wv = sales ? "wv-sales-1" : offset <= -3 ? "wv-std-1" : "wv-std-2";
      const weights = WEIGHT_VERSIONS.find((w) => w.id === wv)!.weights;
      const k = `${e.empId}|${offset}`;
      let metrics: Scorecard["metrics"];
      let tasks: ScorecardTask[] = [];
      let salesDetail: SalesDetail | undefined;
      let taskCount = 0;
      if (sales) {
        const s = SALES[e.empId];
        const workingDays = 21 + Math.floor(hash01(`${k}|wd`) * 2);
        salesDetail = {
          workingDays,
          targetDaysMet: Math.round(workingDays * Math.min(1, s.met + (hash01(`${k}|met`) - 0.5) * 0.2)),
          meetingTarget: 8,
          meetings: s.meet[0] + Math.floor(hash01(`${k}|meet`) * (s.meet[1] - s.meet[0] + 1)),
          wonTargetUsd: e.empId === "ACV-0014" ? 12000 : 4000,
          wonValueUsd: Math.round((s.won[0] + hash01(`${k}|won`) * (s.won[1] - s.won[0])) / 50) * 50,
          bounceRate: Math.round((s.bounce + (hash01(`${k}|b`) - 0.5) * 1.6) * 10) / 10,
          duplicates: hash01(`${k}|dup`) < 0.3 ? s.dups : 0,
        };
        metrics = salesMetrics(salesDetail, Math.min(100, s.att + (hash01(`${k}|att`) - 0.5) * 8));
        taskCount = salesDetail.workingDays;
      } else {
        tasks = genTasks(e.empId, e.departmentId, offset);
        const tm = taskMetrics(tasks);
        const p = PROFILE[e.empId];
        metrics = {
          quality: tm.quality ?? 80,
          onTime: tm.onTime ?? 100,
          completion: tm.completion ?? 100,
          rework: tm.rework ?? 0,
          attendance: Math.round(Math.min(100, p.att + (hash01(`${k}|att`) - 0.5) * 10) * 10) / 10,
          workloadHours: 18 + Math.floor(hash01(`${k}|wl`) * 20),
        } satisfies MetricSet;
        taskCount = tm.taskCount;
      }
      const score = computeScore(sales ? "sales" : "standard", metrics, weights);
      const reviewer = scorecardReviewer(e.empId, EMPLOYEES);
      const status = statusFor(e.empId, offset, !!reviewer);
      const created = dayOfMonth(offset + 1, 1, "02:00");
      const hasRemark = !!reviewer && status !== "draft" && hash01(`${k}|remark`) < 0.6;
      out.push({
        id: `sc_${e.empId.slice(-4)}_${month}`,
        empId: e.empId,
        month,
        kind: sales ? "sales" : "standard",
        metrics,
        salesDetail,
        weightsVersionId: wv,
        score,
        band: bandOf(score),
        taskCount,
        smallSample: !sales && taskCount < SMALL_SAMPLE,
        status,
        reviewerEmpId: reviewer?.empId,
        reviewerRemark: hasRemark ? REMARKS[Math.floor(hash01(`${k}|rm`) * REMARKS.length)] : undefined,
        remarkAt: hasRemark ? dayOfMonth(offset + 1, 3, "11:00") : undefined,
        // Without a reviewer the scorecard is released when the draft is made (month close).
        releasedAt: status === "draft" ? undefined : reviewer ? dayOfMonth(offset + 1, offset === -1 ? 5 : 4, "16:00") : created,
        acknowledgedAt: status === "acknowledged" ? dayOfMonth(offset + 1, 6, "10:00") : undefined,
        employeeComment: status === "acknowledged" && hash01(`${k}|ec`) < 0.35 ? "Thanks. I'll work on finishing tasks before the deadline." : undefined,
        tasks,
        createdAt: created,
      });
    }
  }
  return out;
}

export function seedDisputes(scorecards: Scorecard[]): RatingDispute[] {
  const out: RatingDispute[] = [];
  const pick = (empId: string, offset: number) => {
    const sc = scorecards.find((s) => s.empId === empId && s.month === monthFromNow(offset));
    const task = sc?.tasks.filter((t) => t.rating).sort((a, b) => (a.rating ?? 5) - (b.rating ?? 5))[0];
    return sc && task ? { sc, task } : null;
  };
  const a = pick("ACV-0008", -1);
  if (a)
    out.push({
      id: "dsp_1",
      scorecardId: a.sc.id,
      empId: "ACV-0008",
      taskNumber: a.task.number,
      taskTitle: a.task.title,
      currentRating: a.task.rating!,
      reason: "The bug that lowered this rating came from a third-party API change on release day, not from my code. The fix was out the same evening.",
      status: "open",
      // The CTO reviewed the task, so the level above (the Director) decides.
      deciderEmpId: "ACV-0003",
      at: minutesAgo(60 * 26),
    });
  const b = pick("ACV-0011", -2);
  if (b)
    out.push({
      id: "dsp_2",
      scorecardId: b.sc.id,
      empId: "ACV-0011",
      taskNumber: b.task.number,
      taskTitle: b.task.title,
      currentRating: b.task.rating!,
      reason: "The client changed the brief twice; the final design matched the last version.",
      status: "upheld",
      deciderEmpId: "ACV-0003",
      decidedBy: "ACV-0003",
      decision: "The rating reflects the missed accessibility checks, not the brief changes. Rating kept.",
      at: minutesAgo(60 * 24 * 30),
      decidedAt: minutesAgo(60 * 24 * 27),
    });
  return out;
}
