import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttendancePayrollPort } from '../src/attendance/attendance-payroll.port';
import { LedgerPostingPort } from '../src/finance/ledger-posting.port';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';
import { API, entryRows, FakeAttendance, FakeLedger, setPay, TEST_SLABS } from './m8-support';

/**
 * Module 8 salary advances (plan section 12): paid out through a Module 9 entry that waits for ledger approval; repaid
 * automatically by each approved run once that payout entry is posted, min(monthly deduction, remaining) per month.
 */
const DIRECTOR = 'ACV-0003';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const FINANCE = 'ACV-0010';
let CEO = '';

let t: TestApp;
let prisma: PrismaClient;
let ledger: FakeLedger;
let advanceId = '';

const as = (who: string) => t.as(who);
const advance = (over: Record<string, unknown> = {}) => ({
  empId: DEV2, amount: '6000.00', monthlyDeduction: '4000.00', startMonth: '2026-10', reason: 'Medical emergency at home', bankAccountId: ledger.bank.id, ...over,
});

async function calculate(month: string): Promise<{ id: string; lines: Array<Record<string, string>> }> {
  const existing = await prisma.payrollRun.findUnique({ where: { month } });
  const id = existing?.id ?? (await as(FINANCE).post(`${API}/payroll/runs`).send({ month }).expect(201)).body.id;
  await as(FINANCE).post(`${API}/payroll/runs/${id}/calculate`).expect(200);
  return { id, lines: (await as(FINANCE).get(`${API}/payroll/runs/${id}/lines`).expect(200)).body.lines };
}

async function approve(id: string): Promise<void> {
  await as(FINANCE).post(`${API}/payroll/runs/${id}/prepare`).expect(200);
  await as(DIRECTOR).post(`${API}/payroll/runs/${id}/review`).expect(200);
  await t.stepUp(CEO);
  await as(CEO).post(`${API}/payroll/runs/${id}/approve`).expect(200);
}

beforeAll(async () => {
  prisma = createTestPrisma();
  ledger = new FakeLedger();
  t = await createTestApp({ overrides: [{ provide: AttendancePayrollPort, useValue: new FakeAttendance(prisma) }, { provide: LedgerPostingPort, useValue: ledger }] });
  await t.signInAll();
  CEO = t.fixtures.CEO;
  await setPay(t, prisma, DEV1, { base: '100000' });
  await setPay(t, prisma, DEV2, { base: '60000' });
  await as(DIRECTOR).post(`${API}/settings/tax-slabs`).send(TEST_SLABS).expect(201);
}, 120000);

afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M8 recording a salary advance', () => {
  it('only Finance records one, with a valid bank account and a deduction not above the advance', async () => {
    await as(DIRECTOR).post(`${API}/payroll/advances`).send(advance()).expect(404);
    await as(DEV2).post(`${API}/payroll/advances`).send(advance()).expect(404);
    expect((await as(FINANCE).post(`${API}/payroll/advances`).send(advance({ bankAccountId: randomUUID() })).expect(400)).body.code).toBe('invalid_bank_account');
    await as(FINANCE).post(`${API}/payroll/advances`).send(advance({ monthlyDeduction: '7000.00' })).expect(400);
    await as(FINANCE).post(`${API}/payroll/advances`).send(advance({ amount: '-5' })).expect(400);
    await as(FINANCE).post(`${API}/payroll/advances`).send(advance({ empId: 'ACV-9999' })).expect(404);
    expect(await prisma.salaryAdvance.count()).toBe(0);
  });

  it('creates it waiting for payout, with a payout entry (Dr employee advances / Cr bank) that waits for ledger approval', async () => {
    const res = (await as(FINANCE).post(`${API}/payroll/advances`).send(advance()).expect(201)).body;
    advanceId = res.id;
    expect(res).toMatchObject({ empId: DEV2, amount: '6000.00', monthlyDeduction: '4000.00', remaining: '6000.00', status: 'pending_payout', payoutEntry: { status: 'pending_approval' }, createdBy: FINANCE });
    const [entry] = ledger.bySource('advance', advanceId);
    expect(entry.input.purpose).toBe('payout');
    expect(entryRows(entry)).toEqual([
      ['Dr', 'employee_advances', '6000.00'],
      ['Cr', ledger.bank.id, '6000.00'],
    ]);
    const finance = await prisma.employee.findUniqueOrThrow({ where: { empId: FINANCE } });
    expect(entry.input.makerId).toBe(finance.id);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'payroll.advance.created' } });
    expect(JSON.stringify(audit.details)).not.toContain('6000');
  });

  it('the employee sees their own advance; others do not', async () => {
    expect((await as(DEV2).get(`${API}/payroll/advances/me`).expect(200)).body.map((a: { id: string }) => a.id)).toEqual([advanceId]);
    expect((await as(DEV1).get(`${API}/payroll/advances/me`).expect(200)).body).toEqual([]);
    expect((await as(FINANCE).get(`${API}/payroll/advances?empId=${DEV2}`).expect(200)).body).toHaveLength(1);
  });
});

describe('M8 repaying an advance through payroll', () => {
  it('deducts nothing while the payout entry is not posted', async () => {
    const { lines } = await calculate('2026-10');
    expect(lines.find((l) => l.empId === DEV2)).toMatchObject({ advanceDeduction: '0.00', net: '59900.00' });
  });

  it('deducts min(monthly deduction, remaining) once the payout entry is posted', async () => {
    ledger.setStatus(ledger.bySource('advance', advanceId)[0].id, 'posted');
    const { id, lines } = await calculate('2026-10');
    expect(lines.find((l) => l.empId === DEV2)).toMatchObject({ advanceDeduction: '4000.00', net: '55900.00' });
    expect((await prisma.salaryAdvance.findUniqueOrThrow({ where: { id: advanceId } })).status).toBe('active');
    await approve(id);
    const [salary] = ledger.bySource('payroll', id);
    expect(entryRows(salary)).toContainEqual(['Cr', 'employee_advances', '4000.00']);
    const repayments = await prisma.advanceRepayment.findMany({ where: { advanceId } });
    expect(repayments.map((r) => r.amount.toFixed(2))).toEqual(['4000.00']);
    expect((await as(FINANCE).get(`${API}/payroll/advances`).expect(200)).body[0]).toMatchObject({ repaid: '4000.00', remaining: '2000.00', status: 'active' });
    await expect(prisma.advanceRepayment.update({ where: { id: repayments[0].id }, data: { amount: '1.00' } })).rejects.toThrow(); // insert-only
  });

  it('takes only what remains in the last month and marks the advance repaid', async () => {
    const { id, lines } = await calculate('2026-11');
    expect(lines.find((l) => l.empId === DEV2)).toMatchObject({ advanceDeduction: '2000.00', net: '57900.00' });
    await approve(id);
    expect((await as(DEV2).get(`${API}/payroll/advances/me`).expect(200)).body[0]).toMatchObject({ repaid: '6000.00', remaining: '0.00', status: 'repaid' });
  });

  it('a rejected payout is cancelled and an advance starting later is not deducted yet', async () => {
    const rejected = (await as(FINANCE).post(`${API}/payroll/advances`).send(advance({ empId: DEV1, amount: '3000', monthlyDeduction: '1000' })).expect(201)).body;
    ledger.setStatus(ledger.bySource('advance', rejected.id)[0].id, 'rejected');
    const later = (await as(FINANCE).post(`${API}/payroll/advances`).send(advance({ empId: DEV1, amount: '3000', monthlyDeduction: '1000', startMonth: '2027-01' })).expect(201)).body;
    ledger.setStatus(ledger.bySource('advance', later.id)[0].id, 'posted');
    const list = (await as(FINANCE).get(`${API}/payroll/advances?empId=${DEV1}`).expect(200)).body;
    expect(Object.fromEntries(list.map((a: { id: string; status: string }) => [a.id, a.status]))).toEqual({ [rejected.id]: 'cancelled', [later.id]: 'active' });
    const sept = await calculate('2026-09');
    expect(sept.lines.find((l) => l.empId === DEV1)).toMatchObject({ advanceDeduction: '0.00' });
  });
});
