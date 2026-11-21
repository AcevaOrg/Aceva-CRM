import { randomUUID } from 'node:crypto';
import Redis from 'ioredis';
import { io } from 'socket.io-client';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import {
  MAX_SOCKETS_PER_PERSON,
  PASSIVE_REQUEST_HEADER,
  REALTIME_PATH,
  SCREEN_HEADER,
  type ConversationChangedEvent,
  type MessageCreatedEvent,
  type MessageUpdatedEvent,
  type PresenceEvent,
  type PresenceSnapshotEvent,
  type ReceiptEvent,
  type SyncReply,
} from '@aceva/contracts';
import { CryptoService } from '../src/auth/crypto.service';
import { COMMS_TOPIC } from '../src/comms/realtime/comms-realtime.publisher';
import { ConnectionRegistry } from '../src/comms/realtime/connection-registry.service';
import { OutboxConsumerRunner } from '../src/events/outbox-consumer-runner.service';
import type { PrismaClient } from '../src/generated/prisma/client';
import { OffboardingService } from '../src/people/offboarding.service';
import { seedDevPasswords } from '../prisma/seed-dev-passwords';
import { createTestApp, TEST_PASSWORD, type SignedIn, type TestApp } from './helpers/app';
import { createEmployee } from './helpers/people';
import { createTestPrisma } from './helpers/prisma';
import { connect, listen, refusalOf, resetAttempts, settle, upgradeStatus, type LiveClient, type LiveServer } from './helpers/realtime';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 14, part 2 (M14.2): live delivery over WebSockets, against the real database and Redis, with TWO server copies
 * (A and B) sharing them, as in production behind a load balancer. Messages are always sent through REST on one server
 * and must reach sockets on the other through the Redis relay.
 *
 * Negative checks ("this person received nothing") are made deterministic with a barrier: a later event the same socket
 * IS allowed to receive, published after the forbidden one through the same server, followed by `settle()` (both
 * servers' delivery queues drained). Redis delivers one publisher's messages in order, so once the barrier arrived the
 * forbidden one has been handled.
 */
const API = '/api/v1/comms';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004'; // comms.admin, head of dep-eng
const DEV1 = 'ACV-0006'; // dep-eng
const DEV2 = 'ACV-0007'; // dep-eng
const DEV3 = 'ACV-0008'; // dep-eng
const SALES1 = 'ACV-0009'; // dep-sales
const SQA = 'ACV-0011'; // dep-eng

/** A unique word in private messages: it must never travel through Redis or reach a log. */
const SECRET = `zq${randomUUID().replace(/-/g, '').slice(0, 14)}`;

let A: LiveServer;
let B: LiveServer;
let tA: TestApp;
let tB: TestApp;
let prisma: PrismaClient;
const ids: Record<string, string> = {};
const open: LiveClient[] = [];

// ---- Everything written to the console while this file runs ----
const captured: string[] = [];
const restore: Array<() => void> = [];
function captureOutput() {
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write;
    restore.push(() => (stream.write = original as typeof stream.write));
  }
}

// ---- Everything published on the relay while this file runs (a separate Redis connection listening to every topic) ----
const relayed: string[] = [];
let spy: Redis | null = null;

const as = (empId: string) => tA.as(empId) as SignedIn;
const conv = (id: string) => `${API}/conversations/${id}`;
const msg = (id: string) => `${API}/messages/${id}`;

/** Both server copies see the same time (each has its own test clock). Live connection entries are kept fresh. */
async function advance(ms: number) {
  tA.clock.advance(ms);
  tB.clock.advance(ms);
  await A.gateway.keepAlive();
  await B.gateway.keepAlive();
  await A.gateway.sweepPresence();
  await B.gateway.sweepPresence();
}
const nextMinute = () => advance(61_000);

async function live(server: LiveServer, who: string | SignedIn, options: { ack?: boolean } = {}): Promise<LiveClient> {
  const cookie = typeof who === 'string' ? as(who).cookie : who.cookie;
  const c = await connect(server, { cookie, ...options });
  open.push(c);
  await c.waitFor('presence.snapshot');
  return c;
}

async function create(who: string, body: Record<string, unknown>, status = 201) {
  const res = await as(who).post(`${API}/conversations`).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.conversation as { id: string };
}

async function send(who: string, conversationId: string, body: string) {
  const res = await as(who).post(`${conv(conversationId)}/messages`).send({ clientKey: randomUUID(), body });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.message as { id: string; seq: number };
}

async function moveDepartment(empId: string, departmentId: string) {
  const res = await as(DIRECTOR).patch(`/api/v1/employees/${empId}/basic`).send({ departmentId, reason: 'Module 14 realtime test: department move' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

/** The session behind a cookie, as Redis holds it (the fast copy) and as PostgreSQL holds it. */
async function sessionState(cookie: string) {
  const token = decodeURIComponent(cookie.slice(cookie.indexOf('=') + 1));
  const hash = tA.app.get(CryptoService).sha256(token);
  const raw = await A.redis.client.get(A.redis.key(`sess:${hash}`));
  const row = await prisma.session.findUniqueOrThrow({ where: { tokenHash: hash }, select: { id: true, lastActiveAt: true, revokedAt: true, revokedReason: true } });
  return { id: row.id, cachedLastActive: raw ? (JSON.parse(raw) as { lastActiveAt: number }).lastActiveAt : null, dbLastActive: row.lastActiveAt.getTime(), revokedAt: row.revokedAt, revokedReason: row.revokedReason };
}

async function waitUntil(check: () => Promise<boolean>, what: string, timeoutMs = 8_000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`Timed out waiting for: ${what}`);
}

const liveCount = (empId: string) => A.t.app.get(ConnectionRegistry).count(ids[empId], tA.clock.now().getTime());

beforeAll(async () => {
  captureOutput();
  tA = await createTestApp();
  tB = await createTestApp(); // both before anyone signs in: creating an app clears the test Redis keys
  A = await listen(tA);
  B = await listen(tB);
  await tA.signInAll();
  prisma = createTestPrisma();
  for (const e of await prisma.employee.findMany({ select: { id: true, empId: true } })) ids[e.empId] = e.id;

  spy = new Redis(process.env.REDIS_URL!, { lazyConnect: true });
  await spy.connect();
  await spy.psubscribe(`${A.redis.prefix}rt:*`);
  spy.on('pmessage', (_pattern, channel, message) => relayed.push(`${channel} ${message}`));
}, 180_000);

afterEach(async () => {
  for (const c of open.splice(0)) c.close();
  A.bus.dropPublishes = false;
  B.bus.dropPublishes = false;
  await resetAttempts(A);
});

afterAll(async () => {
  for (const r of restore.reverse()) r();
  spy?.disconnect();
  await tA.close();
  await tB.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120_000);

// Shared conversations.
let dm = ''; // DEV1 and DEV2
let group = ''; // DEV1 (moderator), DEV2, DEV3
let eng = ''; // dep-eng department channel

describe('1. connecting: the session cookie, the Origin and the login rules', () => {
  it('connects with a valid session cookie from the Aceva website', async () => {
    const c = await live(B, DEV1);
    expect(c.socket.connected).toBe(true);
  });

  it('refuses no cookie, a made-up cookie and an ended session', async () => {
    expect(await refusalOf(A, { cookie: null })).toBe('unauthenticated');
    expect(await refusalOf(A, { cookie: `aceva_session=${randomUUID()}` })).toBe('unauthenticated');
    const s = await tA.signIn(SQA);
    await s.post('/api/v1/auth/logout').expect(200);
    expect(await refusalOf(B, { cookie: s.cookie })).toBe('unauthenticated');
  });

  it('refuses another website and a missing Origin before the upgrade (CORS does not protect WebSockets)', async () => {
    const cookie = as(DEV1).cookie;
    // Engine.IO answers a refused upgrade with 400 Bad Request; only the Aceva website gets 101 Switching Protocols.
    expect(await upgradeStatus(A, { Cookie: cookie, Origin: 'https://evil.example' })).toBe(400);
    expect(await upgradeStatus(A, { Cookie: cookie, Origin: 'http://localhost:3000.evil.example' })).toBe(400);
    expect(await upgradeStatus(A, { Cookie: cookie })).toBe(400);
    expect(await upgradeStatus(A, { Cookie: cookie, Origin: A.origin })).toBe(101);
    expect(await refusalOf(A, { cookie, origin: 'https://evil.example' })).not.toBe('connected');
  });

  it('refuses a login that is not finished (authenticator code still to enter)', async () => {
    // The CTO must use 2FA: a password-only login leaves the session at "2fa_required".
    const login = await tA.rawLogin({ empId: CTO, password: TEST_PASSWORD });
    expect(login.body.status).toBe('2fa_required');
    const cookie = (login.headers['set-cookie'] as unknown as string[]).find((c) => c.startsWith('aceva_session='))!.split(';')[0];
    expect(await refusalOf(A, { cookie })).toBe('auth_incomplete');
  });

  it('never makes the session last longer: connecting, syncing and receiving do not count as activity', async () => {
    const s = await tA.signIn(DEV3);
    const before = await sessionState(s.cookie);
    await advance(5_000);
    const c = await live(A, s);
    const c2 = await live(B, s);
    for (let i = 0; i < 5; i++) await c.socket.emitWithAck('sync');
    await advance(5_000);
    await A.gateway.revalidate();
    await B.gateway.revalidate();
    const after = await sessionState(s.cookie);
    expect(after.cachedLastActive).toBe(before.cachedLastActive);
    expect(after.dbLastActive).toBe(before.dbLastActive);
    c.close();
    c2.close();
  });

  it('a passive REST read checks the session without counting as activity; a normal one counts', async () => {
    const s = await tA.signIn(DEV3);
    const before = await sessionState(s.cookie);
    await advance(2_000);
    await s.get(`${API}/conversations`).set(PASSIVE_REQUEST_HEADER, '1').expect(200);
    expect((await sessionState(s.cookie)).cachedLastActive).toBe(before.cachedLastActive);
    // The header cannot keep an ended session alive, and is ignored on changes.
    await s.get(`${API}/conversations`).expect(200);
    expect((await sessionState(s.cookie)).cachedLastActive).toBeGreaterThan(before.cachedLastActive!);
  });
});

describe('2. live delivery through the Redis relay (sent on server A, delivered on server B)', () => {
  it('delivers a new DM message to the other person on another server, saved first, without the per-person fields', async () => {
    dm = (await create(DEV1, { kind: 'dm', empId: DEV2 })).id;
    const dev2 = await live(B, DEV2);
    const dev2tab = await live(A, DEV2); // a second tab, on the other server
    const outsider = await live(B, SALES1);
    const sent = await send(DEV1, dm, `Hello ${SECRET}`);

    const got = await dev2.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === sent.id);
    expect(got).toMatchObject({ conversationId: dm, seq: sent.seq, message: { id: sent.id, seq: sent.seq, authorEmpId: DEV1, body: `Hello ${SECRET}`, deleted: false } });
    expect(got.message).not.toHaveProperty('savedByMe');
    await dev2tab.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === sent.id);
    // It was in the database before anyone was told.
    expect(await prisma.message.count({ where: { id: sent.id } })).toBe(1);

    // The outsider got nothing: barrier = a DM of their own, sent afterwards through the same server.
    const own = (await create(DIRECTOR, { kind: 'dm', empId: SALES1 })).id;
    const barrier = await send(DIRECTOR, own, 'barrier');
    await outsider.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === barrier.id);
    await settle(A, B);
    expect(outsider.all<MessageCreatedEvent>('message.created').map((e) => e.conversationId)).toEqual([own]);
  });

  it('records "delivered" when the screen acknowledges, and tells the sender (no REST call, so no activity)', async () => {
    const dev1 = await live(A, DEV1);
    const dev2 = await live(B, DEV2);
    const sent = await send(DEV1, dm, 'Did you get this?');
    await dev2.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === sent.id);
    // The acknowledgement is a round trip from the screen: wait for it to be written (flushing what has arrived).
    await waitUntil(async () => {
      await A.delivery.flushDelivered();
      await B.delivery.flushDelivered();
      const read = await prisma.conversationRead.findUniqueOrThrow({ where: { conversationId_employeeId: { conversationId: dm, employeeId: ids[DEV2] } } });
      return read.lastDeliveredSeq >= sent.seq;
    }, 'the delivered position written from the acknowledgement');
    const receipt = await dev1.waitFor<ReceiptEvent>('receipt.updated', (e) => e.empId === DEV2 && e.lastDeliveredSeq >= sent.seq);
    expect(receipt.conversationId).toBe(dm);

    // Reading (REST) is told to the other member too.
    await as(DEV2).post(`${conv(dm)}/read`).send({ seq: sent.seq }).expect(200);
    await dev1.waitFor<ReceiptEvent>('receipt.updated', (e) => e.empId === DEV2 && e.lastReadSeq >= sent.seq);
  });

  it('a screen that does not acknowledge is not marked delivered', async () => {
    const dev2 = await live(B, DEV2, { ack: false });
    const before = await prisma.conversationRead.findUniqueOrThrow({ where: { conversationId_employeeId: { conversationId: dm, employeeId: ids[DEV2] } } });
    const sent = await send(DEV1, dm, 'No ack please');
    await dev2.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === sent.id);
    await settle(A, B);
    await B.delivery.flushDelivered();
    const after = await prisma.conversationRead.findUniqueOrThrow({ where: { conversationId_employeeId: { conversationId: dm, employeeId: ids[DEV2] } } });
    expect(after.lastDeliveredSeq).toBe(before.lastDeliveredSeq);
  });

  it('delivers edits, reactions, pins and deletions as updates with the current state', async () => {
    const dev2 = await live(B, DEV2);
    const sent = await send(DEV1, dm, 'Typo heer');
    await dev2.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === sent.id);

    await as(DEV1).patch(msg(sent.id)).send({ body: 'Typo here' }).expect(200);
    const edited = await dev2.waitFor<MessageUpdatedEvent>('message.updated', (e) => e.message.id === sent.id && e.revision === 1);
    expect(edited.message).toMatchObject({ body: 'Typo here', seq: sent.seq });
    expect(edited.message.editedAt).not.toBeNull();

    // A reaction added and taken back at once: the last update always shows the final state.
    await as(DEV1).put(`${msg(sent.id)}/reactions/${encodeURIComponent('👍')}`).expect(200);
    await as(DEV1).delete(`${msg(sent.id)}/reactions/${encodeURIComponent('👍')}`).expect(200);
    await as(DEV1).put(`${msg(sent.id)}/pin`).expect(200);
    const pinned = await dev2.waitFor<MessageUpdatedEvent>('message.updated', (e) => e.message.id === sent.id && e.message.pinned);
    expect(pinned.message.reactions).toEqual([]);

    await as(DEV1).delete(msg(sent.id)).expect(200);
    const deleted = await dev2.waitFor<MessageUpdatedEvent>('message.updated', (e) => e.message.id === sent.id && e.message.deleted);
    expect(deleted.message).toMatchObject({ body: '', deletedAs: 'author', pinned: false, reactions: [] });
    expect(deleted.revision).toBe(2);
  });

  it('a duplicate pointer gives the same message again (screens drop it by its number); the database decides the content', async () => {
    const dev2 = await live(B, DEV2);
    const sent = await send(DEV1, dm, 'Once');
    await dev2.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === sent.id);
    await A.bus.publish(COMMS_TOPIC, { kind: 'message', conversationId: dm, messageId: sent.id, created: true });
    await waitUntil(async () => dev2.all<MessageCreatedEvent>('message.created').filter((e) => e.message.id === sent.id).length === 2, 'the duplicate');
    const copies = dev2.all<MessageCreatedEvent>('message.created').filter((e) => e.message.id === sent.id);
    expect(copies[0]).toEqual(copies[1]);
    // A pointer for a message of another conversation, or for nothing, delivers nothing.
    await A.bus.publish(COMMS_TOPIC, { kind: 'message', conversationId: dm, messageId: randomUUID(), created: true });
    const barrier = await send(DEV1, dm, 'barrier 2');
    await dev2.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === barrier.id);
    await settle(A, B);
    expect(dev2.all('message.created')).toHaveLength(3);
  });
});

describe('3. every delivery is authorised from the database: removals, joins, history start, department moves', () => {
  it('a person added to a group gets only messages after they joined, even one delayed past their joining', async () => {
    await nextMinute();
    group = (await create(DEV1, { kind: 'group', name: 'Live group', memberEmpIds: [DEV2, DEV3] })).id;
    const before = await send(DEV1, group, 'Before SQA joins');
    const sqa = await live(B, SQA);
    const dev2 = await live(B, DEV2);

    // A message whose broadcast is lost, then the add: SQA's history starts after it.
    A.bus.dropPublishes = true;
    const delayed = await send(DEV1, group, 'Sent while the relay was down');
    A.bus.dropPublishes = false;
    const since = sqa.events.length;
    await as(DEV1).post(`${conv(group)}/members`).send({ empIds: [SQA] }).expect(200);
    await sqa.waitFor<ConversationChangedEvent>('conversation.changed', (e) => e.conversationId === group, { since });

    // The delayed broadcast finally goes out (for example from the outbox safety net): the old member gets it, SQA does not.
    await A.bus.publish(COMMS_TOPIC, { kind: 'message', conversationId: group, messageId: delayed.id, created: true });
    await dev2.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === delayed.id);
    const after = await send(DEV1, group, 'Welcome SQA');
    await sqa.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === after.id);
    await settle(A, B);
    expect(sqa.all<MessageCreatedEvent>('message.created').map((e) => e.message.id)).toEqual([after.id]);

    // Catching up (passive REST, after=0) starts at the same place.
    const history = await as(SQA).get(`${conv(group)}/messages?after=0`).set(PASSIVE_REQUEST_HEADER, '1').expect(200);
    expect(history.body.items.map((m: { id: string }) => m.id)).toEqual([after.id]);
    expect([before.id, delayed.id].some((id) => history.body.items.some((m: { id: string }) => m.id === id))).toBe(false);
  });

  it('a removed member is taken out at once: told the conversation is gone, and gets nothing more', async () => {
    const dev3 = await live(A, DEV3);
    const dev2 = await live(B, DEV2);
    await as(DEV1).delete(`${conv(group)}/members/${DEV3}`).expect(200);
    await dev3.waitFor('conversation.removed', (e: { conversationId: string }) => e.conversationId === group);
    const secret = await send(DEV1, group, `After DEV3 left ${SECRET}`);
    await dev2.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === secret.id);
    // Barrier for DEV3: a DM to them sent afterwards.
    const own = (await create(DEV1, { kind: 'dm', empId: DEV3 })).id;
    const barrier = await send(DEV1, own, 'barrier 3');
    await dev3.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === barrier.id);
    await settle(A, B);
    expect(dev3.all<MessageCreatedEvent>('message.created').map((e) => e.message.id)).toEqual([barrier.id]);
    const serverSide = A.gateway.localSockets().find((s) => s.id === dev3.socket.id)!;
    expect(serverSide.rooms.has(`conv:${group}`)).toBe(false);
  });

  it('department channel: moving out ends delivery at once; moving in starts it, never before the join', async () => {
    await nextMinute();
    eng = (await create(CTO, { kind: 'channel', scope: 'department', departmentId: 'dep-eng', name: 'live-engineering' })).id;
    const dev1 = await live(A, DEV1);
    const sales = await live(B, SALES1);
    const dev2 = await live(B, DEV2);
    await send(DEV2, eng, 'First');
    await dev1.waitFor<MessageCreatedEvent>('message.created', (e) => e.conversationId === eng);

    try {
      // No event is written for a department move: the next delivery checks the employee records.
      A.bus.dropPublishes = true;
      const old = await send(DEV2, eng, 'Just before the move');
      A.bus.dropPublishes = false;
      await moveDepartment(DEV1, 'dep-sales');
      await moveDepartment(SALES1, 'dep-eng');
      await A.bus.publish(COMMS_TOPIC, { kind: 'message', conversationId: eng, messageId: old.id, created: true }); // late
      const next = await send(DEV2, eng, `After the move ${SECRET}`);
      await sales.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === next.id);
      await dev1.waitFor('conversation.removed', (e: { conversationId: string }) => e.conversationId === eng);
      await dev2.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === next.id);
      await settle(A, B);
      expect(sales.all<MessageCreatedEvent>('message.created').map((e) => e.message.id)).toEqual([next.id]); // not the late one
      expect(dev1.all<MessageCreatedEvent>('message.created').some((e) => e.message.id === next.id || e.message.id === old.id)).toBe(false);
      expect(dev2.all<MessageCreatedEvent>('message.created').some((e) => e.message.id === old.id)).toBe(true);
    } finally {
      await moveDepartment(DEV1, 'dep-eng');
      await moveDepartment(SALES1, 'dep-sales');
    }
  });

  it('a new department head receives from their start only; the re-check follows the move for the rooms', async () => {
    const dep = await prisma.department.findFirstOrThrow({ where: { code: 'dep-eng' }, select: { id: true, headEmployeeId: true } });
    const sales = await live(A, SALES1);
    const before = await send(DEV2, eng, 'Before the new head');
    try {
      await prisma.department.update({ where: { id: dep.id }, data: { headEmployeeId: ids[SALES1] } }); // the trigger records the start
      await A.gateway.revalidate(); // the minute re-check puts SALES1's socket in the channel room
      expect(A.gateway.localSockets().find((s) => s.id === sales.socket.id)!.rooms.has(`conv:${eng}`)).toBe(true);
      await A.bus.publish(COMMS_TOPIC, { kind: 'message', conversationId: eng, messageId: before.id, created: true });
      const after = await send(DEV2, eng, 'Hello new head');
      await sales.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === after.id);
      await settle(A, B);
      expect(sales.all<MessageCreatedEvent>('message.created').map((e) => e.message.id)).toEqual([after.id]);
    } finally {
      await prisma.department.update({ where: { id: dep.id }, data: { headEmployeeId: dep.headEmployeeId } });
    }
    await A.gateway.revalidate();
    await sales.waitFor('conversation.removed', (e: { conversationId: string }) => e.conversationId === eng);
  });

  it('channel read positions go only to that person; DM positions to both', async () => {
    const dev1 = await live(A, DEV1);
    const dev2 = await live(B, DEV2);
    const m = await send(DEV2, eng, 'Read me');
    await dev1.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === m.id);
    await as(DEV1).post(`${conv(eng)}/read`).send({ seq: m.seq }).expect(200);
    await dev1.waitFor<ReceiptEvent>('receipt.updated', (e) => e.conversationId === eng && e.empId === DEV1 && e.lastReadSeq >= m.seq);
    const barrier = await send(DEV1, dm, 'barrier 4');
    await dev2.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === barrier.id);
    await settle(A, B);
    expect(dev2.all<ReceiptEvent>('receipt.updated').filter((e) => e.conversationId === eng && e.empId === DEV1)).toEqual([]);
  });
});

describe('4. ending a session closes its sockets on every server at once', () => {
  it('logout closes that session’s sockets on both servers; the same person’s other session stays', async () => {
    const s1 = await tA.signIn(DEV3);
    const s2 = await tA.signIn(DEV3);
    const a1 = await live(A, s1);
    const b1 = await live(B, s1);
    const b2 = await live(B, s2);
    await s1.post('/api/v1/auth/logout');
    await a1.waitFor('session.ended');
    await b1.waitFor('session.ended');
    await Promise.all([a1.closed, b1.closed]);
    expect(b2.socket.connected).toBe(true);
    expect(await refusalOf(A, { cookie: s1.cookie })).toBe('unauthenticated');
  });

  it('"log out my other devices", an admin force-logout and a password reset by HR all close the sockets', async () => {
    const keep = await tA.signIn(DEV3);
    const other = await tA.signIn(DEV3);
    const keepSocket = await live(A, keep);
    const otherSocket = await live(B, other);
    await keep.delete('/api/v1/auth/sessions').expect(200);
    await otherSocket.waitFor('session.ended');
    expect(keepSocket.socket.connected).toBe(true);

    const forced = await as(DIRECTOR).post(`/api/v1/auth/employees/${DEV3}/force-logout`).send({ reason: 'Realtime test: force logout' });
    expect(forced.status, JSON.stringify(forced.body)).toBe(200);
    await keepSocket.waitFor('session.ended');
  });

  it('leaving the company (offboarding) closes every socket of that person and refuses new ones', async () => {
    const hire = await createEmployee(prisma, { name: 'Realtime Leaver', reportsToEmpId: CTO });
    await seedDevPasswords(prisma, TEST_PASSWORD);
    const s = await tA.signIn(hire.empId);
    const a = await live(A, s);
    const b = await live(B, s);
    const yesterday = new Date(tA.clock.now().getTime() - 86_400_000);
    await prisma.employee.update({ where: { id: hire.id }, data: { status: 'on_notice', lastWorkingDay: new Date(Date.UTC(yesterday.getUTCFullYear(), yesterday.getUTCMonth(), yesterday.getUTCDate())) } });
    await tA.app.get(OffboardingService).process(hire.empId);
    await a.waitFor('session.ended');
    await b.waitFor('session.ended');
    expect(await refusalOf(B, { cookie: s.cookie })).toBe('unauthenticated');
  });

  it('when the "session ended" signal is lost (Redis trouble), the minute re-check still closes the socket', async () => {
    const s = await tA.signIn(DEV3);
    const b = await live(B, s);
    A.bus.dropPublishes = true;
    await s.post('/api/v1/auth/logout');
    A.bus.dropPublishes = false;
    expect(b.socket.connected).toBe(true);
    await B.gateway.revalidate();
    await b.waitFor('session.ended');
    await b.closed;
  });
});

describe('5. Redis outage and recovery: the database stays the truth', () => {
  it('a server whose relay connection breaks tells its sockets to catch up when it comes back; catch-up finds the message', async () => {
    const dev2 = await live(B, DEV2);
    const sync = (await dev2.socket.emitWithAck('sync')) as SyncReply;
    const known = sync.conversations.find((c) => c.id === dm)!.lastSeq;
    await B.bus.interruptForTest();
    const missed = await send(DEV1, dm, 'Sent during the outage'); // REST still works
    await B.bus.resumeForTest();
    await dev2.waitFor('sync.required');
    expect(dev2.all<MessageCreatedEvent>('message.created').some((e) => e.message.id === missed.id)).toBe(false);
    const after = (await dev2.socket.emitWithAck('sync')) as SyncReply;
    expect(after.conversations.find((c) => c.id === dm)!.lastSeq).toBeGreaterThan(known);
    const page = await as(DEV2).get(`${conv(dm)}/messages?after=${known}`).set(PASSIVE_REQUEST_HEADER, '1').expect(200);
    expect(page.body.items.map((m: { id: string }) => m.id)).toContain(missed.id);
    // And live delivery works again.
    const back = await send(DEV1, dm, 'Back to normal');
    await dev2.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === back.id);
  });

  it('the outbox safety net re-sends a new message whose broadcast was lost, and only that one (decision D5)', async () => {
    const runner = tA.app.get(OutboxConsumerRunner);
    await runner.drain('comms-realtime'); // anything earlier is done
    const dev2 = await live(B, DEV2);
    const ok = await send(DEV1, dm, 'Relayed normally');
    await dev2.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === ok.id);
    A.bus.dropPublishes = true;
    const lost = await send(DEV1, dm, 'Broadcast lost');
    A.bus.dropPublishes = false;
    await runner.drain('comms-realtime');
    await dev2.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === lost.id);
    await settle(A, B);
    expect(dev2.all<MessageCreatedEvent>('message.created').filter((e) => e.message.id === ok.id)).toHaveLength(1); // not re-sent
  });

  it('new connections are refused while Redis is unavailable (decision D6); existing sockets carry on', async () => {
    const dev2 = await live(B, DEV2);
    B.redis.client.disconnect(false);
    try {
      await waitUntil(async () => !B.redis.isReady, 'Redis disconnected');
      expect(await refusalOf(B, { cookie: as(DEV1).cookie })).toBe('realtime_unavailable');
      expect(dev2.socket.connected).toBe(true);
    } finally {
      await B.redis.client.connect();
      await waitUntil(async () => B.redis.isReady, 'Redis back');
    }
    const c = await live(B, DEV1);
    expect(c.socket.connected).toBe(true);
  });
});

describe('6. presence: online/offline only, only for people sharing a DM or group, across servers', () => {
  it('shows a person online to their DM partner when the first socket opens, offline when the last one closes', async () => {
    await waitUntil(async () => (await liveCount(DEV1)) === 0, 'DEV1 has no sockets');
    const dev2 = await live(B, DEV2);
    const sales = await live(B, SALES1); // shares no DM or group with DEV1 (only a channel at most)
    const since = dev2.events.length;
    const first = await live(A, DEV1);
    expect((await first.waitFor<PresenceSnapshotEvent>('presence.snapshot')).online).toContain(DEV2);
    await dev2.waitFor<PresenceEvent>('presence', (e) => e.empId === DEV1 && e.online, { since });
    const second = await live(B, DEV1);
    second.close();
    await waitUntil(async () => (await liveCount(DEV1)) === 1, 'one socket left');
    first.close();
    await dev2.waitFor<PresenceEvent>('presence', (e) => e.empId === DEV1 && !e.online, { since });
    await settle(A, B);
    expect(sales.all<PresenceEvent>('presence').filter((e) => e.empId === DEV1)).toEqual([]);
    // Nothing about presence is kept: no table, and Redis holds only live entries.
    const presenceTables = await prisma.$queryRaw<Array<{ n: bigint }>>`SELECT count(*) AS n FROM information_schema.tables WHERE table_name ILIKE '%presence%'`;
    expect(Number(presenceTables[0].n)).toBe(0);
  });

  it('a browser that goes away while its connection is being checked leaves no entry behind (not online, no place taken)', async () => {
    await waitUntil(async () => (await liveCount(SQA)) === 0, 'SQA has no sockets');
    const registry = tA.app.get(ConnectionRegistry);
    const claim = registry.claim.bind(registry);
    const raw = io(A.url, {
      path: REALTIME_PATH,
      transports: ['websocket'],
      extraHeaders: { Cookie: as(SQA).cookie, Origin: A.origin, 'X-Forwarded-For': '172.31.250.9' },
      reconnection: false,
      autoConnect: false,
      forceNew: true,
    });
    let placesWhileChecking = -1;
    // The page navigates away exactly while the server is checking the connection, after its place was taken.
    registry.claim = async (...args: Parameters<typeof claim>) => {
      const result = await claim(...args);
      placesWhileChecking = await liveCount(SQA);
      raw.disconnect();
      await new Promise((r) => setTimeout(r, 200));
      return result;
    };
    try {
      raw.connect();
      await waitUntil(async () => placesWhileChecking >= 0, 'the server took a place');
    } finally {
      registry.claim = claim;
    }
    expect(placesWhileChecking).toBe(1);
    await waitUntil(async () => (await liveCount(SQA)) === 0, 'the place given back');
    expect(raw.connected).toBe(false);
  });

  it('a server that stops without saying goodbye: its entries expire and the person goes offline', async () => {
    await waitUntil(async () => (await liveCount(DEV1)) === 0, 'DEV1 has no sockets');
    const dev2 = await live(B, DEV2);
    const registry = tA.app.get(ConnectionRegistry);
    await registry.claim(ids[DEV1], 'crashed-server:socket', tA.clock.now().getTime());
    const since = dev2.events.length;
    await advance(91_000); // refreshes only the live servers' own entries, then sweeps
    await dev2.waitFor<PresenceEvent>('presence', (e) => e.empId === DEV1 && !e.online, { since });
  });
});

describe('7. limits: five sockets per person across servers, twenty events a second per socket', () => {
  it('refuses the sixth socket whichever server it reaches, and allows it again when one closes', async () => {
    await waitUntil(async () => (await liveCount(DEV3)) === 0, 'DEV3 has no sockets', 15_000);
    const s = await tA.signIn(DEV3);
    const sockets: LiveClient[] = [];
    for (let i = 0; i < MAX_SOCKETS_PER_PERSON; i++) sockets.push(await live(i % 2 ? B : A, s));
    expect(await refusalOf(A, { cookie: s.cookie })).toBe('too_many_connections');
    const otherSession = await tA.signIn(DEV3);
    expect(await refusalOf(B, { cookie: otherSession.cookie })).toBe('too_many_connections'); // another session of the same person
    sockets[0].close();
    await waitUntil(async () => (await liveCount(DEV3)) === MAX_SOCKETS_PER_PERSON - 1, 'a place free');
    const again = await live(B, s);
    expect(again.socket.connected).toBe(true);
  });

  it('closes a socket that sends an unknown event', async () => {
    const c = await live(A, DEV2);
    c.socket.emit('message.send', { body: 'sockets cannot write' });
    await c.waitFor('closing', (e: { reason: string }) => e.reason === 'unknown_event');
    await c.closed;
  });

  it('answers at most twenty events a second; a flood closes the socket', async () => {
    const c = await live(A, DEV2);
    const ask = () => c.socket.timeout(5_000).emitWithAck('sync').catch(() => ({ error: 'closed' })) as Promise<{ error?: string; conversations?: unknown[] }>;
    // Twenty at once: all answered.
    const first = await Promise.all(Array.from({ length: 20 }, ask));
    expect(first.filter((r) => r.conversations).length).toBe(20);
    // Twenty more straight away: only what refilled meanwhile (twenty a second) is answered; the rest is refused, but
    // fewer than twenty refusals in a second do not close the socket.
    const second = await Promise.all(Array.from({ length: 20 }, ask));
    expect(second.filter((r) => r.error === 'rate_limited').length).toBeGreaterThanOrEqual(5);
    expect(c.socket.connected).toBe(true);
    // A flood: the socket is closed.
    for (let i = 0; i < 100; i++) void ask();
    await c.waitFor('closing', (e: { reason: string }) => e.reason === 'rate_limited');
    await c.closed;
  });

  it('refuses too many connection attempts from one session in a minute (reconnect storms)', async () => {
    const s = await tA.signIn(DEV3);
    let refused = '';
    await waitUntil(async () => (await liveCount(DEV3)) === 0, 'DEV3 has no sockets', 15_000);
    for (let i = 0; i < 40 && !refused; i++) {
      const code = await refusalOf(A, { cookie: s.cookie });
      if (code !== 'connected') refused = code;
      else await waitUntil(async () => (await liveCount(DEV3)) === 0, 'the socket is released');
    }
    expect(refused).toBe('too_many_attempts');
  });

  it('refuses an oversized packet', async () => {
    const c = await live(A, DEV2);
    c.socket.emit('sync', 'x'.repeat(40_000));
    await c.closed;
  });
});

describe('8. privacy: the relay and the logs never carry message text, cookies or tokens', () => {
  it('nothing published on Redis contains a message text, a cookie or a session token', async () => {
    await settle(A, B);
    expect(relayed.length).toBeGreaterThan(10);
    const tokens = [DEV1, DEV2, SALES1].map((e) => decodeURIComponent(as(e).cookie.split('=')[1]));
    for (const line of relayed) {
      expect(line).not.toContain(SECRET);
      expect(line).not.toContain('aceva_session');
      for (const token of tokens) expect(line).not.toContain(token);
    }
    expect(captured.join('\n')).not.toContain(SECRET);
  });
});

describe('10. access changes reach live sockets at once (no waiting for the minute re-check)', () => {
  /** A test-only role WITHOUT comms.use, and a test-only duty that grants it: so messaging can be taken away. */
  let person = { id: '', empId: '' };
  let session: SignedIn;

  beforeAll(async () => {
    const level = await prisma.level.findUniqueOrThrow({ where: { number: 5 }, select: { id: true } });
    const use = await prisma.permission.findUniqueOrThrow({ where: { key: 'comms.use' }, select: { id: true } });
    await prisma.role.upsert({ where: { key: 'rt-no-messaging' }, create: { key: 'rt-no-messaging', name: 'Realtime test role (no messaging)', levelId: level.id }, update: {} });
    const duty = await prisma.duty.upsert({ where: { key: 'rt-messaging' }, create: { key: 'rt-messaging', name: 'Realtime test duty (messaging)' }, update: {} });
    await prisma.dutyPermission.createMany({ data: [{ dutyId: duty.id, permissionId: use.id }], skipDuplicates: true });
    person = await createEmployee(prisma, { name: 'Realtime Duty Holder', roleKey: 'rt-no-messaging', reportsToEmpId: CTO });
    await prisma.employeeDuty.create({ data: { employeeId: person.id, dutyId: duty.id, reason: 'Realtime test' } });
    await seedDevPasswords(prisma, TEST_PASSWORD);
    session = await tA.signIn(person.empId);
    ids[person.empId] = person.id;
  });

  it('ending the duty that gave messaging closes the socket at once, with no message and no re-check', async () => {
    const c = await live(B, session);
    const res = await as(DIRECTOR).delete(`/api/v1/org/employees/${person.empId}/duties/rt-messaging`).send({ reason: 'Realtime test: messaging taken away' });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await c.waitFor('closing', (e: { reason: string }) => e.reason === 'forbidden');
    await c.closed;
    expect(await refusalOf(A, { cookie: session.cookie })).toBe('forbidden');
  });

  it('a permission taken away some other way (straight in the database) stops the very next delivery and closes the socket', async () => {
    const duty = await prisma.duty.findUniqueOrThrow({ where: { key: 'rt-messaging' }, select: { id: true } });
    await prisma.employeeDuty.create({ data: { employeeId: person.id, dutyId: duty.id, reason: 'Realtime test: given back' } });
    await nextMinute();
    const dm2 = (await create(DEV1, { kind: 'dm', empId: person.empId })).id;
    const c = await live(A, session);
    const first = await send(DEV1, dm2, 'Can you read this?');
    await c.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === first.id);
    // No API, no notification: the duty is ended directly.
    await prisma.employeeDuty.updateMany({ where: { employeeId: person.id, endedAt: null }, data: { endedAt: new Date() } });
    const hidden = await send(DEV1, dm2, `Not for you any more ${SECRET}`);
    await c.waitFor('closing', (e: { reason: string }) => e.reason === 'forbidden');
    await c.closed;
    expect(c.all<MessageCreatedEvent>('message.created').some((e) => e.message.id === hidden.id)).toBe(false);
  });

  it('a department move tells both people at once: one loses the channel, the other gains it (no message needed)', async () => {
    const dev1 = await live(A, DEV1);
    const sales = await live(B, SALES1);
    const since1 = dev1.events.length;
    const since2 = sales.events.length;
    try {
      await moveDepartment(DEV1, 'dep-sales');
      await moveDepartment(SALES1, 'dep-eng');
      await dev1.waitFor('conversation.removed', (e: { conversationId: string }) => e.conversationId === eng, { since: since1 });
      await sales.waitFor<ConversationChangedEvent>('conversation.changed', (e) => e.conversationId === eng, { since: since2 });
    } finally {
      await moveDepartment(DEV1, 'dep-eng');
      await moveDepartment(SALES1, 'dep-sales');
    }
    await dev1.waitFor<ConversationChangedEvent>('conversation.changed', (e) => e.conversationId === eng, { since: since1 });
    await sales.waitFor('conversation.removed', (e: { conversationId: string }) => e.conversationId === eng, { since: since2 + 1 });
  });

  it('a new department head (changed through the org screens) gains the channel at once and loses it when replaced', async () => {
    const sales = await live(A, SALES1);
    const since = sales.events.length;
    const change = async (headEmpId: string) => {
      const res = await as('ACV-0001').patch('/api/v1/org/departments/dep-eng').send({ headEmpId, reason: 'Realtime test: head change' });
      expect(res.status, JSON.stringify(res.body)).toBe(200);
    };
    try {
      await change(SALES1);
      await sales.waitFor<ConversationChangedEvent>('conversation.changed', (e) => e.conversationId === eng, { since });
    } finally {
      await change(CTO);
    }
    await sales.waitFor('conversation.removed', (e: { conversationId: string }) => e.conversationId === eng, { since });
  });
});

describe('11. a lost broadcast of an edit, deletion, reaction or pin is recovered from the database', () => {
  it('the outbox safety net re-sends each lost change with the current state; changes that went out are not re-sent', async () => {
    const runner = tA.app.get(OutboxConsumerRunner);
    await runner.drain('comms-realtime');
    const dev2 = await live(B, DEV2);
    const m = await send(DEV1, dm, 'Original text');
    await dev2.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === m.id);

    A.bus.dropPublishes = true; // every live signal from server A is lost from here
    await as(DEV1).patch(msg(m.id)).send({ body: 'Edited while the relay was down' }).expect(200);
    await as(DEV1).put(`${msg(m.id)}/reactions/${encodeURIComponent('🎉')}`).expect(200);
    await as(DEV1).put(`${msg(m.id)}/pin`).expect(200);
    A.bus.dropPublishes = false;
    expect(dev2.all<MessageUpdatedEvent>('message.updated').filter((e) => e.message.id === m.id)).toEqual([]);

    await runner.drain('comms-realtime');
    const recovered = await dev2.waitFor<MessageUpdatedEvent>('message.updated', (e) => e.message.id === m.id && e.message.pinned && e.message.reactions.length === 1);
    expect(recovered).toMatchObject({ revision: 1, message: { body: 'Edited while the relay was down', pinned: true, reactions: [{ emoji: '🎉', empIds: [DEV1] }] } });

    // A deletion whose broadcast is lost, too.
    A.bus.dropPublishes = true;
    await as(DEV1).delete(msg(m.id)).expect(200);
    A.bus.dropPublishes = false;
    await runner.drain('comms-realtime');
    await dev2.waitFor<MessageUpdatedEvent>('message.updated', (e) => e.message.id === m.id && e.message.deleted);

    // Changes that did go out are recognised and not sent again.
    const n = await send(DEV1, dm, 'Normal edit');
    await as(DEV1).patch(msg(n.id)).send({ body: 'Normal edit, done' }).expect(200);
    await dev2.waitFor<MessageUpdatedEvent>('message.updated', (e) => e.message.id === n.id);
    const before = dev2.all<MessageUpdatedEvent>('message.updated').filter((e) => e.message.id === n.id).length;
    await runner.drain('comms-realtime');
    const barrier = await send(DEV1, dm, 'barrier 11');
    await dev2.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === barrier.id);
    await settle(A, B);
    expect(dev2.all<MessageUpdatedEvent>('message.updated').filter((e) => e.message.id === n.id)).toHaveLength(before);
    // The change events carry ids only, never the text.
    const events = await prisma.outboxEvent.findMany({ where: { type: 'comms.message.changed' }, select: { payload: true } });
    expect(events.length).toBeGreaterThan(0);
    expect(JSON.stringify(events)).not.toContain('Edited while the relay was down');
  });

  it('a new reply re-sends its thread’s first message (the reply count), also when it comes from the safety net', async () => {
    const dev2 = await live(B, DEV2);
    const top = await send(DEV1, dm, 'Thread start');
    await dev2.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === top.id);
    A.bus.dropPublishes = true;
    const reply = await as(DEV1).post(`${conv(dm)}/messages`).send({ clientKey: randomUUID(), body: 'A reply', parentId: top.id });
    expect(reply.status).toBe(201);
    A.bus.dropPublishes = false;
    await tA.app.get(OutboxConsumerRunner).drain('comms-realtime');
    await dev2.waitFor<MessageCreatedEvent>('message.created', (e) => e.message.id === reply.body.message.id);
    await dev2.waitFor<MessageUpdatedEvent>('message.updated', (e) => e.message.id === top.id && e.message.replyCount === 1);
  });
});

describe('9. timeouts while connected (last: they move the clock past every session limit)', () => {
  it('follows the idle limit of the screen the person was last active on: 10 minutes after a finance screen, 30 elsewhere', async () => {
    const finance = await tA.signIn(DEV3);
    await finance.get('/api/v1/journal-entries'); // a finance screen (refused for DEV3, but it is the last activity)
    const heartbeat = await tA.signIn(DEV3);
    await heartbeat.get('/api/v1/auth/me').set(SCREEN_HEADER, 'finance').expect(200); // the "still here" signal from a finance screen
    const normal = await tA.signIn(DEV2);
    await normal.get('/api/v1/auth/me').expect(200);
    const a = await live(A, finance);
    const b = await live(B, heartbeat);
    const c = await live(A, normal);
    await advance(11 * 60_000);
    await A.gateway.revalidate();
    await B.gateway.revalidate();
    await a.waitFor('session.ended');
    await b.waitFor('session.ended');
    expect((await sessionState(finance.cookie)).revokedReason).toBe('idle_timeout');
    expect((await sessionState(heartbeat.cookie)).revokedReason).toBe('idle_timeout');
    expect(c.socket.connected).toBe(true); // normal screens: 30 minutes
    expect((await sessionState(normal.cookie)).revokedAt).toBeNull();
  });

  it('a socket on an idle session is closed by the re-check, and the session is ended as idle', async () => {
    const s = await tA.signIn(DEV3);
    const a = await live(A, s);
    for (let i = 0; i < 5; i++) await a.socket.emitWithAck('sync'); // socket traffic is not activity
    await advance(31 * 60_000);
    await A.gateway.revalidate();
    await a.waitFor('session.ended');
    const state = await sessionState(s.cookie);
    expect(state.revokedReason).toBe('idle_timeout');
    expect(await refusalOf(B, { cookie: s.cookie })).toBe('unauthenticated');
  });

  it('a session past its 12 hours is refused and its sockets closed', async () => {
    const s = await tA.signIn(DEV2);
    const b = await live(B, s);
    // Keep the session active (real requests) while moving towards the 12-hour end.
    for (let i = 0; i < 24; i++) {
      await advance(29 * 60_000);
      await s.get('/api/v1/auth/me').expect(200);
    }
    expect(b.socket.connected).toBe(true); // 11 h 36 min: still valid
    await advance(25 * 60_000); // 12 h 01 min, within the idle limit
    await B.gateway.revalidate();
    await b.waitFor('session.ended');
    expect((await sessionState(s.cookie)).revokedReason).toBe('max_duration');
  });
});
