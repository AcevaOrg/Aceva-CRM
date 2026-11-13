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

test('approval limits: the settings come from the server, and only the Owner may change them (D22)', async ({ playwright }) => {
  const next = { reason: 'Browser test: same limits again', limits: [{ approverLevel: 3, maxAmount: '50000', label: 'Director' }, { approverLevel: 2, maxAmount: '500000', label: 'CEO' }, { approverLevel: 1, maxAmount: null, label: 'Owner' }] };
  // the Director cannot change approval limits, even after confirming again (they would be raising their own limit)
  const director = await apiAs(playwright, DIRECTOR);
  await stepUpApi(director, DIRECTOR);
  expect((await director.put('/settings/approval-limits', next)).status()).toBe(404);
  // the Owner can, after confirming again (the same values, so nothing else changes)
  const owner = await apiAs(playwright, OWNER);
  expect((await owner.put('/settings/approval-limits', next)).status()).toBe(403); // not confirmed yet
  await stepUpApi(owner, OWNER);
  expect((await owner.put('/settings/approval-limits', next)).status()).toBe(200);
  const limits: Array<{ approverLevel: number; maxAmount: string | null }> = await (await owner.get('/settings/approval-limits')).json();
  expect(limits.find((l) => l.approverLevel === 1)?.maxAmount).toBeNull();
});

test('finance is not reachable for a developer: the server answers 404', async ({ playwright }) => {
  const dev = await apiAs(playwright, DEV);
  for (const path of ['/journal-entries', '/bank-accounts', '/periods', '/accounts', '/settings/approval-limits']) {
    expect((await dev.get(path)).status(), path).toBe(404);
  }
});
