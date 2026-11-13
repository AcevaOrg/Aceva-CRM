import type { Prisma } from '../generated/prisma/client';
import type { Decimal } from '../common/money';

/**
 * M7 -> M8 integration contract (agreed before implementation; owner: Track A, consumer: Track B).
 * Module 8 talks to Module 7 ONLY through this port, so payroll never re-implements attendance rules.
 * Module 7 never imports anything from Module 8.
 */

export interface AttendanceMonthSummary {
  employeeId: string;
  empId: string;
  /** Working days in the month (weekdays of the schedule, minus holidays), the same number for everyone. */
  workingDays: number;
  /** Working days on which the person checked in (on time or late). */
  presentDays: number;
  /** Working days on which the check-in was late (after start + grace). */
  lateDays: number;
  /** Working days with neither a check-in nor approved leave. Information only: the plan deducts only unpaid leave. */
  absentDays: number;
  /** Days on which the system closed the day because nobody checked out. */
  missedCheckouts: number;
  /** Approved paid leave falling on working days of the month (half days count 0.5). */
  paidLeaveDays: Decimal;
  /** Approved UNPAID leave falling on working days of the month. Payroll deducts base / working days x this. */
  unpaidLeaveDays: Decimal;
}

export abstract class AttendancePayrollPort {
  /** Working days between two Pakistan days (inclusive), from the work schedule and the holiday calendar. */
  abstract workingDays(from: string, to: string): Promise<number>;

  /** True once the month is locked. */
  abstract isMonthLocked(month: string): Promise<boolean>;

  /**
   * Locks the month (plan section 12: "attendance and leave for the month are locked"). Idempotent. After this,
   * attendance, corrections and leave dated in that month are refused (`period_locked`). Runs inside the caller's transaction.
   */
  abstract lockMonth(month: string, actorId: string, tx: Prisma.TransactionClient): Promise<void>;

  /** One summary per requested employee for the month. Pass `tx` to read inside the caller's transaction. */
  abstract monthSummary(month: string, employeeIds: string[], tx?: Prisma.TransactionClient): Promise<AttendanceMonthSummary[]>;
}
