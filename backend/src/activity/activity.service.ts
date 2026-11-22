import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  AccountLockView,
  ActivityEventsQuery,
  ActivityEventView,
  DailySummaryView,
  ExportLogRequest,
  LogoutHow,
  MyActivityResponse,
  OnlineSessionView,
  ScreenViewRequest,
  SignalResponse,
  TimelineResponse,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { PermissionService } from '../access/permission.service';
import { ScopeService } from '../access/scope.service';
import { IDLE_LIMIT_MS } from '../auth/session/session.service';
import { Clock } from '../common/clock';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ActivityRecorder } from './activity-recorder.service';
import { ActivitySummaryService } from './activity-summary.service';
import { activityAccess, PersonSignalThrottle, screenWords, SignalThrottle, timelineView, type ActivityAccess } from './rules/activity-access';
import { changesFromAudit, type FieldDiff } from './rules/activity-changes';
import { deviceLabel, financeScreenAccess, isFinanceModule, moduleOf } from './rules/activity-classify';
import { dayWindow, daysBetween, MINUTE_MS, pakistanDay, sessionStateNow } from './rules/activity-time';

/** Activity search returns at most this many rows (newest first); narrow the filters for more. */
export const SEARCH_LIMIT = 2000;
/** Daily summaries cover at most this many days per request. */
export const MAX_SUMMARY_DAYS = 31;
/** "My activity" shows the person's own records of the last 14 days. */
const MY_DAYS = 14;

const LOGOUT_HOWS = new Set<LogoutHow>(['clicked', 'timed_out', 'forced', 'password_changed']);

const eventSelect = {
  id: true,
  occurredAt: true,
  source: true,
  action: true,
  module: true,
  target: true,
  description: true,
  ip: true,
  city: true,
  device: true,
  requestId: true,
  sessionId: true,
  details: true,
  employee: { select: { empId: true } },
} satisfies Prisma.ActivityEventSelect;

type EventRow = Prisma.ActivityEventGetPayload<{ select: typeof eventSelect }>;

/**
 * Module 4 reading side and the browser's signals (plan section 8, spec section 9.4). Who sees what is decided by
 * rules/activity-access.ts; whose data is decided in the database by ScopeService (self, or the people below the caller
 * in the reporting line; for the CEO / Founder / Owner that is everyone). Tracking data is never changed or deleted
 * here: there is no such request.
 */
@Injectable()
export class ActivityService {
  /** A tab sends one heartbeat a minute; a few tabs share one session. More than this is ignored. */
  private readonly heartbeats = new SignalThrottle(6, 60_000);
  /** Screens opened, per session and minute. */
  private readonly screens = new SignalThrottle(60, 60_000);
  /**
   * Export records, per session AND per person and minute. Each one is a permanent row and, for a large export of finance
   * or employee data, can start an alert mail: a person who signs in again gets no new allowance.
   */
  private readonly exports = new PersonSignalThrottle(10, 20, 60_000);

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
    private readonly recorder: ActivityRecorder,
    private readonly summaries: ActivitySummaryService,
    private readonly clock: Clock,
  ) {}

  async accessOf(actor: Actor): Promise<{ access: ActivityAccess; permissions: Set<string> }> {
    const { permissions } = await this.permissions.getEffectiveAccess(actor.id);
    return { access: activityAccess(permissions), permissions };
  }

  // ------------------------------------------------------------------------------------------- signals from the browser

  /** POST /activity/heartbeat: one "still here" a minute, only whether the mouse or keyboard was used. */
  heartbeat(actor: Actor, sessionId: string | null, active: boolean): SignalResponse {
    const now = this.clock.now();
    if (!sessionId || !this.heartbeats.allow(sessionId, now.getTime())) return { ok: true, recorded: false };
    this.recorder.heartbeat({ sessionId, employeeId: actor.id, at: now, active });
    return { ok: true, recorded: true };
  }

  /**
   * POST /activity/screen: a screen was opened. Opening a finance screen without the permission for it is recorded as a
   * blocked attempt instead (the website shows "not found"; repeated attempts raise an alert).
   */
  async screen(actor: Actor, sessionId: string | null, dto: ScreenViewRequest, request: { ip: string | null; requestId: string | null }): Promise<SignalResponse> {
    const now = this.clock.now();
    if (!sessionId || !this.screens.allow(sessionId, now.getTime())) return { ok: true, recorded: false };
    const path = dto.path?.split(/[?#]/)[0] ?? null;
    const finance = path ? financeScreenAccess(path, (await this.accessOf(actor)).permissions) : null;
    const module = path ? moduleOf(path) : 'System';
    const refused = finance !== null && !finance.allowed;
    // A refused finance screen is worded from the server's module of the page: those words reach the alert mail.
    const words = screenWords({ label: dto.screen, module, refused });
    this.recorder.record({
      employeeId: actor.id,
      empId: actor.empId,
      occurredAt: now,
      action: refused ? 'blocked' : 'screen_view',
      module,
      target: words.target,
      description: words.description,
      sessionId,
      ip: request.ip,
      requestId: request.requestId,
      financeLinked: finance !== null,
      details: { screen: dto.screen, ...(path ? { path } : {}) },
    });
    return { ok: true, recorded: true };
  }

  /**
   * POST /activity/export: the screens build the file; the server records that the export happened. A flood from one
   * session or one person is ignored (recorded: false), so it cannot fill the tables or the Director's mailbox.
   */
  logExport(actor: Actor, sessionId: string | null, dto: ExportLogRequest, request: { ip: string | null; requestId: string | null }): SignalResponse {
    const now = this.clock.now();
    if (!this.exports.allow(actor.id, sessionId, now.getTime())) return { ok: true, recorded: false };
    const module = dto.module ?? 'Activity';
    const what = dto.dataset ?? `${module} data`;
    this.recorder.record({
      employeeId: actor.id,
      empId: actor.empId,
      occurredAt: now,
      action: 'export',
      module,
      target: dto.dataset ?? null,
      description: `Exported ${dto.rows.toLocaleString('en-US')} rows of ${what} (${dto.format.toUpperCase()})`,
      sessionId,
      ip: request.ip,
      requestId: request.requestId,
      financeLinked: isFinanceModule(module),
      details: { rows: dto.rows, format: dto.format, ...(dto.dataset ? { dataset: dto.dataset } : {}) },
    });
    return { ok: true, recorded: true };
  }

  // ------------------------------------------------------------------------------------------- online now

  /** GET /activity/online: live sessions of the people below the caller (activity.view_all). */
  async online(actor: Actor): Promise<OnlineSessionView[]> {
    const now = this.clock.now();
    const sessions = await this.prisma.session.findMany({
      where: {
        revokedAt: null,
        absoluteExpiresAt: { gt: now },
        // PostgreSQL's "last active" time lags up to a minute behind Redis; a session idle longer than the limit is over.
        lastActiveAt: { gt: new Date(now.getTime() - IDLE_LIMIT_MS - MINUTE_MS) },
        employee: { ...this.scope.employeeWhere(actor.id, 'below'), status: { not: 'left' } },
      },
      orderBy: { createdAt: 'asc' },
      select: { id: true, createdAt: true, lastActiveAt: true, device: true, browser: true, os: true, city: true, employee: { select: { empId: true } } },
    });
    if (!sessions.length) return [];
    const ids = sessions.map((s) => s.id);
    const [screens, beats, uses, logins] = await Promise.all([
      // The last screen opened in each session, also when it was refused (the person is looking at "not found").
      this.prisma.$queryRaw<Array<{ session_id: string; target: string | null }>>`
        SELECT DISTINCT ON (session_id) session_id, target FROM activity_events
        WHERE session_id = ANY(${ids}::uuid[]) AND (action = 'screen_view' OR (action = 'blocked' AND details->>'screen' IS NOT NULL))
        ORDER BY session_id, occurred_at DESC`,
      this.prisma.activityHeartbeat.groupBy({ by: ['sessionId'], where: { sessionId: { in: ids }, active: true }, _max: { at: true } }),
      this.prisma.activityEvent.groupBy({ by: ['sessionId'], where: { sessionId: { in: ids }, action: { notIn: ['login', 'logout'] } }, _max: { occurredAt: true } }),
      this.prisma.activityEvent.findMany({ where: { sessionId: { in: ids }, action: 'login' }, select: { sessionId: true, details: true } }),
    ]);
    const screenOf = new Map(screens.map((s) => [s.session_id, s.target]));
    const beatOf = new Map(beats.map((b) => [b.sessionId, b._max.at]));
    const useOf = new Map(uses.map((u) => [u.sessionId, u._max.occurredAt]));
    const newDeviceOf = new Map(logins.map((l) => [l.sessionId, (l.details as { newDevice?: unknown } | null)?.newDevice === true]));
    return sessions.map((s) => {
      const lastUse = Math.max(s.lastActiveAt.getTime(), beatOf.get(s.id)?.getTime() ?? 0, useOf.get(s.id)?.getTime() ?? 0);
      return {
        sessionId: s.id,
        empId: s.employee.empId,
        since: s.createdAt.toISOString(),
        currentScreen: screenOf.get(s.id) ?? '—',
        state: sessionStateNow(new Date(lastUse), now),
        device: deviceLabel(s),
        city: s.city ?? 'Unknown',
        ...(newDeviceOf.get(s.id) ? { newDevice: true } : {}),
      };
    });
  }

  // ------------------------------------------------------------------------------------------- activity search

  /**
   * GET /activity/events: the CEO / Founder / Owner and the Director (activity.view_all and audit.view) search everyone in
   * their reporting line; everyone else gets only their own records. Newest first, at most SEARCH_LIMIT rows.
   */
  async events(actor: Actor, q: ActivityEventsQuery): Promise<ActivityEventView[]> {
    const { access } = await this.accessOf(actor);
    const and: Prisma.ActivityEventWhereInput[] = [access.search ? { employee: this.scope.employeeWhere(actor.id) } : { employeeId: actor.id }];
    if (q.empId) and.push({ employee: { empId: q.empId } });
    if (q.departmentId) and.push({ employee: { department: { code: q.departmentId } } });
    if (q.module) and.push({ module: q.module });
    if (q.action) and.push({ action: q.action });
    if (q.source) and.push({ source: q.source });
    if (q.from) and.push({ occurredAt: { gte: dayWindow(q.from).start } });
    if (q.to) and.push({ occurredAt: { lt: dayWindow(q.to).end } });
    const rows = await this.prisma.activityEvent.findMany({ where: { AND: and }, orderBy: { occurredAt: 'desc' }, take: SEARCH_LIMIT, select: eventSelect });
    return this.views(rows);
  }

  // ------------------------------------------------------------------------------------------- reports and timeline

  /** GET /activity/summaries: daily summaries of the people below the caller (activity.view_team or view_all). */
  async dailySummaries(actor: Actor, from: string, to: string, client: RequestInfo): Promise<DailySummaryView[]> {
    const { access } = await this.accessOf(actor);
    if (!access.reports) await this.deny(actor, 'activity.summaries', null, client);
    if (daysBetween(from, to).length > MAX_SUMMARY_DAYS) {
      throw new BadRequestException({ statusCode: 400, code: 'range_too_long', message: `Choose at most ${MAX_SUMMARY_DAYS} days` });
    }
    const people = await this.prisma.employee.findMany({ where: this.scope.employeeWhere(actor.id, 'below'), select: { id: true, empId: true } });
    return this.summaries.summaries(people, from, to);
  }

  /**
   * GET /activity/timeline: one person, one day, in order. Your own always; someone below you with the timeline right
   * (CTO: developers; Director: their line; CEO / Founder / Owner: everyone). Without activity.view_all only the day summary.
   */
  async timeline(actor: Actor, empId: string, date: string, client: RequestInfo): Promise<TimelineResponse> {
    const person = await this.prisma.employee.findUnique({ where: { empId }, select: { id: true, empId: true } });
    if (!person) throw new NotFoundException('Employee not found');
    const isSelf = person.id === actor.id;
    const { access } = await this.accessOf(actor);
    const below = !isSelf && (await this.scope.canAccess(actor.id, person.id, 'below'));
    const view = timelineView(access, isSelf, below);
    if (view === 'refused') await this.deny(actor, 'activity.timeline', empId, client);
    const summary = await this.summaries.summaryOf(person, date);
    if (view === 'summary') return { summary, events: null };
    const { start, end } = dayWindow(date);
    const rows = await this.prisma.activityEvent.findMany({
      where: { employeeId: person.id, occurredAt: { gte: start, lt: end } },
      orderBy: { occurredAt: 'asc' },
      take: SEARCH_LIMIT,
      select: eventSelect,
    });
    return { summary, events: await this.views(rows) };
  }

  /** GET /activity/me: what the system recorded about the caller (everyone sees their own). */
  async mine(actor: Actor, sessionId: string | null): Promise<MyActivityResponse> {
    const now = this.clock.now();
    const today = pakistanDay(now);
    const [summary, rows, screens, beats] = await Promise.all([
      this.summaries.summaryOf({ id: actor.id, empId: actor.empId }, today),
      this.prisma.activityEvent.findMany({
        where: { employeeId: actor.id, occurredAt: { gte: new Date(now.getTime() - MY_DAYS * 86_400_000) } },
        orderBy: { occurredAt: 'desc' },
        take: 200,
        select: eventSelect,
      }),
      sessionId
        ? this.prisma.activityEvent.findMany({ where: { sessionId, action: 'screen_view' }, orderBy: { occurredAt: 'desc' }, take: 40, select: { occurredAt: true, target: true } })
        : [],
      sessionId
        ? this.prisma.activityHeartbeat.findMany({ where: { sessionId, at: { gte: dayWindow(today).start } }, orderBy: { at: 'desc' }, take: 120, select: { at: true, active: true } })
        : [],
    ]);
    return {
      ...(summary ? { today: summary } : {}),
      events: await this.views(rows),
      liveScreens: screens.map((s) => ({ at: s.occurredAt.toISOString(), screen: s.target ?? '' })),
      heartbeats: beats.map((b) => ({ at: b.at.toISOString(), active: b.active })),
    };
  }

  // ------------------------------------------------------------------------------------------- locked accounts

  /** GET /accounts/locked: locked accounts in the caller's line (themselves and below), or all of them with activity.security. */
  async locks(actor: Actor): Promise<AccountLockView[]> {
    const { access } = await this.accessOf(actor);
    const rows = await this.prisma.credential.findMany({
      where: { lockedAt: { not: null }, employee: access.alerts ? {} : this.scope.employeeWhere(actor.id) },
      select: { lockedAt: true, employee: { select: { empId: true } } },
      orderBy: { lockedAt: 'desc' },
    });
    if (!rows.length) return [];
    const audits = await this.prisma.auditLog.findMany({
      where: { action: 'auth.account.locked', targetType: 'employee', targetId: { in: rows.map((r) => r.employee.empId) } },
      orderBy: { occurredAt: 'desc' },
      select: { targetId: true, reason: true, actor: { select: { empId: true } } },
    });
    return rows.map((r) => {
      // An account is locked again only after it was unlocked, so the newest lock entry describes the current lock.
      const entry = audits.find((a) => a.targetId === r.employee.empId);
      return {
        empId: r.employee.empId,
        at: r.lockedAt!.toISOString(),
        by: entry?.actor?.empId ?? 'system',
        reason: entry?.reason ?? 'Locked',
      };
    });
  }

  // ------------------------------------------------------------------------------------------- helpers

  /**
   * Turns rows into the shape the screens use. "Changes" are joined from the audit log rows the same request wrote
   * (decision in rules/activity-changes.ts); a login says whether two-step login was used in that session.
   */
  async views(rows: EventRow[]): Promise<ActivityEventView[]> {
    const requestIds = [...new Set(rows.map((r) => r.requestId).filter((v): v is string => !!v))];
    const loginSessions = [...new Set(rows.filter((r) => r.action === 'login' && r.sessionId).map((r) => r.sessionId!))];
    const [audits, sessions] = await Promise.all([
      requestIds.length ? this.prisma.auditLog.findMany({ where: { requestId: { in: requestIds }, outcome: 'success' }, orderBy: { occurredAt: 'asc' }, select: { requestId: true, details: true } }) : [],
      loginSessions.length ? this.prisma.session.findMany({ where: { id: { in: loginSessions } }, select: { id: true, twoFactorVerifiedAt: true } }) : [],
    ]);
    const changesOf = new Map<string, FieldDiff[]>();
    for (const a of audits) {
      const changes = changesFromAudit(a.details);
      if (changes.length) changesOf.set(a.requestId!, [...(changesOf.get(a.requestId!) ?? []), ...changes]);
    }
    const twoFactor = new Set(sessions.filter((s) => s.twoFactorVerifiedAt).map((s) => s.id));
    return rows.map((r) => {
      const how = (r.details as { how?: unknown } | null)?.how;
      const changes = r.requestId ? changesOf.get(r.requestId) : undefined;
      return {
        id: r.id,
        empId: r.employee.empId,
        at: r.occurredAt.toISOString(),
        source: r.source as ActivityEventView['source'],
        action: r.action,
        module: r.module,
        ...(r.target ? { target: r.target } : {}),
        description: r.action === 'login' && r.sessionId && twoFactor.has(r.sessionId) ? `${r.description} with two-step login` : r.description,
        ...(changes?.length ? { changes } : {}),
        ...(r.ip ? { ip: r.ip } : {}),
        ...(r.city ? { city: r.city } : {}),
        ...(r.device ? { device: r.device } : {}),
        ...(typeof how === 'string' && LOGOUT_HOWS.has(how as LogoutHow) ? { how: how as LogoutHow } : {}),
      };
    });
  }

  private async deny(actor: Actor, attempted: string, targetEmpId: string | null, client: RequestInfo): Promise<never> {
    await this.audit.record({ actorId: actor.id, action: 'access.denied', targetType: targetEmpId ? 'employee' : 'route', targetId: targetEmpId, outcome: 'denied', reason: 'activity_not_allowed', details: { attempted }, ...client });
    throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message: 'You do not have access to this' });
  }
}
