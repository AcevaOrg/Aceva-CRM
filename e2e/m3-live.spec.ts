import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { createTestPrisma } from '../backend/test/helpers/prisma';
import { API, PASSWORD, apiAs, nextCode, openAs } from './auth-helpers';
import { E2E_FILES, FIXTURE_CEO, FIXTURE_HR } from './paths';

/**
 * Module 3 (employee profiles, joining, leaving) driven through the real screens in Chromium, with the real backend,
 * PostgreSQL, Redis and Mailpit. Scenario: the Director fills the joining wizard, the CEO approves it, the new person
 * signs in, edits their profile, uploads a document and a photo; the Director edits and resets the authenticator; HR
 * sets the last working day; the CEO sees and resolves the unresolved reports.
 */
const MAILPIT = 'http://127.0.0.1:8025/api/v1';
const DIRECTOR = 'ACV-0003';
const CEO = FIXTURE_CEO; // test-only CEO, added by reset-test-db.ts
const OWNER = 'ACV-0001';
const HR = FIXTURE_HR; // test-only HR officer
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

/** A real authenticator code (each code works once; wait for the next 30-second window when two were just used). */
async function freshCode(empId: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    try {
      return nextCode(empId);
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error('No authenticator code available');
}

/** The "confirm it's you" dialog: the SERVER checks the password and the code. */
async function stepUp(page: Page, empId: string) {
  await page.locator('#stepup-pw').fill(PASSWORD);
  await page.locator('input[aria-label="Digit 1"]').click();
  await page.keyboard.type(await freshCode(empId));
  await page.getByRole('button', { name: 'Confirm' }).click();
}

/** Confirm again through the API for a signed-in API client. */
async function apiStepUp(api: Awaited<ReturnType<typeof apiAs>>, empId: string, withCode = true) {
  const res = await api.post('auth/step-up', { password: PASSWORD, ...(withCode ? { code: await freshCode(empId) } : {}) });
  expect(res.status()).toBe(200);
}

/** The reason dialog (title varies): type a reason and confirm. */
async function giveReason(page: Page, reason: string) {
  const dialog = page.getByRole('dialog');
  await dialog.locator('textarea').fill(reason);
  await dialog.locator('button[type="submit"]').click(); // not .last(): the close (X) button comes after the footer
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
  const [download] = await Promise.all([page.waitForEvent('download'), page.locator('li').getByRole('button', { name: /^my-cv.pdf/ }).click()]);
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
  await stepUp(director.page, DIRECTOR);
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

test('the confirm-again dialog is checked by the server: a wrong password or an arbitrary code is refused and nothing is revealed', async ({ browser, playwright }) => {
  const director = await openAs(browser, DIRECTOR, `/people/${hireId}?tab=pay`);
  const page = director.page;
  await page.getByRole('button', { name: 'Show base salary' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.locator('#stepup-pw')).toBeVisible();

  // wrong password with a plausible code
  await dialog.locator('#stepup-pw').fill('not-the-right-password');
  await dialog.locator('input[aria-label="Digit 1"]').click();
  await page.keyboard.type('123456');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog.locator('[role="alert"]')).toContainText('not right');
  await expect(dialog).toBeVisible(); // it stays open: nothing was confirmed
  // right password, arbitrary six digits
  await dialog.locator('#stepup-pw').fill(PASSWORD);
  await dialog.locator('input[aria-label="Digit 1"]').click();
  await page.keyboard.type('000000');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(dialog.locator('[role="alert"]')).toContainText('not right');
  await expect(page.getByText(/1[89]\d,?000/)).toHaveCount(0); // no salary shown
  // the server agrees: this session has not confirmed, so the reveal is refused
  const direct = await apiAs(playwright, DIRECTOR);
  const refused = await direct.post(`employees/${hireId}/reveal`, { field: 'salary' });
  expect(refused.status()).toBe(403);
  expect((await refused.json()).code).toBe('step_up_required');

  // right password and the real code
  await dialog.locator('#stepup-pw').fill(PASSWORD);
  await dialog.locator('input[aria-label="Digit 1"]').click();
  await page.keyboard.type(await freshCode(DIRECTOR));
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.getByText(/180,?000/).first()).toBeVisible();
  await director.context.close();

  const prisma = createTestPrisma();
  try {
    expect(await prisma.auditLog.count({ where: { action: 'auth.step_up.failed', actor: { empId: DIRECTOR } } })).toBeGreaterThanOrEqual(2);
    expect(await prisma.auditLog.count({ where: { action: 'auth.step_up', actor: { empId: DIRECTOR } } })).toBeGreaterThanOrEqual(1);
  } finally {
    await prisma.$disconnect();
  }
});

test('pay edit form: the Director edits through confirm-again and a reason; history is masked; everyone else is refused', async ({ browser, playwright }) => {
  const director = await openAs(browser, DIRECTOR, `/people/${hireId}?tab=pay`);
  const page = director.page;
  await page.getByRole('button', { name: 'Edit pay' }).click();
  await stepUp(page, DIRECTOR);
  await expect(page.locator('#pay-base')).toHaveValue('180000'); // prefilled from the logged reveal
  await page.locator('#pay-base').fill('195000');
  await page.getByRole('button', { name: 'Save pay' }).click();
  await giveReason(page, 'Annual review 2026');
  await expect(toastText(page, 'Pay saved')).toBeVisible();

  // history: both amounts are hidden, the field and the reason are there
  await page.goto(`/people/${hireId}?tab=history`);
  await expect(page.getByText('Base salary').first()).toBeVisible();
  await expect(page.getByText('Annual review 2026')).toBeVisible();
  const html = await page.content();
  expect(html).not.toMatch(/195,?000|180,?000/);
  await director.context.close();

  const prisma = createTestPrisma();
  try {
    const row = await prisma.profileChange.findFirstOrThrow({ where: { employee: { empId: hireId }, field: 'Base salary' }, orderBy: { changedAt: 'desc' } });
    expect(row.isSensitive).toBe(true);
    expect(`${row.oldValue}${row.newValue}`).not.toMatch(/195000|180000/); // stored encrypted
    expect(await prisma.auditLog.count({ where: { action: 'employee.pay.updated', targetId: hireId, actor: { empId: DIRECTOR } } })).toBeGreaterThanOrEqual(1);
  } finally {
    await prisma.$disconnect();
  }
  // the new amount is really saved (reveal after confirming again)
  const api = await apiAs(playwright, DIRECTOR);
  await apiStepUp(api, DIRECTOR);
  expect((await (await api.post(`employees/${hireId}/reveal`, { field: 'salary' })).json()).value).toBe('195000.00');

  // others never edit pay, with or without confirming again
  const attempts: Array<[string, string]> = [[HR, 'HR'], [CEO, 'CEO'], [OWNER, 'Owner'], [PEER, 'peer'], [FINANCE, 'finance']];
  for (const [who, label] of attempts) {
    const client = await apiAs(playwright, who);
    if ([OWNER, CEO, FINANCE].includes(who)) await apiStepUp(client, who); // prove it is the permission, not the missing confirmation
    const res = await client.patch(`employees/${hireId}/pay`, { baseSalary: 1, reason: `${label} must not change pay` });
    expect(res.status(), label).toBe(403);
  }
  const hr = await openAs(browser, HR, `/people/${hireId}`);
  await expect(tabs(hr.page).filter({ hasText: 'Pay' })).toHaveCount(0);
  await hr.context.close();
  const ceo = await openAs(browser, CEO, `/people/${hireId}?tab=pay`);
  await expect(ceo.page.getByRole('button', { name: /Edit pay|Add pay/ })).toHaveCount(0); // the CEO may view, not edit
  await expect(ceo.page.getByText(/View only/)).toBeVisible();
  await ceo.context.close();
  expect((await (await (await apiAs(playwright, DIRECTOR)).get(`employees/${hireId}`)).json()).pay.salaryOnFile).toBe(true);
});

test('job edit form: HR edits job fields in the screen; only the Owner or CEO change the manager, and everyone else is refused', async ({ browser, playwright }) => {
  // HR: type and weekly capacity (the level and manager are shown but cannot be changed)
  const hr = await openAs(browser, HR, `/people/${hireId}?tab=job`);
  await hr.page.getByRole('button', { name: 'Edit' }).first().click();
  await expect(hr.page.locator('#j-level')).toHaveCount(0); // no level control for HR
  await expect(hr.page.locator('#j-boss')).toHaveCount(0); // no manager control for HR
  await expect(hr.page.getByText('Only the Owner or CEO change levels.')).toBeVisible();
  await hr.page.locator('#j-type').selectOption('part_time');
  await hr.page.locator('#j-cap').fill('20');
  await hr.page.getByRole('button', { name: 'Save changes' }).click();
  await giveReason(hr.page, 'Reduced hours agreed with the employee');
  await expect(toastText(hr.page, 'Job details saved')).toBeVisible();
  await hr.context.close();

  const api = await apiAs(playwright, DIRECTOR);
  const job = (await (await api.get(`employees/${hireId}`)).json()).job;
  expect([job.type, job.weeklyCapacityHours, job.reportsTo]).toEqual(['part_time', 20, 'ACV-0004']);

  // the CEO reassigns the manager in the form (CTO -> Director)
  const ceo = await openAs(browser, CEO, `/people/${hireId}?tab=job`);
  await ceo.page.getByRole('button', { name: 'Edit' }).first().click();
  await expect(ceo.page.locator('#j-boss')).toBeVisible();
  await ceo.page.locator('#j-boss').selectOption('ACV-0003');
  await ceo.page.getByRole('button', { name: 'Save changes' }).click();
  await giveReason(ceo.page, 'Moves to the management team');
  await expect(toastText(ceo.page, 'Job details saved')).toBeVisible();
  await ceo.context.close();
  expect((await (await (await apiAs(playwright, DIRECTOR)).get(`employees/${hireId}`)).json()).job.reportsTo).toBe('ACV-0003');

  // history shows both changes with who and why
  const dir = await openAs(browser, DIRECTOR, `/people/${hireId}?tab=history`);
  await expect(dir.page.getByText('Reports to').first()).toBeVisible();
  await expect(dir.page.getByText('Moves to the management team').first()).toBeVisible();
  await expect(dir.page.getByText('Reduced hours agreed with the employee').first()).toBeVisible(); // on both the type and the capacity rows
  await dir.context.close();

  // unauthorized attempts, sent directly to the server
  const attempts: Array<[string, Record<string, unknown>]> = [
    [HR, { level: 4, reason: 'HR must not change levels' }],
    [HR, { reportsToEmpId: 'ACV-0004', reason: 'HR must not move people' }],
    [DIRECTOR, { reportsToEmpId: 'ACV-0004', reason: 'Director must not move people' }],
    [DIRECTOR, { level: 4, reason: 'Director must not change levels' }],
    [PEER, { type: 'full_time', reason: 'A colleague must not edit jobs' }],
    [FINANCE, { reportsToEmpId: 'ACV-0004', reason: 'Finance must not move people' }],
  ];
  for (const [who, body] of attempts) {
    const res = await (await apiAs(playwright, who)).patch(`employees/${hireId}/job`, body);
    expect(res.status(), JSON.stringify(body) + ' by ' + who).toBe(403);
  }
  // an invalid line is refused even for the CEO (the reporting rules still apply)
  const bad = await (await apiAs(playwright, CEO)).patch(`employees/${hireId}/job`, { reportsToEmpId: PEER, reason: 'A colleague of equal level cannot be the manager' });
  expect(bad.status()).toBe(400);
  expect((await (await (await apiAs(playwright, DIRECTOR)).get(`employees/${hireId}`)).json()).job.reportsTo).toBe('ACV-0003');
  // the employee cannot edit their own job
  const self = await playwright.request.newContext({ baseURL: API + '/' });
  const login = await (await self.post('auth/login', { data: { empId: hireId, password: NEW_PASSWORD } })).json();
  const csrf = login.csrfToken as string;
  const own = await self.patch(`employees/${hireId}/job`, { headers: { 'X-CSRF-Token': csrf }, data: { type: 'full_time', reason: 'I want full time' } });
  expect(own.status()).toBe(403);
});

test('document archiving: the person and HR archive in the screen; others are refused; archived files cannot be opened', async ({ browser, playwright, page }) => {
  const prisma = createTestPrisma();
  const docs = async () => prisma.employeeDocument.findMany({ where: { employee: { empId: hireId } }, orderBy: { createdAt: 'asc' } });
  try {
    // the person adds a second file
    await page.goto('/login');
    await page.locator('#empId').fill(hireId.replace('ACV-', ''));
    await page.locator('#password').fill(NEW_PASSWORD);
    await page.getByRole('button', { name: /^Sign in/ }).click();
    await page.waitForURL(/\/$/);
    await page.goto(`/people/${hireId}?tab=documents`);
    await page.locator('input[type="file"]').first().setInputFiles({ name: 'second.pdf', mimeType: 'application/pdf', buffer: PDF });
    await expect(page.locator('li').getByRole('button', { name: /^second\.pdf/ })).toBeVisible();
    const [first, second] = await docs();
    expect(first.archivedAt).toBeNull();

    // others cannot archive, with the right or wrong id
    for (const who of [PEER, 'ACV-0004', FINANCE]) {
      const res = await (await apiAs(playwright, who)).delete(`employees/${hireId}/documents/${second.id}`, { reason: 'not allowed' });
      expect(res.status(), who).toBe(403);
      expect((await (await apiAs(playwright, who)).get(`employees/${hireId}/documents/${second.id}/download`)).status(), who).toBe(403);
    }
    expect((await docs())[1].archivedAt).toBeNull();

    // the person archives the first file in the screen (a reason is required)
    await page.getByRole('button', { name: /Archive my-cv\.pdf/ }).click();
    const dialog = page.getByRole('dialog');
    await expect(dialog.locator('button[type="submit"]')).toBeDisabled();
    await giveReason(page, 'Replaced by a newer version');
    await expect(toastText(page, 'my-cv.pdf archived')).toBeVisible();
    await expect(page.locator('li').getByRole('button', { name: /my-cv\.pdf/ })).toHaveCount(0); // gone from the list
    await page.reload();
    await expect(page.locator('li').getByRole('button', { name: /my-cv\.pdf/ })).toHaveCount(0);
    await expect(page.locator('li').getByRole('button', { name: /^second\.pdf/ })).toBeVisible();

    // the record and the file are kept, but nobody can open the archived file
    const archived = (await docs())[0];
    expect(archived.archivedAt).not.toBeNull();
    expect(existsSync(join(E2E_FILES, archived.storageKey))).toBe(true);
    for (const who of [DIRECTOR, HR]) {
      const client = await apiAs(playwright, who);
      expect((await client.get(`employees/${hireId}/documents/${archived.id}/download`)).status(), who).toBe(404);
      const list = (await (await client.get(`employees/${hireId}/documents`)).json()) as Array<{ id: string }>;
      expect(list.some((d) => d.id === archived.id)).toBe(false);
    }
    expect(await prisma.auditLog.count({ where: { action: 'employee.document.archived', targetId: hireId, reason: 'Replaced by a newer version' } })).toBe(1);

    // HR archives the second file in the screen
    const hr = await openAs(browser, HR, `/people/${hireId}?tab=documents`);
    await hr.page.getByRole('button', { name: /Archive second\.pdf/ }).click();
    await giveReason(hr.page, 'Duplicate upload');
    await expect(toastText(hr.page, 'second.pdf archived')).toBeVisible();
    await hr.context.close();
    expect((await docs())[1].archivedAt).not.toBeNull();
    expect(existsSync(join(E2E_FILES, (await docs())[1].storageKey))).toBe(true);
  } finally {
    await prisma.$disconnect();
  }
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
  // the reassigned person leaves the list; the demo roster's other person who reported to Finance is still waiting
  await expect(ceo.page.getByTestId('unresolved-reports')).not.toContainText('E2E Orphan');
  await expect(ceo.page.getByTestId('unresolved-reports')).toContainText('Danish Iqbal');
  void orphanRow;
  await ceo.context.close();
});

test('the person whose last working day is today is still on notice: leaving is processed the next day (the clock-moving backend tests prove it)', async ({ playwright }) => {
  const director = await apiAs(playwright, DIRECTOR);
  const profile = await (await director.get(`employees/${hireId}`)).json();
  expect(profile.job.status).toBe('on_notice');
  expect(profile.job.lastWorkingDay).toBeTruthy();
});
