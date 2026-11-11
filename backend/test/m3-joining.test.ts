import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

const OWNER = 'ACV-0001';
const CEO = 'ACV-0002';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const HR = 'ACV-0015';
const FINANCE = 'ACV-0010';
const DEV1 = 'ACV-0006';

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
    joiningDate: '2026-11-01',
    type: 'full_time',
    ...overrides,
  };
};
const passwordFrom = (mail: string) => mail.match(/Temporary password: (\S+)/)![1];
const employeeCount = () => prisma.employee.count();

/** Director or HR start the hire; the CEO authorizes it. Returns the new Emp-ID. */
async function hire(body: ReturnType<typeof newHire>, starter = DIRECTOR, approvalBody: Record<string, unknown> = {}) {
  const started = await t.as(starter).post('/api/v1/employees').send(body).expect(201);
  expect(started.body.status).toBe('pending_approval');
  const approved = await t.as(CEO).post(`/api/v1/hire-requests/${started.body.requestId}/approve`).send(approvalBody).expect(200);
  return { empId: approved.body.empId as string, requestId: started.body.requestId as string };
}

describe('M3 joining: Director or HR start the hire, the Owner or CEO authorize it', () => {
  it('starting a hire creates only a request: no employee, no Emp-ID, no login, no email', async () => {
    const before = await employeeCount();
    const body = newHire();
    const res = await t.as(DIRECTOR).post('/api/v1/employees').send(body).expect(201);
    expect(res.body).toMatchObject({ status: 'pending_approval', payPending: true });
    expect(res.body.empId).toBeUndefined();
    expect(await employeeCount()).toBe(before);
    expect(t.mailer.lastTo(body.officialEmail)).toBeUndefined();
    expect(await prisma.credential.count({ where: { employee: { officialEmail: body.officialEmail } } })).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'hire.requested', targetId: res.body.requestId } })).toBe(1);
  });

  it('only the Owner or CEO approve or reject; Director, HR and others cannot, even for their own request', async () => {
    const started = (await t.as(HR).post('/api/v1/employees').send(newHire()).expect(201)).body;
    for (const who of [DIRECTOR, HR, CTO, DEV1, FINANCE]) {
      await t.as(who).post(`/api/v1/hire-requests/${started.requestId}/approve`).send({}).expect(403);
      await t.as(who).post(`/api/v1/hire-requests/${started.requestId}/reject`).send({ reason: 'not allowed to decide' }).expect(403);
    }
    expect((await prisma.hireRequest.findUniqueOrThrow({ where: { id: started.requestId } })).status).toBe('pending');
    await t.anonymous().post(`/api/v1/hire-requests/${started.requestId}/approve`).send({}).expect(401);
  });

  it('approval generates the Emp-ID, creates the login and emails a temporary password', async () => {
    const body = newHire();
    const { empId } = await hire(body);
    expect(empId).toBe('ACV-0016');
    const mail = t.mailer.lastTo(body.officialEmail)!;
    expect(mail.subject).toBe('Welcome to Aceva');
    expect(mail.text).toContain(empId);
    expect(mail.text).toContain('/login');
    const credential = await prisma.credential.findFirstOrThrow({ where: { employee: { empId } } });
    expect(credential.passwordHash.startsWith('$argon2id$')).toBe(true);
    expect(credential.passwordHash).not.toContain(passwordFrom(mail.text));
    expect(credential.mustChangePassword).toBe(true);
    expect(JSON.stringify(await prisma.auditLog.findMany({ where: { action: 'hire.approved' } }))).not.toContain(passwordFrom(mail.text));
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'hire.approved', targetId: empId }, include: { actor: true } });
    expect(audit.actor?.empId).toBe(CEO); // the authorizer is on record
  });

  it('is integrated with M2: the temporary password works once and must be changed at first login', async () => {
    const body = newHire();
    const { empId } = await hire(body, HR);
    const temporary = passwordFrom(t.mailer.lastTo(body.officialEmail)!.text);
    const login = await t.rawLogin({ empId, password: temporary }).expect(200);
    expect(login.body.status).toBe('password_change_required');
    const headers = { Cookie: (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0], 'X-CSRF-Token': login.body.csrfToken };
    expect((await request(t.app.getHttpServer()).get('/api/v1/employees').set(headers).expect(403)).body.code).toBe('auth_incomplete');
    expect((await request(t.app.getHttpServer()).post('/api/v1/auth/password/change').set(headers).send({ newPassword: 'My-Own-Password-2026' }).expect(200)).body.stage).toBe('ok');
    expect((await t.rawLogin({ empId, password: temporary }).expect(200)).body.status).toBe('invalid');
    expect((await t.rawLogin({ empId, password: 'My-Own-Password-2026' }).expect(200)).body.status).toBe('ok');
  });

  it('the authorizer may correct the reporting line; the correction is on record; the rules still apply', async () => {
    const started = (await t.as(DIRECTOR).post('/api/v1/employees').send(newHire({ level: 5, reportsToEmpId: CTO })).expect(201)).body;
    await t.as(CEO).post(`/api/v1/hire-requests/${started.requestId}/approve`).send({ reportsToEmpId: DEV1 }).expect(400); // a Level 5 cannot manage a Level 5
    const ok = await t.as(CEO).post(`/api/v1/hire-requests/${started.requestId}/approve`).send({ reportsToEmpId: FINANCE }).expect(200);
    const row = await prisma.employee.findUniqueOrThrow({ where: { empId: ok.body.empId }, include: { reportsTo: true, level: true } });
    expect([row.level.number, row.reportsTo!.empId]).toEqual([5, FINANCE]);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'hire.approved', targetId: ok.body.empId } });
    expect(audit.details).toMatchObject({ requestedBy: expect.any(String), correctedByAuthorizer: true });
  });

  it('a request is decided once: approving twice or after a rejection is refused; a rejection creates nothing', async () => {
    const first = await hire(newHire());
    await t.as(CEO).post(`/api/v1/hire-requests/${first.requestId}/approve`).send({}).expect(409);
    await t.as(CEO).post(`/api/v1/hire-requests/${first.requestId}/reject`).send({ reason: 'too late to reject' }).expect(409);

    const before = await employeeCount();
    const started = (await t.as(DIRECTOR).post('/api/v1/employees').send(newHire()).expect(201)).body;
    await t.as(OWNER).post(`/api/v1/hire-requests/${started.requestId}/reject`).send({ reason: 'No budget this quarter' }).expect(200);
    await t.as(CEO).post(`/api/v1/hire-requests/${started.requestId}/approve`).send({}).expect(409);
    expect(await employeeCount()).toBe(before);
    expect(await prisma.auditLog.count({ where: { action: 'hire.rejected', targetId: started.requestId } })).toBe(1);
    await t.as(OWNER).post(`/api/v1/hire-requests/${started.requestId}/reject`).send({ reason: 'x' }).expect(400);
    await t.as(OWNER).post('/api/v1/hire-requests/not-a-uuid/approve').send({}).expect(400);
  });

  it('two simultaneous approvals of one request create one employee', async () => {
    const started = (await t.as(DIRECTOR).post('/api/v1/employees').send(newHire()).expect(201)).body;
    const before = await employeeCount();
    const results = await Promise.all([t.as(CEO).post(`/api/v1/hire-requests/${started.requestId}/approve`).send({}), t.as(OWNER).post(`/api/v1/hire-requests/${started.requestId}/approve`).send({})]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await employeeCount()).toBe(before + 1);
  });

  it('lists requests for Owner, CEO, Director and HR only, without personal or pay details', async () => {
    const withSecrets = newHire({ personal: { cnic: '42201-7654321-3', phone: '+92 300 5551234' }, pay: { baseSalary: 150000, bankName: 'HBL', accountNumber: 'PK55HABB0000123456789' } });
    await t.as(DIRECTOR).post('/api/v1/employees').send(withSecrets).expect(201);
    for (const who of [OWNER, CEO, DIRECTOR, HR]) {
      const list = (await t.as(who).get('/api/v1/hire-requests?status=pending').expect(200)).body as Array<{ officialEmail: string }>;
      expect(list.some((r) => r.officialEmail === withSecrets.officialEmail)).toBe(true);
      expect(JSON.stringify(list)).not.toMatch(/42201|150000|PK55|sensitive/i);
    }
    await t.as(DEV1).get('/api/v1/hire-requests').expect(403);
    const row = await prisma.hireRequest.findFirstOrThrow({ where: { officialEmail: withSecrets.officialEmail } });
    expect(row.sensitiveEncrypted).toMatch(/^v1:/);
    expect(row.sensitiveEncrypted).not.toMatch(/42201|150000|PK55/);
  });
});

describe('M3 joining: who may hire at which level', () => {
  it('Director and HR can only start Level 4 or 5 hires; Level 3 and above are refused', async () => {
    for (const who of [DIRECTOR, HR]) {
      await t.as(who).post('/api/v1/employees').send(newHire({ level: 3, reportsToEmpId: DIRECTOR })).expect(400);
      await t.as(who).post('/api/v1/employees').send(newHire({ level: 2 })).expect(400);
    }
    expect(((await t.as(HR).post('/api/v1/employees').send(newHire({ level: 4, departmentId: 'dep-sales', reportsToEmpId: DIRECTOR })).expect(201)).body as { status: string }).status).toBe('pending_approval');
  });

  it('Owner and CEO can hire directly (no request), including Level 3', async () => {
    const body = newHire({ level: 3, departmentId: 'dep-eng', reportsToEmpId: CEO, designation: 'Head of QA' });
    const res = await t.as(CEO).post('/api/v1/employees').send(body).expect(201);
    expect(res.body).toMatchObject({ status: 'created', welcomeEmailSent: true });
    const row = await prisma.employee.findUniqueOrThrow({ where: { empId: res.body.empId }, include: { level: true, role: true } });
    expect([row.level.number, row.role.key]).toEqual([3, 'level3_default']);
  });

  it('nobody else can start a hire (employees, CTO, Finance)', async () => {
    for (const who of [DEV1, CTO, FINANCE]) await t.as(who).post('/api/v1/employees').send(newHire()).expect(403);
  });

  it('validates the request when it is started: departments, managers, rules, email, duplicates', async () => {
    const post = (body: Record<string, unknown>, who = DIRECTOR) => t.as(who).post('/api/v1/employees').send(body);
    await post(newHire({ departmentId: 'dep-nowhere' })).expect(400);
    await post(newHire({ officeId: 'off-nowhere' })).expect(400);
    await post(newHire({ reportsToEmpId: DEV1 })).expect(400); // a Level 5 employee cannot manage a Level 5 hire
    await post(newHire({ reportsToEmpId: 'ACV-9999' })).expect(404);
    await post(newHire({ officialEmail: 'someone@gmail.com' })).expect(400);
    await post({ name: 'x' }).expect(400);
    await post(newHire({ extraField: true })).expect(400);
    const pending = newHire();
    await post(pending).expect(201);
    await post({ ...pending, name: 'Same Email' }).expect(409); // already waiting for approval
    await prisma.employee.update({ where: { empId: CTO }, data: { status: 'left' } });
    await post(newHire()).expect(400); // the manager has left
    await prisma.employee.update({ where: { empId: CTO }, data: { status: 'active' } });
    const existing = (await prisma.employee.findFirstOrThrow({ where: { empId: DEV1 } })).officialEmail!;
    await post(newHire({ officialEmail: existing }), CEO).expect(409); // already used by a person (checked on creation)
  });

  it('only the Director enters pay; HR cannot; personal details and pay reach the employee only after approval, encrypted', async () => {
    const withPay = newHire({ pay: { baseSalary: 150000, allowances: 5000, bankName: 'HBL', accountNumber: 'PK55HABB0000123456789' }, personal: { cnic: '42201-7654321-3', phone: '+92 300 5551234' } });
    await t.as(HR).post('/api/v1/employees').send(newHire({ pay: { baseSalary: 1 } })).expect(403);
    const { empId } = await hire(withPay, DIRECTOR);
    const profile = (await t.as(DIRECTOR).get(`/api/v1/employees/${empId}`).expect(200)).body;
    expect(profile.pay).toMatchObject({ salaryOnFile: true, bankName: 'HBL' });
    expect(JSON.stringify(profile)).not.toMatch(/150000|5000\.00/); // the salary is only shown by the logged reveal
    await t.stepUp(DIRECTOR);
    expect((await t.as(DIRECTOR).post(`/api/v1/employees/${empId}/reveal`).send({ field: 'salary' }).expect(200)).body).toEqual({ value: '150000.00', allowances: '5000.00' });
    expect(profile.personal.cnicMasked).toMatch(/^\*+3213$/);
    const raw = await prisma.$queryRaw<Array<{ cnic_encrypted: string; bank_account_encrypted: string }>>`
      SELECT p.cnic_encrypted, y.bank_account_encrypted FROM employee_personal p JOIN employee_pay y USING (employee_id) JOIN employees e ON e.id = p.employee_id WHERE e.emp_id = ${empId}`;
    expect(`${raw[0].cnic_encrypted}${raw[0].bank_account_encrypted}`).not.toMatch(/42201|PK55/);
  });
});

describe('M3 joining: the record, the tree and the Emp-IDs', () => {
  it('puts the approved employee in the one central record: directory, profile, history, reporting tree', async () => {
    const body = newHire({ designation: 'SQA Engineer' });
    const { empId } = await hire(body);
    const listed = ((await t.as(FINANCE).get('/api/v1/employees').expect(200)).body as Array<{ empId: string; name: string }>).find((e) => e.empId === empId)!;
    expect(listed.name).toBe(body.name);
    const profile = (await t.as(DIRECTOR).get(`/api/v1/employees/${empId}`).expect(200)).body;
    expect(profile.job).toMatchObject({ level: 5, reportsTo: CTO, joiningDate: '2026-11-01', type: 'full_time', status: 'active', weeklyCapacityHours: 40 });
    expect(((await t.as(CTO).get('/api/v1/org/team').expect(200)).body as Array<{ empId: string }>).map((m) => m.empId)).toContain(empId);
    await t.as(DEV1).get(`/api/v1/org/team/${empId}`).expect(403);
    const closure = await prisma.reportingClosure.findMany({ where: { descendant: { empId } } });
    expect(closure.map((c) => c.depth).sort()).toEqual([0, 1, 2, 3, 4]);
    expect((await prisma.employmentHistory.findFirstOrThrow({ where: { employee: { empId }, eventType: 'joined' } })).details).toMatchObject({ designation: 'SQA Engineer', reportsTo: CTO });
  });

  it('gives a Sales hire the Sales role and part-time people a lower default capacity', async () => {
    const sales = await hire(newHire({ level: 4, departmentId: 'dep-sales', reportsToEmpId: DIRECTOR, designation: 'Sales Executive' }));
    const row = await prisma.employee.findUniqueOrThrow({ where: { empId: sales.empId }, include: { role: true, level: true } });
    expect([row.level.number, row.role.key]).toEqual([4, 'sales']);
    const intern = await hire(newHire({ type: 'intern' }));
    expect((await t.as(DIRECTOR).get(`/api/v1/employees/${intern.empId}`).expect(200)).body.job.weeklyCapacityHours).toBe(20);
  });

  it('generates unique, increasing Emp-IDs even when many people are approved at the same moment', async () => {
    const requests = await Promise.all(Array.from({ length: 5 }, () => t.as(DIRECTOR).post('/api/v1/employees').send(newHire())));
    const approvals = await Promise.all(requests.map((r) => t.as(CEO).post(`/api/v1/hire-requests/${r.body.requestId}/approve`).send({})));
    expect(approvals.every((r) => r.status === 200)).toBe(true);
    const ids = approvals.map((r) => r.body.empId as string);
    expect(new Set(ids).size).toBe(5);
    ids.forEach((id) => expect(id).toMatch(/^ACV-\d{4}$/));
    const missing = await prisma.$queryRaw<Array<{ missing: bigint }>>`
      SELECT count(*) AS missing FROM employees e WHERE NOT EXISTS (SELECT 1 FROM reporting_closure c WHERE c.ancestor_id = e.id AND c.descendant_id = e.id)`;
    expect(Number(missing[0].missing)).toBe(0);
  });

  it('never reuses an Emp-ID after someone leaves', async () => {
    const first = (await hire(newHire())).empId;
    await prisma.employee.update({ where: { empId: first }, data: { status: 'left' } });
    const second = (await hire(newHire())).empId;
    expect(second > first).toBe(true);
    expect(await prisma.employee.count({ where: { empId: first } })).toBe(1);
  });
});

describe('M3 the welcome email can be sent again', () => {
  it('keeps the new employee even if the mail server is down, and resends with a new temporary password', async () => {
    const body = newHire();
    const started = (await t.as(DIRECTOR).post('/api/v1/employees').send(body).expect(201)).body;
    t.mailer.failing = true;
    const res = await t.as(CEO).post(`/api/v1/hire-requests/${started.requestId}/approve`).send({}).expect(200);
    t.mailer.failing = false;
    expect(res.body.welcomeEmailSent).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: 'employee.welcome_email_failed', targetId: res.body.empId } })).toBe(1);
    await t.as(DIRECTOR).post(`/api/v1/employees/${res.body.empId}/resend-welcome`).send({}).expect(200);
    const temporary = passwordFrom(t.mailer.lastTo(body.officialEmail)!.text);
    expect((await t.rawLogin({ empId: res.body.empId, password: temporary }).expect(200)).body.status).toBe('password_change_required');
  });

  it('refuses to resend once the person has chosen their own password, and to unauthorized people', async () => {
    const body = newHire();
    const { empId } = await hire(body);
    const login = await t.rawLogin({ empId, password: passwordFrom(t.mailer.lastTo(body.officialEmail)!.text) }).expect(200);
    const headers = { Cookie: (login.headers['set-cookie'] as unknown as string[])[0].split(';')[0], 'X-CSRF-Token': login.body.csrfToken };
    await request(t.app.getHttpServer()).post('/api/v1/auth/password/change').set(headers).send({ newPassword: 'Chosen-Password-2026' }).expect(200);
    await t.as(DIRECTOR).post(`/api/v1/employees/${empId}/resend-welcome`).send({}).expect(409);
    await t.as(DEV1).post(`/api/v1/employees/${empId}/resend-welcome`).send({}).expect(403);
    await t.as(HR).post(`/api/v1/employees/${DIRECTOR}/resend-welcome`).send({}).expect(403);
  });
});
