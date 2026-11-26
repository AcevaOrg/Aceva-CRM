import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { COMMS_NOTIFICATIONS_CONSUMER } from '../src/comms/comms-notifications.consumer';
import { OutboxConsumerRunner } from '../src/events/outbox-consumer-runner.service';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 14 notifications through the shared Module 12 core (plan section 19): new messages in DMs and groups (one per
 * conversation until read), mentions and replies; never the message text, never for one's own message, never for a
 * message the person cannot read (no longer a member, deleted, or already read).
 */
const API = '/api/v1/comms';
const DIRECTOR = 'ACV-0003'; // comms.admin
const DEV1 = 'ACV-0006'; // dep-eng
const DEV2 = 'ACV-0007'; // dep-eng
const DEV3 = 'ACV-0008'; // dep-eng
const SALES1 = 'ACV-0009'; // dep-sales

/** A unique word put in every message; it must never reach a notification or an email. */
const SECRET = `zq${randomUUID().replace(/-/g, '').slice(0, 14)}`;

let t: TestApp;
let prisma: PrismaClient;
let runner: OutboxConsumerRunner;
const ids: Record<string, string> = {};

const as = (empId: string) => t.as(empId);
const conv = (id: string) => `${API}/conversations/${id}`;
const drain = () => runner.drain(COMMS_NOTIFICATIONS_CONSUMER);
const nextMinute = () => t.clock.advance(61_000);

async function create(who: string, body: Record<string, unknown>) {
  const res = await as(who).post(`${API}/conversations`).send(body);
  expect([200, 201], JSON.stringify(res.body)).toContain(res.status);
  return res.body.conversation.id as string;
}

async function send(who: string, conversationId: string, body: string, extra: Record<string, unknown> = {}) {
  const res = await as(who).post(`${conv(conversationId)}/messages`).send({ clientKey: randomUUID(), body, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.message as { id: string; seq: number };
}

async function read(who: string, conversationId: string, seq: number) {
  const res = await as(who).post(`${conv(conversationId)}/read`).send({ seq });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

/** The person's notifications about one conversation (by its link), oldest first. */
async function notificationsOf(empId: string, conversationId: string) {
  return prisma.notification.findMany({
    where: { recipientId: ids[empId], link: { startsWith: `/messages/${conversationId}` } },
    orderBy: { createdAt: 'asc' },
    include: { deliveries: true },
  });
}

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  prisma = createTestPrisma();
  runner = t.app.get(OutboxConsumerRunner);
  for (const e of await prisma.employee.findMany({ select: { id: true, empId: true } })) ids[e.empId] = e.id;
  await drain(); // start from a clean reader
});

afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120_000);

describe('new messages in a DM', () => {
  it('tells the other person once per conversation until they read it, without the text, and never the author', async () => {
    nextMinute();
    const dm = await create(DEV1, { kind: 'dm', empId: DEV2 });
    await send(DEV1, dm, `first ${SECRET}`);
    await send(DEV1, dm, `second ${SECRET}`);
    await drain();
    let toDev2 = await notificationsOf(DEV2, dm);
    expect(toDev2).toHaveLength(1);
    expect(toDev2[0]).toMatchObject({ type: 'message_new', title: 'New message from Fahad Khan', body: null, link: `/messages/${dm}`, essential: false });
    expect(toDev2[0].deliveries.map((d) => d.status)).toEqual(['pending']);
    expect(await notificationsOf(DEV1, dm)).toHaveLength(0);

    // Read, then a new message: a second notification.
    const last = await send(DEV1, dm, `third ${SECRET}`);
    await read(DEV2, dm, last.seq);
    const fourth = await send(DEV1, dm, `fourth ${SECRET}`);
    await drain();
    toDev2 = await notificationsOf(DEV2, dm);
    expect(toDev2).toHaveLength(2);

    // Already read when the reader gets to it (seen live): nothing more.
    await read(DEV2, dm, fourth.seq);
    const fifth = await send(DEV1, dm, `fifth ${SECRET}`);
    await read(DEV2, dm, fifth.seq);
    await drain();
    expect(await notificationsOf(DEV2, dm)).toHaveLength(2);

    // The text never appears in a notification.
    const all = await prisma.notification.findMany({ where: { link: { startsWith: '/messages/' } } });
    expect(JSON.stringify(all)).not.toContain(SECRET);
  });

  it('respects the person turning these emails off (the notification stays in the app)', async () => {
    nextMinute();
    const prefs = await as(DEV3).patch('/api/v1/notifications/prefs').send({ email: { message_new: false }, dailySummary: true });
    expect(prefs.status, JSON.stringify(prefs.body)).toBe(200);
    const dm = await create(DEV1, { kind: 'dm', empId: DEV3 });
    await send(DEV1, dm, `hello ${SECRET}`);
    await drain();
    const toDev3 = await notificationsOf(DEV3, dm);
    expect(toDev3).toHaveLength(1);
    expect(toDev3[0].deliveries.map((d) => [d.status, d.note])).toEqual([['skipped', 'turned_off']]);
  });
});

describe('groups: mentions, replies and members', () => {
  it('sends the mentioned person a mention (not also a new-message notice), and replies to the author answered', async () => {
    nextMinute();
    const group = await create(DEV1, { kind: 'group', name: `Notify ${SECRET.slice(0, 6)}`, memberEmpIds: [DEV2, DEV3] });
    const parent = await send(DEV2, group, `question ${SECRET}`);
    await drain();
    // Only what the answer causes counts from here (the question told DEV1 and DEV3 already).
    const earlier = new Set((await prisma.notification.findMany({ where: { link: { startsWith: `/messages/${group}` } }, select: { id: true } })).map((n) => n.id));
    const fresh = async (empId: string) => (await notificationsOf(empId, group)).filter((n) => !earlier.has(n.id));

    await send(DEV1, group, `@${DEV3} answer ${SECRET}`, { parentId: parent.id });
    await drain();
    const dev3 = await fresh(DEV3);
    expect(dev3.map((n) => n.type)).toEqual(['message_mention']);
    expect(dev3[0].title).toBe(`Fahad Khan mentioned you in Notify ${SECRET.slice(0, 6)}`);
    const dev2 = await fresh(DEV2);
    expect(dev2.map((n) => n.type)).toEqual(['message_reply']);
    expect(dev2[0].link).toBe(`/messages/${group}?m=${parent.id}`);
    expect(await fresh(DEV1)).toHaveLength(0);
  });

  it('never tells someone removed from the group, or about a message deleted before the reader got to it', async () => {
    nextMinute();
    const group = await create(DEV1, { kind: 'group', name: 'Removal check', memberEmpIds: [DEV2, DEV3] });
    const removed = await as(DEV1).delete(`${conv(group)}/members/${DEV3}`);
    expect(removed.status, JSON.stringify(removed.body)).toBe(200);
    const gone = await send(DEV1, group, `soon deleted ${SECRET}`);
    expect((await as(DEV1).delete(`${API}/messages/${gone.id}`)).status).toBe(200);
    await drain();
    expect(await notificationsOf(DEV2, group)).toHaveLength(0);
    await send(DEV1, group, `kept ${SECRET}`);
    await drain();
    expect(await notificationsOf(DEV2, group)).toHaveLength(1);
    expect(await notificationsOf(DEV3, group)).toHaveLength(0);
  });
});

describe('channels', () => {
  it('notify mentions and replies only, never every new message', async () => {
    nextMinute();
    const channel = await create(DIRECTOR, { kind: 'channel', scope: 'project', name: `notify-${SECRET.slice(2, 8)}`, projectName: 'Notification check', memberEmpIds: [DEV1, DEV2, SALES1] });
    const parent = await send(DEV2, channel, `channel question ${SECRET}`);
    await send(DEV1, channel, `channel answer ${SECRET}`, { parentId: parent.id });
    await send(DEV1, channel, `@${SALES1} have a look ${SECRET}`);
    await drain();
    expect((await notificationsOf(DEV2, channel)).map((n) => n.type)).toEqual(['message_reply']);
    expect((await notificationsOf(SALES1, channel)).map((n) => n.type)).toEqual(['message_mention']);
    expect(await notificationsOf(DIRECTOR, channel)).toHaveLength(0);
    expect((await notificationsOf(SALES1, channel))[0].title).toMatch(/ in #notify-/);
  });
});
