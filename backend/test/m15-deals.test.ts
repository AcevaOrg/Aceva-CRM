import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { outboxEventSchema, SALES_DEAL_SERVICE_LABEL } from '@aceva/contracts';
import type { PrismaClient } from '../src/generated/prisma/client';
import { BILLING_CONSUMER } from '../src/billing/billing-events.consumer';
import { pkDate } from '../src/common/pakistan-time';
import { OutboxConsumerRunner } from '../src/events/outbox-consumer-runner.service';
import { OutboxService } from '../src/events/outbox.service';
import { addMonths } from '../src/sales/deals.service';
import { createTestApp, type SignedIn, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 15.2: deals and the pipeline (plan section 20), against the real database, with Module 13's billing reader.
 * Eight stages; Won and Lost are final; every open deal has a next step with a date; Lost needs a reason from the
 * settings and gets a re-contact date; Won is asked for and confirmed by the sales manager, never by the owner or the
 * person who asked; the confirmation hands the deal to Module 13 (one draft invoice, however often the event arrives).
 */
const API = '/api/v1';
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const DEV = 'ACV-0006';
const HIRA = 'ACV-0009';
const FINANCE = 'ACV-0010';
const KAMRAN = 'ACV-0012';
const SAAD = 'ACV-0014';

let t: TestApp;
let prisma: PrismaClient;
let runner: OutboxConsumerRunner;
const lead: Record<string, string> = {};
const deal: Record<string, { id: string; number: string; version: number }> = {};
let today = '';

const as = (who: string) => t.as(who);
const put = (who: string, url: string) => request(t.app.getHttpServer()).put(url).set((t.as(who) as SignedIn).headers());
const audit = (action: string, targetId?: string) => prisma.auditLog.findMany({ where: { action, ...(targetId ? { targetId } : {}) }, orderBy: { occurredAt: 'asc' } });
const events = () => prisma.outboxEvent.findMany({ where: { type: 'sales.deal.won_confirmed' }, orderBy: { createdAt: 'asc' } });
const history = (dealId: string) => prisma.salesDealHistory.findMany({ where: { dealId }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
const inDays = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function newDeal(who: string, leadId: string, over: Record<string, unknown> = {}) {
  return as(who)
    .post(`${API}/sales/deals`)
    .send({ leadId, service: 'website', value: '250000.00', currency: 'PKR', expectedClose: inDays(30), nextStep: 'Send the proposal', nextStepDate: inDays(2), ...over });
}
const keep = (key: string, body: { id: string; number: string; version: number }) => {
  deal[key] = { id: body.id, number: body.number, version: body.version };
};

async function salesSettings(value: Record<string, unknown>) {
  const current = (await as(DIRECTOR).get(`${API}/settings/modules/sales`).expect(200)).body;
  return put(DIRECTOR, `${API}/settings/modules/sales`).send({ value: { ...current.value, ...value }, version: current.version, reason: 'Sales test settings' });
}

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  prisma = createTestPrisma();
  runner = t.app.get(OutboxConsumerRunner);
  today = pkDate(t.clock.now());
  await runner.drain(BILLING_CONSUMER); // the billing reader starts here
  const mk = async (who: string, body: Record<string, unknown>) => (await as(who).post(`${API}/sales/leads`).send({ source: 'linkedin', ...body }).expect(201)).body.id as string;
  lead.hira = await mk(HIRA, { fullName: 'Ayesha Khan', email: 'ayesha@northwind-deals.test', company: { name: 'Northwind Deals', website: 'northwind-deals.test', country: 'United Kingdom' } });
  lead.hira2 = await mk(HIRA, { fullName: 'Omar Farooq', email: 'omar@contoso-deals.test', company: { name: 'Contoso Deals', website: 'contoso-deals.test' } });
  lead.kamran = await mk(KAMRAN, { fullName: 'Lena Park', email: 'lena@fabrikam-deals.test', company: { name: 'Fabrikam Deals', website: 'fabrikam-deals.test' } });
  lead.noCompany = await mk(HIRA, { fullName: 'Walk-in visitor', email: 'walkin@nowhere-deals.test', source: 'walk_in' });
  lead.director = await mk(DIRECTOR, { fullName: 'Director prospect', email: 'boss@initech-deals.test', company: { name: 'Initech Deals', website: 'initech-deals.test' } });
}, 180000);
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M15.2 access', () => {
  it('people without sales.own have no access to deals: Finance, the CTO, developers', async () => {
    for (const who of [FINANCE, CTO, DEV]) {
      await as(who).get(`${API}/sales/deals`).expect(403);
      await as(who).get(`${API}/sales/deals/summary`).expect(403);
      await newDeal(who, lead.hira).expect(403);
    }
    for (const who of [HIRA, DIRECTOR, OWNER]) await as(who).get(`${API}/sales/deals`).expect(200);
  });
});

describe('M15.2 deals', () => {
  it('the owner adds a deal for their lead: it starts in New, numbered, with a next step; logged and in the history', async () => {
    const res = await newDeal(HIRA, lead.hira).expect(201);
    expect(res.body).toMatchObject({
      restricted: false,
      number: expect.stringMatching(/^DL-\d{4}-\d{4}$/),
      stage: 'new',
      owner: { empId: HIRA },
      company: { name: 'Northwind Deals' },
      leadName: 'Ayesha Khan',
      service: 'website',
      value: '250000.00',
      currency: 'PKR',
      nextStep: 'Send the proposal',
      nextStepDate: inDays(2),
      wonStatus: 'none',
      version: 1,
      canEdit: true,
      canDecideWon: false,
      handover: null,
    });
    expect(res.body.history).toEqual([expect.objectContaining({ event: 'created', fromStage: null, toStage: 'new', by: expect.objectContaining({ empId: HIRA }) })]);
    keep('a', res.body);
    expect(await audit('sales.deal.created', res.body.number)).toHaveLength(1);
  });

  it('a deal needs a company, a next step date that is not in the past, and the lead in the caller’s hands', async () => {
    expect((await newDeal(HIRA, lead.noCompany).expect(400)).body.code).toBe('lead_needs_company');
    expect((await newDeal(HIRA, lead.hira2, { nextStepDate: inDays(-1) }).expect(400)).body.code).toBe('next_step_in_past');
    await newDeal(HIRA, lead.hira2, { nextStep: '' }).expect(400);
    await newDeal(HIRA, lead.hira2, { value: '-5' }).expect(400);
    await newDeal(KAMRAN, lead.hira).expect(403); // not his lead
    await newDeal(OWNER, lead.hira).expect(403); // the CEO / Owner only views
    // the sales manager adds a deal for a team member's lead; the owner is the lead's owner
    const res = await newDeal(DIRECTOR, lead.hira2, { service: 'mobile_app', value: '1200.00', currency: 'USD' }).expect(201);
    expect(res.body.owner.empId).toBe(HIRA);
    keep('b', res.body);
    keep('k', (await newDeal(KAMRAN, lead.kamran, { service: 'ai_automation' }).expect(201)).body);
  });

  it("another salesperson sees only that the deal exists and who owns it; the Director and the CEO see it in full", async () => {
    const stub = (await as(KAMRAN).get(`${API}/sales/deals/${deal.a.id}`).expect(200)).body;
    expect(stub).toEqual({ restricted: true, id: deal.a.id, number: deal.a.number, companyName: 'Northwind Deals', owner: { empId: HIRA, name: expect.any(String) } });
    expect((await as(KAMRAN).get(`${API}/sales/deals`).expect(200)).body.items.map((d: { number: string }) => d.number)).toEqual([deal.k.number]);
    expect((await as(DIRECTOR).get(`${API}/sales/deals/${deal.a.number}`).expect(200)).body).toMatchObject({ restricted: false, value: '250000.00', canEdit: true });
    expect((await as(OWNER).get(`${API}/sales/deals/${deal.a.id}`).expect(200)).body).toMatchObject({ restricted: false, canEdit: false });
    await as(HIRA).get(`${API}/sales/deals/DL-1999-0001`).expect(404);
  });

  it('editing names the version read; others cannot edit', async () => {
    const res = (await as(HIRA).patch(`${API}/sales/deals/${deal.a.id}`).send({ value: '275000.00', nextStep: 'Call about the scope', version: 1 }).expect(200)).body;
    expect(res).toMatchObject({ value: '275000.00', nextStep: 'Call about the scope', version: 2 });
    deal.a.version = 2;
    expect((await as(HIRA).patch(`${API}/sales/deals/${deal.a.id}`).send({ value: '1.00', version: 1 }).expect(409)).body.code).toBe('stale_version');
    await as(KAMRAN).patch(`${API}/sales/deals/${deal.a.id}`).send({ value: '1.00', version: 2 }).expect(403);
    const [log] = await audit('sales.deal.updated', deal.a.number);
    expect(log.details).toMatchObject({ before: { value: '250000.00' }, after: { value: '275000.00' } });
  });

  it('stages: open stages move freely and each move is in the history; Won is never a move', async () => {
    let res = (await as(HIRA).post(`${API}/sales/deals/${deal.a.id}/move`).send({ toStage: 'contacted', version: 2 }).expect(200)).body;
    expect(res).toMatchObject({ stage: 'contacted', version: 3 });
    res = (await as(HIRA).post(`${API}/sales/deals/${deal.a.id}/move`).send({ toStage: 'proposal_sent', nextStep: 'Wait for feedback', nextStepDate: inDays(5), version: 3 }).expect(200)).body;
    expect(res).toMatchObject({ stage: 'proposal_sent', nextStep: 'Wait for feedback', nextStepDate: inDays(5), version: 4 });
    res = (await as(HIRA).post(`${API}/sales/deals/${deal.a.id}/move`).send({ toStage: 'negotiation', version: 4 }).expect(200)).body;
    deal.a.version = res.version;
    expect(res.history.map((h: { event: string; fromStage: string | null; toStage: string }) => [h.event, h.fromStage, h.toStage])).toEqual([
      ['created', null, 'new'],
      ['stage_changed', 'new', 'contacted'],
      ['stage_changed', 'contacted', 'proposal_sent'],
      ['stage_changed', 'proposal_sent', 'negotiation'],
    ]);
    expect((await as(HIRA).post(`${API}/sales/deals/${deal.a.id}/move`).send({ toStage: 'negotiation', version: deal.a.version }).expect(409)).body.code).toBe('same_stage');
    await as(HIRA).post(`${API}/sales/deals/${deal.a.id}/move`).send({ toStage: 'won', version: deal.a.version }).expect(400);
    await as(HIRA).post(`${API}/sales/deals/${deal.a.id}/move`).send({ toStage: 'replied', nextStepDate: inDays(-3), version: deal.a.version }).expect(400);
  });

  it('two moves of the same version at the same moment: one wins, the other is told to reload', async () => {
    const v = deal.b.version;
    const results = await Promise.all([
      as(HIRA).post(`${API}/sales/deals/${deal.b.id}/move`).send({ toStage: 'contacted', version: v }),
      as(DIRECTOR).post(`${API}/sales/deals/${deal.b.id}/move`).send({ toStage: 'replied', version: v }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await history(deal.b.id)).filter((h) => h.event === 'stage_changed')).toHaveLength(1);
    deal.b.version = (await prisma.salesDeal.findUniqueOrThrow({ where: { id: deal.b.id } })).version;
  });
});

describe('M15.2 Lost: a reason from the settings and a re-contact date', () => {
  it('nothing can be marked Lost until management sets the reasons and the re-contact period', async () => {
    const res = await as(HIRA).post(`${API}/sales/deals/${deal.b.id}/move`).send({ toStage: 'lost', lostReason: 'Price', version: deal.b.version }).expect(409);
    expect(res.body.code).toBe('sales_rules_missing');
    await as(HIRA).post(`${API}/sales/deals/${deal.b.id}/move`).send({ toStage: 'lost', version: deal.b.version }).expect(400); // a reason is required
    const settings = (await as(HIRA).get(`${API}/settings/modules/sales`).expect(200)).body.value;
    expect(settings).toMatchObject({ lostReasons: [], recontactMonths: null });
    // only the Director changes the settings
    await put(HIRA, `${API}/settings/modules/sales`).send({ value: { ...settings, lostReasons: ['Price'], recontactMonths: 3 }, version: 0, reason: 'Not mine to set' }).expect(403);
    const saved = await salesSettings({ lostReasons: ['Price', 'No reply', 'Chose another company'], recontactMonths: 6 });
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
  });

  it('a reason that is not on the list is refused; Lost records the reason, the note and the re-contact date', async () => {
    expect((await as(HIRA).post(`${API}/sales/deals/${deal.b.id}/move`).send({ toStage: 'lost', lostReason: 'Bad vibes', version: deal.b.version }).expect(400)).body.code).toBe('unknown_lost_reason');
    const res = (await as(HIRA).post(`${API}/sales/deals/${deal.b.id}/move`).send({ toStage: 'lost', lostReason: 'chose ANOTHER company', note: 'Went with a local agency', version: deal.b.version }).expect(200)).body;
    expect(res).toMatchObject({ stage: 'lost', lostReason: 'Chose another company', lostNote: 'Went with a local agency', recontactAfter: addMonths(today, 6), nextStep: null, canEdit: false });
    expect(res.closedAt).not.toBeNull();
    expect(res.history.at(-1)).toMatchObject({ event: 'stage_changed', toStage: 'lost', reason: 'Chose another company', note: 'Went with a local agency' });
    deal.b.version = res.version;
  });

  it('Lost is final; a new deal for the lead waits for the re-contact date; the database refuses changes to a closed deal', async () => {
    expect((await as(HIRA).post(`${API}/sales/deals/${deal.b.id}/move`).send({ toStage: 'contacted', version: deal.b.version }).expect(409)).body.code).toBe('deal_closed');
    expect((await as(HIRA).patch(`${API}/sales/deals/${deal.b.id}`).send({ value: '1.00', version: deal.b.version }).expect(409)).body.code).toBe('deal_closed');
    expect((await as(HIRA).post(`${API}/sales/deals/${deal.b.id}/request-won`).send({ version: deal.b.version }).expect(409)).body.code).toBe('deal_closed');
    const again = await newDeal(HIRA, lead.hira2).expect(409);
    expect(again.body).toMatchObject({ code: 'recontact_later', recontactAfter: addMonths(today, 6) });
    await expect(prisma.salesDeal.update({ where: { id: deal.b.id }, data: { stage: 'negotiation', nextStep: 'x step', nextStepDate: new Date() } })).rejects.toThrow(/final/);
  });
});

describe('M15.2 Won: asked for, confirmed by the sales manager, handed to Module 13', () => {
  it('the owner marks the deal Won: it waits; it cannot be changed meanwhile; nobody else may decide but the sales manager', async () => {
    const res = (await as(HIRA).post(`${API}/sales/deals/${deal.a.id}/request-won`).send({ version: deal.a.version }).expect(200)).body;
    expect(res).toMatchObject({ stage: 'negotiation', wonStatus: 'pending', wonRequestedBy: { empId: HIRA }, canEdit: false, canDecideWon: false });
    deal.a.version = res.version;
    expect(res.history.at(-1)).toMatchObject({ event: 'won_requested', toStage: 'negotiation' });
    expect((await as(HIRA).patch(`${API}/sales/deals/${deal.a.id}`).send({ value: '1.00', version: deal.a.version }).expect(409)).body.code).toBe('won_pending');
    expect((await as(HIRA).post(`${API}/sales/deals/${deal.a.id}/request-won`).send({ version: deal.a.version }).expect(409)).body.code).toBe('won_pending');
    // the owner cannot confirm (not the sales manager, and it is their own deal); the CEO / Owner and other salespeople cannot either
    for (const who of [HIRA, KAMRAN, OWNER]) await as(who).post(`${API}/sales/deals/${deal.a.id}/confirm-won`).send({ version: deal.a.version }).expect(403);
    expect((await as(DIRECTOR).get(`${API}/sales/deals/${deal.a.id}`).expect(200)).body.canDecideWon).toBe(true);
    expect(await events()).toHaveLength(0);
  });

  it('nobody confirms a request they made themselves: the sales manager who asked on someone’s behalf cannot confirm it', async () => {
    const res = (await as(DIRECTOR).post(`${API}/sales/deals/${deal.k.id}/request-won`).send({ version: deal.k.version }).expect(200)).body;
    deal.k.version = res.version;
    expect(res.canDecideWon).toBe(false);
    expect((await as(DIRECTOR).post(`${API}/sales/deals/${deal.k.id}/confirm-won`).send({ version: deal.k.version }).expect(403)).body.code).toBe('self_approval');
    // ...so the request goes back (by the same rule nobody else in this company may confirm it either); a reason is required
    await as(DIRECTOR).post(`${API}/sales/deals/${deal.k.id}/reject-won`).send({ reason: 'no', version: deal.k.version }).expect(400);
  });

  it('the database itself refuses a deal confirmed by its owner', async () => {
    const hira = await prisma.employee.findUniqueOrThrow({ where: { empId: HIRA } });
    await expect(
      prisma.salesDeal.update({ where: { id: deal.a.id }, data: { stage: 'won', wonStatus: 'confirmed', wonConfirmedById: hira.id, wonConfirmedAt: new Date(), closedAt: new Date() } }),
    ).rejects.toThrow(/sales_deals_no_self_confirmation/);
  });

  it('the Won request is in the sales manager’s approvals inbox, and counted as routed up for the person who asked', async () => {
    const inbox = (await as(DIRECTOR).get(`${API}/approvals`).expect(200)).body;
    const item = inbox.items.find((i: { type: string; refId: string }) => i.type === 'won_deal' && i.refId === deal.a.id);
    expect(item).toMatchObject({ id: `won_deal:${deal.a.id}`, refNumber: deal.a.number, requester: HIRA, title: 'Won: Northwind Deals', approveLabel: 'Confirm Won' });
    // the Director's own request (deal k) is not his to decide, so it is not in his inbox
    expect(inbox.items.some((i: { refId: string }) => i.refId === deal.k.id)).toBe(false);
    expect((await as(HIRA).get(`${API}/approvals`).expect(200)).body.routedUp).toBeGreaterThanOrEqual(1);
    expect((await as(HIRA).get(`${API}/approvals`).expect(200)).body.items.some((i: { type: string }) => i.type === 'won_deal')).toBe(false);
  });

  it('two confirmations at the same moment: exactly one confirms and exactly one event goes to Module 13', async () => {
    const entriesBefore = await prisma.journalEntry.count();
    const results = await Promise.all([
      as(DIRECTOR).post(`${API}/sales/deals/${deal.a.id}/confirm-won`).send({ version: deal.a.version }),
      as(DIRECTOR).post(`${API}/sales/deals/${deal.a.id}/confirm-won`).send({ version: deal.a.version }),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 409]);
    const ok = results.find((r) => r.status === 200)!.body;
    expect(ok).toMatchObject({ stage: 'won', wonStatus: 'confirmed', wonConfirmedBy: { empId: DIRECTOR }, canEdit: false });
    expect(ok.history.at(-1)).toMatchObject({ event: 'won_confirmed', fromStage: 'negotiation', toStage: 'won', by: { empId: DIRECTOR } });
    const sent = await events();
    expect(sent).toHaveLength(1);
    // the exact payload Module 13 expects (the contract is validated when it is written, and again here)
    expect(outboxEventSchema.safeParse({ id: sent[0].id, type: sent[0].type, version: sent[0].version, occurredAt: sent[0].occurredAt.toISOString(), actor: sent[0].actor, payload: sent[0].payload }).success).toBe(true);
    expect(sent[0].payload).toEqual({
      dealNumber: deal.a.number,
      ownerEmpId: HIRA,
      confirmedByEmpId: DIRECTOR,
      client: { partyId: null, name: 'Northwind Deals', email: 'ayesha@northwind-deals.test', country: 'United Kingdom' },
      service: SALES_DEAL_SERVICE_LABEL.website,
      value: '275000.00',
      currency: 'PKR',
    });
    expect(await audit('sales.deal.won_confirmed', deal.a.number)).toHaveLength(1);
    expect(await prisma.journalEntry.count()).toBe(entriesBefore); // Module 15 writes no ledger entry
    deal.a.version = ok.version;
  });

  it('Module 13 makes exactly one draft invoice from it, and a repeated event makes nothing more', async () => {
    await runner.drain(BILLING_CONSUMER);
    const drafts = await prisma.invoice.findMany({ where: { sourceDealNumber: deal.a.number } });
    expect(drafts).toHaveLength(1);
    expect(drafts[0]).toMatchObject({ status: 'draft', currency: 'PKR', journalEntryId: null });
    expect(drafts[0].total.toFixed(2)).toBe('275000.00');
    const handover = await prisma.dealHandover.findUniqueOrThrow({ where: { dealNumber: deal.a.number } });
    expect(handover).toMatchObject({ status: 'drafted', invoiceId: drafts[0].id });
    // the deal page shows the handover
    expect((await as(HIRA).get(`${API}/sales/deals/${deal.a.id}`).expect(200)).body.handover).toEqual({ status: 'drafted', invoiceId: drafts[0].id });
    // the reader handles an event once; and the same deal sent again (a second event) is recognised by its number
    await runner.drain(BILLING_CONSUMER);
    const [first] = await events();
    await t.app.get(OutboxService).emit({ type: 'sales.deal.won_confirmed', actor: DIRECTOR, payload: first.payload as never });
    await runner.drain(BILLING_CONSUMER);
    expect(await prisma.invoice.count({ where: { sourceDealNumber: deal.a.number } })).toBe(1);
    expect(await prisma.dealHandover.count({ where: { dealNumber: deal.a.number } })).toBe(1);
  });

  it('Won is final: nothing changes after it, and the database refuses a change to the outcome', async () => {
    expect((await as(DIRECTOR).post(`${API}/sales/deals/${deal.a.id}/move`).send({ toStage: 'lost', lostReason: 'Price', version: deal.a.version }).expect(409)).body.code).toBe('deal_closed');
    expect((await as(DIRECTOR).post(`${API}/sales/deals/${deal.a.id}/confirm-won`).send({ version: deal.a.version }).expect(409)).body.code).toBe('not_pending');
    await expect(prisma.salesDeal.update({ where: { id: deal.a.id }, data: { value: '1.00' } })).rejects.toThrow(/final/);
  });

  it('the sales manager sends a Won request back with a reason; the deal stays open in its stage', async () => {
    const k = (await prisma.salesDeal.findUniqueOrThrow({ where: { id: deal.k.id } })).version;
    // the Director asked for deal k himself (above): taking his own request back is allowed, only a confirmation is not
    const res = (await as(DIRECTOR).post(`${API}/sales/deals/${deal.k.id}/reject-won`).send({ reason: 'Asked on the wrong deal', version: k }).expect(200)).body;
    expect(res).toMatchObject({ stage: 'new', wonStatus: 'none', wonRequestedBy: null, canEdit: true });
    expect(res.history.at(-1)).toMatchObject({ event: 'won_rejected', reason: 'Asked on the wrong deal' });
    // Kamran asks; the Director confirms through the approvals inbox
    const asked = (await as(KAMRAN).post(`${API}/sales/deals/${deal.k.id}/request-won`).send({ version: res.version }).expect(200)).body;
    expect(asked.wonStatus).toBe('pending');
    await as(DIRECTOR).post(`${API}/approvals/${encodeURIComponent(`won_deal:${deal.k.id}`)}/reject`).send({ reason: 'Contract not signed yet' }).expect(200);
    expect((await prisma.salesDeal.findUniqueOrThrow({ where: { id: deal.k.id } })).wonStatus).toBe('none');
    const again = (await as(KAMRAN).post(`${API}/sales/deals/${deal.k.id}/request-won`).send({ version: (await prisma.salesDeal.findUniqueOrThrow({ where: { id: deal.k.id } })).version }).expect(200)).body;
    expect(again.wonStatus).toBe('pending');
    await as(DIRECTOR).post(`${API}/approvals/${encodeURIComponent(`won_deal:${deal.k.id}`)}/approve`).send({}).expect(200);
    const done = await prisma.salesDeal.findUniqueOrThrow({ where: { id: deal.k.id } });
    expect(done).toMatchObject({ stage: 'won', wonStatus: 'confirmed' });
    expect((await events()).map((e) => (e.payload as { dealNumber: string }).dealNumber)).toEqual([deal.a.number, deal.a.number, deal.k.number]);
  });

  it('a deal the Director owns is confirmed by the CEO / Owner (decision B1), never by the Director', async () => {
    const own = (await newDeal(DIRECTOR, lead.director).expect(201)).body;
    const asked = (await as(DIRECTOR).post(`${API}/sales/deals/${own.id}/request-won`).send({ version: own.version }).expect(200)).body;
    expect((await as(DIRECTOR).post(`${API}/sales/deals/${own.id}/confirm-won`).send({ version: asked.version }).expect(403)).body.code).toBe('self_approval');
    // the request is in the Owner's approvals inbox, not in the Director's
    const ownerInbox = (await as(OWNER).get(`${API}/approvals`).expect(200)).body.items.filter((i: { type: string }) => i.type === 'won_deal');
    expect(ownerInbox.map((i: { refId: string }) => i.refId)).toEqual([own.id]);
    expect((await as(DIRECTOR).get(`${API}/approvals`).expect(200)).body.items.some((i: { refId: string }) => i.refId === own.id)).toBe(false);
    expect((await as(OWNER).get(`${API}/sales/deals/${own.id}`).expect(200)).body.canDecideWon).toBe(true);
    const done = (await as(OWNER).post(`${API}/sales/deals/${own.id}/confirm-won`).send({ version: asked.version }).expect(200)).body;
    expect(done).toMatchObject({ stage: 'won', wonStatus: 'confirmed', wonConfirmedBy: { empId: OWNER }, owner: { empId: DIRECTOR } });
    const sent = (await events()).at(-1)!;
    expect(sent.payload).toMatchObject({ dealNumber: own.number, ownerEmpId: DIRECTOR, confirmedByEmpId: OWNER });
    await runner.drain(BILLING_CONSUMER);
    expect(await prisma.invoice.count({ where: { sourceDealNumber: own.number } })).toBe(1);
  });

  it('the CEO / Owner confirms nothing else: not a salesperson’s deal, through the screen, the inbox or the database', async () => {
    const d = (await newDeal(KAMRAN, lead.kamran, { service: 'website' }).expect(201)).body;
    const asked = (await as(KAMRAN).post(`${API}/sales/deals/${d.id}/request-won`).send({ version: d.version }).expect(200)).body;
    expect((await as(OWNER).get(`${API}/sales/deals/${d.id}`).expect(200)).body.canDecideWon).toBe(false);
    expect((await as(OWNER).post(`${API}/sales/deals/${d.id}/confirm-won`).send({ version: asked.version }).expect(403)).body.code).toBe('owner_confirms_director_deals_only');
    expect((await as(OWNER).post(`${API}/sales/deals/${d.id}/reject-won`).send({ reason: 'Not mine to decide', version: asked.version }).expect(403)).body.code).toBe('owner_confirms_director_deals_only');
    await as(OWNER).post(`${API}/approvals/${encodeURIComponent(`won_deal:${d.id}`)}/approve`).send({}).expect(403);
    expect((await as(OWNER).get(`${API}/approvals`).expect(200)).body.items.some((i: { refId: string }) => i.refId === d.id)).toBe(false);
    // the database refuses a Level 1 confirmation of a deal that is not the Director's, whatever the code does
    const owner = await prisma.employee.findUniqueOrThrow({ where: { empId: OWNER } });
    await expect(
      prisma.salesDeal.update({ where: { id: d.id }, data: { stage: 'won', wonStatus: 'confirmed', wonConfirmedById: owner.id, wonConfirmedAt: new Date(), closedAt: new Date() } }),
    ).rejects.toThrow(/owner_confirms_director_deals_only/);
    // the Director (the sales manager) confirms it as usual
    await as(DIRECTOR).post(`${API}/sales/deals/${d.id}/confirm-won`).send({ version: asked.version }).expect(200);
  });
});

describe('M15.2 pipeline, reassignment and records', () => {
  it('the pipeline summary counts each stage with totals per currency, for the deals the caller sees', async () => {
    const mine = (await as(HIRA).get(`${API}/sales/deals/summary`).expect(200)).body;
    const stage = (s: string) => mine.stages.find((x: { stage: string }) => x.stage === s);
    expect(mine.stages.map((s: { stage: string }) => s.stage)).toEqual(['new', 'contacted', 'replied', 'meeting_booked', 'proposal_sent', 'negotiation', 'won', 'lost']);
    expect(stage('won')).toEqual({ stage: 'won', count: 1, totals: [{ currency: 'PKR', value: '275000.00' }] });
    expect(stage('lost')).toEqual({ stage: 'lost', count: 1, totals: [{ currency: 'USD', value: '1200.00' }] });
    const team = (await as(DIRECTOR).get(`${API}/sales/deals/summary`).expect(200)).body;
    expect(team.stages.find((x: { stage: string }) => x.stage === 'won').count).toBe(4); // deals a and k, the Director's own (B1) and Kamran's
    expect(team.pendingWonCount).toBe(0);
  });

  it("moving a lead to another salesperson moves its open deals with it (Won and Lost deals keep their owner)", async () => {
    const lv = (await prisma.salesLead.findUniqueOrThrow({ where: { id: lead.hira } })).version;
    const open = (await newDeal(HIRA, lead.hira, { service: 'ecommerce' }).expect(201)).body;
    await as(DIRECTOR).post(`${API}/sales/leads/${lead.hira}/owner`).send({ toEmpId: SAAD, reason: 'Saad takes over the UK accounts', version: lv }).expect(200);
    const moved = await prisma.salesDeal.findUniqueOrThrow({ where: { id: open.id }, include: { owner: true } });
    expect(moved.owner.empId).toBe(SAAD);
    expect(moved.version).toBe(open.version + 1);
    expect((await history(open.id)).at(-1)).toMatchObject({ event: 'owner_changed', reason: 'Saad takes over the UK accounts' });
    const won = await prisma.salesDeal.findUniqueOrThrow({ where: { id: deal.a.id }, include: { owner: true } });
    expect(won.owner.empId).toBe(HIRA);
    const [log] = await audit('sales.lead.reassigned', lead.hira);
    expect(log.details).toMatchObject({ deals: [open.number] });
  });

  it('a lead moved while one of its deals is closed at the same moment: a clean 200 or 409, never a server error', async () => {
    // Lost needs the settings (set earlier in this file). Each round races a lead move against marking its open deal Lost.
    for (let round = 0; round < 6; round++) {
      const leadId = (await as(KAMRAN).post(`${API}/sales/leads`).send({ source: 'referral', fullName: `Race ${round}`, email: `race${round}@race-deals.test`, company: { name: `Race ${round}`, website: `race${round}-deals.test` } }).expect(201)).body.id;
      const d = (await newDeal(KAMRAN, leadId).expect(201)).body;
      const lv = (await prisma.salesLead.findUniqueOrThrow({ where: { id: leadId } })).version;
      const [moveLead, closeDeal] = await Promise.all([
        as(DIRECTOR).post(`${API}/sales/leads/${leadId}/owner`).send({ toEmpId: SAAD, reason: 'Saad covers this region', version: lv }),
        as(KAMRAN).post(`${API}/sales/deals/${d.id}/move`).send({ toStage: 'lost', lostReason: 'Price', version: d.version }),
      ]);
      expect([200, 409]).toContain(moveLead.status);
      // When the lead (with its open deal) moved to Saad first, Kamran no longer works on the deal: a clean 403.
      expect([200, 403, 409]).toContain(closeDeal.status);
      const deal = await prisma.salesDeal.findUniqueOrThrow({ where: { id: d.id }, include: { owner: true } });
      const leadNow = await prisma.salesLead.findUniqueOrThrow({ where: { id: leadId }, include: { owner: true } });
      // a closed deal keeps the owner it had when it closed; an open deal follows its lead
      if (deal.stage === 'lost') expect(deal.owner.empId).toBe(KAMRAN);
      else expect(deal.owner.empId).toBe(leadNow.owner.empId);
    }
  });

  it('the history is insert-only and deals are never deleted', async () => {
    const [h] = await history(deal.a.id);
    await expect(prisma.salesDealHistory.update({ where: { id: h.id }, data: { note: 'x' } })).rejects.toThrow(/insert-only/);
    await expect(prisma.salesDealHistory.delete({ where: { id: h.id } })).rejects.toThrow(/insert-only/);
    await expect(prisma.salesDeal.delete({ where: { id: deal.k.id } })).rejects.toThrow(/never deleted/);
  });
});
