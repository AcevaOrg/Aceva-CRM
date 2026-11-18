import { expect, test } from '@playwright/test';
import { apiAs, openAs } from './auth-helpers';
import { screenLoadsFromServer } from './live-screen';

/**
 * Cycle 3 foundation: the minimal Module 12 notification core against the real server, with its background workers on
 * (the outbox reader and the email sender run on their own timers, as in production; emails go to Mailpit).
 */
const DEV = 'ACV-0006';
const DIRECTOR = 'ACV-0003';
const MAILPIT = 'http://127.0.0.1:8025/api/v1';

test.describe.configure({ mode: 'serial' });

test('/notifications as the Director loads from the real API', async ({ browser }) => {
  const { page, context } = await openAs(browser, DIRECTOR, '/');
  await screenLoadsFromServer(page, '/notifications', /\/api\/v1\/notifications$/);
  await context.close();
});

test('a leave request reaches the Director: in the app, on the notifications screen, and by email (Mailpit)', async ({ browser, playwright, request }) => {
  // Real timing: the reader runs every 10 s and the email sender every 15 s.
  test.setTimeout(120_000);
  const dev = await apiAs(playwright, DEV);
  const types: Array<{ id: string; key: string }> = await (await dev.get('/leave/types')).json();
  const unpaid = types.find((x) => x.key === 'unpaid')!;
  const next = new Date(Date.now() + 28 * 86_400_000);
  while ([0, 6].includes(next.getUTCDay())) next.setUTCDate(next.getUTCDate() + 1);
  const day = next.toISOString().slice(0, 10);
  const asked = await dev.post('/leave/requests', { leaveTypeId: unpaid.id, from: day, to: day, reason: 'Browser test: notification' });
  expect(asked.status(), await asked.text()).toBe(201);
  const number = (await asked.json()).number as string;

  const director = await apiAs(playwright, DIRECTOR);
  let notificationId = '';
  await expect
    .poll(
      async () => {
        const list: Array<{ id: string; body: string | null; essential: boolean }> = await (await director.get('/notifications')).json();
        const hit = list.find((n) => n.body?.includes(number));
        notificationId = hit?.id ?? '';
        return hit?.essential ?? null;
      },
      { timeout: 45_000, intervals: [2_000] },
    )
    .toBe(true);

  // the requester is never told about their own request
  const own: Array<{ body: string | null }> = await (await dev.get('/notifications')).json();
  expect(own.some((n) => n.body?.includes(number))).toBe(false);

  // the email went out through the real mail server
  await expect
    .poll(
      async () => {
        const search = await (await request.get(`${MAILPIT}/search?query=${encodeURIComponent(`subject:"leave request is waiting" ${number}`)}`)).json();
        return search.messages?.length ?? 0;
      },
      { timeout: 60_000, intervals: [3_000] },
    )
    .toBe(1);

  // the screen shows it, and marking it read is saved on the server
  const { page, context } = await openAs(browser, DIRECTOR, '/');
  await screenLoadsFromServer(page, '/notifications', /\/api\/v1\/notifications$/);
  await expect(page.getByText('A leave request is waiting for your approval').first()).toBeVisible();
  await context.close();
  expect((await (await director.post('/notifications/read', { ids: [notificationId] })).json()).updated).toBe(1);
});

test('email choices: approvals cannot be turned off; other emails can', async ({ playwright }) => {
  const dev = await apiAs(playwright, DEV);
  const refused = await dev.patch('/notifications/prefs', { email: { leave_requested: false }, dailySummary: true });
  expect(refused.status()).toBe(400);
  expect((await refused.json()).code).toBe('essential_notification');
  const saved = await dev.patch('/notifications/prefs', { email: { payslip_available: false }, dailySummary: true });
  expect(saved.status()).toBe(200);
  expect(await saved.json()).toEqual({ email: { payslip_available: false }, dailySummary: true });
});
