import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboxEventSchema } from '@aceva/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { JobRunner } from '../src/jobs/job-runner.service';
import { OffboardingService } from '../src/people/offboarding.service';
import { accessEndsAt, isDue, pakistanToday } from '../src/people/leaving-rules';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

const OWNER = 'ACV-0001';
const CEO = 'ACV-0002';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const HR = 'ACV-0015';
const FINANCE = 'ACV-0010';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const SALES1 = 'ACV-0009';

let t: TestApp;
let prisma: PrismaClient;

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  prisma = createTestPrisma();
});
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

const isoDay = (offsetDays: number) => new Date(Date.now() + offsetDays * 86_400_000 + 5 * 3600_000).toISOString().slice(0, 10);
const offboard = (who: string, target: string, lastWorkingDay: string, reason = 'Resigned, notice served') =>
  t.as(who).post(`/api/v1/employees/${target}/offboard`).send({ lastWorkingDay, reason });

describe('M3 Pakistan-time rules', () => {
  it('works out the day in Pakistan (UTC+5); access ends at 00:00 Pakistan time on the day AFTER the last working day', () => {
    expect(pakistanToday(new Date('2026-12-01T19:30:00Z'))).toBe('2026-12-02');
    expect(pakistanToday(new Date('2026-12-01T18:59:00Z'))).toBe('2026-12-01');
    expect(accessEndsAt('2026-12-02').toISOString()).toBe('2026-12-02T19:00:00.000Z'); // = 00:00 on 3 Dec in Pakistan
    // through the whole last working day (2 Dec) the person is still active
    expect(isDue('2026-12-02', new Date('2026-12-02T18:59:00Z'))).toBe(false); // 23:59 on 2 Dec in Pakistan
    expect(isDue('2026-12-02', new Date('2026-12-02T19:00:00Z'))).toBe(true); // 00:00 on 3 Dec in Pakistan
    expect(isDue('2026-11-01', new Date('2026-12-01T00:00:00Z'))).toBe(true);
  });
});

describe('M3 leaving: processed immediately when the last working day is already over', () => {
  it('only HR or the Director (above or over the person) can set a last working day', async () => {
    for (const who of [DEV1, CTO, FINANCE, CEO, OWNER]) await offboard(who, DEV2, isoDay(0)).expect(403);
    await offboard(HR, DIRECTOR, isoDay(0)).expect(403); // upward
    await offboard(HR, HR, isoDay(0)).expect(403); // themselves
    await offboard(HR, SALES1, isoDay(0)).expect(403); // beside, same level
    await offboard(HR, DEV2, isoDay(0), 'no').expect(400); // a reason is required
    await offboard(HR, DEV2, '2020-01-01').expect(400); // before the joining date
    expect((await prisma.employee.findUniqueOrThrow({ where: { empId: DEV2 } })).status).toBe('active');
  });

  it('disables login, ends all sessions, ends duties and stand-ins, clears head of department, and keeps the record', async () => {
    await prisma.department.update({ where: { code: 'dep-eng' }, data: { head: { connect: { empId: DEV2 } } } });
    const duty = await prisma.duty.findFirstOrThrow({ where: { key: 'hr' } });
    await prisma.employeeDuty.create({ data: { employee: { connect: { empId: DEV2 } }, duty: { connect: { id: duty.id } }, reason: 'test' } });
    const mine = t.as(DEV2);
    await mine.get('/api/v1/auth/me').expect(200);

    const res = await offboard(HR, DEV2, isoDay(-1)).expect(200);
    expect(res.body).toMatchObject({ empId: DEV2, processed: 'now' });

    await mine.get('/api/v1/auth/me').expect(401); // every session ended
    expect((await t.rawLogin({ empId: DEV2, password: 'Demo-Passw0rd-2026' }).expect(200)).body.status).not.toBe('ok'); // cannot sign in
    const employee = await prisma.employee.findUniqueOrThrow({ where: { empId: DEV2 } });
    expect(employee.status).toBe('left'); // the record is never deleted
    expect((await prisma.credential.findFirstOrThrow({ where: { employeeId: employee.id } })).loginDisabledAt).not.toBeNull();
    expect(await prisma.employeeDuty.count({ where: { employeeId: employee.id, endedAt: null } })).toBe(0);
    expect((await prisma.department.findUniqueOrThrow({ where: { code: 'dep-eng' } })).headEmployeeId).toBeNull();
    const history = await prisma.employmentHistory.findMany({ where: { employeeId: employee.id }, orderBy: { createdAt: 'asc' } });
    expect(history.map((h) => h.eventType)).toEqual(expect.arrayContaining(['notice_given', 'left']));
    expect(await prisma.employee.count({ where: { empId: DEV2 } })).toBe(1);
  });

  it('prepares the events for tasks and final salary (event contracts and outbox only; nothing consumes them yet)', async () => {
    const events = await prisma.outboxEvent.findMany({ where: { type: { in: ['employee.offboarded', 'task.transfer.requested', 'payroll.final_settlement.requested'] } } });
    expect(events.map((e) => e.type).sort()).toEqual(['employee.offboarded', 'payroll.final_settlement.requested', 'task.transfer.requested']);
    for (const e of events) expect(outboxEventSchema.safeParse({ id: e.id, type: e.type, version: e.version, occurredAt: e.occurredAt.toISOString(), actor: e.actor, payload: e.payload }).success).toBe(true);
    expect(events.find((e) => e.type === 'task.transfer.requested')!.payload).toEqual({ fromEmpId: DEV2, toEmpId: CTO, reason: 'employee_left' });
    expect(events.find((e) => e.type === 'payroll.final_settlement.requested')!.payload).toMatchObject({ empId: DEV2, lastWorkingDay: isoDay(-1) });
  });

  it('audits the leaving and shows the person as left in the directory, but keeps their profile readable', async () => {
    expect(await prisma.auditLog.count({ where: { action: 'employee.offboarded', targetId: DEV2 } })).toBe(1);
    expect(((await t.as(HR).get('/api/v1/employees').expect(200)).body as Array<{ empId: string }>).some((e) => e.empId === DEV2)).toBe(false);
    const profile = (await t.as(DIRECTOR).get(`/api/v1/employees/${DEV2}`).expect(200)).body;
    expect(profile.job).toMatchObject({ status: 'left' });
    await offboard(HR, DEV2, isoDay(0)).expect(400); // already left
  });

  it('processing the same person twice changes nothing (safe retries)', async () => {
    const service = t.app.get(OffboardingService);
    await service.process(DEV2);
    await service.process(DEV2);
    expect(await prisma.outboxEvent.count({ where: { type: 'employee.offboarded' } })).toBe(1);
    expect(await prisma.employmentHistory.count({ where: { employee: { empId: DEV2 }, eventType: 'left' } })).toBe(1);
  });

  it('never moves the leaver\'s reports by itself: they are listed until the Owner or CEO assign a new manager', async () => {
    // a new Level 5 hire reports to Finance (Level 4), who then leaves
    const hire = await t.as(OWNER).post('/api/v1/employees').send({ name: 'Orphan Report', designation: 'Analyst', departmentId: 'dep-fin', officeId: 'off-khi', officialEmail: 'orphan.report@acevatech.com', level: 5, reportsToEmpId: FINANCE, joiningDate: '2026-11-01', type: 'full_time' }).expect(201);
    const orphan = hire.body.empId as string;
    const res = await offboard(DIRECTOR, FINANCE, isoDay(-1)).expect(200);
    expect(res.body.directReportsNeedingManager).toContain(orphan);
    const finance = await prisma.employee.findUniqueOrThrow({ where: { empId: FINANCE } });
    expect((await prisma.employee.findUniqueOrThrow({ where: { empId: orphan } })).reportsToId).toBe(finance.id); // unchanged

    // the unresolved reports are shown to Owner, CEO, Director and HR; nobody else
    for (const who of [OWNER, CEO, DIRECTOR, HR]) {
      const list = (await t.as(who).get('/api/v1/employees/unresolved-reports').expect(200)).body as Array<{ empId: string; leftManager: { empId: string } }>;
      expect(list.find((r) => r.empId === orphan)!.leftManager.empId).toBe(FINANCE);
    }
    await t.as(DEV1).get('/api/v1/employees/unresolved-reports').expect(403);

    // only the Owner or CEO can reassign (Director and HR cannot)
    await t.as(DIRECTOR).patch(`/api/v1/employees/${orphan}/job`).send({ reportsToEmpId: DIRECTOR, reason: 'Director may not change lines' }).expect(403);
    await t.as(HR).patch(`/api/v1/employees/${orphan}/job`).send({ reportsToEmpId: DIRECTOR, reason: 'HR may not change lines' }).expect(403);
    await t.as(CEO).patch(`/api/v1/employees/${orphan}/job`).send({ reportsToEmpId: DIRECTOR, reason: 'Finance lead left; reassigned' }).expect(200);
    const after = (await t.as(CEO).get('/api/v1/employees/unresolved-reports').expect(200)).body as Array<{ empId: string }>;
    expect(after.some((r) => r.empId === orphan)).toBe(false);
  });
});

describe('M3 leaving: scheduled for a future day', () => {
  it('keeps the person working until the day comes, then processes once', async () => {
    const day = isoDay(3);
    const res = await offboard(DIRECTOR, SALES1, day).expect(200);
    expect(res.body).toMatchObject({ processed: 'scheduled' });
    const employee = await prisma.employee.findUniqueOrThrow({ where: { empId: SALES1 } });
    expect(employee.status).toBe('on_notice');
    const job = await prisma.scheduledJob.findUniqueOrThrow({ where: { dedupeKey: `offboard:${SALES1}` } });
    expect(job).toMatchObject({ type: 'employee.offboard', status: 'pending' });
    expect(job.runAt.toISOString()).toBe(accessEndsAt(day).toISOString());
    await t.as(SALES1).get('/api/v1/auth/me').expect(200); // still works on notice

    const runner = t.app.get(JobRunner);
    expect(await runner.tick()).toBe(0); // not due yet
    expect((await prisma.employee.findUniqueOrThrow({ where: { empId: SALES1 } })).status).toBe('on_notice');

    // through the whole last working day the person keeps access: still on notice on that day, even late in the evening
    t.clock.advance(3 * 86_400_000 + 3600_000);
    expect(await runner.tick()).toBe(0);
    expect((await prisma.employee.findUniqueOrThrow({ where: { empId: SALES1 } })).status).toBe('on_notice');
    // access ends at 00:00 Pakistan time on the next day
    t.clock.advance(86_400_000);
    expect(await runner.tick()).toBe(1);
    expect((await prisma.employee.findUniqueOrThrow({ where: { empId: SALES1 } })).status).toBe('left');
    expect((await prisma.scheduledJob.findUniqueOrThrow({ where: { dedupeKey: `offboard:${SALES1}` } })).status).toBe('succeeded');
    expect(await runner.tick()).toBe(0); // runs once
    expect(await prisma.outboxEvent.count({ where: { type: 'employee.offboarded' } })).toBeGreaterThanOrEqual(2);
    t.clock.reset();
  });

  it('can be moved to another day or cancelled before it happens', async () => {
    const candidate = DEV1;
    const today = await offboard(HR, candidate, isoDay(0)).expect(200); // the last working day is today: still working, ends tomorrow
    expect(today.body.processed).toBe('scheduled');
    expect(await t.app.get(JobRunner).tick()).toBe(0);
    expect((await prisma.employee.findUniqueOrThrow({ where: { empId: candidate } })).status).toBe('on_notice');
    await offboard(HR, candidate, isoDay(5)).expect(200);
    await offboard(HR, candidate, isoDay(9), 'Notice period extended').expect(200);
    const job = await prisma.scheduledJob.findUniqueOrThrow({ where: { dedupeKey: `offboard:${candidate}` } });
    expect(job.runAt.toISOString()).toBe(accessEndsAt(isoDay(9)).toISOString());
    expect(await prisma.scheduledJob.count({ where: { dedupeKey: { startsWith: `offboard:${candidate}` } } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'employee.offboarding.rescheduled', targetId: candidate } })).toBe(2);

    await t.as(HR).delete(`/api/v1/employees/${candidate}/offboard`).send({ reason: 'Decided to stay' }).expect(200);
    const employee = await prisma.employee.findUniqueOrThrow({ where: { empId: candidate } });
    expect([employee.status, employee.lastWorkingDay]).toEqual(['active', null]);
    t.clock.advance(20 * 86_400_000);
    await t.app.get(JobRunner).tick();
    expect((await prisma.employee.findUniqueOrThrow({ where: { empId: candidate } })).status).toBe('active'); // the cancelled job did nothing
    t.clock.reset();
    await t.as(HR).delete(`/api/v1/employees/${candidate}/offboard`).send({ reason: 'Nothing to cancel' }).expect(400);
  });
});

describe('M3 job runner: retries, failures and crash recovery', () => {
  it('retries a failing job with a delay, keeps the error, and gives up after the maximum attempts', async () => {
    const runner = t.app.get(JobRunner);
    runner.register('test.fail', async () => {
      throw new Error('boom');
    });
    await runner.schedule('test.fail', 'test:fail', new Date(Date.now() - 1000), {}, null);
    await runner.tick();
    let job = await prisma.scheduledJob.findUniqueOrThrow({ where: { dedupeKey: 'test:fail' } });
    expect(job).toMatchObject({ status: 'pending', attempts: 1, lastError: 'boom' });
    expect(job.runAt.getTime()).toBeGreaterThan(Date.now()); // backed off
    for (let i = 0; i < 6; i++) {
      t.clock.advance(7 * 3600_000);
      await runner.tick();
    }
    job = await prisma.scheduledJob.findUniqueOrThrow({ where: { dedupeKey: 'test:fail' } });
    expect(job).toMatchObject({ status: 'failed', attempts: 5, lastError: 'boom' });
    t.clock.reset();
  });

  it('recovers a job left "running" by a crashed server once its lock is stale', async () => {
    const runner = t.app.get(JobRunner);
    let ran = 0;
    runner.register('test.crash', async () => {
      ran++;
    });
    await runner.schedule('test.crash', 'test:crash', new Date(Date.now() - 1000), {}, null);
    await prisma.scheduledJob.update({ where: { dedupeKey: 'test:crash' }, data: { status: 'running', lockedAt: new Date(), lockedBy: 'dead-server:1' } });
    expect(await runner.tick()).toBe(0); // a fresh lock belongs to a live server
    t.clock.advance(10 * 60_000);
    expect(await runner.tick()).toBe(1);
    expect(ran).toBe(1);
    t.clock.reset();
  });

  it('runs each job once even when several servers tick at the same time', async () => {
    const runner = t.app.get(JobRunner);
    let ran = 0;
    runner.register('test.once', async () => {
      ran++;
      await new Promise((r) => setTimeout(r, 50));
    });
    await runner.schedule('test.once', 'test:once', new Date(Date.now() - 1000), {}, null);
    const other = new JobRunner(t.app.get(PrismaService), t.clock);
    other.register('test.once', async () => {
      ran++;
    });
    await Promise.all([runner.tick(), other.tick()]);
    expect(ran).toBe(1);
  });
});
