import { randomUUID } from 'node:crypto';
import { expect, test } from '@playwright/test';
import { apiAs, openAs } from './auth-helpers';
import { startClamd, stopClamd } from './clamd-control';
import { giveReason, goLive, messageMenu, messageRow, stepUpInUi } from './comms-helpers';

/**
 * Module 14 after the review: the screens the first browser tests did not cover. Meeting files and task links, the
 * retention card, creating a project channel in the live dialog, moderating and archiving a channel (a comms admin who is
 * not a member included), a file checked late because the scanner was down (shown live once clean), and the email
 * notification switches. Real servers, real ClamAV, two or three people signed in at once.
 */
const DIRECTOR = 'ACV-0003'; // comms.admin
const CTO = 'ACV-0004'; // comms.admin
const DEV1 = 'ACV-0006'; // Fahad Khan
const DEV2 = 'ACV-0007'; // Mariam Shah
const DEV3 = 'ACV-0008'; // Ali Raza
const MAILPIT = 'http://127.0.0.1:8025/api/v1';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\ntrailer\n<<>>\n%%EOF\n');

test.describe.configure({ mode: 'serial' });

test('meeting page: the organizer adds a file and links a task; an invitee opens the file and is told only that a task they cannot see is linked', async ({ browser, playwright }) => {
  test.setTimeout(180_000);
  const tag = randomUUID().slice(0, 6);
  const cto = await apiAs(playwright, CTO);
  const start = new Date();
  const task = (await (
    await cto.post('/tasks', { title: `Meeting task ${tag}`, assignee: DEV1, size: 'S', estimatedHours: 4, startDate: start.toISOString(), deadline: new Date(start.getTime() + 5 * 86_400_000).toISOString(), confirmWarnings: true })
  ).json()) as { id: string; number: string };
  const dev1 = await apiAs(playwright, DEV1);
  const meeting = (await (
    await dev1.post('/comms/meetings', { title: `Files and links ${tag}`, startsAt: new Date(start.getTime() + 2 * 86_400_000).toISOString(), durationMin: 30, location: 'Video call', participantEmpIds: [DEV2] })
  ).json()) as { id: string };

  const organizer = await openAs(browser, DEV1, `/meetings/${meeting.id}`);
  await organizer.page.goto(`/meetings/${meeting.id}`);
  await organizer.page.getByLabel('Choose a file for the meeting').setInputFiles({ name: `slides-${tag}.pdf`, mimeType: 'application/pdf', buffer: PDF });
  const card = (page: typeof organizer.page) => page.getByRole('button', { name: new RegExp(`slides-${tag}\\.pdf`) });
  await expect(card(organizer.page)).toBeVisible({ timeout: 30_000 });
  await expect(organizer.page.getByText('Checking for viruses…')).toHaveCount(0, { timeout: 30_000 });
  await organizer.page.getByLabel('Link a task').selectOption({ label: `${task.number} · Meeting task ${tag}` });
  await expect(organizer.page.getByRole('link', { name: new RegExp(task.number) })).toBeVisible({ timeout: 10_000 });

  const invitee = await openAs(browser, DEV2, `/meetings/${meeting.id}`);
  await invitee.page.goto(`/meetings/${meeting.id}`);
  await expect(card(invitee.page)).toBeVisible({ timeout: 10_000 });
  const download = invitee.page.waitForEvent('download');
  await card(invitee.page).click();
  expect((await download).suggestedFilename()).toBe(`slides-${tag}.pdf`);
  await expect(invitee.page.getByText("1 linked task you can't open")).toBeVisible();
  await expect(invitee.page.getByText(task.number)).toHaveCount(0);
  await expect(invitee.page.getByLabel('Choose a file for the meeting')).toHaveCount(0); // invitees do not add files
  // The organizer unlinks it.
  await organizer.page.getByRole('button', { name: `Unlink ${task.number}` }).click();
  await expect(organizer.page.getByRole('link', { name: new RegExp(task.number) })).toHaveCount(0, { timeout: 10_000 });
  for (const x of [organizer, invitee]) await x.context.close();
});

test('retention card: a comms admin records the periods after confirming again, with a reason; everyone sees the policy', async ({ browser, playwright }) => {
  test.setTimeout(180_000);
  const admin = await openAs(browser, CTO, '/messages/channels');
  await admin.page.goto('/messages/channels');
  await expect(admin.page.getByText(/management has not set the periods yet|Retention set by management/)).toBeVisible({ timeout: 15_000 });
  await admin.page.getByLabel('Messages are kept for').selectOption('730');
  await admin.page.getByLabel('Files are kept for').selectOption('365');
  await admin.page.getByRole('button', { name: 'Save', exact: true }).click();
  await stepUpInUi(admin.page, CTO);
  await giveReason(admin.page, 'Director decision on retention', 'Save');
  await expect(admin.page.getByText('Retention set by management: messages 2 years, files 1 year. Automatic removal is not switched on yet.')).toBeVisible({ timeout: 15_000 });

  // A member sees the policy in a conversation's details.
  const group = (await (await (await apiAs(playwright, DEV1)).post('/comms/conversations', { kind: 'group', name: `Policy ${randomUUID().slice(0, 6)}`, memberEmpIds: [DEV2] })).json()).conversation.id as string;
  const member = await openAs(browser, DEV1, '/messages');
  await goLive(member.page, `/messages/${group}`);
  await member.page.getByRole('button', { name: 'Conversation details' }).click();
  await expect(member.page.getByText(/Retention set by management: messages 2 years, files 1 year/)).toBeVisible({ timeout: 10_000 });
  // A non-admin cannot see the card.
  await member.page.goto('/messages/channels');
  await expect(member.page.getByLabel('Messages are kept for')).toHaveCount(0);
  for (const x of [admin, member]) await x.context.close();
});

test('channels: a comms admin creates a project channel in the live dialog; moderation, a non-member admin appointing a moderator, and archiving reach members live', async ({ browser, playwright }) => {
  test.setTimeout(240_000);
  const tag = randomUUID().slice(0, 6);
  const name = `northwind-${tag}`;
  const creator = await openAs(browser, DIRECTOR, '/messages?new=1');
  await creator.page.goto('/messages?new=1');
  await creator.page.getByRole('radio', { name: /Channel/ }).click();
  await creator.page.locator('#ch-name').fill(name);
  await creator.page.locator('#ch-scope').selectOption({ label: 'Northwind Studio website' });
  await creator.page.getByLabel('Search people').fill('Fahad');
  await creator.page.getByRole('checkbox', { name: 'Add Fahad Khan' }).click();
  await creator.page.getByLabel('Search people').fill('Mariam');
  await creator.page.getByRole('checkbox', { name: 'Add Mariam Shah' }).click();
  await creator.page.getByRole('button', { name: 'Create channel' }).click();
  await creator.page.waitForURL(/\/messages\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const channel = creator.page.url().split('/').pop()!;
  const director = await apiAs(playwright, DIRECTOR);
  const projects = (await (await director.get('/projects')).json()) as Array<{ id: string; name: string }>;
  const northwind = projects.find((p) => p.name === 'Northwind Studio website')!;
  expect((await (await director.get(`/comms/conversations/${channel}`)).json()).projectId).toBe(northwind.id);

  // A member's message is removed by the moderator (the Director created it), with a reason; Mariam sees it at once.
  const dev1 = await apiAs(playwright, DEV1);
  const text = `Wrong channel for this ${tag}`;
  expect((await dev1.post(`/comms/conversations/${channel}/messages`, { clientKey: randomUUID(), body: text })).status()).toBe(201);
  const member = await openAs(browser, DEV2, '/');
  await goLive(member.page, `/messages/${channel}`);
  await goLive(creator.page, `/messages/${channel}`);
  await messageMenu(creator.page, text);
  await creator.page.getByRole('menuitem', { name: /Remove message/ }).click();
  await giveReason(creator.page, `Please use the project thread ${tag}`, 'Remove');
  await expect(member.page.getByText('Removed by a moderator')).toBeVisible({ timeout: 10_000 });
  await expect(messageRow(member.page, text)).toHaveCount(0);

  // The CTO (comms admin, not a member) makes Mariam a moderator from the channel overview, without reading it.
  const admin = await openAs(browser, CTO, '/messages/channels');
  await admin.page.goto(`/messages/${channel}`);
  await expect(admin.page.getByText('You manage this channel')).toBeVisible({ timeout: 10_000 });
  await admin.page.getByRole('button', { name: 'Open details' }).click();
  await admin.page.getByRole('button', { name: 'Make Mariam Shah a moderator' }).click();
  await member.page.getByRole('button', { name: 'Conversation details' }).click();
  await expect(member.page.getByRole('button', { name: 'Rename' })).toBeVisible({ timeout: 10_000 });

  // The CTO archives it: Mariam's composer gives way to the archived notice, live.
  await admin.page.getByRole('button', { name: 'Archive' }).click();
  await giveReason(admin.page, `Project handed over ${tag}`, 'Archive');
  await expect(member.page.getByText(/This conversation is archived/)).toBeVisible({ timeout: 10_000 });
  expect((await dev1.post(`/comms/conversations/${channel}/messages`, { clientKey: randomUUID(), body: 'late' })).status()).toBe(409);
  for (const x of [creator, member, admin]) await x.context.close();
});

test('a file uploaded while the scanner is down waits unopenable, and opens on the other screen live once ClamAV has checked it', async ({ browser, playwright }) => {
  test.setTimeout(420_000);
  const tag = randomUUID().slice(0, 6);
  const dev1 = await apiAs(playwright, DEV1);
  const group = (await (await dev1.post('/comms/conversations', { kind: 'group', name: `Late scan ${tag}`, memberEmpIds: [DEV2] })).json()).conversation.id as string;
  const a = await openAs(browser, DEV1, '/');
  const b = await openAs(browser, DEV2, '/');
  await goLive(a.page, `/messages/${group}`);
  await goLive(b.page, `/messages/${group}`);
  await stopClamd();
  try {
    const uploaded = a.page.waitForResponse((r) => r.request().method() === 'POST' && /\/comms\/conversations\/[0-9a-f-]{36}\/files$/.test(r.url()));
    await a.page.locator('input[type=file]').first().setInputFiles({ name: `late-${tag}.pdf`, mimeType: 'application/pdf', buffer: PDF });
    const upload = (await (await uploaded).json()) as { id: string; scan: string };
    expect(upload.scan).toBe('scanning');
    const fileId = upload.id;
    const chip = a.page.locator('li').filter({ has: a.page.getByRole('button', { name: `Remove late-${tag}.pdf` }) });
    await expect(chip).toContainText('Scanning…', { timeout: 30_000 });
    // The screen does not send a file that is still being checked.
    await a.page.getByPlaceholder(/^Message /).fill('Not yet');
    await expect(a.page.getByRole('button', { name: 'Send' })).toBeDisabled();
    // The API accepts it attached to a message, and nobody can open it until the check passes.
    expect((await dev1.post(`/comms/conversations/${group}/messages`, { clientKey: randomUUID(), body: `Late file ${tag}`, attachmentIds: [fileId] })).status()).toBe(201);
    await expect(messageRow(b.page, `Late file ${tag}`).getByText('Checking for viruses…')).toBeVisible({ timeout: 10_000 });
    expect((await (await apiAs(playwright, DEV2)).get(`/comms/files/${fileId}/download`)).status()).toBe(409);
  } finally {
    await startClamd();
  }
  // The scan job runs again within a few minutes (1 minute, then the job runner's 30-second tick): Mariam's screen
  // updates by itself, and she can open the file.
  await expect(messageRow(b.page, `Late file ${tag}`).getByText('Checking for viruses…')).toHaveCount(0, { timeout: 240_000 });
  const download = b.page.waitForEvent('download');
  await messageRow(b.page, `Late file ${tag}`).getByRole('button', { name: new RegExp(`late-${tag}\\.pdf`) }).click();
  expect((await download).suggestedFilename()).toBe(`late-${tag}.pdf`);
  for (const x of [a, b]) await x.context.close();
});

test('notification switches: with "New message" emails off, the person still gets the notification in the app but no email; someone with it on gets both', async ({ browser, playwright, request }) => {
  test.setTimeout(240_000);
  const mariam = await openAs(browser, DEV2, '/notifications');
  await mariam.page.goto('/notifications');
  const toggle = mariam.page.locator('#pref-message_new');
  await expect(toggle).toBeVisible({ timeout: 15_000 });
  if ((await toggle.getAttribute('aria-checked')) !== 'false') await toggle.click();
  await mariam.page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(mariam.page.getByText('Email preferences saved')).toBeVisible({ timeout: 10_000 });
  const dev2 = await apiAs(playwright, DEV2);
  expect((await (await dev2.get('/notifications/prefs')).json()).email.message_new).toBe(false);
  const dev3 = await apiAs(playwright, DEV3);
  const ali = (await (await dev3.get('/notifications/prefs')).json()) as { email: Record<string, boolean>; dailySummary: boolean };
  if (ali.email.message_new === false) expect((await dev3.patch('/notifications/prefs', { email: { ...ali.email, message_new: true }, dailySummary: ali.dailySummary })).status()).toBe(200);

  // Fahad writes to both (each has read their DM first, so this is a new unread conversation for them).
  const dev1 = await apiAs(playwright, DEV1);
  const count = async (to: string) => ((await (await request.get(`${MAILPIT}/search?query=${encodeURIComponent(`to:${to} subject:"New message from Fahad Khan"`)}`)).json()).messages?.length ?? 0) as number;
  const before = { mariam: await count('mariam@acevatech.com'), ali: await count('ali@acevatech.com') };
  const started = new Date().toISOString();
  for (const [client, empId] of [[dev2, DEV2], [dev3, DEV3]] as const) {
    const dm = (await (await dev1.post('/comms/conversations', { kind: 'dm', empId })).json()).conversation.id as string;
    const seq = (await (await client.get(`/comms/conversations/${dm}`)).json()).lastSeq as number;
    if (seq) await client.post(`/comms/conversations/${dm}/read`, { seq });
    expect((await dev1.post(`/comms/conversations/${dm}/messages`, { clientKey: randomUUID(), body: `Preference check ${randomUUID().slice(0, 6)}` })).status()).toBe(201);
  }
  // Ali (on) gets the email; by then the sender has run for Mariam too, and she has none, but the bell has it.
  await expect.poll(() => count('ali@acevatech.com'), { timeout: 90_000, intervals: [3_000] }).toBeGreaterThan(before.ali);
  const inApp = (await (await dev2.get('/notifications')).json()) as Array<{ title: string; at: string }>;
  expect(inApp.some((n) => n.title === 'New message from Fahad Khan' && n.at >= started)).toBe(true);
  expect(await count('mariam@acevatech.com')).toBe(before.mariam);
  await mariam.context.close();
});
