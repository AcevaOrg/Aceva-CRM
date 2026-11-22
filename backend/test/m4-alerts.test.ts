import { createHash, randomUUID } from 'node:crypto';
import { ALERTS_CHECKED_LIMIT, type OutboxEvent } from '@aceva/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityRecorder } from '../src/activity/activity-recorder.service';
import { OutboxDispatcher } from '../src/events/outbox-dispatcher.service';
import { OutboxService } from '../src/events/outbox.service';
import type { PrismaClient } from '../src/generated/prisma/client';
import { seedDevPasswords } from '../prisma/seed-dev-passwords';
import { createTestApp, TEST_PASSWORD, type TestApp } from './helpers/app';
import { createEmployee } from './helpers/people';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/** Module 4: Module 2 events as activity, security alerts, checking alerts, and the admin controls (plan section 8). */
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const SALES1 = 'ACV-0009';

const KARACHI = '192.0.2.10'; // the test city list (helpers/app.ts): 192.0.2.x is Karachi, 198.51.100.x is Lahore
const LAHORE = '198.51.100.7';
const ANDROID = 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';
const QUIET = { outsideHours: false };

let t: TestApp;
let prisma: PrismaClient;
let recorder: ActivityRecorder;
let dispatcher: OutboxDispatcher;
/** Test-only people below the CTO, so their sign-in history is known exactly. */
let NEWBIE = '';
let LOCKME = '';
let LOCK2 = '';

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await recorder.flush();
    await dispatcher.tick();
  }
}

const setRules = (values: Record<string, unknown>) =>
  prisma.systemSetting.upsert({ where: { section: 'alert-rules' }, update: { values: values as never }, create: { section: 'alert-rules', values: values as never } });
const eventsOf = (empId: string, where: Record<string, unknown> = {}) =>
  prisma.activityEvent.findMany({ where: { employee: { empId }, ...where }, orderBy: { occurredAt: 'asc' } });
const alertsOf = (empId: string, kind?: string) => prisma.securityAlert.findMany({ where: { employee: { empId }, ...(kind ? { kind: kind as never } : {}) }, orderBy: { occurredAt: 'asc' } });
const sessionOf = (cookie: string) => prisma.session.findUniqueOrThrow({ where: { tokenHash: createHash('sha256').update(cookie.split('=')[1]).digest('hex') } });
/** HH:MM in Pakistan time. */
const pkt = (ms: number) => new Date(ms + 5 * 3_600_000).toISOString().slice(11, 16);

beforeAll(async () => {
  t = await createTestApp();
  prisma = createTestPrisma();
  await setRules(QUIET);
  NEWBIE = (await createEmployee(prisma, { name: 'Test Newbie', reportsToEmpId: CTO })).empId;
  LOCKME = (await createEmployee(prisma, { name: 'Test Lockme', reportsToEmpId: CTO })).empId;
  LOCK2 = (await createEmployee(prisma, { name: 'Test Locktwo', reportsToEmpId: CTO })).empId;
  await seedDevPasswords(prisma, TEST_PASSWORD);
  await t.signInAll();
  recorder = t.app.get(ActivityRecorder);
  dispatcher = t.app.get(OutboxDispatcher);
  await settle();
});
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M4 turns Module 2 events into activity records', () => {
  it('a login, a wrong password and a clicked logout, with device, city and how the session ended', async () => {
    const me = await t.signIn(NEWBIE, { ip: KARACHI });
    expect((await t.rawLogin({ empId: NEWBIE, password: 'not-the-password' }, { ip: KARACHI }).expect(200)).body.status).toBe('invalid');
    await me.post('/api/v1/auth/logout').send({}).expect(200);
    await settle();
    const rows = await eventsOf(NEWBIE);
    expect(rows.map((r) => [r.action, r.description])).toEqual([
      ['login', 'Signed in'],
      ['login_failed', 'Wrong password'],
      ['logout', 'Signed out'],
    ]);
    expect(rows[0]).toMatchObject({ module: 'Login', ip: KARACHI, city: 'Karachi', device: 'Chrome 142 on Windows' });
    expect((rows[2].details as { how: string }).how).toBe('clicked');
    // The session itself knows its approximate city (My devices)
    expect((await prisma.session.findFirstOrThrow({ where: { employee: { empId: NEWBIE } }, orderBy: { createdAt: 'asc' } })).city).toBe('Karachi');
    // The very first sign-in only sets the baseline: no alert
    expect(await alertsOf(NEWBIE)).toEqual([]);
  });

  it('each event becomes exactly one record, even when delivered again', async () => {
    const count = await prisma.activityEvent.count();
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { type: 'auth.logout', payload: { path: ['empId'], equals: NEWBIE } } });
    await prisma.outboxEvent.update({ where: { id: event.id }, data: { processedAt: null, attempts: 0, nextAttemptAt: null } });
    await prisma.outboxDelivery.deleteMany({ where: { eventId: event.id } }); // as if the server crashed before recording the delivery
    await settle();
    expect(await prisma.activityEvent.count()).toBe(count);
    expect((await prisma.outboxEvent.findUniqueOrThrow({ where: { id: event.id } })).processedAt).not.toBeNull();
  });

  it('a login of someone with two-step login says so, and the person sees their own history', async () => {
    const res = await t.as(DIRECTOR).get('/api/v1/activity/events').query({ empId: DIRECTOR, action: 'login' }).expect(200);
    expect(res.body[0].description).toBe('Signed in with two-step login');
    const own = await t.as(DEV1).get('/api/v1/activity/events').expect(200);
    expect(own.body.length).toBeGreaterThan(0);
    expect(own.body.every((e: { empId: string }) => e.empId === DEV1)).toBe(true);
  });

  it('security changes on an account are recorded (here: the Director resets an authenticator)', async () => {
    await t.as(DIRECTOR).post(`/api/v1/auth/employees/${NEWBIE}/reset-2fa`).send({ reason: 'Lost phone, identity confirmed' }).expect(200);
    await settle();
    const [security] = await eventsOf(NEWBIE, { action: 'security' });
    expect(security).toMatchObject({ module: 'Login', description: `Authenticator reset by ${DIRECTOR}`, target: DIRECTOR });
    expect((security.details as { kind: string }).kind).toBe('two_factor_reset');
    // The Director's own action is recorded as his action (once: not again from the Module 2 event)
    const mine = (await eventsOf(DIRECTOR, { action: 'security' })).map((e) => e.description);
    expect(mine.filter((d) => d === `Reset the authenticator of ${NEWBIE}`)).toHaveLength(1);
  });
});

describe('M4 security alerts from sign-ins', () => {
  it('a sign-in from a new city on a new device raises one high alert; the same place again raises nothing', async () => {
    t.mailer.clear();
    await t.signIn(NEWBIE, { ip: LAHORE, userAgent: ANDROID });
    await settle();
    const alerts = await alertsOf(NEWBIE, 'new_device');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ rule: 'Login from a new city', severity: 'high' });
    expect(alerts[0].details).toMatch(/Signed in from Lahore on a new device: Chrome 142 on Android \(198\.51\.100\.7\)\. Usual: Karachi\./);
    const login = (await eventsOf(NEWBIE, { action: 'login' })).pop()!;
    expect(login.details).toMatchObject({ newDevice: true, newCity: true });
    for (const to of ['bilal@acevatech.com', 'omar@acevatech.com']) {
      expect(t.mailer.sent.some((m) => m.to === to && m.subject === `Security alert: Login from a new city (${NEWBIE})`)).toBe(true);
    }

    await t.signIn(NEWBIE, { ip: LAHORE, userAgent: ANDROID });
    await settle();
    expect(await alertsOf(NEWBIE, 'new_device')).toHaveLength(1);
  });

  it('a sign-in outside the working hours in the settings raises a low alert (the window is read from settings)', async () => {
    const now = t.clock.now().getTime();
    await setRules({ outsideHours: true, outsideFrom: pkt(now - 3_600_000), outsideTo: pkt(now + 3_600_000) });
    try {
      await t.signIn(NEWBIE, { ip: KARACHI });
      await settle();
    } finally {
      await setRules(QUIET);
    }
    const alerts = await alertsOf(NEWBIE, 'outside_hours');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ rule: 'Login outside working hours', severity: 'low' });
    expect(alerts[0].details).toMatch(/^Signed in at \d\d:\d\d \(Pakistan time\) from Karachi, Chrome 142 on Windows\.$/);
  });

  it('five wrong passwords lock the account: one alert, mailed to the Director and the CTO; the lock is listed', async () => {
    t.mailer.clear();
    for (let i = 0; i < 5; i++) await t.rawLogin({ empId: LOCKME, password: `wrong-password-${i}` }).expect(200);
    expect((await t.rawLogin({ empId: LOCKME, password: TEST_PASSWORD }).expect(200)).body.status).toBe('locked');
    await settle();
    const alerts = await alertsOf(LOCKME, 'account_locked');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ rule: 'Account locked after 5 wrong passwords', severity: 'medium' });
    expect(alerts[0].details).toMatch(/^5 wrong passwords, the last from Chrome 142 on Windows(, \w+)? \(/);
    expect((await eventsOf(LOCKME, { action: 'security' })).map((e) => e.description)).toContain('Account locked after 5 wrong passwords');
    expect(t.mailer.sent.filter((m) => m.subject === `Security alert: Account locked after 5 wrong passwords (${LOCKME})`).map((m) => m.to).sort()).toEqual(['bilal@acevatech.com', 'omar@acevatech.com']);

    const locks = await t.as(CTO).get('/api/v1/accounts/locked').expect(200);
    expect(locks.body).toEqual(expect.arrayContaining([expect.objectContaining({ empId: LOCKME, by: 'system', reason: '5 wrong passwords' })]));
    expect((await t.as(DEV1).get('/api/v1/accounts/locked').expect(200)).body).toEqual([]); // nobody below a developer
  });
});

describe('M4 who sees security alerts, and who checks them (maker-checker)', () => {
  it('the Director, the CTO and the CEO / Founder / Owner see every alert; nobody else does', async () => {
    for (const who of [OWNER, DIRECTOR, CTO]) {
      const res = await t.as(who).get('/api/v1/activity/alerts').expect(200);
      expect(res.body.some((a: { empId: string; kind: string }) => a.empId === LOCKME && a.kind === 'account_locked')).toBe(true);
    }
    for (const who of [DEV1, SALES1, 'ACV-0010']) await t.as(who).get('/api/v1/activity/alerts').expect(403);
  });

  it('a manager above the person checks it once, with a note; the CEO / Founder / Owner and the person cannot', async () => {
    const [alert] = await alertsOf(LOCKME, 'account_locked');
    const check = (who: string, note = 'Confirmed with the employee, they forgot the new password') => t.as(who).post(`/api/v1/activity/alerts/${alert.id}/check`).send({ note });
    await check(OWNER).expect(403); // view only
    await check(DEV1).expect(403);
    await check(CTO, 'no').expect(400); // a note is required
    const done = await check(CTO).expect(200);
    expect(done.body).toMatchObject({ id: alert.id, status: 'checked', checkedBy: CTO, note: 'Confirmed with the employee, they forgot the new password' });
    expect((await check(DIRECTOR).expect(409)).body.code).toBe('already_checked');
    // The alert itself never changed; the check is a row of its own
    expect(await prisma.securityAlert.findUniqueOrThrow({ where: { id: alert.id } })).toEqual(alert);
    expect(await prisma.securityAlertCheck.count({ where: { alertId: alert.id } })).toBe(1);
    const open = await t.as(CTO).get('/api/v1/activity/alerts').query({ status: 'open' }).expect(200);
    expect(open.body.some((a: { id: string }) => a.id === alert.id)).toBe(false);
  });

  it('nobody checks an alert about themselves: the Director checks the CTO, the CTO checks the Director', async () => {
    await t.as(CTO).post('/api/v1/activity/export').send({ rows: 800, format: 'xlsx', module: 'People', dataset: 'Staff list' }).expect(200);
    await t.as(DIRECTOR).post('/api/v1/activity/export').send({ rows: 900, format: 'pdf', module: 'Payroll', dataset: 'Payroll run' }).expect(200);
    await settle();
    const [aboutCto] = await alertsOf(CTO, 'large_export');
    const [aboutDirector] = await alertsOf(DIRECTOR, 'large_export');
    expect(aboutCto.rule).toBe('Large export of employee data');
    expect(aboutDirector.rule).toBe('Large export of finance data');
    const note = { note: 'Reviewed: needed for the monthly report' };
    await t.as(CTO).post(`/api/v1/activity/alerts/${aboutCto.id}/check`).send(note).expect(403);
    await t.as(DIRECTOR).post(`/api/v1/activity/alerts/${aboutDirector.id}/check`).send(note).expect(403);
    await t.as(DIRECTOR).post(`/api/v1/activity/alerts/${aboutCto.id}/check`).send(note).expect(200);
    await t.as(CTO).post(`/api/v1/activity/alerts/${aboutDirector.id}/check`).send(note).expect(200);
  });
});

describe('M4 controls: force sign-out, lock and unlock (the Director and the CTO, for people below them, after confirming)', () => {
  it('ends one session of someone below, after a confirm-again; the person sees why', async () => {
    const extra = await t.signIn(DEV2);
    const session = await sessionOf(extra.cookie);
    const force = (who: string) => t.as(who).post(`/api/v1/sessions/${session.id}/force-logout`).send({ reason: 'Left the laptop unlocked' });
    await force(OWNER).expect(403); // view only
    await force(DEV1).expect(403);
    await force(SALES1).expect(403);
    expect((await force(CTO).expect(403)).body.code).toBe('step_up_required');
    await t.stepUp(CTO);
    await force(CTO).expect(200);
    await extra.get('/api/v1/auth/me').expect(401);
    expect((await force(CTO).expect(409)).body.code).toBe('session_ended');
    await t.as(DEV2).get('/api/v1/auth/me').expect(200); // the other session is untouched
    await settle();
    expect((await prisma.session.findUniqueOrThrow({ where: { id: session.id } })).revokedReason).toBe('forced');
    expect((await eventsOf(DEV2, { action: 'security' })).map((e) => e.description)).toContain(`Signed out by ${CTO} (Omar Farooq): Left the laptop unlocked`);
    const logout = (await eventsOf(DEV2, { action: 'logout', sessionId: session.id }))[0];
    expect((logout.details as { how: string }).how).toBe('forced');
    expect((await eventsOf(CTO, { action: 'security' })).map((e) => e.description)).toContain(`Signed ${DEV2} out (Chrome 142 on Windows)`);
    expect(await prisma.auditLog.count({ where: { action: 'auth.session.forced_logout', targetId: DEV2, reason: 'Left the laptop unlocked' } })).toBe(1);
  });

  it('the CTO cannot sign out someone who is not below him', async () => {
    const extra = await t.signIn(SALES1);
    const session = await sessionOf(extra.cookie);
    await t.stepUp(CTO);
    await t.as(CTO).post(`/api/v1/sessions/${session.id}/force-logout`).send({ reason: 'Not my team' }).expect(403);
    await extra.get('/api/v1/auth/me').expect(200);
  });

  it('locks an account below (every session ends, no sign-in) and unlocks it again', async () => {
    const victim = await t.signIn(LOCK2);
    const lock = (who: string) => t.as(who).post(`/api/v1/employees/${LOCK2}/lock`).send({ reason: 'Suspicious sign-ins' });
    await lock(OWNER).expect(403);
    await lock(SALES1).expect(403);
    expect((await lock(DIRECTOR).expect(403)).body.code).toBe('step_up_required');
    await t.stepUp(DIRECTOR);
    expect((await lock(DIRECTOR).expect(200)).body).toMatchObject({ ok: true, ended: 1 });
    await victim.get('/api/v1/auth/me').expect(401);
    expect((await t.rawLogin({ empId: LOCK2, password: TEST_PASSWORD }).expect(200)).body.status).toBe('locked');
    expect((await lock(DIRECTOR).expect(409)).body.code).toBe('already_locked');
    const locks = await t.as(DIRECTOR).get('/api/v1/accounts/locked').expect(200);
    expect(locks.body).toEqual(expect.arrayContaining([expect.objectContaining({ empId: LOCK2, by: DIRECTOR, reason: 'Suspicious sign-ins' })]));

    await t.as(DEV1).post(`/api/v1/employees/${LOCK2}/unlock`).send({}).expect(403); // no unlock permission
    await t.stepUp(OWNER);
    await t.as(OWNER).post(`/api/v1/employees/${LOCK2}/unlock`).send({}).expect(403); // Module 2's rule: the Owner unlocks only his direct report
    await t.as(DIRECTOR).post(`/api/v1/employees/${LOCK2}/unlock`).send({}).expect(200);
    expect((await t.rawLogin({ empId: LOCK2, password: TEST_PASSWORD }).expect(200)).body.status).toBe('ok');
    await settle();
    expect((await eventsOf(LOCK2, { action: 'security' })).map((e) => e.description)).toEqual(expect.arrayContaining([`Account locked by ${DIRECTOR}`, `Account unlocked by ${DIRECTOR}`]));
    expect((await eventsOf(DIRECTOR, { action: 'security' })).map((e) => e.description)).toEqual(expect.arrayContaining([`Locked the account of ${LOCK2}`, `Unlocked the account of ${LOCK2}`]));
    // An administrator's lock is not the "5 wrong passwords" alert
    expect(await alertsOf(LOCK2, 'account_locked')).toEqual([]);
  });
});

describe('M4 outbox dispatcher (shared with Modules 5 and 6)', () => {
  it('retries a failing consumer with a delay, never repeats a consumer that succeeded, and marks the event processed', async () => {
    const seen = { ok: 0, flaky: 0 };
    let failing = true;
    let mine = '';
    const isMine = (e: OutboxEvent) => e.type === 'payroll.final_settlement.requested' && e.payload.lastWorkingDay === '2030-01-31';
    dispatcher.register({
      name: 'test.ok',
      handles: [{ type: 'payroll.final_settlement.requested', version: 1 }],
      handle: async (e) => {
        if (isMine(e)) seen.ok++;
      },
    });
    dispatcher.register({
      name: 'test.flaky',
      handles: [{ type: 'payroll.final_settlement.requested', version: 1 }],
      handle: async (e) => {
        if (!isMine(e)) return;
        seen.flaky++;
        if (failing) throw new Error('payroll is down');
      },
    });
    await t.app.get(OutboxService).emit({ type: 'payroll.final_settlement.requested', actor: 'system', payload: { empId: 'ACV-0013', lastWorkingDay: '2030-01-31' } });
    mine = (await prisma.outboxEvent.findFirstOrThrow({ where: { type: 'payroll.final_settlement.requested', payload: { path: ['lastWorkingDay'], equals: '2030-01-31' } } })).id;

    await dispatcher.tick();
    let row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: mine } });
    expect(seen).toEqual({ ok: 1, flaky: 1 });
    expect(row).toMatchObject({ processedAt: null, attempts: 1, lockedBy: null });
    expect(row.lastError).toContain('test.flaky: payroll is down');
    expect(row.nextAttemptAt!.getTime()).toBeGreaterThan(t.clock.now().getTime());

    await dispatcher.tick(); // not due yet
    expect(seen).toEqual({ ok: 1, flaky: 1 });

    failing = false;
    t.clock.advance(11_000);
    await dispatcher.tick();
    row = await prisma.outboxEvent.findUniqueOrThrow({ where: { id: mine } });
    expect(seen).toEqual({ ok: 1, flaky: 2 });
    expect(row.processedAt).not.toBeNull();
    expect(row.lastError).toBeNull();
    expect((await prisma.outboxDelivery.findMany({ where: { eventId: mine } })).map((d) => d.consumer).sort()).toEqual(['test.flaky', 'test.ok']);
  });

  it('a consumer name can only be registered once', () => {
    expect(() => dispatcher.register({ name: 'activity.auth', handles: [], handle: async () => undefined })).toThrow(/registered twice/);
  });
});

describe('M4 the alerts list never cuts off an open alert', () => {
  it('returns every open alert, however old, and only the newest checked ones', async () => {
    const [subject, reviewer] = await Promise.all([
      prisma.employee.findUniqueOrThrow({ where: { empId: DEV1 }, select: { id: true } }),
      prisma.employee.findUniqueOrThrow({ where: { empId: CTO }, select: { id: true } }),
    ]);
    const base = t.clock.now().getTime();
    const alert = (key: string, minutesAgo: number) => ({
      id: randomUUID(),
      kind: 'new_device' as const,
      rule: 'Login from a new device',
      severity: 'medium' as const,
      employeeId: subject.id,
      occurredAt: new Date(base - minutesAgo * 60_000),
      details: 'Signed in on a device not used before.',
      dedupeKey: key,
    });
    const oldOpen = alert('test-list-old-open', 3_000); // older than everything below, never checked
    const checked = Array.from({ length: ALERTS_CHECKED_LIMIT + 5 }, (_, i) => alert(`test-list-checked-${i}`, i + 1));
    await prisma.securityAlert.createMany({ data: [oldOpen, ...checked] });
    await prisma.securityAlertCheck.createMany({ data: checked.map((a) => ({ alertId: a.id, checkedBy: reviewer.id, note: 'Looked at it, nothing wrong' })) });

    type Row = { id: string; status: 'open' | 'checked'; at: string };
    const list = async (status?: string) => (await t.as(CTO).get('/api/v1/activity/alerts').query(status ? { status } : {}).expect(200)).body as Row[];

    const all = await list();
    expect(all.find((a) => a.id === oldOpen.id)?.status).toBe('open'); // 505 newer checked alerts do not push it out
    expect(all.filter((a) => a.status === 'checked')).toHaveLength(ALERTS_CHECKED_LIMIT);
    expect(all.some((a) => a.id === checked[ALERTS_CHECKED_LIMIT + 4].id)).toBe(false); // the oldest checked ones are the ones left out
    const times = all.map((a) => a.at);
    expect(times).toEqual([...times].sort().reverse()); // still newest first

    expect((await list('open')).some((a) => a.id === oldOpen.id)).toBe(true);
    const onlyChecked = await list('checked');
    expect(onlyChecked).toHaveLength(ALERTS_CHECKED_LIMIT);
    expect(onlyChecked.every((a) => a.status === 'checked')).toBe(true);
  });
});
