import { Injectable } from '@nestjs/common';
import type { WorkScheduleView } from '@aceva/contracts';
import type { Prisma, WorkSchedule } from '../generated/prisma/client';
import { dayOf, daysBetween, dbDate, firstDayOfMonth, isoWeekday, lastDayOfMonth, monthOf, nextMonth } from '../common/pakistan-time';
import { PrismaService } from '../prisma/prisma.service';
import { clockOf } from './attendance-rules';

export type Db = PrismaService | Prisma.TransactionClient;

/** A loaded slice of the calendar: schedules and active holidays, so a month can be evaluated without one query per day. */
export class CalendarSlice {
  constructor(
    /** Every schedule, oldest first. */
    readonly schedules: WorkSchedule[],
    /** Active (non-archived) holidays by day. */
    readonly holidays: Map<string, string>,
  ) {}

  /** The schedule in force on a day: the latest effective_from <= day. */
  scheduleOn(day: string): WorkSchedule | null {
    let found: WorkSchedule | null = null;
    for (const s of this.schedules) {
      if (dayOf(s.effectiveFrom) <= day) found = s;
      else break;
    }
    return found;
  }

  holiday(day: string): string | null {
    return this.holidays.get(day) ?? null;
  }

  isWeekend(day: string): boolean {
    const s = this.scheduleOn(day);
    return !s || !s.workingWeekdays.includes(isoWeekday(day));
  }

  /** A working day: a weekday of the schedule in force and not an active holiday. */
  isWorkingDay(day: string): boolean {
    return !this.isWeekend(day) && !this.holidays.has(day);
  }

  workingDayList(from: string, to: string): string[] {
    return daysBetween(from, to).filter((d) => this.isWorkingDay(d));
  }
}

export function scheduleView(s: WorkSchedule): WorkScheduleView {
  return {
    id: s.id,
    effectiveFrom: dayOf(s.effectiveFrom),
    start: clockOf(s.startMinute),
    end: clockOf(s.endMinute),
    graceMinutes: s.graceMinutes,
    graceEnd: clockOf(s.startMinute + s.graceMinutes),
    workingWeekdays: [...s.workingWeekdays].sort((a, b) => a - b),
    officeOnlyCheckIn: s.officeOnlyCheckIn,
    note: s.note,
  };
}

/**
 * THE server source of "working day" (plan section 11: the holiday calendar is also used by tasks and payroll).
 * Schedule in force on a day = the latest work_schedules.effective_from <= that day; working day = an ISO weekday of that schedule
 * that is not an active holiday. Every day is a Pakistan day.
 */
@Injectable()
export class WorkCalendarService {
  constructor(private readonly prisma: PrismaService) {}

  /** Loads what is needed to evaluate the days from `from` to `to`. */
  async slice(from: string, to: string, db: Db = this.prisma): Promise<CalendarSlice> {
    const [schedules, holidays] = await Promise.all([
      db.workSchedule.findMany({ orderBy: { effectiveFrom: 'asc' } }),
      db.holiday.findMany({ where: { archivedAt: null, date: { gte: dbDate(from), lte: dbDate(to) } }, select: { date: true, name: true } }),
    ]);
    return new CalendarSlice(schedules, new Map(holidays.map((h) => [dayOf(h.date), h.name])));
  }

  async scheduleOn(day: string, db: Db = this.prisma): Promise<WorkSchedule | null> {
    return db.workSchedule.findFirst({ where: { effectiveFrom: { lte: dbDate(day) } }, orderBy: { effectiveFrom: 'desc' } });
  }

  async isWorkingDay(day: string, db: Db = this.prisma): Promise<boolean> {
    return (await this.slice(day, day, db)).isWorkingDay(day);
  }

  /** Working days between two days, inclusive. */
  async workingDays(from: string, to: string, db: Db = this.prisma): Promise<number> {
    if (to < from) return 0;
    return (await this.slice(from, to, db)).workingDayList(from, to).length;
  }

  async monthSlice(month: string, db: Db = this.prisma): Promise<CalendarSlice> {
    return this.slice(firstDayOfMonth(month), lastDayOfMonth(month), db);
  }

  async isMonthLocked(month: string, db: Db = this.prisma): Promise<boolean> {
    return (await db.attendancePeriod.count({ where: { month } })) > 0;
  }

  /** The locked months among those touched by the days from `from` to `to`. */
  async lockedMonthsIn(from: string, to: string, db: Db = this.prisma): Promise<string[]> {
    const months = new Set<string>();
    for (let d = from; d <= to; d = firstDayOfMonth(nextMonth(monthOf(d)))) months.add(monthOf(d));
    const rows = await db.attendancePeriod.findMany({ where: { month: { in: [...months] } }, select: { month: true } });
    return rows.map((r) => r.month);
  }
}
