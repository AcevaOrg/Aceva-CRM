import { randomUUID } from 'node:crypto';
import { expect, test, type Page, type WebSocket } from '@playwright/test';
import { API, apiAs, loginViaUi, openAs } from './auth-helpers';
import { screenLoadsFromServer } from './live-screen';

/**
 * Module 14, part 2 (live messaging) in real browsers against the real server: messages written through the REST API
 * appear on another person's open screen at once over the WebSocket, the screen does not poll, presence is online or
 * offline only, and ending the session in one tab sends every other open tab to the login screen at once.
 */
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const DEV3 = 'ACV-0008';

test.describe.configure({ mode: 'serial' });

/**
 * Opens a page and waits until its live connection is signed in (the server's first event is the presence snapshot).
 * The page that was open before may still open (and then close) a socket of its own, so the one that counts is a socket
 * that received the snapshot and is still open after the navigation.
 */
async function goLive(page: Page, path: string): Promise<WebSocket> {
  const ready = new Set<WebSocket>();
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/socket.io/')) return;
    ws.on('framereceived', (f) => {
      if (String(f.payload).includes('presence.snapshot')) ready.add(ws);
    });
  });
  await page.goto(path);
  let live: WebSocket | undefined;
  await expect
    .poll(() => (live = [...ready].find((ws) => !ws.isClosed())) !== undefined, { timeout: 20_000, message: `a signed-in live connection on ${path}` })
    .toBe(true);
  return live!;
}

let dm = '';

test('the messages screen loads from the real API, reads passively and does not poll', async ({ browser }) => {
  const { page, context } = await openAs(browser, DEV1, '/');
  const reads: Array<{ url: string; passive: boolean }> = [];
  page.on('request', (r) => {
    if (r.url().includes('/api/v1/comms/')) reads.push({ url: r.url(), passive: r.headers()['x-aceva-passive'] === '1' });
  });
  await screenLoadsFromServer(page, '/messages', /\/api\/v1\/comms\/conversations$/);
  // Two reads are expected: the screen's own, and the catch-up right after the live connection signs in.
  await expect.poll(() => reads.filter((r) => r.url.includes('/comms/conversations')).length, { timeout: 20_000 }).toBeGreaterThanOrEqual(2);
  // Every read the screen makes on its own is passive: it never counts as the person's activity.
  expect(reads.filter((r) => !r.passive)).toEqual([]);
  const before = reads.length;
  await page.waitForTimeout(9_000); // the demo used to poll every 4 seconds
  expect(reads.slice(before)).toEqual([]);
  await expect(page.getByText(/Last seen/)).toHaveCount(0);
  await context.close();
});

test('a message sent by someone else appears at once on an open screen; a reply typed there reaches them live', async ({ browser, playwright }) => {
  test.setTimeout(120_000);
  const dev2 = await apiAs(playwright, DEV2);
  const created = await dev2.post('/comms/conversations', { kind: 'dm', empId: DEV1 });
  expect(created.status(), await created.text()).toBeLessThan(300);
  dm = (await created.json()).conversation.id;

  const a = await openAs(browser, DEV1, '/');
  await goLive(a.page, `/messages/${dm}`);
  const text = `Live hello ${randomUUID().slice(0, 8)}`;
  const sent = await dev2.post(`/comms/conversations/${dm}/messages`, { clientKey: randomUUID(), body: text });
  expect(sent.status(), await sent.text()).toBe(201);
  const seq: number = (await sent.json()).message.seq;
  // Shown once in the conversation, and the conversation list's preview follows live too.
  await expect(a.page.getByText(text, { exact: true })).toHaveCount(1, { timeout: 10_000 });
  await expect(a.page.getByText(`: ${text}`)).toBeVisible({ timeout: 10_000 });

  // The screen acknowledged it: the server records "delivered" (no REST call from the screen for it).
  await expect
    .poll(async () => {
      const detail = await (await dev2.get(`/comms/conversations/${dm}`)).json();
      return (detail.receipts as Array<{ empId: string; lastDeliveredSeq: number }>).find((r) => r.empId === DEV1)?.lastDeliveredSeq ?? 0;
    }, { timeout: 15_000 })
    .toBeGreaterThanOrEqual(seq);

  // DEV2 opens the same conversation in a browser: DEV1 sees them online (online/offline only, no "last seen").
  const b = await openAs(browser, DEV2, '/');
  await goLive(b.page, `/messages/${dm}`);
  await expect(a.page.getByText(/^Online ·/)).toBeVisible({ timeout: 15_000 });

  // DEV1 types a reply on the screen; it arrives on DEV2's open screen without a reload.
  const reply = `Reply typed live ${randomUUID().slice(0, 8)}`;
  const composer = a.page.getByPlaceholder(/^Message /);
  await composer.fill(reply);
  await composer.press('Enter');
  await expect(b.page.getByText(reply, { exact: true })).toHaveCount(1, { timeout: 10_000 });

  // DEV2 closes their browser: DEV1 sees them offline.
  await b.context.close();
  await expect(a.page.getByText(/^Online ·/)).toHaveCount(0, { timeout: 15_000 });
  await expect(a.page.getByText(/Last seen|Away/)).toHaveCount(0);
  await a.context.close();
});

test('logging out in one tab sends the other open tab to the login screen at once', async ({ browser }) => {
  test.setTimeout(90_000);
  const context = await browser.newContext(); // a session of its own (the saved logins of other specs are not touched)
  const first = await context.newPage();
  await loginViaUi(first, DEV3);
  const second = await context.newPage();
  await goLive(second, '/messages');

  await first
    .evaluate(async (api) => {
      const csrf = window.sessionStorage.getItem('aceva-csrf') ?? '';
      await fetch(`${api}/auth/logout`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: '{}' });
    }, API)
    // The tab that logged out is sent to the login screen by its own socket too, possibly before the fetch returns.
    .catch((error: Error) => {
      if (!/Execution context was destroyed/.test(error.message)) throw error;
    });
  // No click, no request from the second tab: the server closes its socket and the tab leaves.
  await second.waitForURL(/\/login\?expired=1/, { timeout: 15_000 });
  await first.waitForURL(/\/login/, { timeout: 15_000 });
  await context.close();
});

test('the composer never loses text: quick messages go out in order, and what is typed during a send stays', async ({ browser, playwright }) => {
  test.setTimeout(120_000);
  const a = await openAs(browser, DEV1, '/');
  const b = await openAs(browser, DEV2, '/');
  await goLive(a.page, `/messages/${dm}`);
  await goLive(b.page, `/messages/${dm}`);
  const tag = randomUUID().slice(0, 6);
  const box = a.page.getByPlaceholder(/^Message /);
  // Five messages typed and sent as fast as possible, without waiting for any of them.
  for (const n of [1, 2, 3, 4, 5]) {
    await box.fill(`Quick ${tag} ${n}`);
    await box.press('Enter');
  }
  // And keeps typing straight away.
  await box.pressSequentially('still typing', { delay: 0 });
  await expect(b.page.getByText(`Quick ${tag} 5`, { exact: true })).toBeVisible({ timeout: 15_000 });
  const shown = (await b.page.locator('[id^="msg-"]').allInnerTexts()).map((t) => new RegExp(`Quick ${tag} ([0-9])`).exec(t)?.[1]).filter(Boolean);
  expect(shown).toEqual(['1', '2', '3', '4', '5']);
  await expect(box).toHaveValue('still typing');
  const sent = (await (await apiAs(playwright, DEV1)).get(`/comms/conversations/${dm}/messages?limit=20`).then((r) => r.json())).items as Array<{ body: string }>;
  expect(sent.filter((m) => m.body.startsWith(`Quick ${tag}`)).map((m) => m.body)).toEqual([1, 2, 3, 4, 5].map((n) => `Quick ${tag} ${n}`));
  await a.context.close();
  await b.context.close();
});

test('a tab that has no CSRF token yet fetches it before its first change, so an early click is not refused', async ({ browser, playwright }) => {
  // The token is kept per tab and arrives with the tab's first /auth/me. A change made before that used to go out without
  // it and was refused (403) with nothing on the screen. Removing it here makes that moment certain instead of a race.
  const a = await openAs(browser, DEV1, '/');
  await goLive(a.page, `/messages/${dm}`);
  await a.page.evaluate(() => window.sessionStorage.removeItem('aceva-csrf'));
  const tag = randomUUID().slice(0, 6);
  const sent = a.page.waitForRequest((r) => r.method() === 'POST' && r.url().includes(`/comms/conversations/${dm}/messages`));
  // the lookup is a passive read (it does not count as activity); the minute heartbeat's /auth/me is not passive
  const lookup = a.page.waitForRequest((r) => r.method() === 'GET' && r.url().endsWith('/auth/me') && r.headers()['x-aceva-passive'] === '1');
  const box = a.page.getByPlaceholder(/^Message /);
  await box.fill(`Early ${tag}`);
  await box.press('Enter');
  await lookup;
  const post = await sent;
  expect(post.headers()['x-csrf-token']).toBeTruthy();
  expect((await post.response())?.status()).toBe(201);
  const items = (await (await apiAs(playwright, DEV1)).get(`/comms/conversations/${dm}/messages?limit=5`).then((r) => r.json())).items as Array<{ body: string }>;
  expect(items.map((m) => m.body)).toContain(`Early ${tag}`);
  await a.context.close();
});

test('a member removed while the conversation is open sees "Conversation not found" at once, without a refresh', async ({ browser, playwright }) => {
  test.setTimeout(120_000);
  const dev1 = await apiAs(playwright, DEV1);
  const created = await dev1.post('/comms/conversations', { kind: 'group', name: `Removal check ${randomUUID().slice(0, 4)}`, memberEmpIds: [DEV2, DEV3] });
  expect(created.status(), await created.text()).toBe(201);
  const group = (await created.json()).conversation.id;
  expect((await dev1.post(`/comms/conversations/${group}/messages`, { clientKey: randomUUID(), body: 'Before the removal' })).status()).toBe(201);
  const b = await openAs(browser, DEV2, '/');
  await goLive(b.page, `/messages/${group}`);
  await expect(b.page.getByText('Before the removal', { exact: true })).toBeVisible();
  // A rename just before the removal (its reload must not bring the conversation back), then the removal.
  expect((await dev1.patch(`/comms/conversations/${group}`, { name: 'Renamed before the removal' })).status()).toBe(200);
  expect((await dev1.delete(`/comms/conversations/${group}/members/${DEV2}`)).status()).toBe(200);
  await expect(b.page.getByText('Conversation not found')).toBeVisible({ timeout: 10_000 });
  await expect(b.page.getByText('Before the removal', { exact: true })).toHaveCount(0);
  await b.page.waitForTimeout(3_000);
  await expect(b.page.getByText('Conversation not found')).toBeVisible(); // and it stays that way
  await b.context.close();
});

test('group management from the details panel: rename, add and remove members, all live in the other browsers', async ({ browser, playwright }) => {
  test.setTimeout(180_000);
  const tag = randomUUID().slice(0, 6);
  const dev1 = await apiAs(playwright, DEV1);
  const created = await dev1.post('/comms/conversations', { kind: 'group', name: `Panel group ${tag}`, memberEmpIds: [DEV2] });
  expect(created.status(), await created.text()).toBe(201);
  const group = (await created.json()).conversation.id;
  const before = `Before Ali joined ${tag}`;
  expect((await dev1.post(`/comms/conversations/${group}/messages`, { clientKey: randomUUID(), body: before })).status()).toBe(201);

  const a = await openAs(browser, DEV1, '/');
  const b = await openAs(browser, DEV2, '/');
  const c = await openAs(browser, DEV3, '/');
  await goLive(a.page, `/messages/${group}`);
  await goLive(b.page, `/messages/${group}`);
  await goLive(c.page, '/messages');

  // A plain member has no management controls, and the server refuses them anyway.
  await b.page.getByRole('button', { name: 'Conversation details' }).click();
  await expect(b.page.getByRole('button', { name: 'Leave conversation' })).toBeVisible();
  await expect(b.page.getByRole('button', { name: 'Rename' })).toHaveCount(0);
  await expect(b.page.getByRole('button', { name: 'Add people' })).toHaveCount(0);
  expect((await (await apiAs(playwright, DEV2)).patch(`/comms/conversations/${group}`, { name: 'Not allowed' })).status()).toBe(403);

  // Rename (A is the group's moderator): B's open conversation follows without a refresh.
  await a.page.getByRole('button', { name: 'Conversation details' }).click();
  await a.page.getByRole('button', { name: 'Rename' }).click();
  await a.page.getByLabel('Conversation name').fill(`Renamed group ${tag}`);
  await a.page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(b.page.getByRole('heading', { name: `Renamed group ${tag}` })).toBeVisible({ timeout: 10_000 });

  // Add Ali: the group appears in his list at once; he sees nothing from before he joined (screen and search).
  await a.page.getByRole('button', { name: 'Add people' }).click();
  await a.page.getByRole('checkbox', { name: 'Add Ali Raza' }).click();
  await a.page.getByRole('dialog').getByRole('button', { name: 'Add', exact: true }).click();
  await expect(c.page.getByRole('link', { name: new RegExp(`Renamed group ${tag}`) })).toBeVisible({ timeout: 10_000 });
  await expect(b.page.getByText('Members · 3')).toBeVisible({ timeout: 10_000 });
  await goLive(c.page, `/messages/${group}`);
  await expect(c.page.getByText(before, { exact: true })).toHaveCount(0);
  const after = `After Ali joined ${tag}`;
  await a.page.getByPlaceholder(/^Message /).fill(after);
  await a.page.getByPlaceholder(/^Message /).press('Enter');
  await expect(c.page.getByText(after, { exact: true })).toBeVisible({ timeout: 10_000 });
  const cSearch = await (await apiAs(playwright, DEV3)).get(`/comms/search?q=${tag}`);
  expect(((await cSearch.json()).items as Array<{ message: { body: string } }>).map((i) => i.message.body)).toEqual([after]);

  // Remove Ali from the members list: his open conversation closes at once; B sees the member count drop.
  await a.page.getByRole('button', { name: 'Remove Ali Raza' }).click();
  await a.page.getByRole('dialog').getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(c.page.getByText('Conversation not found')).toBeVisible({ timeout: 10_000 });
  await expect(b.page.getByText('Members · 2')).toBeVisible({ timeout: 10_000 });

  // B leaves: B goes back to the list, A's details show one member.
  await b.page.getByRole('button', { name: 'Leave conversation' }).click();
  await b.page.getByRole('dialog').getByRole('button', { name: 'Leave', exact: true }).click();
  await b.page.waitForURL(/\/messages$/, { timeout: 10_000 });
  await expect(a.page.getByText('Members · 1')).toBeVisible({ timeout: 10_000 });
  for (const x of [a, b, c]) await x.context.close();
});

test('pinning updates the header count at once, and a pinned follow-on message says "Pinned"', async ({ browser }) => {
  test.setTimeout(120_000);
  const a = await openAs(browser, DEV1, '/');
  const b = await openAs(browser, DEV2, '/');
  await goLive(a.page, `/messages/${dm}`);
  await goLive(b.page, `/messages/${dm}`);
  const tag = randomUUID().slice(0, 6);
  const box = a.page.getByPlaceholder(/^Message /);
  for (const n of ['one', 'two']) {
    await box.fill(`Pin target ${n} ${tag}`);
    await box.press('Enter');
  }
  const row = (page: Page) => page.locator('[id^="msg-"]').filter({ has: page.getByText(`Pin target two ${tag}`, { exact: true }) });
  await expect(row(b.page)).toBeVisible({ timeout: 10_000 });
  // "two" follows "one" from the same person within minutes: a compact message, with no name line of its own.
  await expect(row(b.page).locator('a[href^="/people/"]')).toHaveCount(0);
  const header = (page: Page) => page.locator('section[aria-label] > header').first();
  const pinCount = (page: Page) => header(page).getByRole('button', { name: /^\d+$/ });
  const countBefore = (await pinCount(b.page).count()) ? Number(await pinCount(b.page).innerText()) : 0;

  await row(a.page).hover();
  await row(a.page).getByRole('button', { name: 'More actions' }).click();
  await a.page.getByRole('menuitem', { name: 'Pin' }).click();
  await expect(row(b.page).getByText('Pinned', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(pinCount(b.page)).toHaveText(String(countBefore + 1), { timeout: 10_000 });

  await row(a.page).hover();
  await row(a.page).getByRole('button', { name: 'More actions' }).click();
  await a.page.getByRole('menuitem', { name: 'Unpin' }).click();
  await expect(row(b.page).getByText('Pinned', { exact: true })).toHaveCount(0, { timeout: 10_000 });
  if (countBefore) await expect(pinCount(b.page)).toHaveText(String(countBefore), { timeout: 10_000 });
  else await expect(pinCount(b.page)).toHaveCount(0, { timeout: 10_000 });
  await a.context.close();
  await b.context.close();
});

test('message search finds only what the person may read, and opens the conversation at the message', async ({ browser, playwright }) => {
  test.setTimeout(120_000);
  const word = `zebra${randomUUID().replace(/-/g, '').slice(0, 8)}`;
  const sent = await (await apiAs(playwright, DEV1)).post(`/comms/conversations/${dm}/messages`, { clientKey: randomUUID(), body: `Searchable ${word} note` });
  expect(sent.status()).toBe(201);

  const b = await openAs(browser, DEV2, '/');
  await goLive(b.page, '/messages');
  await b.page.getByRole('button', { name: 'Search messages' }).click();
  await b.page.getByLabel('Search messages text').fill(word);
  const hit = b.page.getByRole('list', { name: 'Search results' }).getByRole('link');
  await expect(hit).toHaveCount(1, { timeout: 10_000 });
  await expect(hit).toContainText(`Searchable ${word} note`);
  await hit.click();
  await b.page.waitForURL(new RegExp(`/messages/${dm}\\?m=`));
  await expect(b.page.getByText(`Searchable ${word} note`, { exact: true })).toBeVisible();

  // Someone outside the DM finds nothing.
  const d = await openAs(browser, 'ACV-0009', '/');
  await goLive(d.page, '/messages');
  await d.page.getByRole('button', { name: 'Search messages' }).click();
  await d.page.getByLabel('Search messages text').fill(word);
  await expect(d.page.getByText('No messages found')).toBeVisible({ timeout: 10_000 });
  await b.context.close();
  await d.context.close();
});

