import { Injectable } from '@nestjs/common';
import type {
  ApprovalRouteStep, LeaveBalancesResponse, LeaveCalendarEntryView, LeaveChainStep, LeavePreviewResponse, LeaveRequestInput,
  LeaveRequestListQuery, LeaveRequestView, LeaveTypeView, Page,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { HierarchyCache } from '../access/hierarchy.service';
import { PermissionService } from '../access/permission.service';
import { ScopeService } from '../access/scope.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { Clock } from '../common/clock';
import { withDbRules } from '../common/db-rules';
import { dec, Decimal, sum } from '../common/money';
import { dayOf, dbDate, firstDayOfMonth, lastDayOfMonth, monthOf, pkDate } from '../common/pakistan-time';
import { OutboxService } from '../events/outbox.service';
import type { LeaveDecision, LeaveRequestStatus, LeaveType, Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { leaveDaysFor, leaveYearOf } from './attendance-rules';
import { badRequest, conflict, forbidden, notFound, periodLocked } from './errors';
import { RoutingHelper } from './routing.helper';
import { type Db, WorkCalendarService } from './work-calendar.service';

const PENDING: LeaveRequestStatus[] = ['pending_manager', 'pending_director'];
const num = (d: Decimal | null | undefined) => (d === null || d === undefined ? 0 : Number(d.toFixed(1)));

export function leaveTypeView(t: LeaveType): LeaveTypeView {
  return { id: t.id, key: t.key, name: t.name, yearlyDays: t.yearlyDays === null ? null : num(t.yearlyDays), paid: t.paid, color: t.color, archived: t.archivedAt !== null };
}

/** Who decides a request now and whether the Director signs off after step 1 (plan: "team lead, then the Director"). */
interface RoutePlan {
  step1: ApprovalRouteStep;
  /** True when the Director sits ABOVE the step-1 seat in the requester's reporting chain. */
  needsDirector: boolean;
  /** The seat just below the Director in the requester's chain (route step 2 from here, so a Director's stand-in also works). */
  belowDirectorEmpId: string | null;
}

type RequestRow = Prisma.LeaveRequestGetPayload<{ include: { employee: { select: { id: true; empId: true; fullName: true } }; leaveType: true; decisions: true } }>;

/**
 * Leave (plan section 11): types and yearly balances, requests, the two-step approval chain (the person's Module 1 routed
 * approver, then the Director when the Director is above that step), the team calendar.
 */
@Injectable()
export class LeaveService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly calendar: WorkCalendarService,
    private readonly approvals: ApprovalsService,
    private readonly routing: RoutingHelper,
    private readonly hierarchy: HierarchyCache,
    private readonly scope: ScopeService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  private today(): string {
    return pkDate(this.clock.now());
  }

  // ------------------------------------------------------------------ types and balances

  async types(includeArchived: boolean): Promise<LeaveTypeView[]> {
    const rows = await this.prisma.leaveType.findMany({ where: includeArchived ? {} : { archivedAt: null }, orderBy: { createdAt: 'asc' } });
    return rows.map(leaveTypeView);
  }

  /** The entitlement for a year: a personal override, or the type's yearly days (null = no limit). */
  private async entitlement(employeeId: string, type: LeaveType, year: number, db: Db): Promise<{ total: Decimal | null; overridden: boolean }> {
    const override = await db.leaveEntitlement.findUnique({ where: { employeeId_leaveTypeId_year: { employeeId, leaveTypeId: type.id, year } } });
    if (override) return { total: override.days, overridden: true };
    return { total: type.yearlyDays, overridden: false };
  }

  private async usage(employeeId: string, leaveTypeId: string, year: number, db: Db): Promise<{ used: Decimal; pending: Decimal }> {
    const rows = await db.leaveRequest.findMany({
      where: { employeeId, leaveTypeId, status: { in: ['approved', ...PENDING] }, fromDate: { gte: dbDate(`${year}-01-01`), lte: dbDate(`${year}-12-31`) } },
      select: { status: true, days: true },
    });
    return {
      used: sum(rows.filter((r) => r.status === 'approved').map((r) => r.days)),
      pending: sum(rows.filter((r) => r.status !== 'approved').map((r) => r.days)),
    };
  }

  async balances(target: { id: string; empId: string }, year?: number): Promise<LeaveBalancesResponse> {
    const y = year ?? leaveYearOf(this.today());
    const types = await this.prisma.leaveType.findMany({ orderBy: { createdAt: 'asc' } });
    const balances = [];
    for (const t of types) {
      const { total, overridden } = await this.entitlement(target.id, t, y, this.prisma);
      const { used, pending } = await this.usage(target.id, t.id, y, this.prisma);
      if (t.archivedAt && used.isZero() && pending.isZero()) continue;
      balances.push({
        leaveTypeId: t.id,
        key: t.key,
        name: t.name,
        paid: t.paid,
        color: t.color,
        total: total === null ? null : num(total),
        overridden,
        used: num(used),
        pending: num(pending),
        remaining: total === null ? null : num(total.minus(used).minus(pending)),
      });
    }
    return { empId: target.empId, year: y, balances };
  }

  // ------------------------------------------------------------------ routing

  private async director(): Promise<{ id: string; empId: string } | null> {
    return this.prisma.employee.findFirst({ where: { role: { key: 'director' }, status: { not: 'left' } }, orderBy: { empId: 'asc' }, select: { id: true, empId: true } });
  }

  async plan(requester: { id: string; empId: string }, day: string): Promise<RoutePlan> {
    const step1 = await this.approvals.route(requester.empId, day);
    const director = await this.director();
    if (!step1.seat || !director || director.id === requester.id) return { step1, needsDirector: false, belowDirectorEmpId: null };
    const chain = await this.hierarchy.getChain(requester.id);
    const seat = await this.prisma.employee.findUnique({ where: { empId: step1.seat }, select: { id: true } });
    const seatIndex = seat ? chain.indexOf(seat.id) : -1;
    const directorIndex = chain.indexOf(director.id);
    if (seatIndex < 0 || directorIndex <= seatIndex) return { step1, needsDirector: false, belowDirectorEmpId: null };
    const below = await this.prisma.employee.findUniqueOrThrow({ where: { id: chain[directorIndex - 1] }, select: { empId: true } });
    return { step1, needsDirector: true, belowDirectorEmpId: below.empId };
  }

  /** The approver of step 2 (the Director, or the Director's stand-in, or further up when the Director is away without one). */
  private async directorStep(requesterEmpId: string, day: string, plan: RoutePlan): Promise<ApprovalRouteStep | null> {
    if (!plan.needsDirector || !plan.belowDirectorEmpId) return null;
    return this.approvals.route(requesterEmpId, day, plan.belowDirectorEmpId);
  }

  /** Who must decide the request now (null when it is not pending or nobody can). */
  private async currentStep(row: { status: LeaveRequestStatus; employee: { id: string; empId: string } }, day: string) {
    if (!PENDING.includes(row.status)) return null;
    const plan = await this.plan(row.employee, day);
    if (row.status === 'pending_manager') return { step: 1, route: plan.step1, plan };
    const step2 = await this.directorStep(row.employee.empId, day, plan);
    return { step: 2, route: step2 ?? { approver: null, seat: null, via: null, skipped: [] }, plan };
  }

  // ------------------------------------------------------------------ views

  private readonly include = { employee: { select: { id: true, empId: true, fullName: true } }, leaveType: true, decisions: { orderBy: { decidedAt: 'asc' as const } } } as const;

  private async views(rows: RequestRow[], actor: Actor): Promise<LeaveRequestView[]> {
    const today = this.today();
    const canApprove = await this.permissions.can(actor.id, 'leave.approve');
    const peopleIds = new Set<string>();
    rows.forEach((r) => r.decisions.forEach((d) => peopleIds.add(d.decidedBy)));
    const plans = new Map<string, Awaited<ReturnType<LeaveService['currentStep']>>>();
    const predicted = new Map<string, ApprovalRouteStep | null>();
    for (const r of rows) {
      const current = await this.currentStep(r, today);
      plans.set(r.id, current);
      if (r.status === 'pending_manager' && current?.plan.needsDirector) predicted.set(r.id, await this.directorStep(r.employee.empId, today, current.plan));
    }
    const empIds = new Set<string>();
    for (const c of plans.values()) if (c?.route.approver) empIds.add(c.route.approver);
    for (const p of predicted.values()) if (p?.approver) empIds.add(p.approver);
    const people = await this.prisma.employee.findMany({
      where: { OR: [{ id: { in: [...peopleIds] } }, { empId: { in: [...empIds] } }] },
      select: { id: true, empId: true, fullName: true, role: { select: { name: true } } },
    });
    const byId = new Map(people.map((p) => [p.id, p]));
    const byEmpId = new Map(people.map((p) => [p.empId, p]));
    const label = (fallback: string, role?: string, via?: string | null) => `${role ?? fallback}${via === 'stand_in' ? ' (stand-in)' : ''}`;

    return rows.map((r) => {
      const current = plans.get(r.id) ?? null;
      const decided = (step: number) => r.decisions.find((d) => d.step === step && d.decision !== 'cancelled');
      const chain: LeaveChainStep[] = [];
      const fromDecision = (step: number, d: LeaveDecision, fallback: string): LeaveChainStep => {
        const who = byId.get(d.decidedBy);
        return { step, label: label(fallback, who?.role.name, d.via), approverEmpId: who?.empId ?? null, approverName: who?.fullName ?? null, state: d.decision === 'approved' ? 'done' : 'rejected', via: d.via, at: d.decidedAt.toISOString(), note: d.note };
      };
      const fromRoute = (step: number, route: ApprovalRouteStep | null, state: 'waiting' | 'pending', fallback: string): LeaveChainStep => {
        const who = route?.approver ? byEmpId.get(route.approver) : undefined;
        return { step, label: label(fallback, who?.role.name, route?.via), approverEmpId: route?.approver ?? null, approverName: who?.fullName ?? null, state, via: route?.via ?? null, at: null, note: null };
      };
      const d1 = decided(1);
      const d2 = decided(2);
      if (d1) chain.push(fromDecision(1, d1, 'Manager'));
      else if (r.status === 'pending_manager') chain.push(fromRoute(1, current!.route, 'waiting', 'Manager'));
      if (d2) chain.push(fromDecision(2, d2, 'Director'));
      else if (r.status === 'pending_director') chain.push(fromRoute(2, current!.route, 'waiting', 'Director'));
      else if (r.status === 'pending_manager' && predicted.get(r.id)) chain.push(fromRoute(2, predicted.get(r.id)!, 'pending', 'Director'));
      if (r.status === 'cancelled') {
        for (const s of chain) if (s.state === 'waiting' || s.state === 'pending') s.state = 'skipped';
      }

      const approver = current?.route.approver ?? null;
      const canDecide = canApprove && !!approver && approver === actor.empId && r.employee.id !== actor.id;
      const canCancel = r.employee.id === actor.id && (PENDING.includes(r.status) || (r.status === 'approved' && today < dayOf(r.fromDate)));
      return {
        id: r.id,
        number: r.number,
        empId: r.employee.empId,
        name: r.employee.fullName,
        leaveTypeId: r.leaveTypeId,
        leaveTypeName: r.leaveType.name,
        paid: r.leaveType.paid,
        from: dayOf(r.fromDate),
        to: dayOf(r.toDate),
        days: num(r.days),
        halfDay: r.halfDay,
        reason: r.reason,
        status: r.status,
        createdAt: r.createdAt.toISOString(),
        chain,
        canDecide,
        canCancel,
      };
    });
  }

  async list(actor: Actor, query: LeaveRequestListQuery): Promise<Page<LeaveRequestView>> {
    const statusWhere: Prisma.LeaveRequestWhereInput = query.status
      ? { status: query.status === 'pending' ? { in: PENDING } : query.status }
      : {};
    const yearWhere: Prisma.LeaveRequestWhereInput = query.year ? { fromDate: { gte: dbDate(`${query.year}-01-01`), lte: dbDate(`${query.year}-12-31`) } } : {};
    let rows: RequestRow[];
    if (query.scope === 'mine') {
      rows = await this.prisma.leaveRequest.findMany({ where: { employeeId: actor.id, ...statusWhere, ...yearWhere }, include: this.include, orderBy: { createdAt: 'desc' } });
    } else {
      const where = await this.routing.decidableWhere(actor.id, this.today());
      rows = await this.prisma.leaveRequest.findMany({ where: { employee: where, ...statusWhere, ...yearWhere }, include: this.include, orderBy: { createdAt: 'desc' } });
    }
    let items = await this.views(rows, actor);
    if (query.scope === 'team') {
      const below = new Set(await this.hierarchy.getDownlineIds(actor.id));
      items = items.filter((item, i) => below.has(rows[i].employeeId) || item.canDecide);
    }
    const start = (query.page - 1) * query.pageSize;
    return { items: items.slice(start, start + query.pageSize), total: items.length, page: query.page, pageSize: query.pageSize };
  }

  async one(actor: Actor, id: string): Promise<LeaveRequestView> {
    const row = await this.prisma.leaveRequest.findUnique({ where: { id }, include: this.include });
    if (!row) throw notFound('Leave request not found');
    const [view] = await this.views([row], actor);
    const visible = row.employeeId === actor.id || view.canDecide || (await this.scope.canAccess(actor.id, row.employeeId, 'below')) || row.decisions.some((d) => d.decidedBy === actor.id);
    if (!visible) throw notFound('Leave request not found');
    return view;
  }

  async calendarMonth(actor: Actor, month: string): Promise<LeaveCalendarEntryView[]> {
    const from = firstDayOfMonth(month);
    const to = lastDayOfMonth(month);
    const rows = await this.prisma.leaveRequest.findMany({
      where: { employee: this.scope.employeeWhere(actor.id, 'self_or_below'), status: { in: ['approved', ...PENDING] }, fromDate: { lte: dbDate(to) }, toDate: { gte: dbDate(from) } },
      include: { employee: { select: { empId: true, fullName: true } }, leaveType: { select: { name: true } } },
      orderBy: [{ fromDate: 'asc' }, { createdAt: 'asc' }],
    });
    return rows.map((r) => ({
      requestId: r.id,
      number: r.number,
      empId: r.employee.empId,
      name: r.employee.fullName,
      leaveTypeId: r.leaveTypeId,
      leaveTypeName: r.leaveType.name,
      from: dayOf(r.fromDate),
      to: dayOf(r.toDate),
      days: num(r.days),
      halfDay: r.halfDay,
      status: r.status,
    }));
  }

  // ------------------------------------------------------------------ requesting

  private async checkDates(actor: Actor, type: LeaveType | null, input: { from: string; to: string; halfDay: boolean }) {
    if (!type || type.archivedAt) throw badRequest('invalid_leave_type', 'Choose a leave type that is in use');
    if (input.to < input.from) throw badRequest('invalid_dates', 'The end date cannot be before the start date');
    if (input.halfDay && input.from !== input.to) throw badRequest('invalid_dates', 'A half day is a single day');
    if (leaveYearOf(input.from) !== leaveYearOf(input.to)) throw badRequest('spans_leave_years', 'A request must stay inside one leave year; make one request per year');
    const employee = await this.prisma.employee.findUniqueOrThrow({ where: { id: actor.id }, select: { joiningDate: true, lastWorkingDay: true } });
    if (input.from < dayOf(employee.joiningDate) || (employee.lastWorkingDay && input.to > dayOf(employee.lastWorkingDay))) {
      throw badRequest('not_employed', 'Leave must fall while you work here');
    }
    const today = this.today();
    if (input.from < firstDayOfMonth(monthOf(today))) throw badRequest('past_month', 'Leave can be asked for days of this month or later only');
    const locked = await this.calendar.lockedMonthsIn(input.from, input.to);
    if (locked.length) throw periodLocked(locked[0]);
    const days = leaveDaysFor(await this.calendar.workingDays(input.from, input.to), input.halfDay);
    if (days <= 0) throw badRequest('no_working_days', 'The dates you picked have no working days');
    return days;
  }

  async preview(actor: Actor, input: { leaveTypeId: string; from: string; to: string; halfDay: boolean }): Promise<LeavePreviewResponse> {
    const type = await this.prisma.leaveType.findUnique({ where: { id: input.leaveTypeId } });
    const days = await this.checkDates(actor, type, input);
    const year = leaveYearOf(input.from);
    const { total } = await this.entitlement(actor.id, type!, year, this.prisma);
    const { used, pending } = await this.usage(actor.id, type!.id, year, this.prisma);
    const remaining = total === null ? null : total.minus(used).minus(pending);
    const today = this.today();
    const plan = await this.plan(actor, today);
    const step2 = await this.directorStep(actor.empId, today, plan);
    const routes = [plan.step1, ...(step2 ? [step2] : [])].filter((r) => r.approver);
    const people = await this.prisma.employee.findMany({ where: { empId: { in: routes.map((r) => r.approver!) } }, select: { empId: true, fullName: true, role: { select: { name: true } } } });
    const chain: LeaveChainStep[] = routes.map((r, i) => {
      const who = people.find((p) => p.empId === r.approver);
      return { step: i + 1, label: `${who?.role.name ?? (i ? 'Director' : 'Manager')}${r.via === 'stand_in' ? ' (stand-in)' : ''}`, approverEmpId: r.approver, approverName: who?.fullName ?? null, state: i ? 'pending' : 'waiting', via: r.via, at: null, note: null };
    });
    return {
      days,
      remaining: remaining === null ? null : num(remaining),
      remainingAfter: remaining === null ? null : num(remaining.minus(dec(days))),
      firstApproverEmpId: plan.step1.approver,
      needsDirector: plan.needsDirector,
      chain,
    };
  }

  async create(actor: Actor, input: LeaveRequestInput, client: RequestInfo): Promise<LeaveRequestView> {
    const type = await this.prisma.leaveType.findUnique({ where: { id: input.leaveTypeId } });
    const days = await this.checkDates(actor, type, input);
    const today = this.today();
    const plan = await this.plan(actor, today);
    const year = leaveYearOf(input.from);

    const id = await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        // One request at a time per person, so two requests sent together cannot both use the last days of a balance.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`leave:${actor.id}`}))`;
        const overlap = await tx.leaveRequest.findFirst({
          where: { employeeId: actor.id, status: { in: ['approved', ...PENDING] }, fromDate: { lte: dbDate(input.to) }, toDate: { gte: dbDate(input.from) } },
          select: { number: true },
        });
        if (overlap) throw conflict('overlapping_request', `These dates overlap request ${overlap.number}`);
        const { total } = await this.entitlement(actor.id, type!, year, tx);
        if (total !== null) {
          const { used, pending } = await this.usage(actor.id, type!.id, year, tx);
          const remaining = total.minus(used).minus(pending);
          if (dec(days).greaterThan(remaining)) {
            throw conflict('insufficient_balance', `You have ${num(remaining)} ${type!.name.toLowerCase()} days left in ${year}. Choose fewer days or another type.`);
          }
        }
        // Nobody above (the top of the company): the leave is recorded as approved (development default, see docs).
        const status: LeaveRequestStatus = plan.step1.approver ? 'pending_manager' : 'approved';
        const created = await tx.leaveRequest.create({
          data: { employeeId: actor.id, leaveTypeId: type!.id, fromDate: dbDate(input.from), toDate: dbDate(input.to), halfDay: input.halfDay, days: dec(days), reason: input.reason, status, createdBy: actor.id },
          select: { id: true, number: true },
        });
        await this.audit.record({
          actorId: actor.id,
          action: status === 'approved' ? 'leave.recorded_without_approver' : 'leave.requested',
          targetType: 'leave_request',
          targetId: created.number,
          reason: input.reason,
          details: { type: type!.key, from: input.from, to: input.to, days, halfDay: input.halfDay, approver: plan.step1.approver, needsDirector: plan.needsDirector },
          ...client,
        }, tx);
        await this.outbox.emit({ type: 'leave.requested', actor: actor.empId, payload: { requestNumber: created.number, empId: actor.empId, approverEmpId: plan.step1.approver, from: input.from, to: input.to } }, tx);
        return created.id;
      }),
    );
    return this.one(actor, id);
  }

  // ------------------------------------------------------------------ decisions

  private async load(id: string) {
    const row = await this.prisma.leaveRequest.findUnique({ where: { id }, include: { employee: { select: { id: true, empId: true } } } });
    if (!row) throw notFound('Leave request not found');
    return row;
  }

  private async lockedFor(row: { fromDate: Date; toDate: Date }) {
    const locked = await this.calendar.lockedMonthsIn(dayOf(row.fromDate), dayOf(row.toDate));
    if (locked.length) throw periodLocked(locked[0]);
  }

  /** Not the requester, the routed approver of the CURRENT step, still pending. */
  private async assertDecider(actor: Actor, row: Awaited<ReturnType<LeaveService['load']>>) {
    if (row.employee.id === actor.id) throw forbidden('self_approval', 'You cannot decide your own leave');
    const current = await this.currentStep(row, this.today());
    if (!current) throw conflict('invalid_transition', 'This leave request is not waiting for a decision');
    if (current.route.approver !== actor.empId) throw forbidden('not_routed_approver', 'This request is waiting for someone else');
    return current;
  }

  private async move(tx: Prisma.TransactionClient, id: string, from: LeaveRequestStatus, to: LeaveRequestStatus, actorId: string) {
    const updated = await tx.leaveRequest.updateMany({ where: { id, status: from }, data: { status: to, updatedBy: actorId } });
    if (updated.count === 0) throw conflict('state_changed', 'This leave request was decided meanwhile');
  }

  async approve(actor: Actor, id: string, note: string | undefined, client: RequestInfo): Promise<LeaveRequestView> {
    const row = await this.load(id);
    const current = await this.assertDecider(actor, row);
    await this.lockedFor(row);
    const today = this.today();
    const forward = current.step === 1 && current.plan.needsDirector;
    const next = forward ? await this.directorStep(row.employee.empId, today, current.plan) : null;
    await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        await this.move(tx, row.id, row.status, forward ? 'pending_director' : 'approved', actor.id);
        await tx.leaveDecision.create({ data: { requestId: row.id, step: current.step, decision: 'approved', decidedBy: actor.id, via: current.route.via, note: note ?? null } });
        await this.audit.record({
          actorId: actor.id,
          action: forward ? 'leave.forwarded' : 'leave.approved',
          targetType: 'leave_request',
          targetId: row.number,
          reason: note ?? null,
          details: { empId: row.employee.empId, step: current.step, via: current.route.via, next: next?.approver ?? null },
          ...client,
        }, tx);
        await this.outbox.emit({
          type: 'leave.decided',
          actor: actor.empId,
          payload: { requestNumber: row.number, empId: row.employee.empId, decision: forward ? 'forwarded' : 'approved', byEmpId: actor.empId, nextApproverEmpId: next?.approver ?? null },
        }, tx);
      }),
    );
    return this.one(actor, id);
  }

  async reject(actor: Actor, id: string, reason: string, client: RequestInfo): Promise<LeaveRequestView> {
    const row = await this.load(id);
    const current = await this.assertDecider(actor, row);
    await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        await this.move(tx, row.id, row.status, 'rejected', actor.id);
        await tx.leaveDecision.create({ data: { requestId: row.id, step: current.step, decision: 'rejected', decidedBy: actor.id, via: current.route.via, note: reason } });
        await this.audit.record({ actorId: actor.id, action: 'leave.rejected', targetType: 'leave_request', targetId: row.number, reason, details: { empId: row.employee.empId, step: current.step }, ...client }, tx);
        await this.outbox.emit({ type: 'leave.decided', actor: actor.empId, payload: { requestNumber: row.number, empId: row.employee.empId, decision: 'rejected', byEmpId: actor.empId, nextApproverEmpId: null } }, tx);
      }),
    );
    return this.one(actor, id);
  }

  /**
   * The requester cancels: a pending request at any time; an APPROVED one only before its first day (development default,
   * docs/M7-M9-DECISIONS.md D8). A locked month is never changed.
   */
  async cancel(actor: Actor, id: string, reason: string | undefined, client: RequestInfo): Promise<LeaveRequestView> {
    const row = await this.load(id);
    if (row.employee.id !== actor.id) throw notFound('Leave request not found');
    const today = this.today();
    if (row.status === 'approved') {
      if (today >= dayOf(row.fromDate)) throw conflict('leave_started', 'Approved leave can be cancelled only before its first day');
      await this.lockedFor(row);
    } else if (!PENDING.includes(row.status)) {
      throw conflict('invalid_transition', 'This leave request is already closed');
    }
    const decisions = await this.prisma.leaveDecision.count({ where: { requestId: row.id } });
    await withDbRules(() =>
      this.prisma.$transaction(async (tx) => {
        await this.move(tx, row.id, row.status, 'cancelled', actor.id);
        await tx.leaveDecision.create({ data: { requestId: row.id, step: decisions + 1, decision: 'cancelled', decidedBy: actor.id, via: 'self', note: reason ?? null } });
        await this.audit.record({ actorId: actor.id, action: 'leave.cancelled', targetType: 'leave_request', targetId: row.number, reason: reason ?? null, details: { previousStatus: row.status }, ...client }, tx);
        await this.outbox.emit({ type: 'leave.decided', actor: actor.empId, payload: { requestNumber: row.number, empId: row.employee.empId, decision: 'cancelled', byEmpId: actor.empId, nextApproverEmpId: null } }, tx);
      }),
    );
    return this.one(actor, id);
  }
}
