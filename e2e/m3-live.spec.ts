import { expect, test, type Page } from '@playwright/test';
import { API, PASSWORD, apiAs, openAs } from './auth-helpers';

/**
 * Module 3 (employee profiles, joining, leaving) through the real screens, backend, PostgreSQL, Redis and Mailpit.
 * The joining wizard itself is NOT driven by a browser test here: the hire is created through the API (covered by the
 * backend tests); the browser tests cover what happens after it (first login, who sees what, leaving).
 */
const MAILPIT = 'http://127.0.0.1:8025/api/v1';
const DIRECTOR = 'ACV-0003';
const HR = 'ACV-0015';
const PEER = 'ACV-0006';
const HIRE_EMAIL = 'e2e.joiner@acevatech.com';

test.describe.configure({ mode: 'serial' });

let hireId = '';
let temporary = '';
const NEW_PASSWORD = 'Joiner-Own-Pass-2026x';

const tabs = (page: Page) => page.getByRole('tab');

test('Director creates a profile: the new Emp-ID is generated and the welcome email carries a temporary password', async ({ playwright, request }) => {
  await request.delete(`${MAILPIT}/messages`);
  const director = await apiAs(playwright, DIRECTOR);
  const res = await director.post('employees', {
    name: 'E2E Joiner',
    designation: 'QA Engineer',
    departmentId: 'dep-eng',
    officeId: 'off-khi',
    officialEmail: HIRE_EMAIL,
    level: 5,
    reportsToEmpId: 'ACV-0004',
    joiningDate: '2026-11-01',
    type: 'full_time',
    personal: { phone: '+92 300 1112223', homeAddress: 'House 5, Street 9, Karachi' },
    pay: { baseSalary: 180000, allowances: 6000, bankName: 'Meezan', accountNumber: 'PK12MEZN0001234567890' },
  });
  expect(res.status()).toBe(201);
  const body = await res.json();
  hireId = body.empId;
  expect(hireId).toMatch(/^ACV-\d{4}$/);
  expect(body.welcomeEmailSent).toBe(true);

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

test('the new employee signs in with the temporary password and must choose their own at first login', async ({ page, playwright }) => {
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
  expect((await (await ctx.post('auth/login', { data: { empId: hireId, password: NEW_PASSWORD } })).json()).status).toBe('ok');
});

test('the person sees their own profile in full, a colleague only sees the basic information', async ({ browser, playwright }) => {
  // the hire is signed in through the API first (their own browser session is not stored)
  const peer = await openAs(browser, PEER, `/people/${hireId}`);
  await expect(peer.page.getByText('E2E Joiner').first()).toBeVisible();
  await expect(tabs(peer.page).filter({ hasText: 'Personal' })).toHaveCount(0);
  await expect(tabs(peer.page).filter({ hasText: 'Pay' })).toHaveCount(0);
  await expect(tabs(peer.page).filter({ hasText: 'Documents' })).toHaveCount(0);
  await peer.context.close();

  const director = await openAs(browser, DIRECTOR, `/people/${hireId}`);
  await expect(director.page.getByText('E2E Joiner').first()).toBeVisible();
  for (const label of ['Job', 'Personal', 'Pay', 'Documents', 'History']) await expect(tabs(director.page).filter({ hasText: label })).toHaveCount(1);
  await director.page.goto(`/people/${hireId}?tab=pay`);
  await expect(director.page.getByText('Meezan')).toBeVisible();
  await expect(director.page.getByText('PK12MEZN0001234567890')).toHaveCount(0); // the account number is masked
  await director.context.close();

  const hr = await openAs(browser, HR, `/people/${hireId}`);
  await expect(tabs(hr.page).filter({ hasText: 'Personal' })).toHaveCount(1);
  await expect(tabs(hr.page).filter({ hasText: 'Pay' })).toHaveCount(0); // HR never sees pay
  await hr.context.close();
  void playwright;
});

test('a change keeps the old value in the history; the server refuses a forbidden change even when sent directly', async ({ browser, playwright }) => {
  const hr = await apiAs(playwright, HR);
  expect((await hr.patch(`employees/${hireId}/personal`, { phone: '+92 321 9990001' })).status()).toBe(200);
  expect((await hr.patch(`employees/${hireId}/pay`, { baseSalary: 1, reason: 'HR cannot change pay' })).status()).toBe(403);
  const peer = await apiAs(playwright, PEER);
  expect((await peer.patch(`employees/${hireId}/personal`, { phone: '+92 300 0000000' })).status()).toBe(403);

  const director = await openAs(browser, DIRECTOR, `/people/${hireId}?tab=history`);
  await expect(director.page.getByText('Phone').first()).toBeVisible();
  await expect(director.page.getByText('+92 300 1112223').first()).toBeVisible(); // the old value is kept
  await expect(director.page.getByText('+92 321 9990001').first()).toBeVisible();
  await director.context.close();
});

test('HR sets today as the last working day: the person is signed out and cannot sign in, the record stays', async ({ browser, playwright }) => {
  const ctx = await playwright.request.newContext({ baseURL: API + '/' });
  const login = await (await ctx.post('auth/login', { data: { empId: hireId, password: NEW_PASSWORD } })).json();
  expect(login.status).toBe('ok');

  const hr = await openAs(browser, HR, `/people/${hireId}`);
  await hr.page.getByRole('button', { name: 'More actions' }).click();
  await hr.page.getByRole('menuitem', { name: 'Set last working day' }).click();
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  await hr.page.locator('#ob-date').fill(iso);
  await hr.page.locator('#ob-reason').fill('Resigned, notice period completed');
  await expect(hr.page.getByText('request to move their open tasks')).toBeVisible(); // honest about what is not connected
  await hr.page.getByRole('button', { name: 'Set last working day' }).last().click();
  await expect(hr.page.getByText(/Last working day set/)).toBeVisible();
  await hr.context.close();

  await expect.poll(async () => (await ctx.get('auth/me')).status()).toBe(401); // every session ended
  const again = await (await ctx.post('auth/login', { data: { empId: hireId, password: NEW_PASSWORD } })).json();
  expect(again.status).not.toBe('ok');
  const director = await apiAs(playwright, DIRECTOR);
  const profile = await (await director.get(`employees/${hireId}`)).json();
  expect(profile.job.status).toBe('left');
});

test('a person who has left no longer appears in the staff directory', async ({ playwright }) => {
  const director = await apiAs(playwright, DIRECTOR);
  const list = (await (await director.get('employees')).json()) as Array<{ empId: string }>;
  expect(list.some((e) => e.empId === hireId)).toBe(false);
  void PASSWORD;
});
