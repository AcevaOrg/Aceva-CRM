import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SALES_DUPLICATE_CHECKS_PER_MINUTE } from '@aceva/contracts';
import type { PrismaClient } from '../src/generated/prisma/client';
import { ActivityRecorder } from '../src/activity/activity-recorder.service';
import { createTestApp, type SignedIn, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 15.1: leads and companies (plan section 20), against the real database.
 * One record per person and per company, one owner per lead, no duplicates (email; company website domain), each
 * salesperson sees their own leads and only "it exists, and who owns it" of anyone else's; the sales manager (the
 * Director) sees and manages the team; the CEO / Owner only views; everyone without sales.own has no access.
 */
const API = '/api/v1';
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003'; // holds the sales-manager duty
const CTO = 'ACV-0004';
const DEV = 'ACV-0006';
const HIRA = 'ACV-0009'; // sales
const FINANCE = 'ACV-0010';
const KAMRAN = 'ACV-0012'; // sales
const SAAD = 'ACV-0014'; // sales

let t: TestApp;
let prisma: PrismaClient;
const leads: Record<string, { id: string; version: number }> = {};

const as = (who: string) => t.as(who);
const newLead = (who: string, body: Record<string, unknown>) => as(who).post(`${API}/sales/leads`).send({ source: 'linkedin', ...body });
const audit = (action: string, targetId?: string) => prisma.auditLog.findMany({ where: { action, ...(targetId ? { targetId } : {}) }, orderBy: { occurredAt: 'asc' } });
const put = (who: string, url: string) => request(t.app.getHttpServer()).put(url).set((t.as(who) as SignedIn).headers());

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  prisma = createTestPrisma();
}, 180000);
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M15.1 access (plan section 20, "Who can do what"; section 16: the prospect list is confidential)', () => {
  it('people without sales.own have no access: Finance, the CTO, developers', async () => {
    for (const who of [FINANCE, CTO, DEV]) {
      await as(who).get(`${API}/sales/leads`).expect(403);
      await as(who).get(`${API}/sales/companies`).expect(403);
      await newLead(who, { fullName: 'Nope' }).expect(403);
      await as(who).post(`${API}/sales/leads/check-duplicate`).send({ email: 'x@y.com' }).expect(403);
    }
  });

  it('the sales team, the Director and the CEO / Owner open the lead list', async () => {
    for (const who of [HIRA, KAMRAN, SAAD, DIRECTOR, OWNER]) {
      const res = await as(who).get(`${API}/sales/leads`).expect(200);
      expect(res.body).toMatchObject({ items: [], total: 0, page: 1 });
    }
  });
});

describe('M15.1 leads and companies', () => {
  it('a salesperson adds a lead with a new company; the domain is normalised; the lead is theirs; it is logged', async () => {
    const res = await newLead(HIRA, {
      fullName: 'Ayesha Khan',
      jobTitle: 'CTO',
      email: '  Ayesha.Khan@Acme-Test.com ',
      phone: '+44 20 7946 0000',
      country: 'United Kingdom',
      notes: 'Met at the London expo',
      company: { name: 'Acme Test Ltd', website: 'https://www.Acme-Test.com/about', country: 'United Kingdom', industry: 'Retail' },
    }).expect(201);
    expect(res.body).toMatchObject({
      restricted: false,
      fullName: 'Ayesha Khan',
      email: 'Ayesha.Khan@Acme-Test.com',
      source: 'linkedin',
      owner: { empId: HIRA },
      emailCheck: 'unchecked',
      archived: false,
      version: 1,
      canEdit: true,
      canReassign: false,
      createdBy: { empId: HIRA },
      company: { name: 'Acme Test Ltd', domain: 'acme-test.com', website: 'https://www.Acme-Test.com/about' },
    });
    leads.ayesha = { id: res.body.id, version: 1 };
    const row = await prisma.salesLead.findUniqueOrThrow({ where: { id: res.body.id } });
    expect(row.emailNormalized).toBe('ayesha.khan@acme-test.com');
    expect(await audit('sales.lead.created', res.body.id)).toHaveLength(1);
    expect(await audit('sales.company.created', res.body.company.id)).toHaveLength(1);
    await t.app.get(ActivityRecorder).flush();
    expect(await prisma.activityEvent.count({ where: { module: 'Sales', employee: { empId: HIRA }, action: 'create' } })).toBeGreaterThanOrEqual(1);
  });

  it("another salesperson does not list it, and opening it shows only that it exists and who owns it", async () => {
    const list = await as(KAMRAN).get(`${API}/sales/leads`).expect(200);
    expect(list.body.total).toBe(0);
    const stub = (await as(KAMRAN).get(`${API}/sales/leads/${leads.ayesha.id}`).expect(200)).body;
    expect(stub).toEqual({ restricted: true, id: leads.ayesha.id, fullName: 'Ayesha Khan', companyName: 'Acme Test Ltd', owner: { empId: HIRA, name: expect.any(String) } });
    expect(JSON.stringify(stub)).not.toMatch(/Ayesha\.Khan@|7946|London expo/);
    await as(KAMRAN).patch(`${API}/sales/leads/${leads.ayesha.id}`).send({ notes: 'mine now', version: 1 }).expect(403);
    await as(KAMRAN).get(`${API}/sales/leads/00000000-0000-4000-8000-000000000000`).expect(404);
  });

  it('the same email (any case or spacing) is refused with its owner, from anyone', async () => {
    for (const who of [KAMRAN, HIRA]) {
      const res = await newLead(who, { fullName: 'Ayesha K.', email: 'AYESHA.KHAN@acme-test.com' }).expect(409);
      expect(res.body).toMatchObject({ code: 'duplicate_lead', existing: { leadId: leads.ayesha.id, owner: { empId: HIRA } } });
      expect(res.body.message).toContain(HIRA);
    }
    expect(await prisma.salesLead.count()).toBe(1);
  });

  it('the check before saving: email owner, and who works on a company with that website domain', async () => {
    const res = (await as(KAMRAN).post(`${API}/sales/leads/check-duplicate`).send({ email: 'ayesha.khan@acme-test.com', website: 'acme-test.com/contact' }).expect(200)).body;
    expect(res).toMatchObject({
      email: { leadId: leads.ayesha.id, owner: { empId: HIRA }, mine: false, canOpen: false },
      domain: 'acme-test.com',
      sharedDomain: false,
      company: { name: 'Acme Test Ltd', leadOwners: [{ empId: HIRA, name: expect.any(String) }] },
    });
    const none = (await as(KAMRAN).post(`${API}/sales/leads/check-duplicate`).send({ email: 'nobody@else.io' }).expect(200)).body;
    expect(none).toEqual({ email: null, domain: null, sharedDomain: false, company: null });
    const mine = (await as(DIRECTOR).post(`${API}/sales/leads/check-duplicate`).send({ email: 'ayesha.khan@acme-test.com' }).expect(200)).body;
    expect(mine.email).toMatchObject({ mine: false, canOpen: true }); // the sales manager may open the team's leads
  });

  it('a new company with an existing website domain is that company (one record per company)', async () => {
    const res = await newLead(KAMRAN, { fullName: 'Bilal Raza', email: 'bilal@acme-test.com', company: { name: 'ACME (UK)', website: 'acme-test.com' } }).expect(201);
    const acme = await prisma.salesCompany.findMany({ where: { domain: 'acme-test.com' } });
    expect(acme).toHaveLength(1);
    expect(res.body.company).toMatchObject({ id: acme[0].id, name: 'Acme Test Ltd' });
    leads.bilal = { id: res.body.id, version: 1 };
    // the company page shows each person only their own leads there, and how many others exist
    const forKamran = (await as(KAMRAN).get(`${API}/sales/companies/${acme[0].id}`).expect(200)).body;
    expect(forKamran.leads.map((l: { id: string }) => l.id)).toEqual([leads.bilal.id]);
    expect(forKamran.otherLeads).toBe(1);
    const forDirector = (await as(DIRECTOR).get(`${API}/sales/companies/${acme[0].id}`).expect(200)).body;
    expect(forDirector.leads).toHaveLength(2);
    expect(forDirector.otherLeads).toBe(0);
  });

  it('a company is added once: the same domain again is refused with the existing company', async () => {
    const res = await as(SAAD).post(`${API}/sales/companies`).send({ name: 'Acme again', website: 'http://acme-test.com' }).expect(409);
    expect(res.body).toMatchObject({ code: 'duplicate_company', existing: { name: 'Acme Test Ltd' } });
    const ok = await as(SAAD).post(`${API}/sales/companies`).send({ name: 'Globex', website: 'globex-test.io', country: 'United States' }).expect(201);
    expect(ok.body).toMatchObject({ name: 'Globex', domain: 'globex-test.io', canEdit: true, version: 1 });
    // without a website there is nothing to compare: two companies may share a name (no rule merges them by name)
    await as(SAAD).post(`${API}/sales/companies`).send({ name: 'Initech' }).expect(201);
    await as(SAAD).post(`${API}/sales/companies`).send({ name: 'Initech' }).expect(201);
    expect(await prisma.salesCompany.count({ where: { name: 'Initech' } })).toBe(2);
    const list = (await as(HIRA).get(`${API}/sales/companies?q=globex`).expect(200)).body;
    expect(list.items.map((c: { name: string }) => c.name)).toEqual(['Globex']);
    expect(list.items[0].canEdit).toBe(false); // Hira neither added it nor has a lead there
  });

  it('changing a company: whoever added it, the owner of a lead there, or the sales manager; versions are checked', async () => {
    const globex = await prisma.salesCompany.findFirstOrThrow({ where: { domain: 'globex-test.io' } });
    await as(HIRA).patch(`${API}/sales/companies/${globex.id}`).send({ industry: 'Energy', version: 1 }).expect(403);
    const changed = (await as(SAAD).patch(`${API}/sales/companies/${globex.id}`).send({ industry: 'Energy', version: 1 }).expect(200)).body;
    expect(changed).toMatchObject({ industry: 'Energy', version: 2 });
    await as(SAAD).patch(`${API}/sales/companies/${globex.id}`).send({ industry: 'Oil', version: 1 }).expect(409);
    const clash = await as(DIRECTOR).patch(`${API}/sales/companies/${globex.id}`).send({ website: 'www.acme-test.com', version: 2 }).expect(409);
    expect(clash.body.code).toBe('duplicate_company');
    expect(await audit('sales.company.updated', globex.id)).toHaveLength(1);
  });

  it('two people adding the same new email at the same moment get one lead and one "already exists"', async () => {
    const results = await Promise.all([
      newLead(HIRA, { fullName: 'Race One', email: 'race@initech-test.com' }),
      newLead(KAMRAN, { fullName: 'Race Two', email: 'Race@Initech-Test.com' }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await prisma.salesLead.count({ where: { emailNormalized: 'race@initech-test.com' } })).toBe(1);
    expect(results.find((r) => r.status === 409)!.body.code).toBe('duplicate_lead');
  });

  it('two people adding leads at the same new company domain at the same moment get one company', async () => {
    const results = await Promise.all([
      newLead(HIRA, { fullName: 'Umbrella One', email: 'one@umbrella-test.com', company: { name: 'Umbrella', website: 'umbrella-test.com' } }),
      newLead(SAAD, { fullName: 'Umbrella Two', email: 'two@umbrella-test.com', company: { name: 'Umbrella Corp', website: 'https://umbrella-test.com' } }),
    ]);
    expect(results.map((r) => r.status)).toEqual([201, 201]);
    expect(await prisma.salesCompany.count({ where: { domain: 'umbrella-test.com' } })).toBe(1);
    expect(results[0].body.company.id).toBe(results[1].body.company.id);
  });

  it('the owner edits their lead; another email that exists is refused; an old version is refused', async () => {
    const res = (await as(HIRA).patch(`${API}/sales/leads/${leads.ayesha.id}`).send({ phone: null, jobTitle: 'Chief Technology Officer', notes: 'Prefers email', version: 1 }).expect(200)).body;
    expect(res).toMatchObject({ phone: null, jobTitle: 'Chief Technology Officer', notes: 'Prefers email', version: 2 });
    leads.ayesha.version = 2;
    await as(HIRA).patch(`${API}/sales/leads/${leads.ayesha.id}`).send({ notes: 'old', version: 1 }).expect(409);
    const dup = await as(HIRA).patch(`${API}/sales/leads/${leads.ayesha.id}`).send({ email: 'bilal@ACME-test.com', version: 2 }).expect(409);
    expect(dup.body).toMatchObject({ code: 'duplicate_lead', existing: { owner: { empId: KAMRAN } } });
    const [updated] = await audit('sales.lead.updated', leads.ayesha.id);
    expect(updated.details).toMatchObject({ before: { phone: '+44 20 7946 0000', notes: '[text]' }, after: { phone: null, notes: '[text]' } });
    expect(JSON.stringify(updated.details)).not.toContain('Prefers email'); // free text never goes into the audit log
  });

  it('only the sales manager gives a new lead to someone else, and only to an active salesperson in their team', async () => {
    await newLead(HIRA, { fullName: 'For Kamran', email: 'fk@globex-test.io', ownerEmpId: KAMRAN }).expect(403);
    await newLead(OWNER, { fullName: 'From the CEO', email: 'ceo@globex-test.io', ownerEmpId: HIRA }).expect(403); // the CEO / Owner only views
    await newLead(DIRECTOR, { fullName: 'To a developer', email: 'dev@globex-test.io', ownerEmpId: DEV }).expect(400);
    await newLead(DIRECTOR, { fullName: 'To finance', email: 'fin@globex-test.io', ownerEmpId: FINANCE }).expect(400);
    const res = await newLead(DIRECTOR, { fullName: 'Walk-in visitor', email: 'walkin@globex-test.io', source: 'walk_in', ownerEmpId: SAAD }).expect(201);
    expect(res.body.owner.empId).toBe(SAAD);
    expect(res.body.createdBy.empId).toBe(DIRECTOR);
  });

  it('the sales manager moves a lead to another salesperson: reason, version and logging; nobody else can', async () => {
    await as(HIRA).post(`${API}/sales/leads/${leads.ayesha.id}/owner`).send({ toEmpId: KAMRAN, reason: 'Kamran covers the UK', version: 2 }).expect(403);
    await as(OWNER).post(`${API}/sales/leads/${leads.ayesha.id}/owner`).send({ toEmpId: KAMRAN, reason: 'Kamran covers the UK', version: 2 }).expect(403);
    await as(DIRECTOR).post(`${API}/sales/leads/${leads.ayesha.id}/owner`).send({ toEmpId: DEV, reason: 'Kamran covers the UK', version: 2 }).expect(400);
    await as(DIRECTOR).post(`${API}/sales/leads/${leads.ayesha.id}/owner`).send({ toEmpId: HIRA, reason: 'Kamran covers the UK', version: 2 }).expect(409);
    await as(DIRECTOR).post(`${API}/sales/leads/${leads.ayesha.id}/owner`).send({ toEmpId: KAMRAN, reason: 'Kamran covers the UK', version: 1 }).expect(409);
    const moved = (await as(DIRECTOR).post(`${API}/sales/leads/${leads.ayesha.id}/owner`).send({ toEmpId: KAMRAN, reason: 'Kamran covers the UK', version: 2 }).expect(200)).body;
    expect(moved).toMatchObject({ owner: { empId: KAMRAN }, version: 3, canReassign: true });
    const [log] = await audit('sales.lead.reassigned', leads.ayesha.id);
    expect(log).toMatchObject({ reason: 'Kamran covers the UK', details: { from: HIRA, to: KAMRAN } });
    // now Kamran sees it in full and Hira only that it exists
    expect((await as(KAMRAN).get(`${API}/sales/leads/${leads.ayesha.id}`).expect(200)).body.restricted).toBe(false);
    expect((await as(HIRA).get(`${API}/sales/leads/${leads.ayesha.id}`).expect(200)).body.restricted).toBe(true);
  });

  it('two sales-manager moves of the same version: one wins, the other is told to reload', async () => {
    const lead = (await newLead(SAAD, { fullName: 'Contested', email: 'contested@globex-test.io' }).expect(201)).body;
    const results = await Promise.all([
      as(DIRECTOR).post(`${API}/sales/leads/${lead.id}/owner`).send({ toEmpId: HIRA, reason: 'Hira knows them', version: 1 }),
      as(DIRECTOR).post(`${API}/sales/leads/${lead.id}/owner`).send({ toEmpId: KAMRAN, reason: 'Kamran knows them', version: 1 }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect(await audit('sales.lead.reassigned', lead.id)).toHaveLength(1);
  });

  it('the Director and the CEO / Owner see the whole team; filters work; the CEO / Owner cannot change anything', async () => {
    const all = (await as(DIRECTOR).get(`${API}/sales/leads?pageSize=200`).expect(200)).body;
    expect(all.total).toBe(await prisma.salesLead.count());
    const owner = (await as(OWNER).get(`${API}/sales/leads?pageSize=200`).expect(200)).body;
    expect(owner.total).toBe(all.total);
    expect(owner.items.every((l: { canEdit: boolean; canReassign: boolean }) => !l.canEdit && !l.canReassign)).toBe(true);
    await as(OWNER).patch(`${API}/sales/leads/${leads.bilal.id}`).send({ notes: 'x', version: 1 }).expect(403);
    const kamrans = (await as(DIRECTOR).get(`${API}/sales/leads?owner=${KAMRAN}`).expect(200)).body;
    expect(kamrans.items.every((l: { owner: { empId: string } }) => l.owner.empId === KAMRAN)).toBe(true);
    const search = (await as(DIRECTOR).get(`${API}/sales/leads?q=acme test`).expect(200)).body;
    expect(search.items.map((l: { fullName: string }) => l.fullName).sort()).toEqual(['Ayesha Khan', 'Bilal Raza']);
    const walkIns = (await as(DIRECTOR).get(`${API}/sales/leads?source=walk_in`).expect(200)).body;
    expect(walkIns.items.map((l: { fullName: string }) => l.fullName)).toEqual(['Walk-in visitor']);
    // a salesperson's list is only their own, whatever they filter by
    const hira = (await as(HIRA).get(`${API}/sales/leads?owner=${KAMRAN}`).expect(200)).body;
    expect(hira.total).toBe(0);
    await as(DIRECTOR).get(`${API}/sales/leads?source=cold_call`).expect(400);
  });

  it('shared website domains (settings, empty by default) never identify a company', async () => {
    await as(HIRA).put(`${API}/settings/modules/sales`).send({ value: { sharedWebsiteDomains: ['fiverr-test.com'] }, version: 0, reason: 'Marketplace' }).expect(403);
    const current = (await as(HIRA).get(`${API}/settings/modules/sales`).expect(200)).body;
    expect(current.value).toEqual({ sharedWebsiteDomains: [] });
    await put(DIRECTOR, `${API}/settings/modules/sales`).send({ value: { sharedWebsiteDomains: ['fiverr-test.com'] }, version: current.version, reason: 'Profiles on a marketplace say nothing about the company' }).expect(200);
    const a = await newLead(HIRA, { fullName: 'Gig One', email: 'gig1@mail-test.com', source: 'fiverr', company: { name: 'Gig One Studio', website: 'fiverr-test.com/gigone' } }).expect(201);
    const b = await newLead(KAMRAN, { fullName: 'Gig Two', email: 'gig2@mail-test.com', source: 'fiverr', company: { name: 'Gig Two Studio', website: 'https://www.fiverr-test.com/gigtwo' } }).expect(201);
    expect(a.body.company.id).not.toBe(b.body.company.id);
    expect(a.body.company).toMatchObject({ website: 'fiverr-test.com/gigone', domain: null });
    const check = (await as(SAAD).post(`${API}/sales/leads/check-duplicate`).send({ website: 'fiverr-test.com/anyone' }).expect(200)).body;
    expect(check).toMatchObject({ domain: null, sharedDomain: true, company: null });
    expect(await audit('settings.module.changed')).toHaveLength(1);
  });

  it('duplicate checks are limited per person and minute, and the refusal is logged', async () => {
    const check = () => as(SAAD).post(`${API}/sales/leads/check-duplicate`).send({ email: 'probe@nowhere-test.com' });
    t.clock.advance(61_000);
    for (let i = 0; i < SALES_DUPLICATE_CHECKS_PER_MINUTE; i++) await check().expect(200);
    const refused = await check().expect(429);
    expect(refused.body.code).toBe('rate_limited');
    await as(HIRA).post(`${API}/sales/leads/check-duplicate`).send({ email: 'probe@nowhere-test.com' }).expect(200); // per person
    expect((await audit('sales.duplicate_check.limited')).length).toBe(1);
    t.clock.advance(61_000);
    await check().expect(200);
  });

  it('leads and companies are never deleted (database rule); bad input is refused', async () => {
    await expect(prisma.salesLead.delete({ where: { id: leads.bilal.id } })).rejects.toThrow(/never deleted/);
    const company = await prisma.salesCompany.findFirstOrThrow();
    await expect(prisma.salesCompany.delete({ where: { id: company.id } })).rejects.toThrow(/never deleted/);
    await newLead(HIRA, { fullName: '', email: 'x@y.com' }).expect(400);
    await newLead(HIRA, { fullName: 'X', email: 'not-an-email' }).expect(400);
    await newLead(HIRA, { fullName: 'X', company: { name: 'Bad', website: 'http://10.0.0.1' } }).expect(400);
    await newLead(HIRA, { fullName: 'X', companyId: '00000000-0000-4000-8000-000000000000' }).expect(404);
    // the database refuses a normalised email that does not follow the email
    await expect(prisma.salesLead.update({ where: { id: leads.bilal.id }, data: { emailNormalized: 'someone@else.com' } })).rejects.toThrow();
  });
});
