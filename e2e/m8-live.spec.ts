import { expect, test } from '@playwright/test';
import { apiAs, openAs } from './auth-helpers';
import { screenLoadsFromServer } from './live-screen';

/** Module 8 (payroll) screens against the real server, logged in for real. */
const DEV = 'ACV-0006';
const FINANCE = 'ACV-0010';

test.describe.configure({ mode: 'serial' });

const SCREENS: Array<{ who: string; path: string; endpoint: RegExp }> = [
  { who: DEV, path: '/payroll/payslips', endpoint: /\/api\/v1\/payslips\/me$/ },
  { who: FINANCE, path: '/payroll', endpoint: /\/api\/v1\/payroll\/runs$/ },
  { who: FINANCE, path: '/payroll/advances', endpoint: /\/api\/v1\/payroll\/advances$/ },
];

for (const s of SCREENS) {
  test(`${s.path} as ${s.who} loads from the real API`, async ({ browser }) => {
    const { page, context } = await openAs(browser, s.who, '/');
    await screenLoadsFromServer(page, s.path, s.endpoint);
    await context.close();
  });
}

test('a payroll run detail screen loads the real run', async ({ browser, playwright }) => {
  const fin = await apiAs(playwright, FINANCE);
  const created = await fin.post('/payroll/runs', { month: '2026-10' });
  expect([201, 409]).toContain(created.status()); // 409: already created by an earlier run of this file
  const { page, context } = await openAs(browser, FINANCE, '/');
  // the detail screen reads the run and its lines in one call: GET /payroll/runs/:id/lines
  await screenLoadsFromServer(page, '/payroll/runs/PR-2026-10', /\/api\/v1\/payroll\/runs\/PR-2026-10\/lines$/);
  await expect(page.getByText('PR-2026-10').first()).toBeVisible();
  await context.close();
});

test('payroll management is not reachable for a developer: the server answers 404', async ({ playwright }) => {
  const dev = await apiAs(playwright, DEV);
  for (const path of ['/payroll/runs', '/payroll/advances', '/payslips/employees/ACV-0007']) {
    expect((await dev.get(path)).status(), path).toBe(404);
  }
  expect((await dev.get('/payslips/me')).status()).toBe(200);
});
