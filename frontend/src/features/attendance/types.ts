/**
 * Module 7 · Attendance and leave (plan §11)
 * Built by: Developer A (cycle 3). Spec §9.7.
 * API contract for the module.
 */
import type { ApprovalStep } from "@/types";

export type DayStatus = "on_time" | "late" | "missed_checkout" | "absent" | "leave" | "holiday" | "weekend" | "future";

export interface AttendanceDay {
  empId: string;
  /** ISO day, e.g. 2026-11-09 */
  date: string;
  checkIn?: string;
  checkOut?: string;
  status: DayStatus;
  lateMinutes?: number;
  /** First login that day, from Module 4 (activity tracking). */
  firstLogin?: string;
  correctionId?: string;
  /** Name of the holiday or leave type when relevant. */
  note?: string;
}

export interface AttendanceCorrection {
  id: string;
  empId: string;
  date: string;
  original: { checkIn?: string; checkOut?: string };
  requested: { checkIn?: string; checkOut?: string };
  reason: string;
  status: "pending" | "approved" | "rejected";
  decidedBy?: string;
  decidedAt?: string;
  decisionNote?: string;
  at: string;
}

export interface LeaveType {
  id: string;
  name: string;
  /** 0 = no yearly limit (unpaid). */
  yearlyDays: number;
  paid: boolean;
  /** CSS colour, e.g. "var(--chart-1)". */
  color: string;
}

export interface LeaveBalance {
  leaveTypeId: string;
  total: number;
  used: number;
  pending: number;
}

/** Balance joined with its leave type, ready for display. */
export interface LeaveBalanceView extends LeaveBalance {
  leaveType: LeaveType;
  /** null when the type has no yearly limit. */
  remaining: number | null;
}

/**
 * pending_manager: waiting for the person's manager (first step: the CTO for Engineering, the Director for the CTO,
 *   Sales and Finance, the CEO / Founder / Owner only for the Director's own leave).
 * pending_director: the CTO approved an engineer's leave and it now waits for the Director (second step).
 */
export type LeaveStatus = "pending_manager" | "pending_director" | "approved" | "rejected" | "cancelled";

export interface LeaveRequest {
  id: string;
  number: string;
  empId: string;
  leaveTypeId: string;
  from: string;
  to: string;
  days: number;
  halfDay?: boolean;
  reason: string;
  status: LeaveStatus;
  chain: ApprovalStep[];
  at: string;
}

export interface Holiday {
  date: string;
  name: string;
}

export interface WorkSchedule {
  startHour: number;
  startMinute: number;
  graceMinutes: number;
  endHour: number;
  workingDays: number[];
  officeOnlyCheckIn: boolean;
}

export type TodayState = "in" | "late" | "not_in" | "leave" | "checked_out" | "off";

export interface TeamTodayRow {
  empId: string;
  state: TodayState;
  checkIn?: string;
  checkOut?: string;
  firstLogin?: string;
  lateMinutes?: number;
  leaveTypeName?: string;
}

export interface TeamMonthRow {
  empId: string;
  present: number;
  late: number;
  leave: number;
  absent: number;
  missedCheckout: number;
  workingDays: number;
  /** Average minutes between check-in and first login (positive = login after check-in). */
  avgLoginGapMin: number | null;
  avgCheckIn: string | null;
}

export interface LeaveCalendarEntry {
  requestId: string;
  empId: string;
  /** "" when the viewer may only see that the person is away (a teammate or their manager, not in their scope). */
  leaveTypeId: string;
  from: string;
  to: string;
  status: LeaveStatus;
  /** Task deadlines that fall inside this leave (plan §11). */
  deadlineClashes: { taskId: string; number: string; title: string; deadline: string }[];
}

export interface NewLeaveInput {
  leaveTypeId: string;
  from: string;
  to: string;
  halfDay: boolean;
  reason: string;
}

export interface NewCorrectionInput {
  date: string;
  checkIn?: string;
  checkOut?: string;
  reason: string;
}
