import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboxEventSchema } from '@aceva/contracts';
import type { PrismaClient } from '../src/generated/prisma/client';
import { AttendancePayrollPort } from '../src/attendance/attendance-payroll.port';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';
import { API, m7Personas, pkAt } from './m7-support';

/**
 * M7 leave (plan section 11: "The request goes to the team lead, then to the Director"), May 2027 (3 May 2027 is a Monday).
 * A test holiday on Wednesday 5 May. Seeded development leave types: casual 10, sick 8, annual 14, unpaid (no limit).
 */
const OWNER = 'ACV-0001';
let CEO = '';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const DEV3 = 'ACV-0008';
const SALES1 = 'ACV-0009';
const FINANCE = 'ACV-0010';
const SQA1 = 'ACV-0011';

let t: TestApp;
let prisma: PrismaClient;
let as: ReturnType<typeof m7Personas>;
const type: Record<string, string> = {};
const idOf = async (empId: string) => (await prisma.employee.findUniqueOrThrow({ where: { empId }, select: { id: true } })).id;
const ask = async (who: string, key: string, from: string, to: string, status: number, extra: Record<string, unknown> = {}) =>
  (await as(who)).post(`${API}/leave/requests`).send({ leaveTypeId: type[key], from, to, reason: 'Family matters', ...extra }).expect(status);
const decide = async (who: string, id: string, action: 'approve' | 'reject' | 'cancel', status: number, body: Record<string, unknown> = {}) =>
  (await as(who)).post(`${API}/leave/requests/${id}/${action}`).send(body).expect(status);
const balance = async (who: string, of: string, key: string) =>
  ((await (await as(who)).get(`${API}/leave/balances/${of}?year=2027`).expect(200)).body.balances as Array<{ key: string }>).find((b) => b.key === key);

const req: Record<string, string> = {};

beforeAll(async () => {
  t = await createTestApp();
  t.clock.set(new Date('2027-05-03T02:00:00.000Z')); // 07:00 Pakistan time, Monday 3 May 2027
  await t.ensureFixtures();
  CEO = t.fixtures.CEO;
  prisma = createTestPrisma();
  as = m7Personas(t);
});

afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M7 leave: types, holidays and day counting', () => {
  it('lists the leave types to everyone', async () => {
    const res = await (await as(DEV1)).get(`${API}/leave/types`).expect(200);
    for (const tp of res.body) type[tp.key] = tp.id;
    expect(res.body.map((tp: { key: string }) => tp.key).sort()).toEqual(['annual', 'casual', 'sick', 'unpaid']);
    expect(res.body.find((tp: { key: string }) => tp.key === 'unpaid')).toMatchObject({ yearlyDays: null, paid: false });
    expect(res.body.find((tp: { key: string }) => tp.key === 'casual')).toMatchObject({ yearlyDays: 10, paid: true });
  });

  it('counts working days only: weekends and holidays are excluded', async () => {
    await (await as(DIRECTOR)).post(`${API}/holidays`).send({ date: '2027-05-05', name: 'Test Holiday', reason: 'Announced by management' }).expect(201);
    const res = await (await as(DEV1)).get(`${API}/leave/preview?leaveTypeId=${type.casual}&from=2027-05-04&to=2027-05-07`).expect(200);
    expect(res.body).toMatchObject({ days: 3, remaining: 10, remainingAfter: 7, firstApproverEmpId: CTO, needsDirector: true });
    expect(res.body.chain).toMatchObject([{ step: 1, approverEmpId: CTO, state: 'waiting' }, { step: 2, approverEmpId: DIRECTOR, state: 'pending' }]);
    const week = await (await as(DEV1)).get(`${API}/leave/preview?leaveTypeId=${type.casual}&from=2027-05-03&to=2027-05-16`).expect(200);
    expect(week.body.days).toBe(9); // 10 weekdays minus the holiday
  });
});

describe('M7 leave: asking', () => {
  it('a developer asks: two steps, the CTO then the Director', async () => {
    const res = await ask(DEV1, 'casual', '2027-05-04', '2027-05-07', 201);
    req.dev1 = res.body.id;
    expect(res.body).toMatchObject({ empId: DEV1, days: 3, status: 'pending_manager', canCancel: true, canDecide: false });
    expect(res.body.number).toMatch(/^LV-\d{4}-\d{4}$/);
    expect(res.body.chain).toMatchObject([
      { step: 1, approverEmpId: CTO, state: 'waiting', label: 'CTO' },
      { step: 2, approverEmpId: DIRECTOR, state: 'pending', label: 'Director' },
    ]);
  });

  it('refuses bad requests with clear codes', async () => {
    expect((await ask(DEV1, 'casual', '2027-05-07', '2027-05-10', 409)).body.code).toBe('overlapping_request');
    expect((await ask(DEV1, 'casual', '2027-05-08', '2027-05-09', 400)).body.code).toBe('no_working_days');
    expect((await ask(DEV1, 'casual', '2027-05-05', '2027-05-05', 400, { halfDay: true })).body.code).toBe('no_working_days');
    expect((await ask(DEV1, 'casual', '2027-12-31', '2028-01-03', 400)).body.code).toBe('spans_leave_years');
    expect((await ask(DEV1, 'casual', '2027-04-30', '2027-05-03', 400)).body.code).toBe('past_month');
    await ask(DEV1, 'casual', '2027-05-12', '2027-05-11', 400);
    await ask(DEV1, 'casual', '2027-05-12', '2027-05-12', 400, { reason: '' });
    await (await as(DEV1)).post(`${API}/leave/requests`).send({ leaveTypeId: '00000000-0000-4000-8000-000000000000', from: '2027-05-12', to: '2027-05-12', reason: 'Family' }).expect(400);
  });

  it('refuses more days than the balance; unpaid leave has no limit', async () => {
    const ten = await ask(DEV2, 'casual', '2027-05-10', '2027-05-21', 201);
    req.dev2Casual = ten.body.id;
    expect(ten.body.days).toBe(10);
    const over = await ask(DEV2, 'casual', '2027-05-24', '2027-05-24', 409);
    expect(over.body.code).toBe('insufficient_balance');
    await ask(DEV2, 'unpaid', '2027-05-24', '2027-05-28', 201);
    expect(await balance(DEV2, DEV2, 'casual')).toMatchObject({ total: 10, used: 0, pending: 10, remaining: 0 });
    expect(await balance(DEV2, DEV2, 'unpaid')).toMatchObject({ total: null, pending: 5, remaining: null });
  });

  it('a half day counts 0.5', async () => {
    const res = await ask(DEV1, 'sick', '2027-05-11', '2027-05-11', 201, { halfDay: true });
    expect(res.body).toMatchObject({ days: 0.5, halfDay: true });
    expect(await balance(DEV1, DEV1, 'sick')).toMatchObject({ total: 8, pending: 0.5, remaining: 7.5 });
  });
});

describe('M7 leave: deciding (only the routed approver of the current step, never yourself)', () => {
  it('step 1: the CTO approves and it moves to the Director', async () => {
    await (await as(DEV2)).post(`${API}/leave/requests/${req.dev1}/approve`).send({}).expect(403); // no permission
    for (const who of [DIRECTOR, FINANCE, OWNER]) expect((await decide(who, req.dev1, 'approve', 403)).body.code).toBe('not_routed_approver');
    const team = await (await as(CTO)).get(`${API}/leave/requests?scope=team&status=pending`).expect(200);
    expect(team.body.items.find((r: { id: string }) => r.id === req.dev1)).toMatchObject({ canDecide: true });
    const res = await decide(CTO, req.dev1, 'approve', 200, { note: 'Fine by me' });
    expect(res.body.status).toBe('pending_director');
    expect(res.body.chain).toMatchObject([
      { step: 1, approverEmpId: CTO, state: 'done', via: 'manager', note: 'Fine by me' },
      { step: 2, approverEmpId: DIRECTOR, state: 'waiting' },
    ]);
    expect((await decide(CTO, req.dev1, 'approve', 403)).body.code).toBe('not_routed_approver');
  });

  it('step 2: the Director approves; the balance updates', async () => {
    const res = await decide(DIRECTOR, req.dev1, 'approve', 200);
    expect(res.body.status).toBe('approved');
    expect(res.body.chain.map((s: { state: string }) => s.state)).toEqual(['done', 'done']);
    expect(await balance(DEV1, DEV1, 'casual')).toMatchObject({ used: 3, pending: 0, remaining: 7 });
    expect((await decide(DIRECTOR, req.dev1, 'approve', 409)).body.code).toBe('invalid_transition');
    expect(await prisma.leaveDecision.count({ where: { requestId: req.dev1 } })).toBe(2);
  });

  it('sales: one step, the Director', async () => {
    const res = await ask(SALES1, 'casual', '2027-05-12', '2027-05-12', 201);
    req.sales = res.body.id;
    expect(res.body.chain).toMatchObject([{ step: 1, approverEmpId: DIRECTOR, state: 'waiting' }]);
    expect(res.body.chain).toHaveLength(1);
    expect((await decide(DIRECTOR, req.sales, 'approve', 200)).body.status).toBe('approved');
  });

  it("the CTO's own leave goes to the Director (one step) and the CTO cannot approve it", async () => {
    const res = await ask(CTO, 'casual', '2027-05-13', '2027-05-13', 201);
    req.cto = res.body.id;
    expect(res.body.chain).toHaveLength(1);
    expect(res.body.chain[0].approverEmpId).toBe(DIRECTOR);
    expect((await decide(CTO, req.cto, 'approve', 403)).body.code).toBe('self_approval');
  });

  it("the Director's own leave goes to the CEO", async () => {
    const res = await ask(DIRECTOR, 'casual', '2027-05-14', '2027-05-14', 201);
    expect(res.body.chain).toMatchObject([{ step: 1, approverEmpId: CEO, state: 'waiting' }]);
    expect(res.body.chain).toHaveLength(1);
    expect((await decide(OWNER, res.body.id, 'approve', 403)).body.code).toBe('not_routed_approver');
    expect((await decide(DIRECTOR, res.body.id, 'approve', 403)).body.code).toBe('self_approval');
    expect((await decide(CEO, res.body.id, 'approve', 200)).body.status).toBe('approved');
  });

  it('the Owner has nobody above: the leave is recorded as approved without a decision (development default)', async () => {
    const res = await ask(OWNER, 'annual', '2027-05-18', '2027-05-18', 201);
    expect(res.body).toMatchObject({ status: 'approved', chain: [] });
    expect(await prisma.leaveDecision.count({ where: { requestId: res.body.id } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'leave.recorded_without_approver' } })).toBe(1);
  });

  it('reject needs a reason and closes the request', async () => {
    await decide(DIRECTOR, req.cto, 'reject', 400, {});
    const res = await decide(DIRECTOR, req.cto, 'reject', 200, { reason: 'Release week, please move it' });
    expect(res.body).toMatchObject({ status: 'rejected', canCancel: false });
    expect(res.body.chain[0]).toMatchObject({ state: 'rejected', note: 'Release week, please move it' });
    await decide(DIRECTOR, req.cto, 'approve', 409);
  });

  it('the requester cancels a pending request (balance restored); nobody else can', async () => {
    await decide(CTO, req.dev2Casual, 'cancel', 404);
    const res = await decide(DEV2, req.dev2Casual, 'cancel', 200, { reason: 'Plans changed' });
    expect(res.body.status).toBe('cancelled');
    expect(res.body.chain.every((s: { state: string }) => s.state === 'skipped')).toBe(true);
    await decide(DEV2, req.dev2Casual, 'cancel', 409);
    expect(await balance(DEV2, DEV2, 'casual')).toMatchObject({ pending: 0, remaining: 10 });
  });

  it('approved leave can be cancelled by the requester before it starts, not after (development default)', async () => {
    expect((await decide(SALES1, req.sales, 'cancel', 200)).body.status).toBe('cancelled');
    pkAt(t, '2027-05-04', '10:00');
    expect((await decide(DEV1, req.dev1, 'cancel', 409)).body.code).toBe('leave_started');
    // A past day of the current month may still be asked for (for example sick leave yesterday).
    await ask(DEV2, 'sick', '2027-05-03', '2027-05-03', 201);
  });
});

describe('M7 leave: stand-ins (Module 1 routing)', () => {
  it("routes step 1 to the CTO's stand-in and step 2 to the Director's stand-in", async () => {
    const standIns = await prisma.standIn.createManyAndReturn({
      data: [
        { managerId: await idOf(CTO), standInId: await idOf(FINANCE), startsOn: new Date('2027-05-04T00:00:00.000Z'), endsOn: new Date('2027-05-31T00:00:00.000Z'), reason: 'CTO away' },
        { managerId: await idOf(DIRECTOR), standInId: await idOf(CTO), startsOn: new Date('2027-05-04T00:00:00.000Z'), endsOn: new Date('2027-05-31T00:00:00.000Z'), reason: 'Director away' },
      ],
    });
    const res = await ask(DEV3, 'casual', '2027-05-17', '2027-05-17', 201);
    expect(res.body.chain).toMatchObject([
      { step: 1, approverEmpId: FINANCE, state: 'waiting', via: 'stand_in' },
      { step: 2, approverEmpId: CTO, state: 'pending', via: 'stand_in' },
    ]);
    const list = await (await as(FINANCE)).get(`${API}/leave/requests?scope=team`).expect(200);
    // The stand-in sees only what is routed to them now (nobody reports to them).
    expect(list.body.items.map((r: { id: string }) => r.id)).toContain(res.body.id);
    expect(list.body.items.every((r: { canDecide: boolean }) => r.canDecide)).toBe(true);
    expect((await decide(CTO, res.body.id, 'approve', 403)).body.code).toBe('not_routed_approver');
    const step1 = await decide(FINANCE, res.body.id, 'approve', 200);
    expect(step1.body.status).toBe('pending_director');
    expect((await decide(DIRECTOR, res.body.id, 'approve', 403)).body.code).toBe('not_routed_approver');
    const step2 = await decide(CTO, res.body.id, 'approve', 200);
    expect(step2.body.status).toBe('approved');
    const decisions = await prisma.leaveDecision.findMany({ where: { requestId: res.body.id }, orderBy: { step: 'asc' } });
    expect(decisions.map((d) => [d.step, d.decision, d.via])).toEqual([[1, 'approved', 'stand_in'], [2, 'approved', 'stand_in']]);
    await prisma.standIn.updateMany({ where: { id: { in: standIns.map((s) => s.id) } }, data: { revokedAt: new Date() } });
  });
});

describe('M7 leave: calendar, balances and lists follow the hierarchy', () => {
  it('the leave calendar shows waiting and approved leave of the caller and everyone below', async () => {
    const cto = (await (await as(CTO)).get(`${API}/leave/calendar?month=2027-05`).expect(200)).body as Array<{ empId: string; status: string }>;
    expect(new Set(cto.map((e) => e.empId))).toEqual(new Set([DEV1, DEV2, DEV3]));
    expect(cto.every((e) => ['approved', 'pending_manager', 'pending_director'].includes(e.status))).toBe(true);
    const dev = (await (await as(DEV1)).get(`${API}/leave/calendar?month=2027-05`).expect(200)).body as Array<{ empId: string }>;
    expect(new Set(dev.map((e) => e.empId))).toEqual(new Set([DEV1]));
    const director = (await (await as(DIRECTOR)).get(`${API}/leave/calendar?month=2027-05`).expect(200)).body as Array<{ empId: string }>;
    expect(director.map((e) => e.empId)).toContain(DIRECTOR);
    expect(director.map((e) => e.empId)).toContain(DEV1);
    await (await as(DEV1)).get(`${API}/leave/calendar?month=May`).expect(400);
  });

  it('balances: yourself or people below you only', async () => {
    await (await as(DEV1)).get(`${API}/leave/balances/${DEV2}`).expect(403);
    await (await as(FINANCE)).get(`${API}/leave/balances/${DEV1}`).expect(403);
    await (await as(SALES1)).get(`${API}/leave/balances/${DEV1}`).expect(403);
    await (await as(CTO)).get(`${API}/leave/balances/${DIRECTOR}`).expect(403);
    expect((await balance(CTO, DEV1, 'casual'))).toMatchObject({ used: 3 });
    expect((await (await as(DEV1)).get(`${API}/leave/requests?scope=team`).expect(200)).body.items).toEqual([]);
    await (await as(DEV2)).get(`${API}/leave/requests/${req.dev1}`).expect(404);
    await (await as(CTO)).get(`${API}/leave/requests/${req.dev1}`).expect(200);
  });
});

describe('M7 leave: locked months and database rules', () => {
  it('refuses requests and approvals that touch a locked month', async () => {
    const june = await ask(SQA1, 'casual', '2027-06-01', '2027-06-01', 201);
    const port = t.app.get(AttendancePayrollPort);
    await t.app.get(PrismaService).$transaction(async (tx) => port.lockMonth('2027-06', await idOf(DIRECTOR), tx));
    expect((await ask(SQA1, 'casual', '2027-06-02', '2027-06-02', 409)).body.code).toBe('period_locked');
    expect((await decide(CTO, june.body.id, 'approve', 409)).body.code).toBe('period_locked');
  });

  it('the database refuses changing dates, deleting requests or rewriting decisions', async () => {
    await expect(prisma.leaveRequest.update({ where: { id: req.dev1 }, data: { toDate: new Date('2027-05-20T00:00:00.000Z') } })).rejects.toThrow();
    await expect(prisma.leaveRequest.delete({ where: { id: req.dev1 } })).rejects.toThrow(/never deleted/);
    const decision = await prisma.leaveDecision.findFirstOrThrow({ where: { requestId: req.dev1 } });
    await expect(prisma.leaveDecision.update({ where: { id: decision.id }, data: { note: 'changed' } })).rejects.toThrow();
    await expect(prisma.leaveRequest.update({ where: { id: req.cto }, data: { status: 'approved' } })).rejects.toThrow(/decided leave request/);
  });
});

describe('M7 leave: audit and events', () => {
  it('audits requests and decisions', async () => {
    expect(await prisma.auditLog.count({ where: { action: 'leave.requested' } })).toBeGreaterThanOrEqual(9);
    expect(await prisma.auditLog.count({ where: { action: 'leave.forwarded' } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: 'leave.approved' } })).toBe(4);
    expect(await prisma.auditLog.count({ where: { action: 'leave.rejected' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'leave.cancelled' } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: 'settings.holiday.created' } })).toBe(1);
  });

  it('emits leave.requested and leave.decided with Emp-IDs only (no UUIDs, no amounts)', async () => {
    const events = await prisma.outboxEvent.findMany({ where: { type: { in: ['leave.requested', 'leave.decided'] } }, orderBy: { occurredAt: 'asc' } });
    const employeeIds = (await prisma.employee.findMany({ select: { id: true } })).map((e) => e.id);
    for (const e of events) {
      expect(outboxEventSchema.safeParse({ id: e.id, type: e.type, version: e.version, occurredAt: e.occurredAt.toISOString(), actor: e.actor, payload: e.payload }).success).toBe(true);
      const text = JSON.stringify(e.payload) + e.actor;
      for (const id of employeeIds) expect(text).not.toContain(id);
      expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    }
    const number = (await prisma.leaveRequest.findUniqueOrThrow({ where: { id: req.dev1 } })).number;
    const mine = events.filter((e) => (e.payload as { requestNumber: string }).requestNumber === number).map((e) => ({ type: e.type, ...(e.payload as object) }));
    expect(mine).toMatchObject([
      { type: 'leave.requested', empId: DEV1, approverEmpId: CTO, from: '2027-05-04', to: '2027-05-07' },
      { type: 'leave.decided', decision: 'forwarded', byEmpId: CTO, nextApproverEmpId: DIRECTOR },
      { type: 'leave.decided', decision: 'approved', byEmpId: DIRECTOR, nextApproverEmpId: null },
    ]);
  });
});
