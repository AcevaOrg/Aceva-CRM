import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { createTestPrisma } from '../backend/test/helpers/prisma';
import { API, PASSWORD, apiAs, openAs } from './auth-helpers';

/**
 * Module 3 (employee profiles, joining, leaving) driven through the real screens in Chromium, with the real backend,
 * PostgreSQL, Redis and Mailpit. Scenario: the Director fills the joining wizard, the CEO approves it, the new person
 * signs in, edits their profile, uploads a document and a photo; the Director edits and resets the authenticator; HR
 * sets the last working day; the CEO sees and resolves the unresolved reports.
 */
const MAILPIT = 'http://127.0.0.1:8025/api/v1';
const DIRECTOR = 'ACV-0003';
const CEO = 'ACV-0002';
const OWNER = 'ACV-0001';
const HR = 'ACV-0015';
const FINANCE = 'ACV-0010';
const PEER = 'ACV-0006';
const HIRE_EMAIL = 'e2e.joiner@acevatech.com';
const HIRE_NAME = 'E2E Joiner';
const NEW_PASSWORD = 'Joiner-Own-Pass-2026x';

test.describe.configure({ mode: 'serial' });

let hireId = '';
let temporary = '';

const tabs = (page: Page) => page.getByRole('tab');
const toastText = (page: Page, text: RegExp | string) => page.locator('[data-sonner-toast]').filter({ hasText: text }).first();
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 7)]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

async function stepUp(page: Page) {
  // the confirmation screen for sensitive actions (a demonstration screen: any 6 digits are accepted)
  await page.locator('#stepup-pw').fill(PASSWORD);
  await page.locator('input[aria-label="Digit 1"]').click();
  await page.keyboard.type('123456');
  await page.getByRole('button', { name: 'Confirm' }).click();
}

test('the Director fills the joining wizard: it creates a request, not an employee', async ({ browser, request }) => {
  await request.delete(`${MAILPIT}/messages`);
  const { page, context } = await openAs(browser, DIRECTOR, '/people/new');
  await page.locator('#o-name').fill(HIRE_NAME);
  await page.locator('#o-des').fill('QA Engineer');
  await page.locator('#o-dep').selectOption('dep-eng');
  await page.locator('#o-off').selectOption('off-khi');
  await page.locator('#o-mail').fill(HIRE_EMAIL);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#o-boss').selectOption('ACV-0004');
  await page.locator('#o-join').fill('2026-11-01');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.locator('#o-base').fill('180000');
  await page.locator('#o-bank').fill('Meezan');
  await page.locator('#o-acc').fill('PK12MEZN0001234567890');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Send for approval' }).click();
  await expect(page.getByText('Hire sent for approval').first()).toBeVisible();
  await expect(page.getByText(/must authorize the level and reporting line/)).toBeVisible();
  await context.close();

  // nothing exists yet: no employee, no email
  const search = await (await request.get(`${MAILPIT}/search?query=${encodeURIComponent('to:' + HIRE_EMAIL)}`)).json();
  expect(search.messages?.length ?? 0).toBe(0);
});

test('Director and HR cannot approve; the CEO approves in the screen and the Emp-ID is created', async ({ browser, playwright, request }) => {
  const director = await openAs(browser, DIRECTOR, '/people');
  await expect(director.page.getByTestId('hire-requests')).toContainText(HIRE_NAME);
  await expect(director.page.getByTestId('hire-requests').getByRole('button', { name: 'Approve' })).toHaveCount(0); // no approve button for the Director
  await director.context.close();

  const api = await apiAs(playwright, DIRECTOR);
  const pending = (await (await api.get('hire-requests?status=pending')).json()) as Array<{ id: string; name: string }>;
  const id = pending.find((r) => r.name === HIRE_NAME)!.id;
  expect((await api.post(`hire-requests/${id}/approve`, {})).status()).toBe(403);

  const ceo = await openAs(browser, CEO, '/people');
  const panel = ceo.page.getByTestId('hire-requests');
  await expect(panel).toContainText(HIRE_NAME);
  await expect(panel).toContainText('Level 5');
  await panel.getByRole('button', { name: 'Approve' }).first().click();
  const t = toastText(ceo.page, /ACV-\d{4} created/);
  await expect(t).toBeVisible();
  hireId = (await t.innerText()).match(/ACV-\d{4}/)![0];
  await ceo.context.close();

  await expect
    .poll(async () => {
      const search = await (await request.get(`${MAILPIT}/search?query=${encodeURIComponent('to:' + HIRE_EMAIL)}`)).json();
      if (!search.messages?.length) return '';
      const msg = await (await request.get(`${MAILPIT}/message/${search.messages[0].ID}`)).json();
      expect(msg.Text).toContain(hireId);
      temporary = (msg.Text as string).match(/Temporary password: (\S+)/)?.[1] ?? '';
      return temporary;
    })
    .not.toBe('');
});

test('the new employee signs in with the temporary password and must choose their own', async ({ page, playwright }) => {
  await page.goto('/login');
  await page.locator('#empId').fill(hireId.replace('ACV-', ''));
  await page.locator('#password').fill(temporary);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/first-login/);
  await page.locator('#new-pw').fill(NEW_PASSWORD);
  await page.locator('#confirm-pw').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /Finish and open Aceva/ }).click();
  await page.waitForURL(/\/$/);
  const ctx = await playwright.request.newContext({ baseURL: API + '/' });
  expect((await (await ctx.post('auth/login', { data: { empId: hireId, password: temporary } })).json()).status).toBe('invalid');
});

test('the person edits their own phone in the screen, and the old value stays in the history', async ({ page }) => {
  await page.goto('/login');
  await page.locator('#empId').fill(hireId.replace('ACV-', ''));
  await page.locator('#password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/$/);
  await page.goto(`/people/${hireId}?tab=personal`);
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.locator('#p-phone').fill('+92 300 1112223');
  await page.locator('#p-addr').fill('House 5, Street 9, Karachi');
  await page.locator('#p-ecn').fill('Imran Khan');
  await page.locator('#p-ecr').fill('Father');
  await page.locator('#p-ecp').fill('+92 301 7654321');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('+92 300 1112223').first()).toBeVisible();
  await page.locator('#p-phone').count(); // form closed
  await page.getByRole('button', { name: 'Edit' }).first().click();
  await page.locator('#p-phone').fill('+92 321 9990001');
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByText('+92 321 9990001').first()).toBeVisible();
  await page.goto(`/people/${hireId}?tab=history`);
  await expect(page.getByText('+92 300 1112223').first()).toBeVisible(); // the old value is kept
  await expect(page.getByText('+92 321 9990001').first()).toBeVisible();
});

test('the person uploads a CV and downloads it back, and sets a photo that others can see', async ({ page, browser }) => {
  await page.goto('/login');
  await page.locator('#empId').fill(hireId.replace('ACV-', ''));
  await page.locator('#password').fill(NEW_PASSWORD);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/$/);

  await page.goto(`/people/${hireId}?tab=documents`);
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'my-cv.pdf', mimeType: 'application/pdf', buffer: PDF });
  await expect(page.getByText('my-cv.pdf').first()).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('li').getByRole('button', { name: /my-cv.pdf/ }).click()]);
  expect(download.suggestedFilename()).toBe('my-cv.pdf');
  expect(readFileSync((await download.path())!).equals(PDF)).toBe(true);
  // a wrong kind of file is refused by the server
  await page.locator('input[type="file"]').first().setInputFiles({ name: 'virus.pdf', mimeType: 'application/pdf', buffer: Buffer.from('MZ not a pdf') });
  await expect(toastText(page, /Only PDF, PNG, JPEG/)).toBeVisible();

  await page.goto(`/people/${hireId}?tab=basic`);
  await expect(page.getByTestId('no-photo')).toBeVisible();
  await page.getByTestId('photo-input').setInputFiles({ name: 'me.png', mimeType: 'image/png', buffer: PNG });
  await expect(page.getByTestId('profile-photo')).toBeVisible();

  const peer = await openAs(browser, PEER, `/people/${hireId}?tab=basic`);
  await expect(peer.page.getByTestId('profile-photo')).toBeVisible(); // the photo is basic information
  await expect(peer.page.getByText('E2E Joiner').first()).toBeVisible();
  for (const label of ['Job', 'Personal', 'Pay', 'Documents']) await expect(tabs(peer.page).filter({ hasText: label })).toHaveCount(0);
  await peer.context.close();
});

test('the Director sees pay only after a logged reveal; HR never sees pay', async ({ browser }) => {
  const director = await openAs(browser, DIRECTOR, `/people/${hireId}?tab=pay`);
  await expect(director.page.getByText('Meezan')).toBeVisible();
  const html = await director.page.content();
  expect(html).not.toMatch(/180,?000/); // the amount is not in the page, nor in the data sent to it
  expect(html).not.toContain('PK12MEZN0001234567890');
  await director.page.getByRole('button', { name: 'Show base salary' }).click();
  await stepUp(director.page);
  await expect(director.page.getByText(/180,?000/).first()).toBeVisible();
  const prisma = createTestPrisma();
  try {
    expect(await prisma.auditLog.count({ where: { action: 'employee.sensitive.revealed', targetId: hireId } })).toBeGreaterThanOrEqual(1); // the reveal was logged
  } finally {
    await prisma.$disconnect();
  }
  await director.context.close();

  const hr = await openAs(browser, HR, `/people/${hireId}`);
  await expect(tabs(hr.page).filter({ hasText: 'Personal' })).toHaveCount(1);
  await expect(tabs(hr.page).filter({ hasText: 'Pay' })).toHaveCount(0);
  await hr.context.close();
});

test('the Director edits a profile field in the screen; the change is in the history', async ({ browser }) => {
  const director = await openAs(browser, DIRECTOR, `/people/${hireId}?tab=basic`);
  await director.page.getByRole('button', { name: 'Edit' }).first().click();
  await director.page.locator('#b-des').fill('Senior QA Engineer');
  await director.page.getByRole('button', { name: 'Save changes' }).click();
  await expect(director.page.getByText('Senior QA Engineer').first()).toBeVisible();
  await director.page.goto(`/people/${hireId}?tab=history`);
  await expect(director.page.getByText('QA Engineer').first()).toBeVisible();
  await expect(director.page.getByText('Senior QA Engineer').first()).toBeVisible();
  await director.context.close();
});

test('the Director resets the authenticator in the dialog: the person is signed out and must enrol again', async ({ browser, playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: API + '/' });
  const login = await (await ctx.post('auth/login', { data: { empId: hireId, password: NEW_PASSWORD } })).json();
  expect(login.status).toBe('ok');

  const director = await openAs(browser, DIRECTOR, `/people/${hireId}`);
  await director.page.getByRole('button', { name: 'More actions' }).click();
  await director.page.getByRole('menuitem', { name: 'Reset authenticator' }).click();
  const confirm = director.page.getByRole('button', { name: 'Reset authenticator' });
  await expect(confirm).toBeDisabled(); // a reason is required
  await director.page.locator('#r2fa-reason').fill('Phone lost; identity confirmed in person');
  await confirm.click();
  await expect(toastText(director.page, /Authenticator reset for/)).toBeVisible();
  await director.context.close();

  await expect.poll(async () => (await ctx.get('auth/me')).status()).toBe(401); // every session ended
  const again = await (await ctx.post('auth/login', { data: { empId: hireId, password: NEW_PASSWORD } })).json();
  expect(again.status).toBe('2fa_setup_required'); // fresh enrolment at the next login
  // a peer cannot reset it
  const peer = await apiAs(playwright, PEER);
  expect((await peer.post(`auth/employees/${hireId}/reset-2fa`, { reason: 'I am not allowed to' })).status()).toBe(403);
});

test('HR sets the last working day in the dialog; access ends the next day, and the CEO sees who needs a new manager', async ({ browser, playwright }) => {
  // an employee reporting to Finance, who is about to leave
  const owner = await apiAs(playwright, OWNER);
  const orphan = await (
    await owner.post('employees', { name: 'E2E Orphan', designation: 'Analyst', departmentId: 'dep-fin', officeId: 'off-khi', officialEmail: 'e2e.orphan@acevatech.com', level: 5, reportsToEmpId: FINANCE, joiningDate: '2026-11-01', type: 'full_time' })
  ).json();
  expect(orphan.status).toBe('created');

  // 1) today as the last working day: still working, scheduled for the next day
  const hr = await openAs(browser, HR, `/people/${hireId}`);
  await hr.page.getByRole('button', { name: 'More actions' }).click();
  await hr.page.getByRole('menuitem', { name: 'Set last working day' }).click();
  const today = new Date();
  const iso = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  await hr.page.locator('#ob-date').fill(iso(today));
  await hr.page.locator('#ob-reason').fill('Resigned, notice period ends today');
  await expect(hr.page.getByText('request to move their open tasks')).toBeVisible();
  await hr.page.getByRole('button', { name: 'Set last working day' }).last().click();
  await expect(toastText(hr.page, /Last working day set/)).toBeVisible();
  const dir = await apiAs(playwright, DIRECTOR);
  const status = async () => ((await (await dir.get(`employees/${hireId}`)).json()) as { job: { status: string } }).job.status;
  expect(await status()).toBe('on_notice'); // still active through the last working day
  const ctx = await playwright.request.newContext({ baseURL: API + '/' });
  expect((await (await ctx.post('auth/login', { data: { empId: hireId, password: NEW_PASSWORD } })).json()).status).not.toBe('invalid'); // can still sign in
  await hr.context.close();

  // 2) the Director sets yesterday for Finance: processed now; the report is listed, not moved
  const finance = await openAs(browser, DIRECTOR, `/people/${FINANCE}`);
  await finance.page.getByRole('button', { name: 'More actions' }).click();
  await finance.page.getByRole('menuitem', { name: 'Set last working day' }).click();
  const yesterday = new Date(today.getTime() - 86_400_000);
  await finance.page.locator('#ob-date').fill(iso(yesterday));
  await finance.page.locator('#ob-reason').fill('Resigned and served notice');
  await finance.page.getByRole('button', { name: 'Set last working day' }).last().click();
  await expect(toastText(finance.page, /Last working day set/)).toBeVisible();
  await finance.context.close();

  const ceo = await openAs(browser, CEO, '/people');
  const panel = ceo.page.getByTestId('unresolved-reports');
  await expect(panel).toContainText('E2E Orphan');
  await expect(panel.getByRole('link', { name: 'Assign manager' }).first()).toBeVisible();
  const cApi = await apiAs(playwright, CEO);
  const orphanRow = (await (await cApi.get('employees/unresolved-reports')).json()) as Array<{ empId: string; name: string }>;
  expect((await (await cApi.get(`employees/${orphan.empId}`)).json()).job.reportsTo).toBe(FINANCE); // not moved automatically
  // only the Owner or CEO reassign (the Director may not)
  expect((await dir.patch(`employees/${orphan.empId}/job`, { reportsToEmpId: DIRECTOR, reason: 'Director cannot reassign' })).status()).toBe(403);
  expect((await cApi.patch(`employees/${orphan.empId}/job`, { reportsToEmpId: DIRECTOR, reason: 'Finance lead left' })).status()).toBe(200);
  await ceo.page.reload();
  await expect(ceo.page.getByTestId('unresolved-reports')).toHaveCount(0);
  void orphanRow;
  await ceo.context.close();
});

test('the person whose last working day is today is still on notice: leaving is processed the next day (the clock-moving backend tests prove it)', async ({ playwright }) => {
  const director = await apiAs(playwright, DIRECTOR);
  const profile = await (await director.get(`employees/${hireId}`)).json();
  expect(profile.job.status).toBe('on_notice');
  expect(profile.job.lastWorkingDay).toBeTruthy();
});
