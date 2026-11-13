import { Injectable, Logger } from '@nestjs/common';
import type { AttendanceMonthResponse, TeamMonthResponse, TeamTodayResponse, TeamTodayState, TodayResponse } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { PermissionService } from '../access/permission.service';
import { ScopeService } from '../access/scope.service';
import { Clock } from '../common/clock';
import { isUniqueViolation, withDbRules } from '../common/db-rules';
import { addDays, dayOf, daysBetween, dbDate, firstDayOfMonth, lastDayOfMonth, monthOf, pkDate, pkInstant, pkMinuteOfDay } from '../common/pakistan-time';
import { JobRunner } from '../jobs/job-runner.service';
import { PrismaService } from '../prisma/prisma.service';
import { averageClock, checkInAllowedFrom, lateMinutesFor } from './attendance-rules';
import { AttendanceDaysService, type EmployeeSpan, type LoadedPeriod } from './attendance-days.service';
import { badRequest, conflict, forbidden, notFound, periodLocked } from './errors';
import { scheduleView, WorkCalendarService } from './work-calendar.service';

export const CLOSE_DAY_JOB = 'attendance.close_day';
const LAST_MINUTE = 23 * 60 + 59;

/**
 * Check-in, check-out, the missed check-out job and the attendance views (plan section 11).
 * The time ALWAYS comes from the server clock; anything the browser sends is ignored.
 */
@Injectable()
export class AttendanceService {
  private readonly logger = new Logger('Attendance');

  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: WorkCalendarService,
    private readonly days: AttendanceDaysService,
    private readonly scope: ScopeService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly jobs: JobRunner,
    private readonly clock: Clock,
  ) {
    this.jobs.register(CLOSE_DAY_JOB, async (payload) => this.closeDay(String(payload.recordId), String(payload.closeAt)));
  }

  today(): string {
    return pkDate(this.clock.now());
  }

  private async officeNetworks(employeeId: string): Promise<string[]> {
    const employee = await this.prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { officeId: true } });
    const rows = await this.prisma.officeNetwork.findMany({ where: { officeId: employee.officeId, archivedAt: null }, select: { cidr: true } });
    return rows.map((r) => r.cidr);
  }

  // ------------------------------------------------------------------ today

  async todayFor(actor: Actor, client: RequestInfo): Promise<TodayResponse> {
    const now = this.clock.now();
    const date = pkDate(now);
    const period = await this.days.load([actor.id], date, date, date);
    const employee = period.employees[0];
    const day = this.days.evaluate(period, employee, date);
    const schedule = period.slice.scheduleOn(date);
    const allowed = checkInAllowedFrom(client.ip, !!schedule?.officeOnlyCheckIn, schedule?.officeOnlyCheckIn ? await this.officeNetworks(actor.id) : []);
    const locked = await this.calendar.isMonthLocked(monthOf(date));
    const hasIn = !!day.record?.checkInAt;
    return {
      empId: actor.empId,
      date,
      serverTime: now.toISOString(),
      workingDay: day.working,
      holiday: day.holiday,
      leave: day.leave ? day.leave.typeName : null,
      schedule: schedule ? scheduleView(schedule) : null,
      checkIn: day.effectiveIn?.toISOString() ?? null,
      checkOut: day.effectiveOut?.toISOString() ?? null,
      lateMinutes: day.lateMinutes,
      missedCheckout: day.missedCheckout,
      status: day.status,
      canCheckIn: day.employed && !hasIn && !locked && allowed,
      canCheckOut: day.employed && !!day.effectiveIn && !day.record?.checkOutAt && !locked,
      checkInAllowedHere: allowed,
    };
  }

  // ------------------------------------------------------------------ check-in / check-out

  async checkIn(actor: Actor, client: RequestInfo): Promise<TodayResponse> {
    const now = this.clock.now();
    const date = pkDate(now);
    const employee = await this.prisma.employee.findUniqueOrThrow({ where: { id: actor.id }, select: { joiningDate: true, lastWorkingDay: true } });
    if (date < dayOf(employee.joiningDate) || (employee.lastWorkingDay && date > dayOf(employee.lastWorkingDay))) {
      throw badRequest('not_employed', 'You can check in only while you work here');
    }
    if (await this.calendar.isMonthLocked(monthOf(date))) throw periodLocked(monthOf(date));
    const slice = await this.calendar.slice(date, date);
    const schedule = slice.scheduleOn(date);
    if (schedule?.officeOnlyCheckIn && !checkInAllowedFrom(client.ip, true, await this.officeNetworks(actor.id))) {
      await this.audit.record({ actorId: actor.id, action: 'attendance.check_in_refused', targetType: 'employee', targetId: actor.empId, outcome: 'denied', reason: 'outside_office_network', details: { date }, ...client });
      throw forbidden('outside_office_network', 'Check-in is only allowed from the office network');
    }
    const working = slice.isWorkingDay(date);
    const late = schedule ? lateMinutesFor(pkMinuteOfDay(now), schedule, working) : 0;

    const existing = await this.prisma.attendanceRecord.findUnique({ where: { employeeId_workDate: { employeeId: actor.id, workDate: dbDate(date) } } });
    if (existing?.checkInAt) throw conflict('already_checked_in', 'You have already checked in today');

    try {
      await withDbRules(() =>
        this.prisma.$transaction(async (tx) => {
          let recordId: string;
          if (existing) {
            // A row made by an approved correction for today (no original check-in yet): the original is filled once.
            const updated = await tx.attendanceRecord.updateMany({
              where: { id: existing.id, checkInAt: null },
              data: { checkInAt: now, checkInIp: client.ip, lateMinutes: existing.correctedCheckInAt ? existing.lateMinutes : late, scheduleId: schedule?.id ?? null, updatedBy: actor.id },
            });
            if (updated.count === 0) throw conflict('already_checked_in', 'You have already checked in today');
            recordId = existing.id;
          } else {
            const created = await tx.attendanceRecord.create({
              data: { employeeId: actor.id, workDate: dbDate(date), checkInAt: now, checkInIp: client.ip, lateMinutes: late, scheduleId: schedule?.id ?? null, createdBy: actor.id },
              select: { id: true },
            });
            recordId = created.id;
          }
          if (schedule) {
            const end = pkInstant(date, schedule.endMinute);
            const closeAt = now.getTime() < end.getTime() ? end : pkInstant(date, LAST_MINUTE);
            await this.jobs.schedule(CLOSE_DAY_JOB, `attendance.close:${recordId}`, closeAt, { recordId, closeAt: closeAt.toISOString() }, actor.id, tx);
          }
          await this.audit.record({ actorId: actor.id, action: 'attendance.checked_in', targetType: 'attendance_record', targetId: recordId, details: { date, lateMinutes: late, workingDay: working }, ...client }, tx);
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('already_checked_in', 'You have already checked in today');
      throw error;
    }
    return this.todayFor(actor, client);
  }

  async checkOut(actor: Actor, client: RequestInfo): Promise<TodayResponse> {
    const now = this.clock.now();
    const date = pkDate(now);
    if (await this.calendar.isMonthLocked(monthOf(date))) throw periodLocked(monthOf(date));
    const record = await this.prisma.attendanceRecord.findUnique({ where: { employeeId_workDate: { employeeId: actor.id, workDate: dbDate(date) } } });
    if (!record || !(record.correctedCheckInAt ?? record.checkInAt)) throw conflict('not_checked_in', 'Check in first');
    if (record.checkOutAt) throw conflict('already_checked_out', 'You have already checked out today');
    const effectiveIn = record.correctedCheckInAt ?? record.checkInAt!;
    const at = now < effectiveIn ? effectiveIn : now;
    await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        const updated = await tx.attendanceRecord.updateMany({ where: { id: record.id, checkOutAt: null }, data: { checkOutAt: at, checkOutIp: client.ip, updatedBy: actor.id } });
        if (updated.count === 0) throw conflict('already_checked_out', 'You have already checked out today');
        await this.audit.record({ actorId: actor.id, action: 'attendance.checked_out', targetType: 'attendance_record', targetId: record.id, details: { date }, ...client }, tx);
      }),
    );
    return this.todayFor(actor, client);
  }

  /**
   * The missed check-out job (plan: "the system closes the day at end of working hours and marks it missed check-out").
   * Safe to run again: it does nothing once there is a check-out, or when the month is locked.
   */
  async closeDay(recordId: string, closeAtIso: string): Promise<void> {
    const record = await this.prisma.attendanceRecord.findUnique({ where: { id: recordId } });
    if (!record || record.checkOutAt || !record.checkInAt) return;
    if (await this.calendar.isMonthLocked(monthOf(dayOf(record.workDate)))) return;
    const closeAt = new Date(closeAtIso);
    const at = closeAt < record.checkInAt ? record.checkInAt : closeAt;
    const updated = await this.prisma.attendanceRecord.updateMany({
      where: { id: recordId, checkOutAt: null },
      data: { checkOutAt: at, missedCheckout: true, autoClosedAt: this.clock.now() },
    });
    if (updated.count > 0) {
      await this.audit.record({ actorId: null, action: 'attendance.auto_closed', targetType: 'attendance_record', targetId: recordId, details: { date: dayOf(record.workDate) } });
      this.logger.log(`Closed attendance day ${dayOf(record.workDate)} (missed check-out)`);
    }
  }

  // ------------------------------------------------------------------ views

  /** One person's month. The route's @Scope already checked the reporting line; another person's month also needs attendance.view_team. */
  async month(actor: Actor, target: { id: string; empId: string }, month: string): Promise<AttendanceMonthResponse> {
    if (target.id !== actor.id && !(await this.permissions.can(actor.id, 'attendance.view_team'))) {
      throw forbidden('forbidden', 'You do not have access to this');
    }
    const from = firstDayOfMonth(month);
    const to = lastDayOfMonth(month);
    const today = this.today();
    const period = await this.days.load([target.id], from, to, today);
    const employee = period.employees[0];
    if (!employee) throw notFound('Employee not found');
    const evals = daysBetween(from, to).map((d) => this.days.evaluate(period, employee, d));
    const totals = { workingDays: 0, present: 0, late: 0, leave: 0, absent: 0, missedCheckouts: 0 };
    for (const d of evals) {
      if (!d.employed) continue;
      if (d.missedCheckout) totals.missedCheckouts++;
      if (!d.working) continue;
      totals.workingDays++;
      if (d.effectiveIn) totals.present++;
      if (d.effectiveIn && d.lateMinutes > 0) totals.late++;
      if (d.leave) totals.leave += d.leave.fraction;
      if (d.status === 'absent') totals.absent++;
    }
    return {
      empId: employee.empId,
      month,
      locked: await this.calendar.isMonthLocked(month),
      days: evals.map((d) => this.days.view(period, employee, d)),
      totals,
    };
  }

  private async peopleBelow(actorId: string, from: string, to: string): Promise<string[]> {
    const rows = await this.prisma.employee.findMany({
      where: {
        ...this.scope.employeeWhere(actorId, 'below'),
        joiningDate: { lte: dbDate(to) },
        OR: [{ lastWorkingDay: null }, { lastWorkingDay: { gte: dbDate(from) } }],
      },
      select: { id: true },
      orderBy: { empId: 'asc' },
    });
    return rows.map((r) => r.id);
  }

  /** Who is in today (or on `date`) among the people below the caller. */
  async teamToday(actor: Actor, date?: string): Promise<TeamTodayResponse> {
    const today = this.today();
    const day = date ?? today;
    if (day > today) throw badRequest('future_date', 'Choose today or a past day');
    const ids = await this.peopleBelow(actor.id, day, day);
    const period = await this.days.load(ids, day, day, today);
    const rows = period.employees.map((e) => {
      const d = this.days.evaluate(period, e, day);
      let state: TeamTodayState;
      if (d.effectiveIn) state = d.effectiveOut ? 'checked_out' : d.lateMinutes > 0 ? 'late' : 'in';
      else if (d.leave) state = 'leave';
      else if (!d.working) state = 'off';
      else state = 'not_in';
      return {
        empId: e.empId,
        name: e.fullName,
        state,
        checkIn: d.effectiveIn?.toISOString() ?? null,
        checkOut: d.effectiveOut?.toISOString() ?? null,
        firstLogin: this.days.firstLogin(period, e.id, day)?.toISOString() ?? null,
        lateMinutes: d.lateMinutes,
        leaveTypeName: d.leave?.typeName ?? null,
      };
    });
    return { date: day, workingDay: period.slice.isWorkingDay(day), rows };
  }

  /** The month table for the people below the caller, with first login next to check-in (plan: gaps are easy to spot). */
  async teamMonth(actor: Actor, month: string): Promise<TeamMonthResponse> {
    const from = firstDayOfMonth(month);
    const to = lastDayOfMonth(month);
    const today = this.today();
    const ids = await this.peopleBelow(actor.id, from, to);
    const period = await this.days.load(ids, from, to, today);
    return {
      month,
      monthWorkingDays: period.slice.workingDayList(from, to).length,
      rows: period.employees.map((e) => this.teamRow(period, e)),
    };
  }

  private teamRow(period: LoadedPeriod, e: EmployeeSpan) {
    const row = { empId: e.empId, name: e.fullName, present: 0, late: 0, leave: 0, absent: 0, missedCheckouts: 0, workingDays: 0, avgCheckIn: null as string | null, avgLoginGapMin: null as number | null };
    const checkIns: number[] = [];
    const gaps: number[] = [];
    const lastCounted = period.to < period.today ? period.to : period.today;
    for (let d = period.from; d <= period.to; d = addDays(d, 1)) {
      const day = this.days.evaluate(period, e, d);
      if (!day.employed) continue;
      if (day.missedCheckout) row.missedCheckouts++;
      if (!day.working) continue;
      if (d <= lastCounted) row.workingDays++;
      if (day.effectiveIn) {
        row.present++;
        checkIns.push(pkMinuteOfDay(day.effectiveIn));
        const login = this.days.firstLogin(period, e.id, d);
        if (login) gaps.push(Math.round((login.getTime() - day.effectiveIn.getTime()) / 60_000));
      }
      if (day.effectiveIn && day.lateMinutes > 0) row.late++;
      if (day.leave) row.leave += day.leave.fraction;
      if (day.status === 'absent') row.absent++;
    }
    row.avgCheckIn = averageClock(checkIns);
    row.avgLoginGapMin = gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null;
    return row;
  }
}
