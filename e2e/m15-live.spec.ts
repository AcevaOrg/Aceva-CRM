import { expect, test } from '@playwright/test';
import { apiAs, openAs } from './auth-helpers';
import { screenLoadsFromServer } from './live-screen';

/**
 * Module 15.1 (leads and companies) against the real server, logged in for real: a salesperson adds a lead on the
 * screen (with the duplicate check as they type), another salesperson is stopped by the duplicate check and sees only
 * that the lead exists and who owns it, and the Director (sales manager) moves the lead with a reason. Module 15.2: a deal
 * made and moved on the screen, Won asked for by the salesperson and confirmed by the Director (Billing makes one draft
 * invoice), and Lost with a reason from the settings. Module 15.3: a logged call moves a deal forward, a proposal link, and
 * a follow-up completed from My sales day.
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

// ------------------------------------------------------------------------------------------------- M15.2: the pipeline

const dealLead = { id: '' };
let dealId = '';

test('a salesperson creates a deal on the lead page and moves it through the pipeline; each move is in the history', async ({ browser, playwright }) => {
  test.setTimeout(150_000);
  const hira = await apiAs(playwright, HIRA);
  const created = await hira.post('/sales/leads', { fullName: 'Bilal Raza', source: 'referral', email: `bilal.${run}@contoso-e2e.test`, company: { name: 'Contoso E2E', website: `contoso-${run}.test` } });
  expect(created.status(), await created.text()).toBe(201);
  dealLead.id = (await created.json()).id;

  const { page, context } = await openAs(browser, HIRA, '/');
  await screenLoadsFromServer(page, `/sales/leads/${dealLead.id}`, new RegExp(`/api/v1/sales/leads/${dealLead.id}$`));
  await page.getByRole('button', { name: 'Create deal' }).click();
  await page.locator('#dl-service').selectOption('custom_software');
  await page.locator('#dl-amount').fill('4500');
  await page.locator('#dl-next').fill('Send the scope document');
  const posted = page.waitForResponse((r) => r.url().endsWith('/api/v1/sales/deals') && r.request().method() === 'POST', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Create deal' }).last().click();
  const res = await posted;
  expect(res.status(), await res.text()).toBe(201);
  const deal = await res.json();
  dealId = deal.id;
  expect(deal).toMatchObject({ stage: 'new', service: 'custom_software', value: '4500.00', currency: 'USD', owner: { empId: HIRA }, nextStep: 'Send the scope document' });
  await page.waitForURL(new RegExp(`/sales/deals/${dealId}$`), { timeout: 30_000 });

  // move to Contacted, then Proposal sent, from the deal page
  for (const [stage, label] of [['contacted', 'Contacted'], ['proposal_sent', 'Proposal sent']] as const) {
    const moved = page.waitForResponse((r) => r.url().endsWith(`/api/v1/sales/deals/${dealId}/move`), { timeout: 30_000 });
    await page.getByLabel('Move to stage').selectOption(stage);
    expect((await moved).status()).toBe(200);
    await expect(page.getByText(`Moved to ${label}`).first()).toBeVisible();
  }
  const now = await (await hira.get(`/sales/deals/${dealId}`)).json();
  expect(now.stage).toBe('proposal_sent');
  expect(now.history.map((h: { event: string; toStage: string }) => `${h.event}:${h.toStage}`)).toEqual(['created:new', 'stage_changed:contacted', 'stage_changed:proposal_sent']);
  await context.close();
});

test('Won: the salesperson marks it Won, the Director confirms it, and Billing makes one draft invoice from it', async ({ browser, playwright }) => {
  test.setTimeout(150_000);
  const hira = await openAs(browser, HIRA, '/');
  await screenLoadsFromServer(hira.page, `/sales/deals/${dealId}`, new RegExp(`/api/v1/sales/deals/${dealId}$`));
  const asked = hira.page.waitForResponse((r) => r.url().endsWith(`/api/v1/sales/deals/${dealId}/request-won`), { timeout: 30_000 });
  await hira.page.getByLabel('Move to stage').selectOption('won');
  expect((await asked).status()).toBe(200);
  await expect(hira.page.getByText('Won · waiting for confirmation')).toBeVisible(); // the stage badge
  await expect(hira.page.getByText(/^Won · waiting for .+ \(Director\)$/)).toBeVisible(); // the banner: the Director confirms
  await expect(hira.page.getByRole('button', { name: 'Confirm won' })).toHaveCount(0); // never the owner
  await hira.context.close();

  const director = await openAs(browser, DIRECTOR, '/');
  await screenLoadsFromServer(director.page, `/sales/deals/${dealId}`, new RegExp(`/api/v1/sales/deals/${dealId}$`));
  const confirmed = director.page.waitForResponse((r) => r.url().endsWith(`/api/v1/sales/deals/${dealId}/confirm-won`), { timeout: 30_000 });
  await director.page.getByRole('button', { name: 'Confirm won' }).click();
  expect((await confirmed).status()).toBe(200);
  await director.context.close();

  const api = await apiAs(playwright, DIRECTOR);
  const deal = await (await api.get(`/sales/deals/${dealId}`)).json();
  expect(deal).toMatchObject({ stage: 'won', wonStatus: 'confirmed', wonConfirmedBy: { empId: DIRECTOR } });
  // the billing reader runs on its own timer: the handover appears within a few seconds, exactly once
  await expect.poll(async () => (await (await api.get(`/sales/deals/${dealId}`)).json()).handover?.status, { timeout: 45_000 }).toBe('drafted');
  const fin = await apiAs(playwright, FINANCE);
  const invoices = await (await fin.get(`/billing/invoices`)).json();
  expect(invoices.items.filter((i: { sourceDealNumber: string | null }) => i.sourceDealNumber === deal.number)).toHaveLength(1);
});

test('the Director sets the lost reasons and the re-contact period in Settings > Sales (live; empty until set)', async ({ browser, playwright }) => {
  test.setTimeout(150_000);
  const { page, context } = await openAs(browser, DIRECTOR, '/');
  await screenLoadsFromServer(page, '/settings?section=sales', /\/api\/v1\/settings\/modules\/sales$/);
  await expect(page.getByText('Lost deals are blocked until the reasons and the period are set')).toBeVisible();
  await expect(page.locator('#ss-months')).toHaveValue(''); // nothing invented
  const reasons = page.getByPlaceholder('Add a reason');
  for (const r of ['Price', 'No reply']) {
    await reasons.fill(r);
    await reasons.press('Enter');
  }
  await page.locator('#ss-months').fill('3');
  await page.getByRole('button', { name: 'Save' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox').fill('Management approved the lost reasons');
  const saved = page.waitForResponse((r) => r.url().endsWith('/api/v1/settings/modules/sales') && r.request().method() === 'PUT', { timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Save' }).click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByText('Lost deals can be recorded')).toBeVisible();
  await context.close();
  const dir = await apiAs(playwright, DIRECTOR);
  expect((await (await dir.get('/settings/modules/sales')).json()).value).toMatchObject({ lostReasons: ['Price', 'No reply'], recontactMonths: 3 });
  // a salesperson may read them but not change them
  const hira = await apiAs(playwright, HIRA);
  const current = await (await hira.get('/settings/modules/sales')).json();
  expect((await hira.put('/settings/modules/sales', { value: current.value, version: current.version, reason: 'Not allowed to change' })).status()).toBe(403);
});

test('the live pipeline shows totals per original currency and offers no USD/PKR conversion', async ({ browser }) => {
  test.setTimeout(120_000);
  const { page, context } = await openAs(browser, HIRA, '/');
  await screenLoadsFromServer(page, '/sales/pipeline', /\/api\/v1\/sales\/deals$/);
  await expect(page.getByRole('radiogroup', { name: 'Display currency' })).toHaveCount(0);
  await expect(page.getByLabel('Display currency')).toHaveCount(0);
  await expect(page.getByText('per currency').first()).toBeVisible();
  await context.close();
});

test('Lost: the reason comes from the settings, and the lead may be contacted again after the set months', async ({ browser, playwright }) => {
  test.setTimeout(150_000);

  const hira = await apiAs(playwright, HIRA);
  const lead = await hira.post('/sales/leads', { fullName: 'Lena Park', source: 'website', email: `lena.${run}@fabrikam-e2e.test`, company: { name: 'Fabrikam E2E', website: `fabrikam-${run}.test` } });
  const leadId2 = (await lead.json()).id;
  const nextDay = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
  const close = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const made = await hira.post('/sales/deals', { leadId: leadId2, service: 'website', value: '900.00', currency: 'USD', expectedClose: close, nextStep: 'Call back', nextStepDate: nextDay });
  expect(made.status(), await made.text()).toBe(201);
  const lostId = (await made.json()).id;

  const { page, context } = await openAs(browser, HIRA, '/');
  await screenLoadsFromServer(page, `/sales/deals/${lostId}`, new RegExp(`/api/v1/sales/deals/${lostId}$`));
  await page.getByLabel('Move to stage').selectOption('lost');
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByText('The lead can be contacted again after 3 months.')).toBeVisible();
  await dialog.getByRole('combobox').selectOption('No reply');
  const moved = page.waitForResponse((r) => r.url().endsWith(`/api/v1/sales/deals/${lostId}/move`), { timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Mark as lost' }).click();
  expect((await moved).status()).toBe(200);
  const lost = await (await hira.get(`/sales/deals/${lostId}`)).json();
  expect(lost).toMatchObject({ stage: 'lost', lostReason: 'No reply' });
  expect(lost.recontactAfter).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  await context.close();
});

// --------------------------------------------------------------------------------- M15.3: activities and follow-ups

const today = () => new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10); // Pakistan day
let actDeal = '';

test('logging a call on the deal page moves the deal forward and shows on the timeline as Manual', async ({ browser, playwright }) => {
  test.setTimeout(150_000);
  const hira = await apiAs(playwright, HIRA);
  const lead = await hira.post('/sales/leads', { fullName: 'Sara Ali', source: 'referral', email: `sara.${run}@tailspin-e2e.test`, company: { name: 'Tailspin E2E', website: `tailspin-${run}.test` } });
  const leadId3 = (await lead.json()).id;
  const close = new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10);
  const made = await hira.post('/sales/deals', { leadId: leadId3, service: 'ai_automation', value: '3000.00', currency: 'USD', expectedClose: close, nextStep: 'Call to qualify', nextStepDate: today() });
  expect(made.status(), await made.text()).toBe(201);
  actDeal = (await made.json()).id;

  const { page, context } = await openAs(browser, HIRA, '/');
  await screenLoadsFromServer(page, `/sales/deals/${actDeal}`, new RegExp(`/api/v1/sales/deals/${actDeal}$`));
  await page.getByRole('button', { name: 'Log activity' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#la-kind').selectOption('call');
  await dialog.locator('#la-summary').fill('Qualification call, budget confirmed');
  const posted = page.waitForResponse((r) => r.url().endsWith(`/api/v1/sales/deals/${actDeal}/activities`) && r.request().method() === 'POST', { timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Log activity' }).click();
  const res = await posted;
  expect(res.status(), await res.text()).toBe(201);
  expect(await res.json()).toMatchObject({ activity: { kind: 'call', source: 'manual', actor: { empId: HIRA } }, stageChange: { from: 'new', to: 'contacted' } });
  await expect(page.getByText('The deal moved to Contacted.')).toBeVisible(); // the message says the deal moved
  await expect(page.getByText('Qualification call, budget confirmed')).toBeVisible();
  const deal = await (await hira.get(`/sales/deals/${actDeal}`)).json();
  expect(deal.stage).toBe('contacted');
  const timeline = await (await hira.get(`/sales/deals/${actDeal}/activities`)).json();
  expect(timeline[0]).toMatchObject({ kind: 'call', source: 'manual', summary: 'Qualification call, budget confirmed' });
  await context.close();
});

test('a proposal is a checked link only: a bad link cannot be sent; a good one is shown and moves the deal to Proposal sent', async ({ browser, playwright }) => {
  test.setTimeout(150_000);
  const { page, context } = await openAs(browser, HIRA, '/');
  await screenLoadsFromServer(page, `/sales/deals/${actDeal}`, new RegExp(`/api/v1/sales/deals/${actDeal}$`));
  const input = page.getByLabel('Proposal link');
  await input.fill('ftp://files.example.com/proposal.pdf');
  await expect(page.getByRole('button', { name: 'Link' })).toBeDisabled();
  await input.fill(`https://docs.example.com/proposal-${run}`);
  const linked = page.waitForResponse((r) => r.url().endsWith(`/api/v1/sales/deals/${actDeal}/activities`) && r.request().method() === 'POST', { timeout: 30_000 });
  await page.getByRole('button', { name: 'Link' }).click();
  expect((await linked).status()).toBe(201);
  await expect(page.getByRole('link', { name: new RegExp(`proposal-${run}`) })).toBeVisible();
  const hira = await apiAs(playwright, HIRA);
  expect(await (await hira.get(`/sales/deals/${actDeal}`)).json()).toMatchObject({ stage: 'proposal_sent', proposalUrl: `https://docs.example.com/proposal-${run}` });
  await context.close();
});

test('My sales day lists today’s follow-up from the server; marking it done records it and sets the next one', async ({ browser, playwright }) => {
  test.setTimeout(150_000);
  const { page, context } = await openAs(browser, HIRA, '/');
  await screenLoadsFromServer(page, '/sales', /\/api\/v1\/sales\/follow-ups$/);
  const row = page.locator('li', { hasText: 'Tailspin E2E' });
  await expect(row).toBeVisible();
  await row.getByRole('button', { name: 'Done' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.locator('#fu-summary').fill('Called, they want the revised scope');
  await dialog.locator('#fu-next').fill('Send the revised scope');
  const later = new Date(Date.now() + 5 * 3_600_000 + 3 * 86_400_000).toISOString().slice(0, 10);
  await dialog.locator('#fu-date').fill(later);
  const done = page.waitForResponse((r) => r.url().endsWith(`/api/v1/sales/deals/${actDeal}/follow-up`), { timeout: 30_000 });
  await dialog.getByRole('button', { name: 'Save' }).click();
  expect((await done).status()).toBe(200);
  const hira = await apiAs(playwright, HIRA);
  const deal = await (await hira.get(`/sales/deals/${actDeal}`)).json();
  expect(deal).toMatchObject({ nextStep: 'Send the revised scope', nextStepDate: later, stage: 'proposal_sent', owner: { empId: HIRA } });
  const timeline = await (await hira.get(`/sales/deals/${actDeal}/activities`)).json();
  expect(timeline.some((a: { kind: string; summary: string }) => a.kind === 'follow_up' && a.summary === 'Called, they want the revised scope')).toBe(true);
  // the sales manager sees the team's follow-ups; another salesperson cannot ask for them
  const dir = await apiAs(playwright, DIRECTOR);
  expect((await dir.get('/sales/follow-ups?scope=team')).status()).toBe(200);
  const kamran = await apiAs(playwright, KAMRAN);
  expect((await kamran.get('/sales/follow-ups?scope=team')).status()).toBe(403);
  await context.close();
});
