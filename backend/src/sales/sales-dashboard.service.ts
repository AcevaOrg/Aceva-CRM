import { Injectable } from '@nestjs/common';
import {
  SALES_DEAL_STAGES,
  SALES_OPEN_STAGES,
  type SalesDashboardView,
  type SalesDealStage,
  type SalesMetricResult,
  type SalesPersonProgressView,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { Clock } from '../common/clock';
import { addDays, dayOf, dbDate, isoWeekday, monthOf, pkDate } from '../common/pakistan-time';
import { PrismaService } from '../prisma/prisma.service';
import { DealsService } from './deals.service';
import { type SalesAccess, SalesAccessService } from './sales-access.service';
import { forbidden, notFound } from './sales-errors';
import { currencyTotals, dayRange, monthRange, SalesMetricsService } from './sales-metrics.service';
import { SalesTargetsService } from './sales-targets.service';
import { person } from './sales-views';

/** The stage that comes right after each stage (Won after Negotiation); Lost has none. */
const NEXT: Partial<Record<SalesDealStage, SalesDealStage>> = Object.fromEntries(
  SALES_DEAL_STAGES.slice(0, SALES_DEAL_STAGES.indexOf('won')).map((s, i) => [s, SALES_DEAL_STAGES[i + 1]]),
) as Partial<Record<SalesDealStage, SalesDealStage>>;

/**
 * Module 15.6, the sales dashboard (plan section 20: "pipeline value by stage, deals won and lost this month, how many deals
 * move from one stage to the next, leads by source and country, and activity per person this week"), plus each person's
 * target progress. Approved rules: every money figure is a total per currency (USD and PKR apart, never converted, no
 * exchange rate); a move "to the next stage" is counted only from the stage history, only between consecutive stages
 * (New to Contacted, ..., Negotiation to Won), never guessed from where deals are now; no forecast. The team (sales.team /
 * sales.all) or, for a salesperson, only their own deals and figures.
 */
@Injectable()
export class SalesDashboardService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: SalesAccessService,
    private readonly deals: DealsService,
    private readonly metrics: SalesMetricsService,
    private readonly targets: SalesTargetsService,
    private readonly clock: Clock,
  ) {}

  private today(): string {
    return pkDate(this.clock.now());
  }

  /** GET /sales/dashboard?month */
  async dashboard(actor: Actor, month?: string): Promise<SalesDashboardView> {
    const a = await this.access.of(actor);
    const m = month ?? monthOf(this.today());
    const dealScope = this.deals.dealWhere(a);
    const leadScope = this.access.leadWhere(a);
    const range = monthRange(m);
    const [pipeline, won, lost, moves, bySource, byCountry] = await Promise.all([
      this.prisma.salesDeal.groupBy({ by: ['stage', 'currency'], where: { AND: [dealScope, { stage: { in: [...SALES_OPEN_STAGES] }, archivedAt: null }] }, _sum: { value: true }, _count: { _all: true } }),
      this.prisma.salesDeal.groupBy({ by: ['currency'], where: { AND: [dealScope, { wonStatus: 'confirmed', wonConfirmedAt: range }] }, _sum: { value: true }, _count: { _all: true } }),
      this.prisma.salesDeal.groupBy({ by: ['currency'], where: { AND: [dealScope, { stage: 'lost', closedAt: range }] }, _sum: { value: true }, _count: { _all: true } }),
      this.prisma.salesDealHistory.findMany({ where: { at: range, event: { in: ['stage_changed', 'won_confirmed'] }, deal: dealScope }, select: { fromStage: true, toStage: true } }),
      this.prisma.salesLead.groupBy({ by: ['source'], where: { AND: [leadScope, { archivedAt: null }] }, _count: { _all: true } }),
      this.prisma.salesLead.groupBy({ by: ['country'], where: { AND: [leadScope, { archivedAt: null }] }, _count: { _all: true } }),
    ]);
    const moveCounts = new Map<string, number>();
    for (const h of moves) {
      if (!h.fromStage || !h.toStage || NEXT[h.fromStage] !== h.toStage) continue;
      const key = `${h.fromStage}>${h.toStage}`;
      moveCounts.set(key, (moveCounts.get(key) ?? 0) + 1);
    }
    const people = await this.metrics.salespeople(this.prisma, this.targets.peopleScope(a));
    return {
      month: m,
      pipeline: SALES_OPEN_STAGES.map((stage) => {
        const rows = pipeline.filter((r) => r.stage === stage);
        return { stage, count: rows.reduce((n, r) => n + r._count._all, 0), totals: currencyTotals(rows) };
      }),
      won: { count: won.reduce((n, r) => n + r._count._all, 0), totals: currencyTotals(won) },
      lost: { count: lost.reduce((n, r) => n + r._count._all, 0), totals: currencyTotals(lost) },
      stageMoves: (Object.entries(NEXT) as Array<[SalesDealStage, SalesDealStage]>).map(([from, to]) => ({ from, to, count: moveCounts.get(`${from}>${to}`) ?? 0 })),
      leadsBySource: bySource.map((r) => ({ source: r.source, count: r._count._all })).sort((x, y) => y.count - x.count),
      leadsByCountry: byCountry.map((r) => ({ country: r.country ?? 'Unknown', count: r._count._all })).sort((x, y) => y.count - x.count),
      people: await Promise.all(people.map((p) => this.progressOf(p, m))),
    };
  }

  /** GET /sales/progress?empId: one person's progress today and this month (the caller, or someone they see). */
  async progress(actor: Actor, empId?: string): Promise<SalesPersonProgressView> {
    const a = await this.access.of(actor);
    const p = await this.prisma.employee.findUnique({ where: { empId: empId ?? actor.empId }, select: { id: true, empId: true, fullName: true } });
    if (!p) notFound('Employee not found');
    if (p.id !== actor.id && !(await this.sees(a, p.id))) forbidden('not_allowed', "Only the sales manager sees someone else's progress");
    return this.progressOf(p, monthOf(this.today()));
  }

  private async sees(a: SalesAccess, employeeId: string): Promise<boolean> {
    return a.all || (a.team && (await this.access.seesFull(a, employeeId)));
  }

  private async progressOf(p: { id: string; empId: string; fullName: string }, month: string): Promise<SalesPersonProgressView> {
    const today = this.today();
    const [targetRow, values, lastReport, monthTargets, monthValues, week] = await Promise.all([
      this.metrics.dailyTargetsOn(p.id, today),
      this.metrics.dailyValues(p.id, today),
      this.prisma.salesDailyReport.findFirst({ where: { employeeId: p.id, day: { lt: dbDate(today) } }, orderBy: { day: 'desc' }, select: { day: true, met: true } }),
      this.metrics.monthlyTargets(p.id, month),
      this.metrics.monthValues(p.id, month),
      this.week(p.id, today),
    ]);
    const evaluated = this.metrics.evaluate(values, this.metrics.dailyTargetsView(targetRow));
    const monthMetric = (value: number, target: number | null): SalesMetricResult => ({ value, measured: true, target, met: target === null ? null : value >= target });
    const wonTarget = monthTargets?.wonAmount && monthTargets.wonCurrency ? { amount: monthTargets.wonAmount.toFixed(2), currency: monthTargets.wonCurrency } : null;
    const inTarget = wonTarget ? (monthValues.won.find((t) => t.currency === wonTarget.currency)?.total ?? '0.00') : null;
    return {
      person: person(p),
      today: { day: today, metrics: evaluated.metrics, met: evaluated.met },
      lastReport: lastReport ? { day: dayOf(lastReport.day), met: lastReport.met } : null,
      month: {
        meetingsBooked: monthMetric(monthValues.meetingsBooked, monthTargets?.meetingsBooked ?? null),
        proposalsSent: monthMetric(monthValues.proposalsSent, monthTargets?.proposalsSent ?? null),
        // Only deals in the target's currency count toward it; the other currency is listed apart (never converted).
        wonValue: { target: wonTarget, inTargetCurrency: inTarget, met: wonTarget && inTarget !== null ? Number(inTarget) >= Number(wonTarget.amount) : null, byCurrency: monthValues.won },
      },
      week,
    };
  }

  /** This week, Monday to today (Pakistan time): logged contacts and follow-ups, and the self-reported log totals. */
  private async week(employeeId: string, today: string): Promise<SalesPersonProgressView['week']> {
    const monday = addDays(today, -(isoWeekday(today) - 1));
    const range = { gte: dayRange(monday).gte, lt: dayRange(today).lt };
    const kinds = await this.prisma.salesActivity.groupBy({ by: ['kind'], where: { actorId: employeeId, occurredAt: range, kind: { in: ['call', 'email_sent', 'reply', 'meeting', 'follow_up'] } }, _count: { _all: true } });
    const count = (k: string) => kinds.find((x) => x.kind === k)?._count._all ?? 0;
    const logs = await this.prisma.salesDailyLog.findMany({ where: { employeeId, day: { gte: dbDate(monday), lte: dbDate(today) } }, orderBy: [{ day: 'asc' }, { version: 'desc' }], distinct: ['day'] });
    const selfReported = logs.reduce((n, l) => n + l.linkedin + l.whatsapp + l.fiverr + l.calls + l.fieldVisits, 0);
    return { calls: count('call'), emailsSent: count('email_sent'), replies: count('reply'), meetings: count('meeting'), followUps: count('follow_up'), selfReported };
  }
}
