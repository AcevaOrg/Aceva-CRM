import { createHash } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AuthService } from '../src/auth/auth.service';
import { BLOCK_AFTER_FAILURES, LoginThrottleService } from '../src/auth/login-throttle.service';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, TEST_PASSWORD, type TestApp } from './helpers/app';
import { createEmployee } from './helpers/people';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

const DIRECTOR = 'ACV-0003';
let HR = ''; // test-only HR officer (not in the demo seed), see helpers/people.ts
const SALES1 = 'ACV-0009';
const SALES2 = 'ACV-0012';
const SALES3 = 'ACV-0014';
const DEV1 = 'ACV-0006';
const DEV3 = 'ACV-0008';
const CTO = 'ACV-0004';

let t: TestApp;
let prisma: PrismaClient;
let auth: AuthService;

beforeAll(async () => {
  t = await createTestApp();
  prisma = createTestPrisma();
  await t.ensureFixtures();
  HR = t.fixtures.HR;
  auth = t.app.get(AuthService);
});
afterAll(async () => {
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');
const cookieOf = (res: request.Response): string => {
  const header = (res.headers['set-cookie'] as unknown as string[] | undefined)?.find((c) => c.startsWith('aceva_session='));
  if (!header) throw new Error('no session cookie in the response');
  return header.split(';')[0];
};
const login = (empId: string, password: string, ip = t.freshIp()) => t.rawLogin({ empId, password }, { ip });

describe('M2 login with Emp-ID and password', () => {
  it('logs in and sets a cookie that page scripts cannot read (HttpOnly, SameSite, no token in the body)', async () => {
    const res = await login(SALES1, TEST_PASSWORD).expect(200);
    expect(res.body.status).toBe('ok');
    const setCookie = (res.headers['set-cookie'] as unknown as string[])[0];
    expect(setCookie).toMatch(/^aceva_session=/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Path=\//);
    expect(setCookie).not.toMatch(/Max-Age|Expires/i); // a browser-session cookie unless "remember me"
    expect(JSON.stringify(res.body)).not.toContain(cookieOf(res).split('=')[1]); // the secret token never appears in the body
  });

  it('accepts the Emp-ID in lower case and verifies the session on a later request', async () => {
    const res = await login('acv-0009', TEST_PASSWORD).expect(200);
    const me = await request(t.app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookieOf(res)).expect(200);
    expect(me.body).toMatchObject({ empId: SALES1, stage: 'ok', level: 4 });
    expect(me.body.csrfToken).toBe(res.body.csrfToken);
  });

  it('stores only the hash of the session token', async () => {
    const res = await login(SALES2, TEST_PASSWORD).expect(200);
    const token = cookieOf(res).split('=')[1];
    const rows = await prisma.session.findMany({ where: { employee: { empId: SALES2 } } });
    expect(rows.some((r) => r.tokenHash === sha256(token))).toBe(true);
    expect(rows.some((r) => r.tokenHash === token)).toBe(false);
  });

  it('refuses a wrong password and an unknown Emp-ID in exactly the same way', async () => {
    const wrong = await login(SALES1, 'not-the-password!').expect(200);
    const unknown = await login('ACV-9999', 'not-the-password!').expect(200);
    expect(wrong.body).toEqual({ status: 'invalid' });
    expect(unknown.body).toEqual({ status: 'invalid' });
    expect(wrong.headers['set-cookie']).toBeUndefined();
  });

  it('rejects a malformed request with 400', async () => {
    await t.rawLogin({ empId: 'bob', password: 'x' }).expect(400);
    await t.rawLogin({ empId: SALES1 }).expect(400);
    await t.rawLogin({ empId: SALES1, password: 'x'.repeat(200) }).expect(400);
  });

  it('records every attempt (successes and failures) and sends login events for Module 4', async () => {
    const before = await prisma.outboxEvent.count({ where: { type: { in: ['auth.login', 'auth.login_failed'] } } });
    await login(SALES1, 'wrong-password-1');
    await login(SALES1, TEST_PASSWORD);
    expect(await prisma.outboxEvent.count({ where: { type: { in: ['auth.login', 'auth.login_failed'] } } })).toBe(before + 2);
    const failed = await prisma.outboxEvent.findFirstOrThrow({ where: { type: 'auth.login_failed' }, orderBy: { occurredAt: 'desc' } });
    expect(failed.payload).toMatchObject({ empIdAttempted: SALES1, empId: SALES1, reason: 'invalid_credentials' });
    expect(await prisma.loginAttempt.count({ where: { employee: { empId: SALES1 }, success: true } })).toBeGreaterThan(0);
    expect(await prisma.loginAttempt.count({ where: { employee: { empId: SALES1 }, success: false } })).toBeGreaterThan(0);
  });

  it('refuses people who have left, and a disabled login', async () => {
    const person = await createEmployee(prisma, { name: 'Left Person' });
    await auth.provisionCredential(person.id, null, 'Temp-Password-9');
    await auth.disableLogin(person.id, null);
    expect((await login(person.empId, 'Temp-Password-9').expect(200)).body).toEqual({ status: 'invalid' });
    expect(await prisma.outboxEvent.count({ where: { type: 'auth.login_failed', payload: { path: ['reason'], equals: 'disabled' } } })).toBeGreaterThan(0);
  });
});

describe('M2 account lockout after five wrong passwords', () => {
  it('locks on the fifth wrong password, stays locked even for the right password, and records it', async () => {
    for (let i = 1; i <= 4; i++) expect((await login(SALES3, `wrong-guess-${i}`).expect(200)).body.status).toBe('invalid');
    expect((await login(SALES3, 'wrong-guess-5').expect(200)).body.status).toBe('locked');
    expect((await login(SALES3, TEST_PASSWORD).expect(200)).body.status).toBe('locked'); // the correct password does not help
    const credential = await prisma.credential.findFirstOrThrow({ where: { employee: { empId: SALES3 } } });
    expect(credential.lockedAt).not.toBeNull();
    expect(credential.failedAttempts).toBe(5);
    expect(await prisma.auditLog.count({ where: { action: 'auth.account.locked', targetId: SALES3 } })).toBe(1);
    const reasons = (await prisma.loginAttempt.findMany({ where: { employee: { empId: SALES3 }, success: false }, select: { failureReason: true } })).map((a) => a.failureReason);
    expect(reasons.filter((r) => r === 'invalid_credentials')).toHaveLength(4);
    expect(reasons.filter((r) => r === 'locked').length).toBeGreaterThanOrEqual(2);
  });

  it('a correct login resets the counter, so spread-out mistakes never lock', async () => {
    for (let i = 0; i < 3; i++) await login(SALES2, `wrong-${i}-xxxx`);
    await login(SALES2, TEST_PASSWORD).expect(200);
    for (let i = 0; i < 3; i++) await login(SALES2, `wrong-again-${i}`);
    expect((await login(SALES2, TEST_PASSWORD).expect(200)).body.status).toBe('ok');
    expect((await prisma.credential.findFirstOrThrow({ where: { employee: { empId: SALES2 } } })).failedAttempts).toBe(0);
  });

  it('counts simultaneous wrong guesses correctly (no way to slip past the limit)', async () => {
    const person = await createEmployee(prisma, { name: 'Race Person' });
    await auth.provisionCredential(person.id, null, 'Race-Password-1');
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) => login(person.empId, `wrong-race-${i}`).then((r) => r.body.status)));
    expect(results.filter((s) => s === 'locked').length).toBeGreaterThanOrEqual(1);
    const credential = await prisma.credential.findFirstOrThrow({ where: { employeeId: person.id } });
    expect(credential.lockedAt).not.toBeNull();
    expect(credential.failedAttempts).toBeGreaterThanOrEqual(5);
  });

  it('can be unlocked by someone above them in the reporting line, or by HR, and by nobody else', async () => {
    // SALES3 (locked above) reports to the Director.
    const dev1 = await t.signIn(DEV1);
    await dev1.post(`/api/v1/auth/employees/${SALES3}/unlock`).send({}).expect(403); // an employee: no permission
    const cto = await t.signIn(CTO);
    const before = await prisma.auditLog.count({ where: { action: 'access.denied', actor: { empId: CTO }, reason: 'out_of_scope' } });
    await cto.post(`/api/v1/auth/employees/${SALES3}/unlock`).send({}).expect(403); // has the permission, but not above SALES3
    expect(await prisma.auditLog.count({ where: { action: 'access.denied', actor: { empId: CTO }, reason: 'out_of_scope' } })).toBe(before + 1);

    const director = await t.signIn(DIRECTOR);
    await director.post(`/api/v1/auth/employees/${SALES3}/unlock`).send({ reason: 'Verified by phone' }).expect(200);
    expect((await login(SALES3, TEST_PASSWORD).expect(200)).body.status).toBe('ok');
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: 'auth.account.unlocked', targetId: SALES3 }, include: { actor: true } });
    expect(entry.actor?.empId).toBe(DIRECTOR);
    expect(entry.reason).toBe('Verified by phone');
    await director.post(`/api/v1/auth/employees/${SALES3}/unlock`).send({}).expect(409); // not locked any more

    // HR (duty) can unlock people outside their own line.
    for (let i = 0; i < 5; i++) await login(DEV3, `wrong-hr-${i}`);
    expect((await login(DEV3, TEST_PASSWORD).expect(200)).body.status).toBe('locked');
    const hr = await t.signIn(HR);
    await hr.post(`/api/v1/auth/employees/${DEV3}/unlock`).send({}).expect(200);
    expect((await login(DEV3, TEST_PASSWORD).expect(200)).body.status).toBe('ok');
    expect((await prisma.auditLog.findFirstOrThrow({ where: { action: 'auth.account.unlocked', targetId: DEV3 } })).details).toMatchObject({ byHrDuty: true });
  });
});

describe('M2 rate limiting by internet address', () => {
  it('slows down repeated failures from one address, then blocks it for a while, then lets it back in', async () => {
    const throttle = t.app.get(LoginThrottleService);
    const ip = t.freshIp();
    const fail = () => throttle.record({ empIdAttempted: 'ACV-0009', employeeId: null, ip, userAgent: null, success: false, failureReason: 'invalid_credentials' });

    expect((await throttle.check(ip)).delayMs).toBe(0);
    for (let i = 0; i < 5; i++) await fail();
    expect(await throttle.check(ip)).toMatchObject({ blocked: false, delayMs: 500 }); // slowed
    const started = Date.now();
    await t.rawLogin({ empId: SALES1, password: 'wrong-slow-down' }, { ip }).expect(200);
    expect(Date.now() - started).toBeGreaterThanOrEqual(450); // the answer really is delayed

    for (let i = 5; i < BLOCK_AFTER_FAILURES; i++) await fail();
    const decision = await throttle.check(ip);
    expect(decision.blocked).toBe(true);
    expect(decision.retryAfterSec).toBeGreaterThan(0);
    // even the correct password is turned away from a blocked address...
    const blocked = await t.rawLogin({ empId: SALES1, password: TEST_PASSWORD }, { ip }).expect(200);
    expect(blocked.body.status).toBe('rate_limited');
    expect(blocked.body.retryAfterSec).toBeGreaterThan(0);
    expect(blocked.headers['set-cookie']).toBeUndefined();
    // ...but another address is unaffected
    expect((await login(SALES1, TEST_PASSWORD).expect(200)).body.status).toBe('ok');
    // and the block ends by itself
    t.clock.advance(16 * 60_000);
    expect((await throttle.check(ip)).blocked).toBe(false);
    t.clock.reset();
  });
});

describe('M2 passwords: first login, policy, reuse', () => {
  let personId: string;
  let personEmpId: string;
  let temporary: string;
  let cookie: string;
  const csrf = { token: '' };

  const change = (body: Record<string, unknown>, withCookie = cookie) =>
    request(t.app.getHttpServer()).post('/api/v1/auth/password/change').set('Cookie', withCookie).set('X-CSRF-Token', csrf.token).send(body);

  beforeAll(async () => {
    const person = await createEmployee(prisma, { name: 'First Login Person', officialEmail: null });
    personId = person.id;
    personEmpId = person.empId;
    temporary = await auth.provisionCredential(person.id, null); // a random temporary password, returned once
  });

  it('a temporary password must be changed at first login: nothing else works until then', async () => {
    const res = await login(personEmpId, temporary).expect(200);
    expect(res.body.status).toBe('password_change_required');
    cookie = cookieOf(res);
    csrf.token = res.body.csrfToken;
    const blocked = await request(t.app.getHttpServer()).get('/api/v1/org/team').set('Cookie', cookie).expect(403);
    expect(blocked.body).toMatchObject({ code: 'auth_incomplete', stage: 'password_change_required' });
    await request(t.app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookie).expect(200); // but finishing the login is allowed
  });

  it('requires at least 10 characters', async () => {
    const res = await change({ newPassword: 'short-9ch' }).expect(400);
    expect(res.body.code === 'weak_password' || res.body.issues).toBeTruthy();
    await change({ newPassword: 'ninechars' }).expect(400);
  });

  it('changes the password: stored as an Argon2id hash only, history kept, every old session ended, new session issued', async () => {
    const other = await login(personEmpId, temporary).expect(200); // a second device
    const res = await change({ newPassword: 'First-Real-Pass1' }).expect(200);
    expect(res.body).toMatchObject({ ok: true, stage: 'ok' });
    const newCookie = cookieOf(res);
    expect(newCookie).not.toBe(cookie);

    await request(t.app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookie).expect(401); // the old session on this device
    await request(t.app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookieOf(other)).expect(401); // the session on the other device
    await request(t.app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', newCookie).expect(200);

    const credential = await prisma.credential.findUniqueOrThrow({ where: { employeeId: personId } });
    expect(credential.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(credential.mustChangePassword).toBe(false);
    expect(credential.passwordHash).not.toContain('First-Real-Pass1');
    expect(await prisma.passwordHistory.count({ where: { employeeId: personId } })).toBe(2); // the temporary one and the new one
    expect(await prisma.session.count({ where: { employeeId: personId, revokedReason: 'password_changed' } })).toBeGreaterThanOrEqual(2);

    expect((await login(personEmpId, temporary).expect(200)).body.status).toBe('invalid'); // the temporary password is dead
    expect((await login(personEmpId, 'First-Real-Pass1').expect(200)).body.status).toBe('ok');
    cookie = newCookie;
    csrf.token = res.body.csrfToken;
  });

  it('a normal change must prove the current password', async () => {
    await change({ newPassword: 'Another-Pass-22' }).expect(400);
    await change({ currentPassword: 'wrong-current', newPassword: 'Another-Pass-22' }).expect(400);
  });

  it('refuses to reuse any of the last three passwords, but allows an older one', async () => {
    const steps = ['Second-Pass-0002', 'Third-Pass-00003', 'Fourth-Pass-0004'];
    let current = 'First-Real-Pass1';
    for (const next of steps) {
      const res = await change({ currentPassword: current, newPassword: next }).expect(200);
      cookie = cookieOf(res);
      csrf.token = res.body.csrfToken;
      current = next;
    }
    // history now: temporary, First, Second, Third, Fourth. The last three: Second, Third, Fourth.
    for (const reused of ['Fourth-Pass-0004', 'Third-Pass-00003', 'Second-Pass-0002']) {
      const res = await change({ currentPassword: current, newPassword: reused }).expect(400);
      expect(res.body.code).toBe('password_reused');
    }
    await change({ currentPassword: current, newPassword: 'First-Real-Pass1' }).expect(200); // four changes ago: allowed
  });
});

describe('M2 temporary passwords set by the Director or HR (people without an official email)', () => {
  let noEmail: { id: string; empId: string };

  beforeAll(async () => {
    noEmail = await createEmployee(prisma, { name: 'No Email Person', officialEmail: null });
    await auth.provisionCredential(noEmail.id, null, 'Original-Pass-1');
  });

  it('the Director sets one, it is shown once, and it must be changed at the next login', async () => {
    const director = await t.signIn(DIRECTOR);
    const res = await director.post(`/api/v1/auth/employees/${noEmail.empId}/temporary-password`).send({ reason: 'Forgot password, no email' }).expect(200);
    const temporary: string = res.body.temporaryPassword;
    expect(temporary.length).toBeGreaterThanOrEqual(10);
    const stored = await prisma.credential.findUniqueOrThrow({ where: { employeeId: noEmail.id } });
    expect(stored.passwordHash).not.toContain(temporary);
    expect(stored.mustChangePassword).toBe(true);
    expect(JSON.stringify(await prisma.auditLog.findMany({ where: { action: 'auth.password.temporary_set' } }))).not.toContain(temporary);
    expect((await login(noEmail.empId, 'Original-Pass-1').expect(200)).body.status).toBe('invalid');
    expect((await login(noEmail.empId, temporary).expect(200)).body.status).toBe('password_change_required');
  });

  it('only for people without an official email (they use the reset link), and only with the permission', async () => {
    const director = await t.signIn(DIRECTOR);
    expect((await director.post(`/api/v1/auth/employees/${DEV1}/temporary-password`).send({}).expect(409)).body.code).toBe('has_official_email');
    const dev = await t.signIn(DEV1);
    await dev.post(`/api/v1/auth/employees/${noEmail.empId}/temporary-password`).send({}).expect(403);
  });

  it('HR can for people of a lower rank, but nobody sets a temporary password for a superior or themselves', async () => {
    const hr = await t.signIn(HR);
    await hr.post(`/api/v1/auth/employees/${noEmail.empId}/temporary-password`).send({}).expect(200);
    await hr.post(`/api/v1/auth/employees/${CTO}/temporary-password`).send({}).expect(403); // a Level 3 superior
    await hr.post(`/api/v1/auth/employees/${HR}/temporary-password`).send({}).expect(403); // themselves
  });
});

describe('M2 password reset by email', () => {
  const EMAIL = 'reset.person@acevatech.com';
  let person: { id: string; empId: string };
  const forgot = (empId: string, ip = t.freshIp()) => request(t.app.getHttpServer()).post('/api/v1/auth/password/forgot').set('X-Forwarded-For', ip).send({ empId });
  const reset = (token: string, newPassword: string) => request(t.app.getHttpServer()).post('/api/v1/auth/password/reset').send({ token, newPassword });
  const tokenFromMail = (): string => {
    const mail = t.mailer.lastTo(EMAIL);
    const token = mail?.text.match(/reset-password\?token=([\w%.-]+)/)?.[1];
    if (!token) throw new Error('no reset link in the email');
    return decodeURIComponent(token);
  };

  beforeAll(async () => {
    person = await createEmployee(prisma, { name: 'Reset Person', officialEmail: EMAIL });
    await auth.provisionCredential(person.id, null, 'Current-Pass-001');
    await prisma.credential.update({ where: { employeeId: person.id }, data: { mustChangePassword: false } });
  });

  it('answers the same way whether or not the Emp-ID exists, and sends nothing for unknown people', async () => {
    t.mailer.clear();
    expect((await forgot('ACV-9999').expect(200)).body).toEqual({ sent: true });
    expect((await forgot(person.empId).expect(200)).body).toEqual({ sent: true });
    expect(t.mailer.sent).toHaveLength(1);
  });

  it('sends a one-time link to the official acevatech.com address; only the token hash is stored; valid 15 minutes', async () => {
    const mail = t.mailer.lastTo(EMAIL)!;
    expect(mail.subject).toMatch(/reset/i);
    expect(mail.text).toContain('15 minutes');
    const token = tokenFromMail();
    expect(token.length).toBeGreaterThanOrEqual(43);
    const row = await prisma.passwordResetToken.findFirstOrThrow({ where: { employeeId: person.id, usedAt: null } });
    expect(row.tokenHash).toBe(sha256(token));
    expect(row.tokenHash).not.toBe(token);
    expect(row.expiresAt.getTime() - row.createdAt.getTime()).toBe(15 * 60_000);
  });

  it('does not send a link to people without an official acevatech.com email', async () => {
    const outsider = await createEmployee(prisma, { name: 'Outside Email', officialEmail: 'someone@gmail.com' });
    await auth.provisionCredential(outsider.id, null, 'Outsider-Pass-1');
    const none = await createEmployee(prisma, { name: 'No Mail', officialEmail: null });
    await auth.provisionCredential(none.id, null, 'NoMail-Pass-001');
    const before = t.mailer.sent.length;
    await forgot(outsider.empId).expect(200);
    await forgot(none.empId).expect(200);
    expect(t.mailer.sent).toHaveLength(before);
  });

  it('rejects a weak new password without using up the link', async () => {
    const token = tokenFromMail();
    expect((await reset(token, 'short').expect(400)).body.issues ?? true).toBeTruthy();
    expect(await prisma.passwordResetToken.count({ where: { employeeId: person.id, usedAt: null } })).toBe(1);
  });

  it('refuses to reuse a recent password', async () => {
    const res = await reset(tokenFromMail(), 'Current-Pass-001').expect(400);
    expect(res.body.code).toBe('password_reused');
  });

  it('works once: sets the password, ends every session, and cannot be used again', async () => {
    const session = await login(person.empId, 'Current-Pass-001').expect(200);
    const token = tokenFromMail();
    await reset(token, 'Brand-New-Pass-77').expect(200);
    await request(t.app.getHttpServer()).get('/api/v1/auth/me').set('Cookie', cookieOf(session)).expect(401); // logged out everywhere
    expect((await login(person.empId, 'Current-Pass-001').expect(200)).body.status).toBe('invalid');
    expect((await login(person.empId, 'Brand-New-Pass-77').expect(200)).body.status).toBe('ok');
    expect((await reset(token, 'Yet-Another-Pass-1').expect(400)).body.code).toBe('invalid_or_expired_link');
  });

  it('expires after 15 minutes', async () => {
    t.mailer.clear();
    await forgot(person.empId).expect(200);
    const token = tokenFromMail();
    t.clock.advance(14 * 60_000);
    // (still valid at 14 minutes, but we test the expiry, so go past 15)
    t.clock.advance(2 * 60_000);
    expect((await reset(token, 'Late-Pass-Word-1').expect(400)).body.code).toBe('invalid_or_expired_link');
    t.clock.reset();
  });

  it('a newer request cancels the older link, and two simultaneous uses of one link give exactly one success', async () => {
    const fresh = await createEmployee(prisma, { name: 'Newer Link', officialEmail: 'newer.link@acevatech.com' });
    await auth.provisionCredential(fresh.id, null, 'Newer-Link-Pass-1');
    const mailToken = () => decodeURIComponent(t.mailer.lastTo('newer.link@acevatech.com')!.text.match(/reset-password\?token=([\w%.-]+)/)![1]);
    t.mailer.clear();
    await forgot(fresh.empId).expect(200);
    const first = mailToken();
    await forgot(fresh.empId).expect(200);
    const second = mailToken();
    expect(second).not.toBe(first);
    expect((await reset(first, 'Old-Link-Pass-001').expect(400)).body.code).toBe('invalid_or_expired_link');
    const results = await Promise.all([reset(second, 'Race-Pass-Word-01'), reset(second, 'Race-Pass-Word-02')]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it('limits how many links can be requested per hour', async () => {
    const limited = await createEmployee(prisma, { name: 'Limited Person', officialEmail: 'limited.person@acevatech.com' });
    await auth.provisionCredential(limited.id, null, 'Limited-Pass-01');
    t.mailer.clear();
    for (let i = 0; i < 5; i++) await forgot(limited.empId).expect(200);
    expect(t.mailer.sent.filter((m) => m.to === 'limited.person@acevatech.com')).toHaveLength(3);
  });
});
