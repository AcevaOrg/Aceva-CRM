import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type SalesDailyMetric, type SalesDailyReportView, type SalesMetricResult, type SalesProofStatus } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { ScopeService } from '../access/scope.service';
import { WorkCalendarService } from '../attendance/work-calendar.service';
import { Clock } from '../common/clock';
import { addDays, dayOf, dbDate, pkDate, pkInstant } from '../common/pakistan-time';
import { ENV } from '../config/config.module';
import { backgroundWorkersOn, type Env } from '../config/env';
import type { Prisma } from '../generated/prisma/client';
import { JobRunner } from '../jobs/job-runner.service';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { SALES_MANAGE, SalesAccessService } from './sales-access.service';
import { lockSalesDay, logCounts } from './sales-daily-log.service';
import { SalesMetricsService } from './sales-metrics.service';
import { SalesTargetsService } from './sales-targets.service';
import { person } from './sales-views';

type Tx = Prisma.TransactionClient;

export const SALES_DAILY_REPORT_JOB = 'sales.daily_report';
/** The nightly report runs at 00:30 Pakistan time (approved; the archive job runs separately at 02:00). */
const RUN_MINUTE = 30;
/** A night also builds any report missing from the days before (a server that was down, a failed run): up to 7 days. */
const CATCH_UP_DAYS = 7;

const reportInclude = {
  employee: { select: { id: true, empId: true, fullName: true } },
  log: { select: { version: true, linkedin: true, whatsapp: true, fiverr: true, calls: true, fieldVisits: true, note: true } },
} satisfies Prisma.SalesDailyReportInclude;
type ReportRow = Prisma.SalesDailyReportGetPayload<{ include: typeof reportInclude }>;

/**
 * Module 15.6, the nightly daily sales report (plan section 20: "built automatically every night for each salesperson from
 * the connected tools and the manual log, and compared with that day's targets"; "the next morning the sales manager sees
 * the whole team on one screen, and the Director gets it in the daily summary email").
 *
 * At 00:30 Pakistan time, for each working day (Module 7's calendar) that has just ended and every working day of the last
 * week still missing one, each salesperson gets one report: the targets in force that day, the measures, the latest log
 * version, and the result. Built under the person's day lock (the same lock as the log), inserted once (one per person
 * and day; the database refuses a second and never lets one change), so a retry, a second server or a run at the same
 * moment changes nothing. Then each active sales manager gets one sales_daily_report notification per day (Module 12).
 */
@Injectable()
export class SalesDailyReportService implements OnModuleInit {
  private readonly logger = new Logger('SalesDailyReport');

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: SalesAccessService,
    private readonly scope: ScopeService,
    private readonly metrics: SalesMetricsService,
    private readonly targets: SalesTargetsService,
    private readonly calendar: WorkCalendarService,
    private readonly notifications: NotificationService,
    private readonly jobs: JobRunner,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.jobs.register(SALES_DAILY_REPORT_JOB, async (payload) => {
      const day = String(payload.day);
      await this.runNight(day);
      await this.scheduleFor(addDays(day, 1));
    });
  }

  async onModuleInit(): Promise<void> {
    if (!backgroundWorkersOn(this.env)) return; // tests run the night themselves
    await this.scheduleFor(pkDate(this.clock.now()), true).catch((e) => this.logger.error(`Could not schedule the daily sales report: ${(e as Error).message}`));
  }

  /** The run of `day` at 00:30 Pakistan time (dedupe key sales.daily_report:<day>). */
  async scheduleFor(day: string, keepExisting = false): Promise<void> {
    const runAt = pkInstant(day, RUN_MINUTE);
    const dedupeKey = `${SALES_DAILY_REPORT_JOB}:${day}`;
    if (keepExisting) {
      await this.prisma.scheduledJob.createMany({ data: [{ type: SALES_DAILY_REPORT_JOB, dedupeKey, runAt, payload: { day } }], skipDuplicates: true });
      return;
    }
    if (await this.prisma.scheduledJob.findUnique({ where: { dedupeKey }, select: { id: true } })) return;
    await this.jobs.schedule(SALES_DAILY_REPORT_JOB, dedupeKey, runAt, { day }, null);
  }

  /** The night that starts `runDay`: the reports of the days before (yesterday first in importance, up to a week back). */
  async runNight(runDay: string): Promise<{ built: Record<string, number> }> {
    const built: Record<string, number> = {};
    for (let i = CATCH_UP_DAYS; i >= 1; i--) {
      const day = addDays(runDay, -i);
      if (!(await this.calendar.isWorkingDay(day))) continue;
      const n = await this.buildDay(day, `${SALES_DAILY_REPORT_JOB}:${runDay}`);
      if (n) built[day] = n;
    }
    if (Object.keys(built).length) this.logger.log(`${runDay}: ${JSON.stringify(built)} daily report(s) built`);
    return { built };
  }

  /** Builds the missing reports of one day. Returns how many were built now. */
  async buildDay(day: string, job: string): Promise<number> {
    const people = await this.metrics.salespeople();
    let made = 0;
    for (const p of people) {
      const created = await this.prisma.$transaction((tx) => this.buildOne(tx, p.id, day, job)).catch((error) => {
        this.logger.error(`The ${day} report of ${p.empId} was not built: ${(error as Error).message}`);
        return false;
      });
      if (created) made++;
    }
    if (made) await this.notifyManagers(day);
    return made;
  }

  /** One person's report of one day, unless it exists. */
  private async buildOne(tx: Tx, employeeId: string, day: string, job: string): Promise<boolean> {
    await lockSalesDay(tx, employeeId, day);
    if (await tx.salesDailyReport.findUnique({ where: { employeeId_day: { employeeId, day: dbDate(day) } }, select: { id: true } })) return false;
    const [targetRow, values, log] = await Promise.all([
      this.metrics.dailyTargetsOn(employeeId, day, tx),
      this.metrics.dailyValues(employeeId, day, tx),
      tx.salesDailyLog.findFirst({ where: { employeeId, day: dbDate(day) }, orderBy: { version: 'desc' }, select: { id: true } }),
    ]);
    const targets = this.metrics.dailyTargetsView(targetRow);
    const result = this.metrics.evaluate(values, targets);
    await tx.salesDailyReport.create({
      data: {
        employeeId,
        day: dbDate(day),
        generatedAt: this.clock.now(),
        job,
        targets: (targets ? { ...targets, setBy: targets.setBy?.empId ?? null } : null) as Prisma.InputJsonValue,
        metrics: result.metrics as unknown as Prisma.InputJsonValue,
        met: result.met,
        logId: log?.id ?? null,
      },
    });
    return true;
  }

  /** One notification per active sales manager and day: how many of their team met their targets. */
  private async notifyManagers(day: string): Promise<void> {
    const managers = await this.prisma.$queryRaw<Array<{ id: string }>>`
      SELECT DISTINCT e.id FROM employees e
      WHERE e.status = 'active' AND (
        EXISTS (SELECT 1 FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id WHERE rp.role_id = e.role_id AND p.key = ${SALES_MANAGE})
        OR EXISTS (SELECT 1 FROM employee_duties ed JOIN duty_permissions dp ON dp.duty_id = ed.duty_id JOIN permissions p ON p.id = dp.permission_id
                   WHERE ed.employee_id = e.id AND ed.ended_at IS NULL AND p.key = ${SALES_MANAGE}))`;
    for (const m of managers) {
      const reports = await this.prisma.salesDailyReport.findMany({ where: { day: dbDate(day), employee: this.scope.employeeWhere(m.id, 'below') }, select: { met: true } });
      if (!reports.length) continue;
      const judged = reports.filter((r) => r.met !== null);
      const met = judged.filter((r) => r.met).length;
      await this.prisma.$transaction((tx) =>
        this.notifications.create(tx, {
          recipientId: m.id,
          type: 'sales_daily_report',
          title: `Sales report of ${day} is ready`,
          body: judged.length ? `${met} of ${judged.length} met their targets (${reports.length} in the report).` : `${reports.length} in the report; no targets were set.`,
          link: `/sales/reports?date=${day}`,
          dedupeKey: `sales_daily_report:${m.id}:${day}`,
        }),
      );
    }
  }

  // ----------------------------------------------------------------------------------------------------------- reads

  /** GET /sales/reports/daily?day: the reports of a day for the people the caller sees (themselves for a salesperson). */
  async reports(actor: Actor, day: string): Promise<SalesDailyReportView[]> {
    const a = await this.access.of(actor);
    const rows = await this.prisma.salesDailyReport.findMany({ where: { day: dbDate(day), employee: this.targets.peopleScope(a) }, include: reportInclude, orderBy: { employee: { empId: 'asc' } } });
    const proofs = await this.prisma.salesProofRequest.findMany({ where: { day: dbDate(day), employeeId: { in: rows.map((r) => r.employeeId) } }, orderBy: { requestedAt: 'desc' }, select: { id: true, employeeId: true, status: true } });
    return rows.map((r) => reportView(r, proofs.find((p) => p.employeeId === r.employeeId) ?? null));
  }

  /** GET /sales/reports/daily/dates: the days that have reports the caller may see, newest first (up to 60). */
  async dates(actor: Actor): Promise<string[]> {
    const a = await this.access.of(actor);
    const rows = await this.prisma.salesDailyReport.findMany({ where: { employee: this.targets.peopleScope(a) }, distinct: ['day'], orderBy: { day: 'desc' }, take: 60, select: { day: true } });
    return rows.map((r) => dayOf(r.day));
  }
}

export function reportView(r: ReportRow, proof: { id: string; status: string } | null): SalesDailyReportView {
  const metrics = r.metrics as unknown as Record<SalesDailyMetric, SalesMetricResult>;
  return {
    id: r.id,
    person: person(r.employee),
    day: dayOf(r.day),
    generatedAt: r.generatedAt.toISOString(),
    metrics,
    unmeasured: (Object.keys(metrics) as SalesDailyMetric[]).filter((k) => !metrics[k].measured),
    met: r.met,
    log: r.log ? { version: r.log.version, counts: logCounts(r.log), note: r.log.note } : null,
    proof: proof ? { id: proof.id, status: proof.status as SalesProofStatus } : null,
  };
}
