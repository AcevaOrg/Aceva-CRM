import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { addDays, dbDate, pkDate, pkInstant } from '../src/common/pakistan-time';
import { OutboxConsumerRunner } from '../src/events/outbox-consumer-runner.service';
import { OffboardingService } from '../src/people/offboarding.service';
import { addMonths } from '../src/sales/deals.service';
import { LeadArchiveService } from '../src/sales/lead-archive.service';
import { SALES_OFFBOARDING_CONSUMER, SalesOffboardingService } from '../src/sales/sales-offboarding.service';
import { createTestApp, type SignedIn, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 15.5: archiving inactive leads, and a salesperson's leads and deals when they leave (plan section 20), against
 * the real database and the real Module 3 leaving step. Approved decisions 7-9.
 */
const API = '/api/v1';
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003'; // holds the sales_manager duty
const CTO = 'ACV-0004';
const HIRA = 'ACV-0009';
const KAMRAN = 'ACV-0012';
const SAAD = 'ACV-0014';

let t: TestApp;
let prisma: PrismaClient;
let runner: OutboxConsumerRunner;
let today = '';
const ids: Record<string, string> = {};

const as = (who: string) => t.as(who);
const put = (who: string, url: string) => request(t.app.getHttpServer()).put(url).set((t.as(who) as SignedIn).headers());
const inDays = (n: number) => addDays(today, n);
const night = () => t.app.get(LeadArchiveService).runNight(today);
const archive = () => t.app.get(LeadArchiveService).archiveInactive(`test:${today}`);
const monthsAgo = (m: number, ms = 0) => new Date(pkInstant(addMonths(today, -m)).getTime() + ms);
const leadRow = (id: string) => prisma.salesLead.findUniqueOrThrow({ where: { id } });
const dealRow = (id: string) => prisma.salesDeal.findUniqueOrThrow({ where: { id } });
const version = async (id: string) => (await dealRow(id)).version;

let n = 0;
/** The email each test lead was added with (archiving removes it from the lead). */
const emailOf: Record<string, string> = {};
async function newLead(who: string, over: Record<string, unknown> = {}, company?: string): Promise<string> {
  n++;
  const site = company ?? `co${n}-arch.test`;
  const body: Record<string, unknown> = { source: 'linkedin', fullName: `Person ${n}`, email: `p${n}@${site}`, phone: '+44 20 7946 0000', linkedinUrl: `https://linkedin.com/in/p${n}`, notes: 'Met at the fair', company: { name: `Company ${site}`, website: site }, ...over };
  const id = (await as(who).post(`${API}/sales/leads`).send(body).expect(201)).body.id as string;
  emailOf[id] = String(body.email);
  return id;
}
async function newDeal(who: string, leadId: string): Promise<{ id: string; number: string; version: number }> {
  return (await as(who).post(`${API}/sales/deals`).send({ leadId, service: 'website', value: '1000.00', currency: 'USD', expectedClose: inDays(30), nextStep: 'Call', nextStepDate: inDays(2) }).expect(201)).body;
}
const age = (leadId: string, at: Date) => prisma.salesLead.update({ where: { id: leadId }, data: { lastActivityAt: at } });
async function salesSettings(value: Record<string, unknown>, status = 200) {
  const current = (await as(DIRECTOR).get(`${API}/settings/modules/sales`).expect(200)).body;
  return put(DIRECTOR, `${API}/settings/modules/sales`).send({ value: { ...current.value, ...value }, version: current.version, reason: 'Sales test settings' }).expect(status);
}
/** The real Module 3 leaving step: on notice with yesterday as the last working day, processed, then the sales reader. */
async function leave(empId: string) {
  await prisma.employee.update({ where: { empId }, data: { status: 'on_notice', lastWorkingDay: dbDate(inDays(-1)) } });
  await t.app.get(OffboardingService).process(empId);
  expect((await prisma.employee.findUniqueOrThrow({ where: { empId } })).status).toBe('left');
  return runner.drain(SALES_OFFBOARDING_CONSUMER);
}

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  prisma = createTestPrisma();
  runner = t.app.get(OutboxConsumerRunner);
  today = pkDate(t.clock.now());
  for (const e of await prisma.employee.findMany({ select: { id: true, empId: true } })) ids[e.empId] = e.id;
  await runner.drain(SALES_OFFBOARDING_CONSUMER); // the sales reader starts here
  await salesSettings({ lostReasons: ['Price'], recontactMonths: 3 });
}, 180000);
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

// ============================================================================================================= archiving

describe('M15.5 archiving inactive leads', () => {
  const L: Record<string, string> = {};
  const D: Record<string, { id: string; number: string; version: number }> = {};

  beforeAll(async () => {
    L.idle = await newLead(HIRA);
    await as(HIRA).post(`${API}/sales/leads/${L.idle}/activities`).send({ kind: 'call', summary: 'First call, no interest' }).expect(201);
    L.open = await newLead(HIRA);
    D.open = await newDeal(HIRA, L.open);
    L.pending = await newLead(HIRA);
    D.pending = await newDeal(HIRA, L.pending);
    await as(HIRA).post(`${API}/sales/deals/${D.pending.id}/request-won`).send({ version: await version(D.pending.id) }).expect(200);
    L.won = await newLead(HIRA, {}, 'client-arch.test');
    D.won = await newDeal(HIRA, L.won);
    await as(HIRA).post(`${API}/sales/deals/${D.won.id}/request-won`).send({ version: await version(D.won.id) }).expect(200);
    await as(DIRECTOR).post(`${API}/sales/deals/${D.won.id}/confirm-won`).send({ version: await version(D.won.id) }).expect(200);
    L.colleague = await newLead(HIRA, { email: 'other@client-arch.test' }, 'client-arch.test'); // same client company, no deal
    L.lost = await newLead(HIRA);
    D.lost = await newDeal(HIRA, L.lost);
    await as(HIRA).post(`${API}/sales/deals/${D.lost.id}/move`).send({ toStage: 'lost', lostReason: 'Price', version: await version(D.lost.id) }).expect(200);
    L.dnc = await newLead(HIRA);
    await as(HIRA).post(`${API}/sales/leads/${L.dnc}/do-not-contact`).send({ reason: 'Unsubscribed' }).expect(200);
    L.edge = await newLead(HIRA);
    L.justOver = await newLead(HIRA);
    L.recent = await newLead(HIRA);
    L.sevenMonths = await newLead(HIRA);
    // a company already a customer in Module 13 (linked to a billing party), with no Won deal of its own here
    L.m13 = await newLead(HIRA, {}, 'm13client-arch.test');
    const party = await prisma.party.create({ data: { kind: 'client', name: 'M13 Client Ltd' } });
    await prisma.salesCompany.updateMany({ where: { domain: 'm13client-arch.test' }, data: { partyId: party.id } });
    await age(L.m13, monthsAgo(13));
    for (const k of ['idle', 'open', 'pending', 'won', 'colleague', 'lost', 'dnc']) await age(L[k], monthsAgo(13));
    await age(L.edge, monthsAgo(12)); // exactly at the cut-off: not yet
    await age(L.justOver, monthsAgo(12, -1)); // one millisecond before the cut-off
    await age(L.sevenMonths, monthsAgo(7));
  }, 180000);

  it('archives only the eligible leads; open, pending-Won, Won and client-company leads are never archived', async () => {
    const res = await archive();
    expect(res.cutoff).toBe(addMonths(today, -12));
    expect(res.archived).toBe(4); // idle, lost, dnc, justOver
    const archived = (await prisma.salesLead.findMany({ where: { id: { in: Object.values(L) }, archivedAt: { not: null } }, select: { id: true } })).map((r) => r.id).sort();
    expect(archived).toEqual([L.idle, L.lost, L.dnc, L.justOver].sort());
    for (const k of ['open', 'pending', 'won', 'colleague', 'm13', 'edge', 'recent', 'sevenMonths']) expect((await leadRow(L[k])).archivedAt, k).toBeNull();
    // the deals of the archived lost lead stay; nothing about the pending Won request changed
    expect(await dealRow(D.pending.id)).toMatchObject({ wonStatus: 'pending', stage: 'new', ownerId: ids[HIRA] });
  });

  it('clears email, phone and LinkedIn; keeps the name, notes, timeline and audit; records why, when and by which job', async () => {
    const l = await leadRow(L.idle);
    expect(l).toMatchObject({ email: null, emailNormalized: null, phone: null, linkedinUrl: null, notes: 'Met at the fair', updatedBy: null });
    expect(l.fullName).toMatch(/^Person/);
    expect(await prisma.salesActivity.count({ where: { leadId: L.idle } })).toBe(1);
    const rec = await prisma.salesLeadArchive.findFirstOrThrow({ where: { leadId: L.idle } });
    expect(rec).toMatchObject({ reason: 'inactive', inactiveMonths: 12, clearedFields: ['email', 'phone', 'linkedinUrl'], archivedBy: null, job: `test:${today}` });
    expect(await prisma.auditLog.count({ where: { action: 'sales.lead.archived', targetId: L.idle, actorId: null } })).toBe(1);
    const view = (await as(HIRA).get(`${API}/sales/leads/${L.idle}`).expect(200)).body;
    expect(view).toMatchObject({ archived: true, email: null, phone: null, linkedinUrl: null, canEdit: false, archive: { reason: 'inactive', inactiveMonths: 12, by: null, clearedFields: ['email', 'phone', 'linkedinUrl'] } });
    // archive records are insert-only
    await expect(prisma.salesLeadArchive.update({ where: { id: rec.id }, data: { reason: 'inactive', inactiveMonths: 1 } })).rejects.toThrow(/insert-only/);
    // the active list leaves archived leads out; asking for archived ones shows them to whoever sees the lead in full
    const active = (await as(HIRA).get(`${API}/sales/leads?pageSize=200`).expect(200)).body.items.map((x: { id: string }) => x.id);
    expect(active).not.toContain(L.idle);
    const arch = (await as(HIRA).get(`${API}/sales/leads?status=archived&pageSize=200`).expect(200)).body.items.map((x: { id: string }) => x.id);
    expect(arch).toContain(L.idle);
    expect((await as(KAMRAN).get(`${API}/sales/leads/${L.idle}`).expect(200)).body).toMatchObject({ restricted: true });
  });

  it('an archived lead cannot be edited, contacted, marked, moved or given a deal (also through its old deals)', async () => {
    const lead = await leadRow(L.lost);
    await as(HIRA).patch(`${API}/sales/leads/${L.lost}`).send({ notes: 'x', version: lead.version }).expect(409);
    await as(HIRA).post(`${API}/sales/leads/${L.lost}/activities`).send({ kind: 'call', summary: 'Call' }).expect(409);
    await as(HIRA).post(`${API}/sales/deals/${D.lost.id}/activities`).send({ kind: 'email_sent', summary: 'Email' }).expect(409);
    await as(HIRA).post(`${API}/sales/leads/${L.lost}/do-not-contact`).send({ reason: 'Asked' }).expect(409);
    await as(DIRECTOR).post(`${API}/sales/leads/${L.lost}/owner`).send({ toEmpId: KAMRAN, reason: 'Kamran covers it', version: lead.version }).expect(409);
    await as(HIRA).post(`${API}/sales/deals`).send({ leadId: L.lost, service: 'website', value: '10.00', currency: 'USD', expectedClose: inDays(30), nextStep: 'Call them again', nextStepDate: inDays(2) }).expect(409);
  });

  it('a do-not-contact lead is archived and stays blocked; anyone else archived can be added again as a new lead', async () => {
    expect((await leadRow(L.dnc)).email).toBeNull(); // the lead no longer has the email ...
    // ... but the list's hash still blocks it, in any case and with spaces
    const blocked = await as(KAMRAN).post(`${API}/sales/leads`).send({ source: 'apollo', fullName: 'Back again', email: ` ${emailOf[L.dnc].toUpperCase()}` }).expect(409);
    expect(blocked.body.code).toBe('do_not_contact');
    const imp = (await as(KAMRAN).post(`${API}/sales/leads/import/preview`).field('source', 'apollo').attach('file', Buffer.from(`name,email
Back,${emailOf[L.dnc]}
`), 'leads.csv').expect(201)).body;
    expect(imp.rows[0].status).toBe('dnc');
    // the idle lead (not do-not-contact) can be added again, by anyone, as a new lead
    const again = (await as(KAMRAN).post(`${API}/sales/leads`).send({ source: 'apollo', fullName: 'Back again', email: emailOf[L.idle] }).expect(201)).body;
    expect(again).toMatchObject({ owner: { empId: KAMRAN }, archived: false, email: emailOf[L.idle] });
  });

  it('Won-client exemption (approved decision 2): a lead with its own Won deal, a lead at a company with any Won deal, and a lead at a Module 13 customer are never archived, even with a 1-month period', async () => {
    await salesSettings({ archiveMonths: 1 });
    await archive();
    for (const k of ['won', 'colleague', 'm13']) expect((await leadRow(L[k])).archivedAt, k).toBeNull();
    expect(await prisma.salesLeadArchive.count({ where: { leadId: { in: [L.won, L.colleague, L.m13] } } })).toBe(0);
    await salesSettings({ archiveMonths: 12 });
  });

  it('runs again without changing anything; a shorter period set by management archives more on the next night', async () => {
    expect((await archive()).archived).toBe(0);
    await salesSettings({ archiveMonths: 6 });
    expect((await as(HIRA).get(`${API}/settings/modules/sales`).expect(200)).body.value.archiveMonths).toBe(6);
    const res = await archive();
    expect(res.cutoff).toBe(addMonths(today, -6));
    expect(res.archived).toBe(0); // the 1-month run above already archived the 7-month lead and the one at the 12-month cut-off
    expect((await leadRow(L.sevenMonths)).archivedAt).not.toBeNull();
    expect((await prisma.salesLeadArchive.findFirstOrThrow({ where: { leadId: L.sevenMonths } })).inactiveMonths).toBe(1); // the period in force when it was archived
    // only the people who change settings may change the period
    const current = (await as(HIRA).get(`${API}/settings/modules/sales`).expect(200)).body;
    await put(HIRA, `${API}/settings/modules/sales`).send({ value: { ...current.value, archiveMonths: 1 }, version: current.version, reason: 'Trying to change it' }).expect(403);
    await salesSettings({ archiveMonths: 0 }, 400);
    await salesSettings({ archiveMonths: 12 });
  });

  it('a do-not-contact lead never loses its protection: a changed email is hashed too, and an unhashed one is not archived', async () => {
    const id = await newLead(HIRA);
    await as(HIRA).post(`${API}/sales/leads/${id}/do-not-contact`).send({ reason: 'Asked by phone' }).expect(200);
    const v = (await leadRow(id)).version;
    await as(HIRA).patch(`${API}/sales/leads/${id}`).send({ email: 'changed.address@newco-arch.test', version: v }).expect(200);
    expect(await prisma.salesDncEntry.count({ where: { leadId: id } })).toBe(2);
    await age(id, monthsAgo(13));
    // a lead flagged without its email on the list (only possible by hand in the database) is left alone
    const odd = await newLead(HIRA);
    await prisma.salesLead.update({ where: { id: odd }, data: { dncAt: new Date(), lastActivityAt: monthsAgo(13) } });
    const res = await archive();
    expect(res.skipped.dnc_unprotected).toBe(1);
    expect((await leadRow(odd)).archivedAt).toBeNull();
    expect((await leadRow(id)).archivedAt).not.toBeNull();
    expect((await as(KAMRAN).post(`${API}/sales/leads`).send({ source: 'apollo', fullName: 'Changed', email: 'Changed.Address@newco-arch.test' }).expect(409)).body.code).toBe('do_not_contact');
  });

  it('a contact logged at the same moment as the night run: either the contact wins (lead kept) or the archive wins (contact refused)', async () => {
    for (let round = 0; round < 4; round++) {
      const id = await newLead(HIRA);
      await age(id, monthsAgo(13));
      const [logged] = await Promise.all([as(HIRA).post(`${API}/sales/leads/${id}/activities`).send({ kind: 'call', summary: `Race ${round}` }), archive()]);
      const l = await leadRow(id);
      if (logged.status === 201) expect(l.archivedAt).toBeNull();
      else {
        expect(logged.status).toBe(409);
        expect(l.archivedAt).not.toBeNull();
        expect(await prisma.salesActivity.count({ where: { leadId: id } })).toBe(0);
      }
    }
  });
});

// ============================================================================================================== leaving

describe('M15.5 a salesperson leaves (Module 3) — leads and deals move to the sales manager', () => {
  const L: Record<string, string> = {};
  const D: Record<string, { id: string; number: string; version: number }> = {};

  beforeAll(async () => {
    L.plain = await newLead(SAAD);
    L.open = await newLead(SAAD);
    D.open = await newDeal(SAAD, L.open);
    L.pending = await newLead(SAAD);
    D.pending = await newDeal(SAAD, L.pending);
    await as(SAAD).post(`${API}/sales/deals/${D.pending.id}/request-won`).send({ version: await version(D.pending.id) }).expect(200);
    L.won = await newLead(SAAD);
    D.won = await newDeal(SAAD, L.won);
    await as(SAAD).post(`${API}/sales/deals/${D.won.id}/request-won`).send({ version: await version(D.won.id) }).expect(200);
    await as(DIRECTOR).post(`${API}/sales/deals/${D.won.id}/confirm-won`).send({ version: await version(D.won.id) }).expect(200);
    L.lost = await newLead(SAAD);
    D.lost = await newDeal(SAAD, L.lost);
    await as(SAAD).post(`${API}/sales/deals/${D.lost.id}/move`).send({ toStage: 'lost', lostReason: 'Price', version: await version(D.lost.id) }).expect(200);
    L.archived = await newLead(SAAD);
    await prisma.salesLead.update({ where: { id: L.archived }, data: { archivedAt: new Date() } });
  }, 180000);

  it('the active leads and open deals (a pending Won request included, kept as it is) move to the one sales manager; final deals stay', async () => {
    const pendingBefore = await dealRow(D.pending.id);
    const historyBefore = await prisma.salesDealHistory.count({ where: { dealId: D.pending.id } });
    await leave(SAAD);
    for (const k of ['plain', 'open', 'pending', 'won', 'lost']) expect((await leadRow(L[k])).ownerId, k).toBe(ids[DIRECTOR]);
    expect((await leadRow(L.archived)).ownerId).toBe(ids[SAAD]); // archived leads are not moved
    expect((await dealRow(D.open.id)).ownerId).toBe(ids[DIRECTOR]);
    const pending = await dealRow(D.pending.id);
    expect(pending).toMatchObject({ ownerId: ids[DIRECTOR], stage: pendingBefore.stage, wonStatus: 'pending', wonRequestedById: ids[SAAD], version: pendingBefore.version + 1 });
    expect(pending.wonRequestedAt).toEqual(pendingBefore.wonRequestedAt);
    const history = await prisma.salesDealHistory.findMany({ where: { dealId: D.pending.id }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    expect(history).toHaveLength(historyBefore + 1);
    expect(history.at(-1)).toMatchObject({ event: 'owner_changed', actorId: null, reason: 'employee_left', note: `${SAAD} to ${DIRECTOR} (left the company)` });
    expect((await dealRow(D.won.id)).ownerId).toBe(ids[SAAD]); // Won and Lost are final
    expect((await dealRow(D.lost.id)).ownerId).toBe(ids[SAAD]);
    const summary = await prisma.auditLog.findMany({ where: { action: 'sales.offboarding.reassigned', targetId: SAAD } });
    expect(summary).toHaveLength(1);
    expect(summary[0]).toMatchObject({ actorId: null, reason: 'employee_left', details: expect.objectContaining({ to: DIRECTOR, rule: 'sales_manager_duty', leads: 5, pendingWon: [D.pending.number] }) });
    expect([...(summary[0].details as { deals: string[] }).deals].sort()).toEqual([D.open.number, D.pending.number].sort());
    expect(await prisma.auditLog.count({ where: { action: 'sales.lead.reassigned', reason: 'employee_left' } })).toBe(5);
  });

  it('the B1 rule is unchanged for the moved pending deal: the Director now owns it, so only the CEO / Owner confirms it', async () => {
    await as(DIRECTOR).post(`${API}/sales/deals/${D.pending.id}/confirm-won`).send({ version: await version(D.pending.id) }).expect(403);
    await as(OWNER).post(`${API}/sales/deals/${D.pending.id}/confirm-won`).send({ version: await version(D.pending.id) }).expect(200);
    expect(await dealRow(D.pending.id)).toMatchObject({ stage: 'won', wonStatus: 'confirmed', ownerId: ids[DIRECTOR], wonRequestedById: ids[SAAD] });
  });

  it('the same event delivered again, the nightly check, or both at the same moment move nothing twice', async () => {
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { type: 'employee.offboarded', payload: { path: ['empId'], equals: SAAD } } });
    const service = t.app.get(SalesOffboardingService);
    const before = await prisma.salesDealHistory.count();
    await Promise.all([
      prisma.$transaction((tx) => service.onOffboarded(event as never, tx)),
      service.sweep('test-sweep'),
      prisma.$transaction((tx) => service.onOffboarded(event as never, tx)),
    ]);
    expect(await prisma.salesDealHistory.count()).toBe(before);
    expect(await prisma.auditLog.count({ where: { action: 'sales.offboarding.reassigned', targetId: SAAD } })).toBe(1);
  });

  it('nobody to receive them (no single sales manager, manager cannot own leads): nothing moves, management sees the case', async () => {
    const k1 = await newLead(KAMRAN);
    const kd = await newDeal(KAMRAN, k1);
    const kamranLeads = await prisma.salesLead.count({ where: { ownerId: ids[KAMRAN], archivedAt: null } });
    // no sales manager (the Director's duty ends) and Kamran's manager is the CTO, who does not work on sales leads
    const duty = await prisma.duty.findUniqueOrThrow({ where: { key: 'sales_manager' } });
    await prisma.employeeDuty.updateMany({ where: { dutyId: duty.id, endedAt: null }, data: { endedAt: new Date() } });
    await prisma.employee.update({ where: { empId: KAMRAN }, data: { reportsToId: ids[CTO] } });
    await leave(KAMRAN);
    expect((await leadRow(k1)).ownerId).toBe(ids[KAMRAN]);
    expect((await dealRow(kd.id)).ownerId).toBe(ids[KAMRAN]);
    const issues = (await as(DIRECTOR).get(`${API}/sales/reassignment-issues`).expect(200)).body;
    expect(issues).toEqual([expect.objectContaining({ employee: { empId: KAMRAN, name: expect.any(String) }, reason: 'no_recipient', openLeads: kamranLeads, openDeals: 1 })]);
    expect(issues[0].detail).toMatch(/Nobody holds the sales manager duty.*ACV-0004 does not manage sales leads/);
    expect(await prisma.auditLog.count({ where: { action: 'sales.offboarding.no_recipient', targetId: KAMRAN } })).toBe(1);
    // the CEO / Owner sees it too; a salesperson does not; the night run does not open a second case
    await as(OWNER).get(`${API}/sales/reassignment-issues`).expect(200);
    await as(HIRA).get(`${API}/sales/reassignment-issues`).expect(403);
    await night();
    expect(await prisma.salesReassignmentIssue.count({ where: { employeeId: ids[KAMRAN] } })).toBe(1);
    // management gives the duty back: the next night moves everything and closes the case
    await prisma.employeeDuty.create({ data: { employeeId: ids[DIRECTOR], dutyId: duty.id } });
    const res = await night();
    expect(res.leavers).toMatchObject({ moved: 1 });
    expect((await leadRow(k1)).ownerId).toBe(ids[DIRECTOR]);
    expect((await dealRow(kd.id)).ownerId).toBe(ids[DIRECTOR]);
    expect(await prisma.salesReassignmentIssue.findFirstOrThrow({ where: { employeeId: ids[KAMRAN] } })).toMatchObject({ resolvedToId: ids[DIRECTOR] });
    expect((await as(DIRECTOR).get(`${API}/sales/reassignment-issues`).expect(200)).body).toEqual([]);
    // a closed case never changes again
    const issue = await prisma.salesReassignmentIssue.findFirstOrThrow({ where: { employeeId: ids[KAMRAN] } });
    await expect(prisma.salesReassignmentIssue.update({ where: { id: issue.id }, data: { resolvedAt: new Date() } })).rejects.toThrow(/reassignment_issue_final/);
  });

  it('two people hold the sales manager duty: the leaver’s manager receives them, if active and working on sales', async () => {
    const h1 = await newLead(HIRA);
    const duty = await prisma.duty.findUniqueOrThrow({ where: { key: 'sales_manager' } });
    await prisma.employeeDuty.create({ data: { employeeId: ids[CTO], dutyId: duty.id } }); // a second holder
    await leave(HIRA);
    expect((await leadRow(h1)).ownerId).toBe(ids[DIRECTOR]); // Hira reports to the Director
    const summary = await prisma.auditLog.findFirstOrThrow({ where: { action: 'sales.offboarding.reassigned', targetId: HIRA } });
    expect(summary.details).toMatchObject({ rule: 'leaver_manager', to: DIRECTOR });
    // Hira's archived leads (from the archiving tests) stayed hers
    expect(await prisma.salesLead.count({ where: { ownerId: ids[HIRA], archivedAt: null } })).toBe(0);
  });

  it('the Director leaves and their manager is the CEO / Owner: the Owner never receives the leads; the case stays open until a valid sales manager exists', async () => {
    // a deal the Director owns and asked to mark Won (B1: only the CEO / Owner may confirm a Director's deal)
    const dl = await newLead(DIRECTOR);
    const dd = await newDeal(DIRECTOR, dl);
    await as(DIRECTOR).post(`${API}/sales/deals/${dd.id}/request-won`).send({ version: await version(dd.id) }).expect(200);
    const pendingBefore = await dealRow(dd.id);
    const historyBefore = await prisma.salesDealHistory.count({ where: { dealId: dd.id } });
    // nobody else holds the sales manager duty (the second holder above gives it back); the Director's own ends as they leave
    const duty = await prisma.duty.findUniqueOrThrow({ where: { key: 'sales_manager' } });
    await prisma.employeeDuty.updateMany({ where: { dutyId: duty.id, employeeId: ids[CTO], endedAt: null }, data: { endedAt: new Date() } });
    const directorLeads = await prisma.salesLead.count({ where: { ownerId: ids[DIRECTOR], archivedAt: null } });
    const directorDeals = await prisma.salesDeal.count({ where: { ownerId: ids[DIRECTOR], archivedAt: null, stage: { notIn: ['won', 'lost'] } } });
    expect(directorLeads).toBeGreaterThan(1);
    await leave(DIRECTOR); // the event names the Director's manager: the CEO / Owner

    // the Owner receives nothing; nothing moves; a case is open for management
    expect(await prisma.salesLead.count({ where: { ownerId: ids[OWNER] } })).toBe(0);
    expect(await prisma.salesDeal.count({ where: { ownerId: ids[OWNER] } })).toBe(0);
    expect(await prisma.salesLead.count({ where: { ownerId: ids[DIRECTOR], archivedAt: null } })).toBe(directorLeads);
    const issue = await prisma.salesReassignmentIssue.findFirstOrThrow({ where: { employeeId: ids[DIRECTOR], resolvedAt: null } });
    expect((issue.details as { detail: string }).detail).toMatch(/Nobody holds the sales manager duty.*ACV-0001 is the CEO \/ Owner, who only views sales/);
    expect((await as(OWNER).get(`${API}/sales/reassignment-issues`).expect(200)).body).toEqual([
      expect.objectContaining({ employee: expect.objectContaining({ empId: DIRECTOR }), reason: 'no_recipient', openLeads: directorLeads, openDeals: directorDeals }),
    ]);
    // the night run keeps the one case open and still gives the Owner nothing; the pending request is untouched
    await night();
    expect(await prisma.salesReassignmentIssue.count({ where: { employeeId: ids[DIRECTOR] } })).toBe(1);
    expect((await prisma.salesReassignmentIssue.findFirstOrThrow({ where: { employeeId: ids[DIRECTOR] } })).resolvedAt).toBeNull();
    expect(await prisma.salesLead.count({ where: { ownerId: ids[OWNER] } })).toBe(0);
    expect(await dealRow(dd.id)).toMatchObject({ ownerId: ids[DIRECTOR], wonStatus: 'pending', wonRequestedById: ids[DIRECTOR], version: pendingBefore.version });

    // a valid sales manager becomes available: the next night moves everything to them and closes the case
    await prisma.employeeDuty.create({ data: { employeeId: ids[CTO], dutyId: duty.id } });
    const res = await night();
    expect(res.leavers.moved).toBeGreaterThanOrEqual(1);
    expect(await prisma.salesLead.count({ where: { ownerId: ids[DIRECTOR], archivedAt: null } })).toBe(0);
    expect(await prisma.salesLead.count({ where: { ownerId: ids[CTO], archivedAt: null } })).toBe(directorLeads);
    expect(await prisma.salesLead.count({ where: { ownerId: ids[OWNER] } })).toBe(0);
    expect(await prisma.salesReassignmentIssue.findFirstOrThrow({ where: { employeeId: ids[DIRECTOR] } })).toMatchObject({ resolvedToId: ids[CTO] });
    expect((await as(OWNER).get(`${API}/sales/reassignment-issues`).expect(200)).body).toEqual([]);
    const summary = await prisma.auditLog.findFirstOrThrow({ where: { action: 'sales.offboarding.reassigned', targetId: DIRECTOR } });
    expect(summary.details).toMatchObject({ to: CTO, rule: 'sales_manager_duty', pendingWon: expect.arrayContaining([dd.number]) });

    // the pending Won request moved exactly as it was (stage, requester, time, history), and B1 itself is unchanged:
    // the CEO / Owner confirms only a deal a Director owns, and nobody confirms their own deal
    const moved = await dealRow(dd.id);
    expect(moved).toMatchObject({ ownerId: ids[CTO], stage: pendingBefore.stage, wonStatus: 'pending', wonRequestedById: ids[DIRECTOR] });
    expect(moved.wonRequestedAt).toEqual(pendingBefore.wonRequestedAt);
    expect(await prisma.salesDealHistory.count({ where: { dealId: dd.id } })).toBe(historyBefore + 1);
    expect((await as(OWNER).post(`${API}/sales/deals/${dd.id}/confirm-won`).send({ version: moved.version }).expect(403)).body.code).toBe('owner_confirms_director_deals_only');
    await as(CTO).post(`${API}/sales/deals/${dd.id}/confirm-won`).send({ version: moved.version }).expect(403);
    expect(await dealRow(dd.id)).toMatchObject({ wonStatus: 'pending', stage: pendingBefore.stage });
  });
});
