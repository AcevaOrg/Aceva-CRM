import { randomUUID } from 'node:crypto';
import { crc32 } from 'node:zlib';
import { expect, test } from '@playwright/test';
import { apiAs, openAs } from './auth-helpers';
import { giveReason, goLive, messageMenu, messageRow } from './comms-helpers';

/**
 * Module 14, the remaining collaboration features (plan section 19) in real browsers against the real server, with two
 * or three people signed in at once: topics, moderators, a moderator removing a message with a reason, archiving,
 * the comms-admin channel overview (managing without reading), older history, per-message delivered/read status, and
 * notifications for new messages, mentions and replies.
 */
const DIRECTOR = 'ACV-0003'; // comms.admin
const CTO = 'ACV-0004'; // comms.admin
const DEV1 = 'ACV-0006'; // Fahad Khan
const DEV2 = 'ACV-0007'; // Mariam Shah
const DEV3 = 'ACV-0008'; // Ali Raza
const SQA = 'ACV-0011';

test.describe.configure({ mode: 'serial' });

test('a group moderator sets the topic, appoints a moderator, removes a message with a reason and archives the group; the others see each step live', async ({ browser, playwright }) => {
  test.setTimeout(240_000);
  const tag = randomUUID().slice(0, 6);
  const dev1 = await apiAs(playwright, DEV1);
  const dev2 = await apiAs(playwright, DEV2);
  const dev3 = await apiAs(playwright, DEV3);
  const created = await dev1.post('/comms/conversations', { kind: 'group', name: `Moderation ${tag}`, memberEmpIds: [DEV2, DEV3] });
  expect(created.status(), await created.text()).toBe(201);
  const group = (await created.json()).conversation.id as string;
  const offending = `Off-topic remark ${tag}`;
  const sent = await dev2.post(`/comms/conversations/${group}/messages`, { clientKey: randomUUID(), body: offending });
  expect(sent.status()).toBe(201);
  const offendingId = (await sent.json()).message.id as string;

  const a = await openAs(browser, DEV1, '/');
  const b = await openAs(browser, DEV2, '/');
  await goLive(a.page, `/messages/${group}`);
  await goLive(b.page, `/messages/${group}`);

  // A plain member (B) has no moderation controls, and the server refuses them.
  await messageMenu(b.page, offending);
  await expect(b.page.getByRole('menuitem', { name: /Remove message/ })).toHaveCount(0);
  await b.page.keyboard.press('Escape');
  expect((await dev3.post(`/comms/messages/${offendingId}/remove`, { reason: 'Not a moderator here' })).status()).toBe(403);
  expect((await dev3.patch(`/comms/conversations/${group}`, { topic: 'Not allowed' })).status()).toBe(403);

  // Topic: set by A, shown in B's header without a refresh.
  await a.page.getByRole('button', { name: 'Conversation details' }).click();
  await a.page.getByRole('button', { name: 'Add a topic' }).click();
  await a.page.getByLabel('Topic').fill(`Release checks ${tag}`);
  await a.page.getByRole('button', { name: 'Save topic' }).click();
  await expect(b.page.locator('section[aria-label] > header').first()).toContainText(`Release checks ${tag}`, { timeout: 10_000 });

  // Appoint B: B gets the moderator's controls live (rename appears in B's details).
  await a.page.getByRole('button', { name: 'Make Mariam Shah a moderator' }).click();
  await b.page.getByRole('button', { name: 'Conversation details' }).click();
  await expect(b.page.getByRole('button', { name: 'Rename' })).toBeVisible({ timeout: 10_000 });
  // ...and stop again: the controls go.
  await a.page.getByRole('button', { name: 'Stop Mariam Shah being a moderator' }).click();
  await expect(b.page.getByRole('button', { name: 'Rename' })).toHaveCount(0, { timeout: 10_000 });
  await b.page.getByRole('button', { name: 'Close panel' }).click();

  // A removes B's message with a reason: B sees the placeholder at once; the audit keeps the reason, never the text.
  await messageMenu(a.page, offending);
  await a.page.getByRole('menuitem', { name: /Remove message/ }).click();
  await giveReason(a.page, `Keep this group on topic ${tag}`, 'Remove');
  await expect(b.page.getByText('Removed by a moderator')).toBeVisible({ timeout: 10_000 });
  await expect(b.page.getByText(offending, { exact: true })).toHaveCount(0);

  // Archive with a reason: B's composer is replaced by the archived notice live; nothing can be sent any more.
  await a.page.getByRole('button', { name: 'Archive' }).click();
  await giveReason(a.page, `The release is done ${tag}`, 'Archive');
  await expect(b.page.getByText(/This conversation is archived/)).toBeVisible({ timeout: 10_000 });
  await expect(b.page.getByPlaceholder(/^Message /)).toHaveCount(0);
  const late = await dev2.post(`/comms/conversations/${group}/messages`, { clientKey: randomUUID(), body: `Too late ${tag}` });
  expect(late.status()).toBe(409);
  expect((await late.json()).code).toBe('conversation_archived');
  // It stays readable, in the Archived section of the list.
  await b.page.goto('/messages');
  await expect(b.page.getByText('Archived', { exact: true })).toBeVisible();
  await expect(b.page.getByRole('link', { name: new RegExp(`Moderation ${tag}`) })).toBeVisible();
  for (const x of [a, b]) await x.context.close();
});

test('the comms admin overview lists every channel; an admin who is not a member manages one without ever reading it', async ({ browser, playwright }) => {
  test.setTimeout(180_000);
  const tag = randomUUID().slice(0, 6);
  const director = await apiAs(playwright, DIRECTOR);
  const created = await director.post('/comms/conversations', { kind: 'channel', scope: 'project', name: `launch-${tag}`, projectName: `Launch ${tag}`, memberEmpIds: [DEV1] });
  expect(created.status(), await created.text()).toBe(201);
  const channel = (await created.json()).conversation.id as string;
  const secret = `Channel-only note ${tag}`;
  expect((await director.post(`/comms/conversations/${channel}/messages`, { clientKey: randomUUID(), body: secret })).status()).toBe(201);

  // The CTO (comms.admin, not a member): may not read it.
  const cto = await apiAs(playwright, CTO);
  expect((await cto.get(`/comms/conversations/${channel}/messages`)).status()).toBe(404);

  const admin = await openAs(browser, CTO, '/');
  const member = await openAs(browser, DEV1, '/');
  const reads: string[] = [];
  admin.page.on('request', (r) => {
    if (r.url().includes(`/comms/conversations/${channel}/`)) reads.push(r.url());
  });
  await goLive(member.page, `/messages/${channel}`);
  await goLive(admin.page, '/messages');
  await admin.page.getByRole('link', { name: 'Manage channels' }).click();
  await admin.page.waitForURL(/\/messages\/channels$/);
  const row = admin.page.getByRole('row').filter({ hasText: `#launch-${tag}` });
  await expect(row).toContainText(`Project · Launch ${tag}`);
  await row.getByRole('link', { name: 'Manage' }).click();
  await expect(admin.page.getByText('You manage this channel')).toBeVisible({ timeout: 10_000 });
  await expect(admin.page.getByText(secret)).toHaveCount(0);
  await admin.page.getByRole('button', { name: 'Open details' }).click();
  await admin.page.getByRole('button', { name: 'Add a topic' }).click();
  await admin.page.getByLabel('Topic').fill(`Go-live coordination ${tag}`);
  await admin.page.getByRole('button', { name: 'Save topic' }).click();
  await expect(member.page.locator('section[aria-label] > header').first()).toContainText(`Go-live coordination ${tag}`, { timeout: 10_000 });
  // The admin's screen never asked for the channel's messages or pins.
  expect(reads.filter((u) => /\/(messages|pins)(\?|$)/.test(u))).toEqual([]);
  // The members-only controls of reading are absent for the admin; the pinned and files sections are not shown.
  await expect(admin.page.getByText(/^Pinned · /)).toHaveCount(0);

  // A non-admin cannot see the overview.
  expect((await (await apiAs(playwright, DEV1)).get('/comms/admin/channels')).status()).toBe(403);
  for (const x of [admin, member]) await x.context.close();
});

test('older history loads on request and stays in order; the newest page comes first', async ({ browser, playwright }) => {
  test.setTimeout(300_000);
  const tag = randomUUID().slice(0, 6);
  // Four authors who send nothing else in this file: the per-person limit (30 a minute) is real, and the people of the
  // later tests must not start inside someone's busy minute.
  const authors = [SQA, 'ACV-0012', 'ACV-0013', 'ACV-0014'];
  const clients = await Promise.all(authors.map((e) => apiAs(playwright, e)));
  const created = await (await apiAs(playwright, DEV1)).post('/comms/conversations', { kind: 'group', name: `History ${tag}`, memberEmpIds: authors });
  expect(created.status(), await created.text()).toBe(201);
  const group = (await created.json()).conversation.id as string;
  // 112 messages (more than one page of 100), from four people to stay under the per-person limit of 30 a minute.
  for (let n = 1; n <= 112; n++) {
    const who = clients[(n - 1) % authors.length];
    const res = await who.post(`/comms/conversations/${group}/messages`, { clientKey: randomUUID(), body: `History ${tag} #${n}` });
    expect(res.status(), await res.text()).toBe(201);
  }
  const a = await openAs(browser, DEV1, '/');
  await goLive(a.page, `/messages/${group}`);
  await expect(a.page.getByText(`History ${tag} #112`, { exact: true })).toBeVisible();
  await expect(a.page.getByText(`History ${tag} #13`, { exact: true })).toBeAttached();
  await expect(a.page.getByText(`History ${tag} #12`, { exact: true })).toHaveCount(0);
  await a.page.getByRole('button', { name: 'Load older messages' }).click();
  await expect(a.page.getByText(`History ${tag} #1`, { exact: true })).toBeAttached({ timeout: 10_000 });
  await expect(a.page.getByRole('button', { name: 'Load older messages' })).toHaveCount(0);
  // In order, without duplicates.
  const texts = await a.page.locator('[id^="msg-"]').allInnerTexts();
  const numbers = texts.map((t) => Number(/History \S+ #(\d+)/.exec(t)?.[1])).filter((n) => n > 0);
  expect(numbers).toEqual(Array.from({ length: 112 }, (_, i) => i + 1));
  // A new message still arrives at the bottom, and the older messages stay.
  expect((await (await apiAs(playwright, DEV2)).post(`/comms/conversations/${group}/messages`, { clientKey: randomUUID(), body: `History ${tag} latest` })).status()).toBe(404); // not a member: the group does not exist for her
  expect((await (await apiAs(playwright, DEV1)).post(`/comms/conversations/${group}/messages`, { clientKey: randomUUID(), body: `History ${tag} latest` })).status()).toBe(201);
  await expect(a.page.getByText(`History ${tag} latest`, { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(a.page.getByText(`History ${tag} #1`, { exact: true })).toBeAttached();
  await a.context.close();
});

test('per-message status in a group: sent, then delivered when it reaches a screen, then read, with who', async ({ browser, playwright }) => {
  test.setTimeout(180_000);
  const tag = randomUUID().slice(0, 6);
  const dev1 = await apiAs(playwright, DEV1);
  const created = await dev1.post('/comms/conversations', { kind: 'group', name: `Receipts ${tag}`, memberEmpIds: [DEV2, DEV3] });
  expect(created.status(), await created.text()).toBe(201);
  const group = (await created.json()).conversation.id as string;

  const a = await openAs(browser, DEV1, '/');
  await goLive(a.page, `/messages/${group}`);
  const text = `Status probe ${tag}`;
  await a.page.getByPlaceholder(/^Message /).fill(text);
  await a.page.getByPlaceholder(/^Message /).press('Enter');
  const row = messageRow(a.page, text);
  await expect(row.getByLabel('Sent', { exact: true })).toBeVisible({ timeout: 10_000 });

  // Mariam has the app open (any screen): the next message reaches her screen live, which counts as delivered.
  const b = await openAs(browser, DEV2, '/');
  await goLive(b.page, '/messages');
  const second = `Status probe two ${tag}`;
  await a.page.getByPlaceholder(/^Message /).fill(second);
  await a.page.getByPlaceholder(/^Message /).press('Enter');
  const row2 = messageRow(a.page, second);
  await expect(row2.getByText('Delivered to 1')).toBeVisible({ timeout: 15_000 });

  // Ali reads it.
  const seq = (await (await dev1.get(`/comms/conversations/${group}`)).json()).lastSeq as number;
  expect((await (await apiAs(playwright, DEV3)).post(`/comms/conversations/${group}/read`, { seq })).status()).toBe(200);
  await expect(row2.getByText('Read by 1')).toBeVisible({ timeout: 10_000 });
  await row2.getByRole('button', { name: /Read by 1\. Show who/ }).click();
  const who = a.page.getByRole('dialog');
  await expect(who).toContainText('Ali Raza');
  await expect(who).toContainText('Delivered, not read yet · 1');
  await expect(who).toContainText('Mariam Shah');
  for (const x of [a, b]) await x.context.close();
});

test('notifications: a new DM message, a mention and a reply reach the right people, without the message text', async ({ browser, playwright }) => {
  test.setTimeout(180_000);
  const tag = randomUUID().slice(0, 6);
  const dev1 = await apiAs(playwright, DEV1);
  const dev2 = await apiAs(playwright, DEV2);
  const dm = (await (await dev1.post('/comms/conversations', { kind: 'dm', empId: DEV2 })).json()).conversation.id as string;
  // Mariam reads the DM first, so this test's message is unread for her.
  const before = (await (await dev2.get(`/comms/conversations/${dm}`)).json()).lastSeq as number;
  if (before) expect((await dev2.post(`/comms/conversations/${dm}/read`, { seq: before })).status()).toBe(200);
  const privateText = `Private words ${tag}`;
  expect((await dev1.post(`/comms/conversations/${dm}/messages`, { clientKey: randomUUID(), body: privateText })).status()).toBe(201);

  const group = (await (await dev1.post('/comms/conversations', { kind: 'group', name: `Notify ${tag}`, memberEmpIds: [DEV2, DEV3] })).json()).conversation.id as string;
  const question = await (await dev2.post(`/comms/conversations/${group}/messages`, { clientKey: randomUUID(), body: `Question ${tag}` })).json();
  expect((await dev1.post(`/comms/conversations/${group}/messages`, { clientKey: randomUUID(), body: `@${DEV3} please answer ${tag}`, parentId: question.message.id })).status()).toBe(201);

  // The outbox reader runs every 10 seconds on the server.
  const titlesOf = async (who: typeof dev1) => ((await (await who.get('/notifications')).json()) as Array<{ title: string; body: string | null; link: string }>);
  await expect.poll(async () => (await titlesOf(dev2)).some((n) => n.title === 'New message from Fahad Khan' && n.link === `/messages/${dm}`), { timeout: 40_000 }).toBe(true);
  const dev3 = await apiAs(playwright, DEV3);
  await expect.poll(async () => (await titlesOf(dev3)).some((n) => n.title === `Fahad Khan mentioned you in Notify ${tag}`), { timeout: 40_000 }).toBe(true);
  await expect.poll(async () => (await titlesOf(dev2)).some((n) => n.title === `Fahad Khan replied to your message in Notify ${tag}`), { timeout: 40_000 }).toBe(true);
  expect(JSON.stringify(await titlesOf(dev2))).not.toContain(privateText);
  expect((await titlesOf(dev1)).some((n) => n.link?.startsWith(`/messages/${dm}`))).toBe(false);

  // Mariam sees it in the app and opens the conversation from it.
  const b = await openAs(browser, DEV2, '/');
  await b.page.goto('/notifications');
  const item = b.page.getByText('New message from Fahad Khan').first();
  await expect(item).toBeVisible({ timeout: 15_000 });
  await item.click();
  await b.page.waitForURL(new RegExp(`/messages/${dm}`), { timeout: 10_000 });
  await expect(b.page.getByText(privateText, { exact: true })).toBeVisible();
  await b.context.close();
});

test('announcements: the CTO publishes to Sales asking for acknowledgement; a salesperson acknowledges; only the publisher sees who has not', async ({ browser, playwright }) => {
  test.setTimeout(180_000);
  const tag = randomUUID().slice(0, 6);
  const title = `Price list update ${tag}`;
  const SALES1 = 'ACV-0009';

  const publisher = await openAs(browser, CTO, '/');
  await publisher.page.goto('/announcements');
  await publisher.page.getByRole('button', { name: 'New announcement' }).click();
  await publisher.page.getByLabel('Title').fill(title);
  await publisher.page.getByLabel('Message').fill(`The new price list applies from Monday. ${tag}`);
  await publisher.page.getByRole('switch', { name: /Everyone in the company/ }).click();
  await publisher.page.getByRole('checkbox', { name: 'Sales' }).click();
  await publisher.page.getByRole('switch', { name: /Ask people to acknowledge/ }).click();
  await publisher.page.getByRole('button', { name: 'Publish' }).click();
  const card = (page: typeof publisher.page) => page.locator('article').filter({ hasText: title });
  await expect(card(publisher.page)).toBeVisible({ timeout: 10_000 });
  await expect(card(publisher.page)).toContainText(/0 of \d+ acknowledged/);

  // The salesperson sees it waiting for them and acknowledges it.
  const sales = await openAs(browser, SALES1, '/');
  await sales.page.goto('/announcements?show=todo');
  await expect(card(sales.page)).toBeVisible({ timeout: 10_000 });
  await expect(card(sales.page)).not.toContainText(/of \d+ acknowledged/); // no progress for non-publishers
  await card(sales.page).getByRole('button', { name: "I've read this" }).click();
  // Acknowledged: it leaves the "To acknowledge" list, and the full list says so on the card.
  await expect(sales.page.getByText("You're all caught up")).toBeVisible({ timeout: 10_000 });
  await sales.page.getByRole('radio', { name: 'All', exact: true }).click();
  await expect(card(sales.page).getByText('You acknowledged this')).toBeVisible({ timeout: 10_000 });

  // The publisher's progress counts it.
  await publisher.page.reload();
  await expect(card(publisher.page)).toContainText(/1 of \d+ acknowledged/, { timeout: 10_000 });

  // A developer does not see a Sales announcement, and the server agrees.
  const dev = await apiAs(playwright, DEV1);
  const list = (await (await dev.get('/comms/announcements')).json()).items as Array<{ title: string; id: string }>;
  expect(list.map((a) => a.title)).not.toContain(title);
  const salesApi = await apiAs(playwright, SALES1);
  const mine = ((await (await salesApi.get('/comms/announcements')).json()).items as Array<{ id: string; title: string; progress: unknown }>).find((a) => a.title === title)!;
  expect(mine.progress).toBeNull();
  expect((await dev.get(`/comms/announcements/${mine.id}`)).status()).toBe(404);
  expect((await salesApi.post('/comms/announcements', { title: 'Not allowed here', body: 'Salespeople do not publish announcements.', audience: { all: true, departmentIds: [] } })).status()).toBe(403);

  // The salesperson was notified (the outbox reader runs every 10 seconds).
  await expect
    .poll(async () => ((await (await salesApi.get('/notifications')).json()) as Array<{ title: string }>).some((n) => n.title === `Please read and acknowledge: ${title}`), { timeout: 40_000 })
    .toBe(true);
  for (const x of [publisher, sales]) await x.context.close();
});

test('meetings: one person schedules and invites, the invitee answers, the organizer writes the notes and cancels; nobody else can see it', async ({ browser, playwright }) => {
  test.setTimeout(180_000);
  const tag = randomUUID().slice(0, 6);
  const title = `Design review ${tag}`;
  const organizer = await openAs(browser, DEV1, '/');
  await organizer.page.goto('/meetings');
  await organizer.page.getByRole('button', { name: 'New meeting' }).first().click();
  await organizer.page.getByLabel('Title').fill(title);
  await organizer.page.getByLabel('Where').fill('Video call');
  await organizer.page.getByLabel('Search people').fill('Mariam');
  await organizer.page.getByRole('checkbox', { name: 'Invite Mariam Shah' }).click();
  await organizer.page.getByLabel('Agenda').fill(`1. Screens ${tag}\n2. Next steps`);
  await expect(organizer.page.getByText(/Add files on the meeting page once it is created/)).toBeVisible();
  await organizer.page.getByRole('button', { name: 'Schedule' }).click();
  await organizer.page.waitForURL(/\/meetings\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const meetingId = organizer.page.url().split('/').pop()!;

  // The invitee finds it and answers.
  const invitee = await openAs(browser, DEV2, '/');
  await invitee.page.goto(`/meetings/${meetingId}`);
  await expect(invitee.page.getByText(`1. Screens ${tag}`)).toBeVisible({ timeout: 10_000 });
  await invitee.page.getByRole('radio', { name: 'Going' }).click();
  await expect(invitee.page.getByRole('radio', { name: 'Going' })).toHaveAttribute('aria-checked', 'true', { timeout: 10_000 });

  // The organizer sees the answer and writes the notes; the invitee reads them.
  await organizer.page.reload();
  await expect(organizer.page.getByText(/2 going/)).toBeVisible({ timeout: 10_000 });
  await organizer.page.getByLabel('Meeting notes').fill(`Decided: ship the screens ${tag}`);
  await organizer.page.getByRole('button', { name: 'Save notes' }).click();
  await expect(organizer.page.getByText(/Last saved/)).toBeVisible({ timeout: 10_000 });
  await invitee.page.reload();
  await expect(invitee.page.getByText(`Decided: ship the screens ${tag}`)).toBeVisible({ timeout: 10_000 });
  await expect(invitee.page.getByLabel('Meeting notes')).toHaveCount(0); // read-only for invitees

  // Nobody else can open it, a manager included; the invitee was notified (no title in the notification).
  for (const who of ['ACV-0009', DIRECTOR]) expect((await (await apiAs(playwright, who)).get(`/comms/meetings/${meetingId}`)).status()).toBe(404);
  const dev2 = await apiAs(playwright, DEV2);
  await expect
    .poll(async () => ((await (await dev2.get('/notifications')).json()) as Array<{ title: string; link: string }>).some((n) => n.link === `/meetings/${meetingId}` && /^Fahad Khan invited you to a meeting on /.test(n.title)), { timeout: 40_000 })
    .toBe(true);
  expect(JSON.stringify(await (await dev2.get('/notifications')).json())).not.toContain(title);

  // The organizer cancels with a reason: the invitee sees it cancelled and can no longer answer.
  await organizer.page.getByRole('button', { name: 'Cancel meeting' }).click();
  await giveReason(organizer.page, `Moved to next sprint ${tag}`, 'Cancel meeting');
  await expect(organizer.page.getByText('Cancelled', { exact: true })).toBeVisible({ timeout: 10_000 });
  await invitee.page.reload();
  await expect(invitee.page.getByText('Cancelled', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(invitee.page.getByRole('radiogroup', { name: 'Your reply' })).toHaveCount(0);
  for (const x of [organizer, invitee]) await x.context.close();
});

/** The EICAR test sample (harmless; every antivirus reports it), put together here so this file never contains it. */
const EICAR = ['X5O!P%@AP[4\\PZX54(P^)7CC)7}', '$EICAR-STANDARD-', 'ANTIVIRUS-TEST-FILE!$H+H*'].join('');
if (EICAR.length !== 68) throw new Error('The EICAR test sample is 68 characters'); // guards against a lost escape
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

/** A minimal .docx-shaped zip (stored, one entry under word/) carrying `content`; ClamAV looks inside zips. */
function docxCarrying(content: Buffer): Buffer {
  const name = Buffer.from('word/document.xml');
  const crc = crc32(content);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(content.length, 18);
  local.writeUInt32LE(content.length, 22);
  local.writeUInt16LE(name.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(content.length, 20);
  central.writeUInt32LE(content.length, 24);
  central.writeUInt16LE(name.length, 28);
  const localPart = Buffer.concat([local, name, content]);
  const centralPart = Buffer.concat([central, name]);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(1, 8);
  end.writeUInt16LE(1, 10);
  end.writeUInt32LE(centralPart.length, 12);
  end.writeUInt32LE(localPart.length, 16);
  return Buffer.concat([localPart, centralPart, end]);
}

test('files (real ClamAV): a clean PDF is shared and the other person downloads it; a file with malware is blocked and cannot be sent', async ({ browser, playwright }) => {
  test.setTimeout(240_000);
  const tag = randomUUID().slice(0, 6);
  const dev1 = await apiAs(playwright, DEV1);
  const group = (await (await dev1.post('/comms/conversations', { kind: 'group', name: `Files ${tag}`, memberEmpIds: [DEV2] })).json()).conversation.id as string;
  const a = await openAs(browser, DEV1, '/');
  const b = await openAs(browser, DEV2, '/');
  await goLive(a.page, `/messages/${group}`);
  await goLive(b.page, `/messages/${group}`);

  // A clean file: uploaded, checked by ClamAV, then sent.
  await a.page.locator('input[type=file]').first().setInputFiles({ name: `plan-${tag}.pdf`, mimeType: 'application/pdf', buffer: PDF });
  const chip = a.page.locator('li').filter({ has: a.page.getByRole('button', { name: `Remove plan-${tag}.pdf` }) });
  await expect(chip).not.toContainText(/Uploading|Scanning/, { timeout: 30_000 });
  await a.page.getByPlaceholder(/^Message /).fill(`The plan ${tag}`);
  await a.page.getByPlaceholder(/^Message /).press('Enter');
  const card = b.page.getByRole('button', { name: new RegExp(`plan-${tag}\.pdf`) });
  await expect(card).toBeVisible({ timeout: 10_000 });
  const download = b.page.waitForEvent('download');
  await card.click();
  const file = await download;
  expect(file.suggestedFilename()).toBe(`plan-${tag}.pdf`);
  const saved = await file.createReadStream();
  const chunks: Buffer[] = [];
  for await (const c of saved) chunks.push(c as Buffer);
  expect(Buffer.concat(chunks).equals(PDF)).toBe(true);

  // A file with malware: blocked at once, cannot be sent, never downloadable.
  await a.page.locator('input[type=file]').first().setInputFiles({ name: `invoice-${tag}.docx`, mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', buffer: docxCarrying(Buffer.from(EICAR, 'latin1')) });
  // The composer's own chip (a toast about the file is a list item too).
  const bad = a.page.locator('li').filter({ has: a.page.getByRole('button', { name: `Remove invoice-${tag}.docx` }) });
  await expect(bad).toContainText('Blocked: malware', { timeout: 30_000 });
  await a.page.getByPlaceholder(/^Message /).fill(`Should not go ${tag}`);
  await expect(a.page.getByRole('button', { name: 'Send' })).toBeDisabled();

  // Someone outside the group cannot download the clean file either.
  const fileId = ((await (await dev1.get(`/comms/conversations/${group}/messages`)).json()).items as Array<{ attachments: Array<{ id: string }> }>).flatMap((m) => m.attachments)[0].id;
  expect((await (await apiAs(playwright, 'ACV-0009')).get(`/comms/files/${fileId}/download`)).status()).toBe(404);
  for (const x of [a, b]) await x.context.close();
});

test('task links: a member links a message to a Module 5 task they may see; a member who may not see that task is never told which', async ({ browser, playwright }) => {
  test.setTimeout(180_000);
  const tag = randomUUID().slice(0, 6);
  const cto = await apiAs(playwright, CTO);
  const start = new Date();
  const created = await cto.post('/tasks', { title: `Payslip screen ${tag}`, assignee: DEV1, size: 'M', estimatedHours: 8, startDate: start.toISOString(), deadline: new Date(start.getTime() + 7 * 86_400_000).toISOString(), confirmWarnings: true });
  expect([200, 201], await created.text()).toContain(created.status());
  const task = (await created.json()) as { id: string; number: string };
  const dev1 = await apiAs(playwright, DEV1);
  const group = (await (await dev1.post('/comms/conversations', { kind: 'group', name: `Links ${tag}`, memberEmpIds: [DEV2] })).json()).conversation.id as string;
  const text = `Starting the payslip screen ${tag}`;
  expect((await dev1.post(`/comms/conversations/${group}/messages`, { clientKey: randomUUID(), body: text })).status()).toBe(201);

  const a = await openAs(browser, DEV1, '/');
  const b = await openAs(browser, DEV2, '/');
  await goLive(a.page, `/messages/${group}`);
  await goLive(b.page, `/messages/${group}`);
  await messageMenu(a.page, text);
  await a.page.getByRole('menuitem', { name: /Link to a task/ }).click();
  await a.page.getByRole('dialog').getByPlaceholder('Search by number or title').fill(tag);
  await a.page.getByRole('dialog').getByRole('button', { name: new RegExp(task.number) }).click();
  await expect(messageRow(a.page, text).getByRole('link', { name: new RegExp(task.number) })).toBeVisible({ timeout: 10_000 });
  // Mariam (a peer) may not see Fahad's task: she is told only that a task is linked, live.
  await expect(messageRow(b.page, text).getByText("Linked to a task you can't open")).toBeVisible({ timeout: 10_000 });
  await expect(b.page.getByText(`Payslip screen ${tag}`, { exact: true })).toHaveCount(0); // the task's title (her own message mentions the words)
  await expect(b.page.getByText(task.number)).toHaveCount(0);
  for (const x of [a, b]) await x.context.close();
});
