import { createHash } from 'node:crypto';
import { Controller, Get } from '@nestjs/common';
import { outboxEventSchema } from '@aceva/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { Authenticated, FinanceScreen } from '../src/access/decorators';
import { CryptoService } from '../src/auth/crypto.service';
import { SessionService } from '../src/auth/session/session.service';
import { clearCookieOptions, sessionCookieOptions } from '../src/auth/session/session-cookie';
import { loadEnv } from '../src/config/env';
import type { PrismaClient } from '../src/generated/prisma/client';
import { RedisService } from '../src/redis/redis.service';
import { createTestApp, TEST_PASSWORD, type TestApp } from './helpers/app';
import { baseEnv } from './helpers/base-env';
import { createEmployee } from './helpers/people';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/** A finance screen: 10 minutes of inactivity ends the session here (30 minutes elsewhere). */
@Controller('test-finance')
class FinanceScreenController {
  @Get()
  @Authenticated()
  @FinanceScreen()
  screen() {
    return { ok: true };
  }
}

const OWNER = 'ACV-0001';
let CEO = ''; // test-only CEO (not in the demo seed), see helpers/people.ts
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const FINANCE = 'ACV-0010';
const SALES1 = 'ACV-0009';
const SALES2 = 'ACV-0012';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const DEV3 = 'ACV-0008';
const DEV4 = 'ACV-0011';
const DEV5 = 'ACV-0013';

const WINDOWS_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const ANDROID_CHROME = 'Mozilla/5.0 (Linux; Android 16; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Mobile Safari/537.36';
const IPHONE_SAFARI = 'Mozilla/5.0 (iPhone; CPU iPhone OS 19_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.0 Mobile/15E148 Safari/604.1';

let t: TestApp;
let prisma: PrismaClient;
let redis: RedisService;
let sessions: SessionService;

beforeAll(async () => {
  t = await createTestApp({ extraControllers: [FinanceScreenController] });
  prisma = createTestPrisma();
  await t.ensureFixtures();
  CEO = t.fixtures.CEO;
  redis = t.app.get(RedisService);
  sessions = t.app.get(SessionService);
});
afterEach(() => t.clock.reset());
afterAll(async () => {
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const tokenOf = (cookie: string) => cookie.split('=')[1];
const redisKey = (cookie: string) => redis.key(`sess:${sha256(tokenOf(cookie))}`);
const withCookie = () => request(t.app.getHttpServer());
const get = (url: string, cookie: string) => withCookie().get(url).set('Cookie', cookie);
const ended = (cookie: string) => prisma.session.findUniqueOrThrow({ where: { tokenHash: sha256(tokenOf(cookie)) } });

describe('M2 sessions are stored in Redis and PostgreSQL', () => {
  it('a login creates the session in both stores, with a 12-hour limit', async () => {
    const me = await t.signIn(SALES1);
    const cached = JSON.parse((await redis.client.get(redisKey(me.cookie)))!);
    expect(cached).toMatchObject({ empId: SALES1, twoFactorVerified: false });
    const ttl = await redis.client.ttl(redisKey(me.cookie));
    expect(ttl).toBeGreaterThan(12 * 3600 - 60);
    expect(ttl).toBeLessThanOrEqual(12 * 3600);
    const row = await ended(me.cookie);
    expect(row.revokedAt).toBeNull();
    expect(row.absoluteExpiresAt.getTime() - row.createdAt.getTime()).toBe(12 * 3_600_000);
  });

  it('every login gets a brand-new token (no session fixation)', async () => {
    const a = await t.signIn(SALES1);
    const b = await t.signIn(SALES1);
    expect(a.cookie).not.toBe(b.cookie);
  });

  it('logout ends it in both stores at once and the old cookie stops working', async () => {
    const me = await t.signIn(SALES1);
    const res = await me.post('/api/v1/auth/logout').send({}).expect(200);
    expect((res.headers['set-cookie'] as unknown as string[])[0]).toMatch(/aceva_session=;/); // cookie cleared
    expect(await redis.client.get(redisKey(me.cookie))).toBeNull();
    expect(await ended(me.cookie)).toMatchObject({ revokedReason: 'user' });
    await get('/api/v1/auth/me', me.cookie).expect(401);
  });

  it('if Redis loses the session, PostgreSQL (the permanent record) rebuilds it', async () => {
    const me = await t.signIn(SALES1);
    await redis.client.del(redisKey(me.cookie));
    await get('/api/v1/auth/me', me.cookie).expect(200);
    expect(await redis.client.get(redisKey(me.cookie))).not.toBeNull(); // restored
  });

  it('a session ended in PostgreSQL stays ended even if a stale Redis copy exists', async () => {
    const me = await t.signIn(SALES1);
    await sessions.end((await ended(me.cookie)).id, 'forced');
    expect(await redis.client.get(redisKey(me.cookie))).toBeNull();
    await get('/api/v1/auth/me', me.cookie).expect(401);
  });
});

describe('M2 session limits: 30 minutes idle, 10 on finance screens, 12 hours in any case', () => {
  const minutes = (n: number) => n * 60_000;

  it('ends a normal session after 30 minutes without activity, but any activity keeps it alive', async () => {
    const me = await t.signIn(SALES1);
    t.clock.advance(minutes(29));
    await get('/api/v1/auth/me', me.cookie).expect(200); // activity at 29 minutes
    t.clock.advance(minutes(29));
    await get('/api/v1/auth/me', me.cookie).expect(200); // 29 minutes since the last activity
    t.clock.advance(minutes(31));
    await get('/api/v1/auth/me', me.cookie).expect(401); // 31 minutes idle
    const row = await ended(me.cookie);
    expect(row.revokedReason).toBe('idle_timeout');
    expect(await redis.client.get(redisKey(me.cookie))).toBeNull();
  });

  it('ends the session after 10 minutes of inactivity on a finance screen, but not on other screens', async () => {
    const a = await t.signIn(SALES1);
    const b = await t.signIn(SALES2);
    await get('/api/v1/test-finance', a.cookie).expect(200);
    t.clock.advance(minutes(11));
    await get('/api/v1/test-finance', a.cookie).expect(401); // 11 minutes idle, finance screen
    expect((await ended(a.cookie)).revokedReason).toBe('idle_timeout');
    await get('/api/v1/auth/me', b.cookie).expect(200); // the same 11 minutes is fine on a normal screen
    t.clock.advance(minutes(9));
    await get('/api/v1/test-finance', b.cookie).expect(200); // 9 minutes since the last activity
  });

  it('ends every session after 12 hours even when the person is active the whole time', async () => {
    const me = await t.signIn(SALES1);
    for (let step = 1; step <= 35; step++) {
      t.clock.advance(minutes(20));
      await get('/api/v1/auth/me', me.cookie).expect(200);
    }
    t.clock.advance(minutes(20 + 20)); // now past 12 hours
    await get('/api/v1/auth/me', me.cookie).expect(401);
    expect((await ended(me.cookie)).revokedReason).toBe('max_duration');
  }, 60000);

  it('the minute-by-minute sweeper ends sessions nobody is using, and tells Module 4', async () => {
    const me = await t.signIn(SALES2);
    const row = await ended(me.cookie);
    t.clock.advance(minutes(31));
    expect(await sessions.sweepExpired()).toBeGreaterThanOrEqual(1);
    expect(await ended(me.cookie)).toMatchObject({ revokedReason: 'idle_timeout' });
    expect(await redis.client.get(redisKey(me.cookie))).toBeNull();
    const event = await prisma.outboxEvent.findFirst({ where: { type: 'auth.logout', payload: { path: ['sessionId'], equals: row.id } } });
    expect(event?.payload).toMatchObject({ reason: 'idle_timeout', empId: SALES2 });
  });

  it('never offers "remember me" to Finance users; others get a cookie that outlives the browser but not 12 hours', async () => {
    const finance = await t.rawLogin({ empId: FINANCE, password: TEST_PASSWORD, rememberMe: true }).expect(200);
    expect((finance.headers['set-cookie'] as unknown as string[])[0]).not.toMatch(/Max-Age|Expires/i);
    expect((await prisma.session.findFirstOrThrow({ where: { employee: { empId: FINANCE } }, orderBy: { createdAt: 'desc' } })).rememberMe).toBe(false);

    const sales = await t.rawLogin({ empId: SALES1, password: TEST_PASSWORD, rememberMe: true }).expect(200);
    const maxAge = Number((sales.headers['set-cookie'] as unknown as string[])[0].match(/Max-Age=(\d+)/)![1]);
    expect(maxAge).toBeGreaterThan(12 * 3600 - 120);
    expect(maxAge).toBeLessThanOrEqual(12 * 3600);

    const me = await t.signIn(SALES1);
    expect((await get('/api/v1/auth/me', me.cookie)).body.rememberAllowed).toBe(true);
  });

  it('the cookie is Secure in production and always HttpOnly and SameSite', () => {
    const prod = loadEnv({ ...baseEnvVars(), NODE_ENV: 'production' });
    expect(sessionCookieOptions(prod, false, Date.now() + 1000, Date.now())).toMatchObject({ httpOnly: true, sameSite: 'lax', secure: true });
    expect(clearCookieOptions(prod)).toMatchObject({ httpOnly: true, secure: true });
    expect(sessionCookieOptions(baseEnv(), false, Date.now() + 1000, Date.now()).secure).toBe(false);
    expect(() => loadEnv({ ...baseEnvVars(), NODE_ENV: 'production', COOKIE_SECURE: 'false' })).toThrow(/Secure/);
  });
});

function baseEnvVars(): Record<string, string> {
  return {
    DATABASE_URL: 'postgresql://u:p@localhost:5432/aceva_unit',
    REDIS_URL: 'redis://127.0.0.1:6379',
    DATA_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  };
}

describe('M2 immediate session termination', () => {
  it('forced logout ends every device at once', async () => {
    const devices = [
      await t.signIn(DEV1, { userAgent: WINDOWS_CHROME }),
      await t.signIn(DEV1, { userAgent: ANDROID_CHROME }),
      await t.signIn(DEV1, { userAgent: IPHONE_SAFARI }),
    ];
    for (const d of devices) await get('/api/v1/auth/me', d.cookie).expect(200);

    const peer = await t.signIn(DEV2);
    await peer.post(`/api/v1/auth/employees/${DEV1}/force-logout`).send({}).expect(403); // no permission
    const otherBranch = await t.signIn(CTO);
    await otherBranch.post(`/api/v1/auth/employees/${SALES2}/force-logout`).send({}).expect(403); // not below the CTO

    const res = await otherBranch.post(`/api/v1/auth/employees/${DEV1}/force-logout`).send({ reason: 'Lost laptop' }).expect(200);
    expect(res.body.ended).toBeGreaterThanOrEqual(3);
    for (const d of devices) {
      await get('/api/v1/auth/me', d.cookie).expect(401);
      expect(await redis.client.get(redisKey(d.cookie))).toBeNull();
      expect((await ended(d.cookie)).revokedReason).toBe('forced');
    }
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'auth.session.forced_logout', targetId: DEV1 }, include: { actor: true } });
    expect(audit.actor?.empId).toBe(CTO);
    expect(audit.reason).toBe('Lost laptop');
  });

  it('an employee whose last working day was processed is logged out everywhere and cannot log in', async () => {
    const person = await createEmployee(prisma, { name: 'Leaving Soon' });
    const auth = t.app.get((await import('../src/auth/auth.service')).AuthService);
    await auth.provisionCredential(person.id, null, 'Leaving-Pass-001');
    await prisma.credential.update({ where: { employeeId: person.id }, data: { mustChangePassword: false } });
    const s1 = await t.signIn(person.empId, { password: 'Leaving-Pass-001' });
    await auth.disableLogin(person.id, null);
    await get('/api/v1/auth/me', s1.cookie).expect(401);
    expect((await ended(s1.cookie)).revokedReason).toBe('employee_left');
    expect((await t.rawLogin({ empId: person.empId, password: 'Leaving-Pass-001' }).expect(200)).body.status).toBe('invalid');
  });

  it('a person who is marked as left cannot keep using an open session', async () => {
    const person = await createEmployee(prisma, { name: 'Marked Left' });
    const auth = t.app.get((await import('../src/auth/auth.service')).AuthService);
    await auth.provisionCredential(person.id, null, 'Marked-Left-Pass1');
    await prisma.credential.update({ where: { employeeId: person.id }, data: { mustChangePassword: false } });
    const s = await t.signIn(person.empId, { password: 'Marked-Left-Pass1' });
    await prisma.employee.update({ where: { id: person.id }, data: { status: 'left' } });
    await get('/api/v1/auth/me', s.cookie).expect(401);
  });
});

describe('M2 My devices', () => {
  it('shows where I am logged in and lets me log out my other devices, but nobody else\'s', async () => {
    const windows = await t.signIn(DEV4, { userAgent: WINDOWS_CHROME });
    const phone = await t.signIn(DEV4, { userAgent: ANDROID_CHROME });
    const iphone = await t.signIn(DEV4, { userAgent: IPHONE_SAFARI });
    const stranger = await t.signIn(DEV5);

    const list = (await windows.get('/api/v1/auth/sessions').expect(200)).body as Array<Record<string, unknown>>;
    expect(list).toHaveLength(3);
    expect(list.filter((s) => s.current)).toHaveLength(1);
    expect(list.find((s) => s.current)).toMatchObject({ device: 'Windows computer', browser: 'Chrome 142', os: 'Windows' });
    expect(list.map((s) => s.device).sort()).toEqual(['Android phone', 'Windows computer', 'iPhone']);
    expect(list.every((s) => typeof s.ip === 'string' && typeof s.startedAt === 'string' && typeof s.lastActiveAt === 'string')).toBe(true);
    expect(JSON.stringify(list)).not.toContain('tokenHash');

    // someone else's session looks exactly like one that does not exist, and the attempt is logged
    const theirs = ((await stranger.get('/api/v1/auth/sessions').expect(200)).body as Array<{ id: string }>)[0].id;
    await windows.delete(`/api/v1/auth/sessions/${theirs}`).expect(404);
    await get('/api/v1/auth/me', stranger.cookie).expect(200); // untouched
    expect(await prisma.auditLog.count({ where: { action: 'access.denied', reason: 'not_own_session', actor: { empId: DEV4 } } })).toBe(1);

    // log out one other device
    const phoneId = (list.find((s) => s.device === 'Android phone') as { id: string }).id;
    await windows.delete(`/api/v1/auth/sessions/${phoneId}`).expect(200);
    await get('/api/v1/auth/me', phone.cookie).expect(401);
    await get('/api/v1/auth/me', iphone.cookie).expect(200);
    // you cannot end the session you are using this way
    const currentId = (list.find((s) => s.current) as { id: string }).id;
    await windows.delete(`/api/v1/auth/sessions/${currentId}`).expect(400);

    // log out all my other devices
    expect((await windows.delete('/api/v1/auth/sessions').expect(200)).body.ended).toBe(1);
    await get('/api/v1/auth/me', iphone.cookie).expect(401);
    await get('/api/v1/auth/me', windows.cookie).expect(200);
    expect(((await windows.get('/api/v1/auth/sessions').expect(200)).body as unknown[]).length).toBe(1);
  });

  it('shows my recent logins and failed attempts with how each ended', async () => {
    await t.rawLogin({ empId: DEV5, password: 'wrong-for-history' });
    const me = await t.signIn(DEV5);
    const other = await t.signIn(DEV5);
    await other.post('/api/v1/auth/logout').send({}).expect(200);
    const history = (await me.get('/api/v1/auth/login-history').expect(200)).body as Array<{ success: boolean; endReason?: string; twoFactor: boolean }>;
    expect(history.some((h) => !h.success)).toBe(true);
    expect(history.find((h) => h.endReason)?.endReason).toBe('clicked');
  });
});

describe('M2 two-step login (TOTP)', () => {
  it('is mandatory for levels 1 to 3: nothing works until the authenticator is set up, then the code is checked on the server', async () => {
    const login = await t.rawLogin({ empId: OWNER, password: TEST_PASSWORD }).expect(200);
    expect(login.body.status).toBe('2fa_setup_required');
    const cookie = (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0];
    const headers = { Cookie: cookie, 'X-CSRF-Token': login.body.csrfToken };
    const api = (method: 'get' | 'post') => (url: string) => request(t.app.getHttpServer())[method](url).set(headers);

    const blocked = await api('get')('/api/v1/org/tree').expect(403);
    expect(blocked.body).toMatchObject({ code: 'auth_incomplete', stage: '2fa_setup_required' });

    const setup = (await api('post')('/api/v1/auth/2fa/setup').send({}).expect(200)).body;
    expect(setup.secret).toMatch(/^[A-Z2-7]{16,}$/);
    expect(setup.otpauthUrl).toMatch(/^otpauth:\/\/totp\/Aceva:ACV-0001\?secret=/);

    // stored encrypted: the database never contains the secret
    const stored = await prisma.totpSecret.findFirstOrThrow({ where: { employee: { empId: OWNER } } });
    expect(stored.secretEncrypted).not.toContain(setup.secret);
    expect(stored.secretEncrypted.startsWith('v1:')).toBe(true);
    expect(t.app.get(CryptoService).decrypt(stored.secretEncrypted)).toBe(setup.secret);
    expect(stored.confirmedAt).toBeNull();

    // wrong code: refused. Correct code: accepted (verified on the server) and the set-up is confirmed.
    await api('post')('/api/v1/auth/2fa/verify').send({ code: '000000' }).expect(400);
    await api('post')('/api/v1/auth/2fa/verify').send({ code: '12345' }).expect(400); // not 6 digits
    const { generateSync } = await import('otplib');
    const code = generateSync({ secret: setup.secret, epoch: t.clock.now().getTime() / 1000 });
    expect((await api('post')('/api/v1/auth/2fa/verify').send({ code }).expect(200)).body.stage).toBe('ok');
    await api('get')('/api/v1/org/tree').expect(200);
    expect((await prisma.totpSecret.findFirstOrThrow({ where: { employee: { empId: OWNER } } })).confirmedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'auth.2fa.enabled', targetId: OWNER } })).toBe(1);
    await api('post')('/api/v1/auth/2fa/setup').send({}).expect(409); // cannot start over while it is on

    // next login asks for the code; the same code cannot be used twice
    const second = await t.rawLogin({ empId: OWNER, password: TEST_PASSWORD }).expect(200);
    expect(second.body.status).toBe('2fa_required');
    const h2 = { Cookie: (second.headers['set-cookie'] as unknown as string[])[0].split(';')[0], 'X-CSRF-Token': second.body.csrfToken };
    const replay = await request(t.app.getHttpServer()).post('/api/v1/auth/2fa/verify').set(h2).send({ code });
    expect(replay.status).toBe(400); // the code from the previous step is refused (replay protection)
    t.clock.advance(30_000);
    const fresh = generateSync({ secret: setup.secret, epoch: t.clock.now().getTime() / 1000 });
    await request(t.app.getHttpServer()).post('/api/v1/auth/2fa/verify').set(h2).send({ code: fresh }).expect(200);
  });

  it('five wrong codes end the session and are recorded', async () => {
    const login = await t.rawLogin({ empId: CEO, password: TEST_PASSWORD }).expect(200);
    const headers = { Cookie: (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0], 'X-CSRF-Token': login.body.csrfToken };
    await request(t.app.getHttpServer()).post('/api/v1/auth/2fa/setup').set(headers).send({}).expect(200);
    for (let i = 0; i < 4; i++) await request(t.app.getHttpServer()).post('/api/v1/auth/2fa/verify').set(headers).send({ code: '000000' }).expect(400);
    const last = await request(t.app.getHttpServer()).post('/api/v1/auth/2fa/verify').set(headers).send({ code: '000000' }).expect(403);
    expect(last.body.code).toBe('too_many_wrong_codes');
    await request(t.app.getHttpServer()).get('/api/v1/auth/me').set(headers).expect(401);
    expect(await prisma.outboxEvent.count({ where: { type: 'auth.login_failed', payload: { path: ['reason'], equals: 'two_factor_failed' } } })).toBeGreaterThanOrEqual(5);
  });

  it('is mandatory for anyone with Finance duty', async () => {
    expect((await t.rawLogin({ empId: FINANCE, password: TEST_PASSWORD }).expect(200)).body.status).toBe('2fa_setup_required');
  });

  it('is optional for other employees: on only if they choose it, and they can switch it off with the password and a code', async () => {
    expect((await t.rawLogin({ empId: DEV2, password: TEST_PASSWORD }).expect(200)).body.status).toBe('ok');
    const me = await t.signIn(DEV2);
    expect((await me.get('/api/v1/auth/2fa').expect(200)).body).toEqual({ required: false, enabled: false });

    const setup = (await me.post('/api/v1/auth/2fa/setup').send({}).expect(200)).body;
    const { generateSync } = await import('otplib');
    const code = () => generateSync({ secret: setup.secret, epoch: t.clock.now().getTime() / 1000 });
    await me.post('/api/v1/auth/2fa/verify').send({ code: code() }).expect(200);
    expect((await me.get('/api/v1/auth/2fa').expect(200)).body).toMatchObject({ required: false, enabled: true });
    expect((await t.rawLogin({ empId: DEV2, password: TEST_PASSWORD }).expect(200)).body.status).toBe('2fa_required');

    t.clock.advance(30_000);
    await me.post('/api/v1/auth/2fa/disable').send({ password: 'wrong-password-1', code: code() }).expect(400);
    await me.post('/api/v1/auth/2fa/disable').send({ password: TEST_PASSWORD, code: code() }).expect(200);
    expect((await t.rawLogin({ empId: DEV2, password: TEST_PASSWORD }).expect(200)).body.status).toBe('ok');
    expect(await prisma.totpSecret.count({ where: { employee: { empId: DEV2 } } })).toBe(0);
  });

  it('cannot be switched off where it is mandatory', async () => {
    const director = await t.signIn(DIRECTOR);
    await director.post('/api/v1/auth/2fa/disable').send({ password: TEST_PASSWORD, code: t.codeFor(DIRECTOR) }).expect(403);
  });

  it('a duty given while someone is logged in makes 2FA mandatory straight away', async () => {
    const dev = await t.signIn(DEV3);
    await dev.get('/api/v1/org/team').expect(200);
    const director = await t.signIn(DIRECTOR);
    await director.post(`/api/v1/org/employees/${DEV3}/duties`).send({ dutyKey: 'finance', reason: 'Covering finance for a week' }).expect(201);
    const blocked = await dev.get('/api/v1/org/team').expect(403);
    expect(blocked.body).toMatchObject({ code: 'auth_incomplete', stage: '2fa_setup_required' });
    expect((await dev.get('/api/v1/auth/me').expect(200)).body).toMatchObject({ stage: '2fa_setup_required', twoFactorRequired: true });
  });
});

describe('M2 protection against forged requests (CSRF) and other websites', () => {
  it('a request that changes data must carry this session\'s CSRF token', async () => {
    const me = await t.signIn(SALES1);
    const url = '/api/v1/auth/sessions';
    await request(t.app.getHttpServer()).delete(url).set('Cookie', me.cookie).expect(403); // no token
    const wrong = await request(t.app.getHttpServer()).delete(url).set({ Cookie: me.cookie, 'X-CSRF-Token': 'not-the-token' }).expect(403);
    expect(wrong.body.code).toBe('csrf_invalid');
    await request(t.app.getHttpServer()).delete(url).set(me.headers()).expect(200); // right token
    await request(t.app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', me.cookie).expect(200); // reading needs no token
    expect(await prisma.auditLog.count({ where: { action: 'access.denied', reason: 'csrf_invalid', actor: { empId: SALES1 } } })).toBe(2);
  });

  it('another person\'s CSRF token does not work for me', async () => {
    const a = await t.signIn(SALES1);
    const b = await t.signIn(SALES2);
    await request(t.app.getHttpServer()).delete('/api/v1/auth/sessions').set({ Cookie: a.cookie, 'X-CSRF-Token': b.csrfToken }).expect(403);
  });

  it('the token is stable (page reloads, other tabs) and only its hash is stored', async () => {
    const me = await t.signIn(SALES1);
    const first = (await get('/api/v1/auth/me', me.cookie)).body.csrfToken;
    const second = (await get('/api/v1/auth/me', me.cookie)).body.csrfToken;
    expect(first).toBe(second);
    expect(first).toBe(me.csrfToken);
    const row = await ended(me.cookie);
    expect(row.csrfTokenHash).toBe(sha256(first));
    expect(row.csrfTokenHash).not.toContain(first);
  });

  it('refuses a change request that comes from a different website, even with a valid token', async () => {
    const me = await t.signIn(SALES1);
    const evil = await request(t.app.getHttpServer()).delete('/api/v1/auth/sessions').set(me.headers()).set('Origin', 'https://evil.example').expect(403);
    expect(evil.body.code).toBe('origin_not_allowed');
    await request(t.app.getHttpServer()).delete('/api/v1/auth/sessions').set(me.headers()).set('Origin', 'http://localhost:3000').expect(200);
    // login itself also refuses foreign sites
    await t.rawLogin({ empId: SALES1, password: TEST_PASSWORD }).set('Origin', 'https://evil.example').expect(403);
  });
});

describe('M2 identity: the session cookie is the only way in', () => {
  it('an invalid cookie is "not logged in" and never falls back to the development header', async () => {
    await request(t.app.getHttpServer()).get('/api/v1/org/tree').set('Cookie', 'aceva_session=forged-token-value').set('X-Dev-Emp-Id', OWNER).expect(401);
  });

  it('public routes work without login and everything else needs it', async () => {
    const anon = t.anonymous();
    await anon.get('/api/v1/health').expect(200);
    await anon.post('/api/v1/auth/password/forgot').send({ empId: 'ACV-9999' }).expect(200);
    for (const url of ['/api/v1/auth/me', '/api/v1/auth/sessions', '/api/v1/org/tree', '/api/v1/access/me']) await anon.get(url).expect(401);
  });
});

describe('M2 events for Module 4 (activity tracking)', () => {
  it('every login, failed login and logout produced a valid, versioned event', async () => {
    const rows = await prisma.outboxEvent.findMany({ where: { type: { in: ['auth.login', 'auth.login_failed', 'auth.logout'] } } });
    expect(rows.length).toBeGreaterThan(20);
    for (const row of rows) {
      const parsed = outboxEventSchema.safeParse({ id: row.id, type: row.type, version: row.version, occurredAt: row.occurredAt.toISOString(), actor: row.actor, payload: row.payload });
      expect(parsed.success, `${row.type} ${JSON.stringify(row.payload)}`).toBe(true);
      expect(row.version).toBe(1);
    }
    const types = new Set(rows.map((r) => r.type));
    expect(types).toEqual(new Set(['auth.login', 'auth.login_failed', 'auth.logout']));
  });

  it('logout events cover every way a session can end, and never contain secrets', async () => {
    const logouts = await prisma.outboxEvent.findMany({ where: { type: 'auth.logout' } });
    const reasons = new Set(logouts.map((l) => (l.payload as { reason: string }).reason));
    for (const reason of ['user', 'idle_timeout', 'max_duration', 'forced', 'employee_left']) expect(reasons.has(reason)).toBe(true);
    const everything = JSON.stringify(await prisma.outboxEvent.findMany());
    expect(everything).not.toContain(TEST_PASSWORD);
    expect(everything).not.toMatch(/aceva_session|csrf|secret/i);
  });
});
