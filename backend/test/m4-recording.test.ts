import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ActivityRecorder } from '../src/activity/activity-recorder.service';
import { OutboxDispatcher } from '../src/events/outbox-dispatcher.service';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type Client, type TestApp } from './helpers/app';
import { createTestPrisma, inRolledBackTransaction } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/** Module 4: the action recorder, blocked attempts, sensitive views, screens and exports (plan section 8). */
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const DEV3 = 'ACV-0008';
const SALES1 = 'ACV-0009';

let t: TestApp;
let prisma: PrismaClient;
let recorder: ActivityRecorder;
let dispatcher: OutboxDispatcher;

/** Writes the recorder's buffer and delivers the outbox events it caused (alert rules, then the alert mails). */
async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await recorder.flush();
    await dispatcher.tick();
  }
}

const eventsOf = (empId: string, where: Record<string, unknown> = {}) =>
  prisma.activityEvent.findMany({ where: { employee: { empId }, ...where }, orderBy: { occurredAt: 'asc' } });
const alertsOf = (empId: string, kind: 'salary_views' | 'finance_attempts' | 'large_export') => prisma.securityAlert.findMany({ where: { employee: { empId }, kind } });

beforeAll(async () => {
  t = await createTestApp();
  prisma = createTestPrisma();
  // Logins at night must not raise "outside working hours" alerts in this file (that rule is tested in m4-alerts).
  await prisma.systemSetting.upsert({ where: { section: 'alert-rules' }, update: { values: { outsideHours: false } }, create: { section: 'alert-rules', values: { outsideHours: false } } });
  await t.signInAll();
  recorder = t.app.get(ActivityRecorder);
  dispatcher = t.app.get(OutboxDispatcher);
  await settle();
});
// The clock only ever moves forward in this file: an authenticator code works once, so going back in time would make
// the next confirm-again reuse an old code.
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M4 action recorder: every change is recorded automatically', () => {
  it('records who changed what, where and from which device, and shows the old and new values from the audit log', async () => {
    const res = await t.as(DIRECTOR).patch('/api/v1/org/departments/dep-hr').send({ name: 'People Operations', reason: 'Renamed for the activity test' }).expect(200);
    await settle();
    const rows = await eventsOf(DIRECTOR, { module: 'Org', target: 'dep-hr' });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ action: 'edit', description: 'Changed department dep-hr', source: 'aceva', financeLinked: false, device: 'Chrome 142 on Windows' });
    expect(rows[0].requestId).toBe(res.headers['x-request-id']); // the same request id as the audit log row
    expect(rows[0].sessionId).not.toBeNull();
    expect(JSON.stringify(rows[0].details)).not.toContain('People Operations'); // never the request body

    const search = await t.as(DIRECTOR).get('/api/v1/activity/events').query({ empId: DIRECTOR, module: 'Org' }).expect(200);
    const found = search.body.find((e: { id: string }) => e.id === rows[0].id);
    expect(found).toMatchObject({ empId: DIRECTOR, action: 'edit', module: 'Org', target: 'dep-hr', device: 'Chrome 142 on Windows' });
    expect(found.changes).toEqual([{ field: 'Name', from: 'Human Resources', to: 'People Operations' }]);
  });

  it('records nothing for requests that only read', async () => {
    const before = await prisma.activityEvent.count({ where: { employee: { empId: DEV1 } } });
    await t.as(DEV1).get('/api/v1/org/tree').expect(200);
    await t.as(DEV1).get(`/api/v1/employees/${DEV1}`).expect(200);
    await settle();
    expect(await prisma.activityEvent.count({ where: { employee: { empId: DEV1 } } })).toBe(before);
  });

  it('a pay change shows WHICH fields changed, never the amounts', async () => {
    await t.stepUp(DIRECTOR);
    await t.as(DIRECTOR).patch(`/api/v1/employees/${DEV3}/pay`).send({ baseSalary: 180000, allowances: 5000, bankName: 'HBL', accountNumber: 'PK11HABB0000000000005678', reason: 'Test pay for M4' }).expect(200);
    await settle();
    const [row] = await eventsOf(DIRECTOR, { module: 'People', target: DEV3, action: 'edit' });
    expect(row.description).toBe(`Changed the pay details of ${DEV3}`);
    const search = await t.as(DIRECTOR).get('/api/v1/activity/events').query({ empId: DIRECTOR, module: 'People' }).expect(200);
    const found = search.body.find((e: { id: string }) => e.id === row.id);
    expect(found.changes).toEqual(expect.arrayContaining([{ field: 'Base salary', from: '', to: 'changed' }, { field: 'Bank account', from: '', to: 'changed' }]));
    const words = JSON.stringify(search.body.map((e: { description: string; changes?: unknown }) => [e.description, e.changes]));
    expect(words).not.toMatch(/180000|5000|PK11HABB/);
  });
});

describe('M4 sensitive views: M3 salary, bank and CNIC reveals are recorded, and many salary views raise an alert', () => {
  it('every reveal is a sensitive view; five salary views within an hour raise one alert, mailed to the Director and the CTO', async () => {
    t.mailer.clear();
    await t.stepUp(DIRECTOR);
    for (let i = 0; i < 5; i++) await t.as(DIRECTOR).post(`/api/v1/employees/${DEV3}/reveal`).send({ field: 'salary' }).expect(200);
    await t.as(DIRECTOR).post(`/api/v1/employees/${DEV3}/reveal`).send({ field: 'account' }).expect(200);
    await settle();

    const views = await eventsOf(DIRECTOR, { action: 'sensitive_view' });
    expect(views.filter((v) => v.description === `Viewed the salary of ${DEV3}`)).toHaveLength(5);
    expect(views.filter((v) => v.description === `Viewed the bank account number of ${DEV3}`)).toHaveLength(1);
    for (const v of views) expect(v).toMatchObject({ module: 'People', target: DEV3, financeLinked: true });
    expect(views.map((v) => (v.details as { category: string }).category)).toEqual(expect.arrayContaining(['salary', 'bank']));
    expect(JSON.stringify(views)).not.toContain('180000'); // the value shown is never recorded
    // M3's own audit entries are still written
    expect(await prisma.auditLog.count({ where: { action: 'employee.sensitive.revealed', targetId: DEV3 } })).toBeGreaterThanOrEqual(6);

    const alerts = await alertsOf(DIRECTOR, 'salary_views');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ rule: 'Many salary records opened in a short time', severity: 'medium' });
    expect(alerts[0].details).toMatch(/salary, bank or payslip records opened in 60 minutes/);
    const subjects = (to: string) => t.mailer.sent.filter((m) => m.to === to).map((m) => m.subject);
    expect(subjects('bilal@acevatech.com')).toContain(`Security alert: Many salary records opened in a short time (${DIRECTOR})`);
    expect(subjects('omar@acevatech.com')).toContain(`Security alert: Many salary records opened in a short time (${DIRECTOR})`);
  });

  it('a CNIC reveal is a sensitive view of personal details (not counted as a salary record)', async () => {
    await t.stepUp(DIRECTOR);
    await t.as(DIRECTOR).patch(`/api/v1/employees/${DEV2}/personal`).send({ cnic: '42101-7654321-1' }).expect(200);
    await t.as(DIRECTOR).post(`/api/v1/employees/${DEV2}/reveal`).send({ field: 'cnic' }).expect(200);
    await settle();
    const [view] = await eventsOf(DIRECTOR, { action: 'sensitive_view', target: DEV2 });
    expect(view).toMatchObject({ description: `Viewed the CNIC of ${DEV2}`, financeLinked: false });
    expect((view.details as { category: string }).category).toBe('personal');
  });

  it('showing yourself your own salary or bank number is recorded, but never counts toward the "many salary records" alert', async () => {
    t.mailer.clear();
    await t.stepUp(DEV3);
    for (let i = 0; i < 5; i++) await t.as(DEV3).post(`/api/v1/employees/${DEV3}/reveal`).send({ field: 'salary' }).expect(200);
    await t.as(DEV3).post(`/api/v1/employees/${DEV3}/reveal`).send({ field: 'account' }).expect(200);
    await settle();
    const views = await eventsOf(DEV3, { action: 'sensitive_view' });
    expect(views).toHaveLength(6); // still on the record
    for (const v of views) expect(v).toMatchObject({ module: 'People', target: DEV3 });
    expect(await alertsOf(DEV3, 'salary_views')).toEqual([]);
    expect(t.mailer.sent.some((m) => m.subject.includes(`(${DEV3})`))).toBe(false);
  });
});

describe('M4 blocked attempts are recorded (403 from the access check or from a service)', () => {
  it('records the refused attempt with what was tried', async () => {
    await t.as(DEV1).patch('/api/v1/org/departments/dep-eng').send({ name: 'Another name', reason: 'Trying without permission' }).expect(403);
    await t.as(CTO).post(`/api/v1/employees/${SALES1}/lock`).send({ reason: 'Not my person' }).expect(403); // Sales is not below the CTO
    await t.as(OWNER).post(`/api/v1/employees/${DEV1}/lock`).send({ reason: 'The owner only watches' }).expect(403); // no control permission
    await settle();
    expect((await eventsOf(DEV1, { action: 'blocked' })).map((e) => e.description)).toContain('Tried to change department dep-eng (no permission)');
    expect((await eventsOf(CTO, { action: 'blocked' })).map((e) => e.description)).toContain(`Tried to lock the account of ${SALES1} (no permission)`);
    expect((await eventsOf(OWNER, { action: 'blocked' })).map((e) => e.description)).toContain(`Tried to lock the account of ${DEV1} (no permission)`);
    const [blocked] = await eventsOf(DEV1, { action: 'blocked' });
    expect(blocked).toMatchObject({ module: 'Org', target: 'dep-eng', financeLinked: false });
    expect((blocked.details as { status: number }).status).toBe(403);
  });

  it('a missing confirm-again is not a blocked attempt (the person is allowed, they only need to confirm)', async () => {
    t.clock.advance(6 * 60_000); // any earlier confirm-again has expired
    const before = await prisma.activityEvent.count({ where: { employee: { empId: DIRECTOR }, action: 'blocked' } });
    const res = await t.as(DIRECTOR).post(`/api/v1/employees/${DEV2}/lock`).send({ reason: 'Testing the confirm-again' }).expect(403);
    expect(res.body.code).toBe('step_up_required');
    await settle();
    expect(await prisma.activityEvent.count({ where: { employee: { empId: DIRECTOR }, action: 'blocked' } })).toBe(before);
    expect((await prisma.credential.findFirstOrThrow({ where: { employee: { empId: DEV2 } } })).lockedAt).toBeNull();
  });
});

describe('M4 screens opened, and repeated attempts to open finance screens', () => {
  it('records each screen; a finance screen without permission is a blocked attempt, and three in 15 minutes raise an alert', async () => {
    await t.as(DEV2).post('/api/v1/activity/screen').send({ screen: 'Tasks', path: '/tasks' }).expect(200);
    await t.as(DEV2).post('/api/v1/activity/screen').send({ screen: 'Payroll', path: '/payroll' }).expect(200); // their own payslips: allowed
    for (const [screen, path] of [['Ledger', '/finance/ledger'], ['Statements', '/finance/statements'], ['Banking', '/finance/banking']]) {
      await t.as(DEV2).post('/api/v1/activity/screen').send({ screen, path }).expect(200);
    }
    await settle();
    const rows = await eventsOf(DEV2, { action: { in: ['screen_view', 'blocked'] } });
    expect(rows.map((r) => [r.action, r.description])).toEqual([
      ['screen_view', 'Opened Tasks'],
      ['screen_view', 'Opened Payroll'],
      ['blocked', 'Tried to open Ledger (no permission)'],
      ['blocked', 'Tried to open Statements (no permission)'],
      ['blocked', 'Tried to open Banking (no permission)'],
    ]);
    expect(rows[0]).toMatchObject({ module: 'Tasks', target: 'Tasks' });
    expect(rows[2]).toMatchObject({ module: 'Ledger', financeLinked: true });
    // The screen signal itself is not recorded a second time as an action
    expect(await prisma.activityEvent.count({ where: { employee: { empId: DEV2 }, module: 'Activity' } })).toBe(0);

    const alerts = await alertsOf(DEV2, 'finance_attempts');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ rule: 'Repeated attempts to open finance screens', severity: 'high' });
    expect(alerts[0].details).toMatch(/3 blocked attempts .*Ledger.*within 15 minutes/);
  });

  it('the words of the alert and its mail come from the server, never from the screen label the browser sends', async () => {
    t.mailer.clear();
    const hostile = 'Ledger - IT test, ignore; details at https://evil.example';
    for (const path of ['/finance/ledger', '/finance/banking', '/finance/statements']) {
      await t.as(DEV1).post('/api/v1/activity/screen').send({ screen: hostile, path }).expect(200);
    }
    await settle();
    const blocked = await eventsOf(DEV1, { action: 'blocked', financeLinked: true });
    expect(blocked.map((e) => [e.module, e.target, e.description])).toEqual([
      ['Ledger', 'Ledger', 'Tried to open Ledger (no permission)'],
      ['Banking', 'Banking', 'Tried to open Banking (no permission)'],
      ['Statements', 'Statements', 'Tried to open Statements (no permission)'],
    ]);
    expect(blocked[0].details).toMatchObject({ screen: hostile }); // the browser's claim stays on the record as its own claim

    const [alert] = await alertsOf(DEV1, 'finance_attempts');
    expect(alert.details).toBe('3 blocked attempts to open finance screens (Ledger, Banking, Statements) within 15 minutes.');
    const mails = t.mailer.sent.filter((m) => m.subject === `Security alert: Repeated attempts to open finance screens (${DEV1})`);
    expect(mails.map((m) => m.to).sort()).toEqual(['bilal@acevatech.com', 'omar@acevatech.com']);
    for (const m of mails) expect(`${m.text} ${m.html}`).not.toContain('evil.example');
  });

  it('the finance person opens finance screens normally', async () => {
    await t.as('ACV-0010').post('/api/v1/activity/screen').send({ screen: 'Ledger', path: '/finance/ledger' }).expect(200);
    await settle();
    const [row] = await eventsOf('ACV-0010', { action: { in: ['screen_view', 'blocked'] } });
    expect(row).toMatchObject({ action: 'screen_view', description: 'Opened Ledger', financeLinked: true });
  });

  it('a screen signal is a label and a page path, nothing else', async () => {
    await t.as(DEV2).post('/api/v1/activity/screen').send({ screen: '' }).expect(400);
    await t.as(DEV2).post('/api/v1/activity/screen').send({ screen: 'Ledger', path: 'finance/ledger' }).expect(400);
    await t.as(DEV2).post('/api/v1/activity/screen').send({ screen: 'Ledger', keys: 'secret typing' }).expect(400);
    await t.anonymous().post('/api/v1/activity/screen').send({ screen: 'Tasks' }).expect(401);
  });
});

describe('M4 exports are recorded, and large exports of finance or employee data raise an alert', () => {
  it('records every export; a large finance export raises one alert', async () => {
    await t.as(DIRECTOR).post('/api/v1/activity/export').send({ rows: 120, format: 'xlsx' }).expect(200);
    await t.as(DIRECTOR).post('/api/v1/activity/export').send({ rows: 1240, format: 'pdf', module: 'Ledger', dataset: 'General ledger' }).expect(200);
    await settle();
    const exports = await eventsOf(DIRECTOR, { action: 'export' });
    expect(exports.map((e) => e.description)).toEqual(['Exported 120 rows of Activity data (XLSX)', 'Exported 1,240 rows of General ledger (PDF)']);
    expect(exports[1]).toMatchObject({ module: 'Ledger', financeLinked: true });
    const alerts = await alertsOf(DIRECTOR, 'large_export');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ rule: 'Large export of finance data', details: '1,240 rows exported from Ledger.' });
  });

  it('a flood of export records is ignored: a few per session and per person a minute are recorded, and it raises one alert and one mail each', async () => {
    // Sessions first (a sign-in can move the clock), then the burst
    const second = await t.signIn(DEV1);
    const third = await t.signIn(DEV1);
    t.mailer.clear();
    const burst = async (who: Client, times: number): Promise<boolean[]> => {
      const recorded: boolean[] = [];
      for (let i = 0; i < times; i++) {
        const res = await who.post('/api/v1/activity/export').send({ rows: 600, format: 'xlsx', module: 'People', dataset: 'Staff list' }).expect(200);
        recorded.push(res.body.recorded as boolean);
      }
      return recorded;
    };
    const ten = Array<boolean>(10).fill(true);
    expect(await burst(t.as(DEV1), 12)).toEqual([...ten, false, false]); // 10 a minute for one session
    expect(await burst(second, 12)).toEqual([...ten, false, false]);
    expect(await burst(third, 3)).toEqual([false, false, false]); // a new session gives no new allowance: the person is at 20 a minute
    await settle();
    expect(await eventsOf(DEV1, { action: 'export' })).toHaveLength(20);
    const alerts = await alertsOf(DEV1, 'large_export');
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ rule: 'Large export of employee data', details: '600 rows exported from People.' });
    const mails = t.mailer.sent.filter((m) => m.subject === `Security alert: Large export of employee data (${DEV1})`);
    expect(mails.map((m) => m.to).sort()).toEqual(['bilal@acevatech.com', 'omar@acevatech.com']);
  });

  it('large exports raise one alert per kind of data per hour: another large export of the same kind is only logged', async () => {
    const send = (module: string, rows: number) => t.as(SALES1).post('/api/v1/activity/export').send({ rows, format: 'pdf', module }).expect(200);
    await send('People', 600);
    await send('People', 900);
    await send('Ledger', 700);
    await settle();
    expect(await eventsOf(SALES1, { action: 'export' })).toHaveLength(3);
    expect((await alertsOf(SALES1, 'large_export')).map((a) => a.rule).sort()).toEqual(['Large export of employee data', 'Large export of finance data']);
  });

  it('refuses a malformed export record', async () => {
    await t.as(DIRECTOR).post('/api/v1/activity/export').send({ rows: -1, format: 'xlsx' }).expect(400);
    await t.as(DIRECTOR).post('/api/v1/activity/export').send({ rows: 10, format: 'docx' }).expect(400);
  });
});

describe('M4 tracking data can never be edited or deleted', () => {
  async function sqlError(sql: string): Promise<string | null> {
    try {
      await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(sql);
      });
      return null;
    } catch (error) {
      return String((error as Error).message);
    }
  }

  const owner = `SELECT id FROM employees WHERE emp_id = '${OWNER}'`;
  const tables: Array<[string, string]> = [
    ['activity_events', `INSERT INTO activity_events (occurred_at, employee_id, action, module, description) SELECT now(), id, 'edit', 'People', 'x' FROM (${owner}) e`],
    ['activity_heartbeats', `INSERT INTO activity_heartbeats (session_id, employee_id, at, active) SELECT s.id, s.employee_id, now(), true FROM sessions s LIMIT 1`],
    ['activity_daily_summaries', `INSERT INTO activity_daily_summaries (employee_id, day, active_minutes, idle_minutes, actions, sessions) SELECT id, '2026-01-05', 10, 5, 1, 1 FROM (${owner}) e`],
    ['security_alerts', `INSERT INTO security_alerts (kind, rule, severity, employee_id, occurred_at, details, dedupe_key) SELECT 'new_device', 'r', 'low', id, now(), 'd', 'test-insert-only' FROM (${owner}) e`],
    [
      'security_alert_checks',
      `WITH a AS (INSERT INTO security_alerts (kind, rule, severity, employee_id, occurred_at, details, dedupe_key) SELECT 'new_device', 'r', 'low', id, now(), 'd', 'test-check-insert-only' FROM (${owner}) e RETURNING id, employee_id)
       INSERT INTO security_alert_checks (alert_id, checked_by, note) SELECT id, employee_id, 'looked at it' FROM a`,
    ],
  ];

  for (const [table, insert] of tables) {
    it(`${table}: allows inserts but blocks update, delete and truncate`, async () => {
      expect(await sqlError(insert)).toBeNull();
      for (const change of [`UPDATE ${table} SET id = id`, `DELETE FROM ${table}`, `TRUNCATE ${table} CASCADE`]) {
        expect(await sqlError(`${insert}; ${change}`), `${table}: ${change}`).toMatch(/insert-only/);
      }
    });
  }

  it('checks the shape of what is stored', async () => {
    expect(await sqlError(`INSERT INTO activity_events (occurred_at, employee_id, action, module, description, source) SELECT now(), id, 'edit', 'People', 'x', 'Not A Tool' FROM (${owner}) e`)).toMatch(/activity_events_source_format/);
    expect(await sqlError(`INSERT INTO activity_daily_summaries (employee_id, day, active_minutes, idle_minutes, actions, sessions) SELECT id, '2026-01-06', 1000, 1000, 0, 1 FROM (${owner}) e`)).toMatch(/activity_daily_summaries_minutes/);
  });

  it('the API has no way to edit or delete tracking data', async () => {
    const [row] = await eventsOf(DIRECTOR);
    await t.as(DIRECTOR).patch(`/api/v1/activity/events/${row.id}`).send({ description: 'changed' }).expect(404);
    await t.as(DIRECTOR).delete(`/api/v1/activity/events/${row.id}`).expect(404);
  });
});
