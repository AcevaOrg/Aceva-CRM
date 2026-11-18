import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { AttendancePayrollPort } from '../src/attendance/attendance-payroll.port';
import { AttendanceService } from '../src/attendance/attendance.service';
import { JobRunner } from '../src/jobs/job-runner.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';
import { API, m7Personas, pkAt } from './m7-support';

/**
 * M7 check-in and check-out (plan section 11), March 2027 (1 March 2027 is a Monday). Seeded development schedule:
 * 09:00-18:00 Monday to Friday, 15 minutes grace.
 */
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const DEV1 = 'ACV-0006'; // Karachi office
const DEV2 = 'ACV-0007'; // Karachi office
const DEV3 = 'ACV-0008'; // Remote office
const SQA1 = 'ACV-0011'; // Karachi office
const FINANCE = 'ACV-0010';

let t: TestApp;
let prisma: PrismaClient;
let as: ReturnType<typeof m7Personas>;

const idOf = async (empId: string) => (await prisma.employee.findUniqueOrThrow({ where: { empId }, select: { id: true } })).id;
const recordOf = async (empId: string, day: string) =>
  prisma.attendanceRecord.findUnique({ where: { employeeId_workDate: { employeeId: await idOf(empId), workDate: new Date(`${day}T00:00:00.000Z`) } } });

beforeAll(async () => {
  t = await createTestApp();
  t.clock.set(new Date('2027-03-01T02:00:00.000Z')); // 07:00 in Pakistan, Monday 1 March 2027
  await t.ensureFixtures();
  prisma = createTestPrisma();
  as = m7Personas(t);
});

afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M7 check-in: the time comes from the server', () => {
  it('shows the day before check-in: schedule, grace end, can check in', async () => {
    const res = await (await as(DEV1)).get(`${API}/attendance/today`).expect(200);
    expect(res.body).toMatchObject({ empId: DEV1, date: '2027-03-01', workingDay: true, checkIn: null, status: 'future', canCheckIn: true, canCheckOut: false, checkInAllowedHere: true });
    expect(res.body.schedule).toMatchObject({ start: '09:00', end: '18:00', graceMinutes: 15, graceEnd: '09:15', workingWeekdays: [1, 2, 3, 4, 5] });
  });

  it('a check-in exactly at start + grace (09:15) is on time and ignores any time sent by the browser', async () => {
    const at = pkAt(t, '2027-03-01', '09:15');
    const dev1 = await as(DEV1);
    const res = await dev1.post(`${API}/attendance/check-in`).send({ time: '2027-03-01T03:00:00.000Z', checkInAt: '2020-01-01T00:00:00.000Z', lateMinutes: 0 }).expect(200);
    expect(res.body).toMatchObject({ status: 'on_time', lateMinutes: 0, canCheckIn: false, canCheckOut: true });
    const record = await recordOf(DEV1, '2027-03-01');
    // Server time (within the few milliseconds the request took), never the time in the body.
    expect(Math.abs(record!.checkInAt!.getTime() - at.getTime())).toBeLessThan(5000);
    expect(record!.lateMinutes).toBe(0);
  });

  it('09:16 is one minute late', async () => {
    pkAt(t, '2027-03-01', '09:16');
    const dev2 = await as(DEV2);
    const res = await dev2.post(`${API}/attendance/check-in`).send({}).expect(200);
    expect(res.body).toMatchObject({ status: 'late', lateMinutes: 1 });
    expect((await recordOf(DEV2, '2027-03-01'))!.lateMinutes).toBe(1);
  });

  it('a second check-in the same day is refused (409 already_checked_in); the database allows one record per day', async () => {
    const res = await (await as(DEV1)).post(`${API}/attendance/check-in`).send({}).expect(409);
    expect(res.body.code).toBe('already_checked_in');
    await expect(prisma.attendanceRecord.create({ data: { employeeId: await idOf(DEV1), workDate: new Date('2027-03-01T00:00:00.000Z'), checkInAt: new Date() } })).rejects.toThrow();
  });

  it('check-out needs a check-in that day and happens once', async () => {
    pkAt(t, '2027-03-01', '17:30');
    const none = await (await as(DEV3)).post(`${API}/attendance/check-out`).send({}).expect(409);
    expect(none.body.code).toBe('not_checked_in');
    const ok = await (await as(DEV1)).post(`${API}/attendance/check-out`).send({ time: '2027-03-01T23:00:00.000Z' }).expect(200);
    expect(ok.body).toMatchObject({ canCheckOut: false, canCheckIn: false });
    const again = await (await as(DEV1)).post(`${API}/attendance/check-out`).send({}).expect(409);
    expect(again.body.code).toBe('already_checked_out');
    const record = await recordOf(DEV1, '2027-03-01');
    expect(Math.abs(record!.checkOutAt!.getTime() - t.clock.now().getTime())).toBeLessThan(10_000);
  });

  it('the original times can never be changed or deleted directly in the database', async () => {
    const record = await recordOf(DEV1, '2027-03-01');
    await expect(prisma.attendanceRecord.update({ where: { id: record!.id }, data: { checkInAt: new Date('2027-03-01T03:00:00.000Z') } })).rejects.toThrow(/original check-in/);
    await expect(prisma.attendanceRecord.update({ where: { id: record!.id }, data: { checkOutAt: null } })).rejects.toThrow(/original check-in/);
    await expect(prisma.attendanceRecord.delete({ where: { id: record!.id } })).rejects.toThrow(/never deleted/);
  });

  it('writes audit rows for check-in and check-out', async () => {
    expect(await prisma.auditLog.count({ where: { action: 'attendance.checked_in' } })).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: 'attendance.checked_out' } })).toBe(1);
  });
});

describe('M7 missed check-out: the system closes the day at the end of working hours', () => {
  it('a check-in after the end of hours is closed at 23:59', async () => {
    pkAt(t, '2027-03-01', '18:30');
    await (await as(DEV3)).post(`${API}/attendance/check-in`).send({}).expect(200);
    const record = await recordOf(DEV3, '2027-03-01');
    const job = await prisma.scheduledJob.findUniqueOrThrow({ where: { dedupeKey: `attendance.close:${record!.id}` } });
    expect(job.runAt.toISOString()).toBe('2027-03-01T18:59:00.000Z'); // 23:59 Pakistan time
  });

  it('closes a day without check-out at 18:00 and marks it missed; running again changes nothing', async () => {
    const dev2Record = await recordOf(DEV2, '2027-03-01');
    const job = await prisma.scheduledJob.findUniqueOrThrow({ where: { dedupeKey: `attendance.close:${dev2Record!.id}` } });
    expect(job.runAt.toISOString()).toBe('2027-03-01T13:00:00.000Z'); // 18:00 Pakistan time
    // Already past 18:00: the job runner picks the due jobs.
    await t.app.get(JobRunner).tick();
    const closed = await recordOf(DEV2, '2027-03-01');
    expect(closed).toMatchObject({ missedCheckout: true });
    expect(closed!.checkOutAt!.toISOString()).toBe('2027-03-01T13:00:00.000Z');
    expect(closed!.autoClosedAt).not.toBeNull();
    // DEV1 checked out himself: his job was a no-op.
    const dev1 = await recordOf(DEV1, '2027-03-01');
    expect(dev1!.missedCheckout).toBe(false);

    await t.app.get(AttendanceService).closeDay(dev2Record!.id, '2027-03-01T13:00:00.000Z');
    await t.app.get(JobRunner).tick();
    const again = await recordOf(DEV2, '2027-03-01');
    expect(again!.checkOutAt!.toISOString()).toBe('2027-03-01T13:00:00.000Z');
    expect(again!.autoClosedAt!.toISOString()).toBe(closed!.autoClosedAt!.toISOString());
    expect(await prisma.auditLog.count({ where: { action: 'attendance.auto_closed' } })).toBe(1);

    // The person can no longer check out that day.
    const res = await (await as(DEV2)).post(`${API}/attendance/check-out`).send({}).expect(409);
    expect(res.body.code).toBe('already_checked_out');
  });

  it('the late check-in is closed at 23:59 when the job runs after midnight', async () => {
    pkAt(t, '2027-03-02', '00:05');
    await t.app.get(JobRunner).tick();
    const record = await recordOf(DEV3, '2027-03-01');
    expect(record).toMatchObject({ missedCheckout: true });
    expect(record!.checkOutAt!.toISOString()).toBe('2027-03-01T18:59:00.000Z');
  });

  it('the month view shows on time, late and missed check-out; a check-in before the start is on time', async () => {
    pkAt(t, '2027-03-02', '08:40');
    await (await as(SQA1)).post(`${API}/attendance/check-in`).send({}).expect(200); // before the start: on time
    const res = await (await as(DEV2)).get(`${API}/attendance/me?month=2027-03`).expect(200);
    const day1 = res.body.days.find((d: { date: string }) => d.date === '2027-03-01');
    expect(day1).toMatchObject({ status: 'missed_checkout', lateMinutes: 1, missedCheckout: true });
    expect(day1.firstLogin).not.toBeNull(); // the session started that day
    const sqa = await (await as(SQA1)).get(`${API}/attendance/today`).expect(200);
    expect(sqa.body).toMatchObject({ status: 'on_time', lateMinutes: 0 });
    expect(res.body.days).toHaveLength(31);
    expect(res.body.days.find((d: { date: string }) => d.date === '2027-03-06').status).toBe('weekend');
    expect(res.body.days.find((d: { date: string }) => d.date === '2027-03-03').status).toBe('future');
  });
});

describe('M7 check-in on a day that is not a working day', () => {
  it('is allowed and never late', async () => {
    pkAt(t, '2027-03-06', '13:00'); // Saturday
    const res = await (await as(DEV1)).post(`${API}/attendance/check-in`).send({}).expect(200);
    expect(res.body).toMatchObject({ workingDay: false, lateMinutes: 0, status: 'on_time' });
  });
});

describe('M7 office-only check-in (management decides; off by default)', () => {
  it('only the Director (settings.manage) changes the schedule or office networks', async () => {
    const body = { effectiveFrom: '2027-03-08', start: '09:00', end: '18:00', graceMinutes: 15, workingWeekdays: [1, 2, 3, 4, 5], officeOnlyCheckIn: true, reason: 'Office staff check in from the office' };
    for (const who of [CTO, DEV1, FINANCE]) await (await as(who)).post(`${API}/settings/work-schedule`).send(body).expect(403);
    for (const who of [CTO, DEV1]) await (await as(who)).post(`${API}/settings/office-networks`).send({ officeCode: 'off-khi', cidr: '203.0.113.0/24', reason: 'Karachi office line' }).expect(403);
    const director = await as(DIRECTOR);
    await director.post(`${API}/settings/work-schedule`).send({ ...body, effectiveFrom: '2027-03-05' }).expect(400); // the past keeps its schedule
    await director.post(`${API}/settings/work-schedule`).send({ ...body, reason: 'no' }).expect(400);
    const res = await director.post(`${API}/settings/work-schedule`).send(body).expect(201);
    expect(res.body.upcoming).toHaveLength(1);
    expect(res.body.current).toMatchObject({ effectiveFrom: '2026-01-01', officeOnlyCheckIn: false });
    const dup = await director.post(`${API}/settings/work-schedule`).send(body).expect(409);
    expect(dup.body.code).toBe('schedule_exists');
    await director.post(`${API}/settings/office-networks`).send({ officeCode: 'off-khi', cidr: '203.0.113.0/24', reason: 'Karachi office line' }).expect(201);
    await director.post(`${API}/settings/office-networks`).send({ officeCode: 'off-nowhere', cidr: '203.0.113.0/24', reason: 'Karachi office line' }).expect(400);
    expect(await prisma.auditLog.count({ where: { action: 'settings.work_schedule.created' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'settings.office_network.created' } })).toBe(1);
    // Everyone can read the schedule.
    await (await as(DEV1)).get(`${API}/settings/work-schedule`).expect(200);
  });

  it('office staff must use the office network; the Remote office (no networks) is not restricted', async () => {
    pkAt(t, '2027-03-08', '08:55'); // Monday: the new schedule is in force
    const dev1 = await as(DEV1);
    const today = await dev1.get(`${API}/attendance/today`).set('X-Forwarded-For', '198.51.100.9').expect(200);
    expect(today.body).toMatchObject({ checkInAllowedHere: false, canCheckIn: false });
    const refused = await dev1.post(`${API}/attendance/check-in`).set('X-Forwarded-For', '198.51.100.9').send({}).expect(403);
    expect(refused.body.code).toBe('outside_office_network');
    expect(await recordOf(DEV1, '2027-03-08')).toBeNull();
    await dev1.post(`${API}/attendance/check-in`).set('X-Forwarded-For', '203.0.113.50').send({}).expect(200);
    expect((await recordOf(DEV1, '2027-03-08'))!.checkInIp).toBe('203.0.113.50');
    await (await as(DEV3)).post(`${API}/attendance/check-in`).set('X-Forwarded-For', '198.51.100.9').send({}).expect(200);
  });
});

describe('M7 locked month (the payroll lock, through the port)', () => {
  it('locks idempotently inside a transaction, with one audit row', async () => {
    const port = t.app.get(AttendancePayrollPort);
    const directorId = await idOf(DIRECTOR);
    expect(await port.isMonthLocked('2027-03')).toBe(false);
    const db = t.app.get(PrismaService);
    await db.$transaction(async (tx) => port.lockMonth('2027-03', directorId, tx));
    await db.$transaction(async (tx) => port.lockMonth('2027-03', directorId, tx));
    expect(await port.isMonthLocked('2027-03')).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: 'attendance.month_locked', targetId: '2027-03' } })).toBe(1);
  });

  it('refuses check-in and check-out in a locked month (409 period_locked), and the database refuses too', async () => {
    const res = await (await as(DEV2)).post(`${API}/attendance/check-in`).set('X-Forwarded-For', '203.0.113.51').send({}).expect(409);
    expect(res.body.code).toBe('period_locked');
    const out = await (await as(DEV1)).post(`${API}/attendance/check-out`).send({}).expect(409);
    expect(out.body.code).toBe('period_locked');
    await expect(prisma.attendanceRecord.create({ data: { employeeId: await idOf(DEV2), workDate: new Date('2027-03-08T00:00:00.000Z'), checkInAt: new Date() } })).rejects.toThrow(/period_locked/);
  });

  it('the missed check-out job does nothing in a locked month', async () => {
    pkAt(t, '2027-03-08', '18:05');
    await t.app.get(JobRunner).tick();
    const record = await recordOf(DEV1, '2027-03-08');
    expect(record!.checkOutAt).toBeNull();
    expect(record!.missedCheckout).toBe(false);
  });
});
