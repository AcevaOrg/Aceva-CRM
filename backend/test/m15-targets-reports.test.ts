import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { addDays, monthOf, pkDate, pkInstant } from '../src/common/pakistan-time';
import { SALES_NIGHTLY_JOB } from '../src/sales/lead-archive.service';
import { SALES_DAILY_REPORT_JOB, SalesDailyReportService } from '../src/sales/sales-daily-report.service';
import { WorkCalendarService } from '../src/attendance/work-calendar.service';
import { createTestApp, type SignedIn, type TestApp } from './helpers/app';
import { createEmployee } from './helpers/people';
import { SalesMetricsService } from '../src/sales/sales-metrics.service';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 15.6: targets, the manual daily log, proof requests, the nightly daily report and the dashboard (plan section 20),
 * against the real database. Approved rules: decisions 10-16 and the M15.6 answers (monthly targets = meetings, proposals,
 * deals won; reports for the sales staff; leads added count for whoever added them; the report notification to managers).
 */
const API = '/api/v1';
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const HIRA = 'ACV-0009';
const FINANCE = 'ACV-0010';
const KAMRAN = 'ACV-0012';
const SAAD = 'ACV-0014';

let t: TestApp;
let prisma: PrismaClient;
let today = '';
let month = '';
const ids: Record<string, string> = {};
/**
 * The sales staff as the corrected rule defines them: active employees of the Sales department holding sales.own (Hira,
 * Kamran, Saad) and the sales managers (the Director, through the role's sales.targets). Not the Level 4 test fixture HR
 * officer (default "sales" role, outside the Sales department), not Finance, not the CEO / Owner.
 */
const staff = [DIRECTOR, HIRA, KAMRAN, SAAD];

const as = (who: string) => t.as(who);
const put = (who: string, url: string) => request(t.app.getHttpServer()).put(url).set((t.as(who) as SignedIn).headers());
const inDays = (n: number) => addDays(today, n);
const reports = () => t.app.get(SalesDailyReportService);
let n = 0;
async function newLead(who: string, over: Record<string, unknown> = {}): Promise<string> {
  n++;
  const site = `perf${n}.test`;
  return (await as(who).post(`${API}/sales/leads`).send({ source: 'linkedin', fullName: `Prospect ${n}`, email: `p${n}@${site}`, company: { name: `Perf Co ${n}`, website: site }, ...over }).expect(201)).body.id;
}
async function newDeal(who: string, leadId: string, currency = 'USD', value = '1000.00') {
  return (await as(who).post(`${API}/sales/deals`).send({ leadId, service: 'website', value, currency, expectedClose: inDays(30), nextStep: 'Call them', nextStepDate: today }).expect(201)).body as { id: string; number: string; version: number };
}
const version = async (id: string) => (await prisma.salesDeal.findUniqueOrThrow({ where: { id } })).version;
const daily = (who: string, body: Record<string, unknown>) => put(who, `${API}/sales/targets/daily`).send(body);
const monthly = (who: string, body: Record<string, unknown>) => put(who, `${API}/sales/targets/monthly`).send(body);
const saveLog = (who: string, day: string, body: Record<string, unknown>) => put(who, `${API}/sales/daily-logs/${day}`).send({ linkedin: 0, whatsapp: 0, fiverr: 0, calls: 0, fieldVisits: 0, ...body });
const progress = async (who: string, empId?: string) => (await as(who).get(`${API}/sales/progress${empId ? `?empId=${empId}` : ''}`).expect(200)).body;

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  prisma = createTestPrisma();
  today = pkDate(t.clock.now());
  month = monthOf(today);
  for (const e of await prisma.employee.findMany({ select: { id: true, empId: true } })) ids[e.empId] = e.id;
}, 180000);
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

// ============================================================================================================== targets

describe('M15.6 targets', () => {
  it('only the sales manager sets them, for someone in the team working on sales, never their own; the CEO / Owner views', async () => {
    const body = { empId: HIRA, effectiveFrom: today, leadsAdded: 2, emailsChecked: 5, emailsSent: 1, followUpsDone: 1 };
    for (const who of [HIRA, KAMRAN, OWNER]) await daily(who, body).expect(403);
    await daily(FINANCE, body).expect(403); // no sales access at all
    expect((await daily(DIRECTOR, { ...body, empId: DIRECTOR }).expect(403)).body.code).toBe('own_targets');
    expect((await daily(DIRECTOR, { ...body, empId: CTO }).expect(400)).body.code).toBe('not_sales');
    // values and dates are checked
    await daily(DIRECTOR, { ...body, leadsAdded: -1 }).expect(400);
    await daily(DIRECTOR, { ...body, emailsSent: 10_001 }).expect(400);
    await daily(DIRECTOR, { ...body, leadsAdded: 1.5 }).expect(400);
    await daily(DIRECTOR, { empId: HIRA, effectiveFrom: today }).expect(400); // nothing to set
    expect((await daily(DIRECTOR, { ...body, effectiveFrom: inDays(-1) }).expect(400)).body.code).toBe('target_in_past');
    const row = (await daily(DIRECTOR, body).expect(200)).body;
    expect(row).toMatchObject({ person: { empId: HIRA }, daily: { effectiveFrom: today, leadsAdded: 2, emailsChecked: 5, emailsSent: 1, followUpsDone: 1, setBy: { empId: DIRECTOR } }, canEdit: true });
    await monthly(HIRA, { empId: HIRA, month, meetingsBooked: 1 }).expect(403);
    await monthly(DIRECTOR, { empId: HIRA, month, wonValue: { amount: '0', currency: 'USD' } }).expect(400);
    await monthly(DIRECTOR, { empId: HIRA, month, wonValue: { amount: '500.00', currency: 'EUR' } }).expect(400);
    expect((await monthly(DIRECTOR, { empId: HIRA, month: monthOf(addDays(`${month}-01`, -1)), meetingsBooked: 1 }).expect(400)).body.code).toBe('target_in_past');
    const m = (await monthly(DIRECTOR, { empId: HIRA, month, meetingsBooked: 1, proposalsSent: 1, wonValue: { amount: '500.00', currency: 'USD' } }).expect(200)).body;
    expect(m.monthly).toMatchObject({ month, meetingsBooked: 1, proposalsSent: 1, wonValue: { amount: '500.00', currency: 'USD' } });
    // views: the team for the sales manager and the CEO / Owner; a salesperson sees only their own
    const owner = (await as(OWNER).get(`${API}/sales/targets`).expect(200)).body;
    expect(owner.map((r: { person: { empId: string } }) => r.person.empId)).toEqual(staff);
    expect(owner.every((r: { canEdit: boolean }) => !r.canEdit)).toBe(true);
    const hira = (await as(HIRA).get(`${API}/sales/targets`).expect(200)).body;
    expect(hira.map((r: { person: { empId: string } }) => r.person.empId)).toEqual([HIRA]);
    await as(FINANCE).get(`${API}/sales/targets`).expect(403);
  });

  it('a change is a new version from a later day; a field left out keeps its value; history never changes', async () => {
    const row = (await daily(DIRECTOR, { empId: HIRA, effectiveFrom: inDays(3), followUpsDone: 4 }).expect(200)).body;
    expect(row.daily).toMatchObject({ effectiveFrom: today, followUpsDone: 1 }); // still in force today
    expect(row.dailyNext).toMatchObject({ effectiveFrom: inDays(3), followUpsDone: 4, leadsAdded: 2, emailsSent: 1, emailsChecked: 5 });
    const rows = await prisma.salesDailyTarget.findMany({ where: { employeeId: ids[HIRA] } });
    expect(rows).toHaveLength(2);
    await expect(prisma.salesDailyTarget.update({ where: { id: rows[0].id }, data: { leadsAdded: 9 } })).rejects.toThrow(/insert-only/);
    await expect(prisma.salesMonthlyTarget.deleteMany({})).rejects.toThrow(/insert-only/);
    expect(await prisma.auditLog.count({ where: { action: 'sales.targets.daily_set', targetId: HIRA } })).toBe(2);
  });
});

// ================================================================================================ measures and the log

describe('M15.6 measures', () => {
  it('counts leads added (by whoever added them), follow-ups done and hand-logged emails; emails checked is not measured', async () => {
    const l1 = await newLead(HIRA);
    await newLead(HIRA);
    await as(HIRA).post(`${API}/sales/leads/${l1}/activities`).send({ kind: 'email_sent', summary: 'Intro email' }).expect(201);
    // an email logged on a do-not-contact lead is refused, so it never counts; nor does a lead the Director adds for Hira
    const dnc = await newLead(HIRA);
    await as(HIRA).post(`${API}/sales/leads/${dnc}/do-not-contact`).send({ reason: 'Asked not to be contacted' }).expect(200);
    await as(HIRA).post(`${API}/sales/leads/${dnc}/activities`).send({ kind: 'email_sent', summary: 'Should not count' }).expect(409);
    await as(DIRECTOR).post(`${API}/sales/leads`).send({ source: 'referral', fullName: 'For Hira', email: 'forhira@perf-dir.test', ownerEmpId: HIRA }).expect(201);
    const p = await progress(HIRA);
    expect(p.today.metrics).toEqual({
      leadsAdded: { value: 3, measured: true, target: 2, met: true },
      emailsChecked: { value: null, measured: false, target: 5, met: null },
      emailsSent: { value: 1, measured: true, target: 1, met: true },
      followUpsDone: { value: 0, measured: true, target: 1, met: false },
    });
    expect(p.today.met).toBe(false);
    // the follow-up done: every target set and measured is met; emails checked is left out, not counted as missed
    const deal = await newDeal(HIRA, l1);
    await as(HIRA).post(`${API}/sales/deals/${deal.id}/follow-up`).send({ nextStep: 'Send the proposal', nextStepDate: inDays(2), version: await version(deal.id) }).expect(200);
    const after = await progress(HIRA);
    expect(after.today.metrics.followUpsDone).toEqual({ value: 1, measured: true, target: 1, met: true });
    expect(after.today.met).toBe(true);
    // the Director's lead counts for the Director (who added it), not for Hira
    expect((await progress(DIRECTOR, HIRA)).today.metrics.leadsAdded.value).toBe(3);
    // nobody with no target: the day has no result (not "met", not "missed")
    expect((await progress(KAMRAN)).today).toMatchObject({ met: null, metrics: { leadsAdded: { target: null, met: null } } });
  });

  it('days are Pakistan days: a lead added at 23:59 belongs to the day before', async () => {
    const id = await newLead(SAAD);
    await prisma.salesLead.update({ where: { id }, data: { createdAt: new Date(pkInstant(today).getTime() - 60_000) } });
    expect((await progress(SAAD)).today.metrics.leadsAdded.value).toBe(0);
    await prisma.salesLead.update({ where: { id }, data: { createdAt: pkInstant(today) } });
    expect((await progress(SAAD)).today.metrics.leadsAdded.value).toBe(1);
  });

  it('activity on an archived lead cannot be logged, so it never counts', async () => {
    const id = await newLead(SAAD);
    await prisma.salesLead.update({ where: { id }, data: { archivedAt: new Date() } });
    await as(SAAD).post(`${API}/sales/leads/${id}/activities`).send({ kind: 'email_sent', summary: 'Archived' }).expect(409);
    expect((await progress(SAAD)).today.metrics.emailsSent.value).toBe(0);
  });

  it('a salesperson sees only their own progress; the sales manager and the CEO / Owner see the team', async () => {
    await as(KAMRAN).get(`${API}/sales/progress?empId=${HIRA}`).expect(403);
    await as(DIRECTOR).get(`${API}/sales/progress?empId=${HIRA}`).expect(200);
    await as(OWNER).get(`${API}/sales/progress?empId=${HIRA}`).expect(200);
  });
});

describe('M15.6 daily log', () => {
  it('the sales staff keep their own log; every save is a new version naming the one read; changes at the same moment: one wins', async () => {
    await saveLog(CTO, today, { calls: 1, version: 0 }).expect(403);
    await saveLog(FINANCE, today, { calls: 1, version: 0 }).expect(403); // no sales access at all
    await saveLog(HIRA, inDays(1), { calls: 1, version: 0 }).expect(400);
    expect((await saveLog(HIRA, inDays(-2), { calls: 1, version: 0 }).expect(409)).body.code).toBe('log_locked');
    await saveLog(HIRA, today, { calls: 1001, version: 0 }).expect(400);
    const v1 = (await saveLog(HIRA, today, { linkedin: 4, calls: 2, note: 'Two calls from referrals', version: 0 }).expect(200)).body;
    expect(v1).toMatchObject({ version: 1, counts: { linkedin: 4, whatsapp: 0, fiverr: 0, calls: 2, fieldVisits: 0 }, locked: false, history: [] });
    expect((await saveLog(HIRA, today, { linkedin: 1, version: 0 }).expect(409)).body.code).toBe('stale_version');
    const [a, b] = await Promise.all([saveLog(HIRA, today, { linkedin: 5, calls: 2, version: 1 }), saveLog(HIRA, today, { linkedin: 6, calls: 2, version: 1 })]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    const cur = (await as(HIRA).get(`${API}/sales/daily-logs/${today}`).expect(200)).body.log;
    expect(cur.version).toBe(2);
    expect(cur.history).toEqual([expect.objectContaining({ version: 1, counts: expect.objectContaining({ linkedin: 4 }) })]);
    // earlier versions never change
    const first = await prisma.salesDailyLog.findFirstOrThrow({ where: { employeeId: ids[HIRA], version: 1 } });
    await expect(prisma.salesDailyLog.update({ where: { id: first.id }, data: { calls: 9 } })).rejects.toThrow(/insert-only/);
    // the sales manager sees it; another salesperson does not
    await as(DIRECTOR).get(`${API}/sales/daily-logs/${today}?empId=${HIRA}`).expect(200);
    await as(KAMRAN).get(`${API}/sales/daily-logs/${today}?empId=${HIRA}`).expect(403);
  });
});

// ================================================================================================= reports and proof

describe('M15.6 nightly report', () => {
  it('runs at 00:30 Pakistan time, apart from the 02:00 archive job', async () => {
    await reports().scheduleFor(inDays(1));
    const job = await prisma.scheduledJob.findUniqueOrThrow({ where: { dedupeKey: `${SALES_DAILY_REPORT_JOB}:${inDays(1)}` } });
    expect(job.runAt).toEqual(pkInstant(inDays(1), 30));
    expect(job.runAt.toISOString().slice(11, 16)).toBe('19:30'); // 00:30 in Pakistan (UTC+5) is 19:30 UTC the day before
    expect(SALES_DAILY_REPORT_JOB).not.toBe(SALES_NIGHTLY_JOB);
    expect(pkInstant(inDays(1), 2 * 60).getTime() - job.runAt.getTime()).toBe(90 * 60_000);
  });

  it('builds one report per salesperson and working day, keeping the targets, measures, log version and result it used', async () => {
    const built = await reports().buildDay(today, `test:${today}`);
    expect(built).toBe(staff.length); // the sales staff, the Director (sales manager) included
    const view = (await as(DIRECTOR).get(`${API}/sales/reports/daily?day=${today}`).expect(200)).body;
    const hira = view.find((r: { person: { empId: string } }) => r.person.empId === HIRA);
    expect(hira).toMatchObject({ day: today, met: true, unmeasured: ['emailsChecked'], log: { version: 2 }, proof: null });
    expect(hira.metrics.emailsChecked).toEqual({ value: null, measured: false, target: 5, met: null });
    expect(view.find((r: { person: { empId: string } }) => r.person.empId === KAMRAN)).toMatchObject({ met: null, log: null });
    // a salesperson sees only their own report
    expect((await as(HIRA).get(`${API}/sales/reports/daily?day=${today}`).expect(200)).body.map((r: { person: { empId: string } }) => r.person.empId)).toEqual([HIRA]);
    expect((await as(HIRA).get(`${API}/sales/reports/daily/dates`).expect(200)).body).toEqual([today]);
  });

  it('a built report never changes: later work, a new target, another run or two runs at once change nothing', async () => {
    const before = await prisma.salesDailyReport.findFirstOrThrow({ where: { employeeId: ids[HIRA] } });
    await as(HIRA).post(`${API}/sales/leads/${await newLead(HIRA)}/activities`).send({ kind: 'email_sent', summary: 'After the report' }).expect(201);
    await daily(DIRECTOR, { empId: HIRA, effectiveFrom: today, emailsSent: 9 }).expect(200);
    const [x, y] = await Promise.all([reports().buildDay(today, 'again-1'), reports().buildDay(today, 'again-2')]);
    expect(x + y).toBe(0);
    expect(await prisma.salesDailyReport.findFirstOrThrow({ where: { employeeId: ids[HIRA] } })).toEqual(before);
    await expect(prisma.salesDailyReport.update({ where: { id: before.id }, data: { met: false } })).rejects.toThrow(/insert-only/);
    expect(await prisma.salesDailyReport.count()).toBe(staff.length);
  });

  it('once the report exists the log is locked (service and database)', async () => {
    expect((await saveLog(HIRA, today, { linkedin: 7, version: 2 }).expect(409)).body.code).toBe('log_locked');
    await expect(prisma.salesDailyLog.create({ data: { employeeId: ids[HIRA], day: new Date(`${today}T00:00:00.000Z`), version: 3, linkedin: 1, whatsapp: 0, fiverr: 0, calls: 0, fieldVisits: 0 } })).rejects.toThrow(/log_locked/);
    expect((await as(HIRA).get(`${API}/sales/daily-logs/${today}`).expect(200)).body.log.locked).toBe(true);
    expect((await as(KAMRAN).get(`${API}/sales/daily-logs/${today}`).expect(200)).body).toEqual({ log: null });
  });

  it('tells each sales manager once that the report is ready (Module 12: in the app and by email); a second run adds nothing', async () => {
    const notes = await prisma.notification.findMany({ where: { type: 'sales_daily_report' }, include: { deliveries: true } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ recipientId: ids[DIRECTOR], title: `Sales report of ${today} is ready`, body: '1 of 1 met their targets (3 in the report).', link: `/sales/reports?date=${today}`, essential: false });
    expect(notes[0].deliveries.map((d) => d.channel)).toEqual(['email']);
    await reports().buildDay(today, 'again-3');
    expect(await prisma.notification.count({ where: { type: 'sales_daily_report' } })).toBe(1);
  });

  it('a night builds only working days of the last week that have no report yet', async () => {
    const res = await reports().runNight(inDays(1));
    const calendar = t.app.get(WorkCalendarService);
    for (const [day, count] of Object.entries(res.built)) {
      expect(await calendar.isWorkingDay(day), day).toBe(true);
      expect(count).toBe(staff.length);
    }
    expect(res.built[today]).toBeUndefined(); // already built
  });
});

describe('M15.6 proof requests', () => {
  it('the sales manager asks, the salesperson answers, the manager closes; each step is audited and the person is told once', async () => {
    const note = 'Please send a screenshot of the LinkedIn messages';
    for (const who of [HIRA, KAMRAN, OWNER]) await as(who).post(`${API}/sales/proof-requests`).send({ empId: HIRA, day: today, note }).expect(403);
    expect((await as(DIRECTOR).post(`${API}/sales/proof-requests`).send({ empId: KAMRAN, day: today, note }).expect(409)).body.code).toBe('no_log');
    const req = (await as(DIRECTOR).post(`${API}/sales/proof-requests`).send({ empId: HIRA, day: today, note }).expect(201)).body;
    expect(req).toMatchObject({ person: { empId: HIRA }, day: today, logVersion: 2, status: 'open', requestedBy: { empId: DIRECTOR } });
    expect((await as(DIRECTOR).post(`${API}/sales/proof-requests`).send({ empId: HIRA, day: today, note }).expect(409)).body.code).toBe('proof_open');
    const notes = await prisma.notification.findMany({ where: { type: 'sales_proof_requested' } });
    expect(notes).toEqual([expect.objectContaining({ recipientId: ids[HIRA], dedupeKey: `sales_proof_requested:${req.id}`, body: note })]);
    // the report shows it
    expect((await as(HIRA).get(`${API}/sales/reports/daily?day=${today}`).expect(200)).body[0].proof).toEqual({ id: req.id, status: 'open' });
    await as(KAMRAN).post(`${API}/sales/proof-requests/${req.id}/answer`).send({ answer: 'Not mine' }).expect(403);
    await as(DIRECTOR).post(`${API}/sales/proof-requests/${req.id}/answer`).send({ answer: 'Answering for Hira' }).expect(403);
    await as(HIRA).post(`${API}/sales/proof-requests/${req.id}/answer`).send({ answer: 'Sent the screenshots in a direct message' }).expect(200);
    await as(HIRA).post(`${API}/sales/proof-requests/${req.id}/answer`).send({ answer: 'Again' }).expect(409);
    await as(HIRA).post(`${API}/sales/proof-requests/${req.id}/close`).send({ note: 'Closing my own request' }).expect(403);
    const closed = (await as(DIRECTOR).post(`${API}/sales/proof-requests/${req.id}/close`).send({ note: 'Screenshots received, thank you' }).expect(200)).body;
    expect(closed).toMatchObject({ status: 'closed', answer: 'Sent the screenshots in a direct message', closedBy: { empId: DIRECTOR } });
    for (const action of ['sales.proof.requested', 'sales.proof.answered', 'sales.proof.closed']) expect(await prisma.auditLog.count({ where: { action, targetId: req.id } }), action).toBe(1);
    // a closed request is final (database)
    await expect(prisma.salesProofRequest.update({ where: { id: req.id }, data: { status: 'open' } })).rejects.toThrow(/proof_request_final/);
    // lists: own, or the team
    expect((await as(HIRA).get(`${API}/sales/proof-requests`).expect(200)).body).toHaveLength(1);
    expect((await as(KAMRAN).get(`${API}/sales/proof-requests`).expect(200)).body).toHaveLength(0);
    expect((await as(DIRECTOR).get(`${API}/sales/proof-requests?status=closed`).expect(200)).body).toHaveLength(1);
  });
});

// ============================================================================================================ dashboard

describe('M15.6 dashboard', () => {
  it('totals per currency (never converted); the deals-won target counts only its own currency, the other is shown apart', async () => {
    const before = (await as(DIRECTOR).get(`${API}/sales/dashboard`).expect(200)).body;
    const usd = await newDeal(HIRA, await newLead(HIRA), 'USD', '1000.00');
    const pkr = await newDeal(HIRA, await newLead(HIRA), 'PKR', '250000.00');
    for (const d of [usd, pkr]) {
      await as(HIRA).post(`${API}/sales/deals/${d.id}/request-won`).send({ version: await version(d.id) }).expect(200);
      await as(DIRECTOR).post(`${API}/sales/deals/${d.id}/confirm-won`).send({ version: await version(d.id) }).expect(200);
    }
    const after = (await as(DIRECTOR).get(`${API}/sales/dashboard`).expect(200)).body;
    const total = (v: { won: { totals: Array<{ currency: string; total: string }> } }, c: string) => Number(v.won.totals.find((x) => x.currency === c)?.total ?? 0);
    expect(total(after, 'USD') - total(before, 'USD')).toBe(1000);
    expect(total(after, 'PKR') - total(before, 'PKR')).toBe(250000);
    expect(JSON.stringify(after)).not.toMatch(/valueUsd|exchange|rate/i);
    const hira = after.people.find((p: { person: { empId: string } }) => p.person.empId === HIRA);
    expect(hira.month.wonValue).toMatchObject({ target: { amount: '500.00', currency: 'USD' }, inTargetCurrency: '1000.00', met: true });
    expect(hira.month.wonValue.byCurrency).toEqual(expect.arrayContaining([expect.objectContaining({ currency: 'PKR', total: '250000.00' }), expect.objectContaining({ currency: 'USD', total: '1000.00' })]));
  });

  it('counts only moves to the very next stage, from the stage history; a jump or the current stage is never counted', async () => {
    const before = (await as(DIRECTOR).get(`${API}/sales/dashboard`).expect(200)).body.stageMoves as Array<{ from: string; to: string; count: number }>;
    const step = await newDeal(SAAD, await newLead(SAAD));
    for (const to of ['contacted', 'replied', 'meeting_booked', 'proposal_sent', 'negotiation']) {
      await as(SAAD).post(`${API}/sales/deals/${step.id}/move`).send({ toStage: to, version: await version(step.id) }).expect(200);
    }
    await as(SAAD).post(`${API}/sales/deals/${step.id}/request-won`).send({ version: await version(step.id) }).expect(200);
    await as(DIRECTOR).post(`${API}/sales/deals/${step.id}/confirm-won`).send({ version: await version(step.id) }).expect(200);
    const jump = await newDeal(SAAD, await newLead(SAAD));
    await as(SAAD).post(`${API}/sales/deals/${jump.id}/move`).send({ toStage: 'negotiation', version: await version(jump.id) }).expect(200);
    const after = (await as(DIRECTOR).get(`${API}/sales/dashboard`).expect(200)).body.stageMoves as Array<{ from: string; to: string; count: number }>;
    const delta = after.map((m) => ({ ...m, count: m.count - (before.find((b) => b.from === m.from && b.to === m.to)?.count ?? 0) }));
    expect(delta).toEqual([
      { from: 'new', to: 'contacted', count: 1 },
      { from: 'contacted', to: 'replied', count: 1 },
      { from: 'replied', to: 'meeting_booked', count: 1 },
      { from: 'meeting_booked', to: 'proposal_sent', count: 1 },
      { from: 'proposal_sent', to: 'negotiation', count: 1 },
      { from: 'negotiation', to: 'won', count: 1 },
    ]);
  });

  it('the team for the sales manager and the CEO / Owner; a salesperson sees only their own; archived leads are left out', async () => {
    const team = (await as(OWNER).get(`${API}/sales/dashboard`).expect(200)).body;
    expect(team.people.map((p: { person: { empId: string } }) => p.person.empId)).toEqual(staff);
    const own = (await as(KAMRAN).get(`${API}/sales/dashboard`).expect(200)).body;
    expect(own.people.map((p: { person: { empId: string } }) => p.person.empId)).toEqual([KAMRAN]);
    expect(own.won.count).toBe(0);
    const active = await prisma.salesLead.count({ where: { archivedAt: null } });
    expect(team.leadsBySource.reduce((s: number, r: { count: number }) => s + r.count, 0)).toBe(active);
    await as(FINANCE).get(`${API}/sales/dashboard`).expect(403);
  });
});

// ======================================================================================== who counts as sales staff

describe('M15.6 sales staff: the Sales department with sales work, and the sales managers; never Level 4 alone', () => {
  const eligible = async () => (await t.app.get(SalesMetricsService).salespeople()).map((p) => p.empId);

  it('Level 4 HR, Finance and Engineering staff are not sales staff, even with the default "sales" role', async () => {
    const hr = await createEmployee(prisma, { name: 'Level 4 HR', roleKey: 'sales', reportsToEmpId: DIRECTOR });
    const hrDept = await prisma.department.findUniqueOrThrow({ where: { code: 'dep-hr' } });
    await prisma.employee.update({ where: { id: hr.id }, data: { departmentId: hrDept.id } });
    const eng = await createEmployee(prisma, { name: 'Level 4 Engineering', roleKey: 'sales', reportsToEmpId: CTO }); // in dep-eng
    const noSalesWork = await createEmployee(prisma, { name: 'Sales department, no sales work', roleKey: 'finance', reportsToEmpId: HIRA }); // dep-sales
    const list = await eligible();
    for (const who of [hr.empId, eng.empId, noSalesWork.empId, FINANCE, CTO, OWNER, 'ACV-0006']) expect(list, who).not.toContain(who);
    expect(list).toEqual(expect.arrayContaining(staff));
    // the same rule everywhere: no targets for them, not on the targets list or the dashboard
    expect((await daily(DIRECTOR, { empId: hr.empId, effectiveFrom: today, leadsAdded: 1 }).expect(400)).body.code).toBe('not_sales_staff');
    expect((await daily(DIRECTOR, { empId: eng.empId, effectiveFrom: today, leadsAdded: 1 }).expect(400)).body.code).toBe('not_sales_staff');
    const onList = (await as(OWNER).get(`${API}/sales/targets`).expect(200)).body.map((r: { person: { empId: string } }) => r.person.empId);
    expect(onList).not.toContain(hr.empId);
    expect((await as(OWNER).get(`${API}/sales/dashboard`).expect(200)).body.people.map((p: { person: { empId: string } }) => p.person.empId)).not.toContain(eng.empId);
  });

  it('an active salesperson of the Sales department is included; a sales manager of another department is too; inactive people never', async () => {
    const newcomer = await createEmployee(prisma, { name: 'New salesperson', roleKey: 'sales', reportsToEmpId: HIRA }); // dep-sales, sales.own
    expect(await eligible()).toContain(newcomer.empId);
    // the sales manager duty given to the CTO (Engineering): a sales manager, so included; taken back: not any more
    const duty = await prisma.duty.findUniqueOrThrow({ where: { key: 'sales_manager' } });
    const held = await prisma.employeeDuty.create({ data: { employeeId: ids[CTO], dutyId: duty.id } });
    expect(await eligible()).toContain(CTO);
    await prisma.employeeDuty.update({ where: { id: held.id }, data: { endedAt: new Date() } });
    expect(await eligible()).not.toContain(CTO);
    // someone on notice or who has left is not sales staff; the report already built for them stays exactly as it was
    const kamranReport = await prisma.salesDailyReport.findFirstOrThrow({ where: { employeeId: ids[KAMRAN] } });
    await prisma.employee.update({ where: { id: ids[KAMRAN] }, data: { status: 'on_notice' } });
    await prisma.employee.update({ where: { id: newcomer.id }, data: { status: 'left' } });
    const list = await eligible();
    expect(list).not.toContain(KAMRAN);
    expect(list).not.toContain(newcomer.empId);
    expect(await prisma.salesDailyReport.findFirstOrThrow({ where: { id: kamranReport.id } })).toEqual(kamranReport);
    await prisma.employee.update({ where: { id: ids[KAMRAN] }, data: { status: 'active' } });
  });
});
