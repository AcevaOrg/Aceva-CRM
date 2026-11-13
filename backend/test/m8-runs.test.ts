import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttendancePayrollPort } from '../src/attendance/attendance-payroll.port';
import { LedgerPostingPort } from '../src/finance/ledger-posting.port';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './helpers/app';
import { createEmployee } from './helpers/people';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';
import { API, entryRows, FakeAttendance, FakeLedger, setPay, TEST_SLABS } from './m8-support';

/**
 * Module 8 payroll runs against FAKE Module 7 and Module 9 ports (plan section 12): calculation, the
 * prepare -> review -> approve chain with maker-checker and confirm-again, approval effects, immutability, adjustments,
 * final settlements, payment and the bank sheet.
 */
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const FINANCE = 'ACV-0010';
let CEO = '';
let LEAVER = '';
let JOINER = '';
const DEV1_ACCOUNT = 'PK11HABB0000000000001234';

let t: TestApp;
let prisma: PrismaClient;
let attendance: FakeAttendance;
let ledger: FakeLedger;
let october = '';

const as = (who: string) => t.as(who);
const act = (who: string, runId: string, action: string, body: Record<string, unknown> = {}) => as(who).post(`${API}/payroll/runs/${runId}/${action}`).send(body);

beforeAll(async () => {
  prisma = createTestPrisma();
  attendance = new FakeAttendance(prisma);
  ledger = new FakeLedger();
  t = await createTestApp({ overrides: [{ provide: AttendancePayrollPort, useValue: attendance }, { provide: LedgerPostingPort, useValue: ledger }] });
  await t.signInAll();
  CEO = t.fixtures.CEO;

  await setPay(t, prisma, DEV1, { base: '100000', allowances: '10000', bank: 'HBL', account: DEV1_ACCOUNT });
  await setPay(t, prisma, DEV2, { base: '60000', account: 'PK22MEZN0000000000005678' });
  await setPay(t, prisma, FINANCE, { base: '80000', allowances: '5000', account: 'PK33UNIL0000000000009012' });

  // A leaver (last working day 20 October, final settlement asked for twice by Module 3) and a joiner (15 October).
  const leaver = await createEmployee(prisma, { name: 'Test Leaver' });
  LEAVER = leaver.empId;
  await prisma.employee.update({ where: { id: leaver.id }, data: { status: 'left', lastWorkingDay: new Date('2026-10-20') } });
  await setPay(t, prisma, LEAVER, { base: '50000' });
  const joiner = await createEmployee(prisma, { name: 'Test Joiner' });
  JOINER = joiner.empId;
  await prisma.employee.update({ where: { id: joiner.id }, data: { joiningDate: new Date('2026-10-15') } });
  await setPay(t, prisma, JOINER, { base: '40000' });
  for (let i = 0; i < 2; i++) {
    await prisma.outboxEvent.create({ data: { id: randomUUID(), type: 'payroll.final_settlement.requested', version: 1, actor: 'system', payload: { empId: LEAVER, lastWorkingDay: '2026-10-20' } } });
  }
  attendance.unpaid['2026-10'] = { [DEV1]: '1.5' };
}, 120000);

afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M8 tax slabs (Settings)', () => {
  it('refuses a run calculation while no slab version is in force for the month', async () => {
    const run = (await as(FINANCE).post(`${API}/payroll/runs`).send({ month: '2026-06' }).expect(201)).body;
    expect(run).toMatchObject({ number: 'PR-2026-06', stage: 'draft' });
    const res = await act(FINANCE, run.id, 'calculate').expect(409);
    expect(res.body.code).toBe('tax_slabs_missing');
    expect(attendance.locked.has('2026-06')).toBe(false); // nothing was locked either
  });

  it('only settings.manage enters a new version; it is validated and audited', async () => {
    await as(FINANCE).post(`${API}/settings/tax-slabs`).send(TEST_SLABS).expect(403);
    const gap = { ...TEST_SLABS, slabs: [{ from: '0', to: '600000', fixed: '0', rate: '0' }, { from: '700000', to: null, fixed: '0', rate: '0.1' }] };
    await as(DIRECTOR).post(`${API}/settings/tax-slabs`).send(gap).expect(400);
    await as(DIRECTOR).post(`${API}/settings/tax-slabs`).send({ ...TEST_SLABS, slabs: [{ from: '0', to: null, fixed: '0', rate: '1.5' }] }).expect(400);
    const res = await as(DIRECTOR).post(`${API}/settings/tax-slabs`).send(TEST_SLABS).expect(201);
    expect(res.body.current.slabs).toHaveLength(6);
    expect(res.body.current.slabs[2]).toEqual({ from: '1200000.00', to: '2200000.00', fixed: '6000.00', rate: '0.1100' });
    expect(await prisma.auditLog.count({ where: { action: 'payroll.tax_slabs.created' } })).toBe(1);
    // payroll.view (Finance) and settings.view (the CTO) may read them; a developer may not
    await as(FINANCE).get(`${API}/settings/tax-slabs`).expect(200);
    await as(CTO).get(`${API}/settings/tax-slabs`).expect(200);
    await as(DEV1).get(`${API}/settings/tax-slabs`).expect(403);
  });
});

describe('M8 calculating a run', () => {
  it('starts one run per month, for this month or earlier only', async () => {
    const run = (await as(FINANCE).post(`${API}/payroll/runs`).send({ month: '2026-10' }).expect(201)).body;
    october = run.id;
    expect((await as(FINANCE).post(`${API}/payroll/runs`).send({ month: '2026-10' }).expect(409)).body.code).toBe('run_exists');
    expect((await as(FINANCE).post(`${API}/payroll/runs`).send({ month: '2030-01' }).expect(400)).body.code).toBe('future_month');
    await as(FINANCE).post(`${API}/payroll/runs`).send({ month: '2026-13' }).expect(400);
  });

  it('cannot be prepared before it is calculated', async () => {
    expect((await act(FINANCE, october, 'prepare').expect(409)).body.code).toBe('invalid_transition');
  });

  it('adds bonus and deduction lines for people in the run only, with a positive amount', async () => {
    await as(FINANCE).post(`${API}/payroll/runs/${october}/items`).send({ empId: DEV1, kind: 'bonus', label: 'Project bonus', amount: '5000.00' }).expect(201);
    await as(FINANCE).post(`${API}/payroll/runs/${october}/items`).send({ empId: DEV1, kind: 'deduction', label: 'Laptop damage', amount: '1000' }).expect(201);
    expect((await as(FINANCE).post(`${API}/payroll/runs/${october}/items`).send({ empId: 'ACV-0008', kind: 'bonus', label: 'No pay on file', amount: '10' }).expect(409)).body.code).toBe('not_in_run');
    await as(FINANCE).post(`${API}/payroll/runs/${october}/items`).send({ empId: DEV1, kind: 'bonus', label: 'Zero', amount: '0' }).expect(400);
    await as(FINANCE).post(`${API}/payroll/runs/${october}/items`).send({ empId: DEV1, kind: 'bonus', label: 'Float', amount: 12.5 }).expect(400);
  });

  it('locks the month through Module 7, takes the final settlement event once, and calculates exact salaries', async () => {
    const res = await act(FINANCE, october, 'calculate').expect(200);
    expect(res.body).toMatchObject({ stage: 'calculated', workingDays: 22, headcount: 5 });
    expect(res.body.totals).toEqual({ gross: '343181.82', tax: '1850.00', advanceDeductions: '0.00', otherDeductions: '1000.00', deductions: '2850.00', net: '340331.82' });
    expect(res.body.taxSlabSet.label).toBe(TEST_SLABS.label);
    expect(res.body.missingPay.map((p: { empId: string }) => p.empId)).toContain('ACV-0008');
    expect(attendance.lockCalls.filter((c) => c.month === '2026-10')).toHaveLength(1);

    const settlements = await prisma.finalSettlement.findMany({ where: { employee: { empId: LEAVER } } });
    expect(settlements).toHaveLength(1); // two events, one settlement
    expect(await prisma.outboxEvent.count({ where: { type: 'payroll.final_settlement.requested', processedAt: null } })).toBe(0);

    const lines = (await as(FINANCE).get(`${API}/payroll/runs/${october}/lines`).expect(200)).body.lines;
    const by = (empId: string) => lines.find((l: { empId: string }) => l.empId === empId);
    expect(by(DEV1)).toMatchObject({
      base: '100000.00', allowances: '10000.00', bonus: '5000.00', unpaidDays: '1.5', unpaidDeduction: '6818.18', gross: '108181.82',
      taxableIncome: '108181.82', tax: '1400.00', advanceDeduction: '0.00', otherDeductions: '1000.00', net: '105781.82', workingDays: 22,
    });
    expect(by(DEV1).items.map((i: { label: string; source: string }) => [i.label, i.source])).toEqual([['Project bonus', 'manual'], ['Laptop damage', 'manual']]);
    expect(by(DEV2)).toMatchObject({ gross: '60000.00', tax: '100.00', net: '59900.00', flags: [] });
    expect(by(FINANCE)).toMatchObject({ gross: '85000.00', tax: '350.00', net: '84650.00' });
    expect(by(LEAVER)).toMatchObject({ net: '50000.00', flags: ['left_mid_month', 'final_settlement'] }); // full base, no pro-rata (D11)
    expect(by(JOINER)).toMatchObject({ net: '40000.00', flags: ['joined_mid_month'] });
    expect(by('ACV-0008')).toBeUndefined(); // no pay on file
    expect(await prisma.auditLog.count({ where: { action: 'payroll.run.viewed', targetId: 'PR-2026-10' } })).toBe(1);
  });

  it('refuses a negative net, naming the person, and keeps nothing of the change', async () => {
    const res = await as(FINANCE).post(`${API}/payroll/runs/${october}/items`).send({ empId: DEV2, kind: 'deduction', label: 'Too much', amount: '90000' }).expect(409);
    expect(res.body).toMatchObject({ code: 'negative_net', empId: DEV2 });
    expect(await prisma.payrollItem.count({ where: { label: 'Too much' } })).toBe(0);
    const run = (await as(FINANCE).get(`${API}/payroll/runs/${october}`).expect(200)).body;
    expect(run.totals.net).toBe('340331.82');
  });

  it('recalculates a calculated run at once when a line is removed or added', async () => {
    const item = (await as(FINANCE).post(`${API}/payroll/runs/${october}/items`).send({ empId: DEV2, kind: 'bonus', label: 'Spot bonus', amount: '100.00' }).expect(201)).body;
    expect((await as(FINANCE).get(`${API}/payroll/runs/${october}`)).body.totals.gross).toBe('343281.82');
    await as(FINANCE).delete(`${API}/payroll/runs/${october}/items/${item.id}`).expect(204);
    expect((await as(FINANCE).get(`${API}/payroll/runs/${october}`)).body.totals.gross).toBe('343181.82');
  });
});

describe('M8 prepare, review and approve (maker-checker and confirm-again)', () => {
  it('only Finance prepares; the Director reviews; nobody else can act (404 for non-finance people)', async () => {
    await act(DIRECTOR, october, 'prepare').expect(404); // no payroll.prepare
    await act(DEV1, october, 'prepare').expect(404);
    const prepared = (await act(FINANCE, october, 'prepare').expect(200)).body;
    expect(prepared).toMatchObject({ stage: 'prepared', preparedBy: { empId: FINANCE }, next: { action: 'review' } });
    expect((await act(FINANCE, october, 'prepare').expect(409)).body.code).toBe('invalid_transition'); // twice
    expect((await act(FINANCE, october, 'calculate').expect(409)).body.code).toBe('invalid_transition'); // no recalculation once prepared
    expect((await as(FINANCE).post(`${API}/payroll/runs/${october}/items`).send({ empId: DEV1, kind: 'bonus', label: 'Late', amount: '1' }).expect(409)).body.code).toBe('invalid_transition');
    await act(FINANCE, october, 'review').expect(404); // Finance has no payroll.review
    await act(CEO, october, 'review').expect(404); // nor the CEO
    expect((await act(CEO, october, 'approve').expect(409)).body.code).toBe('invalid_transition'); // not reviewed yet
  });

  it('the database refuses line changes once prepared', async () => {
    await expect(prisma.payrollLine.updateMany({ where: { runId: october }, data: { net: '1.00' } })).rejects.toThrow(/cannot change once the run is prepared/);
  });

  it('the Director reviews; the Director can never approve', async () => {
    const reviewed = (await act(DIRECTOR, october, 'review').expect(200)).body;
    expect(reviewed).toMatchObject({ stage: 'reviewed', reviewedBy: { empId: DIRECTOR }, next: { action: 'approve' } });
    expect((await act(DIRECTOR, october, 'review').expect(409)).body.code).toBe('invalid_transition');
    await act(DIRECTOR, october, 'approve').expect(404); // no payroll.approve
    expect(await prisma.outboxEvent.count({ where: { type: 'payroll.run.ready' } })).toBe(2);
  });

  it('the CEO approves only after confirming again', async () => {
    const refused = await act(CEO, october, 'approve').expect(403);
    expect(refused.body.code).toBe('step_up_required');
    expect(await prisma.payslip.count()).toBe(0);
    await t.stepUp(CEO);
    const approved = (await act(CEO, october, 'approve').expect(200)).body;
    expect(approved).toMatchObject({ stage: 'approved', approvedBy: { empId: CEO }, salaryEntry: { status: 'pending_approval' }, next: { action: 'mark_paid' } });
    expect((await act(CEO, october, 'approve').expect(409)).body.code).toBe('invalid_transition'); // no double approval
  });

  it('approval creates the salary entry exactly once, balanced, made by the preparer, waiting for ledger approval', async () => {
    const entries = ledger.bySource('payroll', october);
    expect(entries).toHaveLength(1);
    const e = entries[0];
    expect(e.input).toMatchObject({ purpose: 'salary', entryDate: '2026-10-31' });
    const finance = await prisma.employee.findUniqueOrThrow({ where: { empId: FINANCE } });
    expect(e.input.makerId).toBe(finance.id);
    expect(entryRows(e)).toEqual([
      ['Dr', 'salary_expense', '343181.82'],
      ['Cr', 'tax_payable', '1850.00'],
      ['Cr', 'payroll_deductions', '1000.00'],
      ['Cr', 'salary_payable', '340331.82'],
    ]);
    const run = await prisma.payrollRun.findUniqueOrThrow({ where: { id: october } });
    expect(run.journalEntryId).toBe(e.id);
    expect((await as(FINANCE).get(`${API}/payroll/runs/${october}`)).body.salaryEntry).toEqual({ number: e.number, status: 'pending_approval' });
  });

  it('issues one payslip per line, settles the final settlement and writes the events (Emp-IDs only)', async () => {
    expect(await prisma.payslip.count({ where: { runId: october } })).toBe(5);
    const settlement = await prisma.finalSettlement.findFirstOrThrow({ where: { employee: { empId: LEAVER } } });
    expect(settlement.runId).toBe(october);
    expect(settlement.settledAt).not.toBeNull();
    expect(await prisma.outboxEvent.count({ where: { type: 'payroll.run.approved' } })).toBe(1);
    const issued = await prisma.outboxEvent.findMany({ where: { type: 'payslip.issued' } });
    expect(issued.map((e) => (e.payload as { empId: string }).empId).sort()).toEqual([DEV1, DEV2, FINANCE, LEAVER, JOINER].sort());
  });

  it('an approved run never changes, even directly in the database', async () => {
    await expect(prisma.payrollRun.update({ where: { id: october }, data: { workingDays: 5 } })).rejects.toThrow(/approved payroll run cannot be changed/);
    await expect(prisma.payrollRun.delete({ where: { id: october } })).rejects.toThrow(/never deleted/);
    await expect(prisma.payslip.updateMany({ where: { runId: october }, data: { month: '2026-09' } })).rejects.toThrow();
    expect((await act(FINANCE, october, 'calculate').expect(409)).body.code).toBe('invalid_transition');
  });
});

describe('M8 sending back, and maker-checker when one person holds two duties', () => {
  let september = '';
  let directorDuty = '';
  let ceoDuty = '';

  beforeAll(async () => {
    const duty = await prisma.duty.findUniqueOrThrow({ where: { key: 'finance' } });
    const director = await prisma.employee.findUniqueOrThrow({ where: { empId: DIRECTOR } });
    const ceo = await prisma.employee.findUniqueOrThrow({ where: { empId: CEO } });
    directorDuty = (await prisma.employeeDuty.create({ data: { employeeId: director.id, dutyId: duty.id, reason: 'Test: Director also on finance duty' } })).id;
    ceoDuty = (await prisma.employeeDuty.create({ data: { employeeId: ceo.id, dutyId: duty.id, reason: 'Test: CEO also on finance duty' } })).id;
    september = (await as(FINANCE).post(`${API}/payroll/runs`).send({ month: '2026-09' }).expect(201)).body.id;
    await act(FINANCE, september, 'calculate').expect(200);
  });
  afterAll(async () => {
    await prisma.employeeDuty.updateMany({ where: { id: { in: [directorDuty, ceoDuty] } }, data: { endedAt: new Date() } });
  });

  it('the person who prepared a run cannot review it (API and database)', async () => {
    await act(DIRECTOR, september, 'prepare').expect(200);
    expect((await act(DIRECTOR, september, 'review').expect(403)).body.code).toBe('maker_checker');
    const director = await prisma.employee.findUniqueOrThrow({ where: { empId: DIRECTOR } });
    await expect(prisma.payrollRun.update({ where: { id: september }, data: { stage: 'reviewed', reviewedBy: director.id } })).rejects.toThrow(/maker_checker|check constraint/i);
  });

  it('a run can be sent back with a reason (validated), then recalculated', async () => {
    await act(FINANCE, september, 'return', { reason: 'no' }).expect(400);
    await act(FINANCE, september, 'return', { reason: 'Wrong month' }).expect(403); // Finance neither reviews nor approves
    const back = (await act(CEO, september, 'return', { reason: 'Please check the bonus lines' }).expect(200)).body;
    expect(back).toMatchObject({ stage: 'calculated', returnedNote: 'Please check the bonus lines', preparedBy: null });
    expect((await act(CEO, september, 'return', { reason: 'Again please' }).expect(409)).body.code).toBe('invalid_transition');
    await act(FINANCE, september, 'calculate').expect(200);
  });

  it('the person who prepared a run cannot approve it', async () => {
    await act(CEO, september, 'prepare').expect(200);
    await act(DIRECTOR, september, 'review').expect(200);
    await t.stepUp(CEO);
    expect((await act(CEO, september, 'approve').expect(403)).body.code).toBe('maker_checker');
    expect((await prisma.payrollRun.findUniqueOrThrow({ where: { id: september } })).stage).toBe('reviewed');
  });
});

describe('M8 after approval: adjustments, payment, bank sheet', () => {
  let november = '';

  it('a mistake is fixed through a later month, never earlier, never for a run not approved', async () => {
    const base = { empId: DEV2, originRunId: october, kind: 'bonus', amount: '2500.00', reason: 'Overtime missed in October' };
    expect((await as(FINANCE).post(`${API}/payroll/adjustments`).send({ ...base, targetMonth: '2026-10' }).expect(400)).body.code).toBe('invalid_target_month');
    const september = await prisma.payrollRun.findUniqueOrThrow({ where: { month: '2026-09' } });
    expect((await as(FINANCE).post(`${API}/payroll/adjustments`).send({ ...base, originRunId: september.id, targetMonth: '2026-11' }).expect(409)).body.code).toBe('run_not_approved');
    expect((await as(FINANCE).post(`${API}/payroll/adjustments`).send({ ...base, empId: 'ACV-0008', targetMonth: '2026-11' }).expect(400)).body.code).toBe('not_in_run');
    await as(DIRECTOR).post(`${API}/payroll/adjustments`).send({ ...base, targetMonth: '2026-11' }).expect(404); // no payroll.prepare
    const adj = (await as(FINANCE).post(`${API}/payroll/adjustments`).send({ ...base, targetMonth: '2026-11' }).expect(201)).body;
    expect(adj).toMatchObject({ empId: DEV2, originRunNumber: 'PR-2026-10', targetMonth: '2026-11', amount: '2500.00', applied: false });
    await expect(prisma.payrollAdjustment.update({ where: { id: adj.id }, data: { amount: '1.00' } })).rejects.toThrow(); // insert-only
  });

  it('the adjustment lands in the next run as a bonus line', async () => {
    november = (await as(FINANCE).post(`${API}/payroll/runs`).send({ month: '2026-11' }).expect(201)).body.id;
    const run = (await act(FINANCE, november, 'calculate').expect(200)).body;
    expect(run.pendingAdjustments).toBe(0);
    const lines = (await as(FINANCE).get(`${API}/payroll/runs/${november}/lines`)).body.lines;
    const dev2 = lines.find((l: { empId: string }) => l.empId === DEV2);
    expect(dev2).toMatchObject({ bonus: '2500.00', gross: '62500.00', tax: '125.00', net: '62375.00', lastMonthNet: '59900.00' });
    expect(dev2.items[0]).toMatchObject({ source: 'adjustment', kind: 'bonus', amount: '2500.00' });
    expect(lines.find((l: { empId: string }) => l.empId === LEAVER)).toBeUndefined(); // left in October
    expect((await as(FINANCE).get(`${API}/payroll/adjustments?month=2026-11`)).body[0].applied).toBe(true);
    // an adjustment line is not removed by hand
    expect((await as(FINANCE).delete(`${API}/payroll/runs/${november}/items/${dev2.items[0].id}`).expect(409)).body.code).toBe('adjustment_item');
  });

  it('records the bank transfer once, through a payment entry that clears salary payable', async () => {
    expect((await act(FINANCE, november, 'mark-paid', { bankAccountId: ledger.bank.id, paidOn: '2026-11-05' }).expect(409)).body.code).toBe('invalid_transition'); // not approved
    expect((await act(FINANCE, october, 'mark-paid', { bankAccountId: randomUUID(), paidOn: '2026-11-05' }).expect(400)).body.code).toBe('invalid_bank_account');
    await act(FINANCE, october, 'mark-paid', { bankAccountId: ledger.bank.id, paidOn: '05-11-2026' }).expect(400);
    await act(DIRECTOR, october, 'mark-paid', { bankAccountId: ledger.bank.id, paidOn: '2026-11-05' }).expect(404);
    const paid = (await act(FINANCE, october, 'mark-paid', { bankAccountId: ledger.bank.id, paidOn: '2026-11-05' }).expect(200)).body;
    expect(paid).toMatchObject({ paid: true, stage: 'approved', paymentEntry: { status: 'pending_approval' }, next: { action: null } });
    const payment = ledger.bySource('payroll_payment', october);
    expect(payment).toHaveLength(1);
    expect(payment[0].input).toMatchObject({ purpose: 'payment', entryDate: '2026-11-05' });
    expect(entryRows(payment[0])).toEqual([
      ['Dr', 'salary_payable', '340331.82'],
      ['Cr', ledger.bank.id, '340331.82'],
    ]);
    expect((await act(FINANCE, october, 'mark-paid', { bankAccountId: ledger.bank.id, paidOn: '2026-11-06' }).expect(409)).body.code).toBe('already_paid');
    // the database allows the payment record once and never again
    await expect(prisma.payrollRun.update({ where: { id: october }, data: { paymentEntryId: randomUUID() } })).rejects.toThrow(/approved payroll run cannot be changed/);
  });

  it('the bank sheet needs payroll.export and confirm-again, only for approved runs, and is audited without numbers', async () => {
    await as(FINANCE).get(`${API}/payroll/runs/${october}/bank-sheet`).expect(404); // Finance has no payroll.export
    t.clock.advance(6 * 60_000); // any earlier confirmation has expired
    expect((await as(DIRECTOR).get(`${API}/payroll/runs/${october}/bank-sheet`).expect(403)).body.code).toBe('step_up_required');
    await t.stepUp(DIRECTOR);
    expect((await as(DIRECTOR).get(`${API}/payroll/runs/${november}/bank-sheet`).expect(409)).body.code).toBe('run_not_approved');
    const res = await as(DIRECTOR).get(`${API}/payroll/runs/${october}/bank-sheet`).expect(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.text.split('\r\n')[0]).toMatch(/^HIGHLY CONFIDENTIAL/);
    expect(res.text).toContain(`${DEV1},Fahad Khan,HBL,${DEV1_ACCOUNT},105781.82`);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'payroll.bank_sheet.exported' } });
    expect(audit.details).toEqual({ runNumber: 'PR-2026-10', rows: 5, format: 'csv' });
  });

  it('never writes salary amounts or bank numbers into the audit log or the payroll events', async () => {
    const audits = await prisma.auditLog.findMany({ where: { OR: [{ action: { startsWith: 'payroll.' } }, { targetType: 'payroll_run' }] } });
    expect(audits.length).toBeGreaterThan(10);
    const events = await prisma.outboxEvent.findMany({ where: { type: { in: ['payroll.run.ready', 'payroll.run.approved', 'payslip.issued'] } } });
    const text = JSON.stringify([audits.map((a) => [a.details, a.reason]), events.map((e) => e.payload)]);
    expect(text).not.toMatch(/\d+\.\d{2}\b/); // no amount like 105781.82
    for (const secret of [DEV1_ACCOUNT, '100000', '340331', '343181', '105781']) expect(text).not.toContain(secret);
    for (const e of events) expect(JSON.stringify(e.payload)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/); // Emp-IDs, never UUIDs
  });
});
