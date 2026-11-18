import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ALERTS_CHECKED_LIMIT, type SecurityAlertView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { PermissionService } from '../access/permission.service';
import { ScopeService } from '../access/scope.service';
import { Clock } from '../common/clock';
import { noteActivity } from '../common/request-context';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { OutboxService } from '../events/outbox.service';
import { Prisma } from '../generated/prisma/client';
import { Mailer } from '../mail/mailer';
import { PrismaService } from '../prisma/prisma.service';
import { SettingsService } from '../settings/settings.service';
import { exportDataKind } from './rules/activity-classify';
import {
  ALERT_MAX_AGE_MS,
  ALERT_RULE_DEFAULTS,
  alertRuleSettingsSchema,
  canCheckAlert,
  FINANCE_ATTEMPT_WINDOW_MIN,
  financeAttemptsAlert,
  LARGE_EXPORT_WINDOW_MIN,
  largeExportAlert,
  pakistanClock,
  SALARY_CATEGORIES,
  SALARY_VIEW_WINDOW_MIN,
  salaryViewsAlert,
  windowBucket,
  type AlertRuleSettings,
  type AlertText,
} from './rules/alert-rules';

/** An alert to raise: the rule's words plus who, when and a key that makes raising it twice impossible. */
export interface NewAlert extends AlertText {
  employeeId: string;
  empId: string;
  occurredAt: Date;
  /** One alert per triggering event or time window: the same key never raises a second alert. */
  dedupeKey: string;
  data?: Record<string, unknown>;
}

/** The flagged activity an alert rule looks at (the payload of activity.flagged). */
export interface FlaggedActivity {
  eventId: string;
  empId: string;
  kind: 'finance_blocked' | 'salary_view' | 'export';
  at: string;
  module: string;
  rows: number | null;
}

/** The settings section the alert rules read (plan section 17 "alert rules"). */
export const ALERT_SETTINGS_SECTION = 'alert-rules';

/**
 * Security alerts (plan section 8 "Alerts the system raises"): stored in security_alerts (insert-only), mailed to the
 * Director and the CTO, and marked as checked with a note by a reviewer (security_alert_checks; the alert itself never
 * changes). The CEO / Founder / Owner sees every alert and checks none.
 */
@Injectable()
export class ActivityAlertsService {
  private readonly logger = new Logger('SecurityAlerts');

  constructor(
    private readonly prisma: PrismaService,
    private readonly outbox: OutboxService,
    private readonly settings: SettingsService,
    private readonly permissions: PermissionService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly mailer: Mailer,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** The alert-rules settings (stored values over the defaults; a broken stored row falls back to the defaults). */
  rules(): Promise<AlertRuleSettings> {
    return this.settings.read<AlertRuleSettings>(ALERT_SETTINGS_SECTION, alertRuleSettingsSchema, ALERT_RULE_DEFAULTS);
  }

  /** Only fresh activity raises alerts (a backlog of last month's logins is recorded, but raises nothing). */
  isFresh(at: Date): boolean {
    return this.clock.now().getTime() - at.getTime() <= ALERT_MAX_AGE_MS;
  }

  /**
   * Stores an alert and, in the same transaction, the activity.alert.raised event (which mails the Director and the
   * CTO). Returns false when an alert with the same key already exists (a retried rule never raises twice).
   */
  async raise(tx: Prisma.TransactionClient, alert: NewAlert): Promise<boolean> {
    const id = randomUUID();
    const created = await tx.securityAlert.createManyAndReturn({
      data: [
        {
          id,
          kind: alert.kind,
          rule: alert.rule.slice(0, 200),
          severity: alert.severity,
          employeeId: alert.employeeId,
          occurredAt: alert.occurredAt,
          details: alert.details.slice(0, 1000),
          data: alert.data ? (alert.data as Prisma.InputJsonValue) : undefined,
          dedupeKey: alert.dedupeKey.slice(0, 200),
        },
      ],
      skipDuplicates: true,
      select: { id: true },
    });
    if (!created.length) return false;
    await this.outbox.emit(
      { type: 'activity.alert.raised', actor: 'system', payload: { alertId: id, kind: alert.kind, severity: alert.severity, empId: alert.empId as `ACV-${string}` } },
      tx,
    );
    return true;
  }

  /** Runs the rules on activity that an alert may follow from (written to the outbox as activity.flagged). */
  async evaluate(flag: FlaggedActivity): Promise<void> {
    const at = new Date(flag.at);
    if (!this.isFresh(at)) return;
    const employee = await this.prisma.employee.findUnique({ where: { empId: flag.empId }, select: { id: true } });
    if (!employee) return;
    const rules = await this.rules();

    if (flag.kind === 'export') {
      const dataKind = exportDataKind(flag.module);
      if (!dataKind || flag.rows === null || flag.rows < rules.largeExportRows) return;
      const text = largeExportAlert({ rows: flag.rows, module: flag.module, dataKind });
      // One alert per person, kind of data and window: a burst of large exports is one alert (and one mail), not one each.
      // Every export is still in the activity log.
      const since = new Date(at.getTime() - LARGE_EXPORT_WINDOW_MIN * 60_000);
      if (await this.recentAlert(employee.id, 'large_export', since, text.rule)) return;
      await this.prisma.$transaction((tx) =>
        this.raise(tx, {
          ...text,
          employeeId: employee.id,
          empId: flag.empId,
          occurredAt: at,
          dedupeKey: `large_export:${employee.id}:${dataKind}:${windowBucket(at, LARGE_EXPORT_WINDOW_MIN)}`,
          data: { eventId: flag.eventId, rows: flag.rows, module: flag.module },
        }),
      );
      return;
    }

    if (flag.kind === 'finance_blocked') {
      const since = new Date(at.getTime() - FINANCE_ATTEMPT_WINDOW_MIN * 60_000);
      const attempts = await this.prisma.activityEvent.findMany({
        where: { employeeId: employee.id, action: 'blocked', financeLinked: true, occurredAt: { gt: since, lte: at } },
        orderBy: { occurredAt: 'asc' },
        select: { module: true },
      });
      if (attempts.length < rules.financeAttempts) return;
      if (await this.recentAlert(employee.id, 'finance_attempts', since)) return; // one alert per person and window
      // The modules come from the server's own label of each page or route (never from text the browser sent).
      const modules = [...new Set(attempts.map((a) => a.module))].slice(0, 6);
      await this.prisma.$transaction((tx) =>
        this.raise(tx, {
          ...financeAttemptsAlert({ count: attempts.length, minutes: FINANCE_ATTEMPT_WINDOW_MIN, modules }),
          employeeId: employee.id,
          empId: flag.empId,
          occurredAt: at,
          dedupeKey: `finance_attempts:${employee.id}:${windowBucket(at, FINANCE_ATTEMPT_WINDOW_MIN)}`,
          data: { attempts: attempts.length },
        }),
      );
      return;
    }

    // salary_view: many salary, bank or payslip records opened in one hour
    const since = new Date(at.getTime() - SALARY_VIEW_WINDOW_MIN * 60_000);
    const views = await this.prisma.activityEvent.count({
      where: {
        employeeId: employee.id,
        action: 'sensitive_view',
        occurredAt: { gt: since, lte: at },
        AND: [
          { OR: SALARY_CATEGORIES.map((category) => ({ details: { path: ['category'], equals: category } })) },
          // Showing yourself your own salary or bank number is not opening someone's records.
          { OR: [{ target: null }, { target: { not: flag.empId } }] },
        ],
      },
    });
    if (views < rules.salaryViewsPerHour) return;
    if (await this.recentAlert(employee.id, 'salary_views', since)) return;
    await this.prisma.$transaction((tx) =>
      this.raise(tx, {
        ...salaryViewsAlert({ count: views, minutes: SALARY_VIEW_WINDOW_MIN }),
        employeeId: employee.id,
        empId: flag.empId,
        occurredAt: at,
        dedupeKey: `salary_views:${employee.id}:${windowBucket(at, SALARY_VIEW_WINDOW_MIN)}`,
        data: { views },
      }),
    );
  }

  private async recentAlert(employeeId: string, kind: 'finance_attempts' | 'salary_views' | 'large_export', since: Date, rule?: string): Promise<boolean> {
    return (await this.prisma.securityAlert.count({ where: { employeeId, kind, ...(rule ? { rule } : {}), occurredAt: { gt: since } } })) > 0;
  }

  // ------------------------------------------------------------------------------------------- reading and checking

  /**
   * The alerts, newest first (activity.security: the Director, the CTO and the CEO / Founder / Owner): EVERY open alert
   * (an unchecked alert is never cut off, however old) plus the newest ALERTS_CHECKED_LIMIT checked ones.
   */
  async list(status: 'open' | 'checked' | 'all' = 'all'): Promise<SecurityAlertView[]> {
    const [open, checked] = await Promise.all([
      status === 'checked' ? [] : this.prisma.securityAlert.findMany({ where: { check: { is: null } }, orderBy: { occurredAt: 'desc' }, include: ALERT_INCLUDE }),
      status === 'open' ? [] : this.prisma.securityAlert.findMany({ where: { check: { isNot: null } }, orderBy: { occurredAt: 'desc' }, take: ALERTS_CHECKED_LIMIT, include: ALERT_INCLUDE }),
    ]);
    return [...open, ...checked].sort((a, b) => b.occurredAt.getTime() - a.occurredAt.getTime()).map(toAlertView);
  }

  /**
   * Marks an alert as checked with the reviewer's note. Maker-checker: never an alert about yourself; a manager above
   * the person checks it (the CTO checks alerts about the Director, the Director those about the CEO / Founder / Owner).
   * An alert is checked once; the check is a new row and the alert never changes.
   */
  async check(actor: Actor, alertId: string, note: string, client: RequestInfo): Promise<SecurityAlertView> {
    const alert = await this.prisma.securityAlert.findUnique({
      where: { id: alertId },
      select: { id: true, rule: true, kind: true, employeeId: true, employee: { select: { empId: true, role: { select: { key: true } } } }, check: { select: { id: true } } },
    });
    if (!alert) throw new NotFoundException('Alert not found');
    const access = await this.permissions.getEffectiveAccess(actor.id);
    const below = alert.employeeId !== actor.id && (await this.scope.canAccess(actor.id, alert.employeeId, 'below'));
    if (!canCheckAlert({ id: actor.id, roleKey: actor.roleKey, permissions: access.permissions }, { id: alert.employeeId, roleKey: alert.employee.role.key }, below)) {
      await this.audit.record({ actorId: actor.id, action: 'access.denied', targetType: 'security_alert', targetId: alert.id, outcome: 'denied', reason: alert.employeeId === actor.id ? 'own_alert' : 'not_above_person', ...client });
      throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message: alert.employeeId === actor.id ? 'This alert is about you: a manager above you checks it' : 'This alert is checked by a manager above this person' });
    }
    if (alert.check) throw new ConflictException({ statusCode: 409, code: 'already_checked', message: 'This alert has already been checked' });
    try {
      await this.prisma.securityAlertCheck.create({ data: { alertId: alert.id, checkedBy: actor.id, note, checkedAt: this.clock.now() } });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException({ statusCode: 409, code: 'already_checked', message: 'This alert has already been checked' });
      }
      throw error;
    }
    await this.audit.record({ actorId: actor.id, action: 'activity.alert.checked', targetType: 'security_alert', targetId: alert.id, reason: note, details: { kind: alert.kind, empId: alert.employee.empId }, ...client });
    noteActivity({ target: alert.employee.empId, description: `Marked the alert "${alert.rule}" about ${alert.employee.empId} as checked` });
    return toAlertView(await this.prisma.securityAlert.findUniqueOrThrow({ where: { id: alert.id }, include: ALERT_INCLUDE }));
  }

  // ------------------------------------------------------------------------------------------- mail

  /**
   * Mails a new alert to the Director and the CTO (their official acevatech.com addresses), through the normal mailer
   * (Mailpit during development). Throws when sending fails, so the outbox dispatcher tries again later.
   */
  async mail(alertId: string): Promise<number> {
    const alert = await this.prisma.securityAlert.findUnique({ where: { id: alertId }, include: { employee: { select: { empId: true, fullName: true } } } });
    if (!alert) return 0;
    const recipients = await this.prisma.employee.findMany({
      where: { status: { not: 'left' }, role: { key: { in: ['director', 'cto'] } }, officialEmail: { not: null } },
      select: { officialEmail: true, fullName: true },
    });
    const link = `${this.env.APP_URL}/activity?tab=alerts`;
    const when = `${alert.occurredAt.toISOString().slice(0, 10)} ${pakistanClock(alert.occurredAt)} (Pakistan time)`;
    const who = `${alert.employee.fullName} (${alert.employee.empId})`;
    for (const r of recipients) {
      await this.mailer.send({
        to: r.officialEmail!,
        subject: `Security alert: ${alert.rule} (${alert.employee.empId})`,
        text: `Hello ${r.fullName},\n\nA security alert was raised.\n\nRule: ${alert.rule} (${alert.severity})\nWho: ${who}\nWhen: ${when}\n${alert.details}\n\nOpen the alerts to check it: ${link}\n`,
        html: `<p>Hello ${escapeHtml(r.fullName)},</p><p>A security alert was raised.</p><p><strong>${escapeHtml(alert.rule)}</strong> (${alert.severity})<br>Who: ${escapeHtml(who)}<br>When: ${escapeHtml(when)}</p><p>${escapeHtml(alert.details)}</p><p><a href="${link}">Open the alerts</a> to check it.</p>`,
      });
    }
    if (!recipients.length) this.logger.warn(`Alert ${alert.id}: nobody to mail (no Director or CTO with an official email)`);
    return recipients.length;
  }
}

const ALERT_INCLUDE = {
  employee: { select: { empId: true } },
  check: { include: { checker: { select: { empId: true } } } },
} satisfies Prisma.SecurityAlertInclude;

function toAlertView(r: Prisma.SecurityAlertGetPayload<{ include: typeof ALERT_INCLUDE }>): SecurityAlertView {
  return {
    id: r.id,
    rule: r.rule,
    severity: r.severity,
    empId: r.employee.empId,
    at: r.occurredAt.toISOString(),
    details: r.details,
    status: r.check ? 'checked' : 'open',
    kind: r.kind,
    ...(r.check ? { checkedBy: r.check.checker.empId, checkedAt: r.check.checkedAt.toISOString(), note: r.check.note } : {}),
  };
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
