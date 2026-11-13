import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';
import { API, setPay, TEST_SLABS } from './m8-support';

/**
 * Module 8 with the REAL Module 7 and Module 9 ports (no fakes): the month is locked in attendance, approved unpaid leave
 * is deducted, approval creates a balanced salary entry that waits for the normal ledger approval, and the run follows the
 * entry when Module 9 posts it. Salary advances are paid through a real payout entry.
 */
const DIRECTOR = 'ACV-0003';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const FINANCE = 'ACV-0010';
let CEO = '';

let t: TestApp;
let prisma: PrismaClient;
let runId = '';
let bankId = '';

const as = (who: string) => t.as(who);

/** base / working days x 1 day, rounded to paisa, for the working days the real calendar gives. */
const ONE_UNPAID_DAY: Record<number, string> = { 20: '5000.00', 21: '4761.90', 22: '4545.45', 23: '4347.83' };

beforeAll(async () => {
  prisma = createTestPrisma();
  t = await createTestApp();
  await t.signInAll();
  CEO = t.fixtures.CEO;
  await setPay(t, prisma, DEV1, { base: '100000', account: 'PK11HABB0000000000001111' });
  await setPay(t, prisma, DEV2, { base: '60000', account: 'PK11HABB0000000000002222' });
  await as(DIRECTOR).post(`${API}/settings/tax-slabs`).send(TEST_SLABS).expect(201);
  bankId = (await prisma.ledgerAccount.findFirstOrThrow({ where: { code: '1100', isBank: true } })).id;
  // One approved day of unpaid leave for DEV1 on Wednesday 14 October 2026 (written directly: the M7 flow has its own tests).
  const dev1 = await prisma.employee.findUniqueOrThrow({ where: { empId: DEV1 } });
  const unpaid = await prisma.leaveType.findUniqueOrThrow({ where: { key: 'unpaid' } });
  await prisma.leaveRequest.create({
    data: { employeeId: dev1.id, leaveTypeId: unpaid.id, fromDate: new Date('2026-10-14'), toDate: new Date('2026-10-14'), days: '1', reason: 'Family matter (test)', status: 'approved' },
  });
}, 120000);

afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M8 with the real attendance (M7) and ledger (M9) modules', () => {
  it('calculating locks the month in attendance and deducts the approved unpaid leave', async () => {
    runId = (await as(FINANCE).post(`${API}/payroll/runs`).send({ month: '2026-10' }).expect(201)).body.id;
    const run = (await as(FINANCE).post(`${API}/payroll/runs/${runId}/calculate`).expect(200)).body;
    expect(await prisma.attendancePeriod.findUnique({ where: { month: '2026-10' } })).not.toBeNull();
    const lines = (await as(FINANCE).get(`${API}/payroll/runs/${runId}/lines`).expect(200)).body.lines;
    const dev1 = lines.find((l: { empId: string }) => l.empId === DEV1);
    expect(dev1.workingDays).toBe(run.workingDays);
    expect(dev1).toMatchObject({ unpaidDays: '1.0', unpaidDeduction: ONE_UNPAID_DAY[run.workingDays] });
    expect(lines.find((l: { empId: string }) => l.empId === DEV2)).toMatchObject({ unpaidDays: '0.0', net: '59900.00' });
    // the locked month refuses new attendance (Module 7 rule, enforced by the database)
    const dev2 = await prisma.employee.findUniqueOrThrow({ where: { empId: DEV2 } });
    await expect(
      prisma.attendanceRecord.create({ data: { employeeId: dev2.id, workDate: new Date('2026-10-20'), checkInAt: new Date('2026-10-20T04:00:00Z') } }),
    ).rejects.toThrow();
    // calculating again is allowed and does not lock twice
    await as(FINANCE).post(`${API}/payroll/runs/${runId}/calculate`).expect(200);
    expect(await prisma.auditLog.count({ where: { action: 'attendance.month_locked', targetId: '2026-10' } })).toBe(1);
  });

  it('approval creates one balanced salary entry, made by the preparer, waiting for ledger approval', async () => {
    await as(FINANCE).post(`${API}/payroll/runs/${runId}/prepare`).expect(200);
    await as(DIRECTOR).post(`${API}/payroll/runs/${runId}/review`).expect(200);
    await t.stepUp(CEO);
    const approved = (await as(CEO).post(`${API}/payroll/runs/${runId}/approve`).expect(200)).body;
    expect(approved.salaryEntry).toMatchObject({ status: 'pending_approval' });
    expect(approved.salaryEntry.number).toMatch(/^JE-\d{4}-\d{4,}$/);

    const entries = await prisma.journalEntry.findMany({ where: { source: 'payroll', sourceRef: runId }, include: { lines: { include: { account: true } } } });
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    const finance = await prisma.employee.findUniqueOrThrow({ where: { empId: FINANCE } });
    expect(entry).toMatchObject({ status: 'pending_approval', purpose: 'salary', makerId: finance.id });
    expect(entry.entryDate.toISOString().slice(0, 10)).toBe('2026-10-31');
    const debit = entry.lines.reduce((a, l) => a + Number(l.debit), 0);
    const credit = entry.lines.reduce((a, l) => a + Number(l.credit), 0);
    expect(debit.toFixed(2)).toBe(credit.toFixed(2));
    expect(debit.toFixed(2)).toBe(approved.totals.gross);
    const byRole = Object.fromEntries(entry.lines.map((l) => [l.account.systemRole, (Number(l.debit) || Number(l.credit)).toFixed(2)]));
    expect(byRole).toMatchObject({ salary_expense: approved.totals.gross, tax_payable: approved.totals.tax, salary_payable: approved.totals.net });
    expect(approved.id).toBe(runId);
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } })).journalEntryId).toBe(entry.id);
  });

  it('the run shows the entry as posted once Module 9 approves it (the CEO, at their tier, confirming again)', async () => {
    const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } });
    await t.stepUp(CEO);
    await as(CEO).post(`${API}/journal-entries/${run.journalEntryId}/approve`).send({}).expect(200);
    expect((await as(FINANCE).get(`${API}/payroll/runs/${runId}`).expect(200)).body.salaryEntry.status).toBe('posted');
  });

  it('marking paid creates the payment entry against the real bank account, once', async () => {
    const paid = (await as(FINANCE).post(`${API}/payroll/runs/${runId}/mark-paid`).send({ bankAccountId: bankId, paidOn: '2026-11-05' }).expect(200)).body;
    expect(paid).toMatchObject({ paid: true, paymentEntry: { status: 'pending_approval' } });
    const payment = await prisma.journalEntry.findFirstOrThrow({ where: { source: 'payroll_payment', sourceRef: runId }, include: { lines: { include: { account: true } } } });
    expect(payment.lines.map((l) => [l.account.systemRole ?? l.account.code, Number(l.debit).toFixed(2), Number(l.credit).toFixed(2)])).toEqual(
      expect.arrayContaining([
        ['salary_payable', paid.totals.net, '0.00'],
        ['1100', '0.00', paid.totals.net],
      ]),
    );
    expect((await as(FINANCE).post(`${API}/payroll/runs/${runId}/mark-paid`).send({ bankAccountId: bankId, paidOn: '2026-11-05' }).expect(409)).body.code).toBe('already_paid');
  });

  it('an advance is paid through a real payout entry and repaid only after the Director posts it', async () => {
    const advance = (await as(FINANCE).post(`${API}/payroll/advances`).send({ empId: DEV2, amount: '6000.00', monthlyDeduction: '2000.00', startMonth: '2026-11', reason: 'Medical emergency', bankAccountId: bankId }).expect(201)).body;
    expect(advance).toMatchObject({ status: 'pending_payout', payoutEntry: { status: 'pending_approval' } });
    const payout = await prisma.journalEntry.findFirstOrThrow({ where: { source: 'advance', sourceRef: advance.id } });
    const november = (await as(FINANCE).post(`${API}/payroll/runs`).send({ month: '2026-11' }).expect(201)).body.id;
    await as(FINANCE).post(`${API}/payroll/runs/${november}/calculate`).expect(200);
    let lines = (await as(FINANCE).get(`${API}/payroll/runs/${november}/lines`)).body.lines;
    expect(lines.find((l: { empId: string }) => l.empId === DEV2).advanceDeduction).toBe('0.00');
    await as(DIRECTOR).post(`${API}/journal-entries/${payout.id}/approve`).send({}).expect(200);
    await as(FINANCE).post(`${API}/payroll/runs/${november}/calculate`).expect(200);
    lines = (await as(FINANCE).get(`${API}/payroll/runs/${november}/lines`)).body.lines;
    expect(lines.find((l: { empId: string }) => l.empId === DEV2)).toMatchObject({ advanceDeduction: '2000.00', net: '57900.00' });
    expect((await as(DEV2).get(`${API}/payroll/advances/me`).expect(200)).body[0].status).toBe('active');
  });
});
