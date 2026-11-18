import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiAs, openAs } from './auth-helpers';
import { screenLoadsFromServer, stepUpApi } from './live-screen';

/**
 * Module 13 (customer billing, subscriptions and renewals) against the real server, logged in for real, with the
 * background workers on (the billing reader marks an invoice paid once its payment is posted in Module 9).
 */
const DEV = 'ACV-0006';
const FINANCE = 'ACV-0010';
const DIRECTOR = 'ACV-0003';

test.describe.configure({ mode: 'serial' });

const SCREENS: Array<{ who: string; path: string; endpoint: RegExp }> = [
  { who: FINANCE, path: '/billing', endpoint: /\/api\/v1\/billing\/overview$/ },
  { who: FINANCE, path: '/billing?tab=invoices', endpoint: /\/api\/v1\/billing\/invoices$/ },
  { who: FINANCE, path: '/billing?tab=customers', endpoint: /\/api\/v1\/billing\/customers$/ },
  { who: FINANCE, path: '/billing/invoices/new', endpoint: /\/api\/v1\/billing\/customers$/ },
  { who: DIRECTOR, path: '/billing?tab=settings', endpoint: /\/api\/v1\/settings\/modules\/billing$/ },
  { who: DIRECTOR, path: '/billing/subscriptions', endpoint: /\/api\/v1\/billing\/subscriptions$/ },
];

for (const s of SCREENS) {
  test(`${s.path} as ${s.who} loads from the real API`, async ({ browser }) => {
    const { page, context } = await openAs(browser, s.who, '/');
    await screenLoadsFromServer(page, s.path, s.endpoint);
    await context.close();
  });
}

let client = '';

test('an invoice made on the screen: a draft is not in the ledger; issuing creates its entry, waiting for approval', async ({ browser, playwright }) => {
  test.setTimeout(120_000);
  const fin = await apiAs(playwright, FINANCE);
  const c = await fin.post('/billing/customers', { name: `E2E Client ${Date.now()}`, contactName: 'Sara Ahmed', email: 'billing@e2e-client.test', currency: 'PKR', termsDays: 7 });
  expect(c.status(), await c.text()).toBe(201);
  client = (await c.json()).id;

  const { page, context } = await openAs(browser, FINANCE, '/');
  await screenLoadsFromServer(page, '/billing/invoices/new', /\/api\/v1\/billing\/customers$/);
  await page.locator('#customerId').selectOption(client);
  await page.getByLabel('Line 1 description').fill('Website maintenance, November');
  await page.getByLabel('Line 1 rate').fill('25000');
  await expect(page.getByText('No sales tax is added to invoices (decision D13).')).toBeVisible();
  await page.getByRole('button', { name: 'Issue invoice' }).click();
  await page.waitForURL(/\/billing\/invoices\/[0-9a-f-]{36}$/, { timeout: 30_000 });
  const id = page.url().split('/').pop()!;
  await expect(page.getByText(/^INV-\d{4}-\d{4}$/).first()).toBeVisible();
  await expect(page.getByText('waiting for approval').first()).toBeVisible();
  // the client is emailed only after the Director approves the entry: no email action yet
  await expect(page.getByText('Nothing is sent to the client until it is approved.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Email to client' })).toHaveCount(0);

  const detail = await (await fin.get(`/billing/invoices/${id}`)).json();
  expect(detail.invoice).toMatchObject({ status: 'issued', total: '25000.00', entryStatus: 'pending_approval' });
  expect(detail.reminders).toHaveLength(8); // 3 days before, on the day, 3 and 7 days after; client and staff
  await context.close();
});

test('the Director approves the entry; Finance records the payment on the screen; once approved the invoice is paid', async ({ browser, playwright }) => {
  test.setTimeout(150_000);
  const fin = await apiAs(playwright, FINANCE);
  const list = await (await fin.get(`/billing/invoices?partyId=${client}`)).json();
  const inv = list.items[0];
  const director = await apiAs(playwright, DIRECTOR);
  await stepUpApi(director, DIRECTOR);
  expect((await director.post(`/journal-entries/${inv.entryId}/approve`, {})).status()).toBe(200);

  const { page, context } = await openAs(browser, FINANCE, '/');
  await screenLoadsFromServer(page, `/billing/invoices/${inv.id}`, new RegExp(`/api/v1/billing/invoices/${inv.id}$`));
  // approved: emailing by hand is offered (customer emails are off here, so nothing was queued automatically)
  await expect(page.getByRole('button', { name: 'Email to client' })).toBeVisible();
  expect((await (await fin.get(`/billing/invoices/${inv.id}`)).json()).emails).toEqual([]);
  await page.getByRole('button', { name: 'Record payment' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByLabel('Received in')).toBeVisible();
  await dialog.getByLabel('Reference (optional)').fill('TT-E2E-1');
  await dialog.getByRole('button', { name: 'Record payment' }).click();
  await expect(page.getByText('recorded and waiting for approval').first()).toBeVisible({ timeout: 20_000 });

  const after = await (await fin.get(`/billing/invoices/${inv.id}`)).json();
  expect(after.invoice).toMatchObject({ status: 'issued', paid: '0.00', pendingPayments: '25000.00' }); // not paid until approved
  const payment = await (await fin.get(`/payments?partyId=${client}`)).json();
  expect((await director.post(`/journal-entries/${payment.items[0].entryId}/approve`, {})).status()).toBe(200);

  await expect.poll(async () => (await (await fin.get(`/billing/invoices/${inv.id}`)).json()).invoice.status, { timeout: 30_000 }).toBe('paid');
  // the billing reader (every 10 s) stops the remaining reminders once the payment is posted
  await expect
    .poll(async () => (await (await fin.get(`/billing/invoices/${inv.id}`)).json()).reminders.every((r: { status: string }) => r.status === 'skipped'), { timeout: 45_000, intervals: [2_000] })
    .toBe(true);
  await page.reload();
  await expect(page.getByText('Paid in full.')).toBeVisible();
  await context.close();
});

test('retries are safe: the same create request twice is one draft, with no ledger entry', async ({ playwright }) => {
  const fin = await apiAs(playwright, FINANCE);
  const body = { requestKey: randomUUID(), partyId: client, issueDate: new Date().toISOString().slice(0, 10), termsDays: 7, currency: 'PKR', lines: [{ description: 'Retry check', quantity: '1', unitPrice: '100.00' }] };
  const a = await (await fin.post('/billing/invoices', body)).json();
  const b = await (await fin.post('/billing/invoices', body)).json();
  expect(b.invoice.id).toBe(a.invoice.id);
  expect(a.invoice).toMatchObject({ status: 'draft', entryId: null });
});

test('subscriptions: the Director adds one and sees it on the screen; Finance views only; a developer gets "not found"', async ({ browser, playwright }) => {
  const director = await apiAs(playwright, DIRECTOR);
  const r = await director.post('/billing/subscriptions', { vendor: 'E2E Hosting', product: 'VPS', category: 'hosting', ownerEmpId: DIRECTOR, plan: 'Standard', cost: '12.00', currency: 'USD', period: 'monthly', renewalDate: '2027-01-15', alertDaysBefore: 7, usageMetric: 'Bandwidth', usageUnit: 'GB', usageLimit: '1000' });
  expect(r.status(), await r.text()).toBe(201);
  const fin = await apiAs(playwright, FINANCE);
  expect((await fin.post('/billing/subscriptions', {})).status()).toBe(404);
  const { page, context } = await openAs(browser, DIRECTOR, '/');
  await screenLoadsFromServer(page, '/billing/subscriptions', /\/api\/v1\/billing\/subscriptions$/);
  await expect(page.getByText('E2E Hosting').first()).toBeVisible();
  await context.close();
  const dev = await apiAs(playwright, DEV);
  for (const path of ['/billing/overview', '/billing/invoices', '/billing/subscriptions', '/billing/customers']) expect((await dev.get(path)).status(), path).toBe(404);
});
