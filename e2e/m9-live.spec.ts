import { expect, test } from '@playwright/test';
import { apiAs, openAs } from './auth-helpers';
import { screenLoadsFromServer, stepUpApi } from './live-screen';

/** Module 9 (finance ledger) screens against the real server, logged in for real. */
const DEV = 'ACV-0006';
const FINANCE = 'ACV-0010';
const DIRECTOR = 'ACV-0003';
const OWNER = 'ACV-0001';

test.describe.configure({ mode: 'serial' });

const SCREENS: Array<{ who: string; path: string; endpoint: RegExp }> = [
  { who: FINANCE, path: '/finance/ledger', endpoint: /\/api\/v1\/journal-entries$/ },
  { who: FINANCE, path: '/finance/ledger/new', endpoint: /\/api\/v1\/accounts$/ },
  { who: FINANCE, path: '/finance/accounts', endpoint: /\/api\/v1\/accounts$/ },
  { who: FINANCE, path: '/finance/banking', endpoint: /\/api\/v1\/bank-accounts$/ },
  { who: FINANCE, path: '/finance/bills', endpoint: /\/api\/v1\/bills$/ },
  { who: FINANCE, path: '/finance/parties', endpoint: /\/api\/v1\/parties$/ },
  { who: FINANCE, path: '/finance/close', endpoint: /\/api\/v1\/periods(\/\d{4}-\d{2})?$/ },
];

for (const s of SCREENS) {
  test(`${s.path} as ${s.who} loads from the real API`, async ({ browser }) => {
    const { page, context } = await openAs(browser, s.who, '/');
    await screenLoadsFromServer(page, s.path, s.endpoint);
    await context.close();
  });
}

test('a journal entry made through the API opens on its detail screen', async ({ browser, playwright }) => {
  const fin = await apiAs(playwright, FINANCE);
  const accounts: Array<{ id: string; code: string }> = await (await fin.get('/accounts')).json();
  const id = (code: string) => accounts.find((a) => a.code === code)!.id;
  const entry = await fin.post('/journal-entries', { date: '2026-10-15', description: 'E2E office supplies', lines: [{ accountId: id('5200'), debit: '1500' }, { accountId: id('1100'), credit: '1500' }] });
  expect(entry.status()).toBe(201);
  const { id: entryId, number } = await entry.json();
  const { page, context } = await openAs(browser, FINANCE, '/');
  await screenLoadsFromServer(page, `/finance/ledger/${entryId}`, new RegExp(`/api/v1/journal-entries/${entryId}$`));
  await expect(page.getByText(number).first()).toBeVisible();
  await context.close();
});

test('finance settings: only the Director changes them, after confirming again; the Owner cannot, and the old approval limits are gone (D26)', async ({ playwright }) => {
  const fin = await apiAs(playwright, FINANCE);
  const director = await apiAs(playwright, DIRECTOR);
  const owner = await apiAs(playwright, OWNER);
  // D26 removed the approval tiers: the old route is gone for everyone, the Director and the Owner included
  const oldLimits = { reason: 'Browser test: the old tiers', limits: [{ approverLevel: 2, maxAmount: null, label: 'Director' }] };
  for (const [who, api] of [[FINANCE, fin], [DIRECTOR, director], [OWNER, owner]] as const) {
    expect((await api.get('/settings/approval-limits')).status(), `GET as ${who}`).toBe(404);
    expect((await api.put('/settings/approval-limits', oldLimits)).status(), `PUT as ${who}`).toBe(404);
  }

  // the settings come from the server; the change below writes the same values again, so nothing else changes
  const current = (await (await fin.get('/settings/finance')).json()) as { stepUpAbove: string; ownerNotifyAbove: string; financeYearStartMonth: number };
  const next = { ...current, reason: 'Browser test: the same finance settings again' };
  // Finance and the Owner (view only) never reach the change, even after confirming again
  expect((await fin.put('/settings/finance', next)).status()).toBe(404);
  await stepUpApi(owner, OWNER);
  expect((await owner.put('/settings/finance', next)).status()).toBe(404);
  // the Director may, but only after confirming again
  const unconfirmed = await director.put('/settings/finance', next);
  expect(unconfirmed.status()).toBe(403);
  expect((await unconfirmed.json()).code).toBe('step_up_required');
  await stepUpApi(director, DIRECTOR);
  const changed = await director.put('/settings/finance', next);
  expect(changed.status(), await changed.text()).toBe(200);
  expect(await changed.json()).toMatchObject(current);
  expect(await (await fin.get('/settings/finance')).json()).toEqual(current);
});

test('finance is not reachable for a developer: the server answers 404', async ({ playwright }) => {
  const dev = await apiAs(playwright, DEV);
  for (const path of ['/journal-entries', '/bank-accounts', '/periods', '/accounts', '/settings/approval-limits']) {
    expect((await dev.get(path)).status(), path).toBe(404);
  }
});
