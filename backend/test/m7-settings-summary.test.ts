import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { AttendancePayrollPort } from '../src/attendance/attendance-payroll.port';
import { dec } from '../src/common/money';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type TestApp } from './helpers/app';
import { createEmployee } from './helpers/people';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';
import { API, m7Personas } from './m7-support';

/**
 * M7 settings and the month numbers Module 8 relies on (AttendancePayrollPort.monthSummary).
 * The clock is on Wednesday 10 March 2027; February 2027 is crafted directly in the database:
 * 20 weekdays (1 February 2027 is a Monday) minus a holiday on Friday 5 February = 19 working days.
 */
let CEO = '';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';

let t: TestApp;
let prisma: PrismaClient;
let as: ReturnType<typeof m7Personas>;
let joiner = { id: '', empId: '' };
const idOf = async (empId: string) => (await prisma.employee.findUniqueOrThrow({ where: { empId }, select: { id: true } })).id;
const day = (d: string) => new Date(`${d}T00:00:00.000Z`);
/** A Pakistan clock time on a day as a UTC instant. */
const pk = (d: string, hhmm: string) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.parse(`${d}T00:00:00.000Z`) - 5 * 3600_000 + (h * 60 + m) * 60_000);
};

beforeAll(async () => {
  t = await createTestApp();
  t.clock.set(new Date('2027-03-10T05:00:00.000Z')); // 10:00 Pakistan time
  await t.ensureFixtures();
  CEO = t.fixtures.CEO;
  prisma = createTestPrisma();
  as = m7Personas(t);

  const dev1 = await idOf(DEV1);
  const dev2 = await idOf(DEV2);
  const types = Object.fromEntries((await prisma.leaveType.findMany()).map((tp) => [tp.key, tp.id]));
  await prisma.attendanceRecord.createMany({
    data: [
      { employeeId: dev1, workDate: day('2027-02-01'), checkInAt: pk('2027-02-01', '09:00'), checkOutAt: pk('2027-02-01', '18:00') },
      { employeeId: dev1, workDate: day('2027-02-02'), checkInAt: pk('2027-02-02', '09:35'), checkOutAt: pk('2027-02-02', '18:00'), lateMinutes: 20 },
      { employeeId: dev1, workDate: day('2027-02-03'), checkInAt: pk('2027-02-03', '09:00'), checkOutAt: pk('2027-02-03', '18:00'), missedCheckout: true, autoClosedAt: pk('2027-02-03', '18:00') },
      { employeeId: dev1, workDate: day('2027-02-04'), correctedCheckInAt: pk('2027-02-04', '09:10') }, // made by an approved correction
      { employeeId: dev1, workDate: day('2027-02-06'), checkInAt: pk('2027-02-06', '10:00') }, // Saturday: not a working day
      { employeeId: dev2, workDate: day('2027-02-22'), checkInAt: pk('2027-02-22', '09:00') }, // after DEV2's last working day: ignored
    ],
  });
  const leave = (employeeId: string, key: string, from: string, to: string, days: string, extra: Record<string, unknown> = {}) => ({
    employeeId, leaveTypeId: types[key], fromDate: day(from), toDate: day(to), days: dec(days), reason: 'Crafted for the test', status: 'approved' as const, ...extra,
  });
  await prisma.leaveRequest.createMany({
    data: [
      leave(dev1, 'casual', '2027-02-08', '2027-02-09', '2'),
      leave(dev1, 'unpaid', '2027-02-10', '2027-02-10', '0.5', { halfDay: true }),
      leave(dev1, 'unpaid', '2027-02-11', '2027-02-12', '2'),
      leave(dev1, 'casual', '2027-02-05', '2027-02-05', '1'), // asked before the 5th became a holiday: not counted
      leave(dev1, 'casual', '2027-02-15', '2027-02-15', '1', { status: 'rejected' }),
    ],
  });
  await prisma.session.create({
    data: { employeeId: dev1, tokenHash: `m7-test-${Date.now()}`, createdAt: pk('2027-02-01', '09:05'), lastActiveAt: pk('2027-02-01', '09:05'), absoluteExpiresAt: pk('2027-02-01', '21:05'), revokedAt: pk('2027-02-01', '18:00') },
  });
  // DEV2 left on 9 February; a new person joined on 15 February.
  await prisma.employee.update({ where: { id: dev2 }, data: { lastWorkingDay: day('2027-02-09'), status: 'on_notice' } });
  joiner = await createEmployee(prisma, { name: 'February Joiner', reportsToEmpId: CTO });
  await prisma.employee.update({ where: { id: joiner.id }, data: { joiningDate: day('2027-02-15') } });
});

afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M7 holidays (settings.manage; archived, never deleted)', () => {
  it('the Director adds a holiday, also in the past while the month is open; others cannot', async () => {
    await (await as(CTO)).post(`${API}/holidays`).send({ date: '2027-02-05', name: 'Test Holiday', reason: 'Announced late' }).expect(403);
    await (await as(DEV1)).post(`${API}/holidays`).send({ date: '2027-02-05', name: 'Test Holiday', reason: 'Announced late' }).expect(403);
    await (await as(DIRECTOR)).post(`${API}/holidays`).send({ date: '2027-02-05', name: 'Test Holiday', reason: 'no' }).expect(400);
    await (await as(DIRECTOR)).post(`${API}/holidays`).send({ date: '2027-02-05', name: 'Test Holiday', reason: 'Announced late' }).expect(201);
    expect((await (await as(DIRECTOR)).post(`${API}/holidays`).send({ date: '2027-02-05', name: 'Again', reason: 'Announced late' }).expect(409)).body.code).toBe('holiday_exists');
  });

  it('renames and archives; the year list hides archived ones unless asked', async () => {
    const director = await as(DIRECTOR);
    const created = await director.post(`${API}/holidays`).send({ date: '2027-03-23', name: 'Pakistan Day', reason: 'National holiday' }).expect(201);
    const renamed = await director.patch(`${API}/holidays/${created.body.id}`).send({ name: 'Pakistan Resolution Day', reason: 'Official name' }).expect(200);
    expect(renamed.body.name).toBe('Pakistan Resolution Day');
    await (await as(CTO)).post(`${API}/holidays/${created.body.id}/archive`).send({ reason: 'Moved to another day' }).expect(403);
    await director.post(`${API}/holidays/${created.body.id}/archive`).send({ reason: 'Moved to another day' }).expect(200);
    await director.post(`${API}/holidays/${created.body.id}/archive`).send({ reason: 'Moved to another day' }).expect(409);
    const list = await (await as(DEV1)).get(`${API}/holidays?year=2027`).expect(200);
    expect(list.body.map((h: { date: string }) => h.date)).toEqual(['2027-02-05']);
    const all = await (await as(DEV1)).get(`${API}/holidays?year=2027&includeArchived=true`).expect(200);
    expect(all.body).toHaveLength(2);
    expect(await prisma.holiday.count()).toBe(2); // nothing deleted
    for (const action of ['settings.holiday.created', 'settings.holiday.renamed', 'settings.holiday.archived']) {
      expect((await prisma.auditLog.findFirstOrThrow({ where: { action } })).reason).toBeTruthy();
    }
  });

  it('a holiday cannot be added to a locked month', async () => {
    const port = t.app.get(AttendancePayrollPort);
    await t.app.get(PrismaService).$transaction(async (tx) => port.lockMonth('2027-01', await idOf(DIRECTOR), tx));
    const res = await (await as(DIRECTOR)).post(`${API}/holidays`).send({ date: '2027-01-20', name: 'Late holiday', reason: 'Announced late' }).expect(409);
    expect(res.body.code).toBe('period_locked');
  });
});

describe('M7 payroll port: the month numbers for Module 8', () => {
  it('counts working days from the schedule and the holiday calendar', async () => {
    const port = t.app.get(AttendancePayrollPort);
    expect(await port.workingDays('2027-02-01', '2027-02-28')).toBe(19);
    expect(await port.workingDays('2027-02-06', '2027-02-07')).toBe(0);
    expect(await port.isMonthLocked('2027-02')).toBe(false);
  });

  it('summarises a crafted month exactly (present, late, absent, missed check-out, paid and unpaid leave, half day)', async () => {
    const port = t.app.get(AttendancePayrollPort);
    const dev1 = await idOf(DEV1);
    const dev2 = await idOf(DEV2);
    const rows = await t.app.get(PrismaService).$transaction(async (tx) => port.monthSummary('2027-02', [dev1, dev2, joiner.id, '00000000-0000-4000-8000-000000000000'], tx));
    expect(rows).toHaveLength(3);
    const [a, b, c] = rows;
    expect({ ...a, paidLeaveDays: a.paidLeaveDays.toFixed(1), unpaidLeaveDays: a.unpaidLeaveDays.toFixed(1) }).toEqual({
      employeeId: dev1, empId: DEV1, workingDays: 19, presentDays: 4, lateDays: 1, absentDays: 10, missedCheckouts: 1, paidLeaveDays: '2.0', unpaidLeaveDays: '2.5',
    });
    expect(a.unpaidLeaveDays.equals(dec('2.5'))).toBe(true); // a Decimal, not a float
    // DEV2 left on 9 February: only 1-9 February count (6 working days), the later check-in is ignored.
    expect(b).toMatchObject({ empId: DEV2, workingDays: 19, presentDays: 0, absentDays: 6, missedCheckouts: 0 });
    expect(b.unpaidLeaveDays.isZero()).toBe(true);
    // The joiner started on 15 February: 10 working days.
    expect(c).toMatchObject({ empId: joiner.empId, workingDays: 19, presentDays: 0, absentDays: 10 });
    expect(await port.monthSummary('2027-02', [])).toEqual([]);
  });

  it('the screens show the same numbers: month view and team summary with check-in next to first login', async () => {
    const month = await (await as(DEV1)).get(`${API}/attendance/me?month=2027-02`).expect(200);
    expect(month.body.totals).toEqual({ workingDays: 19, present: 4, late: 1, leave: 4.5, absent: 10, missedCheckouts: 1 });
    const byDate = Object.fromEntries((month.body.days as Array<{ date: string }>).map((d) => [d.date, d]));
    expect(byDate['2027-02-01']).toMatchObject({ status: 'on_time', firstLogin: pk('2027-02-01', '09:05').toISOString() });
    expect(byDate['2027-02-02']).toMatchObject({ status: 'late', lateMinutes: 20 });
    expect(byDate['2027-02-03']).toMatchObject({ status: 'missed_checkout' });
    expect(byDate['2027-02-04']).toMatchObject({ status: 'on_time', checkIn: pk('2027-02-04', '09:10').toISOString(), original: { checkIn: null, checkOut: null } });
    expect(byDate['2027-02-05']).toMatchObject({ status: 'holiday', note: 'Test Holiday' });
    expect(byDate['2027-02-06']).toMatchObject({ status: 'on_time', note: 'Weekend' });
    expect(byDate['2027-02-07']).toMatchObject({ status: 'weekend' });
    expect(byDate['2027-02-10']).toMatchObject({ status: 'leave', note: 'Unpaid (half day)' });
    expect(byDate['2027-02-15']).toMatchObject({ status: 'absent' });

    const team = await (await as(CTO)).get(`${API}/attendance/team/summary?month=2027-02`).expect(200);
    expect(team.body.monthWorkingDays).toBe(19);
    const row = team.body.rows.find((r: { empId: string }) => r.empId === DEV1);
    expect(row).toMatchObject({ present: 4, late: 1, leave: 4.5, absent: 10, missedCheckouts: 1, workingDays: 19, avgCheckIn: '09:11', avgLoginGapMin: 5 });
    expect(team.body.rows.find((r: { empId: string }) => r.empId === DEV2)).toMatchObject({ workingDays: 6, absent: 6 });
    expect(team.body.rows.find((r: { empId: string }) => r.empId === joiner.empId)).toMatchObject({ workingDays: 10, absent: 10 });
    // The finance officer has attendance.view_team but nobody below.
    expect((await (await as('ACV-0010')).get(`${API}/attendance/team/summary?month=2027-02`).expect(200)).body.rows).toEqual([]);
  });
});

describe('M7 leave types and entitlements (settings.manage)', () => {
  it('creates, updates and archives a leave type; an archived type cannot be requested', async () => {
    const director = await as(DIRECTOR);
    const body = { key: 'maternity', name: 'Maternity', yearlyDays: 90, paid: true, reason: 'Company policy from management' };
    await (await as(CTO)).post(`${API}/leave/types`).send(body).expect(403);
    const created = await director.post(`${API}/leave/types`).send(body).expect(201);
    expect(created.body).toMatchObject({ key: 'maternity', yearlyDays: 90, paid: true, archived: false });
    expect((await director.post(`${API}/leave/types`).send(body).expect(409)).body.code).toBe('leave_type_exists');
    const updated = await director.patch(`${API}/leave/types/${created.body.id}`).send({ yearlyDays: 84.5, reason: 'Corrected by management' }).expect(200);
    expect(updated.body.yearlyDays).toBe(84.5);
    await director.patch(`${API}/leave/types/${created.body.id}`).send({ yearlyDays: 84.5 }).expect(400); // a reason is required
    await director.post(`${API}/leave/types/${created.body.id}/archive`).send({ reason: 'Replaced by a new policy' }).expect(200);
    const types = await (await as(DEV1)).get(`${API}/leave/types`).expect(200);
    expect(types.body.map((tp: { key: string }) => tp.key)).not.toContain('maternity');
    const all = await (await as(DEV1)).get(`${API}/leave/types?includeArchived=true`).expect(200);
    expect(all.body.find((tp: { key: string }) => tp.key === 'maternity')).toMatchObject({ archived: true });
    const res = await (await as(DEV1)).post(`${API}/leave/requests`).send({ leaveTypeId: created.body.id, from: '2027-03-15', to: '2027-03-15', reason: 'Family' }).expect(400);
    expect(res.body.code).toBe('invalid_leave_type');
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'settings.leave_type.updated' } });
    expect(audit.details).toMatchObject({ before: { yearlyDays: 90 }, after: { yearlyDays: 84.5 } });
  });

  it('sets a personal allowance for someone below (never yourself) and the balance uses it', async () => {
    const types = Object.fromEntries((await prisma.leaveType.findMany()).map((tp) => [tp.key, tp.id]));
    const director = await as(DIRECTOR);
    const body = { empId: DEV1, leaveTypeId: types.casual, year: 2027, days: 12, reason: 'Long service allowance' };
    await (await as(CTO)).post(`${API}/settings/leave-entitlements`).send(body).expect(403);
    expect((await director.post(`${API}/settings/leave-entitlements`).send({ ...body, empId: DIRECTOR }).expect(403)).body.code).toBe('self_change');
    await director.post(`${API}/settings/leave-entitlements`).send({ ...body, empId: CEO }).expect(403); // above the Director
    await director.post(`${API}/settings/leave-entitlements`).send({ ...body, days: 12.3 }).expect(400);
    await director.post(`${API}/settings/leave-entitlements`).send(body).expect(200);
    const balances = await (await as(DEV1)).get(`${API}/leave/balances/${DEV1}?year=2027`).expect(200);
    expect(balances.body.balances.find((b: { key: string }) => b.key === 'casual')).toMatchObject({ total: 12, overridden: true, used: 3, remaining: 9 }); // 3 casual days approved in February
    const list = await director.get(`${API}/settings/leave-entitlements?year=2027`).expect(200);
    expect(list.body).toMatchObject([{ empId: DEV1, year: 2027, days: 12 }]);
    expect(await prisma.auditLog.count({ where: { action: 'settings.leave_entitlement.set', targetId: DEV1 } })).toBe(1);
  });

  it('everyone reads the work schedule; office networks are listed and archived by the Director', async () => {
    const schedule = await (await as(DEV1)).get(`${API}/settings/work-schedule`).expect(200);
    expect(schedule.body.current).toMatchObject({ start: '09:00', end: '18:00', graceMinutes: 15, officeOnlyCheckIn: false });
    const director = await as(DIRECTOR);
    const net = await director.post(`${API}/settings/office-networks`).send({ officeCode: 'off-dadu', cidr: '192.0.2.10', label: 'Dadu fibre', reason: 'Dadu office line' }).expect(201);
    await (await as(DEV1)).get(`${API}/settings/office-networks`).expect(403);
    expect((await director.get(`${API}/settings/office-networks`).expect(200)).body).toMatchObject([{ officeCode: 'off-dadu', cidr: '192.0.2.10', archived: false }]);
    await director.post(`${API}/settings/office-networks/${net.body.id}/archive`).send({ reason: 'Line replaced' }).expect(200);
    expect((await director.get(`${API}/settings/office-networks`).expect(200)).body[0].archived).toBe(true);
  });
});
