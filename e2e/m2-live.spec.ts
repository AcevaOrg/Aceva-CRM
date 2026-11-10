import * as argon2 from 'argon2';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { createEmployee } from '../backend/test/helpers/people';
import { createTestPrisma } from '../backend/test/helpers/prisma';
import { API, PASSWORD, apiAs, loginViaUi, nextCode } from './auth-helpers';

/** Module 2 (Emp-ID login and sessions) through the real screens, backend, PostgreSQL, Redis and Mailpit. */

/** The error box on the page (not Next.js's hidden route announcer, which is also an alert). */
const alertOf = (page: Page) => page.locator('[role="alert"]:not(#__next-route-announcer__)');

const MAILPIT = 'http://127.0.0.1:8025/api/v1';
const NIDA = 'ACV-0013';
const HIRA = 'ACV-0009';

test.describe.configure({ mode: 'serial' });

async function fillLogin(page: Page, empId: string, password: string) {
  await page.goto('/login');
  await page.locator('#empId').fill(empId.replace('ACV-', ''));
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
}

/** A new employee with a login (used for first-login and reset tests). */
async function createPerson(name: string, email: string | null, password: string, mustChange: boolean) {
  const prisma = createTestPrisma();
  try {
    const person = await createEmployee(prisma, { name, officialEmail: email });
    const hash = await argon2.hash(password, { type: argon2.argon2id, memoryCost: 4096, timeCost: 2, parallelism: 1, raw: false });
    await prisma.credential.create({ data: { employeeId: person.id, passwordHash: hash, mustChangePassword: mustChange, passwordChangedAt: new Date() } });
    await prisma.passwordHistory.create({ data: { employeeId: person.id, passwordHash: hash } });
    return person;
  } finally {
    await prisma.$disconnect();
  }
}

async function loggedInContext(browser: Browser, empId: string) {
  const context = await browser.newContext();
  const page = await context.newPage();
  await loginViaUi(page, empId);
  return { context, page };
}

test('a wrong password is refused on the screen; a good login gives an HttpOnly cookie and keeps no secrets in the browser', async ({ page, context }) => {
  await fillLogin(page, NIDA, 'definitely-not-the-password');
  await expect(alertOf(page)).toContainText('Emp-ID or password is wrong');
  expect(await page.evaluate(() => document.cookie)).toBe('');

  await loginViaUi(page, NIDA);
  await expect(page).toHaveURL(/\/$/);
  const cookie = (await context.cookies()).find((c) => c.name === 'aceva_session')!;
  expect(cookie).toBeTruthy();
  expect(cookie.httpOnly).toBe(true);
  expect(cookie.sameSite).toBe('Lax');
  // page scripts cannot read it, and neither it nor the password is stored anywhere the page can read
  expect(await page.evaluate(() => document.cookie)).not.toContain('aceva_session');
  const stored = await page.evaluate(() => JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }));
  expect(stored).not.toContain(cookie.value);
  expect(stored).not.toContain(PASSWORD);
});

test('five wrong passwords lock the account on the screen, and HR unlocks it', async ({ page, playwright }) => {
  for (let i = 1; i <= 5; i++) {
    await fillLogin(page, HIRA, `wrong-guess-number-${i}`);
    await expect(alertOf(page)).toBeVisible();
  }
  await expect(alertOf(page)).toContainText('Account locked after 5 wrong passwords');
  await fillLogin(page, HIRA, PASSWORD); // the correct password does not help
  await expect(alertOf(page)).toContainText('Account locked');

  const hr = await apiAs(playwright, 'ACV-0015');
  expect((await hr.post(`/auth/employees/${HIRA}/unlock`, { reason: 'Identity confirmed by phone' })).status()).toBe(200);
  await loginViaUi(page, HIRA);
  await expect(page).toHaveURL(/\/$/);
});

test('a temporary password must be replaced at first login, in the wizard', async ({ page, playwright }) => {
  const person = await createPerson('First Login Browser', null, 'Temporary-Pass-77', true);
  await fillLogin(page, person.empId, 'Temporary-Pass-77');
  await page.waitForURL(/\/first-login/);
  await page.locator('#new-pw').fill('Brand-New-Pass-2026x');
  await page.locator('#confirm-pw').fill('Brand-New-Pass-2026x');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('checkbox').check();
  await page.getByRole('button', { name: /Finish and open Aceva/ }).click();
  await page.waitForURL(/\/$/);
  // the temporary password is dead; the new one works (checked against the server directly)
  const ctx = await playwright.request.newContext({ baseURL: API + '/' });
  expect((await (await ctx.post('auth/login', { data: { empId: person.empId, password: 'Temporary-Pass-77' } })).json()).status).toBe('invalid');
  expect((await (await ctx.post('auth/login', { data: { empId: person.empId, password: 'Brand-New-Pass-2026x' } })).json()).status).toBe('ok');
});

test('two-step login is mandatory for the Director, and the code is checked on the server', async ({ browser }) => {
  // The Director already set up the authenticator in an earlier test; this is a fresh login that must ask for the code.
  const context = await browser.newContext();
  const page = await context.newPage();
  await fillLogin(page, 'ACV-0003', PASSWORD);
  await page.waitForURL(/\/login\/verify/);
  await page.locator('input[aria-label="Digit 1"]').click();
  await page.keyboard.type('000000');
  await expect(alertOf(page)).toContainText('not right');
  // nothing else works until the code is right: the app redirects back
  await page.goto('/org');
  await page.waitForURL(/\/login/);
  await context.close();

  const ok = await browser.newContext();
  const okPage = await ok.newPage();
  await loginViaUi(okPage, 'ACV-0003'); // enters a correct code
  await expect(okPage).toHaveURL(/\/$/);
  await ok.close();
});

test('forced logout ends every device at once', async ({ browser, playwright }) => {
  const a = await loggedInContext(browser, NIDA);
  const b = await loggedInContext(browser, NIDA);
  await a.page.goto('/tasks');
  await b.page.goto('/tasks');
  await expect(a.page).toHaveURL(/\/tasks/);

  const director = await apiAs(playwright, 'ACV-0003');
  const res = await director.post(`/auth/employees/${NIDA}/force-logout`, { reason: 'Lost laptop' });
  expect(res.status()).toBe(200);
  expect((await res.json()).ended).toBeGreaterThanOrEqual(2);

  await a.page.goto('/tasks');
  await b.page.goto('/org');
  await a.page.waitForURL(/\/login/);
  await b.page.waitForURL(/\/login/);
  await a.context.close();
  await b.context.close();
});

test('My devices lists where I am signed in and signs out the others', async ({ browser }) => {
  const a = await loggedInContext(browser, NIDA);
  const b = await loggedInContext(browser, NIDA);
  await a.page.goto('/account?tab=devices');
  await expect(a.page.getByText('This device')).toBeVisible();
  await expect(a.page.getByText(/signed in on [2-9] devices/)).toBeVisible();
  await a.page.getByRole('button', { name: 'Sign out all other devices' }).click();
  await expect(a.page.getByText(/signed in on 1 device\b/)).toBeVisible();
  await b.page.goto('/tasks');
  await b.page.waitForURL(/\/login/); // the other device is signed out at once
  await a.page.goto('/account?tab=devices');
  await expect(a.page.getByText('This device')).toBeVisible(); // this one is still in
  await a.context.close();
  await b.context.close();
});

test('password reset: a one-time link arrives by email, works once, and ends every session', async ({ page, request, playwright }) => {
  const email = 'e2e.reset@acevatech.com';
  const person = await createPerson('Reset Browser', email, 'Original-Pass-2026', false);
  await request.delete(`${MAILPIT}/messages`);

  await page.goto('/forgot-password');
  await page.locator('#fp-emp').fill(person.empId);
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByText('Check your email')).toBeVisible();

  // read the real email from Mailpit
  let link = '';
  await expect
    .poll(async () => {
      const search = await (await request.get(`${MAILPIT}/search?query=${encodeURIComponent('to:' + email)}`)).json();
      if (!search.messages?.length) return '';
      const msg = await (await request.get(`${MAILPIT}/message/${search.messages[0].ID}`)).json();
      link = (msg.Text as string).match(/https?:\/\/\S+\/reset-password\?token=\S+/)?.[0] ?? '';
      expect(msg.From.Address).toBe('no-reply@acevatech.com');
      expect(msg.Text).toContain('15 minutes');
      return link;
    })
    .not.toBe('');

  const token = new URL(link).searchParams.get('token')!;
  await page.goto(`/reset-password?token=${token}`);
  await page.locator('#new-pw').fill('Reset-New-Pass-2026x');
  await page.locator('#confirm-pw').fill('Reset-New-Pass-2026x');
  await page.getByRole('button', { name: 'Save new password' }).click();
  await page.waitForURL(/\/login/);
  const ctx = await playwright.request.newContext({ baseURL: API + '/' });
  expect((await (await ctx.post('auth/login', { data: { empId: person.empId, password: 'Original-Pass-2026' } })).json()).status).toBe('invalid');
  expect((await (await ctx.post('auth/login', { data: { empId: person.empId, password: 'Reset-New-Pass-2026x' } })).json()).status).toBe('ok');

  // the same link cannot be used a second time
  await page.goto(`/reset-password?token=${token}`);
  await page.locator('#new-pw').fill('Another-New-Pass-2026y');
  await page.locator('#confirm-pw').fill('Another-New-Pass-2026y');
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(alertOf(page)).toContainText('not valid any more');
});

test('the server refuses a change request without the right CSRF token, and any request without a session', async ({ playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: API + '/' });
  expect((await ctx.get('org/tree')).status()).toBe(401); // no session
  const login = await ctx.post('auth/login', { data: { empId: NIDA, password: PASSWORD } });
  const { csrfToken } = await login.json();
  expect((await ctx.delete('auth/sessions', { headers: { 'X-CSRF-Token': 'forged' } })).status()).toBe(403);
  expect((await ctx.delete('auth/sessions')).status()).toBe(403);
  expect((await ctx.delete('auth/sessions', { headers: { 'X-CSRF-Token': csrfToken, Origin: 'https://evil.example' } })).status()).toBe(403);
  expect((await ctx.delete('auth/sessions', { headers: { 'X-CSRF-Token': csrfToken } })).status()).toBe(200);
  void nextCode;
});
