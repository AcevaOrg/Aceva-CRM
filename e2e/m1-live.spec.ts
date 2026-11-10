import { expect, test, type Page } from '@playwright/test';

const API = 'http://localhost:4000/api/v1';

/** Opens the app already "signed in" as a person (login itself is Module 2; the mock sign-in is used until then). */
async function openAs(page: Page, empId: string, path: string) {
  await page.addInitScript((id) => {
    localStorage.setItem(
      'aceva-session',
      JSON.stringify({
        state: { empId: id, stage: 'signed_in', signedInAt: new Date().toISOString(), policyAccepted: { [id]: true }, checks: {} },
        version: 0,
      }),
    );
  }, empId);
  await page.goto(path);
}

/** A direct call to the real API as someone (what any script or browser extension could do). */
const callApi = (page: Page, empId: string) => ({
  get: (path: string) => page.request.get(API + path, { headers: { 'X-Dev-Emp-Id': empId } }),
  patch: (path: string, data: unknown) => page.request.patch(API + path, { headers: { 'X-Dev-Emp-Id': empId }, data }),
});

const node = (page: Page, name: string) => page.getByRole('button', { name: new RegExp(`^${name}, .*Open details`) });

test.describe.configure({ mode: 'serial' });

test('the org chart is drawn from the real server, as the logged-in person', async ({ page }) => {
  const tree = page.waitForResponse((r) => r.url().endsWith('/api/v1/org/tree') && r.status() === 200);
  await openAs(page, 'ACV-0002', '/org');
  const response = await tree;
  expect(response.request().headers()['x-dev-emp-id']).toBe('ACV-0002');
  const body = (await response.json()) as Array<{ empId: string; children: unknown[] }>;
  expect(body[0].empId).toBe('ACV-0001'); // the Owner is the root; the CEO is a separate person below
  await expect(node(page, 'Hamza Qureshi')).toBeVisible();
  await expect(node(page, 'Ayesha Siddiqui')).toBeVisible();
  await expect(node(page, 'Rabia Anwar \\(DEMO HR\\)')).toBeVisible(); // the demo HR person exists only in the real data
});

test('the CEO moves a person under another manager and it is saved on the server', async ({ page }) => {
  await openAs(page, 'ACV-0002', '/org');
  await node(page, 'Danish Iqbal').click();
  await page.getByRole('button', { name: /Move under/ }).click();
  await page.locator('#move-boss').selectOption('ACV-0010'); // Sana Malik (Level 4)
  await page.locator('#change-reason').fill('Joins the finance audit project');
  const saved = page.waitForResponse((r) => r.url().endsWith('/org/employees/ACV-0011/reporting-line') && r.request().method() === 'PATCH');
  await page.getByRole('button', { name: 'Save new reporting line' }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByText(/now reports to Sana Malik/).first()).toBeVisible();

  // Real hierarchy rules: the new manager sees the person at once, the old manager no longer does.
  expect((await callApi(page, 'ACV-0010').get('/org/team/ACV-0011')).status()).toBe(200);
  expect((await callApi(page, 'ACV-0004').get('/org/team/ACV-0011')).status()).toBe(403);
});

test('the server refuses an invalid move and the screen shows why', async ({ page }) => {
  await openAs(page, 'ACV-0002', '/org');
  // Bypass the screen's own filter: ask the server directly to put a Level 4 head under a Level 5 employee.
  const res = await callApi(page, 'ACV-0002').patch('/org/employees/ACV-0009/reporting-line', { reportsToEmpId: 'ACV-0006', reason: 'invalid on purpose' });
  expect(res.status()).toBe(400);
  expect(JSON.stringify(await res.json())).toContain('manager_below_employee');
});

test('the CEO changes a level and the person gets the new permissions on the next request', async ({ page }) => {
  await openAs(page, 'ACV-0002', '/org');
  await node(page, 'Mariam Shah').click();
  await page.getByRole('button', { name: 'Change level' }).click();
  await page.locator('#level-new').selectOption('4');
  await page.locator('#change-reason').fill('Promoted to team lead');
  await page.getByRole('button', { name: 'Save new level' }).click();
  await expect(page.getByText(/is now Department Head \/ Team Lead \(Level 4\)/)).toBeVisible();
  const me = await (await callApi(page, 'ACV-0007').get('/access/me')).json();
  expect(me.level).toBe(4);
  expect(me.permissions).toContain('task.assign');
});

test('the Director cannot change levels or lines, sees the audit feed, and gives Finance duty', async ({ page }) => {
  await openAs(page, 'ACV-0003', '/org');
  await expect(page.getByText('Recent access changes')).toBeVisible();
  await expect(page.getByText(/now reports to Sana Malik/).first()).toBeVisible(); // the CEO's move, read from the audit log
  await node(page, 'Ali Raza').click();
  await expect(page.getByRole('button', { name: /Move under/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Change level' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Give Finance duty' }).click();
  await page.getByPlaceholder('Write a short reason').fill('Covering the finance team this month');
  await page.getByRole('dialog').getByRole('button', { name: 'Give duty' }).click();
  await expect(page.getByText(/Finance duty given to Ali Raza/)).toBeVisible();
  const me = await (await callApi(page, 'ACV-0008').get('/access/me')).json();
  expect(me.duties).toEqual(['finance']);
  expect(me.twoFactorRequired).toBe(true);
  // and the server refuses the Director's attempt to change a level directly
  expect((await callApi(page, 'ACV-0003').patch('/org/employees/ACV-0008/level', { level: 4, reason: 'not allowed' })).status()).toBe(403);
});

test('an employee sees the chart view-only, and the server refuses everything above them', async ({ page }) => {
  await openAs(page, 'ACV-0013', '/org');
  await node(page, 'Omar Farooq').click();
  await expect(page.getByText(/View only/).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /Move under/ })).toHaveCount(0);
  const me = callApi(page, 'ACV-0013');
  expect((await me.patch('/org/employees/ACV-0008/level', { level: 4, reason: 'attack attempt' })).status()).toBe(403);
  expect((await me.get('/org/team/ACV-0004')).status()).toBe(403); // above
  expect((await me.get('/org/team/ACV-0008')).status()).toBe(403); // beside
  expect((await me.get('/org/team/ACV-0013')).status()).toBe(200); // own record
});

test('a manager names a stand-in and approvals route to them', async ({ page }) => {
  const iso = (offset: number) => new Date(Date.now() + offset * 86_400_000).toLocaleDateString('en-CA');
  await openAs(page, 'ACV-0004', '/org?tab=standins');
  await page.getByRole('button', { name: 'Add stand-in' }).first().click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#si-person').selectOption('ACV-0003'); // the Director
  await dialog.locator('#si-to').fill(iso(7));
  await dialog.getByRole('button', { name: 'Add stand-in' }).click();
  await expect(page.getByRole('cell', { name: /Bilal Ahmed/ }).first()).toBeVisible();

  const route = await (await callApi(page, 'ACV-0013').get(`/approvals/route/ACV-0013?date=${iso(1)}`)).json();
  expect(route).toMatchObject({ approver: 'ACV-0003', seat: 'ACV-0004', via: 'stand_in' });
  const after = await (await callApi(page, 'ACV-0013').get(`/approvals/route/ACV-0013?date=${iso(30)}`)).json();
  expect(after).toMatchObject({ approver: 'ACV-0004', via: 'manager' }); // the period is over
});
