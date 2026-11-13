import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AttendancePayrollPort } from '../src/attendance/attendance-payroll.port';
import { LedgerPostingPort } from '../src/finance/ledger-posting.port';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';
import { API, FakeAttendance, FakeLedger, setPay, TEST_SLABS } from './m8-support';

/**
 * Module 8 access (plan section 16): payroll is highly confidential. Management screens answer 404 to anyone without the
 * permission (audited); payslips are own-only unless payroll.view (audited); the Owner views and exports but never approves.
 */
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const SALES1 = 'ACV-0009';
const FINANCE = 'ACV-0010';
let CEO = '';
let HR = '';
const DEV1_ACCOUNT = 'PK11HABB0000000000004321';

let t: TestApp;
let prisma: PrismaClient;
let october = '';
let dev1Slip = '';

const as = (who: string) => t.as(who);

async function approvedRun(month: string): Promise<string> {
  const id = (await as(FINANCE).post(`${API}/payroll/runs`).send({ month }).expect(201)).body.id;
  await as(FINANCE).post(`${API}/payroll/runs/${id}/calculate`).expect(200);
  await as(FINANCE).post(`${API}/payroll/runs/${id}/prepare`).expect(200);
  await as(DIRECTOR).post(`${API}/payroll/runs/${id}/review`).expect(200);
  await t.stepUp(CEO);
  await as(CEO).post(`${API}/payroll/runs/${id}/approve`).expect(200);
  return id;
}

beforeAll(async () => {
  prisma = createTestPrisma();
  t = await createTestApp({ overrides: [{ provide: AttendancePayrollPort, useValue: new FakeAttendance(prisma) }, { provide: LedgerPostingPort, useValue: new FakeLedger() }] });
  await t.signInAll();
  CEO = t.fixtures.CEO;
  HR = t.fixtures.HR;
  await setPay(t, prisma, DEV1, { base: '100000', allowances: '10000', bank: 'Meezan', account: DEV1_ACCOUNT });
  await setPay(t, prisma, DEV2, { base: '60000' });
  await as(DIRECTOR).post(`${API}/settings/tax-slabs`).send(TEST_SLABS).expect(201);
  await approvedRun('2026-09');
  october = await approvedRun('2026-10');
}, 180000);

afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M8 management screens are not found for people without payroll access', () => {
  it.each([[DEV1], [CTO], [SALES1], ['HR']])('%s gets 404 everywhere, and each refusal is audited', async (who) => {
    const empId = who === 'HR' ? HR : who;
    const before = await prisma.auditLog.count({ where: { action: 'access.denied', actor: { empId } } });
    const urls = [
      `${API}/payroll/runs`,
      `${API}/payroll/runs/${october}`,
      `${API}/payroll/runs/${october}/lines`,
      `${API}/payroll/runs/${october}/bank-sheet`,
      `${API}/payroll/advances`,
      `${API}/payroll/adjustments`,
      `${API}/payslips/employees/${DEV1}`,
    ];
    for (const url of urls) {
      const res = await as(empId).get(url).expect(404);
      expect(res.body.code).toBe('not_found');
    }
    await as(empId).post(`${API}/payroll/runs`).send({ month: '2026-11' }).expect(404);
    await as(empId).post(`${API}/payroll/runs/${october}/approve`).expect(404);
    expect(await prisma.auditLog.count({ where: { action: 'access.denied', actor: { empId } } })).toBe(before + urls.length + 2);
  });

  it('without a session it is 401, not a hint that the route exists', async () => {
    await t.anonymous().get(`${API}/payroll/runs`).expect(401);
  });

  it('the Owner views every run and may export, but never prepares or approves', async () => {
    expect((await as(OWNER).get(`${API}/payroll/runs`).expect(200)).body.map((r: { number: string }) => r.number)).toEqual(['PR-2026-10', 'PR-2026-09']);
    await as(OWNER).post(`${API}/payroll/runs`).send({ month: '2026-11' }).expect(404);
    await as(OWNER).post(`${API}/payroll/runs/${october}/approve`).expect(404);
    await t.stepUp(OWNER);
    const sheet = await as(OWNER).get(`${API}/payroll/runs/${october}/bank-sheet`).expect(200);
    expect(sheet.text).toContain(DEV1_ACCOUNT);
  });

  it('the run lines are a logged sensitive view', async () => {
    const before = await prisma.auditLog.count({ where: { action: 'payroll.run.viewed' } });
    await as(FINANCE).get(`${API}/payroll/runs/PR-2026-10/lines`).expect(200); // by number as well as id
    expect(await prisma.auditLog.count({ where: { action: 'payroll.run.viewed' } })).toBe(before + 1);
  });
});

describe('M8 payslips: own only, unless payroll.view (audited)', () => {
  it('an employee lists and opens their own payslips with year-to-date figures', async () => {
    const mine = (await as(DEV1).get(`${API}/payslips/me`).expect(200)).body;
    expect(mine.map((p: { month: string; net: string }) => [p.month, p.net])).toEqual([
      ['2026-10', '108400.00'],
      ['2026-09', '108400.00'],
    ]);
    dev1Slip = mine[0].id;
    const slip = (await as(DEV1).get(`${API}/payslips/me/2026-10`).expect(200)).body;
    expect(slip).toMatchObject({ empId: DEV1, month: '2026-10', runNumber: 'PR-2026-10', earnings: '110000.00', deductions: '1600.00', gross: '110000.00', tax: '1600.00', net: '108400.00', ytdNet: '216800.00', ytdTax: '3200.00', bankName: 'Meezan', accountMasked: '**** 4321' });
    expect(slip.lines).toEqual([
      { label: 'Basic salary', kind: 'earning', amount: '100000.00' },
      { label: 'Allowances', kind: 'earning', amount: '10000.00' },
      { label: 'Income tax', kind: 'deduction', amount: '1600.00' },
    ]);
    expect((await as(DEV1).get(`${API}/payslips/${dev1Slip}`).expect(200)).body.net).toBe('108400.00');
    await as(DEV1).get(`${API}/payslips/me/2026-08`).expect(404);
    await as(DEV1).get(`${API}/payslips/me/2026-8`).expect(400);
  });

  it('the printable payslip is HTML with the masked account only', async () => {
    const doc = await as(DEV1).get(`${API}/payslips/${dev1Slip}/document`).expect(200);
    expect(doc.headers['content-type']).toMatch(/text\/html/);
    expect(doc.text).toContain('PKR 108,400.00');
    expect(doc.text).toContain('**** 4321');
    expect(doc.text).not.toContain(DEV1_ACCOUNT);
  });

  it("another employee gets 404 for someone else's payslip, and the attempt is audited", async () => {
    await as(DEV2).get(`${API}/payslips/${dev1Slip}`).expect(404);
    await as(DEV2).get(`${API}/payslips/${dev1Slip}/document`).expect(404);
    await as(CTO).get(`${API}/payslips/${dev1Slip}`).expect(404); // DEV1's manager: still not finance
    await as(DEV2).get(`${API}/payslips/not-a-uuid`).expect(404);
    expect(await prisma.auditLog.count({ where: { action: 'access.denied', targetType: 'payslip', targetId: dev1Slip } })).toBe(3);
    expect((await as(DEV2).get(`${API}/payslips/me`).expect(200)).body).toHaveLength(2);
  });

  it('finance and management open anyone\'s payslip; each view is audited without amounts', async () => {
    const before = await prisma.auditLog.count({ where: { action: 'payroll.payslip.viewed', targetId: DEV1 } });
    expect((await as(DIRECTOR).get(`${API}/payslips/${dev1Slip}`).expect(200)).body.net).toBe('108400.00');
    expect((await as(FINANCE).get(`${API}/payslips/employees/${DEV1}`).expect(200)).body).toHaveLength(2);
    await as(OWNER).get(`${API}/payslips/${dev1Slip}/document`).expect(200);
    const rows = await prisma.auditLog.findMany({ where: { action: 'payroll.payslip.viewed', targetId: DEV1 } });
    expect(rows).toHaveLength(before + 3);
    expect(JSON.stringify(rows.map((r) => r.details))).not.toMatch(/\d+\.\d{2}/);
  });

  it('everyone sees their own advances outside the finance screens', async () => {
    expect((await as(DEV1).get(`${API}/payroll/advances/me`).expect(200)).body).toEqual([]);
  });
});

describe('M8 request validation', () => {
  it('refuses malformed months, amounts and reasons with 400', async () => {
    await as(FINANCE).post(`${API}/payroll/runs`).send({ month: '2026-1' }).expect(400);
    await as(FINANCE).post(`${API}/payroll/runs`).send({}).expect(400);
    await as(FINANCE).post(`${API}/payroll/runs/${october}/items`).send({ empId: 'nobody', kind: 'bonus', label: 'x', amount: '1' }).expect(400);
    await as(FINANCE).post(`${API}/payroll/advances`).send({ empId: DEV2, amount: '100', monthlyDeduction: '200', startMonth: '2026-11', reason: 'Emergency need', bankAccountId: '6f1b6f5e-5a5d-4c8e-9a3a-2b1c0d9e8f7a' }).expect(400);
    await as(FINANCE).get(`${API}/payroll/adjustments?month=2026`).expect(400);
    await as(FINANCE).get(`${API}/payroll/runs/PR-2031-01`).expect(404);
  });
});
