import { z } from 'zod';
import { empIdSchema } from './events';
import { clockTimeSchema, daySchema, decisionNoteSchema, decisionReasonSchema, monthSchema } from './shared';

/**
 * Module 7 attendance and leave: request schemas (validated by the server with createZodDto) and response types, shared with the website.
 * Owner: Track A. Other tracks read this file; they never edit it. A breaking change is coordinated through the schema owner.
 *
 * Days are Pakistan calendar days 'YYYY-MM-DD', months 'YYYY-MM', clock times 'HH:MM' Pakistan time, instants ISO 8601 UTC.
 * People are Emp-IDs. Leave day counts are numbers with at most one decimal (half days are 0.5).
 */

// --------------------------------------------------------------------------- queries

export const attendanceMonthQuerySchema = z.object({ month: monthSchema });
export const attendanceDayQuerySchema = z.object({ date: daySchema.optional() });
export const yearQuerySchema = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional() });
export const holidaysQuerySchema = yearQuerySchema.extend({ includeArchived: z.enum(['true', 'false']).optional() });

const listScope = z.enum(['mine', 'team']).default('mine');
const page = z.coerce.number().int().min(1).default(1);
const pageSize = z.coerce.number().int().min(1).max(200).default(50);

export const correctionListQuerySchema = z.object({
  scope: listScope,
  status: z.enum(['pending', 'approved', 'rejected', 'cancelled']).optional(),
  page,
  pageSize,
});
export type CorrectionListQuery = z.infer<typeof correctionListQuerySchema>;

export const leaveRequestListQuerySchema = z.object({
  scope: listScope,
  status: z.enum(['pending', 'pending_manager', 'pending_director', 'approved', 'rejected', 'cancelled']).optional(),
  year: z.coerce.number().int().min(2000).max(2100).optional(),
  page,
  pageSize,
});
export type LeaveRequestListQuery = z.infer<typeof leaveRequestListQuerySchema>;

export const leavePreviewQuerySchema = z.object({
  leaveTypeId: z.uuid(),
  from: daySchema,
  to: daySchema,
  halfDay: z.enum(['true', 'false']).optional(),
});

// --------------------------------------------------------------------------- requests

/** The body of check-in / check-out is ignored: the time always comes from the server clock. */
export const checkInRequestSchema = z.object({}).passthrough();

export const correctionRequestSchema = z
  .object({
    date: daySchema,
    checkIn: clockTimeSchema.optional(),
    checkOut: clockTimeSchema.optional(),
    reason: z.string().trim().min(5, 'Please give a reason (at least 5 characters)').max(500),
  })
  .refine((v) => v.checkIn || v.checkOut, { message: 'Give the check-in time, the check-out time or both', path: ['checkIn'] })
  .refine((v) => !v.checkIn || !v.checkOut || v.checkOut >= v.checkIn, { message: 'Check-out cannot be before check-in', path: ['checkOut'] });
export type CorrectionRequest = z.infer<typeof correctionRequestSchema>;

export const leaveRequestSchema = z
  .object({
    leaveTypeId: z.uuid(),
    from: daySchema,
    to: daySchema,
    halfDay: z.boolean().default(false),
    reason: z.string().trim().min(3, 'Please give a reason').max(500),
  })
  .refine((v) => v.to >= v.from, { message: 'The end date cannot be before the start date', path: ['to'] })
  .refine((v) => !v.halfDay || v.from === v.to, { message: 'A half day is a single day', path: ['halfDay'] });
export type LeaveRequestInput = z.infer<typeof leaveRequestSchema>;

export const approveSchema = decisionNoteSchema;
export const cancelSchema = z.object({ reason: z.string().trim().max(500).optional() });

const weekdaysSchema = z
  .array(z.number().int().min(1).max(7))
  .min(1, 'Choose at least one working day')
  .max(7)
  .refine((v) => new Set(v).size === v.length, 'Each weekday once');

export const workScheduleRequestSchema = z
  .object({
    effectiveFrom: daySchema,
    start: clockTimeSchema,
    end: clockTimeSchema,
    graceMinutes: z.number().int().min(0).max(240),
    workingWeekdays: weekdaysSchema,
    officeOnlyCheckIn: z.boolean().default(false),
    reason: decisionReasonSchema,
  })
  .refine((v) => v.end > v.start, { message: 'Working hours must end after they start', path: ['end'] });
export type WorkScheduleRequest = z.infer<typeof workScheduleRequestSchema>;

export const holidayRequestSchema = z.object({ date: daySchema, name: z.string().trim().min(2).max(120), reason: decisionReasonSchema });
export const holidayRenameSchema = z.object({ name: z.string().trim().min(2).max(120), reason: decisionReasonSchema });
export const archiveSchema = z.object({ reason: decisionReasonSchema });

/** Leave days per year: null = no yearly limit. At most one decimal (half days). */
const leaveDaysValue = z.number().min(0).max(366).refine((v) => Number.isInteger(v * 2), 'Use whole or half days');

export const leaveTypeRequestSchema = z.object({
  key: z.string().trim().regex(/^[a-z][a-z0-9_]{1,30}$/, 'A short lowercase key, e.g. maternity'),
  name: z.string().trim().min(2).max(60),
  yearlyDays: leaveDaysValue.nullable(),
  paid: z.boolean(),
  color: z.string().trim().max(40).optional(),
  reason: decisionReasonSchema,
});
export const leaveTypeUpdateSchema = z.object({
  name: z.string().trim().min(2).max(60).optional(),
  yearlyDays: leaveDaysValue.nullable().optional(),
  paid: z.boolean().optional(),
  color: z.string().trim().max(40).optional(),
  reason: decisionReasonSchema,
});

export const entitlementRequestSchema = z.object({
  empId: empIdSchema,
  leaveTypeId: z.uuid(),
  year: z.number().int().min(2000).max(2100),
  days: leaveDaysValue,
  reason: decisionReasonSchema,
});
export const entitlementQuerySchema = z.object({ year: z.coerce.number().int().min(2000).max(2100).optional(), empId: empIdSchema.optional() });

const ipv4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}(\/(3[0-2]|[12]?\d))?$/;
export const officeNetworkRequestSchema = z.object({
  officeCode: z.string().trim().min(2).max(40),
  cidr: z.string().trim().regex(ipv4, 'An IPv4 address (203.0.113.7) or range (203.0.113.0/24)'),
  label: z.string().trim().max(80).optional(),
  reason: decisionReasonSchema,
});

// --------------------------------------------------------------------------- responses

export type AttendanceDayStatus = 'on_time' | 'late' | 'missed_checkout' | 'absent' | 'leave' | 'holiday' | 'weekend' | 'future';

export interface WorkScheduleView {
  id: string;
  effectiveFrom: string;
  /** 'HH:MM' Pakistan time. */
  start: string;
  end: string;
  graceMinutes: number;
  /** start + grace, 'HH:MM': a check-in at this minute is still on time. */
  graceEnd: string;
  workingWeekdays: number[];
  officeOnlyCheckIn: boolean;
  note: string | null;
}

export interface WorkScheduleResponse {
  /** The schedule in force today (null only if none was ever set). */
  current: WorkScheduleView | null;
  /** Schedules that start after today. */
  upcoming: WorkScheduleView[];
  /** Every schedule, newest first (history is never rewritten). */
  history: WorkScheduleView[];
}

export interface AttendanceRecordTimes {
  checkIn: string | null;
  checkOut: string | null;
}

export interface TodayResponse {
  empId: string;
  date: string;
  serverTime: string;
  workingDay: boolean;
  holiday: string | null;
  /** Approved leave today (type name), if any. */
  leave: string | null;
  schedule: WorkScheduleView | null;
  /** Effective times (corrected where a correction was approved). */
  checkIn: string | null;
  checkOut: string | null;
  lateMinutes: number;
  missedCheckout: boolean;
  status: AttendanceDayStatus;
  canCheckIn: boolean;
  canCheckOut: boolean;
  /** False when office-only check-in is on and this connection is not one of the person's office networks. */
  checkInAllowedHere: boolean;
}

export interface AttendanceDayView {
  empId: string;
  date: string;
  status: AttendanceDayStatus;
  /** Effective times (an approved correction replaces the original here). */
  checkIn: string | null;
  checkOut: string | null;
  /** The original server times, present only when a correction changed them. The original is always kept. */
  original: AttendanceRecordTimes | null;
  lateMinutes: number;
  missedCheckout: boolean;
  /** First login that Pakistan day (from the login sessions, Module 2). */
  firstLogin: string | null;
  /** The latest correction for this day, if any. */
  correctionId: string | null;
  correctionStatus: 'pending' | 'approved' | 'rejected' | 'cancelled' | null;
  /** Holiday name, leave type, "Half day", "Not employed"... */
  note: string | null;
}

export interface AttendanceMonthResponse {
  empId: string;
  month: string;
  locked: boolean;
  days: AttendanceDayView[];
  totals: { workingDays: number; present: number; late: number; leave: number; absent: number; missedCheckouts: number };
}

export type TeamTodayState = 'in' | 'late' | 'not_in' | 'leave' | 'checked_out' | 'off';

export interface TeamTodayRowView {
  empId: string;
  name: string;
  state: TeamTodayState;
  checkIn: string | null;
  checkOut: string | null;
  firstLogin: string | null;
  lateMinutes: number;
  leaveTypeName: string | null;
}

export interface TeamTodayResponse {
  date: string;
  workingDay: boolean;
  rows: TeamTodayRowView[];
}

export interface TeamMonthRowView {
  empId: string;
  name: string;
  present: number;
  late: number;
  /** Approved leave on working days (half days 0.5). */
  leave: number;
  absent: number;
  missedCheckouts: number;
  /** Working days of the month so far (up to today) within the person's employment. */
  workingDays: number;
  /** Average check-in 'HH:MM' Pakistan time. */
  avgCheckIn: string | null;
  /** Average minutes from check-in to first login (positive = login after check-in). */
  avgLoginGapMin: number | null;
}

export interface TeamMonthResponse {
  month: string;
  /** Working days in the whole month. */
  monthWorkingDays: number;
  rows: TeamMonthRowView[];
}

export interface CorrectionView {
  id: string;
  empId: string;
  name: string;
  date: string;
  original: AttendanceRecordTimes;
  requested: AttendanceRecordTimes;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  createdAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionNote: string | null;
  /** For a pending correction: who must decide now (Module 1 routing). */
  approverEmpId: string | null;
  /** True when the caller is that approver. */
  canDecide: boolean;
}

export interface LeaveTypeView {
  id: string;
  key: string;
  name: string;
  /** Null = no yearly limit. */
  yearlyDays: number | null;
  paid: boolean;
  color: string | null;
  archived: boolean;
}

export interface LeaveBalanceItem {
  leaveTypeId: string;
  key: string;
  name: string;
  paid: boolean;
  color: string | null;
  /** The entitlement for the year (null = no limit). */
  total: number | null;
  /** True when the entitlement comes from a personal override. */
  overridden: boolean;
  used: number;
  pending: number;
  /** total - used - pending (null = no limit). */
  remaining: number | null;
}

export interface LeaveBalancesResponse {
  empId: string;
  year: number;
  balances: LeaveBalanceItem[];
}

export type LeaveStatusValue = 'pending_manager' | 'pending_director' | 'approved' | 'rejected' | 'cancelled';
export type LeaveStepState = 'done' | 'waiting' | 'pending' | 'skipped' | 'rejected';

export interface LeaveChainStep {
  step: number;
  /** "Manager", "Director", or "Cancelled". */
  label: string;
  /** The person who decided (done/rejected) or who must decide now / next (waiting/pending). */
  approverEmpId: string | null;
  approverName: string | null;
  state: LeaveStepState;
  /** 'manager' | 'stand_in' | 'self' (cancellation). */
  via: string | null;
  at: string | null;
  note: string | null;
}

export interface LeaveRequestView {
  id: string;
  number: string;
  empId: string;
  name: string;
  leaveTypeId: string;
  leaveTypeName: string;
  paid: boolean;
  from: string;
  to: string;
  days: number;
  halfDay: boolean;
  reason: string;
  status: LeaveStatusValue;
  createdAt: string;
  chain: LeaveChainStep[];
  /** True when the caller must decide the current step. */
  canDecide: boolean;
  /** True when the caller (the requester) may cancel it now. */
  canCancel: boolean;
}

export interface LeavePreviewResponse {
  days: number;
  /** Remaining before this request (null = no limit). */
  remaining: number | null;
  /** Remaining after this request (null = no limit). */
  remainingAfter: number | null;
  firstApproverEmpId: string | null;
  needsDirector: boolean;
  /** Who would decide, step by step, if the request were sent now (Module 1 routing: stand-ins and leavers included). */
  chain: LeaveChainStep[];
}

export interface LeaveCalendarEntryView {
  requestId: string;
  number: string;
  empId: string;
  name: string;
  leaveTypeId: string;
  leaveTypeName: string;
  from: string;
  to: string;
  days: number;
  halfDay: boolean;
  status: LeaveStatusValue;
}

export interface HolidayView {
  id: string;
  date: string;
  name: string;
  archived: boolean;
}

export interface EntitlementView {
  id: string;
  empId: string;
  leaveTypeId: string;
  year: number;
  days: number;
  reason: string;
}

export interface OfficeNetworkView {
  id: string;
  officeCode: string;
  officeName: string;
  cidr: string;
  label: string | null;
  archived: boolean;
}
