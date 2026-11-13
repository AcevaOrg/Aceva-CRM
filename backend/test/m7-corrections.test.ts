import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboxEventSchema } from '@aceva/contracts';
import type { PrismaClient } from '../src/generated/prisma/client';
import { AttendancePayrollPort } from '../src/attendance/attendance-payroll.port';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';
import { API, m7Personas, pkAt } from './m7-support';

/** M7 attendance corrections (plan section 11), April 2027 (5 April 2027 is a Monday). */
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
const ids = new Map<string, string>();
const idOf = async (empId: string) => {
  if (!ids.has(empId)) ids.set(empId, (await prisma.employee.findUniqueOrThrow({ where: { empId }, select: { id: true } })).id);
  return ids.get(empId)!;
};
const recordOf = async (empId: string, day: string) =>
  prisma.attendanceRecord.findUnique({ where: { employeeId_workDate: { employeeId: await idOf(empId), workDate: new Date(`${day}T00:00:00.000Z`) } } });
const correction = async (who: string, body: Record<string, unknown>, status: number) => (await as(who)).post(`${API}/attendance/corrections`).send(body).expect(status);

let dev1Correction = '';
let dev2Correction = '';
let ctoCorrection = '';
let sqaCorrection = '';

beforeAll(async () => {
  t = await createTestApp();
  t.clock.set(new Date('2027-04-05T02:00:00.000Z')); // 07:00 Pakistan time, Monday 5 April 2027
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

describe('M7 corrections: asking', () => {
  it('sets up a late day for DEV1 (09:40, 25 minutes late)', async () => {
    pkAt(t, '2027-04-05', '09:40');
    const res = await (await as(DEV1)).post(`${API}/attendance/check-in`).send({}).expect(200);
    expect(res.body.lateMinutes).toBe(25);
    pkAt(t, '2027-04-05', '18:10');
    await (await as(DEV1)).post(`${API}/attendance/check-out`).send({}).expect(200);
  });

  it('asks for a past day with a reason; validation and one pending per day', async () => {
    pkAt(t, '2027-04-06', '09:00');
    await correction(DEV1, { date: '2027-04-05', checkIn: '09:05', reason: 'no' }, 400);
    await correction(DEV1, { date: '2027-04-05', reason: 'The gate reader was down' }, 400);
    const future = await correction(DEV1, { date: '2027-04-07', checkIn: '09:00', reason: 'The gate reader was down' }, 400);
    expect(future.body.code).toBe('future_date');
    const later = await correction(DEV1, { date: '2027-04-06', checkIn: '10:30', reason: 'The gate reader was down' }, 400);
    expect(later.body.code).toBe('future_time');
    const bad = await correction(DEV1, { date: '2027-04-05', checkIn: '18:30', reason: 'The gate reader was down' }, 400);
    expect(bad.body.code).toBe('invalid_times'); // after the original check-out
    const res = await correction(DEV1, { date: '2027-04-05', checkIn: '09:05', reason: 'The gate reader was down' }, 201);
    dev1Correction = res.body.id;
    expect(res.body).toMatchObject({ empId: DEV1, date: '2027-04-05', status: 'pending', approverEmpId: CTO, canDecide: false });
    expect(res.body.original.checkIn.startsWith('2027-04-05T04:40')).toBe(true); // 09:40 Pakistan time
    expect(res.body.requested.checkIn).toBe('2027-04-05T04:05:00.000Z');
    const dup = await correction(DEV1, { date: '2027-04-05', checkOut: '18:30', reason: 'The gate reader was down' }, 409);
    expect(dup.body.code).toBe('correction_pending');
    // The database allows one pending correction per person and day.
    await expect(prisma.attendanceCorrection.create({ data: { employeeId: await idOf(DEV1), workDate: new Date('2027-04-05T00:00:00.000Z'), requestedCheckInAt: new Date('2027-04-05T04:00:00.000Z'), reason: 'direct insert' } })).rejects.toThrow();
  });

  it('a day without any record can be corrected too (forgot to check in and out)', async () => {
    const res = await correction(DEV2, { date: '2027-04-02', checkIn: '09:00', checkOut: '18:00', reason: 'Forgot my phone at home' }, 201);
    dev2Correction = res.body.id;
    expect(res.body.original).toEqual({ checkIn: null, checkOut: null });
    const cto = await correction(CTO, { date: '2027-04-02', checkIn: '09:10', reason: 'Client visit in the morning' }, 201);
    ctoCorrection = cto.body.id;
    expect(cto.body.approverEmpId).toBe(DIRECTOR);
  });
});

describe('M7 corrections: deciding (the routed approver only, never yourself)', () => {
  it('refuses people without the permission, the requester and anyone who is not the routed approver', async () => {
    await (await as(DEV2)).post(`${API}/attendance/corrections/${dev1Correction}/approve`).send({}).expect(403); // no permission
    await (await as(SALES1)).post(`${API}/attendance/corrections/${dev1Correction}/approve`).send({}).expect(403); // no permission
    const self = await (await as(CTO)).post(`${API}/attendance/corrections/${ctoCorrection}/approve`).send({}).expect(403);
    expect(self.body.code).toBe('self_approval');
    for (const who of [DIRECTOR, FINANCE, OWNER]) {
      const res = await (await as(who)).post(`${API}/attendance/corrections/${dev1Correction}/approve`).send({}).expect(403);
      expect(res.body.code).toBe('not_routed_approver');
    }
  });

  it('the manager sees it in the team list and approves: corrected time applied, lateness recomputed, original kept', async () => {
    const list = await (await as(CTO)).get(`${API}/attendance/corrections?scope=team&status=pending`).expect(200);
    const item = list.body.items.find((c: { id: string }) => c.id === dev1Correction);
    expect(item).toMatchObject({ canDecide: true, approverEmpId: CTO });
    expect(list.body.items.some((c: { empId: string }) => c.empId === CTO)).toBe(false);
    await (await as(DEV1)).get(`${API}/attendance/corrections?scope=team`).expect(403);
    const mine = await (await as(DEV1)).get(`${API}/attendance/corrections`).expect(200);
    expect(mine.body.items.map((c: { id: string }) => c.id)).toEqual([dev1Correction]);

    const res = await (await as(CTO)).post(`${API}/attendance/corrections/${dev1Correction}/approve`).send({ note: 'Gate log confirms' }).expect(200);
    expect(res.body).toMatchObject({ status: 'approved', decidedBy: CTO, decisionNote: 'Gate log confirms' });
    const record = await recordOf(DEV1, '2027-04-05');
    expect(record!.checkInAt!.toISOString()).toBe(res.body.original.checkIn); // the original is unchanged
    expect(record!.correctedCheckInAt!.toISOString()).toBe('2027-04-05T04:05:00.000Z');
    expect(record!.lateMinutes).toBe(0);

    const month = await (await as(DEV1)).get(`${API}/attendance/me?month=2027-04`).expect(200);
    const day = month.body.days.find((d: { date: string }) => d.date === '2027-04-05');
    expect(day).toMatchObject({ status: 'on_time', checkIn: '2027-04-05T04:05:00.000Z', lateMinutes: 0, correctionId: dev1Correction, correctionStatus: 'approved' });
    expect(day.original.checkIn).toBe(record!.checkInAt!.toISOString());

    const again = await (await as(CTO)).post(`${API}/attendance/corrections/${dev1Correction}/approve`).send({}).expect(409);
    expect(again.body.code).toBe('invalid_transition');
  });

  it('the database keeps the original and refuses to change a decided correction', async () => {
    const record = await recordOf(DEV1, '2027-04-05');
    await expect(prisma.attendanceRecord.update({ where: { id: record!.id }, data: { checkInAt: new Date('2027-04-05T04:05:00.000Z') } })).rejects.toThrow(/original/);
    await expect(prisma.attendanceCorrection.update({ where: { id: dev1Correction }, data: { status: 'rejected' } })).rejects.toThrow(/decided correction/);
    await expect(prisma.attendanceCorrection.delete({ where: { id: dev1Correction } })).rejects.toThrow(/never deleted/);
  });

  it('a correction for a day without a record creates one with no original times', async () => {
    await (await as(CTO)).post(`${API}/attendance/corrections/${dev2Correction}/approve`).send({}).expect(200);
    const record = await recordOf(DEV2, '2027-04-02');
    expect(record).toMatchObject({ checkInAt: null, checkOutAt: null, lateMinutes: 0 });
    expect(record!.correctedCheckInAt!.toISOString()).toBe('2027-04-02T04:00:00.000Z');
    expect(record!.correctedCheckOutAt!.toISOString()).toBe('2027-04-02T13:00:00.000Z');
  });

  it('reject needs a reason; the requester may cancel their own pending one, nobody else can', async () => {
    await (await as(DIRECTOR)).post(`${API}/attendance/corrections/${ctoCorrection}/reject`).send({}).expect(400);
    const res = await (await as(DIRECTOR)).post(`${API}/attendance/corrections/${ctoCorrection}/reject`).send({ reason: 'No client visit on the calendar' }).expect(200);
    expect(res.body).toMatchObject({ status: 'rejected', decisionNote: 'No client visit on the calendar' });
    expect((await recordOf(CTO, '2027-04-02'))).toBeNull();

    const again = await correction(CTO, { date: '2027-04-02', checkIn: '09:10', reason: 'Client visit, calendar updated' }, 201);
    await (await as(DIRECTOR)).post(`${API}/attendance/corrections/${again.body.id}/cancel`).send({}).expect(404);
    const cancelled = await (await as(CTO)).post(`${API}/attendance/corrections/${again.body.id}/cancel`).send({}).expect(200);
    expect(cancelled.body.status).toBe('cancelled');
    await (await as(CTO)).post(`${API}/attendance/corrections/${again.body.id}/cancel`).send({}).expect(409);
  });

  it("the Director's own correction goes to the CEO", async () => {
    const res = await correction(DIRECTOR, { date: '2027-04-05', checkIn: '09:00', checkOut: '17:00', reason: 'Board meeting off-site' }, 201);
    expect(res.body.approverEmpId).toBe(CEO);
    await (await as(OWNER)).post(`${API}/attendance/corrections/${res.body.id}/approve`).send({}).expect(403);
    await (await as(CEO)).post(`${API}/attendance/corrections/${res.body.id}/approve`).send({}).expect(200);
  });

  it('a stand-in decides while the manager is away; the away manager cannot', async () => {
    const standIn = await prisma.standIn.create({ data: { managerId: await idOf(CTO), standInId: await idOf(FINANCE), startsOn: new Date('2027-04-06T00:00:00.000Z'), endsOn: new Date('2027-04-09T00:00:00.000Z'), reason: 'CTO on leave' } });
    const res = await correction(DEV3, { date: '2027-04-05', checkIn: '09:00', reason: 'Worked from a cafe, VPN down' }, 201);
    expect(res.body.approverEmpId).toBe(FINANCE);
    const awayManager = await (await as(CTO)).post(`${API}/attendance/corrections/${res.body.id}/approve`).send({}).expect(403);
    expect(awayManager.body.code).toBe('not_routed_approver');
    const list = await (await as(FINANCE)).get(`${API}/attendance/corrections?scope=team`).expect(200);
    expect(list.body.items.map((c: { id: string }) => c.id)).toEqual([res.body.id]); // only what is routed to them
    const decided = await (await as(FINANCE)).post(`${API}/attendance/corrections/${res.body.id}/approve`).send({}).expect(200);
    expect(decided.body).toMatchObject({ status: 'approved', decidedBy: FINANCE });
    await prisma.standIn.update({ where: { id: standIn.id }, data: { revokedAt: new Date() } }); // the CTO is back
  });
});

describe('M7 attendance views: hierarchy scope', () => {
  it('a developer sees only themselves; the CTO sees developers; the finance officer sees nobody below', async () => {
    await (await as(DEV1)).get(`${API}/attendance/employees/${DEV2}?month=2027-04`).expect(403);
    await (await as(DEV1)).get(`${API}/attendance/employees/${DEV1}?month=2027-04`).expect(200);
    await (await as(DEV1)).get(`${API}/attendance/team`).expect(403);
    await (await as(FINANCE)).get(`${API}/attendance/employees/${DEV1}?month=2027-04`).expect(403);
    await (await as(SALES1)).get(`${API}/attendance/employees/${DEV1}?month=2027-04`).expect(403);
    await (await as(CTO)).get(`${API}/attendance/employees/${DIRECTOR}?month=2027-04`).expect(403); // upward
    const cto = await (await as(CTO)).get(`${API}/attendance/employees/${DEV1}?month=2027-04`).expect(200);
    expect(cto.body.empId).toBe(DEV1);
    await (await as(CTO)).get(`${API}/attendance/employees/${DEV1}?month=2027-4`).expect(400);

    const team = await (await as(CTO)).get(`${API}/attendance/team?date=2027-04-05`).expect(200);
    const rows = team.body.rows as Array<{ empId: string; state: string }>;
    expect(rows.map((r) => r.empId).sort()).toEqual(['ACV-0006', 'ACV-0007', 'ACV-0008', 'ACV-0011', 'ACV-0013']);
    expect(rows.find((r) => r.empId === DEV1)!.state).toBe('checked_out');
    expect(rows.find((r) => r.empId === DEV2)!.state).toBe('not_in');
    expect((await (await as(FINANCE)).get(`${API}/attendance/team`).expect(200)).body.rows).toEqual([]);
    const director = await (await as(DIRECTOR)).get(`${API}/attendance/team/summary?month=2027-04`).expect(200);
    expect(director.body.rows.map((r: { empId: string }) => r.empId)).toContain(SALES1);
    expect(director.body.rows.map((r: { empId: string }) => r.empId)).not.toContain(DIRECTOR);
  });
});

describe('M7 corrections in a locked month', () => {
  it('refuses asking, approving and cancelling once payroll locked the month', async () => {
    const pending = await correction(SQA1, { date: '2027-04-05', checkIn: '09:00', reason: 'Badge was not working' }, 201);
    sqaCorrection = pending.body.id;
    const port = t.app.get(AttendancePayrollPort);
    await t.app.get(PrismaService).$transaction(async (tx) => port.lockMonth('2027-04', await idOf(DIRECTOR), tx));
    const ask = await correction(DEV2, { date: '2027-04-05', checkIn: '09:00', reason: 'Forgot to check in' }, 409);
    expect(ask.body.code).toBe('period_locked');
    const approve = await (await as(CTO)).post(`${API}/attendance/corrections/${sqaCorrection}/approve`).send({}).expect(409);
    expect(approve.body.code).toBe('period_locked');
    const cancel = await (await as(SQA1)).post(`${API}/attendance/corrections/${sqaCorrection}/cancel`).send({}).expect(409);
    expect(cancel.body.code).toBe('period_locked');
    await expect(prisma.attendanceCorrection.update({ where: { id: sqaCorrection }, data: { status: 'cancelled' } })).rejects.toThrow(/period_locked/);
  });
});

describe('M7 corrections: audit and events', () => {
  it('audits every request and decision', async () => {
    expect(await prisma.auditLog.count({ where: { action: 'attendance.correction_requested' } })).toBe(7);
    expect(await prisma.auditLog.count({ where: { action: 'attendance.correction_approved' } })).toBe(4);
    expect(await prisma.auditLog.count({ where: { action: 'attendance.correction_rejected' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'attendance.correction_cancelled' } })).toBe(1);
  });

  it('emits attendance.correction.decided with Emp-IDs, never employee UUIDs', async () => {
    const events = await prisma.outboxEvent.findMany({ where: { type: 'attendance.correction.decided' } });
    expect(events).toHaveLength(5);
    const employeeIds = (await prisma.employee.findMany({ select: { id: true } })).map((e) => e.id);
    for (const e of events) {
      expect(outboxEventSchema.safeParse({ id: e.id, type: e.type, version: e.version, occurredAt: e.occurredAt.toISOString(), actor: e.actor, payload: e.payload }).success).toBe(true);
      const text = JSON.stringify(e.payload) + e.actor;
      for (const id of employeeIds) expect(text).not.toContain(id);
    }
    expect(events.find((e) => (e.payload as { correctionId: string }).correctionId === dev1Correction)!.payload).toMatchObject({ empId: DEV1, decision: 'approved', byEmpId: CTO, date: '2027-04-05' });
  });
});
