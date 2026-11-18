import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { AuditService } from '../access/audit.service';
import { Clock } from '../common/clock';
import { dec, Decimal, ZERO } from '../common/money';
import { addDays, firstDayOfMonth, lastDayOfMonth, MONTH_PATTERN, pkDate } from '../common/pakistan-time';
import { PrismaService } from '../prisma/prisma.service';
import { AttendanceDaysService } from './attendance-days.service';
import { AttendancePayrollPort, type AttendanceMonthSummary } from './attendance-payroll.port';
import { WorkCalendarService } from './work-calendar.service';

/**
 * The real M7 implementation of the payroll port (Track A). Module 8 reads attendance only through this, so payroll never
 * re-implements attendance rules. The day rules are the same ones the attendance screens use (AttendanceDaysService).
 */
@Injectable()
export class AttendancePayrollAdapter extends AttendancePayrollPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: WorkCalendarService,
    private readonly days: AttendanceDaysService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {
    super();
  }

  async workingDays(from: string, to: string): Promise<number> {
    return this.calendar.workingDays(from, to);
  }

  async isMonthLocked(month: string): Promise<boolean> {
    return this.calendar.isMonthLocked(month);
  }

  async lockMonth(month: string, actorId: string, tx: Prisma.TransactionClient): Promise<void> {
    if (!MONTH_PATTERN.test(month)) throw new Error(`Not a month: ${month}`);
    const created = await tx.attendancePeriod.createMany({ data: [{ month, lockedBy: actorId, lockedAt: this.clock.now() }], skipDuplicates: true });
    if (created.count > 0) {
      await this.audit.record({ actorId, action: 'attendance.month_locked', targetType: 'attendance_period', targetId: month, details: { month } }, tx);
    }
  }

  async monthSummary(month: string, employeeIds: string[], tx?: Prisma.TransactionClient): Promise<AttendanceMonthSummary[]> {
    if (!MONTH_PATTERN.test(month)) throw new Error(`Not a month: ${month}`);
    if (!employeeIds.length) return [];
    const db = tx ?? this.prisma;
    const from = firstDayOfMonth(month);
    const to = lastDayOfMonth(month);
    const period = await this.days.load(employeeIds, from, to, pkDate(this.clock.now()), db, false);
    const monthWorkingDays = period.slice.workingDayList(from, to);
    const byId = new Map(period.employees.map((e) => [e.id, e]));

    return employeeIds
      .filter((id) => byId.has(id))
      .map((id) => {
        const employee = byId.get(id)!;
        let presentDays = 0;
        let lateDays = 0;
        let absentDays = 0;
        let missedCheckouts = 0;
        let paidLeaveDays: Decimal = ZERO;
        let unpaidLeaveDays: Decimal = ZERO;
        for (let d = from; d <= to; d = addDays(d, 1)) {
          const day = this.days.evaluate(period, employee, d);
          if (!day.employed) continue;
          if (day.missedCheckout) missedCheckouts++;
          if (!day.working) continue;
          if (day.effectiveIn) {
            presentDays++;
            if (day.lateMinutes > 0) lateDays++;
          }
          if (day.leave) {
            if (day.leave.paid) paidLeaveDays = paidLeaveDays.plus(dec(day.leave.fraction));
            else unpaidLeaveDays = unpaidLeaveDays.plus(dec(day.leave.fraction));
          } else if (!day.effectiveIn && d < period.today) {
            absentDays++;
          }
        }
        return {
          employeeId: id,
          empId: employee.empId,
          workingDays: monthWorkingDays.length,
          presentDays,
          lateDays,
          absentDays,
          missedCheckouts,
          paidLeaveDays,
          unpaidLeaveDays,
        };
      });
  }
}
