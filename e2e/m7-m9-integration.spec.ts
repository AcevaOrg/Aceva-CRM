import { expect, test } from '@playwright/test';
import { apiAs, openAs } from './auth-helpers';
import { screenLoadsFromServer, stepUpApi } from './live-screen';

/**
 * Cross-module flow through the real API, checked on the real screens:
 *   pay on file (M3) -> payroll calculated for September, which leaves the attendance month open (M7 -> M8)
 *   -> prepared by Finance, approved by the Director after confirming again, which locks the month (M8, one step since
 *      D25; the Owner approves only a run the Director prepared, D26)
 *   -> a balanced salary entry waiting in the ledger, approved by the Director whatever its amount (M9, D26)
 *   -> the run screen and the ledger screen show the same entry; the employee sees their payslip.
 */
const DIRECTOR = 'ACV-0003';
const OWNER = 'ACV-0001'; // the CEO / Founder / Owner (one person in the final company structure)
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

test('M3 -> M7 -> M8: pay on file, the run is calculated (the attendance month stays open), prepared, and approved by the Director (locking the month)', async ({ playwright }) => {
  // Real timing: two "confirm again" steps by the Director, each waiting for a fresh authenticator code (never reused).
  test.setTimeout(120_000);
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
  // calculating does NOT lock the attendance month (D26): check-ins, corrections and leave stay possible until approval
  const dev1 = await apiAs(playwright, DEV1);
  const monthLocked = async () => ((await (await dev1.get(`/attendance/me?month=${MONTH}`)).json()) as { locked: boolean }).locked;
  expect(await monthLocked()).toBe(false);
  expect((await fin.post(`/payroll/runs/${RUN}/prepare`)).status()).toBe(200);
  expect((await fin.post(`/payroll/runs/${RUN}/approve`)).status()).toBe(404); // the preparer never approves (no permission: a finance screen answers 404)
  expect((await director.post(`/payroll/runs/${RUN}/review`)).status()).toBe(404); // no separate review step since D25
  const owner = await apiAs(playwright, OWNER);
  const byOwner = await owner.post(`/payroll/runs/${RUN}/approve`);
  expect(byOwner.status()).toBe(403); // D26: the Owner approves only a run the Director prepared; Finance prepared this one
  expect((await byOwner.json()).code).toBe('owner_approves_director_only');
  expect(await monthLocked()).toBe(false); // nothing was approved yet

  await stepUpApi(director, DIRECTOR); // a fresh "confirm again" for the approval
  const approved = await director.post(`/payroll/runs/${RUN}/approve`);
  expect(approved.status(), await approved.text()).toBe(200);
  const run = await approved.json();
  expect(run.salaryEntry.status).toBe('pending_approval');
  // approving the payroll locks the attendance month: a correction for a day in it is now refused
  expect(await monthLocked()).toBe(true);
  const correction = await dev1.post('/attendance/corrections', { date: `${MONTH}-15`, checkIn: '09:00', reason: 'Forgot to check in (browser test)' });
  expect(correction.status()).toBe(409);
  expect((await correction.json()).code).toBe('period_locked');
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

test('M9: the Director approves the salary entry whatever its amount (D26), never the preparer, and the employee sees the payslip', async ({ browser, playwright }) => {
  const fin = await apiAs(playwright, FINANCE);
  const entry = await (await fin.get(`/journal-entries/${entryId}`)).json();
  expect((await fin.post(`/journal-entries/${entryId}/approve`)).status()).toBe(404); // the maker (Finance prepared the run) never approves
  expect(entry.requiredLevel).toBe(2); // D26: no amount tiers; the Director (level 2) approves any amount
  // the Owner approves only entries the Director made; this one Finance made
  const owner = await apiAs(playwright, OWNER);
  await stepUpApi(owner, OWNER);
  const byOwner = await owner.post(`/journal-entries/${entryId}/approve`);
  expect(byOwner.status()).toBe(403);
  expect((await byOwner.json()).code).toBe('approval_limit');
  const director = await apiAs(playwright, DIRECTOR);
  await stepUpApi(director, DIRECTOR); // the salary total is above the "confirm again" amount
  const posted = await director.post(`/journal-entries/${entryId}/approve`);
  expect(posted.status(), await posted.text()).toBe(200);
  expect((await (await fin.get(`/payroll/runs/${RUN}`)).json()).salaryEntry.status).toBe('posted');

  const dev1 = await apiAs(playwright, DEV1);
  expect((await dev1.get(`/payslips/me/${MONTH}`)).status()).toBe(200);
  const { page, context } = await openAs(browser, DEV1, '/');
  await screenLoadsFromServer(page, '/payroll/payslips', /\/api\/v1\/payslips\/me$/);
  await context.close();
});
