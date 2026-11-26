import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { ActivityRecorder } from '../src/activity/activity-recorder.service';
import { addDays, dbDate, pkDate } from '../src/common/pakistan-time';
import { FollowUpRemindersService } from '../src/sales/follow-up-reminders.service';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 15.3: activities, follow-ups and proposal links (plan section 20), against the real database.
 * The timeline (who, when, manual or tool), insert-only; logged contacts move a deal FORWARD only (never a Won, Lost or
 * pending-Won deal) and never overwrite a stage change made at the same moment; the next step is the follow-up; the daily
 * reminder notifies once; Module 4 records each successful request as a Sales "create", never a tool action.
 */
const API = '/api/v1';
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const DEV = 'ACV-0006';
const HIRA = 'ACV-0009';
const FINANCE = 'ACV-0010';
const KAMRAN = 'ACV-0012';

let t: TestApp;
let prisma: PrismaClient;
let today = '';
const ids: Record<string, string> = {};
const lead: Record<string, string> = {};
const deal: Record<string, { id: string; number: string }> = {};

const as = (who: string) => t.as(who);
const inDays = (n: number) => addDays(today, n);
const version = async (id: string) => (await prisma.salesDeal.findUniqueOrThrow({ where: { id } })).version;
const log = (who: string, where: { deal?: string; lead?: string }, body: Record<string, unknown>) =>
  as(who).post(where.deal ? `${API}/sales/deals/${where.deal}/activities` : `${API}/sales/leads/${where.lead}/activities`).send(body);
const newDeal = (who: string, leadId: string, over: Record<string, unknown> = {}) =>
  as(who).post(`${API}/sales/deals`).send({ leadId, service: 'website', value: '1000.00', currency: 'USD', expectedClose: inDays(30), nextStep: 'Call them', nextStepDate: today, ...over });
const salesEvents = async () => {
  await t.app.get(ActivityRecorder).flush();
  return prisma.activityEvent.findMany({ where: { module: 'Sales' }, orderBy: { occurredAt: 'asc' } });
};

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  prisma = createTestPrisma();
  today = pkDate(t.clock.now());
  for (const e of await prisma.employee.findMany({ select: { id: true, empId: true } })) ids[e.empId] = e.id;
  const mk = async (who: string, name: string, site: string) =>
    (await as(who).post(`${API}/sales/leads`).send({ source: 'linkedin', fullName: name, email: `${name.split(' ')[0].toLowerCase()}@${site}`, company: { name: site, website: site } }).expect(201)).body.id as string;
  lead.hira = await mk(HIRA, 'Ayesha Khan', 'northwind-act.test');
  lead.hira2 = await mk(HIRA, 'Omar Farooq', 'contoso-act.test');
  lead.kamran = await mk(KAMRAN, 'Lena Park', 'fabrikam-act.test');
  const keep = (k: string, b: { id: string; number: string }) => (deal[k] = { id: b.id, number: b.number });
  keep('a', (await newDeal(HIRA, lead.hira).expect(201)).body);
  keep('b', (await newDeal(HIRA, lead.hira2, { nextStepDate: inDays(3) }).expect(201)).body);
  keep('k', (await newDeal(KAMRAN, lead.kamran).expect(201)).body);
}, 180000);
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M15.3 access', () => {
  it('people without sales access have none; another salesperson can neither read nor write a timeline; the CEO / Owner reads only', async () => {
    for (const who of [FINANCE, CTO, DEV]) {
      await as(who).get(`${API}/sales/leads/${lead.hira}/activities`).expect(403);
      await as(who).get(`${API}/sales/follow-ups`).expect(403);
      await log(who, { lead: lead.hira }, { kind: 'note', summary: 'Nope' }).expect(403);
    }
    await as(KAMRAN).get(`${API}/sales/leads/${lead.hira}/activities`).expect(403);
    await as(KAMRAN).get(`${API}/sales/deals/${deal.a.id}/activities`).expect(403);
    await log(KAMRAN, { deal: deal.a.id }, { kind: 'call', summary: 'Not my lead' }).expect(403);
    await log(OWNER, { lead: lead.hira }, { kind: 'note', summary: 'The CEO only views' }).expect(403);
    await as(OWNER).get(`${API}/sales/leads/${lead.hira}/activities`).expect(200);
    await as(DIRECTOR).get(`${API}/sales/deals/${deal.a.id}/activities`).expect(200);
    expect(await prisma.salesActivity.count()).toBe(0);
  });
});

describe('M15.3 timeline and stage triggers', () => {
  it('a call moves New to Contacted; the entry keeps who, when and "manual"; the lead was contacted; Module 4 records a Sales create', async () => {
    const before = (await prisma.salesLead.findUniqueOrThrow({ where: { id: lead.hira } })).lastActivityAt;
    const res = (await log(HIRA, { deal: deal.a.id }, { kind: 'call', summary: 'First call, interested' }).expect(201)).body;
    expect(res).toMatchObject({
      activity: { kind: 'call', source: 'manual', summary: 'First call, interested', actor: { empId: HIRA }, dealId: deal.a.id, dealNumber: deal.a.number, leadId: lead.hira, externalId: null },
      stageChange: { from: 'new', to: 'contacted' },
      stageNotChanged: null,
    });
    const d = await prisma.salesDeal.findUniqueOrThrow({ where: { id: deal.a.id } });
    expect(d.stage).toBe('contacted');
    const history = await prisma.salesDealHistory.findMany({ where: { dealId: deal.a.id }, orderBy: { at: 'asc' } });
    expect(history.at(-1)).toMatchObject({ event: 'stage_changed', fromStage: 'new', toStage: 'contacted', actorId: ids[HIRA], note: 'Moved by a logged activity' });
    expect((await prisma.salesLead.findUniqueOrThrow({ where: { id: lead.hira } })).lastActivityAt.getTime()).toBeGreaterThan(before.getTime());
    const events = await salesEvents();
    const mine = events.filter((e) => e.description?.includes(`Logged a call on ${deal.a.number}`));
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ action: 'create', source: 'aceva', employeeId: ids[HIRA] });
    // the tool actions of Module 4 are left to Module 16
    expect(events.some((e) => ['email_sent', 'reply', 'bounce', 'call', 'email_check'].includes(e.action))).toBe(false);
  });

  it('forward only: a reply moves to Replied; a later call does not move it back; a meeting moves only with its date', async () => {
    expect((await log(HIRA, { deal: deal.a.id }, { kind: 'reply', summary: 'They answered' }).expect(201)).body.stageChange).toEqual({ from: 'contacted', to: 'replied' });
    const call = (await log(HIRA, { deal: deal.a.id }, { kind: 'whatsapp', summary: 'Sent the brochure' }).expect(201)).body;
    expect(call).toMatchObject({ stageChange: null, stageNotChanged: 'not_forward' });
    expect((await log(HIRA, { deal: deal.a.id }, { kind: 'meeting', summary: 'Talked about a meeting' }).expect(201)).body).toMatchObject({ stageChange: null, stageNotChanged: null });
    const meeting = (await log(HIRA, { deal: deal.a.id }, { kind: 'meeting', summary: 'Meeting booked', meetingAt: new Date(Date.now() + 2 * 86_400_000).toISOString() }).expect(201)).body;
    expect(meeting.stageChange).toEqual({ from: 'replied', to: 'meeting_booked' });
    expect(meeting.activity.meetingAt).not.toBeNull();
  });

  it('a linked proposal moves to Proposal sent and becomes the deal’s link; links and meeting dates are checked', async () => {
    await log(HIRA, { deal: deal.a.id }, { kind: 'proposal', summary: 'Sent', proposalUrl: 'ftp://files.example.com/p.pdf' }).expect(400);
    await log(HIRA, { deal: deal.a.id }, { kind: 'proposal', summary: 'Sent', proposalUrl: 'javascript:alert(1)' }).expect(400);
    await log(HIRA, { deal: deal.a.id }, { kind: 'call', summary: 'Call', proposalUrl: 'https://docs.example.com/p' }).expect(400);
    await log(HIRA, { deal: deal.a.id }, { kind: 'call', summary: 'Call', meetingAt: new Date().toISOString() }).expect(400);
    const res = (await log(HIRA, { deal: deal.a.id }, { kind: 'proposal', summary: 'Proposal v1', proposalUrl: 'https://docs.example.com/proposal-v1' }).expect(201)).body;
    expect(res.stageChange).toEqual({ from: 'meeting_booked', to: 'proposal_sent' });
    const view = (await as(HIRA).get(`${API}/sales/deals/${deal.a.id}`).expect(200)).body;
    expect(view).toMatchObject({ stage: 'proposal_sent', proposalUrl: 'https://docs.example.com/proposal-v1' });
    // a newer proposal link replaces the deal's link (the stage stays)
    const v2 = (await log(HIRA, { deal: deal.a.id }, { kind: 'proposal', summary: 'Proposal v2', proposalUrl: 'https://docs.example.com/proposal-v2' }).expect(201)).body;
    expect(v2).toMatchObject({ stageChange: null, stageNotChanged: 'not_forward' });
    expect((await prisma.salesDeal.findUniqueOrThrow({ where: { id: deal.a.id } })).proposalUrl).toBe('https://docs.example.com/proposal-v2');
  });

  it('the timeline is in time order (an entry logged late for an earlier time sits where it happened); the deal shows its own and the lead’s general entries', async () => {
    const earlier = new Date(Date.now() - 3 * 86_400_000).toISOString();
    await log(HIRA, { lead: lead.hira }, { kind: 'linkedin', summary: 'Connected on LinkedIn', at: earlier }).expect(201);
    // a Fiverr inquiry is a contact: New to Contacted (approved decision 1)
    expect((await log(HIRA, { deal: deal.b.id }, { kind: 'fiverr', summary: 'Fiverr inquiry about a shop' }).expect(201)).body.stageChange).toEqual({ from: 'new', to: 'contacted' });
    const leadLine = (await as(HIRA).get(`${API}/sales/leads/${lead.hira}/activities`).expect(200)).body;
    const times = leadLine.map((x: { at: string }) => x.at);
    expect([...times].sort().reverse()).toEqual(times); // newest first
    expect(leadLine.at(-1)).toMatchObject({ kind: 'linkedin', at: earlier, dealId: null });
    const dealLine = (await as(HIRA).get(`${API}/sales/deals/${deal.a.id}/activities`).expect(200)).body;
    expect(dealLine.some((x: { kind: string }) => x.kind === 'linkedin')).toBe(true); // the lead's general entry
    expect(dealLine.some((x: { kind: string }) => x.kind === 'fiverr')).toBe(false); // another deal's entry
    // a late entry never moves "last contacted" back
    const last = (await prisma.salesLead.findUniqueOrThrow({ where: { id: lead.hira } })).lastActivityAt;
    expect(last.getTime()).toBeGreaterThan(Date.parse(earlier));
    // a note is not a contact
    const before = (await prisma.salesLead.findUniqueOrThrow({ where: { id: lead.hira2 } })).lastActivityAt;
    t.clock.advance(1000);
    await log(HIRA, { lead: lead.hira2 }, { kind: 'note', summary: 'Prefers mornings' }).expect(201);
    expect((await prisma.salesLead.findUniqueOrThrow({ where: { id: lead.hira2 } })).lastActivityAt).toEqual(before);
    await log(HIRA, { lead: lead.hira }, { kind: 'note', summary: 'Too late', at: new Date(Date.now() + 3_600_000).toISOString() }).expect(400);
  });

  it('a reply moves Contacted to Replied only: on a New deal it is kept, the stage stays New and the answer says why', async () => {
    const d = (await newDeal(HIRA, lead.hira2).expect(201)).body;
    const early = (await log(HIRA, { deal: d.id }, { kind: 'reply', summary: 'Replied to an old post' }).expect(201)).body;
    expect(early).toMatchObject({ activity: { kind: 'reply', dealId: d.id }, stageChange: null, stageNotChanged: 'needs_contacted' });
    const row = await prisma.salesDeal.findUniqueOrThrow({ where: { id: d.id } });
    expect(row).toMatchObject({ stage: 'new', version: d.version }); // untouched: no skip to Replied, no version bump
    expect(await prisma.salesDealHistory.count({ where: { dealId: d.id, event: 'stage_changed' } })).toBe(0);
    expect(await prisma.salesActivity.count({ where: { dealId: d.id, kind: 'reply' } })).toBe(1);
    // after the first contact, a reply moves Contacted to Replied
    expect((await log(HIRA, { deal: d.id }, { kind: 'call', summary: 'First call' }).expect(201)).body.stageChange).toEqual({ from: 'new', to: 'contacted' });
    expect((await log(HIRA, { deal: d.id }, { kind: 'reply', summary: 'They answered' }).expect(201)).body).toMatchObject({ stageChange: { from: 'contacted', to: 'replied' }, stageNotChanged: null });
    // a later reply, or a reply on a deal further on, never moves it (forward only)
    expect((await log(HIRA, { deal: d.id }, { kind: 'reply', summary: 'Another answer' }).expect(201)).body).toMatchObject({ stageChange: null, stageNotChanged: 'not_forward' });
    expect((await log(HIRA, { deal: deal.a.id }, { kind: 'reply', summary: 'Questions about the proposal' }).expect(201)).body).toMatchObject({ stageChange: null, stageNotChanged: 'not_forward' });
    expect((await prisma.salesDeal.findUniqueOrThrow({ where: { id: deal.a.id } })).stage).toBe('proposal_sent');
    await prisma.salesDeal.update({ where: { id: d.id }, data: { archivedAt: new Date() } }); // keep the follow-up lists below clean
  });

  it('a deal waiting for its Won confirmation, or closed, is never moved; the activity is kept and the answer says why', async () => {
    await as(KAMRAN).post(`${API}/sales/deals/${deal.k.id}/request-won`).send({ version: await version(deal.k.id) }).expect(200);
    const pending = (await log(KAMRAN, { deal: deal.k.id }, { kind: 'reply', summary: 'Signed the contract' }).expect(201)).body;
    expect(pending).toMatchObject({ stageChange: null, stageNotChanged: 'won_pending' });
    await as(DIRECTOR).post(`${API}/sales/deals/${deal.k.id}/confirm-won`).send({ version: await version(deal.k.id) }).expect(200);
    const closed = (await log(KAMRAN, { deal: deal.k.id }, { kind: 'call', summary: 'Kick-off call' }).expect(201)).body;
    expect(closed).toMatchObject({ stageChange: null, stageNotChanged: 'deal_closed' });
    expect((await prisma.salesDeal.findUniqueOrThrow({ where: { id: deal.k.id } })).stage).toBe('won');
    expect(await prisma.salesActivity.count({ where: { dealId: deal.k.id } })).toBe(2);
  });

  it('an activity and a manual stage change at the same moment: no lost update, no server error, the activity is always kept', async () => {
    for (let round = 0; round < 5; round++) {
      const d = (await newDeal(HIRA, lead.hira2).expect(201)).body;
      const [manual, activity] = await Promise.all([
        as(HIRA).post(`${API}/sales/deals/${d.id}/move`).send({ toStage: 'negotiation', version: d.version }),
        log(HIRA, { deal: d.id }, { kind: 'call', summary: `Race call ${round}` }),
      ]);
      expect([200, 409]).toContain(manual.status);
      expect(activity.status).toBe(201);
      const now = await prisma.salesDeal.findUniqueOrThrow({ where: { id: d.id } });
      const moves = await prisma.salesDealHistory.findMany({ where: { dealId: d.id, event: 'stage_changed' }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
      // the stage is the last recorded move, and every recorded move starts where the previous one ended
      expect(now.stage).toBe(moves.at(-1)!.toStage);
      moves.forEach((m, i) => expect(m.fromStage).toBe(i === 0 ? 'new' : moves[i - 1].toStage));
      // never backwards: once the manual move to Negotiation happened, the call could not take it back to Contacted
      if (manual.status === 200) expect(now.stage).toBe('negotiation');
      await prisma.salesDeal.update({ where: { id: d.id }, data: { archivedAt: new Date() } }); // keep the follow-up lists below clean
    }
  });

  it('the timeline is insert-only; an activity is always on its deal’s own lead; a manual entry has no tool id', async () => {
    const a = await prisma.salesActivity.findFirstOrThrow({ where: { leadId: lead.hira } });
    await expect(prisma.salesActivity.update({ where: { id: a.id }, data: { summary: 'changed' } })).rejects.toThrow(/insert-only/);
    await expect(prisma.salesActivity.delete({ where: { id: a.id } })).rejects.toThrow(/insert-only/);
    await expect(prisma.salesActivity.create({ data: { leadId: lead.kamran, dealId: deal.a.id, actorId: ids[HIRA], kind: 'call', occurredAt: new Date(), summary: 'x' } })).rejects.toThrow(/activity_deal_lead/);
    await expect(prisma.salesActivity.create({ data: { leadId: lead.hira, actorId: ids[HIRA], kind: 'call', occurredAt: new Date(), summary: 'x', externalId: 'apollo-1' } })).rejects.toThrow();
    // Module 16 will write tool entries: one tool id once per tool
    await prisma.salesActivity.create({ data: { leadId: lead.hira, kind: 'email_sent', source: 'apollo', occurredAt: new Date(), summary: 'Sequence email', externalId: 'apollo-1' } });
    await expect(prisma.salesActivity.create({ data: { leadId: lead.hira, kind: 'email_sent', source: 'apollo', occurredAt: new Date(), summary: 'Again', externalId: 'apollo-1' } })).rejects.toThrow();
    const line = (await as(HIRA).get(`${API}/sales/leads/${lead.hira}/activities`).expect(200)).body;
    expect(line.find((x: { externalId: string | null }) => x.externalId === 'apollo-1')).toMatchObject({ source: 'apollo', actor: null });
  });

  it('a refused request leaves nothing behind: no activity and no Module 4 "create" record (a refusal is only a blocked attempt)', async () => {
    const activities = await prisma.salesActivity.count();
    const creates = (await salesEvents()).filter((e) => e.action === 'create').length;
    await log(HIRA, { deal: deal.a.id }, { kind: 'proposal', summary: 'Bad link', proposalUrl: 'not a link' }).expect(400);
    await log(KAMRAN, { deal: deal.a.id }, { kind: 'call', summary: 'Not my deal' }).expect(403);
    await log(HIRA, { deal: '00000000-0000-4000-8000-000000000000' }, { kind: 'call', summary: 'No such deal' }).expect(404);
    expect(await prisma.salesActivity.count()).toBe(activities);
    expect((await salesEvents()).filter((e) => e.action === 'create').length).toBe(creates);
  });
});

describe('M15.3 follow-ups', () => {
  it('mine and the team’s, due today or missed (Pakistan time); the sales manager sees the team; a salesperson only their own', async () => {
    // make deal b's follow-up missed (its date has passed)
    await prisma.salesDeal.update({ where: { id: deal.b.id }, data: { nextStepDate: dbDate(inDays(-2)) } });
    const mine = (await as(HIRA).get(`${API}/sales/follow-ups`).expect(200)).body;
    expect(mine.map((f: { dealNumber: string; missed: boolean }) => [f.dealNumber, f.missed])).toEqual([
      [deal.b.number, true],
      [deal.a.number, false],
    ]);
    expect((await as(HIRA).get(`${API}/sales/follow-ups?status=missed`).expect(200)).body.map((f: { dealNumber: string }) => f.dealNumber)).toEqual([deal.b.number]);
    expect((await as(HIRA).get(`${API}/sales/follow-ups?status=due`).expect(200)).body.map((f: { dealNumber: string }) => f.dealNumber)).toEqual([deal.a.number]);
    await as(HIRA).get(`${API}/sales/follow-ups?scope=team`).expect(403);
    const team = (await as(DIRECTOR).get(`${API}/sales/follow-ups?scope=team&status=missed`).expect(200)).body;
    expect(team).toEqual([expect.objectContaining({ dealNumber: deal.b.number, missed: true, owner: { empId: HIRA, name: expect.any(String) } })]);
    // the Won deal k has no follow-up any more; the CEO / Owner sees the team's list too (view only)
    expect((await as(OWNER).get(`${API}/sales/follow-ups?scope=team`).expect(200)).body.some((f: { dealNumber: string }) => f.dealNumber === deal.k.number)).toBe(false);
    // Pakistan time decides "today": 19:30 UTC is already the next day in Pakistan
    expect(pkDate(new Date(`${today}T19:30:00.000Z`))).toBe(inDays(1));
    expect(pkDate(new Date(`${today}T18:59:59.000Z`))).toBe(today);
  });

  it('completing a follow-up records it, sets the next one, keeps the stage and owner, and checks the version', async () => {
    const before = await prisma.salesDeal.findUniqueOrThrow({ where: { id: deal.b.id } });
    const res = (await as(HIRA).post(`${API}/sales/deals/${deal.b.id}/follow-up`).send({ summary: 'Called back, they need a week', nextStep: 'Send the revised scope', nextStepDate: inDays(7), version: before.version }).expect(200)).body;
    expect(res).toMatchObject({ nextStep: 'Send the revised scope', nextStepDate: inDays(7), stage: before.stage, owner: { empId: HIRA }, version: before.version + 1 });
    const act = await prisma.salesActivity.findFirstOrThrow({ where: { dealId: deal.b.id, kind: 'follow_up' } });
    expect(act).toMatchObject({ summary: 'Called back, they need a week', actorId: ids[HIRA], source: 'manual' });
    await as(HIRA).post(`${API}/sales/deals/${deal.b.id}/follow-up`).send({ nextStep: 'Old', nextStepDate: inDays(7), version: before.version }).expect(409);
    await as(HIRA).post(`${API}/sales/deals/${deal.b.id}/follow-up`).send({ nextStep: 'Past', nextStepDate: inDays(-1), version: res.version }).expect(400);
    await as(KAMRAN).post(`${API}/sales/deals/${deal.b.id}/follow-up`).send({ nextStep: 'Mine now', nextStepDate: inDays(2), version: res.version }).expect(403);
    await as(OWNER).post(`${API}/sales/deals/${deal.b.id}/follow-up`).send({ nextStep: 'The CEO', nextStepDate: inDays(2), version: res.version }).expect(403);
    // a closed deal has no follow-up to complete
    expect((await as(KAMRAN).post(`${API}/sales/deals/${deal.k.id}/follow-up`).send({ nextStep: 'x step', nextStepDate: inDays(2), version: await version(deal.k.id) }).expect(409)).body.code).toBe('deal_closed');
    expect((await as(HIRA).get(`${API}/sales/follow-ups?status=missed`).expect(200)).body).toEqual([]);
  });

  it('the daily reminder at 09:00 Pakistan time tells each owner once about the follow-ups due that day', async () => {
    const reminders = t.app.get(FollowUpRemindersService);
    const state = (id: string) => prisma.salesDeal.findUniqueOrThrow({ where: { id }, select: { stage: true, wonStatus: true, nextStepDate: true, archivedAt: true, wonRequestedById: true } });
    const reminded = (id: string, day = today) => prisma.notification.count({ where: { type: 'sales_follow_up', dedupeKey: `sales_follow_up:${id}:${day}` } });
    // The real statuses (enum sales_won_status): 'none' = no Won request waiting (a new deal, or a request withdrawn or
    // rejected); 'pending' = waiting for the confirmation (the stage stays open); 'confirmed' = Won (stage 'won', a CHECK).
    // Deal a: open, no request, due today -> eligible.
    expect(await state(deal.a.id)).toMatchObject({ stage: 'proposal_sent', wonStatus: 'none', nextStepDate: dbDate(today), archivedAt: null });
    // Deal k: Won -> its status is 'confirmed' and its stage 'won' (closed, not eligible).
    expect(await state(deal.k.id)).toMatchObject({ stage: 'won', wonStatus: 'confirmed' });
    // Deals p and q: due today, open, owner active, not archived; request-won takes each from 'none' to 'pending' and keeps the
    // stage open, so the Won status is the only thing that sets them apart from deal a. Their follow-ups cannot be completed
    // while pending (409 won_pending), so no reminder.
    const p = (await newDeal(HIRA, lead.hira2).expect(201)).body;
    const q = (await newDeal(HIRA, lead.hira2).expect(201)).body;
    for (const d of [p, q]) {
      expect(await state(d.id)).toMatchObject({ stage: 'new', wonStatus: 'none', nextStepDate: dbDate(today), archivedAt: null });
      await as(HIRA).post(`${API}/sales/deals/${d.id}/request-won`).send({ version: d.version }).expect(200);
      expect(await state(d.id)).toMatchObject({ stage: 'new', wonStatus: 'pending', nextStepDate: dbDate(today), archivedAt: null, wonRequestedById: ids[HIRA] });
    }
    await as(HIRA).post(`${API}/sales/deals/${p.id}/follow-up`).send({ nextStep: 'x step', nextStepDate: inDays(2), version: await version(p.id) }).expect(409);
    const made = await reminders.run(today);
    expect(made).toBe(1); // deal a only; deal b moved to next week, deal k is Won, deals p and q wait for their Won confirmation
    expect(await reminded(p.id)).toBe(0);
    expect(await reminded(q.id)).toBe(0);
    const notes = await prisma.notification.findMany({ where: { type: 'sales_follow_up' }, include: { deliveries: true } });
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ recipientId: ids[HIRA], title: 'Follow-up due today: northwind-act.test', link: `/sales/deals/${deal.a.id}`, dedupeKey: `sales_follow_up:${deal.a.id}:${today}`, essential: false });
    expect(notes[0].deliveries.map((d) => d.channel)).toEqual(['email']);
    // the same day again (a retry, or a second server): nothing new
    expect(await reminders.run(today)).toBe(0);
    expect(await prisma.notification.count({ where: { type: 'sales_follow_up' } })).toBe(1);
    // The person who asked withdraws deal p's request: 'pending' -> 'none', the stage still open. It is eligible again: its
    // owner is told once; deal a is not told again; deal q, still pending, is still left out.
    await as(HIRA).post(`${API}/sales/deals/${p.id}/reject-won`).send({ reason: 'The client has not signed yet', version: await version(p.id) }).expect(200);
    expect(await state(p.id)).toMatchObject({ stage: 'new', wonStatus: 'none', wonRequestedById: null });
    expect(await state(q.id)).toMatchObject({ wonStatus: 'pending' });
    expect(await reminders.run(today)).toBe(1);
    expect(await reminded(p.id)).toBe(1);
    expect(await reminded(q.id)).toBe(0);
    expect(await reminded(deal.a.id)).toBe(1);
    // The sales manager rejects deal q's request: also back to 'none', so eligible again, and told once.
    await as(DIRECTOR).post(`${API}/sales/deals/${q.id}/reject-won`).send({ reason: 'Not signed yet', version: await version(q.id) }).expect(200);
    expect(await state(q.id)).toMatchObject({ stage: 'new', wonStatus: 'none' });
    expect(await reminders.run(today)).toBe(1);
    expect(await reminders.run(today)).toBe(0); // nothing twice
    expect(await reminded(q.id)).toBe(1);
    expect(await prisma.notification.count({ where: { type: 'sales_follow_up' } })).toBe(3); // a, p, q: once each
    await prisma.salesDeal.updateMany({ where: { id: { in: [p.id, q.id] } }, data: { archivedAt: new Date() } }); // keep later checks clean
    // the day deal b is due, its owner is told once
    expect(await reminders.run(inDays(7))).toBe(1);
  });

  it('Module 4 records a completed follow-up once, as a Sales create', async () => {
    const done = (await salesEvents()).filter((e) => e.description === `Completed a follow-up on ${deal.b.number}`);
    expect(done).toHaveLength(1);
    expect(done[0]).toMatchObject({ action: 'create', employeeId: ids[HIRA] });
  });
});

describe('M15.3 timeline privacy after a lead moves', () => {
  it('the former owner of a closed deal keeps its entries but does not see what the new owner logs on the lead', async () => {
    const before = await prisma.salesLead.findUniqueOrThrow({ where: { id: lead.kamran } });
    await as(DIRECTOR).post(`${API}/sales/leads/${lead.kamran}/owner`).send({ toEmpId: HIRA, reason: 'Hira covers this account now', version: before.version }).expect(200);
    expect((await prisma.salesDeal.findUniqueOrThrow({ where: { id: deal.k.id } })).ownerId).toBe(ids[KAMRAN]); // a Won deal keeps its owner
    await log(HIRA, { lead: lead.kamran }, { kind: 'note', summary: 'Private plan for the renewal' }).expect(201);
    const kamrans = (await as(KAMRAN).get(`${API}/sales/deals/${deal.k.id}/activities`).expect(200)).body;
    expect(kamrans.map((x: { summary: string }) => x.summary).sort()).toEqual(['Kick-off call', 'Signed the contract']);
    await as(KAMRAN).get(`${API}/sales/leads/${lead.kamran}/activities`).expect(403);
    // the sales manager and the new owner see everything
    const director = (await as(DIRECTOR).get(`${API}/sales/deals/${deal.k.id}/activities`).expect(200)).body;
    expect(director.some((x: { summary: string }) => x.summary === 'Private plan for the renewal')).toBe(true);
    expect((await as(HIRA).get(`${API}/sales/leads/${lead.kamran}/activities`).expect(200)).body).toHaveLength(3);
  });
});
