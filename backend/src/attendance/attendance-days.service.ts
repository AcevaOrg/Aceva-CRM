import { Injectable } from '@nestjs/common';
import type { AttendanceDayStatus, AttendanceDayView } from '@aceva/contracts';
import type { AttendanceRecord } from '../generated/prisma/client';
import { addDays, dayOf, daysBetween, dbDate, pkDate, pkInstant } from '../common/pakistan-time';
import { PrismaService } from '../prisma/prisma.service';
import { CalendarSlice, type Db, WorkCalendarService } from './work-calendar.service';

export interface EmployeeSpan {
  id: string;
  empId: string;
  fullName: string;
  joiningDate: string;
  lastWorkingDay: string | null;
}

export interface DayLeave {
  requestId: string;
  typeName: string;
  paid: boolean;
  halfDay: boolean;
  /** 1, or 0.5 for a half day. */
  fraction: number;
}

export interface DayEval {
  date: string;
  employed: boolean;
  working: boolean;
  weekend: boolean;
  holiday: string | null;
  record: AttendanceRecord | null;
  effectiveIn: Date | null;
  effectiveOut: Date | null;
  lateMinutes: number;
  /** The system closed the day and no correction replaced the check-out. */
  missedCheckout: boolean;
  /** Approved leave on this day (only on working days). */
  leave: DayLeave | null;
  status: AttendanceDayStatus;
  note: string | null;
}

export interface LoadedPeriod {
  from: string;
  to: string;
  today: string;
  slice: CalendarSlice;
  employees: EmployeeSpan[];
  records: Map<string, AttendanceRecord>;
  /** Approved leave by employee id and day. */
  leaves: Map<string, DayLeave>;
  /** Earliest session start by employee id and day. */
  firstLogins: Map<string, Date>;
  /** Latest correction by employee id and day. */
  corrections: Map<string, { id: string; status: 'pending' | 'approved' | 'rejected' | 'cancelled' }>;
}

const key = (employeeId: string, day: string) => `${employeeId}|${day}`;

/**
 * Reads everything needed to evaluate attendance for some people over some days, and evaluates each day the same way for the
 * month view, the team boards and the payroll port, so the numbers always agree.
 */
@Injectable()
export class AttendanceDaysService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: WorkCalendarService,
  ) {}

  async load(employeeIds: string[], from: string, to: string, today: string, db: Db = this.prisma, extras = true): Promise<LoadedPeriod> {
    const [slice, people, records, leaves, sessions, corrections] = await Promise.all([
      this.calendar.slice(from, to, db),
      db.employee.findMany({
        where: { id: { in: employeeIds } },
        select: { id: true, empId: true, fullName: true, joiningDate: true, lastWorkingDay: true },
        orderBy: { empId: 'asc' },
      }),
      db.attendanceRecord.findMany({ where: { employeeId: { in: employeeIds }, workDate: { gte: dbDate(from), lte: dbDate(to) } } }),
      db.leaveRequest.findMany({
        where: { employeeId: { in: employeeIds }, status: 'approved', fromDate: { lte: dbDate(to) }, toDate: { gte: dbDate(from) } },
        select: { id: true, employeeId: true, fromDate: true, toDate: true, halfDay: true, leaveType: { select: { name: true, paid: true } } },
      }),
      extras
        ? db.session.findMany({
            where: { employeeId: { in: employeeIds }, createdAt: { gte: pkInstant(from), lt: pkInstant(addDays(to, 1)) } },
            select: { employeeId: true, createdAt: true },
          })
        : Promise.resolve([]),
      extras
        ? db.attendanceCorrection.findMany({
            where: { employeeId: { in: employeeIds }, workDate: { gte: dbDate(from), lte: dbDate(to) } },
            select: { id: true, employeeId: true, workDate: true, status: true, createdAt: true },
            orderBy: { createdAt: 'asc' },
          })
        : Promise.resolve([]),
    ]);

    const period: LoadedPeriod = {
      from,
      to,
      today,
      slice,
      employees: people.map((p) => ({
        id: p.id,
        empId: p.empId,
        fullName: p.fullName,
        joiningDate: dayOf(p.joiningDate),
        lastWorkingDay: p.lastWorkingDay ? dayOf(p.lastWorkingDay) : null,
      })),
      records: new Map(records.map((r) => [key(r.employeeId, dayOf(r.workDate)), r])),
      leaves: new Map(),
      firstLogins: new Map(),
      corrections: new Map(),
    };
    for (const l of leaves) {
      const start = dayOf(l.fromDate) < from ? from : dayOf(l.fromDate);
      const end = dayOf(l.toDate) > to ? to : dayOf(l.toDate);
      for (const d of daysBetween(start, end)) {
        if (!slice.isWorkingDay(d)) continue;
        period.leaves.set(key(l.employeeId, d), { requestId: l.id, typeName: l.leaveType.name, paid: l.leaveType.paid, halfDay: l.halfDay, fraction: l.halfDay ? 0.5 : 1 });
      }
    }
    for (const s of sessions) {
      const k = key(s.employeeId, pkDate(s.createdAt));
      const seen = period.firstLogins.get(k);
      if (!seen || s.createdAt < seen) period.firstLogins.set(k, s.createdAt);
    }
    for (const c of corrections) period.corrections.set(key(c.employeeId, dayOf(c.workDate)), { id: c.id, status: c.status });
    return period;
  }

  /** One day of one person. */
  evaluate(period: LoadedPeriod, employee: EmployeeSpan, date: string): DayEval {
    const { slice, today } = period;
    const working = slice.isWorkingDay(date);
    const weekend = slice.isWeekend(date);
    const holiday = slice.holiday(date);
    const employed = date >= employee.joiningDate && (!employee.lastWorkingDay || date <= employee.lastWorkingDay);
    const record = employed ? (period.records.get(key(employee.id, date)) ?? null) : null;
    const leave = employed ? (period.leaves.get(key(employee.id, date)) ?? null) : null;
    const effectiveIn = record ? (record.correctedCheckInAt ?? record.checkInAt) : null;
    const effectiveOut = record ? (record.correctedCheckOutAt ?? record.checkOutAt) : null;
    const missedCheckout = !!record && record.missedCheckout && !record.correctedCheckOutAt;
    const lateMinutes = effectiveIn && working ? record!.lateMinutes : 0;

    let status: AttendanceDayStatus;
    let note: string | null = holiday;
    if (!employed) {
      status = 'future';
      note = date < employee.joiningDate ? 'Not yet joined' : 'Left the company';
    } else if (effectiveIn) {
      status = missedCheckout ? 'missed_checkout' : lateMinutes > 0 ? 'late' : 'on_time';
      if (leave) note = leave.halfDay ? `${leave.typeName} (half day)` : leave.typeName;
      else if (!working) note = holiday ?? 'Weekend';
    } else if (leave) {
      status = 'leave';
      note = leave.halfDay ? `${leave.typeName} (half day)` : leave.typeName;
    } else if (holiday) {
      status = 'holiday';
    } else if (!working) {
      status = 'weekend';
    } else if (date >= today) {
      status = 'future';
    } else {
      status = 'absent';
    }
    return { date, employed, working, weekend, holiday, record, effectiveIn, effectiveOut, lateMinutes, missedCheckout, leave, status, note };
  }

  view(period: LoadedPeriod, employee: EmployeeSpan, day: DayEval): AttendanceDayView {
    const r = day.record;
    const corrected = !!r && (r.correctedCheckInAt !== null || r.correctedCheckOutAt !== null);
    const correction = period.corrections.get(key(employee.id, day.date)) ?? null;
    return {
      empId: employee.empId,
      date: day.date,
      status: day.status,
      checkIn: day.effectiveIn?.toISOString() ?? null,
      checkOut: day.effectiveOut?.toISOString() ?? null,
      original: corrected ? { checkIn: r!.checkInAt?.toISOString() ?? null, checkOut: r!.checkOutAt?.toISOString() ?? null } : null,
      lateMinutes: day.lateMinutes,
      missedCheckout: day.missedCheckout,
      firstLogin: period.firstLogins.get(key(employee.id, day.date))?.toISOString() ?? null,
      correctionId: correction?.id ?? null,
      correctionStatus: correction?.status ?? null,
      note: day.note,
    };
  }

  firstLogin(period: LoadedPeriod, employeeId: string, day: string): Date | null {
    return period.firstLogins.get(key(employeeId, day)) ?? null;
  }
}
