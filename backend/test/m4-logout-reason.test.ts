import { createHash } from 'node:crypto';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { ActivityRecorder } from '../src/activity/activity-recorder.service';
import { OutboxDispatcher } from '../src/events/outbox-dispatcher.service';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type SignedIn, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 4: how a logout is recorded when the browser's own idle timer ends the session with the tab still open.
 * The browser's timer always runs out before the server's, so it says why it logs out ({ reason: "idle_timeout" }). The
 * server believes that only when the session really was idle for about the limit (30 minutes, 10 on a finance screen,
 * less a 2-minute tolerance); a claim made too early is recorded as a normal clicked logout.
 */
const SALES1 = 'ACV-0009';
const SALES2 = 'ACV-0012';
const MINUTE = 60_000;

let t: TestApp;
let prisma: PrismaClient;
let recorder: ActivityRecorder;
let dispatcher: OutboxDispatcher;

async function settle(): Promise<void> {
  for (let i = 0; i < 3; i++) {
    await recorder.flush();
    await dispatcher.tick();
  }
}

const sessionOf = (who: SignedIn) => prisma.session.findUniqueOrThrow({ where: { tokenHash: createHash('sha256').update(who.cookie.split('=')[1]).digest('hex') } });
/** The one logout record of a session, once Module 4 has written it. */
async function logoutRecord(who: SignedIn) {
  await settle();
  const session = await sessionOf(who);
  return prisma.activityEvent.findFirstOrThrow({ where: { action: 'logout', sessionId: session.id } });
}
const howOf = (record: { details: unknown }) => (record.details as { how: string; reason: string }).how;
const beat = (who: SignedIn, active: boolean) => who.post('/api/v1/activity/heartbeat').send({ active }).expect(200);

beforeAll(async () => {
  t = await createTestApp();
  prisma = createTestPrisma();
  await t.ensureFixtures();
  recorder = t.app.get(ActivityRecorder);
  dispatcher = t.app.get(OutboxDispatcher);
  await settle();
});
afterEach(() => t.clock.reset());
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M4 idle logout from an open tab is recorded as "timed out"', () => {
  it('the browser says it was idle and the session really was: timed out, and the logout does not count as activity', async () => {
    const me = await t.signIn(SALES1);
    t.clock.advance(MINUTE);
    await beat(me, true); // the last mouse or key use, a minute after signing in: the server's "last active" time
    const lastActive = (await sessionOf(me)).lastActiveAt;
    // The browser's 30-minute countdown (counted from its last input) runs out; the server's own limit is still almost a minute away.
    t.clock.advance(29 * MINUTE + 5_000);
    const res = await me.post('/api/v1/auth/logout').send({ reason: 'idle_timeout' }).expect(200);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/aceva_session=;/);

    const row = await sessionOf(me);
    expect(row.revokedReason).toBe('idle_timeout');
    expect(row.lastActiveAt.getTime()).toBe(lastActive.getTime()); // the logout request itself did not keep the session "active"
    const record = await logoutRecord(me);
    expect(record.description).toMatch(/^Timed out after /);
    expect(record.details).toMatchObject({ how: 'timed_out', reason: 'idle_timeout' });
    await me.get('/api/v1/auth/me').expect(401);
  });

  it('on a finance screen the limit is 10 minutes, so the browser says so and the session is recorded as timed out', async () => {
    const me = await t.signIn(SALES2);
    t.clock.advance(10 * MINUTE + 5_000);
    await me.post('/api/v1/auth/logout').send({ reason: 'idle_timeout', financeScreen: true }).expect(200);
    expect((await sessionOf(me)).revokedReason).toBe('idle_timeout');
    expect(howOf(await logoutRecord(me))).toBe('timed_out');
  });

  it('exactly one record per session: the server limit may already be over, and the session then ends as timed out once', async () => {
    const me = await t.signIn(SALES1);
    t.clock.advance(31 * MINUTE); // a sleeping laptop: even the server's own limit has passed
    await me.post('/api/v1/auth/logout').send({ reason: 'idle_timeout' }).expect(401);
    const row = await sessionOf(me);
    expect(row.revokedReason).toBe('idle_timeout');
    await settle();
    expect(await prisma.outboxEvent.count({ where: { type: 'auth.logout', payload: { path: ['sessionId'], equals: row.id } } })).toBe(1);
    expect(await prisma.activityEvent.count({ where: { action: 'logout', sessionId: row.id } })).toBe(1);
    expect(howOf(await logoutRecord(me))).toBe('timed_out');
  });
});

describe('M4 an idle claim that is not true is recorded as a clicked logout', () => {
  it('claimed after only 5 minutes: the session ends, as a clicked logout', async () => {
    const me = await t.signIn(SALES1);
    t.clock.advance(5 * MINUTE);
    await me.post('/api/v1/auth/logout').send({ reason: 'idle_timeout' }).expect(200);
    expect((await sessionOf(me)).revokedReason).toBe('user');
    const record = await logoutRecord(me);
    expect(record.description).toBe('Signed out');
    expect(howOf(record)).toBe('clicked');
  });

  it('claimed as a finance screen after 7 minutes (the limit less the tolerance is 8), or as a normal screen after 20: clicked', async () => {
    const finance = await t.signIn(SALES2);
    t.clock.advance(7 * MINUTE);
    await finance.post('/api/v1/auth/logout').send({ reason: 'idle_timeout', financeScreen: true }).expect(200);
    expect((await sessionOf(finance)).revokedReason).toBe('user');

    const normal = await t.signIn(SALES1);
    t.clock.advance(20 * MINUTE);
    await normal.post('/api/v1/auth/logout').send({ reason: 'idle_timeout' }).expect(200);
    expect((await sessionOf(normal)).revokedReason).toBe('user');
    expect(howOf(await logoutRecord(normal))).toBe('clicked');
  });

  it('the person was active a minute ago (a heartbeat that reports use): clicked, whatever the browser says', async () => {
    const me = await t.signIn(SALES2);
    t.clock.advance(25 * MINUTE);
    await beat(me, true);
    t.clock.advance(MINUTE);
    await me.post('/api/v1/auth/logout').send({ reason: 'idle_timeout' }).expect(200);
    expect((await sessionOf(me)).revokedReason).toBe('user');
    expect(howOf(await logoutRecord(me))).toBe('clicked');
  });

  it('a heartbeat that reports no use does not keep the session alive, so the idle claim after the full time is believed', async () => {
    const me = await t.signIn(SALES1);
    for (let minute = 0; minute < 29; minute++) {
      t.clock.advance(MINUTE);
      await beat(me, false); // the tab is open but nobody uses it
    }
    t.clock.advance(30_000); // 29.5 minutes since the sign-in: the browser's countdown is over, the server's limit is not
    await me.post('/api/v1/auth/logout').send({ reason: 'idle_timeout' }).expect(200);
    expect((await sessionOf(me)).revokedReason).toBe('idle_timeout');
    expect(howOf(await logoutRecord(me))).toBe('timed_out');
  }, 60000);
});

describe('M4 the plain logout is unchanged, and the body is strict', () => {
  it('a logout with an empty body, or no body at all, is a clicked logout', async () => {
    const a = await t.signIn(SALES1);
    await a.post('/api/v1/auth/logout').send({}).expect(200);
    expect((await sessionOf(a)).revokedReason).toBe('user');
    expect(howOf(await logoutRecord(a))).toBe('clicked');

    const b = await t.signIn(SALES2);
    await b.post('/api/v1/auth/logout').expect(200);
    expect((await sessionOf(b)).revokedReason).toBe('user');
  });

  it('another reason, an unknown field or a wrong type is refused and the session stays', async () => {
    const me = await t.signIn(SALES1);
    await me.post('/api/v1/auth/logout').send({ reason: 'forced' }).expect(400);
    await me.post('/api/v1/auth/logout').send({ reason: 'idle_timeout', extra: 1 }).expect(400);
    await me.post('/api/v1/auth/logout').send({ reason: 'idle_timeout', financeScreen: 'yes' }).expect(400);
    await me.get('/api/v1/auth/me').expect(200);
    expect((await sessionOf(me)).revokedAt).toBeNull();
    await me.post('/api/v1/auth/logout').send({}).expect(200);
  });
});
