import { Injectable } from '@nestjs/common';
import {
  SALES_DAILY_METRICS,
  type SalesTargetsRowView,
  type SetSalesDailyTargetsRequest,
  type SetSalesMonthlyTargetsRequest,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { PermissionService } from '../access/permission.service';
import { ScopeService } from '../access/scope.service';
import { Clock } from '../common/clock';
import { dbDate, monthOf, pkDate } from '../common/pakistan-time';
import { noteActivity } from '../common/request-context';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SALES_OWN, type SalesAccess, SalesAccessService } from './sales-access.service';
import { badRequest, forbidden, notFound } from './sales-errors';
import { SalesMetricsService } from './sales-metrics.service';
import { person } from './sales-views';

/**
 * Module 15.6 targets (plan section 20: "the sales manager sets targets for each person for every working day ... and for
 * each month"). Only the sales manager (sales.targets) sets them, for sales staff (SalesMetricsService.salespeople) in
 * their reporting line, never for themselves. A change is a new version from a day (today or later) or for a month (this month or later),
 * so a day already reported keeps the targets it was measured against. Fields left out keep the value in force; null
 * clears one. The CEO / Owner and the team see them; a salesperson sees their own.
 */
@Injectable()
export class SalesTargetsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: SalesAccessService,
    private readonly scope: ScopeService,
    private readonly permissions: PermissionService,
    private readonly metrics: SalesMetricsService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private today(): string {
    return pkDate(this.clock.now());
  }

  /** GET /sales/targets?month */
  async list(actor: Actor, month?: string): Promise<SalesTargetsRowView[]> {
    const a = await this.access.of(actor);
    const m = month ?? monthOf(this.today());
    const people = await this.metrics.salespeople(this.prisma, this.peopleScope(a));
    const managed = await this.access.manageableOwners(a, people.map((p) => p.id));
    const out: SalesTargetsRowView[] = [];
    for (const p of people) {
      const [daily, next, monthly] = await Promise.all([this.metrics.dailyTargetsOn(p.id, this.today()), this.metrics.dailyTargetsAfter(p.id, this.today()), this.metrics.monthlyTargets(p.id, m)]);
      out.push({
        person: person(p),
        daily: this.metrics.dailyTargetsView(daily),
        dailyNext: this.metrics.dailyTargetsView(next),
        monthly: this.metrics.monthlyTargetsView(monthly),
        canEdit: managed.has(p.id) && p.id !== actor.id,
      });
    }
    return out;
  }

  /** PUT /sales/targets/daily */
  async setDaily(actor: Actor, dto: SetSalesDailyTargetsRequest, client: RequestInfo): Promise<SalesTargetsRowView> {
    const target = await this.editable(actor, dto.empId);
    if (dto.effectiveFrom < this.today()) badRequest('target_in_past', 'Targets change from today or a later day; a past day keeps the targets it had');
    const id = await this.prisma.$transaction(async (tx) => {
      const before = await this.metrics.dailyTargetsOn(target.id, dto.effectiveFrom, tx);
      const merged: Record<string, number | null> = {};
      for (const k of SALES_DAILY_METRICS) merged[k] = dto[k] === undefined ? (before?.[k] ?? null) : dto[k];
      const row = await tx.salesDailyTarget.create({
        data: { employeeId: target.id, effectiveFrom: dbDate(dto.effectiveFrom), leadsAdded: merged.leadsAdded, emailsChecked: merged.emailsChecked, emailsSent: merged.emailsSent, followUpsDone: merged.followUpsDone, setById: actor.id },
        select: { id: true },
      });
      await this.audit.record(
        { actorId: actor.id, action: 'sales.targets.daily_set', targetType: 'employee', targetId: target.empId, details: { effectiveFrom: dto.effectiveFrom, before: before ? pick(before, SALES_DAILY_METRICS) : null, after: merged } as Prisma.InputJsonValue, ...client },
        tx,
      );
      return row.id;
    });
    noteActivity({ target: target.empId, description: `Set the daily sales targets of ${target.empId} from ${dto.effectiveFrom}`, details: { id } });
    return this.row(actor, target.id);
  }

  /** PUT /sales/targets/monthly */
  async setMonthly(actor: Actor, dto: SetSalesMonthlyTargetsRequest, client: RequestInfo): Promise<SalesTargetsRowView> {
    const target = await this.editable(actor, dto.empId);
    if (dto.month < monthOf(this.today())) badRequest('target_in_past', 'Monthly targets change for this month or a later one; a past month keeps its targets');
    await this.prisma.$transaction(async (tx) => {
      const before = await this.metrics.monthlyTargets(target.id, dto.month, tx);
      const meetingsBooked = dto.meetingsBooked === undefined ? (before?.meetingsBooked ?? null) : dto.meetingsBooked;
      const proposalsSent = dto.proposalsSent === undefined ? (before?.proposalsSent ?? null) : dto.proposalsSent;
      const won =
        dto.wonValue === undefined ? (before?.wonAmount && before.wonCurrency ? { amount: before.wonAmount.toFixed(2), currency: before.wonCurrency } : null) : dto.wonValue;
      await tx.salesMonthlyTarget.create({
        data: { employeeId: target.id, month: dto.month, meetingsBooked, proposalsSent, wonAmount: won?.amount ?? null, wonCurrency: won?.currency ?? null, setById: actor.id },
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'sales.targets.monthly_set',
          targetType: 'employee',
          targetId: target.empId,
          details: { month: dto.month, before: before ? { ...pick(before, ['meetingsBooked', 'proposalsSent']), wonValue: before.wonAmount ? `${before.wonCurrency} ${before.wonAmount.toFixed(2)}` : null } : null, after: { meetingsBooked, proposalsSent, wonValue: won ? `${won.currency} ${won.amount}` : null } } as Prisma.InputJsonValue,
          ...client,
        },
        tx,
      );
    });
    noteActivity({ target: target.empId, description: `Set the ${dto.month} sales targets of ${target.empId}` });
    return this.row(actor, target.id);
  }

  // --------------------------------------------------------------------------------------------------------- helpers

  /** Who the caller's list shows: the team for sales.team / sales.all, otherwise only themselves. */
  peopleScope(a: SalesAccess): Prisma.EmployeeWhereInput {
    if (a.all) return {};
    if (a.team) return this.scope.employeeWhere(a.actor.id);
    return { id: a.actor.id };
  }

  /** The person whose targets the caller may set: the sales manager, someone below them, active, working on sales leads. */
  private async editable(actor: Actor, empId: string): Promise<{ id: string; empId: string }> {
    const a = await this.access.of(actor);
    if (!a.manage) forbidden('not_allowed', 'Only the sales manager sets sales targets');
    const p = await this.prisma.employee.findUnique({ where: { empId }, select: { id: true, empId: true, status: true } });
    if (!p) notFound('Employee not found');
    if (p.id === actor.id) forbidden('own_targets', 'Your own targets are set by your manager');
    if (!(await this.access.canManage(a, p.id))) forbidden('not_allowed', `${empId} is not in your sales team`);
    if (p.status !== 'active') badRequest('not_active', `${empId} is not an active employee`);
    if (!(await this.permissions.can(p.id, SALES_OWN))) badRequest('not_sales', `${empId} does not work on sales leads`);
    // The same sales-staff rule as the logs, reports and dashboard: the Sales department, or a sales manager.
    if (!(await this.metrics.isSalesperson(p.id))) badRequest('not_sales_staff', `${empId} is not sales staff (Sales department or sales manager)`);
    return { id: p.id, empId: p.empId };
  }

  /** The caller's view of one person's targets after a change. */
  private async row(actor: Actor, employeeId: string): Promise<SalesTargetsRowView> {
    const p = await this.prisma.employee.findUniqueOrThrow({ where: { id: employeeId }, select: { empId: true } });
    const found = (await this.list(actor)).find((x) => x.person.empId === p.empId);
    if (!found) notFound('Employee not found');
    return found;
  }
}

function pick<T extends object, K extends keyof T>(o: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) out[k] = o[k];
  return out;
}
