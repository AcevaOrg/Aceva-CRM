import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboxEventSchema } from '@aceva/contracts';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const HR = 'ACV-0015';
const FINANCE = 'ACV-0010';
const DEV1 = 'ACV-0006';
const CEO = 'ACV-0002';

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

let counter = 0;
const newHire = (overrides: Record<string, unknown> = {}) => {
  counter++;
  return {
    name: `New Hire ${counter}`,
    designation: 'Software Developer',
    departmentId: 'dep-eng',
    officeId: 'off-khi',
    officialEmail: `new.hire${counter}@acevatech.com`,
    level: 5,
    reportsToEmpId: CTO,
    joiningDate: '2026-12-01',
    type: 'full_time',
    ...overrides,
  };
};
const passwordFrom = (mail: string) => mail.match(/Temporary password: (\S+)/)![1];

describe('M3 joining workflow', () => {
  it('Director creates a profile: Emp-ID generated, login created, welcome email with a temporary password sent', async () => {
    const hire = newHire();
    const res = await t.as(DIRECTOR).post('/api/v1/employees').send(hire).expect(201);
    expect(res.body).toMatchObject({ welcomeEmailSent: true, payPending: true });
    expect(res.body.empId).toBe('ACV-0016'); // the next number after the demo roster
    const mail = t.mailer.lastTo(hire.officialEmail)!;
    expect(mail.subject).toBe('Welcome to Aceva');
    expect(mail.text).toContain('ACV-0016');
    expect(mail.text).toContain('/login');
    expect(passwordFrom(mail.text).length).toBeGreaterThanOrEqual(10);
    // the email is the only place the temporary password exists
    const credential = await prisma.credential.findFirstOrThrow({ where: { employee: { empId: 'ACV-0016' } } });
    expect(credential.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(credential.passwordHash).not.toContain(passwordFrom(mail.text));
    expect(credential.mustChangePassword).toBe(true);
    expect(JSON.stringify(await prisma.auditLog.findMany({ where: { action: 'employee.created' } }))).not.toContain(passwordFrom(mail.text));
  });

  it('is integrated with M2: the temporary password works once and must be changed at first login', async () => {
    const hire = newHire();
    const empId = (await t.as(HR).post('/api/v1/employees').send(hire).expect(201)).body.empId;
    const temporary = passwordFrom(t.mailer.lastTo(hire.officialEmail)!.text);

    const login = await t.rawLogin({ empId, password: temporary }).expect(200);
    expect(login.body.status).toBe('password_change_required');
    const headers = { Cookie: (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0], 'X-CSRF-Token': login.body.csrfToken };
    const blocked = await request(t.app.getHttpServer()).get('/api/v1/employees').set(headers).expect(403);
    expect(blocked.body.code).toBe('auth_incomplete');

    const changed = await request(t.app.getHttpServer()).post('/api/v1/auth/password/change').set(headers).send({ newPassword: 'My-Own-Password-2026' }).expect(200);
    expect(changed.body.stage).toBe('ok'); // a Level 5 hire needs no authenticator
    expect((await t.rawLogin({ empId, password: temporary }).expect(200)).body.status).toBe('invalid'); // the temporary password is dead
    expect((await t.rawLogin({ empId, password: 'My-Own-Password-2026' }).expect(200)).body.status).toBe('ok');
  });

  it('puts the new employee in the one central record: directory, profile, history and reporting line', async () => {
    const hire = newHire({ designation: 'SQA Engineer' });
    const empId = (await t.as(DIRECTOR).post('/api/v1/employees').send(hire).expect(201)).body.empId;
    const listed = ((await t.as(FINANCE).get('/api/v1/employees').expect(200)).body as Array<{ empId: string; name: string; officialEmail: string }>).find((e) => e.empId === empId)!;
    expect(listed).toMatchObject({ name: hire.name, officialEmail: hire.officialEmail });
    const profile = (await t.as(DIRECTOR).get(`/api/v1/employees/${empId}`).expect(200)).body;
    expect(profile.job).toMatchObject({ level: 5, reportsTo: CTO, joiningDate: '2026-12-01', type: 'full_time', status: 'active', weeklyCapacityHours: 40 });
    expect(profile.basic).toMatchObject({ designation: 'SQA Engineer', departmentId: 'dep-eng', officeId: 'off-khi' });
    const history = await prisma.employmentHistory.findFirstOrThrow({ where: { employee: { empId }, eventType: 'joined' } });
    expect(history.details).toMatchObject({ designation: 'SQA Engineer', reportsTo: CTO });
    // the reporting tree includes them straight away: the CTO sees them, a peer does not
    expect(((await t.as(CTO).get('/api/v1/org/team').expect(200)).body as Array<{ empId: string }>).map((m) => m.empId)).toContain(empId);
    await t.as(DEV1).get(`/api/v1/org/team/${empId}`).expect(403);
    const closure = await prisma.reportingClosure.findMany({ where: { descendant: { empId } } });
    expect(closure.map((c) => c.depth).sort()).toEqual([0, 1, 2, 3, 4]); // themselves, CTO, Director, CEO, Owner
  });

  it('part-time people and interns get a lower default weekly capacity', async () => {
    const empId = (await t.as(DIRECTOR).post('/api/v1/employees').send(newHire({ type: 'intern' })).expect(201)).body.empId;
    expect((await t.as(DIRECTOR).get(`/api/v1/employees/${empId}`).expect(200)).body.job.weeklyCapacityHours).toBe(20);
  });

  it('only the Director enters pay; HR cannot; personal details can be entered at joining; both are stored encrypted', async () => {
    const withPay = newHire({
      pay: { baseSalary: 150000, allowances: 5000, bankName: 'HBL', accountNumber: 'PK55HABB0000123456789' },
      personal: { cnic: '42201-7654321-3', phone: '+92 300 5551234' },
    });
    const empId = (await t.as(DIRECTOR).post('/api/v1/employees').send(withPay).expect(201)).body;
    expect(empId.payPending).toBe(false);
    const profile = (await t.as(DIRECTOR).get(`/api/v1/employees/${empId.empId}`).expect(200)).body;
    expect(profile.pay).toMatchObject({ baseSalary: '150000.00', allowances: '5000.00', bankName: 'HBL' });
    expect(profile.personal.cnicMasked).toMatch(/^\*+3213$/);
    const raw = await prisma.$queryRaw<Array<{ cnic_encrypted: string; bank_account_encrypted: string }>>`
      SELECT p.cnic_encrypted, y.bank_account_encrypted FROM employee_personal p JOIN employee_pay y USING (employee_id) JOIN employees e ON e.id = p.employee_id WHERE e.emp_id = ${empId.empId}`;
    expect(`${raw[0].cnic_encrypted}${raw[0].bank_account_encrypted}`).not.toMatch(/42201|PK55/);

    await t.as(HR).post('/api/v1/employees').send(newHire({ pay: { baseSalary: 1 } })).expect(403);
    expect(await prisma.employee.count({ where: { fullName: { startsWith: 'New Hire' } } })).toBe(counter - 1); // the refused one was not created
  });

  it('only people who manage others can create profiles', async () => {
    for (const actor of [DEV1, CTO, FINANCE, CEO]) await t.as(actor).post('/api/v1/employees').send(newHire()).expect(403);
  });

  it('validates the profile: levels, departments, managers, email and duplicates', async () => {
    const post = (body: Record<string, unknown>) => t.as(DIRECTOR).post('/api/v1/employees').send(body);
    await post(newHire({ level: 3 })).expect(400); // Level 3 is placed by the Owner or CEO
    await post(newHire({ level: 2 })).expect(400);
    await post(newHire({ departmentId: 'dep-nowhere' })).expect(400);
    await post(newHire({ officeId: 'off-nowhere' })).expect(400);
    await post(newHire({ reportsToEmpId: DEV1 })).expect(400); // a Level 5 employee cannot manage a Level 5 hire
    await post(newHire({ reportsToEmpId: 'ACV-9999' })).expect(404);
    await post(newHire({ officialEmail: 'someone@gmail.com' })).expect(400);
    await post(newHire({ officialEmail: 'ali@acevatech.com' })).expect(409); // already used
    await post({ name: 'x' }).expect(400);
    await post(newHire({ extraField: true })).expect(400);
    await prisma.employee.update({ where: { empId: CTO }, data: { status: 'left' } });
    await post(newHire()).expect(400); // the manager has left
    await prisma.employee.update({ where: { empId: CTO }, data: { status: 'active' } });
  });

  it('gives every Level 4 head a valid default role, and a Sales hire the Sales role', async () => {
    const empId = (await t.as(DIRECTOR).post('/api/v1/employees').send(newHire({ level: 4, departmentId: 'dep-sales', reportsToEmpId: DIRECTOR, designation: 'Sales Executive' })).expect(201)).body.empId;
    const row = await prisma.employee.findUniqueOrThrow({ where: { empId }, include: { role: true, level: true } });
    expect([row.level.number, row.role.key]).toEqual([4, 'sales']);
  });

  it('generates unique, increasing Emp-IDs even when many people are created at the same moment', async () => {
    const results = await Promise.all(Array.from({ length: 6 }, () => t.as(DIRECTOR).post('/api/v1/employees').send(newHire())));
    expect(results.every((r) => r.status === 201)).toBe(true);
    const ids = results.map((r) => r.body.empId as string);
    expect(new Set(ids).size).toBe(6);
    ids.forEach((id) => expect(id).toMatch(/^ACV-\d{4}$/));
    const closureOk = await prisma.$queryRaw<Array<{ missing: bigint }>>`
      SELECT count(*) AS missing FROM employees e WHERE NOT EXISTS (SELECT 1 FROM reporting_closure c WHERE c.ancestor_id = e.id AND c.descendant_id = e.id)`;
    expect(Number(closureOk[0].missing)).toBe(0);
  });

  it('never reuses an Emp-ID after someone leaves', async () => {
    const first = (await t.as(DIRECTOR).post('/api/v1/employees').send(newHire()).expect(201)).body.empId as string;
    await prisma.employee.update({ where: { empId: first }, data: { status: 'left' } });
    const second = (await t.as(DIRECTOR).post('/api/v1/employees').send(newHire()).expect(201)).body.empId as string;
    expect(second > first).toBe(true);
    expect(await prisma.employee.count({ where: { empId: first } })).toBe(1); // the record is still there
  });
});

describe('M3 the welcome email can be sent again', () => {
  it('keeps the new employee even if the mail server is down, and resends with a new temporary password', async () => {
    const hire = newHire();
    t.mailer.failing = true;
    const res = await t.as(DIRECTOR).post('/api/v1/employees').send(hire).expect(201);
    t.mailer.failing = false;
    expect(res.body.welcomeEmailSent).toBe(false);
    expect(t.mailer.lastTo(hire.officialEmail)).toBeUndefined();
    expect(await prisma.auditLog.count({ where: { action: 'employee.welcome_email_failed', targetId: res.body.empId } })).toBe(1);

    await t.as(DIRECTOR).post(`/api/v1/employees/${res.body.empId}/resend-welcome`).send({}).expect(200);
    const temporary = passwordFrom(t.mailer.lastTo(hire.officialEmail)!.text);
    expect((await t.rawLogin({ empId: res.body.empId, password: temporary }).expect(200)).body.status).toBe('password_change_required');
  });

  it('refuses to resend once the person has chosen their own password, and to unauthorized people', async () => {
    const hire = newHire();
    const empId = (await t.as(DIRECTOR).post('/api/v1/employees').send(hire).expect(201)).body.empId;
    const login = await t.rawLogin({ empId, password: passwordFrom(t.mailer.lastTo(hire.officialEmail)!.text) }).expect(200);
    const headers = { Cookie: (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0], 'X-CSRF-Token': login.body.csrfToken };
    await request(t.app.getHttpServer()).post('/api/v1/auth/password/change').set(headers).send({ newPassword: 'Chosen-Password-2026' }).expect(200);
    await t.as(DIRECTOR).post(`/api/v1/employees/${empId}/resend-welcome`).send({}).expect(409);
    await t.as(DEV1).post(`/api/v1/employees/${empId}/resend-welcome`).send({}).expect(403);
    await t.as(HR).post(`/api/v1/employees/${DIRECTOR}/resend-welcome`).send({}).expect(403); // upward
  });

  it('writes no outbox event for joining (nothing downstream needs one yet)', async () => {
    const rows = await prisma.outboxEvent.findMany({ where: { type: { startsWith: 'employee.' } } });
    rows.forEach((r) => expect(outboxEventSchema.safeParse({ id: r.id, type: r.type, version: r.version, occurredAt: r.occurredAt.toISOString(), actor: r.actor, payload: r.payload }).success).toBe(true));
  });
});
