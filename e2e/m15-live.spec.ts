import { expect, test } from '@playwright/test';
import { apiAs, openAs } from './auth-helpers';
import { screenLoadsFromServer } from './live-screen';

/**
 * Module 15.1 (leads and companies) against the real server, logged in for real: a salesperson adds a lead on the
 * screen (with the duplicate check as they type), another salesperson is stopped by the duplicate check and sees only
 * that the lead exists and who owns it, and the Director (sales manager) moves the lead with a reason.
 */
const HIRA = 'ACV-0009';
const KAMRAN = 'ACV-0012';
const DIRECTOR = 'ACV-0003';
const FINANCE = 'ACV-0010';

test.describe.configure({ mode: 'serial' });

const run = Date.now();
const email = `ayesha.${run}@acme-e2e.test`;
const website = `acme-${run}.test`;
let leadId = '';

for (const who of [HIRA, DIRECTOR]) {
  test(`/sales/leads as ${who} loads from the real API`, async ({ browser }) => {
    const { page, context } = await openAs(browser, who, '/');
    await screenLoadsFromServer(page, '/sales/leads', /\/api\/v1\/sales\/leads$/);
    await context.close();
  });
}

test('the API refuses people without sales access (Finance)', async ({ playwright }) => {
  const fin = await apiAs(playwright, FINANCE);
  expect((await fin.get('/sales/leads')).status()).toBe(403);
});

test('a salesperson adds a lead on the screen; it is theirs, with its company', async ({ browser, playwright }) => {
  test.setTimeout(120_000);
  const { page, context } = await openAs(browser, HIRA, '/');
  await screenLoadsFromServer(page, '/sales/leads', /\/api\/v1\/sales\/leads$/);
  await page.getByRole('button', { name: 'Add lead' }).first().click(); // the header button (an empty list shows a second one)
  await expect(page.locator('#ld-name')).toBeVisible();
  await page.locator('#ld-name').fill('Ayesha Khan');
  await page.locator('#ld-company').fill('Acme E2E');
  await page.locator('#ld-web').fill(`https://www.${website}/about`);
  const checked = page.waitForResponse((r) => r.url().endsWith('/api/v1/sales/leads/check-duplicate') && r.status() === 200, { timeout: 30_000 });
  await page.locator('#ld-email').fill(email);
  await checked;
  await expect(page.getByText('No duplicate found.')).toBeVisible();
  const created = page.waitForResponse((r) => r.url().endsWith('/api/v1/sales/leads') && r.request().method() === 'POST', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Add lead' }).last().click();
  const res = await created;
  expect(res.status(), await res.text()).toBe(201);
  const lead = await res.json();
  leadId = lead.id;
  expect(lead).toMatchObject({ fullName: 'Ayesha Khan', owner: { empId: HIRA }, company: { name: 'Acme E2E', domain: website } });
  await expect(page.getByText('Ayesha Khan').first()).toBeVisible();
  const api = await apiAs(playwright, HIRA);
  expect((await (await api.get(`/sales/leads/${leadId}`)).json()).restricted).toBe(false);
  await context.close();
});

test('another salesperson is stopped by the duplicate check and sees only who owns the lead', async ({ browser }) => {
  test.setTimeout(120_000);
  const { page, context } = await openAs(browser, KAMRAN, '/');
  await screenLoadsFromServer(page, '/sales/leads', /\/api\/v1\/sales\/leads$/);
  await page.getByRole('button', { name: 'Add lead' }).first().click(); // the header button (an empty list shows a second one)
  await expect(page.locator('#ld-name')).toBeVisible();
  await page.locator('#ld-name').fill('Ayesha K.');
  await page.locator('#ld-company').fill('Acme');
  const checked = page.waitForResponse((r) => r.url().endsWith('/api/v1/sales/leads/check-duplicate') && r.status() === 200, { timeout: 30_000 });
  await page.locator('#ld-email').fill(email.toUpperCase());
  await checked;
  await expect(page.getByText('This lead already exists.')).toBeVisible();
  await expect(page.getByRole('link', { name: /View existing/ })).toBeVisible();
  await page.keyboard.press('Escape');

  await screenLoadsFromServer(page, `/sales/leads/${leadId}`, new RegExp(`/api/v1/sales/leads/${leadId}$`));
  await expect(page.getByText('This lead belongs to someone else')).toBeVisible();
  await expect(page.getByText(email)).toHaveCount(0);
  await context.close();
});

test('the Director moves the lead to another salesperson, with a reason', async ({ browser, playwright }) => {
  test.setTimeout(120_000);
  const { page, context } = await openAs(browser, DIRECTOR, '/');
  await screenLoadsFromServer(page, `/sales/leads/${leadId}`, new RegExp(`/api/v1/sales/leads/${leadId}$`));
  await page.locator('select').filter({ has: page.locator(`option[value="${KAMRAN}"]`) }).selectOption(KAMRAN);
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('Kamran covers the UK accounts');
  const moved = page.waitForResponse((r) => r.url().endsWith(`/api/v1/sales/leads/${leadId}/owner`), { timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Move lead' }).click();
  expect((await moved).status()).toBe(200);
  const api = await apiAs(playwright, KAMRAN);
  const lead = await (await api.get(`/sales/leads/${leadId}`)).json();
  expect(lead).toMatchObject({ restricted: false, owner: { empId: KAMRAN } });
  await context.close();
});
