import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import type { DailySummaryView } from '@aceva/contracts';
import { Clock } from '../common/clock';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { JobRunner } from '../jobs/job-runner.service';
import { PrismaService } from '../prisma/prisma.service';
import { countsAsAction, tasksTouchedFromEvents } from './rules/activity-access';
import { computeDayActivity, dayWindow, daysBetween, MINUTE_MS, pakistanDay, type DayActivity, type SessionSpan, type Signal } from './rules/activity-time';

/** The scheduled job that builds one day's summaries (scheduled_jobs.type). */
export const DAILY_SUMMARY_JOB = 'activity.daily_summary';
/** The job for a day runs at 00:15 Pakistan time the next morning. */
const RUN_AFTER_DAY_END_MS = 15 * MINUTE_MS;
/** On start-up and every hour the server makes sure the jobs of the last 7 days exist (catches up after downtime). */
const CATCH_UP_DAYS = 7;
const ENSURE_EVERY_MS = 3_600_000;
/** A session lasts at most 12 hours (Module 2), so everything that touches a day began at most this long before it. */
const LONGEST_SESSION_MS = 12 * 3_600_000 + MINUTE_MS;

export const summaryJobKey = (day: string) => `${DAILY_SUMMARY_JOB}:${day}`;

/** The people and the Pakistan day a summary hook is asked about. */
export interface SummaryHookQuery {
  /** Internal employee ids. */
  employeeIds: string[];
  /** The Pakistan day (YYYY-MM-DD) and its start and end as UTC instants. */
  day: string;
  start: Date;
  end: Date;
}

/** Module 5 (tasks): how many different tasks each person worked on that day (employee id -> count). */
export type TasksTouchedSource = (query: SummaryHookQuery) => Promise<Map<string, number>>;
/** Module 7 (attendance): each person's check-in that day (employee id -> time). People without one are left out. */
export type CheckInSource = (query: SummaryHookQuery) => Promise<Map<string, Date>>;

/**
 * The two places where later modules plug into the daily summary (plan section 8: "number of actions and tasks touched,
 * compared with their attendance check-in"). Module 4 does not know tasks or attendance; the modules that do register
 * a source here once, in their own onModuleInit:
 *
 *   constructor(private readonly hooks: ActivitySummaryHooks) {}            // import ActivityModule
 *   onModuleInit() { this.hooks.useTasksTouched(async ({ employeeIds, start, end }) => new Map(...)); }
 *
 * Until then "tasks touched" counts the different tasks a person acted on in the Tasks module, from their recorded
 * actions (0 while Module 5 does not exist), and the check-in stays empty (null).
 */
@Injectable()
export class ActivitySummaryHooks {
  private tasksTouched: TasksTouchedSource | null = null;
  private checkIns: CheckInSource | null = null;

  /** Module 5 registers how "tasks touched" is counted (null goes back to the default count from recorded actions). */
  useTasksTouched(source: TasksTouchedSource | null): void {
    this.tasksTouched = source;
  }

  /** Module 7 registers where the attendance check-ins come from (null: no check-in shown). */
  useCheckIns(source: CheckInSource | null): void {
    this.checkIns = source;
  }

  tasksTouchedSource(): TasksTouchedSource | null {
    return this.tasksTouched;
  }

  checkInSource(): CheckInSource | null {
    return this.checkIns;
  }
}

interface LoadedEvent {
  employeeId: string;
  occurredAt: Date;
  action: string;
  module: string;
  target: string | null;
  requestId: string | null;
  source: string;
}

/** Everything the time calculation needs for some people over some time, by person (internal id). */
interface Loaded {
  sessionsByEmployee: Map<string, SessionSpan[]>;
  signalsByEmployee: Map<string, Signal[]>;
  eventsByEmployee: Map<string, LoadedEvent[]>;
}

function push<T>(map: Map<string, T[]>, key: string, value: T): void {
  const list = map.get(key);
  if (list) list.push(value);
  else map.set(key, [value]);
}

/** One person's day, worked out (not yet stored). */
export interface ComputedDay {
  employeeId: string;
  day: string;
  activity: DayActivity;
  actions: number;
  tasksTouched: number;
  checkIn: Date | null;
}

/**
 * Daily summaries (plan section 8 "Daily summary"): every night a job builds one row per person per day with first
 * login, last logout, active and idle minutes, actions, tasks touched and the attendance check-in. The rows are
 * insert-only. Today, and any day whose job has not run yet, is worked out live with the same rules.
 */
@Injectable()
export class ActivitySummaryService implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('ActivitySummary');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobRunner,
    private readonly hooks: ActivitySummaryHooks,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    this.jobs.register(DAILY_SUMMARY_JOB, async (payload) => {
      await this.buildDay(String(payload.day));
    });
  }

  onApplicationBootstrap(): void {
    if (this.env.ACTIVITY_SUMMARY_SCHEDULE !== 'on') return;
    const ensure = () => this.ensureScheduled().catch((error) => this.logger.error(`Could not schedule the daily summaries: ${(error as Error).message}`));
    void ensure();
    this.timer = setInterval(() => void ensure(), ENSURE_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /** Makes sure one summary job exists for each of the last 7 finished days (never twice, never re-run). */
  async ensureScheduled(): Promise<number> {
    const now = this.clock.now();
    let created = 0;
    for (let i = 1; i <= CATCH_UP_DAYS; i++) {
      const day = pakistanDay(new Date(now.getTime() - i * 86_400_000));
      const runAt = new Date(dayWindow(day).end.getTime() + RUN_AFTER_DAY_END_MS);
      if (await this.jobs.scheduleOnce(DAILY_SUMMARY_JOB, summaryJobKey(day), runAt, { day }, null)) created++;
    }
    return created;
  }

  /**
   * Builds and stores the summaries of one finished Pakistan day, for everyone who was signed in at some point of it.
   * Safe to run twice: a row that exists is never changed (insert-only) and is skipped. Returns how many rows were added.
   */
  async buildDay(day: string): Promise<number> {
    const { start, end } = dayWindow(day);
    if (this.clock.now().getTime() < end.getTime()) throw new Error(`The day ${day} is not over yet`);
    const sessions = await this.prisma.session.findMany({
      where: { createdAt: { gte: new Date(start.getTime() - LONGEST_SESSION_MS), lt: end } },
      select: { employeeId: true },
      distinct: ['employeeId'],
    });
    const computed = await this.compute(
      sessions.map((s) => s.employeeId),
      [day],
    );
    if (!computed.length) return 0;
    const { count } = await this.prisma.activityDailySummary.createMany({
      data: computed.map((c) => ({
        employeeId: c.employeeId,
        day: new Date(`${day}T00:00:00.000Z`),
        firstLoginAt: c.activity.firstLoginAt,
        lastLogoutAt: c.activity.lastLogoutAt,
        activeMinutes: c.activity.activeMinutes,
        idleMinutes: c.activity.idleMinutes,
        actions: c.actions,
        tasksTouched: c.tasksTouched,
        checkInAt: c.checkIn,
        idleSpans: c.activity.idleSpans.map((s) => ({ from: s.from.toISOString(), to: s.to.toISOString() })),
        sessions: c.activity.sessions,
      })),
      skipDuplicates: true,
    });
    this.logger.log(`Daily activity summaries for ${day}: ${count} added`);
    return count;
  }

  /**
   * Summaries for some people over some days: the stored nightly rows, and for today (or a day whose job has not run)
   * the same numbers worked out live. People who were never signed in on a day have no summary for it.
   */
  async summaries(people: Array<{ id: string; empId: string }>, from: string, to: string): Promise<DailySummaryView[]> {
    if (!people.length) return [];
    const today = pakistanDay(this.clock.now());
    const days = daysBetween(from, to < today ? to : today);
    if (!days.length) return [];
    const empIdOf = new Map(people.map((p) => [p.id, p.empId]));
    const ids = people.map((p) => p.id);

    const stored = await this.prisma.activityDailySummary.findMany({
      where: { employeeId: { in: ids }, day: { gte: new Date(`${days[0]}T00:00:00.000Z`), lte: new Date(`${days[days.length - 1]}T00:00:00.000Z`) } },
      orderBy: [{ day: 'asc' }],
    });
    const out: DailySummaryView[] = stored.map((s) => ({
      empId: empIdOf.get(s.employeeId)!,
      date: s.day.toISOString().slice(0, 10),
      ...(s.firstLoginAt ? { firstLogin: s.firstLoginAt.toISOString() } : {}),
      ...(s.lastLogoutAt ? { lastLogout: s.lastLogoutAt.toISOString() } : {}),
      activeMinutes: s.activeMinutes,
      idleMinutes: s.idleMinutes,
      actions: s.actions,
      tasksTouched: s.tasksTouched,
      ...(s.checkInAt ? { checkIn: s.checkInAt.toISOString() } : {}),
      idleSpans: Array.isArray(s.idleSpans) ? (s.idleSpans as Array<{ from: string; to: string }>) : [],
    }));

    // Days already summarised by their nightly job need nothing more; the others (today, or a job that has not run) are
    // worked out live.
    const done = await this.prisma.scheduledJob.findMany({ where: { dedupeKey: { in: days.map(summaryJobKey) }, status: 'succeeded' }, select: { dedupeKey: true } });
    const summarised = new Set(done.map((d) => d.dedupeKey));
    const have = new Set(out.map((s) => `${s.empId}|${s.date}`));
    const liveDays = days.filter((d) => d === today || !summarised.has(summaryJobKey(d)));
    if (liveDays.length) {
      for (const c of await this.compute(ids, liveDays)) {
        const empId = empIdOf.get(c.employeeId)!;
        if (!have.has(`${empId}|${c.day}`)) out.push(this.view(empId, c));
      }
    }
    return out.sort((a, b) => a.date.localeCompare(b.date) || a.empId.localeCompare(b.empId));
  }

  /** One person's day: the stored row, or worked out live. Undefined when they were not signed in that day. */
  async summaryOf(person: { id: string; empId: string }, day: string): Promise<DailySummaryView | undefined> {
    return (await this.summaries([person], day, day))[0];
  }

  /** Works out the given days for the given people (only those signed in at some point of a day get a result). */
  async compute(employeeIds: string[], days: string[]): Promise<ComputedDay[]> {
    if (!employeeIds.length || !days.length) return [];
    const sorted = [...days].sort();
    const from = dayWindow(sorted[0]).start;
    const to = dayWindow(sorted[sorted.length - 1]).end;
    const loaded = await this.load(employeeIds, from, to);
    const now = this.clock.now();
    const results: ComputedDay[] = [];

    for (const day of sorted) {
      const { start, end } = dayWindow(day);
      const dayResults: ComputedDay[] = [];
      for (const employeeId of employeeIds) {
        const sessions = loaded.sessionsByEmployee.get(employeeId) ?? [];
        if (!sessions.length) continue;
        const signals = loaded.signalsByEmployee.get(employeeId) ?? [];
        const activity = computeDayActivity({ sessions, signals, dayStart: start, dayEnd: end, now });
        if (activity.sessions === 0) continue;
        const events = (loaded.eventsByEmployee.get(employeeId) ?? []).filter((e) => e.occurredAt >= start && e.occurredAt < end);
        dayResults.push({ employeeId, day, activity, actions: events.filter(countsAsAction).length, tasksTouched: tasksTouchedFromEvents(events), checkIn: null });
      }
      if (!dayResults.length) continue;
      const query: SummaryHookQuery = { employeeIds: dayResults.map((r) => r.employeeId), day, start, end };
      const tasks = this.hooks.tasksTouchedSource();
      if (tasks) {
        const counts = await tasks(query);
        for (const r of dayResults) r.tasksTouched = Math.max(0, Math.floor(counts.get(r.employeeId) ?? 0));
      }
      const checkIns = this.hooks.checkInSource();
      if (checkIns) {
        const times = await checkIns(query);
        for (const r of dayResults) r.checkIn = times.get(r.employeeId) ?? null;
      }
      results.push(...dayResults);
    }
    return results;
  }

  view(empId: string, c: ComputedDay): DailySummaryView {
    return {
      empId,
      date: c.day,
      ...(c.activity.firstLoginAt ? { firstLogin: c.activity.firstLoginAt.toISOString() } : {}),
      ...(c.activity.lastLogoutAt ? { lastLogout: c.activity.lastLogoutAt.toISOString() } : {}),
      activeMinutes: c.activity.activeMinutes,
      idleMinutes: c.activity.idleMinutes,
      actions: c.actions,
      tasksTouched: c.tasksTouched,
      ...(c.checkIn ? { checkIn: c.checkIn.toISOString() } : {}),
      idleSpans: c.activity.idleSpans.map((s) => ({ from: s.from.toISOString(), to: s.to.toISOString() })),
    };
  }

  /** Sessions that touch [from, to), their heartbeats and actions (signals of use), and the people's recorded events. */
  private async load(employeeIds: string[], from: Date, to: Date): Promise<Loaded> {
    const sessions = await this.prisma.session.findMany({
      where: { employeeId: { in: employeeIds }, createdAt: { gte: new Date(from.getTime() - LONGEST_SESSION_MS), lt: to } },
      select: { id: true, employeeId: true, createdAt: true, revokedAt: true, revokedReason: true, lastActiveAt: true },
    });
    const sessionIds = sessions.map((s) => s.id);
    const [beats, uses, events] = await Promise.all([
      sessionIds.length ? this.prisma.activityHeartbeat.findMany({ where: { sessionId: { in: sessionIds } }, select: { sessionId: true, at: true, active: true } }) : [],
      // What the person did in a session (screens, actions, refused attempts) is use too. Logins and logouts are not.
      sessionIds.length
        ? this.prisma.activityEvent.findMany({ where: { sessionId: { in: sessionIds }, action: { notIn: ['login', 'logout'] } }, select: { sessionId: true, occurredAt: true } })
        : [],
      this.prisma.activityEvent.findMany({
        where: { employeeId: { in: employeeIds }, occurredAt: { gte: from, lt: to } },
        select: { employeeId: true, occurredAt: true, action: true, module: true, target: true, requestId: true, source: true },
      }),
    ]);
    const sessionsByEmployee = new Map<string, SessionSpan[]>();
    const ownerOf = new Map<string, string>();
    for (const s of sessions) {
      ownerOf.set(s.id, s.employeeId);
      push(sessionsByEmployee, s.employeeId, { id: s.id, startedAt: s.createdAt, endedAt: s.revokedAt, endReason: s.revokedReason, lastActiveAt: s.lastActiveAt });
    }
    const signalsByEmployee = new Map<string, Signal[]>();
    for (const b of beats) push(signalsByEmployee, ownerOf.get(b.sessionId)!, { sessionId: b.sessionId, at: b.at, kind: 'heartbeat', active: b.active });
    for (const u of uses) if (u.sessionId) push(signalsByEmployee, ownerOf.get(u.sessionId)!, { sessionId: u.sessionId, at: u.occurredAt, kind: 'action', active: true });
    const eventsByEmployee = new Map<string, LoadedEvent[]>();
    for (const e of events) push(eventsByEmployee, e.employeeId, e);
    return { sessionsByEmployee, signalsByEmployee, eventsByEmployee };
  }
}
