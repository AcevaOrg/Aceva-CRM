import { expect, test, type Page } from '@playwright/test';
import { apiAs, openAs } from './auth-helpers';

/** Module 1 screens against the real server, logged in for real (password, authenticator code, session cookie). */

const node = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name}, .*Open details`) });

test.describe.configure({ mode: 'serial' });

test('the org chart is drawn from the real server, as the logged-in person', async ({ browser }) => {
  const { page, context } = await openAs(browser, 'ACV-0002', '/');
  const tree = page.waitForResponse((r) => r.url().endsWith('/api/v1/org/tree') && r.status() === 200);
  await page.goto('/org');
  const response = await tree;
  expect(response.request().headers()['x-dev-emp-id']).toBeUndefined(); // the old development header is gone
  await expect(node(page, 'Hamza Qureshi')).toBeVisible();
  await expect(node(page, 'Ayesha Siddiqui')).toBeVisible();
  await expect(node(page, 'Rabia Anwar \\(DEMO HR\\)')).toBeVisible(); // the demo HR person exists only in the real data
  await context.close();
});

test('the CEO moves a person under another manager and it is saved on the server', async ({ browser, playwright }) => {
  const { page, context } = await openAs(browser, 'ACV-0002', '/org');
  await node(page, 'Danish Iqbal').click();
  await page.getByRole('button', { name: /Move under/ }).click();
  await page.locator('#move-boss').selectOption('ACV-0010'); // Sana Malik (Level 4)
  await page.locator('#change-reason').fill('Joins the finance audit project');
  const saved = page.waitForResponse((r) => r.url().endsWith('/org/employees/ACV-0011/reporting-line') && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save new reporting line' }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByText(/now reports to Sana Malik/).first()).toBeVisible();

  // Real hierarchy rules: the new manager sees the person at once, the old manager no longer does.
  expect((await (await apiAs(playwright, 'ACV-0010')).get('/org/team/ACV-0011')).status()).toBe(200);
  expect((await (await apiAs(playwright, 'ACV-0004')).get('/org/team/ACV-0011')).status()).toBe(403);
  await context.close();
});

test('the server refuses an invalid reporting line even when the screen is bypassed', async ({ playwright }) => {
  const ceo = await apiAs(playwright, 'ACV-0002');
  const res = await ceo.patch('/org/employees/ACV-0009/reporting-line', { reportsToEmpId: 'ACV-0006', reason: 'invalid on purpose' });
  expect(res.status()).toBe(400);
  expect(JSON.stringify(await res.json())).toContain('manager_below_employee');
});

test('the CEO changes a level and the person gets the new permissions on the next request', async ({ browser, playwright }) => {
  const { page, context } = await openAs(browser, 'ACV-0002', '/org');
  await node(page, 'Mariam Shah').click();
  await page.getByRole('button', { name: 'Change level' }).click();
  await page.locator('#level-new').selectOption('4');
  await page.locator('#change-reason').fill('Promoted to team lead');
  await page.getByRole('button', { name: 'Save new level' }).click();
  await expect(page.getByText(/is now Department Head \/ Team Lead \(Level 4\)/)).toBeVisible();
  const me = await (await (await apiAs(playwright, 'ACV-0007')).get('/access/me')).json();
  expect(me.level).toBe(4);
  expect(me.permissions).toContain('task.assign');
  await context.close();
});

test('the Director cannot change levels or lines, sees the audit feed, and gives Finance duty', async ({ browser, playwright }) => {
  const { page, context } = await openAs(browser, 'ACV-0003', '/org');
  await expect(page.getByText('Recent access changes')).toBeVisible();
  await expect(page.getByText(/now reports to Sana Malik/).first()).toBeVisible(); // the CEO's move, read from the audit log
  await node(page, 'Ali Raza').click();
  await expect(page.getByRole('button', { name: /Move under/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change level' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Give Finance duty' }).click();
  await page.getByPlaceholder('Write a short reason').fill('Covering the finance team this month');
  await page.getByRole('dialog').getByRole('button', { name: 'Give duty' }).click();
  await expect(page.getByText(/Finance duty given to Ali Raza/)).toBeVisible();
  // two-step login became mandatory for Ali at once: a fresh login is told to set up the authenticator
  const fresh = await playwright.request.newContext({ baseURL: 'http://localhost:4100/api/v1/' });
  const login = await (await fresh.post('auth/login', { data: { empId: 'ACV-0008', password: 'Demo-Passw0rd-2026' } })).json();
  expect(login.status).toBe('2fa_setup_required');
  const me = await (await (await apiAs(playwright, 'ACV-0008')).get('/auth/me')).json();
  expect(me.duties).toEqual(['finance']);
  expect(me.twoFactorRequired).toBe(true);
  // and the server refuses the Director's attempt to change a level directly
  expect((await (await apiAs(playwright, 'ACV-0003')).patch('/org/employees/ACV-0008/level', { level: 4, reason: 'not allowed' })).status()).toBe(403);
  await context.close();
});

test('an employee sees the chart view-only, and the server refuses everything above them', async ({ browser, playwright }) => {
  const { page, context } = await openAs(browser, 'ACV-0013', '/org');
  await node(page, 'Omar Farooq').click();
  await expect(page.getByText(/View only/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Move under/ })).toHaveCount(0);
  const me = await apiAs(playwright, 'ACV-0013');
  expect((await me.patch('/org/employees/ACV-0008/level', { level: 4, reason: 'attack attempt' })).status()).toBe(403);
  expect((await me.get('/org/team/ACV-0004')).status()).toBe(403); // above
  expect((await me.get('/org/team/ACV-0008')).status()).toBe(403); // beside
  expect((await me.get('/org/team/ACV-0013')).status()).toBe(200); // own record
  await context.close();
});

test('a manager names a stand-in and approvals route to them', async ({ browser, playwright }) => {
  const iso = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA');
  const { page, context } = await openAs(browser, 'ACV-0004', '/org?tab=standins');
  await page.getByRole('button', { name: 'Add stand-in' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#si-person').selectOption('ACV-0003'); // the Director
  await dialog.locator('#si-to').fill(iso(7));
  await dialog.getByRole('button', { name: 'Add stand-in' }).click();
  await expect(page.getByRole('cell', { name: /Bilal Ahmed/ }).first()).toBeVisible();

  const nida = await apiAs(playwright, 'ACV-0013');
  const route = await (await nida.get(`/approvals/route/ACV-0013?date=${iso(1)}`)).json();
  expect(route).toMatchObject({ approver: 'ACV-0003', seat: 'ACV-0004', via: 'stand_in' });
  const after = await (await nida.get(`/approvals/route/ACV-0013?date=${iso(30)}`)).json();
  expect(after).toMatchObject({ approver: 'ACV-0004', via: 'manager' }); // the period is over
  await context.close();
});
