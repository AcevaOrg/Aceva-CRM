import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttendancePayrollPort } from '../src/attendance/attendance-payroll.port';
import { dec, round2, sum } from '../src/common/money';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type Client, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';
import { m7Personas, pkAt } from './m7-support';
import { setPay, TEST_SLABS } from './m8-support';

/**
 * Cycle 3 end to end, through the real HTTP API and the real modules (no fake ports):
 *   attendance (M7: check-in/out, a late day, a two-step unpaid leave)
 *   -> the month summary Module 7 gives payroll
 *   -> payroll calculation, preparation, review and approval with "confirm again" (M8)
 *   -> one balanced salary entry that waits for, and gets, ledger approval at the right tier (M9)
 *   -> payment recorded through a second ledger entry; salary payable back to zero
 *   -> the month is closed (finance runs it, the CEO approves) and nothing more can be posted into it.
 * February 2027: 1 February is a Monday. Development schedule 09:00 to 18:00, 15 minutes grace.
 */
const API = '/api/v1';
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const FINANCE = 'ACV-0010';
const MONTH = '2027-02';
const DEV1_ACCOUNT = 'PK36SCBL0000001123456702';
const DEV2_ACCOUNT = 'PK36SCBL0000001123456703';

let t: TestApp;
let prisma: PrismaClient;
let m7as: (empId: string) => Promise<Client>;
let CEO = '';
let runId = '';
let bankId = '';
let totals: { gross: string; tax: string; net: string } = { gross: '', tax: '', net: '' };

const approverFor = (level: number | null) => (level === 3 ? DIRECTOR : level === 2 ? CEO : OWNER);

beforeAll(async () => {
  prisma = createTestPrisma();
  t = await createTestApp();
  t.clock.set(new Date('2027-02-01T02:00:00.000Z')); // 07:00 in Pakistan, Monday 1 February 2027
  await t.ensureFixtures();
  CEO = t.fixtures.CEO;
  m7as = m7Personas(t);
}, 180000);

afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('Cycle 3 end to end: attendance -> payroll -> ledger -> payment -> month close', () => {
  it('M7: people check in and out on the server clock, and an unpaid leave goes team lead -> Director', async () => {
    const unpaid = (await prisma.leaveType.findUniqueOrThrow({ where: { key: 'unpaid' } })).id;

    pkAt(t, '2027-02-01', '08:00');
    const asked = (await (await m7as(DEV1)).post(`${API}/leave/requests`).send({ leaveTypeId: unpaid, from: '2027-02-10', to: '2027-02-10', reason: 'Family matter' }).expect(201)).body;
    expect(asked.status).toBe('pending_manager');
    await (await m7as(DEV1)).post(`${API}/leave/requests/${asked.id}/approve`).send({}).expect((r) => expect([403, 404]).toContain(r.status)); // never your own
    expect((await (await m7as(CTO)).post(`${API}/leave/requests/${asked.id}/approve`).send({}).expect(200)).body.status).toBe('pending_director');
    expect((await (await m7as(DIRECTOR)).post(`${API}/leave/requests/${asked.id}/approve`).send({}).expect(200)).body.status).toBe('approved');

    pkAt(t, '2027-02-01', '09:05');
    await (await m7as(DEV2)).post(`${API}/attendance/check-in`).send({}).expect(200);
    pkAt(t, '2027-02-01', '09:10');
    const onTime = (await (await m7as(DEV1)).post(`${API}/attendance/check-in`).send({ checkInAt: '2027-02-01T03:00:00.000Z' }).expect(200)).body;
    expect(onTime.lateMinutes ?? onTime.record?.lateMinutes ?? 0).toBe(0);
    pkAt(t, '2027-02-01', '18:05');
    await (await m7as(DEV1)).post(`${API}/attendance/check-out`).send({}).expect(200);
    await (await m7as(DEV2)).post(`${API}/attendance/check-out`).send({}).expect(200);

    pkAt(t, '2027-02-02', '09:30'); // 15 minutes after the grace period
    await (await m7as(DEV2)).post(`${API}/attendance/check-in`).send({}).expect(200);
    pkAt(t, '2027-02-02', '18:10');
    await (await m7as(DEV2)).post(`${API}/attendance/check-out`).send({}).expect(200);
  }, 90_000); // several real sign-ins with authenticator codes (slow on a busy machine)

  it('M7 -> M8: payroll uses exactly the month summary attendance gives, and calculation locks the month', async () => {
    pkAt(t, '2027-03-01', '09:00');
    await t.signInAll(); // fresh sessions in March for the payroll and finance steps
    await setPay(t, prisma, DEV1, { base: '100000', account: DEV1_ACCOUNT });
    await setPay(t, prisma, DEV2, { base: '60000', account: DEV2_ACCOUNT });
    await t.as(DIRECTOR).post(`${API}/settings/tax-slabs`).send(TEST_SLABS).expect(201);
    bankId = (await prisma.ledgerAccount.findFirstOrThrow({ where: { code: '1100', isBank: true } })).id;

    const [dev1, dev2] = await Promise.all([DEV1, DEV2].map((empId) => prisma.employee.findUniqueOrThrow({ where: { empId } })));
    const summary = await t.app.get(AttendancePayrollPort).monthSummary(MONTH, [dev1.id, dev2.id]);
    const s1 = summary.find((s) => s.empId === DEV1)!;
    const s2 = summary.find((s) => s.empId === DEV2)!;
    const wd = s1.workingDays;
    expect(wd).toBeGreaterThanOrEqual(18);
    expect(s1).toMatchObject({ presentDays: 1, lateDays: 0, absentDays: wd - 2, missedCheckouts: 0 });
    expect(s1.unpaidLeaveDays.toFixed(1)).toBe('1.0');
    expect(s2).toMatchObject({ presentDays: 2, lateDays: 1, absentDays: wd - 2, missedCheckouts: 0 });
    expect(s2.unpaidLeaveDays.toFixed(1)).toBe('0.0');

    runId = (await t.as(FINANCE).post(`${API}/payroll/runs`).send({ month: MONTH }).expect(201)).body.id;
    const run = (await t.as(FINANCE).post(`${API}/payroll/runs/${runId}/calculate`).expect(200)).body;
    expect(run.workingDays).toBe(wd);
    expect(await prisma.attendancePeriod.findUnique({ where: { month: MONTH } })).not.toBeNull();

    const lines = (await t.as(FINANCE).get(`${API}/payroll/runs/${runId}/lines`).expect(200)).body.lines;
    const l1 = lines.find((l: { empId: string }) => l.empId === DEV1);
    const l2 = lines.find((l: { empId: string }) => l.empId === DEV2);
    expect(l1).toMatchObject({ workingDays: wd, presentDays: 1, lateDays: 0, absentDays: wd - 2, unpaidDays: '1.0', unpaidDeduction: round2(dec(100000).div(wd)).toFixed(2) });
    expect(l2).toMatchObject({ workingDays: wd, presentDays: 2, lateDays: 1, absentDays: wd - 2, unpaidDays: '0.0', unpaidDeduction: '0.00' });
    // D6 (pending): lateness and absence without leave do not change pay; only unpaid leave does
    expect(l2.net).toBe('59900.00');

    // the locked month: no more attendance and no more leave, even written directly to the database
    await expect(prisma.attendanceRecord.create({ data: { employeeId: dev2.id, workDate: new Date('2027-02-15'), checkInAt: new Date('2027-02-15T04:00:00Z') } })).rejects.toThrow();
    const sick = (await prisma.leaveType.findUniqueOrThrow({ where: { key: 'sick' } })).id;
    await expect(
      prisma.leaveRequest.create({ data: { employeeId: dev2.id, leaveTypeId: sick, fromDate: new Date('2027-02-16'), toDate: new Date('2027-02-16'), days: '1', reason: 'Backdated (test)', status: 'approved' } }),
    ).rejects.toThrow(/period_locked/);
  }, 120_000); // signs every test person in again for March

  it('M8: Finance prepares, the Director reviews, the CEO approves only after confirming again', async () => {
    await t.as(FINANCE).post(`${API}/payroll/runs/${runId}/prepare`).expect(200);
    await t.as(DIRECTOR).post(`${API}/payroll/runs/${runId}/approve`).expect(404); // the Director reviews, never approves (P1)
    await t.as(DIRECTOR).post(`${API}/payroll/runs/${runId}/review`).expect(200);
    expect((await t.as(CEO).post(`${API}/payroll/runs/${runId}/approve`).expect(403)).body.code).toBe('step_up_required');
    await t.stepUp(CEO);
    const approved = (await t.as(CEO).post(`${API}/payroll/runs/${runId}/approve`).expect(200)).body;
    totals = approved.totals;
    expect(approved.stage).toBe('approved');
    expect(approved.salaryEntry.status).toBe('pending_approval'); // P7 / D5: waits for normal ledger approval
  });

  it('M8 -> M9: one balanced salary entry, made by the preparer, approved at the tier its amount needs', async () => {
    const entries = await prisma.journalEntry.findMany({ where: { source: 'payroll', sourceRef: runId }, include: { lines: { include: { account: true } } } });
    expect(entries).toHaveLength(1);
    const entry = entries[0];
    const finance = await prisma.employee.findUniqueOrThrow({ where: { empId: FINANCE } });
    expect(entry).toMatchObject({ status: 'pending_approval', makerId: finance.id });
    expect(entry.entryDate.toISOString().slice(0, 10)).toBe('2027-02-28');
    const debit = sum(entry.lines.map((l) => dec(l.debit)));
    const credit = sum(entry.lines.map((l) => dec(l.credit)));
    expect(debit.equals(credit)).toBe(true);
    expect(debit.toFixed(2)).toBe(totals.gross);
    expect(dec(entry.totalBase).toFixed(2)).toBe(totals.gross);
    const byRole = (role: string) => sum(entry.lines.filter((l) => l.account.systemRole === role).map((l) => dec(l.debit).plus(l.credit))).toFixed(2);
    expect(byRole('salary_expense')).toBe(totals.gross);
    expect(byRole('tax_payable')).toBe(totals.tax);
    expect(byRole('salary_payable')).toBe(totals.net);

    // the maker never approves; an approver below the tier is refused
    await t.as(FINANCE).post(`${API}/journal-entries/${entry.id}/approve`).send({}).expect(404);
    if ((entry.requiredLevel ?? 3) < 3) {
      expect((await t.as(DIRECTOR).post(`${API}/journal-entries/${entry.id}/approve`).send({}).expect(403)).body.code).toBe('approval_limit');
    }
    const approver = approverFor(entry.requiredLevel);
    await t.stepUp(approver); // the total is above the "confirm again" amount
    await t.as(approver).post(`${API}/journal-entries/${entry.id}/approve`).send({}).expect(200);
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: entry.id } })).status).toBe('posted');
    expect((await t.as(FINANCE).get(`${API}/payroll/runs/${runId}`).expect(200)).body.salaryEntry.status).toBe('posted');

    // payslips: each person sees their own, nobody else's
    const mine = (await t.as(DEV1).get(`${API}/payslips/me/${MONTH}`).expect(200)).body;
    const lines = (await t.as(FINANCE).get(`${API}/payroll/runs/${runId}/lines`).expect(200)).body.lines;
    expect(mine.net).toBe(lines.find((l: { empId: string }) => l.empId === DEV1).net);
    await t.as(DEV2).get(`${API}/payslips/${mine.id}`).expect(404);
  });

  it('M8 -> M9: the payment is recorded through its own ledger entry; salary payable returns to zero', async () => {
    const future = await t.as(FINANCE).post(`${API}/payroll/runs/${runId}/mark-paid`).send({ bankAccountId: bankId, paidOn: '2027-03-02' }).expect(400);
    expect(future.body.code).toBe('invalid_date'); // a transfer cannot be dated in the future
    const paid = (await t.as(FINANCE).post(`${API}/payroll/runs/${runId}/mark-paid`).send({ bankAccountId: bankId, paidOn: '2027-03-01' }).expect(200)).body;
    expect(paid.paymentEntry.status).toBe('pending_approval');
    expect((await t.as(FINANCE).post(`${API}/payroll/runs/${runId}/mark-paid`).send({ bankAccountId: bankId, paidOn: '2027-03-01' }).expect(409)).body.code).toBe('already_paid');
    const payment = await prisma.journalEntry.findFirstOrThrow({ where: { source: 'payroll_payment', sourceRef: runId } });
    const approver = approverFor(payment.requiredLevel);
    await t.stepUp(approver);
    await t.as(approver).post(`${API}/journal-entries/${payment.id}/approve`).send({}).expect(200);

    const posted = await prisma.journalLine.findMany({ where: { entry: { status: 'posted' } }, include: { account: true } });
    const balance = (pick: (code: string, role: string | null) => boolean) =>
      sum(posted.filter((l) => pick(l.account.code, l.account.systemRole)).map((l) => dec(l.debit).minus(l.credit)));
    expect(balance((_c, role) => role === 'salary_payable').toFixed(2)).toBe('0.00');
    expect(balance((code) => code === '1100').toFixed(2)).toBe(dec(totals.net).negated().toFixed(2));
    expect(balance((_c, role) => role === 'tax_payable').toFixed(2)).toBe(dec(totals.tax).negated().toFixed(2));
  });

  it('M9: Finance closes February, the CEO approves, and nothing more can be posted into it', async () => {
    const asked = await t.as(FINANCE).post(`${API}/periods/${MONTH}/close`);
    expect(asked.status, JSON.stringify(asked.body)).toBe(200);
    await t.as(FINANCE).post(`${API}/periods/${MONTH}/approve-close`).expect(404); // not the person who ran it, and not their duty
    expect((await t.as(CEO).post(`${API}/periods/${MONTH}/approve-close`).expect(200)).body.status).toBe('closed');

    const accounts = Object.fromEntries((await prisma.ledgerAccount.findMany()).map((a) => [a.code, a.id]));
    const late = await t.as(FINANCE).post(`${API}/journal-entries`).send({ date: '2027-02-20', description: 'Late office bill', lines: [{ accountId: accounts['5200'], debit: '10' }, { accountId: accounts['1100'], credit: '10' }] });
    expect(late.status).toBe(409);
    expect(late.body.code).toBe('period_closed');
  });

  it('the database itself refuses to unlock, reopen or post around the workflow', async () => {
    // the payroll lock of February cannot be removed or changed
    await expect(prisma.attendancePeriod.delete({ where: { month: MONTH } })).rejects.toThrow(/period_locked/);
    await expect(prisma.attendancePeriod.update({ where: { month: MONTH }, data: { lockedAt: new Date() } })).rejects.toThrow(/period_locked/);
    // a closed month is not reopened by a direct update (only with a "reopened" event, which the API writes)
    await expect(prisma.financePeriod.update({ where: { month: MONTH }, data: { status: 'open' } })).rejects.toThrow(/approval workflow/);
    expect((await prisma.financePeriod.findUniqueOrThrow({ where: { month: MONTH } })).status).toBe('closed');
    // an entry is never written as posted, and never skips "pending approval"
    const maker = (await prisma.employee.findUniqueOrThrow({ where: { empId: FINANCE } })).id;
    await expect(prisma.journalEntry.create({ data: { entryDate: new Date('2027-03-03'), description: 'Direct posted', makerId: maker, status: 'posted' } })).rejects.toThrow(/starts as a draft/);
    const draft = await prisma.journalEntry.create({ data: { entryDate: new Date('2027-03-03'), description: 'Direct draft', makerId: maker } });
    await expect(prisma.journalEntry.update({ where: { id: draft.id }, data: { status: 'posted', approvedBy: maker } })).rejects.toThrow(/cannot go from draft to posted/);
    // the reviewer of the run can never also be its approver
    const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: runId } });
    expect(run.reviewedBy).not.toBe(run.approvedBy);
  });

  it('no salary figure or bank number reached the audit log or the outbox', async () => {
    const audit = JSON.stringify(await prisma.auditLog.findMany({ select: { action: true, details: true, reason: true } }));
    const outbox = JSON.stringify(await prisma.outboxEvent.findMany({ select: { type: true, payload: true } }));
    for (const secret of [DEV1_ACCOUNT, DEV2_ACCOUNT, DEV1_ACCOUNT.slice(-8), totals.gross, totals.net, '59900.00', '100000.00']) {
      expect(audit, `audit log contains ${secret}`).not.toContain(secret);
      expect(outbox, `outbox contains ${secret}`).not.toContain(secret);
    }
    const types = new Set((await prisma.outboxEvent.findMany({ select: { type: true } })).map((e) => e.type));
    for (const type of ['leave.requested', 'leave.decided', 'payroll.run.ready', 'payroll.run.approved', 'payslip.issued', 'ledger.entry.posted']) expect(types).toContain(type);
  });
});
