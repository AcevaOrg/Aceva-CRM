/**
 * Pure task rules (plan §9). Mirrored on the server; unit-test these.
 */
import { addWorkingDays, workingDaysBetween } from "@/lib/dates";
import type { Priority, SizeRule, Task, TaskSize, TaskStatus } from "./types";

/** Default size table; the Director can change it in Settings. */
export const SIZE_RULES: SizeRule[] = [
  { size: "XS", meaning: "Very small, such as fixing a typo", hours: 2, hoursLabel: "Up to 2 h", points: 1, days: 0 },
  { size: "S", meaning: "Small", hours: 4, hoursLabel: "2–4 h", points: 2, days: 1 },
  { size: "M", meaning: "Medium", hours: 12, hoursLabel: "1–2 days", points: 3, days: 3 },
  { size: "L", meaning: "Large", hours: 32, hoursLabel: "3–5 days", points: 5, days: 7 },
  { size: "XL", meaning: "Very large", hours: 48, hoursLabel: "More than 1 week", points: 0, days: null },
];

export const sizeRule = (s: TaskSize) => SIZE_RULES.find((r) => r.size === s)!;

export const STATUS_LABEL: Record<TaskStatus, string> = {
  assigned: "Assigned",
  in_progress: "In progress",
  submitted: "Submitted",
  under_review: "Under review",
  approved: "Approved",
  rework: "Rework",
  on_hold: "On hold",
  cancelled: "Cancelled",
};

export const PRIORITY_LABEL: Record<Priority, string> = { low: "Low", medium: "Medium", high: "High", urgent: "Urgent" };

export const OPEN_STATUSES: TaskStatus[] = ["assigned", "in_progress", "submitted", "under_review", "rework", "on_hold"];
export const isOpen = (s: TaskStatus) => OPEN_STATUSES.includes(s);

/** Suggested deadline from the start date, counting working days only and skipping holidays. */
export function suggestedDeadline(start: Date | string, size: TaskSize, holidays: string[] = []) {
  const days = sizeRule(size).days;
  const d = addWorkingDays(start, days ?? 10, holidays);
  d.setHours(18, 0, 0, 0);
  return d;
}

export type Hint = { tone: "warning" | "error" | "info"; text: string };

/** Deadline hints shown under the field (plan §9 "too-short warning", "no past deadline"). */
export function deadlineHints(start: string, deadline: string, size: TaskSize, holidays: string[] = []): Hint[] {
  const hints: Hint[] = [];
  if (!deadline) return [{ tone: "error", text: "A deadline is required." }];
  const dl = new Date(deadline);
  if (dl.getTime() < Date.now()) hints.push({ tone: "error", text: "A deadline can't be in the past." });
  const rule = sizeRule(size);
  if (rule.days === null) return hints;
  const given = Math.max(0, workingDaysBetween(start, dl, holidays) - 1);
  if (rule.days > 0 && given < rule.days) {
    hints.push({
      tone: "warning",
      text: `An ${size} task usually needs ${rule.days} working day${rule.days === 1 ? "" : "s"}; you set ${given}. You can continue.`,
    });
  }
  return hints;
}

/** Allowed next statuses for the person acting (plan §9 status flow). */
export function allowedTransitions(task: Task, actor: { empId: string; isAssigner: boolean; isReviewer: boolean }): TaskStatus[] {
  const own = actor.empId === task.assignee;
  const out: TaskStatus[] = [];
  switch (task.status) {
    case "assigned":
      if (own) out.push("in_progress");
      break;
    case "in_progress":
    case "rework":
      if (own) out.push("submitted");
      break;
    case "submitted":
      if (actor.isReviewer) out.push("under_review", "approved", "rework");
      break;
    case "under_review":
      if (actor.isReviewer) out.push("approved", "rework");
      break;
    case "on_hold":
      if (actor.isAssigner) out.push("in_progress");
      break;
  }
  if (actor.isAssigner && isOpen(task.status) && task.status !== "on_hold") out.push("on_hold", "cancelled");
  return out;
}

/** Waiting on the reviewer or finished: the deadline no longer counts against the assignee. */
export function isSettled(s: TaskStatus) {
  return !isOpen(s) || s === "submitted" || s === "under_review";
}

export function openHours(tasks: Task[], empId: string) {
  return tasks.filter((t) => t.assignee === empId && !t.personal && isOpen(t.status)).reduce((h, t) => h + t.estimatedHours, 0);
}

export function computeOverdue(t: Pick<Task, "deadline" | "status">) {
  return isOpen(t.status) && t.status !== "submitted" && t.status !== "under_review" && new Date(t.deadline).getTime() < Date.now();
}
