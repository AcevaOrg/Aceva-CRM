import { generateSync } from 'otplib';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, TEST_PASSWORD, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

const OWNER = 'ACV-0001';
const CEO = 'ACV-0002';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const FINANCE = 'ACV-0010';
const SALES1 = 'ACV-0009';
const HR = 'ACV-0015';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';

let t: TestApp;
let prisma: PrismaClient;

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  prisma = createTestPrisma();
});
afterAll(async () => {
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

const reset = (actor: string, target: string, reason: string | null = 'Lost phone, identity confirmed') =>
  t.as(actor).post(`/api/v1/auth/employees/${target}/reset-2fa`).send(reason === null ? {} : { reason });

describe('M2 lost authenticator phone: who may reset two-step login', () => {
  it('nobody resets their own, someone of the same level, or someone above them', async () => {
    await reset(CEO, CEO).expect(403); // self
    await reset(DIRECTOR, DIRECTOR).expect(403); // self
    await reset(CEO, OWNER).expect(403); // upward
    await reset(DIRECTOR, CEO).expect(403); // upward
    await reset(DIRECTOR, CTO).expect(403); // same level, even though the CTO is below the Director in the chain
    await reset(CTO, DIRECTOR).expect(403); // same level the other way
    await reset(HR, SALES1).expect(403); // HR is level 4, so is Sales
    await reset(HR, DIRECTOR).expect(403); // upward
    expect(await prisma.auditLog.count({ where: { action: 'auth.2fa.reset' } })).toBe(0);
  });

  it('employees and managers without the permission cannot reset anyone', async () => {
    await reset(DEV1, DEV2).expect(403);
    await reset(CTO, DEV2).expect(403); // the CTO has no reset permission
    await reset(SALES1, DEV2).expect(403);
  });

  it('a reason is required', async () => {
    await reset(OWNER, DIRECTOR, null).expect(400);
    await reset(OWNER, DIRECTOR, 'no').expect(400);
  });

  it('the Owner and the CEO can reset anyone of lower rank, anywhere', async () => {
    expect((await reset(OWNER, CEO).expect(200)).body.ended).toBeGreaterThanOrEqual(1);
    const ceo = await t.signIn(CEO); // sign back in with a fresh authenticator (the helper handles the set-up)
    await ceo.post(`/api/v1/auth/employees/${DEV1}/reset-2fa`).send({ reason: 'Lost phone, identity confirmed' }).expect(200);
    await ceo.post(`/api/v1/auth/employees/${CTO}/reset-2fa`).send({ reason: 'Lost phone, identity confirmed' }).expect(200);
  });

  it('the Director resets people below them, and HR duty resets people of lower rank', async () => {
    await reset(DIRECTOR, FINANCE).expect(200);
    await reset(HR, DEV2).expect(200);
    await reset(HR, DEV1).expect(200);
  });

  it('people who have left cannot be reset', async () => {
    await prisma.employee.update({ where: { empId: DEV1 }, data: { status: 'left' } });
    await reset(OWNER, DEV1).expect(400);
    await prisma.employee.update({ where: { empId: DEV1 }, data: { status: 'active' } });
  });
});

describe('M2 what a reset does', () => {
  it('destroys the old secret, ends every session, and demands a fresh enrollment at the next login', async () => {
    // A mandatory-2FA person: the Director resets Sana (Finance duty).
    const device1 = await t.signIn(FINANCE);
    const device2 = await t.signIn(FINANCE);
    const oldSecretRow = await prisma.totpSecret.findFirstOrThrow({ where: { employee: { empId: FINANCE } } });
    expect(oldSecretRow.confirmedAt).not.toBeNull();

    const res = await reset(DIRECTOR, FINANCE, 'Phone dropped in a river').expect(200);
    expect(res.body.ended).toBeGreaterThanOrEqual(2);
    await device1.get('/api/v1/auth/me').expect(401);
    await device2.get('/api/v1/auth/me').expect(401);
    expect(await prisma.totpSecret.count({ where: { employee: { empId: FINANCE } } })).toBe(0); // the old secret is gone
    expect((await prisma.credential.findFirstOrThrow({ where: { employee: { empId: FINANCE } } })).mustEnrollTwoFactor).toBe(true);

    // Next login: a fresh enrollment, with a NEW secret; the old secret's codes are useless.
    const login = await t.rawLogin({ empId: FINANCE, password: TEST_PASSWORD }).expect(200);
    expect(login.body.status).toBe('2fa_setup_required');
    const headers = { Cookie: (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0], 'X-CSRF-Token': login.body.csrfToken };
    const fresh = await (await import('supertest')).default(t.app.getHttpServer()).post('/api/v1/auth/2fa/setup').set(headers).send({}).expect(200);
    const request = (await import('supertest')).default;
    const oldCode = generateSync({ secret: t.app.get((await import('../src/auth/crypto.service')).CryptoService).decrypt(oldSecretRow.secretEncrypted), epoch: t.clock.now().getTime() / 1000 });
    await request(t.app.getHttpServer()).post('/api/v1/auth/2fa/verify').set(headers).send({ code: oldCode }).expect(400);
    const newCode = generateSync({ secret: fresh.body.secret, epoch: t.clock.now().getTime() / 1000 });
    await request(t.app.getHttpServer()).post('/api/v1/auth/2fa/verify').set(headers).send({ code: newCode }).expect(200);
    expect(fresh.body.secret).not.toBe(oldCode);
    expect((await prisma.credential.findFirstOrThrow({ where: { employee: { empId: FINANCE } } })).mustEnrollTwoFactor).toBe(false); // done
  });

  it('even someone for whom 2FA is optional must enroll again after a reset', async () => {
    // Hira (Sales, 2FA optional) turns it on, then the Director resets it.
    const me = await t.signIn(SALES1);
    const setup = (await me.post('/api/v1/auth/2fa/setup').send({}).expect(200)).body;
    await me.post('/api/v1/auth/2fa/verify').send({ code: generateSync({ secret: setup.secret, epoch: t.clock.now().getTime() / 1000 }) }).expect(200);
    expect((await t.rawLogin({ empId: SALES1, password: TEST_PASSWORD }).expect(200)).body.status).toBe('2fa_required');

    await reset(DIRECTOR, SALES1, 'Phone replaced and old one wiped').expect(200);
    expect((await t.rawLogin({ empId: SALES1, password: TEST_PASSWORD }).expect(200)).body.status).toBe('2fa_setup_required');
  });

  it('records every reset in the audit log: who, whom, why, and under which rule', async () => {
    const entries = await prisma.auditLog.findMany({ where: { action: 'auth.2fa.reset' }, include: { actor: true }, orderBy: { occurredAt: 'asc' } });
    expect(entries.length).toBeGreaterThanOrEqual(8);
    const phone = entries.find((e) => e.targetId === FINANCE && e.reason === 'Phone dropped in a river')!;
    expect(phone.actor?.empId).toBe(DIRECTOR);
    expect(phone.reason).toBe('Phone dropped in a river');
    expect(phone.details).toMatchObject({ rule: 'director' });
    expect(entries.find((e) => e.targetId === CEO)?.details).toMatchObject({ rule: 'owner_or_ceo' });
    expect(entries.find((e) => e.actor?.empId === HR)?.details).toMatchObject({ rule: 'hr_duty' });
    // refused attempts are logged too
    expect(await prisma.auditLog.count({ where: { action: 'access.denied', details: { path: ['attempted'], equals: 'auth.reset_two_factor' } } })).toBeGreaterThan(0);
  });
});
