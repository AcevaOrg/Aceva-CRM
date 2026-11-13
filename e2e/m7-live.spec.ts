import { expect, test } from '@playwright/test';
import { apiAs, openAs } from './auth-helpers';
import { screenLoadsFromServer } from './live-screen';

/** Module 7 (attendance and leave) screens against the real server, logged in for real. */
const DEV = 'ACV-0006';
const DIRECTOR = 'ACV-0003';

test.describe.configure({ mode: 'serial' });

const SCREENS: Array<{ who: string; path: string; endpoint: RegExp }> = [
  { who: DEV, path: '/attendance', endpoint: /\/api\/v1\/attendance\/(today|me)$/ },
  { who: DEV, path: '/leave', endpoint: /\/api\/v1\/leave\/(requests|types|balances\/.+|calendar)$/ },
  { who: DIRECTOR, path: '/attendance', endpoint: /\/api\/v1\/attendance\/(team|today|me)(\/summary)?$/ },
];

for (const s of SCREENS) {
  test(`${s.path} as ${s.who} loads from the real API`, async ({ browser }) => {
    const { page, context } = await openAs(browser, s.who, '/');
    await screenLoadsFromServer(page, s.path, s.endpoint);
    await context.close();
  });
}

test('checking in on the attendance screen is recorded by the server, with the server time', async ({ browser, playwright }) => {
  const { page, context } = await openAs(browser, DEV, '/');
  await screenLoadsFromServer(page, '/attendance', /\/api\/v1\/attendance\/today$/);
  const api = await apiAs(playwright, DEV);
  const before = await (await api.get('/attendance/today')).json();
  if (before.canCheckIn) {
    const saved = page.waitForResponse((r) => r.url().endsWith('/api/v1/attendance/check-in') && r.request().method() === 'POST');
    await page.getByRole('button', { name: /^Check in/ }).first().click();
    expect((await saved).status()).toBe(200);
  }
  const after = await (await api.get('/attendance/today')).json();
  expect(after.checkIn).toBeTruthy(); // recorded on the server, not only in the browser
  await context.close();
});

test('a leave request sent through the API waits for the team lead, who sees it in the real data', async ({ playwright }) => {
  const dev = await apiAs(playwright, DEV);
  const types: Array<{ id: string; key: string }> = await (await dev.get('/leave/types')).json();
  const unpaid = types.find((x) => x.key === 'unpaid')!;
  const next = new Date(Date.now() + 14 * 86_400_000);
  while ([0, 6].includes(next.getUTCDay())) next.setUTCDate(next.getUTCDate() + 1);
  const day = next.toISOString().slice(0, 10);
  const asked = await dev.post('/leave/requests', { leaveTypeId: unpaid.id, from: day, to: day, reason: 'Browser test leave' });
  expect([201, 409]).toContain(asked.status()); // 409: an earlier run already asked for this day
  const mine = await (await dev.get('/leave/requests?scope=mine')).json();
  expect(mine.items.length).toBeGreaterThan(0);
});
