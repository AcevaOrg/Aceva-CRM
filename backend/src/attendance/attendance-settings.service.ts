import { Injectable } from '@nestjs/common';
import type {
  EntitlementView, HolidayView, LeaveTypeView, OfficeNetworkView, WorkScheduleRequest, WorkScheduleResponse,
  entitlementRequestSchema, leaveTypeRequestSchema, leaveTypeUpdateSchema, officeNetworkRequestSchema,
} from '@aceva/contracts';
import type { z } from 'zod';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { ScopeService } from '../access/scope.service';
import { Clock } from '../common/clock';
import { isUniqueViolation } from '../common/db-rules';
import { dec } from '../common/money';
import { dayOf, dbDate, monthOf, pkDate } from '../common/pakistan-time';
import type { Holiday } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { minuteOf } from './attendance-rules';
import { badRequest, conflict, forbidden, notFound, periodLocked } from './errors';
import { leaveTypeView } from './leave.service';
import { scheduleView, WorkCalendarService } from './work-calendar.service';

const holidayView = (h: Holiday): HolidayView => ({ id: h.id, date: dayOf(h.date), name: h.name, archived: h.archivedAt !== null });

/**
 * Module 7 settings (plan section 11 and the settings list in section 17): working days and hours, grace period, office-only
 * check-in and office networks, the holiday calendar, leave types and personal leave entitlements. Director (`settings.manage`).
 * Every change is audited with its reason. History is never rewritten: a schedule change is a new row from a day that has not
 * passed yet, and holidays are archived, never deleted.
 */
@Injectable()
export class AttendanceSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: WorkCalendarService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private today(): string {
    return pkDate(this.clock.now());
  }

  // ------------------------------------------------------------------ work schedule

  async workSchedule(): Promise<WorkScheduleResponse> {
    const today = this.today();
    const rows = await this.prisma.workSchedule.findMany({ orderBy: { effectiveFrom: 'desc' } });
    const current = rows.find((r) => dayOf(r.effectiveFrom) <= today) ?? null;
    return {
      current: current ? scheduleView(current) : null,
      upcoming: rows.filter((r) => dayOf(r.effectiveFrom) > today).reverse().map(scheduleView),
      history: rows.map(scheduleView),
    };
  }

  async createSchedule(actor: Actor, dto: WorkScheduleRequest, client: RequestInfo): Promise<WorkScheduleResponse> {
    if (dto.effectiveFrom < this.today()) throw badRequest('past_effective_date', 'A new schedule starts today or later; past days keep the schedule they had');
    const startMinute = minuteOf(dto.start);
    const endMinute = minuteOf(dto.end);
    if (dto.graceMinutes >= endMinute - startMinute) throw badRequest('invalid_schedule', 'The grace period must be shorter than the working hours');
    if (await this.calendar.isMonthLocked(monthOf(dto.effectiveFrom))) throw periodLocked(monthOf(dto.effectiveFrom));
    const exists = await this.prisma.workSchedule.count({ where: { effectiveFrom: dbDate(dto.effectiveFrom) } });
    if (exists) throw conflict('schedule_exists', 'A schedule already starts on that day; choose another day');
    try {
      await this.prisma.$transaction(async (tx) => {
        const created = await tx.workSchedule.create({
          data: {
            effectiveFrom: dbDate(dto.effectiveFrom),
            startMinute,
            endMinute,
            graceMinutes: dto.graceMinutes,
            workingWeekdays: [...dto.workingWeekdays].sort((a, b) => a - b),
            officeOnlyCheckIn: dto.officeOnlyCheckIn,
            note: dto.reason,
            createdBy: actor.id,
          },
        });
        await this.audit.record({ actorId: actor.id, action: 'settings.work_schedule.created', targetType: 'work_schedule', targetId: created.id, reason: dto.reason, details: { effectiveFrom: dto.effectiveFrom, start: dto.start, end: dto.end, graceMinutes: dto.graceMinutes, workingWeekdays: dto.workingWeekdays, officeOnlyCheckIn: dto.officeOnlyCheckIn }, ...client }, tx);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('schedule_exists', 'A schedule already starts on that day; choose another day');
      throw error;
    }
    return this.workSchedule();
  }

  // ------------------------------------------------------------------ holidays

  async holidays(year: number | undefined, includeArchived: boolean): Promise<HolidayView[]> {
    const y = year ?? Number(this.today().slice(0, 4));
    const rows = await this.prisma.holiday.findMany({
      where: { date: { gte: dbDate(`${y}-01-01`), lte: dbDate(`${y}-12-31`) }, ...(includeArchived ? {} : { archivedAt: null }) },
      orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map(holidayView);
  }

  private async assertOpen(day: string) {
    if (await this.calendar.isMonthLocked(monthOf(day))) throw periodLocked(monthOf(day));
  }

  async createHoliday(actor: Actor, dto: { date: string; name: string; reason: string }, client: RequestInfo): Promise<HolidayView> {
    await this.assertOpen(dto.date);
    const exists = await this.prisma.holiday.count({ where: { date: dbDate(dto.date), archivedAt: null } });
    if (exists) throw conflict('holiday_exists', 'There is already a holiday on that day');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.holiday.create({ data: { date: dbDate(dto.date), name: dto.name, createdBy: actor.id } });
        await this.audit.record({ actorId: actor.id, action: 'settings.holiday.created', targetType: 'holiday', targetId: created.id, reason: dto.reason, details: { date: dto.date, name: dto.name }, ...client }, tx);
        return holidayView(created);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('holiday_exists', 'There is already a holiday on that day');
      throw error;
    }
  }

  async renameHoliday(actor: Actor, id: string, dto: { name: string; reason: string }, client: RequestInfo): Promise<HolidayView> {
    const row = await this.prisma.holiday.findUnique({ where: { id } });
    if (!row || row.archivedAt) throw notFound('Holiday not found');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.holiday.update({ where: { id }, data: { name: dto.name, updatedBy: actor.id } });
      await this.audit.record({ actorId: actor.id, action: 'settings.holiday.renamed', targetType: 'holiday', targetId: id, reason: dto.reason, details: { date: dayOf(row.date), from: row.name, to: dto.name }, ...client }, tx);
      return holidayView(updated);
    });
  }

  async archiveHoliday(actor: Actor, id: string, reason: string, client: RequestInfo): Promise<HolidayView> {
    const row = await this.prisma.holiday.findUnique({ where: { id } });
    if (!row) throw notFound('Holiday not found');
    if (row.archivedAt) throw conflict('invalid_transition', 'This holiday is already archived');
    await this.assertOpen(dayOf(row.date));
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.holiday.update({ where: { id }, data: { archivedAt: this.clock.now(), updatedBy: actor.id } });
      await this.audit.record({ actorId: actor.id, action: 'settings.holiday.archived', targetType: 'holiday', targetId: id, reason, details: { date: dayOf(row.date), name: row.name }, ...client }, tx);
      return holidayView(updated);
    });
  }

  // ------------------------------------------------------------------ leave types

  async createLeaveType(actor: Actor, dto: z.infer<typeof leaveTypeRequestSchema>, client: RequestInfo): Promise<LeaveTypeView> {
    if (await this.prisma.leaveType.count({ where: { key: dto.key } })) throw conflict('leave_type_exists', 'A leave type with that key exists');
    try {
      return await this.prisma.$transaction(async (tx) => {
        const created = await tx.leaveType.create({ data: { key: dto.key, name: dto.name, yearlyDays: dto.yearlyDays === null ? null : dec(dto.yearlyDays), paid: dto.paid, color: dto.color ?? null, createdBy: actor.id } });
        await this.audit.record({ actorId: actor.id, action: 'settings.leave_type.created', targetType: 'leave_type', targetId: created.key, reason: dto.reason, details: { name: dto.name, yearlyDays: dto.yearlyDays, paid: dto.paid }, ...client }, tx);
        return leaveTypeView(created);
      });
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('leave_type_exists', 'A leave type with that key exists');
      throw error;
    }
  }

  async updateLeaveType(actor: Actor, id: string, dto: z.infer<typeof leaveTypeUpdateSchema>, client: RequestInfo): Promise<LeaveTypeView> {
    const row = await this.prisma.leaveType.findUnique({ where: { id } });
    if (!row) throw notFound('Leave type not found');
    if (row.archivedAt) throw conflict('invalid_transition', 'This leave type is archived');
    // Paid or unpaid decides the payroll deduction. Changing it would silently change months already locked for payroll and
    // the history of past leave, so it is fixed once leave of this type exists: archive it and add a new type instead
    // (security review, finding 6).
    if (dto.paid !== undefined && dto.paid !== row.paid) {
      const used = await this.prisma.leaveRequest.count({ where: { leaveTypeId: id, status: { notIn: ['rejected', 'cancelled'] } } });
      if (used) throw conflict('leave_type_in_use', 'Leave of this type already exists, so paid or unpaid cannot change. Archive it and add a new leave type');
    }
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.leaveType.update({
        where: { id },
        data: {
          ...(dto.name !== undefined ? { name: dto.name } : {}),
          ...(dto.yearlyDays !== undefined ? { yearlyDays: dto.yearlyDays === null ? null : dec(dto.yearlyDays) } : {}),
          ...(dto.paid !== undefined ? { paid: dto.paid } : {}),
          ...(dto.color !== undefined ? { color: dto.color } : {}),
          updatedBy: actor.id,
        },
      });
      const before = leaveTypeView(row);
      const after = leaveTypeView(updated);
      await this.audit.record({
        actorId: actor.id,
        action: 'settings.leave_type.updated',
        targetType: 'leave_type',
        targetId: row.key,
        reason: dto.reason,
        details: { before: { name: before.name, yearlyDays: before.yearlyDays, paid: before.paid, color: before.color }, after: { name: after.name, yearlyDays: after.yearlyDays, paid: after.paid, color: after.color } },
        ...client,
      }, tx);
      return after;
    });
  }

  async archiveLeaveType(actor: Actor, id: string, reason: string, client: RequestInfo): Promise<LeaveTypeView> {
    const row = await this.prisma.leaveType.findUnique({ where: { id } });
    if (!row) throw notFound('Leave type not found');
    if (row.archivedAt) throw conflict('invalid_transition', 'This leave type is already archived');
    return this.prisma.$transaction(async (tx) => {
      const updated = await tx.leaveType.update({ where: { id }, data: { archivedAt: this.clock.now(), updatedBy: actor.id } });
      await this.audit.record({ actorId: actor.id, action: 'settings.leave_type.archived', targetType: 'leave_type', targetId: row.key, reason, ...client }, tx);
      return leaveTypeView(updated);
    });
  }

  // ------------------------------------------------------------------ entitlements

  async entitlements(actor: Actor, year: number | undefined, empId: string | undefined): Promise<EntitlementView[]> {
    const rows = await this.prisma.leaveEntitlement.findMany({
      where: { ...(year ? { year } : {}), employee: { ...this.scope.employeeWhere(actor.id, 'below'), ...(empId ? { empId } : {}) } },
      include: { employee: { select: { empId: true } } },
      orderBy: [{ year: 'desc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => ({ id: r.id, empId: r.employee.empId, leaveTypeId: r.leaveTypeId, year: r.year, days: Number(r.days.toFixed(1)), reason: r.reason }));
  }

  /** Sets a person's yearly allowance for one type. Only for people BELOW the caller (never their own). */
  async setEntitlement(actor: Actor, dto: z.infer<typeof entitlementRequestSchema>, client: RequestInfo): Promise<EntitlementView> {
    const target = await this.prisma.employee.findUnique({ where: { empId: dto.empId }, select: { id: true, empId: true } });
    if (!target) throw notFound('Employee not found');
    if (target.id === actor.id) throw forbidden('self_change', 'You cannot change your own leave allowance');
    if (!(await this.scope.canAccess(actor.id, target.id, 'below'))) throw forbidden('forbidden', 'You do not have access to this');
    const type = await this.prisma.leaveType.findUnique({ where: { id: dto.leaveTypeId } });
    if (!type) throw badRequest('invalid_leave_type', 'Unknown leave type');
    return this.prisma.$transaction(async (tx) => {
      const before = await tx.leaveEntitlement.findUnique({ where: { employeeId_leaveTypeId_year: { employeeId: target.id, leaveTypeId: type.id, year: dto.year } } });
      const row = await tx.leaveEntitlement.upsert({
        where: { employeeId_leaveTypeId_year: { employeeId: target.id, leaveTypeId: type.id, year: dto.year } },
        create: { employeeId: target.id, leaveTypeId: type.id, year: dto.year, days: dec(dto.days), reason: dto.reason, createdBy: actor.id },
        update: { days: dec(dto.days), reason: dto.reason, updatedBy: actor.id },
      });
      await this.audit.record({
        actorId: actor.id,
        action: 'settings.leave_entitlement.set',
        targetType: 'employee',
        targetId: target.empId,
        reason: dto.reason,
        details: { leaveType: type.key, year: dto.year, from: before ? Number(before.days.toFixed(1)) : null, to: dto.days },
        ...client,
      }, tx);
      return { id: row.id, empId: target.empId, leaveTypeId: type.id, year: row.year, days: Number(row.days.toFixed(1)), reason: row.reason };
    });
  }

  // ------------------------------------------------------------------ office networks

  async officeNetworks(): Promise<OfficeNetworkView[]> {
    const [rows, offices] = await Promise.all([
      this.prisma.officeNetwork.findMany({ orderBy: { createdAt: 'asc' } }),
      this.prisma.office.findMany({ select: { id: true, code: true, name: true } }),
    ]);
    const office = new Map(offices.map((o) => [o.id, o]));
    return rows.map((r) => ({ id: r.id, officeCode: office.get(r.officeId)?.code ?? '', officeName: office.get(r.officeId)?.name ?? '', cidr: r.cidr, label: r.label, archived: r.archivedAt !== null }));
  }

  async createOfficeNetwork(actor: Actor, dto: z.infer<typeof officeNetworkRequestSchema>, client: RequestInfo): Promise<OfficeNetworkView> {
    const office = await this.prisma.office.findUnique({ where: { code: dto.officeCode } });
    if (!office || office.archivedAt) throw badRequest('invalid_office', 'Unknown office');
    const created = await this.prisma.$transaction(async (tx) => {
      const row = await tx.officeNetwork.create({ data: { officeId: office.id, cidr: dto.cidr, label: dto.label ?? null, createdBy: actor.id } });
      await this.audit.record({ actorId: actor.id, action: 'settings.office_network.created', targetType: 'office_network', targetId: row.id, reason: dto.reason, details: { office: office.code, cidr: dto.cidr }, ...client }, tx);
      return row;
    });
    return { id: created.id, officeCode: office.code, officeName: office.name, cidr: created.cidr, label: created.label, archived: false };
  }

  async archiveOfficeNetwork(actor: Actor, id: string, reason: string, client: RequestInfo): Promise<OfficeNetworkView> {
    const row = await this.prisma.officeNetwork.findUnique({ where: { id } });
    if (!row) throw notFound('Office network not found');
    if (row.archivedAt) throw conflict('invalid_transition', 'This network is already archived');
    const office = await this.prisma.office.findUniqueOrThrow({ where: { id: row.officeId } });
    await this.prisma.$transaction(async (tx) => {
      await tx.officeNetwork.update({ where: { id }, data: { archivedAt: this.clock.now(), updatedBy: actor.id } });
      await this.audit.record({ actorId: actor.id, action: 'settings.office_network.archived', targetType: 'office_network', targetId: id, reason, details: { office: office.code, cidr: row.cidr }, ...client }, tx);
    });
    return { id, officeCode: office.code, officeName: office.name, cidr: row.cidr, label: row.label, archived: true };
  }
}
