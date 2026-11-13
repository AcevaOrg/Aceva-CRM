import { Injectable } from '@nestjs/common';
import type { CorrectionListQuery, CorrectionRequest, CorrectionView, Page } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { HierarchyCache } from '../access/hierarchy.service';
import { PermissionService } from '../access/permission.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { Clock } from '../common/clock';
import { isUniqueViolation, withDbRules } from '../common/db-rules';
import { dayOf, dbDate, monthOf, pkDate, pkInstant, pkMinuteOfDay } from '../common/pakistan-time';
import { OutboxService } from '../events/outbox.service';
import type { AttendanceCorrection, Employee, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { lateMinutesFor, minuteOf } from './attendance-rules';
import { badRequest, conflict, forbidden, notFound, periodLocked } from './errors';
import { RoutingHelper } from './routing.helper';
import { WorkCalendarService } from './work-calendar.service';

type CorrectionRow = AttendanceCorrection & {
  employee: Pick<Employee, 'empId' | 'fullName'>;
  record: { checkInAt: Date | null; checkOutAt: Date | null } | null;
};

/**
 * Attendance corrections (plan section 11): the employee asks their manager to fix a wrong or missed entry, with a reason.
 * The original record is never changed: an approval fills corrected_check_in_at / corrected_check_out_at.
 * The approver is the person's Module 1 routed approver (stand-ins and leavers handled there), never the person themselves.
 */
@Injectable()
export class CorrectionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: WorkCalendarService,
    private readonly approvals: ApprovalsService,
    private readonly routing: RoutingHelper,
    private readonly hierarchy: HierarchyCache,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  private today(): string {
    return pkDate(this.clock.now());
  }

  private async view(rows: CorrectionRow[], actor: Actor, canDecideAny: boolean): Promise<CorrectionView[]> {
    const today = this.today();
    const deciders = new Map<string, string | null>();
    const decidedBy = new Map(
      (await this.prisma.employee.findMany({ where: { id: { in: rows.map((r) => r.decidedBy).filter((v): v is string => !!v) } }, select: { id: true, empId: true } })).map((e) => [e.id, e.empId]),
    );
    const out: CorrectionView[] = [];
    for (const r of rows) {
      let approver: string | null = null;
      if (r.status === 'pending') {
        if (!deciders.has(r.employee.empId)) deciders.set(r.employee.empId, (await this.approvals.route(r.employee.empId, today)).approver);
        approver = deciders.get(r.employee.empId) ?? null;
      }
      out.push({
        id: r.id,
        empId: r.employee.empId,
        name: r.employee.fullName,
        date: dayOf(r.workDate),
        original: { checkIn: r.record?.checkInAt?.toISOString() ?? null, checkOut: r.record?.checkOutAt?.toISOString() ?? null },
        requested: { checkIn: r.requestedCheckInAt?.toISOString() ?? null, checkOut: r.requestedCheckOutAt?.toISOString() ?? null },
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        decidedBy: r.decidedBy ? (decidedBy.get(r.decidedBy) ?? null) : null,
        decidedAt: r.decidedAt?.toISOString() ?? null,
        decisionNote: r.decisionNote,
        approverEmpId: approver,
        canDecide: canDecideAny && approver === actor.empId && r.employee.empId !== actor.empId,
      });
    }
    return out;
  }

  private readonly include = { employee: { select: { empId: true, fullName: true } }, record: { select: { checkInAt: true, checkOutAt: true } } } as const;

  async list(actor: Actor, query: CorrectionListQuery): Promise<Page<CorrectionView>> {
    const canDecide = await this.permissions.can(actor.id, 'attendance.approve_correction');
    let rows: CorrectionRow[];
    if (query.scope === 'mine') {
      rows = await this.prisma.attendanceCorrection.findMany({
        where: { employeeId: actor.id, ...(query.status ? { status: query.status } : {}) },
        include: this.include,
        orderBy: [{ workDate: 'desc' }, { createdAt: 'desc' }],
      });
    } else {
      const canView = canDecide || (await this.permissions.can(actor.id, 'attendance.view_team'));
      if (!canView) throw forbidden('forbidden', 'You do not have access to this');
      const where = await this.routing.decidableWhere(actor.id, this.today());
      rows = await this.prisma.attendanceCorrection.findMany({
        where: { employee: where, ...(query.status ? { status: query.status } : {}) },
        include: this.include,
        orderBy: [{ createdAt: 'desc' }],
      });
    }
    let items = await this.view(rows, actor, canDecide);
    if (query.scope === 'team') {
      // Outside the caller's own line, only what is routed to them (as a stand-in) right now.
      const below = new Set(await this.hierarchy.getDownlineIds(actor.id));
      items = items.filter((item, i) => below.has(rows[i].employeeId) || item.canDecide);
    }
    const start = (query.page - 1) * query.pageSize;
    return { items: items.slice(start, start + query.pageSize), total: items.length, page: query.page, pageSize: query.pageSize };
  }

  async create(actor: Actor, dto: CorrectionRequest, client: RequestInfo): Promise<CorrectionView> {
    const now = this.clock.now();
    const today = pkDate(now);
    if (dto.date > today) throw badRequest('future_date', 'You can ask for a correction of today or a past day only');
    const employee = await this.prisma.employee.findUniqueOrThrow({ where: { id: actor.id }, select: { joiningDate: true, lastWorkingDay: true } });
    if (dto.date < dayOf(employee.joiningDate) || (employee.lastWorkingDay && dto.date > dayOf(employee.lastWorkingDay))) {
      throw badRequest('not_employed', 'You did not work here on that day');
    }
    if (await this.calendar.isMonthLocked(monthOf(dto.date))) throw periodLocked(monthOf(dto.date));
    const requestedIn = dto.checkIn ? pkInstant(dto.date, minuteOf(dto.checkIn)) : null;
    const requestedOut = dto.checkOut ? pkInstant(dto.date, minuteOf(dto.checkOut)) : null;
    if ((requestedIn && requestedIn > now) || (requestedOut && requestedOut > now)) throw badRequest('future_time', 'A requested time cannot be later than now');

    const record = await this.prisma.attendanceRecord.findUnique({ where: { employeeId_workDate: { employeeId: actor.id, workDate: dbDate(dto.date) } } });
    const finalIn = requestedIn ?? record?.correctedCheckInAt ?? record?.checkInAt ?? null;
    const finalOut = requestedOut ?? record?.correctedCheckOutAt ?? record?.checkOutAt ?? null;
    if (finalIn && finalOut && finalOut < finalIn) throw badRequest('invalid_times', 'Check-out cannot be before check-in');

    const pending = await this.prisma.attendanceCorrection.count({ where: { employeeId: actor.id, workDate: dbDate(dto.date), status: 'pending' } });
    if (pending) throw conflict('correction_pending', 'There is already a pending correction for this day');
    const route = await this.approvals.route(actor.empId, today);
    if (!route.approver) throw badRequest('no_approver', 'There is nobody above you to approve a correction');

    let id: string;
    try {
      id = await withDbRules(() =>
        this.prisma.$transaction(async (tx) => {
          const created = await tx.attendanceCorrection.create({
            data: { employeeId: actor.id, workDate: dbDate(dto.date), recordId: record?.id ?? null, requestedCheckInAt: requestedIn, requestedCheckOutAt: requestedOut, reason: dto.reason, createdBy: actor.id },
            select: { id: true },
          });
          await this.audit.record({ actorId: actor.id, action: 'attendance.correction_requested', targetType: 'attendance_correction', targetId: created.id, reason: dto.reason, details: { date: dto.date, checkIn: dto.checkIn ?? null, checkOut: dto.checkOut ?? null, approver: route.approver }, ...client }, tx);
          return created.id;
        }),
      );
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('correction_pending', 'There is already a pending correction for this day');
      throw error;
    }
    return this.one(actor, id);
  }

  async one(actor: Actor, id: string): Promise<CorrectionView> {
    const row = await this.prisma.attendanceCorrection.findUnique({ where: { id }, include: this.include });
    if (!row) throw notFound('Correction not found');
    const canDecide = await this.permissions.can(actor.id, 'attendance.approve_correction');
    const [view] = await this.view([row], actor, canDecide);
    const visible = row.employeeId === actor.id || row.decidedBy === actor.id || view.canDecide || (await this.hierarchy.getDownlineIds(actor.id)).includes(row.employeeId);
    if (!visible) throw notFound('Correction not found');
    return view;
  }

  private async pendingFor(actor: Actor, id: string) {
    const row = await this.prisma.attendanceCorrection.findUnique({ where: { id }, include: { employee: { select: { id: true, empId: true } } } });
    if (!row) throw notFound('Correction not found');
    return row;
  }

  /** The checks every decision makes: still pending, not the requester, the currently routed approver, month not locked. */
  private async assertDecider(actor: Actor, row: { status: string; workDate: Date; employee: { empId: string } }) {
    if (row.employee.empId === actor.empId) throw forbidden('self_approval', 'You cannot decide your own correction');
    const route = await this.approvals.route(row.employee.empId, this.today());
    if (route.approver !== actor.empId) throw forbidden('not_routed_approver', "Only the person's routed approver can decide this correction");
    if (row.status !== 'pending') throw conflict('invalid_transition', 'This correction was already decided');
    const month = monthOf(dayOf(row.workDate));
    if (await this.calendar.isMonthLocked(month)) throw periodLocked(month);
  }

  async approve(actor: Actor, id: string, note: string | undefined, client: RequestInfo): Promise<CorrectionView> {
    const row = await this.pendingFor(actor, id);
    await this.assertDecider(actor, row);
    const date = dayOf(row.workDate);
    const slice = await this.calendar.slice(date, date);
    const schedule = slice.scheduleOn(date);
    const now = this.clock.now();

    await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        const record = await tx.attendanceRecord.findUnique({ where: { employeeId_workDate: { employeeId: row.employeeId, workDate: row.workDate } } });
        const correctedIn = row.requestedCheckInAt ?? record?.correctedCheckInAt ?? null;
        const correctedOut = row.requestedCheckOutAt ?? record?.correctedCheckOutAt ?? null;
        const effectiveIn = correctedIn ?? record?.checkInAt ?? null;
        const effectiveOut = correctedOut ?? record?.checkOutAt ?? null;
        if (effectiveIn && effectiveOut && effectiveOut < effectiveIn) throw conflict('invalid_times', 'With this correction the check-out would be before the check-in');
        const late = effectiveIn && schedule ? lateMinutesFor(pkMinuteOfDay(effectiveIn), schedule, slice.isWorkingDay(date)) : 0;
        let recordId: string;
        if (record) {
          await tx.attendanceRecord.update({ where: { id: record.id }, data: { correctedCheckInAt: correctedIn, correctedCheckOutAt: correctedOut, lateMinutes: late, updatedBy: actor.id } });
          recordId = record.id;
        } else {
          const created = await tx.attendanceRecord.create({
            data: { employeeId: row.employeeId, workDate: row.workDate, correctedCheckInAt: correctedIn, correctedCheckOutAt: correctedOut, lateMinutes: late, scheduleId: schedule?.id ?? null, createdBy: actor.id },
            select: { id: true },
          });
          recordId = created.id;
        }
        await this.decide(tx, row.id, { status: 'approved', decidedBy: actor.id, decidedAt: now, decisionNote: note ?? null, updatedBy: actor.id, recordId });
        await this.audit.record({ actorId: actor.id, action: 'attendance.correction_approved', targetType: 'attendance_correction', targetId: row.id, reason: note ?? null, details: { empId: row.employee.empId, date, lateMinutes: late }, ...client }, tx);
        await this.outbox.emit({ type: 'attendance.correction.decided', actor: actor.empId, payload: { correctionId: row.id, empId: row.employee.empId, date, decision: 'approved', byEmpId: actor.empId } }, tx);
      }),
    );
    return this.one(actor, id);
  }

  async reject(actor: Actor, id: string, reason: string, client: RequestInfo): Promise<CorrectionView> {
    const row = await this.pendingFor(actor, id);
    await this.assertDecider(actor, row);
    const date = dayOf(row.workDate);
    await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        await this.decide(tx, row.id, { status: 'rejected', decidedBy: actor.id, decidedAt: this.clock.now(), decisionNote: reason, updatedBy: actor.id });
        await this.audit.record({ actorId: actor.id, action: 'attendance.correction_rejected', targetType: 'attendance_correction', targetId: row.id, reason, details: { empId: row.employee.empId, date }, ...client }, tx);
        await this.outbox.emit({ type: 'attendance.correction.decided', actor: actor.empId, payload: { correctionId: row.id, empId: row.employee.empId, date, decision: 'rejected', byEmpId: actor.empId } }, tx);
      }),
    );
    return this.one(actor, id);
  }

  async cancel(actor: Actor, id: string, client: RequestInfo): Promise<CorrectionView> {
    const row = await this.pendingFor(actor, id);
    if (row.employeeId !== actor.id) throw notFound('Correction not found');
    if (row.status !== 'pending') throw conflict('invalid_transition', 'Only a pending correction can be cancelled');
    const month = monthOf(dayOf(row.workDate));
    if (await this.calendar.isMonthLocked(month)) throw periodLocked(month);
    await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        await this.decide(tx, row.id, { status: 'cancelled', decidedBy: actor.id, decidedAt: this.clock.now(), updatedBy: actor.id });
        await this.audit.record({ actorId: actor.id, action: 'attendance.correction_cancelled', targetType: 'attendance_correction', targetId: row.id, details: { date: dayOf(row.workDate) }, ...client }, tx);
      }),
    );
    return this.one(actor, id);
  }

  /** Moves a pending correction on; 409 state_changed if someone else decided it meanwhile (no double decisions). */
  private async decide(tx: Prisma.TransactionClient, id: string, data: Prisma.AttendanceCorrectionUncheckedUpdateManyInput) {
    const updated = await tx.attendanceCorrection.updateMany({ where: { id, status: 'pending' }, data });
    if (updated.count === 0) throw conflict('state_changed', 'This correction was decided meanwhile');
  }
}
