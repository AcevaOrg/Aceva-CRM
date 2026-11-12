import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { TEST_PASSWORD } from './helpers/reset-db';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/** "Confirm again" (plan section 6): checked on the server, and required for bank details, salary and pay edits. */
const DIRECTOR = 'ACV-0003';
let HR = ''; // test-only HR officer (not in the demo seed), see helpers/people.ts
const DEV1 = 'ACV-0006';

let t: TestApp;
let prisma: PrismaClient;

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  HR = t.fixtures.HR;
  prisma = createTestPrisma();
  await t.stepUp(HR); // HR enters personal details; Director enters pay
  await t.as(HR).patch(`/api/v1/employees/${DEV1}/personal`).send({ cnic: '42101-1234567-1' }).expect(200);
  await t.stepUp(DIRECTOR);
  await t.as(DIRECTOR).patch(`/api/v1/employees/${DEV1}/pay`).send({ baseSalary: 250000, allowances: 5000, bankName: 'HBL', accountNumber: 'PK11HABB0000000000001234', reason: 'Starting pay' }).expect(200);
  t.clock.advance(6 * 60_000); // the confirmation above has expired
});
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

const reveal = (who: string, field: string) => t.as(who).post(`/api/v1/employees/${DEV1}/reveal`).send({ field });

describe('M3 risky actions need a recent "confirm again", checked by the server', () => {
  it('refuses salary, bank details and pay edits without it (even for the right person), with a clear reason', async () => {
    const salary = await reveal(DIRECTOR, 'salary').expect(403);
    expect(salary.body.code).toBe('step_up_required');
    expect((await reveal(DIRECTOR, 'account').expect(403)).body.code).toBe('step_up_required');
    expect((await t.as(DEV1).post(`/api/v1/employees/${DEV1}/reveal`).send({ field: 'account' }).expect(403)).body.code).toBe('step_up_required'); // their own
    const edit = await t.as(DIRECTOR).patch(`/api/v1/employees/${DEV1}/pay`).send({ baseSalary: 1, reason: 'no confirmation yet' }).expect(403);
    expect(edit.body.code).toBe('step_up_required');
    expect(await prisma.auditLog.count({ where: { action: 'access.denied', reason: 'step_up_required' } })).toBeGreaterThanOrEqual(4);
  });

  it('does not ask for it for the CNIC (the plan lists bank details, not the CNIC)', async () => {
    expect((await reveal(DIRECTOR, 'cnic').expect(200)).body.value).toBe('42101-1234567-1');
  });

  it('rejects a wrong password and a wrong code, and does not count them as confirmation', async () => {
    const director = t.as(DIRECTOR);
    const before = await prisma.auditLog.count({ where: { action: 'auth.step_up.failed' } });
    expect((await director.post('/api/v1/auth/step-up').send({ password: 'not-the-password', code: t.codeFor(DIRECTOR) }).expect(400)).body.code).toBe('invalid_credentials');
    expect((await director.post('/api/v1/auth/step-up').send({ password: TEST_PASSWORD, code: '000000' }).expect(400)).body.code).toBe('invalid_credentials');
    expect((await director.post('/api/v1/auth/step-up').send({ password: TEST_PASSWORD }).expect(400)).body.code).toBe('code_required'); // the Director uses an authenticator
    await director.post('/api/v1/auth/step-up').send({ password: TEST_PASSWORD, code: 'abcdef' }).expect(400);
    await director.post('/api/v1/auth/step-up').send({}).expect(400);
    expect(await prisma.auditLog.count({ where: { action: 'auth.step_up.failed' } })).toBe(before + 2);
    await reveal(DIRECTOR, 'salary').expect(403); // still not confirmed
  });

  it('accepts the right password and a fresh code, then allows the risky actions, and audits it', async () => {
    await t.stepUp(DIRECTOR);
    expect((await reveal(DIRECTOR, 'salary').expect(200)).body).toEqual({ value: '250000.00', allowances: '5000.00' });
    expect((await reveal(DIRECTOR, 'account').expect(200)).body.value).toBe('PK11HABB0000000000001234');
    await t.as(DIRECTOR).patch(`/api/v1/employees/${DEV1}/pay`).send({ baseSalary: 260000, reason: 'Review' }).expect(200);
    expect(await prisma.auditLog.count({ where: { action: 'auth.step_up', actor: { empId: DIRECTOR } } })).toBeGreaterThanOrEqual(1);
  });

  it('a code works once: reusing the code just used for confirming is refused', async () => {
    const code = t.codeFor(DIRECTOR);
    t.clock.advance(30_000);
    const fresh = t.codeFor(DIRECTOR);
    await t.as(DIRECTOR).post('/api/v1/auth/step-up').send({ password: TEST_PASSWORD, code: fresh }).expect(200);
    await t.as(DIRECTOR).post('/api/v1/auth/step-up').send({ password: TEST_PASSWORD, code: fresh }).expect(400); // replay
    void code;
    t.clock.advance(60_000); // move past the step used above so the next confirmation gets a fresh code
  });

  it('expires after 5 minutes', async () => {
    await t.stepUp(DIRECTOR);
    await reveal(DIRECTOR, 'salary').expect(200);
    t.clock.advance(4 * 60_000);
    await reveal(DIRECTOR, 'salary').expect(200);
    t.clock.advance(2 * 60_000);
    expect((await reveal(DIRECTOR, 'salary').expect(403)).body.code).toBe('step_up_required');
  });

  it('belongs to one session only: a second session of the same person is not confirmed', async () => {
    await t.stepUp(DIRECTOR);
    const other = await t.signIn(DIRECTOR);
    await other.post(`/api/v1/employees/${DEV1}/reveal`).send({ field: 'salary' }).expect(403);
    await reveal(DIRECTOR, 'salary').expect(200);
  });

  it('works with a password only for people who do not use an authenticator (their code is not asked for)', async () => {
    const dev = t.as(DEV1);
    await dev.post('/api/v1/auth/step-up').send({ password: 'wrong-password-here' }).expect(400);
    await dev.post('/api/v1/auth/step-up').send({ password: TEST_PASSWORD }).expect(200);
    expect((await dev.post(`/api/v1/employees/${DEV1}/reveal`).send({ field: 'account' }).expect(200)).body.value).toBe('PK11HABB0000000000001234');
  });

  it('requires a login, and five wrong answers end the session', async () => {
    await t.anonymous().post('/api/v1/auth/step-up').send({ password: TEST_PASSWORD }).expect(401);
    const session = await t.signIn(HR);
    for (let i = 0; i < 4; i++) await session.post('/api/v1/auth/step-up').send({ password: 'wrong-wrong-wrong', code: '000000' }).expect(400);
    const last = await session.post('/api/v1/auth/step-up').send({ password: 'wrong-wrong-wrong', code: '000000' });
    expect(last.status).toBe(403);
    await session.get('/api/v1/auth/me').expect(401); // the session is over
  });
});
