import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityRecorder } from '../src/activity/activity-recorder.service';
import { ActivitySummaryHooks, ActivitySummaryService, summaryJobKey } from '../src/activity/activity-summary.service';
import { pakistanDay } from '../src/activity/rules/activity-time';
import { OutboxDispatcher } from '../src/events/outbox-dispatcher.service';
import type { PrismaClient } from '../src/generated/prisma/client';
import { JobRunner } from '../src/jobs/job-runner.service';
import { seedDevPasswords } from '../prisma/seed-dev-passwords';
import { createTestApp, TEST_PASSWORD, type SignedIn, type TestApp } from './helpers/app';
import { createEmployee } from './helpers/people';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 4: active and idle time, the screens built on it, who sees them, and the nightly summary (plan section 8).
 *
 * The demo people sign in at the real time. WORKER's 20 minutes of work are played BEFORE that moment (the clock is set
 * back 20 minutes and moves forward one minute per heartbeat), so nobody's session gets near the 30-minute idle limit.
 * Nothing requests anything as WORKER afterwards (that would move its "last active" time); the managers look at it.
 * The tests that let sessions time out run last.
 */
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const DEV1 = 'ACV-0006';
const SALES1 = 'ACV-0009';
const FINANCE = 'ACV-0010';
const MINUTE = 60_000;
const DAY = 24 * 3_600_000;

let t: TestApp;
let prisma: PrismaClient;
let recorder: ActivityRecorder;
let dispatcher: OutboxDispatcher;
let summaries: ActivitySummaryService;
/** Test-only people below the CTO with a known day. */
let WORKER = '';
let NIGHT = '';
let worker: SignedIn;
/** The Pakistan day(s) of WORKER's work: two only if it ran over midnight (then exact minutes are not compared). */
let workedDays: string[] = [];
const oneDay = () => workedDays.length === 1;

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await recorder.flush();
    await dispatcher.tick();
  }
}

const beat = (who: SignedIn, active: boolean) => who.post('/api/v1/activity/heartbeat').send({ active }).expect(200);

/**
 * Moves the clock to second :10 of the current minute (at most 50 seconds back). Minutes are counted in whole minutes,
 * so a played session that starts there cannot slip across a half-minute boundary while the test itself takes time.
 */
function alignToSecondTen(): void {
  t.clock.advance(10_000 - (t.clock.now().getTime() % MINUTE));
}

/**
 * 10 used minutes, 6 quiet minutes (the tab stays open, heartbeats say "not used"), 4 used minutes: 20 signed-in
 * minutes, 14 active and 6 idle. `afterFirst` runs after the first minute (a screen opened then is use in a minute that
 * is active anyway, so it changes no number).
 */
async function workTwentyMinutes(who: SignedIn, afterFirst?: () => Promise<unknown>): Promise<void> {
  for (let i = 0; i < 20; i++) {
    t.clock.advance(MINUTE);
    await beat(who, i < 10 || i >= 16);
    if (i === 0 && afterFirst) await afterFirst();
  }
  await recorder.flush();
}

beforeAll(async () => {
  t = await createTestApp();
  prisma = createTestPrisma();
  await prisma.systemSetting.upsert({ where: { section: 'alert-rules' }, update: { values: { outsideHours: false } }, create: { section: 'alert-rules', values: { outsideHours: false } } });
  WORKER = (await createEmployee(prisma, { name: 'Test Worker', reportsToEmpId: CTO })).empId;
  NIGHT = (await createEmployee(prisma, { name: 'Test Nightshift', reportsToEmpId: CTO })).empId;
  await seedDevPasswords(prisma, TEST_PASSWORD);
  await t.signInAll();
  recorder = t.app.get(ActivityRecorder);
  dispatcher = t.app.get(OutboxDispatcher);
  summaries = t.app.get(ActivitySummaryService);

  t.clock.advance(-20 * MINUTE);
  alignToSecondTen();
  worker = await t.signIn(WORKER);
  const start = t.clock.now();
  await workTwentyMinutes(worker, () => worker.post('/api/v1/activity/screen').send({ screen: 'Tasks', path: '/tasks' }).expect(200));
  // the clock is back at about the real time now (within a minute)
  workedDays = [...new Set([pakistanDay(start), pakistanDay(t.clock.now())])];
  await settle();
}, 120000);
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

/** WORKER's day as the CTO sees it, added up over the worked days (normally one). */
async function workerTotals() {
  let active = 0;
  let idle = 0;
  let spans = 0;
  for (const date of workedDays) {
    const res = await t.as(CTO).get('/api/v1/activity/timeline').query({ empId: WORKER, date }).expect(200);
    active += res.body.summary?.activeMinutes ?? 0;
    idle += res.body.summary?.idleMinutes ?? 0;
    spans += res.body.summary?.idleSpans?.length ?? 0;
  }
  return { active, idle, spans };
}

describe('M4 heartbeats: only a yes/no', () => {
  it('stores each heartbeat (and nothing else) without recording it as an action', async () => {
    const beats = await prisma.activityHeartbeat.findMany({ where: { employee: { empId: WORKER } }, orderBy: { at: 'asc' } });
    expect(beats.map((b) => b.active)).toEqual([...Array(10).fill(true), ...Array(6).fill(false), ...Array(4).fill(true)]);
    expect(await prisma.activityEvent.count({ where: { employee: { empId: WORKER }, module: 'Activity' } })).toBe(0);
  });

  it('refuses anything but a yes/no', async () => {
    // "not used" answers: these do not count as activity, so WORKER's day stays exactly as played
    await worker.post('/api/v1/activity/heartbeat').send({ active: 'yes' }).expect(400);
    await worker.post('/api/v1/activity/heartbeat').send({ active: false, keys: 'abc' }).expect(400);
    await t.anonymous().post('/api/v1/activity/heartbeat').send({ active: true }).expect(401);
  });
});

describe('M4 retention: every tracking table has an index that starts with its time column', () => {
  it('a clean-up by age (docs/M4-ACCEPTANCE.md, Retention) can use an index on every tracking table', async () => {
    const timeColumn: Record<string, string> = {
      activity_events: 'occurred_at',
      activity_heartbeats: 'at',
      activity_daily_summaries: 'day',
      security_alerts: 'occurred_at',
      security_alert_checks: 'checked_at',
    };
    const tables = Object.keys(timeColumn);
    const indexes = await prisma.$queryRaw<Array<{ tablename: string; indexdef: string }>>`
      SELECT tablename, indexdef FROM pg_indexes WHERE schemaname = current_schema() AND tablename = ANY(${tables}::text[])`;
    for (const [table, column] of Object.entries(timeColumn)) {
      // "CREATE INDEX ... USING btree (at)": the column alone, so a delete by age does not have to scan the table.
      const alone = new RegExp(`\\(\\s*"?${column}"?\\s*\\)`);
      expect(
        indexes.some((i) => i.tablename === table && alone.test(i.indexdef)),
        `${table}.${column} has no index of its own`,
      ).toBe(true);
    }
  });
});

describe('M4 active and idle time on the screens', () => {
  it('the day summary: 14 active minutes, 6 idle minutes in one idle stretch, still signed in', async () => {
    if (oneDay()) expect(await workerTotals()).toEqual({ active: 14, idle: 6, spans: 1 });
    else expect((await workerTotals()).active + (await workerTotals()).idle).toBe(20);
    const res = await t.as(CTO).get('/api/v1/activity/timeline').query({ empId: WORKER, date: workedDays[workedDays.length - 1] }).expect(200);
    expect(res.body.summary.lastLogout).toBeUndefined(); // still signed in
    expect(res.body.summary.tasksTouched).toBe(0); // until Module 5 exists
    expect(res.body.summary.checkIn).toBeUndefined(); // until Module 7 exists
    expect(res.body.summary.actions).toBe(0); // a login and a screen are not actions
    // The sign-in and the opened screen belong to the day the work began. Over midnight (two worked days) that is the
    // first day, not the last one, so the events are collected over all the worked days.
    const actions: string[] = [];
    for (const date of workedDays) {
      const day = await t.as(CTO).get('/api/v1/activity/timeline').query({ empId: WORKER, date }).expect(200);
      actions.push(...day.body.events.map((e: { action: string }) => e.action));
    }
    expect(actions).toEqual(expect.arrayContaining(['login', 'screen_view']));
  });

  it('"My activity": today so far, own records, this session\'s screens and heartbeats', async () => {
    const res = await worker.get('/api/v1/activity/me').expect(200); // a passive request: it does not count as activity
    if (oneDay()) {
      expect(res.body.today).toMatchObject({ empId: WORKER, activeMinutes: 14, idleMinutes: 6, actions: 0 });
      expect(res.body.heartbeats).toHaveLength(20);
    }
    expect(res.body.liveScreens).toEqual([expect.objectContaining({ screen: 'Tasks' })]);
    expect(res.body.events.length).toBeGreaterThan(0);
    expect(res.body.events.every((e: { empId: string }) => e.empId === WORKER)).toBe(true);
  });

  it('who is online now: the CTO sees his developers with screen and state; the Owner everyone; others nothing', async () => {
    const cto = await t.as(CTO).get('/api/v1/activity/online').expect(200);
    expect(cto.body.find((s: { empId: string }) => s.empId === WORKER)).toMatchObject({ currentScreen: 'Tasks', state: 'active', device: 'Chrome 142 on Windows' });
    expect(cto.body.some((s: { empId: string }) => s.empId === SALES1)).toBe(false); // Sales is not below the CTO
    expect(cto.body.some((s: { empId: string }) => s.empId === CTO)).toBe(false); // not himself
    const owner = await t.as(OWNER).get('/api/v1/activity/online').expect(200);
    expect(owner.body.some((s: { empId: string }) => s.empId === SALES1)).toBe(true);
    expect(owner.body.some((s: { empId: string }) => s.empId === WORKER)).toBe(true);
    const director = await t.as(DIRECTOR).get('/api/v1/activity/online').expect(200);
    expect(director.body.some((s: { empId: string }) => s.empId === OWNER)).toBe(false); // never above
    for (const who of [DEV1, SALES1, FINANCE]) await t.as(who).get('/api/v1/activity/online').expect(403);
  });
});

describe('M4 who sees timelines, reports and the activity search', () => {
  it('timelines: the person and the managers above them; never a colleague or someone beside or above', async () => {
    const date = workedDays[0];
    for (const who of [CTO, DIRECTOR, OWNER]) {
      const res = await t.as(who).get('/api/v1/activity/timeline').query({ empId: WORKER, date }).expect(200);
      expect(res.body.events).not.toBeNull();
    }
    for (const who of [DEV1, SALES1, FINANCE]) await t.as(who).get('/api/v1/activity/timeline').query({ empId: WORKER, date }).expect(403);
    await t.as(CTO).get('/api/v1/activity/timeline').query({ empId: SALES1, date }).expect(403); // not below the CTO
    await t.as(CTO).get('/api/v1/activity/timeline').query({ empId: DIRECTOR, date }).expect(403); // above
    await t.as(CTO).get('/api/v1/activity/timeline').query({ empId: 'ACV-9999', date }).expect(404);
    const own = await t.as(DEV1).get('/api/v1/activity/timeline').query({ empId: DEV1, date: pakistanDay(t.clock.now()) }).expect(200);
    expect(own.body.events).not.toBeNull();
  });

  it('reports: the CTO gets his developers, the Director his whole line; others are refused', async () => {
    const from = workedDays[0];
    const to = workedDays[workedDays.length - 1];
    const cto = await t.as(CTO).get('/api/v1/activity/summaries').query({ from, to, scope: 'team' }).expect(200);
    const people = new Set(cto.body.map((s: { empId: string }) => s.empId));
    expect(people.has(WORKER)).toBe(true);
    expect(people.has(SALES1)).toBe(false);
    expect(people.has(CTO)).toBe(false);
    const director = await t.as(DIRECTOR).get('/api/v1/activity/summaries').query({ from, to }).expect(200);
    const line = new Set(director.body.map((s: { empId: string }) => s.empId));
    expect(line.has(SALES1) && line.has(WORKER)).toBe(true);
    expect(line.has(OWNER)).toBe(false);
    await t.as(DEV1).get('/api/v1/activity/summaries').query({ from, to }).expect(403);
    await t.as(CTO).get('/api/v1/activity/summaries').query({ from: '2026-01-01', to: '2026-03-01' }).expect(400); // more than 31 days
    await t.as(CTO).get('/api/v1/activity/summaries').query({ from: '2026-03-02', to: '2026-03-01' }).expect(400); // backwards
  });

  it('activity search: the Director and the Owner search their line; the CTO and everyone else get only their own', async () => {
    expect((await t.as(DIRECTOR).get('/api/v1/activity/events').query({ empId: WORKER }).expect(200)).body.length).toBeGreaterThan(0);
    expect((await t.as(OWNER).get('/api/v1/activity/events').query({ empId: SALES1 }).expect(200)).body.length).toBeGreaterThan(0);
    expect((await t.as(CTO).get('/api/v1/activity/events').query({ empId: WORKER }).expect(200)).body).toEqual([]); // he uses the timeline and reports
    expect((await t.as(DIRECTOR).get('/api/v1/activity/events').query({ empId: OWNER }).expect(200)).body).toEqual([]); // never above
    const byDepartment = await t.as(DIRECTOR).get('/api/v1/activity/events').query({ departmentId: 'dep-sales', action: 'login' }).expect(200);
    expect(byDepartment.body.length).toBeGreaterThan(0);
    expect(byDepartment.body.every((e: { empId: string; action: string }) => ['ACV-0009', 'ACV-0012', 'ACV-0014'].includes(e.empId) && e.action === 'login')).toBe(true);
    await t.as(DIRECTOR).get('/api/v1/activity/events').query({ action: 'teleport' }).expect(400);
  });
});

describe('M4 online state turns idle', () => {
  it('six quiet minutes later the session shows as idle', async () => {
    t.clock.advance(6 * MINUTE);
    const res = await t.as(CTO).get('/api/v1/activity/online').expect(200);
    expect(res.body.find((s: { empId: string }) => s.empId === WORKER).state).toBe('idle');
  });
});

describe('M4 nightly daily summary', () => {
  it('builds a finished day once (insert-only), with the same rules, and the reports read the stored row', async () => {
    // NIGHT worked yesterday: the clock goes back a day for the sign-in, the heartbeats and the logout.
    t.clock.advance(-DAY);
    alignToSecondTen();
    const night = await t.signIn(NIGHT);
    const started = pakistanDay(t.clock.now());
    await workTwentyMinutes(night);
    await night.post('/api/v1/auth/logout').send({}).expect(200);
    const ended = pakistanDay(t.clock.now());
    await settle();
    t.clock.advance(DAY);

    await expect(summaries.buildDay(pakistanDay(t.clock.now()))).rejects.toThrow(/not over yet/);
    expect(await summaries.buildDay(started)).toBeGreaterThanOrEqual(1);
    expect(await summaries.buildDay(started)).toBe(0); // never twice, never changed
    const stored = await prisma.activityDailySummary.findFirstOrThrow({ where: { employee: { empId: NIGHT }, day: new Date(`${started}T00:00:00.000Z`) } });
    expect(stored).toMatchObject({ sessions: 1, tasksTouched: 0, checkInAt: null, actions: 0 });
    if (started === ended) {
      expect(stored).toMatchObject({ activeMinutes: 14, idleMinutes: 6 });
      expect(stored.lastLogoutAt).not.toBeNull();
    }

    const res = await t.as(CTO).get('/api/v1/activity/summaries').query({ from: started, to: started }).expect(200);
    expect(res.body.find((s: { empId: string }) => s.empId === NIGHT)).toMatchObject({ date: started, activeMinutes: stored.activeMinutes, idleMinutes: stored.idleMinutes });
  });

  it('the scheduler creates one job per finished day (never twice), and the job runner builds it', async () => {
    expect(await summaries.ensureScheduled()).toBe(7);
    expect(await summaries.ensureScheduled()).toBe(0);
    const yesterday = pakistanDay(new Date(t.clock.now().getTime() - DAY));
    // Due now even when this test runs between 00:00 and 00:15 Pakistan time (the job normally runs at 00:15).
    await prisma.scheduledJob.updateMany({ where: { dedupeKey: summaryJobKey(yesterday) }, data: { runAt: new Date(0) } });
    const jobs = t.app.get(JobRunner);
    let status = '';
    for (let i = 0; i < 20 && status !== 'succeeded'; i++) {
      await jobs.tick();
      status = (await prisma.scheduledJob.findUniqueOrThrow({ where: { dedupeKey: summaryJobKey(yesterday) } })).status;
      if (status !== 'succeeded') await new Promise((resolve) => setTimeout(resolve, 200)); // the 30-second runner may be busy with it
    }
    expect(status).toBe('succeeded');
  });

  it('Module 5 and Module 7 plug in "tasks touched" and the check-in through the hooks', async () => {
    const hooks = t.app.get(ActivitySummaryHooks);
    // A person who signs in right now, so the day is "today" by the test clock. Today is never stored (the nightly job
    // keeps only finished days, insert-only), so the hooks decide its numbers. WORKER's own day cannot be used here: the
    // tests above move the clock about half an hour ahead, and when that crosses midnight Pakistan time his day is already
    // finished and stored by the job test, with the numbers it had at the time.
    await t.signIn(NIGHT);
    const nightId = (await prisma.employee.findUniqueOrThrow({ where: { empId: NIGHT }, select: { id: true } })).id;
    const day = pakistanDay(t.clock.now());
    const checkIn = new Date(t.clock.now().getTime() - 3 * 3_600_000);
    const previousTasksSource = hooks.tasksTouchedSource();
    hooks.useTasksTouched(async ({ employeeIds }) => new Map(employeeIds.map((id) => [id, id === nightId ? 3 : 0])));
    hooks.useCheckIns(async () => new Map([[nightId, checkIn]]));
    try {
      const [computed] = await summaries.compute([nightId], [day]);
      expect(computed).toMatchObject({ employeeId: nightId, tasksTouched: 3, checkIn });
      const res = await t.as(CTO).get('/api/v1/activity/timeline').query({ empId: NIGHT, date: day }).expect(200);
      expect(res.body.summary).toMatchObject({ tasksTouched: 3, checkIn: checkIn.toISOString() });
    } finally {
      hooks.useTasksTouched(previousTasksSource);
      hooks.useCheckIns(null);
    }
  });
});

describe('M4 only a used minute keeps the session alive (these let sessions time out, so they run last)', () => {
  it('an open but unused tab (heartbeats saying "not used") still times out after 30 minutes', async () => {
    const idle = await t.signIn(DEV1);
    t.clock.advance(20 * MINUTE);
    await beat(idle, false);
    t.clock.advance(11 * MINUTE);
    await idle.get('/api/v1/auth/me').expect(401);
  });

  it('a used minute keeps it alive', async () => {
    const busy = await t.signIn(DEV1);
    t.clock.advance(20 * MINUTE);
    await beat(busy, true);
    t.clock.advance(20 * MINUTE);
    await busy.get('/api/v1/auth/me').expect(200);
  });
});
