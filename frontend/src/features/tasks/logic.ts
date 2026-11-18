/**
 * Pure task rules (plan §9). Mirrored on the server; unit-test these.
 */
import { addWorkingDays, isWorkingDay, workingDaysBetween } from "@/lib/dates";
import type { Priority, SizeRule, StatusChange, Task, TaskAction, TaskSize, TaskStatus } from "./types";

/**
 * Default size table (the mock screens use it as is). Live, the real table comes from GET /settings/task-sizes (the
 * Director can change it); the screens pass it to sizeRule(), suggestedDeadline() and deadlineHints() as `rules`.
 */
export const SIZE_RULES: SizeRule[] = [
  { size: "XS", meaning: "Very small, such as fixing a typo", hours: 2, hoursLabel: "Up to 2 h", points: 1, days: 0 },
  { size: "S", meaning: "Small", hours: 4, hoursLabel: "2–4 h", points: 2, days: 1 },
  { size: "M", meaning: "Medium", hours: 12, hoursLabel: "1–2 days", points: 3, days: 3 },
  { size: "L", meaning: "Large", hours: 32, hoursLabel: "3–5 days", points: 5, days: 7 },
  { size: "XL", meaning: "Very large", hours: 48, hoursLabel: "More than 1 week", points: 0, days: null },
];

export const sizeRule = (s: TaskSize, rules: SizeRule[] = SIZE_RULES) => rules.find((r) => r.size === s) ?? SIZE_RULES.find((r) => r.size === s)!;

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
export function suggestedDeadline(start: Date | string, size: TaskSize, holidays: string[] = [], rules: SizeRule[] = SIZE_RULES) {
  const days = sizeRule(size, rules).days;
  const d = addWorkingDays(start, days ?? 10, holidays);
  d.setHours(18, 0, 0, 0);
  return d;
}

/**
 * The earliest and the latest moment a task date may have: the years 2020 to 2100, as on the server (TASK_DATE_MIN and
 * TASK_DATE_MAX in packages/contracts/src/tasks.ts; keep them the same). A date outside that is a typing slip, such as the
 * year 20260.
 */
const TASK_DATE_MIN_MS = Date.parse("2020-01-01T00:00:00.000Z");
const TASK_DATE_MAX_MS = Date.parse("2100-12-31T23:59:59.999Z");
/** Is this a real date inside the years the server accepts? (false for an invalid date) */
export const isTaskDate = (d: Date) => d.getTime() >= TASK_DATE_MIN_MS && d.getTime() <= TASK_DATE_MAX_MS;
/** The min and max of a date-time input (the deadline) and of a date input (the start date). */
export const TASK_DATETIME_INPUT_MIN = "2020-01-01T00:00";
export const TASK_DATETIME_INPUT_MAX = "2100-12-31T23:59";
export const TASK_DATE_INPUT_MIN = "2020-01-01";
export const TASK_DATE_INPUT_MAX = "2100-12-31";
export const TASK_DATE_RANGE_MESSAGE = "Choose a date between 2020 and 2100.";

export type Hint = { tone: "warning" | "error" | "info"; text: string };

/**
 * Deadline hints shown under the field (plan §9 "too-short warning", "no past deadline"). A start or deadline outside the
 * years 2020 to 2100 gets no working-days hint (the server refuses such a date, and the inputs stop it).
 */
export function deadlineHints(start: string, deadline: string, size: TaskSize, holidays: string[] = [], rules: SizeRule[] = SIZE_RULES): Hint[] {
  const hints: Hint[] = [];
  if (!deadline) return [{ tone: "error", text: "A deadline is required." }];
  const dl = new Date(deadline);
  if (dl.getTime() < Date.now()) hints.push({ tone: "error", text: "A deadline can't be in the past." });
  const rule = sizeRule(size, rules);
  if (rule.days === null) return hints;
  if (!isTaskDate(dl) || (start && !isTaskDate(new Date(start)))) return hints;
  // The working days AFTER the start day up to the deadline day (the start day itself is never counted, as on the server).
  const given = Math.max(0, workingDaysBetween(start, dl, holidays) - (isWorkingDay(start, holidays) ? 1 : 0));
  if (rule.days > 0 && given < rule.days) {
    hints.push({
      tone: "warning",
      text: `An ${size} task usually needs ${rule.days} working day${rule.days === 1 ? "" : "s"}; you set ${given}. You can continue.`,
    });
  }
  return hints;
}

/**
 * Allowed next statuses for the person acting (plan §9 status flow). Mirrors the server (rules/task-status.ts):
 *  - the person doing the task starts it (also again after rework) and submits it;
 *  - the reviewer picks it up, approves with a rating or sends it back with a reason (never their own task);
 *  - the assigner puts it on hold, resumes it, or cancels any open task (a held one too);
 *  - a personal to-do has no review: its owner starts it, marks it done (approved), reopens it or cancels it.
 */
export function allowedTransitions(task: Task, actor: { empId: string; isAssigner: boolean; isReviewer: boolean }): TaskStatus[] {
  const own = actor.empId === task.assignee;
  const out: TaskStatus[] = [];
  if (task.personal) {
    if (!own) return out;
    if (task.status === "assigned") out.push("in_progress");
    if (task.status === "assigned" || task.status === "in_progress") out.push("approved", "cancelled");
    if (task.status === "approved") out.push("assigned");
    return out;
  }
  switch (task.status) {
    case "assigned":
      if (own) out.push("in_progress");
      break;
    case "in_progress":
      if (own) out.push("submitted");
      break;
    case "rework":
      if (own) out.push("submitted", "in_progress");
      break;
    case "submitted":
      if (actor.isReviewer && !own) out.push("under_review", "approved", "rework");
      break;
    case "under_review":
      if (actor.isReviewer && !own) out.push("approved", "rework");
      break;
    case "on_hold":
      if (actor.isAssigner && !own) out.push("in_progress");
      break;
  }
  if (actor.isAssigner && !own && isOpen(task.status)) {
    if (task.status !== "on_hold") out.push("on_hold");
    out.push("cancelled");
  }
  return out;
}

/**
 * Which server action moves a task from `from` to `to` (POST /tasks/:id/{action}), or null when no single action does.
 * Starting from "on hold" is a resume; a personal to-do is finished with done and brought back with reopen.
 */
export function actionFor(from: TaskStatus, to: TaskStatus, personal: boolean): TaskAction | null {
  if (personal) {
    if (to === "approved") return "done";
    if (to === "assigned" && from === "approved") return "reopen";
    if (to === "in_progress") return "start";
    if (to === "cancelled") return "cancel";
    return null;
  }
  switch (to) {
    case "in_progress":
      return from === "on_hold" ? "resume" : "start";
    case "submitted":
      return "submit";
    case "under_review":
      return "review";
    case "approved":
      return "approve";
    case "rework":
      return "rework";
    case "on_hold":
      return "hold";
    case "cancelled":
      return "cancel";
    default:
      return null;
  }
}

/**
 * Who approved the task: the person on the last history line that moved it to "approved" (oldest first). The reviewer the
 * server reports with the task is "who reviews it now" and changes with stand-ins and with the assigner's return, so it
 * cannot name the person who approved. Null when the history has no such line (the screen then names the assigner).
 */
export function approvedBy(history: StatusChange[]): string | null {
  for (let i = history.length - 1; i >= 0; i--) {
    const h = history[i];
    // Other lines on an approved task (an edit, a stopped repeat) have from = to = approved: they are not the approval.
    if (h.to === "approved" && h.from !== "approved") return h.by === "system" ? null : h.by;
  }
  return null;
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

/** The weekday names a weekly repeat can fall on (1 = Monday). The server also accepts 6 and 7. */
export const WEEKDAY_SHORT = ["", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];

/** "Weekly on Mon" / "Monthly on day 5", with the stop date when there is one. */
export function repeatLabel(r: NonNullable<Task["repeat"]>, formatDay: (iso: string) => string): string {
  const base = r.every === "week" ? `Weekly on ${WEEKDAY_SHORT[r.on] ?? r.on}` : `Monthly on day ${r.on}`;
  const tail = r.active === false ? " (stopped)" : r.until ? `, until ${formatDay(r.until)}` : "";
  return base + tail;
}

/** Files a task or a comment can carry (the server checks again): PDF, PNG, JPEG or .docx, 10 MB. */
export const TASK_FILE_ACCEPT = ".pdf,.png,.jpg,.jpeg,.docx";
export const MAX_TASK_FILE_BYTES = 10 * 1024 * 1024;

/** A sentence when the file is not acceptable, otherwise null. */
export function fileProblem(file: { name: string; size: number }): string | null {
  if (!/\.(pdf|png|jpe?g|docx)$/i.test(file.name)) return "Only PDF, PNG, JPEG and Word (.docx) files can be attached.";
  if (file.size > MAX_TASK_FILE_BYTES) return "A file can be at most 10 MB.";
  if (file.size === 0) return "That file is empty.";
  return null;
}

const HISTORY_KIND_LABEL: Record<NonNullable<StatusChange["kind"]>, string> = {
  created: "Task created",
  status: "",
  deadline_changed: "Deadline changed",
  extension_requested: "Extension requested",
  extension_approved: "Extension approved",
  extension_rejected: "Extension rejected",
  reassigned: "Handed to someone else",
  transferred: "Handed over",
  edited: "Task edited",
  repeat_stopped: "Repeat stopped",
};

/**
 * The title of one history line. Live lines carry a `kind`; the mock history has status changes and plain notes
 * (from = to), so without a kind the old rule applies.
 */
export function historyTitle(h: StatusChange): string {
  if (h.kind) return h.kind === "status" ? STATUS_LABEL[h.to] : HISTORY_KIND_LABEL[h.kind];
  return h.from === h.to ? (h.reason ?? "Updated") : STATUS_LABEL[h.to];
}

/** The detail under a history line: who did it, the reason, and what changed (a deadline or a person, live). */
export function historyMeta(h: StatusChange, who: string, fmt: { when: (iso: string) => string; name: (empId: string) => string }): string {
  const parts = [who];
  const d = h.details ?? {};
  if ((h.kind === "deadline_changed" || h.kind === "extension_approved") && typeof d.fromDeadline === "string" && typeof d.toDeadline === "string") parts.push(`${fmt.when(d.fromDeadline)} → ${fmt.when(d.toDeadline)}`);
  if ((h.kind === "reassigned" || h.kind === "transferred") && typeof d.fromEmpId === "string" && typeof d.toEmpId === "string") parts.push(`${fmt.name(d.fromEmpId)} → ${fmt.name(d.toEmpId)}`);
  const showReason = h.kind ? !!h.reason : !!h.reason && h.from !== h.to;
  if (showReason) parts.push(`“${h.reason}”`);
  return parts.join(" · ");
}
