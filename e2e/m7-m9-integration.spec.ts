import { expect, test } from '@playwright/test';
import { apiAs, openAs } from './auth-helpers';
import { FIXTURE_CEO } from './paths';
import { screenLoadsFromServer, stepUpApi } from './live-screen';

/**
 * Cross-module flow through the real API, checked on the real screens:
 *   pay on file (M3) -> payroll calculated for September, which locks the attendance month (M7 -> M8)
 *   -> prepared by Finance, reviewed by the Director, approved by the CEO after confirming again (M8)
 *   -> a balanced salary entry waiting in the ledger, approved at its tier (M9)
 *   -> the run screen and the ledger screen show the same entry; the employee sees their payslip.
 */
const DIRECTOR = 'ACV-0003';
const OWNER = 'ACV-0001';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const FINANCE = 'ACV-0010';
const MONTH = '2026-09';
const RUN = `PR-${MONTH}`;

const SLABS = {
  effectiveFrom: '2026-07-01',
  label: 'Browser test slabs (test data)',
  slabs: [
    { from: '0', to: '600000', fixed: '0', rate: '0' },
    { from: '600000', to: '1200000', fixed: '0', rate: '0.01' },
    { from: '1200000', to: null, fixed: '6000', rate: '0.11' },
  ],
};

test.describe.configure({ mode: 'serial' });

let entryId = '';

test('M3 -> M7 -> M8: pay on file, the run is calculated (locking the attendance month), prepared, reviewed and approved', async ({ playwright }) => {
  const director = await apiAs(playwright, DIRECTOR);
  await stepUpApi(director, DIRECTOR);
  for (const [empId, base, account] of [[DEV1, 100000, 'PK36SCBL0000001123456702'], [DEV2, 60000, 'PK36SCBL0000001123456703']] as const) {
    const res = await director.patch(`/employees/${empId}/pay`, { baseSalary: base, allowances: 0, bankName: 'Standard Chartered', accountNumber: account, reason: 'Browser test salary' });
    expect(res.status(), `pay for ${empId}`).toBe(200);
  }
  expect((await director.post('/settings/tax-slabs', SLABS)).status()).toBe(201);

  const fin = await apiAs(playwright, FINANCE);
  expect((await fin.post('/payroll/runs', { month: MONTH })).status()).toBe(201);
  const calculated = await fin.post(`/payroll/runs/${RUN}/calculate`);
  expect(calculated.status(), await calculated.text()).toBe(200);
  // the attendance month is now locked: a correction for a day in it is refused
  const dev1 = await apiAs(playwright, DEV1);
  const correction = await dev1.post('/attendance/corrections', { date: `${MONTH}-15`, checkIn: '09:00', reason: 'Forgot to check in (browser test)' });
  expect([400, 409]).toContain(correction.status());
  expect((await fin.post(`/payroll/runs/${RUN}/prepare`)).status()).toBe(200);
  expect((await fin.post(`/payroll/runs/${RUN}/review`)).status()).toBe(404); // the preparer never reviews (Finance has no review permission: a finance screen answers 404)
  expect((await director.post(`/payroll/runs/${RUN}/review`)).status()).toBe(200);
  expect((await director.post(`/payroll/runs/${RUN}/approve`)).status()).toBe(404); // the Director reviews, the CEO approves

  const ceo = await apiAs(playwright, FIXTURE_CEO);
  expect((await ceo.post(`/payroll/runs/${RUN}/approve`)).status()).toBe(403); // "confirm again" first
  await stepUpApi(ceo, FIXTURE_CEO);
  const approved = await ceo.post(`/payroll/runs/${RUN}/approve`);
  expect(approved.status(), await approved.text()).toBe(200);
  const run = await approved.json();
  expect(run.salaryEntry.status).toBe('pending_approval');
  entryId = run.salaryEntry.id ?? '';
  if (!entryId) {
    const list = await (await fin.get(`/journal-entries?source=payroll&status=pending_approval`)).json();
    entryId = list.items.find((e: { number: string }) => e.number === run.salaryEntry.number).id;
  }
});

test('M8 -> M9: the run screen and the ledger screen show the same balanced salary entry', async ({ browser, playwright }) => {
  const fin = await apiAs(playwright, FINANCE);
  const entry = await (await fin.get(`/journal-entries/${entryId}`)).json();
  expect(entry.status).toBe('pending_approval');
  const debit = entry.lines.reduce((a: number, l: { debit: string }) => a + Math.round(Number(l.debit) * 100), 0);
  const credit = entry.lines.reduce((a: number, l: { credit: string }) => a + Math.round(Number(l.credit) * 100), 0);
  expect(debit).toBe(credit);

  const { page, context } = await openAs(browser, FINANCE, '/');
  await screenLoadsFromServer(page, `/payroll/runs/${RUN}`, new RegExp(`/api/v1/payroll/runs/${RUN}/lines$`));
  await expect(page.getByText(entry.number).first()).toBeVisible();
  await screenLoadsFromServer(page, `/finance/ledger/${entryId}`, new RegExp(`/api/v1/journal-entries/${entryId}$`));
  await expect(page.getByText(entry.number).first()).toBeVisible();
  await context.close();
});

test('M9: the salary entry is approved at its tier (never by the preparer), and the employee sees the payslip', async ({ browser, playwright }) => {
  const fin = await apiAs(playwright, FINANCE);
  const entry = await (await fin.get(`/journal-entries/${entryId}`)).json();
  expect((await fin.post(`/journal-entries/${entryId}/approve`)).status()).toBe(404); // the maker never approves
  const approverId = entry.requiredLevel === 3 ? DIRECTOR : entry.requiredLevel === 2 ? FIXTURE_CEO : OWNER;
  const approver = await apiAs(playwright, approverId);
  await stepUpApi(approver, approverId);
  const posted = await approver.post(`/journal-entries/${entryId}/approve`);
  expect(posted.status(), await posted.text()).toBe(200);
  expect((await (await fin.get(`/payroll/runs/${RUN}`)).json()).salaryEntry.status).toBe('posted');

  const dev1 = await apiAs(playwright, DEV1);
  expect((await dev1.get(`/payslips/me/${MONTH}`)).status()).toBe(200);
  const { page, context } = await openAs(browser, DEV1, '/');
  await screenLoadsFromServer(page, '/payroll/payslips', /\/api\/v1\/payslips\/me$/);
  await context.close();
});
