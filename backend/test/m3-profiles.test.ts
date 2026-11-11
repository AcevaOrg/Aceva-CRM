import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CryptoService } from '../src/auth/crypto.service';
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
const SALES1 = 'ACV-0009';
const DEV1 = 'ACV-0006'; // the person whose profile most tests look at (reports to the CTO)
const DEV2 = 'ACV-0007';

let t: TestApp;
let prisma: PrismaClient;
let crypto: CryptoService;

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  prisma = createTestPrisma();
  crypto = t.app.get(CryptoService);
});
afterAll(async () => {
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

const profile = async (viewer: string, target = DEV1) => (await t.as(viewer).get(`/api/v1/employees/${target}`).expect(200)).body;
const denied = (reason: string) => prisma.auditLog.count({ where: { action: 'access.denied', reason } });

describe('M3 staff directory (Basic information: everyone)', () => {
  it('shows basic information of everyone to every employee, and nothing else', async () => {
    const list = (await t.as(DEV2).get('/api/v1/employees').expect(200)).body as Array<Record<string, unknown>>;
    expect(list).toHaveLength(14);
    expect(Object.keys(list[0]).sort()).toEqual(['departmentId', 'designation', 'empId', 'hasPhoto', 'name', 'officeId', 'officialEmail']);
    expect(JSON.stringify(list)).not.toMatch(/salary|cnic|joiningDate|level/i);
  });

  it('searches by name, Emp-ID or designation, and leaves out people who have left', async () => {
    expect(((await t.as(DEV2).get('/api/v1/employees?q=mariam').expect(200)).body as unknown[]).length).toBe(1);
    expect(((await t.as(DEV2).get('/api/v1/employees?q=ACV-0004').expect(200)).body as Array<{ empId: string }>)[0].empId).toBe(CTO);
    await prisma.employee.update({ where: { empId: 'ACV-0013' }, data: { status: 'left' } });
    expect(((await t.as(DEV2).get('/api/v1/employees').expect(200)).body as unknown[]).length).toBe(13);
    await prisma.employee.update({ where: { empId: 'ACV-0013' }, data: { status: 'active' } });
  });

  it('requires a login', async () => {
    await t.anonymous().get('/api/v1/employees').expect(401);
  });
});

describe('M3 pay and personal details are set by the right people', () => {
  it('HR enters personal details (including the CNIC) and the Director enters pay', async () => {
    await t.as(HR).patch(`/api/v1/employees/${DEV1}/personal`).send({ cnic: '42101-1234567-1', phone: '+92 300 1234567', homeAddress: 'House 12, Block B, Dadu', emergencyContact: { name: 'Imran Khan', relation: 'Father', phone: '+92 301 7654321' } }).expect(200);
    await t.stepUp(DIRECTOR);
    await t.as(DIRECTOR).patch(`/api/v1/employees/${DEV1}/pay`).send({ baseSalary: 300000, allowances: 8000, bankName: 'Bank Alfalah', accountNumber: 'PK36ALFH55019987123344', reason: 'Starting salary' }).expect(200);
    // the Director's own pay, so own-pay visibility can be checked
    await t.as(OWNER).get(`/api/v1/employees/${DIRECTOR}`).expect(200);
  });
});

describe('M3 who sees which section (plan section 7)', () => {
  const sees = async (viewer: string, target = DEV1) => {
    const p = await profile(viewer, target);
    return { job: !!p.job, personal: !!p.personal, pay: !!p.pay, documents: !!p.documents || p.access.see.documents, history: !!p.history, p };
  };

  it('a peer sees only the basic information', async () => {
    const s = await sees(DEV2);
    expect(s).toMatchObject({ job: false, personal: false, pay: false, history: false });
    expect(s.p.access.see).toMatchObject({ basic: true, job: false, personal: false, pay: false, documents: false });
    expect(s.p.basic.name).toBeTruthy();
  });

  it('Sales and Finance (who are beside, not above) do not see Job or Personal; Finance sees Pay', async () => {
    expect(await sees(SALES1)).toMatchObject({ job: false, personal: false, pay: false });
    expect(await sees(FINANCE)).toMatchObject({ job: false, personal: false, pay: true });
  });

  it('the employee sees their own Job, Personal and Pay', async () => {
    expect(await sees(DEV1)).toMatchObject({ job: true, personal: true, pay: true, history: true });
  });

  it('the manager above sees Job but not Personal or Pay', async () => {
    const s = await sees(CTO);
    expect(s).toMatchObject({ job: true, personal: false, pay: false, history: true });
    expect(s.p.job).toMatchObject({ level: 5, reportsTo: CTO, type: 'full_time', status: 'active' });
  });

  it('HR sees Job and Personal but not Pay', async () => {
    expect(await sees(HR)).toMatchObject({ job: true, personal: true, pay: false });
  });

  it('the Director, the CEO and the Owner see everything', async () => {
    for (const viewer of [DIRECTOR, CEO, OWNER]) expect(await sees(viewer), viewer).toMatchObject({ job: true, personal: true, pay: true });
  });

  it('nobody sees the pay of someone else unless allowed: employees, the CTO and HR never do', async () => {
    for (const viewer of [DEV2, SALES1, CTO, HR]) expect((await profile(viewer)).pay, viewer).toBeUndefined();
    expect((await profile(DEV2, DIRECTOR)).pay).toBeUndefined(); // nor the Director's pay
  });

  it('shows only masked CNIC and bank account numbers', async () => {
    const p = await profile(DIRECTOR);
    expect(p.personal.cnicMasked).toMatch(/^\*+5671$/);
    expect(p.pay.accountMasked).toMatch(/^\*+3344$/);
    expect(JSON.stringify(p)).not.toContain('42101-1234567-1');
    expect(JSON.stringify(p)).not.toContain('PK36ALFH55019987123344');
    expect(p.pay).toEqual({ salaryOnFile: true, currency: 'PKR', bankName: 'Bank Alfalah', accountMasked: expect.stringMatching(/^\*+3344$/) });
    expect(JSON.stringify(p)).not.toMatch(/300000|8000/); // salary amounts are never sent before a logged reveal
    expect(p.personal).toMatchObject({ phone: '+92 300 1234567', homeAddress: 'House 12, Block B, Dadu', emergencyContact: { name: 'Imran Khan', relation: 'Father' } });
  });
});

describe('M3 who may change what (enforced on the server, not only in forms)', () => {
  it('an employee changes only their own phone, address and emergency contact', async () => {
    const me = t.as(DEV1);
    await me.patch(`/api/v1/employees/${DEV1}/personal`).send({ phone: '+92 333 9998887' }).expect(200);
    await me.patch(`/api/v1/employees/${DEV1}/personal`).send({ homeAddress: 'Flat 4, Clifton, Karachi' }).expect(200);
    await me.patch(`/api/v1/employees/${DEV1}/personal`).send({ emergencyContact: { name: 'Fatima Khan', relation: 'Mother', phone: '+92 302 1112223' } }).expect(200);
    expect((await profile(DEV1)).personal).toMatchObject({ phone: '+92 333 9998887', homeAddress: 'Flat 4, Clifton, Karachi', emergencyContact: { name: 'Fatima Khan' } });
  });

  it('...but not their CNIC, job, basic or pay fields, even by sending the request directly', async () => {
    const me = t.as(DEV1);
    await me.patch(`/api/v1/employees/${DEV1}/personal`).send({ cnic: '42101-7654321-9' }).expect(403);
    await me.patch(`/api/v1/employees/${DEV1}/basic`).send({ designation: 'Chief Everything' }).expect(403);
    await me.patch(`/api/v1/employees/${DEV1}/job`).send({ type: 'part_time', reason: 'I would like fewer hours' }).expect(403);
    await me.patch(`/api/v1/employees/${DEV1}/pay`).send({ baseSalary: 999999, reason: 'I deserve it' }).expect(403);
    await me.patch(`/api/v1/employees/${DEV1}/job`).send({ level: 4, reason: 'promote myself please' }).expect(403);
    await t.stepUp(DIRECTOR);
    expect((await t.as(DIRECTOR).post(`/api/v1/employees/${DEV1}/reveal`).send({ field: 'salary' }).expect(200)).body.value).toBe('300000.00');
  });

  it('nobody changes someone else\'s personal details unless HR or the Director', async () => {
    for (const actor of [DEV2, SALES1, FINANCE, CTO]) await t.as(actor).patch(`/api/v1/employees/${DEV1}/personal`).send({ phone: '+92 300 0000000' }).expect(403);
  });

  it('HR and the Director change job-related fields, with a reason', async () => {
    await t.as(HR).patch(`/api/v1/employees/${DEV1}/basic`).send({ designation: 'Principal Backend Developer' }).expect(200);
    await t.as(DIRECTOR).patch(`/api/v1/employees/${DEV1}/basic`).send({ officeId: 'off-remote', reason: 'Moved to remote work' }).expect(200);
    await t.as(HR).patch(`/api/v1/employees/${DEV1}/job`).send({ type: 'part_time', weeklyCapacityHours: 20, reason: 'Reduced hours agreed' }).expect(200);
    await t.as(HR).patch(`/api/v1/employees/${DEV1}/job`).send({ type: 'full_time' }).expect(400); // a reason is required
    const p = await profile(DIRECTOR);
    expect(p.basic).toMatchObject({ designation: 'Principal Backend Developer', officeId: 'off-remote' });
    expect(p.job).toMatchObject({ type: 'part_time', weeklyCapacityHours: 20 });
  });

  it('only the Director changes pay, never their own, and HR cannot', async () => {
    await t.stepUp(DIRECTOR);
    await t.as(DIRECTOR).patch(`/api/v1/employees/${DEV1}/pay`).send({ baseSalary: 320000, reason: 'Annual review' }).expect(200);
    await t.as(HR).patch(`/api/v1/employees/${DEV1}/pay`).send({ baseSalary: 1, reason: 'HR may not change pay' }).expect(403);
    await t.as(CEO).patch(`/api/v1/employees/${DEV1}/pay`).send({ baseSalary: 1, reason: 'CEO may not change pay' }).expect(403);
    await t.as(FINANCE).patch(`/api/v1/employees/${DEV1}/pay`).send({ baseSalary: 1, reason: 'Finance may not change pay' }).expect(403);
    await t.as(DIRECTOR).patch(`/api/v1/employees/${DIRECTOR}/pay`).send({ baseSalary: 999999, reason: 'Raise for myself' }).expect(403);
    await t.stepUp(DIRECTOR);
    expect((await t.as(DIRECTOR).post(`/api/v1/employees/${DEV1}/reveal`).send({ field: 'salary' }).expect(200)).body.value).toBe('320000.00');
    expect(await denied('pay_edit_not_allowed')).toBeGreaterThanOrEqual(5);
  });

  it('nobody edits someone above them or at their own level without being above them', async () => {
    await t.as(HR).patch(`/api/v1/employees/${DIRECTOR}/basic`).send({ designation: 'Hacked' }).expect(403); // upward
    await t.as(HR).patch(`/api/v1/employees/${SALES1}/basic`).send({ designation: 'Hacked' }).expect(403); // same level, beside
    await t.as(HR).patch(`/api/v1/employees/${HR}/basic`).send({ designation: 'Self promotion' }).expect(403); // themselves
    await t.as(DIRECTOR).patch(`/api/v1/employees/${CEO}/basic`).send({ designation: 'Hacked' }).expect(403); // upward
  });

  it('levels and reporting lines change only through the Owner/CEO rules, even from the job form', async () => {
    await t.as(DIRECTOR).patch(`/api/v1/employees/${DEV1}/job`).send({ level: 4, reason: 'Director may not change levels' }).expect(403);
    await t.as(HR).patch(`/api/v1/employees/${DEV1}/job`).send({ reportsToEmpId: FINANCE, reason: 'HR may not move people' }).expect(403);
    await t.as(CEO).patch(`/api/v1/employees/${DEV1}/job`).send({ reportsToEmpId: FINANCE, reason: 'Joins the finance team' }).expect(200);
    expect((await profile(CEO)).job.reportsTo).toBe(FINANCE);
    await t.as(CEO).patch(`/api/v1/employees/${DEV1}/job`).send({ reportsToEmpId: CTO, reason: 'Back to development' }).expect(200);
    await t.as(CEO).patch(`/api/v1/employees/${DEV1}/job`).send({ reportsToEmpId: DEV2, reason: 'Invalid on purpose' }).expect(400); // M1 validation applies
  });

  it('validates the input (bad CNIC, wrong email domain, unknown fields, negative pay)', async () => {
    await t.as(HR).patch(`/api/v1/employees/${DEV1}/personal`).send({ cnic: '123' }).expect(400);
    await t.as(HR).patch(`/api/v1/employees/${DEV1}/basic`).send({ officialEmail: 'someone@gmail.com' }).expect(400);
    await t.as(HR).patch(`/api/v1/employees/${DEV1}/basic`).send({ officialEmail: 'ali@acevatech.com' }).expect(409); // taken
    await t.as(HR).patch(`/api/v1/employees/${DEV1}/basic`).send({ isAdmin: true }).expect(400);
    await t.as(DIRECTOR).patch(`/api/v1/employees/${DEV1}/pay`).send({ baseSalary: -5, reason: 'negative pay' }).expect(400);
    await t.as(DIRECTOR).patch(`/api/v1/employees/${DEV1}/pay`).send({ baseSalary: 100.555, reason: 'too many decimals' }).expect(400);
    await t.as(HR).patch(`/api/v1/employees/${DEV1}/basic`).send({}).expect(400); // nothing to change
  });

  it('status changes only through the leaving workflow', async () => {
    await t.as(HR).patch(`/api/v1/employees/${DEV1}/job`).send({ status: 'on_notice', reason: 'trying to skip the workflow' }).expect(400);
  });
});

describe('M3 every change keeps the old value (who, when, old, new)', () => {
  it('records each field with its old and new value, the person who changed it, and the reason', async () => {
    const history = (await profile(DIRECTOR)).history as Array<{ field: string; oldValue: string; newValue: string; changedBy: string; changedAt: string; reason?: string; section: string }>;
    const find = (field: string, newValue: string) => history.find((h) => h.field === field && h.newValue === newValue)!;

    expect(find('Designation', 'Principal Backend Developer')).toMatchObject({ oldValue: 'Senior Backend Developer', changedBy: HR, section: 'basic' });
    expect(find('Office', 'Remote')).toMatchObject({ oldValue: 'Karachi Studio', changedBy: DIRECTOR, reason: 'Moved to remote work' });
    expect(find('Type', 'Part-time')).toMatchObject({ oldValue: 'Full-time', changedBy: HR, reason: 'Reduced hours agreed', section: 'job' });
    expect(find('Phone', '+92 333 9998887')).toMatchObject({ oldValue: '+92 300 1234567', changedBy: DEV1, section: 'personal' });
    // salary amounts are hidden in the history too; the old and new values are kept (encrypted) in the table
    expect(history.find((h) => h.field === 'Base salary' && h.reason === 'Annual review')).toMatchObject({ oldValue: '••••••', newValue: '••••••', changedBy: DIRECTOR, section: 'pay' });
    expect(JSON.stringify(history)).not.toMatch(/300000|320000/);
    expect(find('Reports to', FINANCE)).toBeUndefined(); // reporting-line history is written by Module 1 (checked below)
    expect(history.every((h) => !Number.isNaN(Date.parse(h.changedAt)))).toBe(true);
  });

  it('keeps the old CNIC and bank account encrypted, and shows them masked', async () => {
    await t.as(HR).patch(`/api/v1/employees/${DEV1}/personal`).send({ cnic: '42101-7654321-9' }).expect(200);
    await t.stepUp(DIRECTOR);
    await t.as(DIRECTOR).patch(`/api/v1/employees/${DEV1}/pay`).send({ accountNumber: 'PK99NEWB00112233445566', reason: 'Changed bank' }).expect(200);
    const history = (await profile(DIRECTOR)).history as Array<{ field: string; oldValue: string; newValue: string }>;
    const cnic = history.find((h) => h.field === 'CNIC' && h.oldValue !== '—')!;
    expect(cnic).toMatchObject({ oldValue: expect.stringMatching(/^\*+5671$/), newValue: expect.stringMatching(/^\*+3219$/) });
    const rows = await prisma.profileChange.findMany({ where: { employee: { empId: DEV1 }, field: { in: ['CNIC', 'Bank account', 'Base salary'] } } });
    expect(rows.length).toBeGreaterThanOrEqual(5);
    for (const r of rows) {
      expect(r.isSensitive).toBe(true);
      expect(`${r.oldValue}${r.newValue}`).not.toMatch(/42101|PK36|PK99|300000|320000/); // nothing readable in the table
    }
    const oldCnicRow = rows.find((r) => r.field === 'CNIC' && r.oldValue)!;
    expect(crypto.decrypt(oldCnicRow.oldValue!)).toBe('42101-1234567-1'); // ...but the old value really is kept
  });

  it('shows history only to people who can see that section', async () => {
    expect((await profile(DEV2)).history).toBeUndefined(); // a peer: no history at all
    const cto = (await profile(CTO)).history as Array<{ section: string }>;
    expect(cto.length).toBeGreaterThan(0);
    expect(cto.some((h) => h.section === 'pay' || h.section === 'personal')).toBe(false); // job and basic only
    const hr = (await profile(HR)).history as Array<{ section: string }>;
    expect(hr.some((h) => h.section === 'personal')).toBe(true);
    expect(hr.some((h) => h.section === 'pay')).toBe(false); // HR never sees pay history
    const director = (await profile(DIRECTOR)).history as Array<{ section: string }>;
    expect(new Set(director.map((h) => h.section))).toEqual(new Set(['basic', 'job', 'personal', 'pay']));
  });

  it('keeps level and reporting-line changes in the same history', async () => {
    const history = (await profile(CEO)).history as Array<{ field: string; changedBy: string }>;
    expect(history.some((h) => h.field === 'reportsTo' || h.field === 'Reports to')).toBe(true);
  });
});

describe('M3 who is offered the Job form', () => {
  const canEditJob = async (viewer: string, target: string) => (await profile(viewer, target)).access.edit.job as boolean;

  it('Director, HR, Owner and CEO get it for people below them; nobody gets it for themselves, upward or sideways', async () => {
    for (const who of [DIRECTOR, HR, CEO, OWNER]) expect(await canEditJob(who, DEV1), who).toBe(true);
    for (const who of [DIRECTOR, HR, CEO, OWNER]) expect(await canEditJob(who, who), who).toBe(false); // never their own
    expect(await canEditJob(HR, DIRECTOR)).toBe(false); // upward
    expect(await canEditJob(DIRECTOR, CEO)).toBe(false); // upward
    for (const who of [DEV2, SALES1, CTO, FINANCE, DEV1]) expect(await canEditJob(who, DEV1), who).toBe(false); // peers, the manager, the person themself
  });
});

describe('M3 revealing masked values', () => {
  const reveal = (viewer: string, field: 'cnic' | 'account', target = DEV1) => t.as(viewer).post(`/api/v1/employees/${target}/reveal`).send({ field });

  it('shows the full value to someone allowed to see that section, and logs every reveal', async () => {
    const before = await prisma.auditLog.count({ where: { action: 'employee.sensitive.revealed' } });
    expect((await reveal(DIRECTOR, 'cnic').expect(200)).body.value).toBe('42101-7654321-9');
    await t.stepUp(DIRECTOR);
    expect((await reveal(DIRECTOR, 'account').expect(200)).body.value).toBe('PK99NEWB00112233445566');
    expect((await reveal(HR, 'cnic').expect(200)).body.value).toBe('42101-7654321-9');
    await t.stepUp(DEV1);
    expect((await reveal(DEV1, 'account').expect(200)).body.value).toBe('PK99NEWB00112233445566'); // their own
    expect(await prisma.auditLog.count({ where: { action: 'employee.sensitive.revealed' } })).toBe(before + 4);
    const entry = await prisma.auditLog.findFirstOrThrow({ where: { action: 'employee.sensitive.revealed', targetId: DEV1, actor: { empId: HR } }, include: { actor: true } });
    expect(entry.details).toEqual({ field: 'CNIC' });
    expect(JSON.stringify(entry)).not.toContain('42101-7654321-9'); // the value itself is never logged
  });

  it('refuses people who cannot see the section (HR and the bank account, a peer, the CTO)', async () => {
    await reveal(HR, 'account').expect(403);
    await reveal(DEV2, 'cnic').expect(403);
    await reveal(CTO, 'cnic').expect(403);
    await reveal(CTO, 'account').expect(403);
    await reveal(FINANCE, 'cnic').expect(403); // Finance sees pay, not personal details
    await t.stepUp(FINANCE);
    expect((await reveal(FINANCE, 'account').expect(200)).body.value).toBe('PK99NEWB00112233445566');
  });

  it('logs a salary reveal too, and only for people allowed to see pay', async () => {
    const before = await prisma.auditLog.count({ where: { action: 'employee.sensitive.revealed' } });
    await t.stepUp(DIRECTOR);
    expect((await reveal(DIRECTOR, 'salary' as 'cnic').expect(200)).body).toEqual({ value: '320000.00', allowances: '8000.00' });
    await reveal(HR, 'salary' as 'cnic').expect(403);
    await reveal(CTO, 'salary' as 'cnic').expect(403);
    expect(await prisma.auditLog.count({ where: { action: 'employee.sensitive.revealed' } })).toBe(before + 1);
  });

  it('says nothing exists when nothing is stored', async () => {
    await reveal(DIRECTOR, 'cnic', SALES1).expect(404);
  });
});

describe('M3 sensitive data is encrypted at rest', () => {
  it('never stores a CNIC or bank account number in readable form', async () => {
    const rows = await prisma.$queryRaw<Array<{ cnic_encrypted: string; bank_account_encrypted: string }>>`
      SELECT p.cnic_encrypted, y.bank_account_encrypted FROM employee_personal p JOIN employee_pay y USING (employee_id)`;
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) {
      expect(r.cnic_encrypted).toMatch(/^v1:/);
      expect(r.bank_account_encrypted).toMatch(/^v1:/);
      expect(`${r.cnic_encrypted}${r.bank_account_encrypted}`).not.toMatch(/42101|PK99/);
    }
  });
});
