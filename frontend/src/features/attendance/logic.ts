/**
 * Pure attendance and leave rules (plan §11). Mirrored on the server; unit-test these.
 */
import { addDays, startOfDay } from "date-fns";
import { isoDay, isWorkingDay } from "@/lib/dates";
import { ROLE_LABEL } from "@/lib/auth/permissions";
import type { BadgeTone } from "@/components/ui/badge";
import type { ApprovalStep, Employee } from "@/types";
import { isTopLevelRole } from "@/types";
import type { DayStatus, LeaveStatus, WorkSchedule } from "./types";

/**
 * Who approves a leave request (plan §11, Aceva structure CEO / Founder / Owner → Director → CTO, Sales, Finance → Development):
 *   1. the person's manager: Development → CTO; CTO, Sales and Finance → Director; Director → CEO / Founder / Owner;
 *   2. then the Director, when that first step was not the Director (so Development goes CTO → Director).
 * The CEO / Founder / Owner approves nothing else: the Director's own leave is the only CEO sign-off.
 * Maker-checker: nobody approves their own leave. If the manager has left, the request goes one level up.
 * The CEO / Founder / Owner has no one above, so their chain is empty and the leave is recorded straight away.
 * Returns steps in "pending" state; callers set the states.
 */
export function buildLeaveChain(empId: string, employees: Employee[]): ApprovalStep[] {
  const find = (id?: string | null) => (id ? employees.find((e) => e.empId === id) : undefined);
  const emp = find(empId);
  if (!emp) return [];
  let manager = find(emp.reportsTo);
  while (manager && (manager.status === "left" || manager.empId === empId)) manager = find(manager.reportsTo);
  if (!manager) return [];
  const steps: ApprovalStep[] = [{ label: ROLE_LABEL[manager.role], empId: manager.empId, state: "pending" }];
  // The Director gives the final sign-off, unless the Director is the first step or the CEO / Founder / Owner is
  // (that only happens for the Director's own leave).
  const director = employees.find((e) => e.role === "director" && e.status !== "left");
  const needsDirector = manager.role !== "director" && !isTopLevelRole(manager.role);
  if (director && needsDirector && director.empId !== empId && director.empId !== manager.empId) {
    steps.push({ label: ROLE_LABEL.director, empId: director.empId, state: "pending" });
  }
  return steps;
}

/**
 * Who approves this person's attendance corrections: their manager, one level further up if the manager
 * has left (so the Director's own correction goes to the CEO / Founder / Owner). Null for the
 * CEO / Founder / Owner, who has no one above (and nobody approves their own correction).
 */
export function correctionApprover(empId: string, employees: Employee[]): Employee | null {
  const find = (id?: string | null) => (id ? employees.find((e) => e.empId === id) : undefined);
  let manager = find(find(empId)?.reportsTo);
  while (manager && manager.status === "left") manager = find(manager.reportsTo);
  return manager && manager.empId !== empId ? manager : null;
}

/** "Hamza Qureshi (CEO / Founder / Owner)" style label for an approver. */
export function approverLabel(e: Employee | null | undefined) {
  return e ? `${e.name} (${ROLE_LABEL[e.role]})` : "their manager";
}

export const DEFAULT_SCHEDULE: WorkSchedule = {
  startHour: 9,
  startMinute: 0,
  graceMinutes: 15,
  endHour: 18,
  workingDays: [1, 2, 3, 4, 5],
  officeOnlyCheckIn: false,
};

/** Minutes late after start + grace (0 = on time). */
export function lateMinutes(checkIn: string | Date, s: WorkSchedule = DEFAULT_SCHEDULE) {
  const d = new Date(checkIn);
  const limit = new Date(d);
  limit.setHours(s.startHour, s.startMinute + s.graceMinutes, 0, 0);
  return Math.max(0, Math.round((d.getTime() - limit.getTime()) / 60_000));
}

/** "09:15" for the schedule. */
export function graceEndLabel(s: WorkSchedule = DEFAULT_SCHEDULE) {
  const total = s.startHour * 60 + s.startMinute + s.graceMinutes;
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}`;
}

/** Working days in a leave range, skipping weekends and holidays. Half day = 0.5. */
export function leaveDays(from: string, to: string, holidays: string[], halfDay = false) {
  if (!from || !to) return 0;
  let d = startOfDay(new Date(from));
  const end = startOfDay(new Date(to));
  if (end < d) return 0;
  let n = 0;
  while (d <= end) {
    if (isWorkingDay(d, holidays)) n++;
    d = addDays(d, 1);
  }
  if (halfDay && n === 1) return 0.5;
  return n;
}

/** Every ISO day in [from, to]. */
export function daysInRange(from: string, to: string) {
  const out: string[] = [];
  let d = startOfDay(new Date(from));
  const end = startOfDay(new Date(to));
  while (d <= end) {
    out.push(isoDay(d));
    d = addDays(d, 1);
  }
  return out;
}

export const DAY_STATUS: Record<DayStatus, { label: string; tone: BadgeTone; color: string }> = {
  on_time: { label: "On time", tone: "success", color: "var(--success)" },
  late: { label: "Late", tone: "warning", color: "var(--warning)" },
  missed_checkout: { label: "Missed check-out", tone: "info", color: "var(--info)" },
  absent: { label: "Absent", tone: "danger", color: "var(--danger)" },
  leave: { label: "Leave", tone: "finance", color: "var(--zone-finance)" },
  holiday: { label: "Holiday", tone: "signal", color: "var(--signal)" },
  weekend: { label: "Weekend", tone: "outline", color: "var(--muted-foreground)" },
  future: { label: "—", tone: "outline", color: "transparent" },
};

export const LEAVE_STATUS: Record<LeaveStatus, { label: string; tone: BadgeTone }> = {
  pending_manager: { label: "Waiting for manager", tone: "warning" },
  pending_director: { label: "Waiting for Director", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "outline" },
};

export const isPendingLeave = (s: LeaveStatus) => s === "pending_manager" || s === "pending_director";

/** Status label that names the approver it is waiting for ("Waiting for CTO", "Waiting for CEO / Founder / Owner"). */
export function leaveStatusLabel(r: { status: LeaveStatus; chain: ApprovalStep[] }) {
  const waiting = isPendingLeave(r.status) ? r.chain.find((s) => s.state === "waiting") : undefined;
  return waiting ? `Waiting for ${waiting.label}` : LEAVE_STATUS[r.status].label;
}

/** Minutes between two ISO times (b − a). */
export function minutesBetween(a?: string, b?: string) {
  if (!a || !b) return null;
  return Math.round((new Date(b).getTime() - new Date(a).getTime()) / 60_000);
}

/** Average clock time ("08:57") of a list of ISO times. */
export function averageClock(times: string[]) {
  if (!times.length) return null;
  const mins = times.map((t) => {
    const d = new Date(t);
    return d.getHours() * 60 + d.getMinutes();
  });
  const avg = Math.round(mins.reduce((a, b) => a + b, 0) / mins.length);
  return `${String(Math.floor(avg / 60)).padStart(2, "0")}:${String(avg % 60).padStart(2, "0")}`;
}
