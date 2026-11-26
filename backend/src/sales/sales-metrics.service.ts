import { Injectable } from '@nestjs/common';
import {
  type Currency,
  SALES_DAILY_METRICS,
  SALES_UNMEASURED_METRICS,
  type SalesCurrencyTotals,
  type SalesDailyMetric,
  type SalesDailyTargetsView,
  type SalesMetricResult,
  type SalesMonthlyTargetsView,
} from '@aceva/contracts';
import { addDays, dbDate, firstDayOfMonth, nextMonth, pkInstant } from '../common/pakistan-time';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SALES_MANAGE, SALES_OWN } from './sales-access.service';
import type { Db } from './sales-errors';
import { person } from './sales-views';

type DailyTargetRow = Prisma.SalesDailyTargetGetPayload<{ include: { setBy: { select: { empId: true; fullName: true } } } }>;
type MonthlyTargetRow = Prisma.SalesMonthlyTargetGetPayload<{ include: { setBy: { select: { empId: true; fullName: true } } } }>;

/** The role of the sales staff (plan section 20: sales executives). */
/**
 * The Sales department, by its existing code (departments.code is fixed when a department is created and never edited; the
 * screens already read "dep-sales" as the Sales department).
 */
export const SALES_DEPARTMENT = 'dep-sales';

/** [start, end) of a Pakistan day, as instants. */
export const dayRange = (day: string) => ({ gte: pkInstant(day), lt: pkInstant(addDays(day, 1)) });
/** [start, end) of a month (Pakistan time), as instants. */
export const monthRange = (month: string) => ({ gte: pkInstant(firstDayOfMonth(month)), lt: pkInstant(firstDayOfMonth(nextMonth(month))) });

/**
 * Module 15.6: what is measured, against which targets (plan section 20; approved decisions 10-12 and the M15.6 answers).
 *  - leads added: leads the person added or imported (created_by) that Pakistan day;
 *  - follow-ups done: "follow-up done" activities the person recorded that day;
 *  - emails sent: "email sent" activities the person logged by hand that day (until Module 16 counts the real ones);
 *  - emails checked: NOT MEASURED YET (null, never 0) until Module 16;
 *  - monthly: meetings booked (meeting activities with a date), proposals sent (proposal activities with a link), and the
 *    value of the person's deals confirmed Won that month, per currency (never converted).
 * A day is met only when every target that is set and measured is met; with none, the result is null ("no targets").
 * Who is measured: the sales staff (salespeople() below), the same rule for targets, logs, reports and the dashboard.
 */
@Injectable()
export class SalesMetricsService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The sales staff (approved M15.6 rule): ACTIVE employees who either
   *  - belong to the Sales department (dep-sales, not archived) AND hold the sales-work permission sales.own, or
   *  - hold the sales-management permission sales.targets (the Director's role, or the sales_manager duty).
   * Being Level 4 or having the default "sales" role is not enough on its own: an HR, Finance or Engineering employee who
   * holds sales.own outside the Sales department is not sales staff. Permissions come from the role and active duties,
   * exactly as everywhere else. Reports already built are never touched by this rule (they are frozen rows).
   */
  async salespeople(db: Db = this.prisma, among?: Prisma.EmployeeWhereInput): Promise<Array<{ id: string; empId: string; fullName: string }>> {
    const eligible = await db.$queryRaw<Array<{ id: string }>>`
      SELECT e.id FROM employees e
      JOIN departments d ON d.id = e.department_id
      WHERE e.status = 'active' AND (
        (d.code = ${SALES_DEPARTMENT} AND d.archived_at IS NULL AND (
          EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = e.role_id AND p.key = ${SALES_OWN})
          OR EXISTS (SELECT 1 FROM employee_duties ed JOIN duty_permissions dp ON dp.duty_id = ed.duty_id JOIN permissions p ON p.id = dp.permission_id
                     WHERE ed.employee_id = e.id AND ed.ended_at IS NULL AND p.key = ${SALES_OWN})))
        OR EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = e.role_id AND p.key = ${SALES_MANAGE})
        OR EXISTS (SELECT 1 FROM employee_duties ed JOIN duty_permissions dp ON dp.duty_id = ed.duty_id JOIN permissions p ON p.id = dp.permission_id
                   WHERE ed.employee_id = e.id AND ed.ended_at IS NULL AND p.key = ${SALES_MANAGE}))`;
    if (!eligible.length) return [];
    return db.employee.findMany({
      where: { AND: [{ id: { in: eligible.map((r) => r.id) } }, ...(among ? [among] : [])] },
      select: { id: true, empId: true, fullName: true },
      orderBy: { empId: 'asc' },
    });
  }

  async isSalesperson(employeeId: string, db: Db = this.prisma): Promise<boolean> {
    return (await this.salespeople(db, { id: employeeId })).length > 0;
  }

  /** The daily targets in force on a day: the latest row of the latest effective day on or before it. */
  dailyTargetsOn(employeeId: string, day: string, db: Db = this.prisma): Promise<DailyTargetRow | null> {
    return db.salesDailyTarget.findFirst({
      where: { employeeId, effectiveFrom: { lte: dbDate(day) } },
      include: { setBy: { select: { empId: true, fullName: true } } },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
  }

  /** A change already set for a day after `day`, if any (the latest one). */
  dailyTargetsAfter(employeeId: string, day: string, db: Db = this.prisma): Promise<DailyTargetRow | null> {
    return db.salesDailyTarget.findFirst({
      where: { employeeId, effectiveFrom: { gt: dbDate(day) } },
      include: { setBy: { select: { empId: true, fullName: true } } },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
    });
  }

  monthlyTargets(employeeId: string, month: string, db: Db = this.prisma): Promise<MonthlyTargetRow | null> {
    return db.salesMonthlyTarget.findFirst({ where: { employeeId, month }, include: { setBy: { select: { empId: true, fullName: true } } }, orderBy: { createdAt: 'desc' } });
  }

  dailyTargetsView(r: DailyTargetRow | null): SalesDailyTargetsView | null {
    if (!r) return null;
    return {
      effectiveFrom: r.effectiveFrom.toISOString().slice(0, 10),
      leadsAdded: r.leadsAdded,
      emailsChecked: r.emailsChecked,
      emailsSent: r.emailsSent,
      followUpsDone: r.followUpsDone,
      setBy: person(r.setBy),
      setAt: r.createdAt.toISOString(),
    };
  }

  monthlyTargetsView(r: MonthlyTargetRow | null): SalesMonthlyTargetsView | null {
    if (!r) return null;
    return {
      month: r.month,
      meetingsBooked: r.meetingsBooked,
      proposalsSent: r.proposalsSent,
      wonValue: r.wonAmount && r.wonCurrency ? { amount: r.wonAmount.toFixed(2), currency: r.wonCurrency } : null,
      setBy: person(r.setBy),
      setAt: r.createdAt.toISOString(),
    };
  }

  /** The measured values of one Pakistan day (emails checked: null, not measured yet). */
  async dailyValues(employeeId: string, day: string, db: Db = this.prisma): Promise<Record<SalesDailyMetric, number | null>> {
    const range = dayRange(day);
    const [leadsAdded, followUpsDone, emailsSent] = await Promise.all([
      db.salesLead.count({ where: { createdBy: employeeId, createdAt: range } }),
      db.salesActivity.count({ where: { actorId: employeeId, kind: 'follow_up', occurredAt: range } }),
      db.salesActivity.count({ where: { actorId: employeeId, kind: 'email_sent', source: 'manual', occurredAt: range } }),
    ]);
    return { leadsAdded, emailsChecked: null, emailsSent, followUpsDone };
  }

  /** Each metric against its target, and the day's result (null: no measurable target set). */
  evaluate(values: Record<SalesDailyMetric, number | null>, targets: Pick<SalesDailyTargetsView, SalesDailyMetric> | null): { metrics: Record<SalesDailyMetric, SalesMetricResult>; met: boolean | null; unmeasured: SalesDailyMetric[] } {
    const metrics = {} as Record<SalesDailyMetric, SalesMetricResult>;
    for (const k of SALES_DAILY_METRICS) {
      const measured = !(SALES_UNMEASURED_METRICS as readonly string[]).includes(k);
      const value = measured ? values[k] : null;
      const target = targets?.[k] ?? null;
      metrics[k] = { value, measured, target, met: measured && target !== null && value !== null ? value >= target : null };
    }
    const judged = SALES_DAILY_METRICS.map((k) => metrics[k].met).filter((m): m is boolean => m !== null);
    return { metrics, met: judged.length ? judged.every(Boolean) : null, unmeasured: [...SALES_UNMEASURED_METRICS] };
  }

  /** The monthly figures: meetings booked, proposals sent, and the Won value per currency. */
  async monthValues(employeeId: string, month: string, db: Db = this.prisma): Promise<{ meetingsBooked: number; proposalsSent: number; won: SalesCurrencyTotals }> {
    const range = monthRange(month);
    const [meetingsBooked, proposalsSent, won] = await Promise.all([
      db.salesActivity.count({ where: { actorId: employeeId, kind: 'meeting', meetingAt: { not: null }, occurredAt: range } }),
      db.salesActivity.count({ where: { actorId: employeeId, kind: 'proposal', proposalUrl: { not: null }, occurredAt: range } }),
      db.salesDeal.groupBy({ by: ['currency'], where: { ownerId: employeeId, wonStatus: 'confirmed', wonConfirmedAt: range }, _sum: { value: true }, _count: { _all: true } }),
    ]);
    return { meetingsBooked, proposalsSent, won: currencyTotals(won) };
  }
}

/** Prisma groupBy rows (by currency) as totals per currency, never converted. */
export function currencyTotals(rows: Array<{ currency: Currency; _sum: { value: Prisma.Decimal | null }; _count: { _all: number } }>): SalesCurrencyTotals {
  return rows
    .map((r) => ({ currency: r.currency, total: r._sum.value ? r._sum.value.toFixed(2) : '0.00', count: r._count._all }))
    .sort((a, b) => a.currency.localeCompare(b.currency));
}
