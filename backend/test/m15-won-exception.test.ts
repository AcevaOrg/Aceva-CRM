import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { BILLING_CONSUMER } from '../src/billing/billing-events.consumer';
import { ActivityRecorder } from '../src/activity/activity-recorder.service';
import type { PrismaClient } from '../src/generated/prisma/client';
import { addDays, dbDate, pkDate } from '../src/common/pakistan-time';
import { OutboxConsumerRunner } from '../src/events/outbox-consumer-runner.service';
import { OffboardingService } from '../src/people/offboarding.service';
import { SALES_OFFBOARDING_CONSUMER } from '../src/sales/sales-offboarding.service';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 15.5 follow-up: the exceptional Won decision (approved management decision). A pending Won request whose requester
 * has left, on a deal Module 15.5 moved to someone nobody can decide for, may be confirmed or sent back by the holder of
 * sales.won_decide_exception (the Owner role only), with a reason and step-up, on its own route; every condition is checked
 * again under the deal's lock; an insert-only record keeps the original request; the database lets a Level 1 confirmer
 * through only with that record written in the same transaction. B1 and the usual routes are unchanged.
 */
const API = '/api/v1';
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const HIRA = 'ACV-0009';
const FINANCE = 'ACV-0010';
const KAMRAN = 'ACV-0012';

let t: TestApp;
let prisma: PrismaClient;
let runner: OutboxConsumerRunner;
let today = '';
const ids: Record<string, string> = {};
type D = { id: string; number: string };
const deal: Record<string, D> = {};

const as = (who: string) => t.as(who);
const inDays = (n: number) => addDays(today, n);
const row = (id: string) => prisma.salesDeal.findUniqueOrThrow({ where: { id } });
const version = async (id: string) => (await row(id)).version;
const decide = async (id: string, decision: string, reason: string | undefined, v?: number) =>
  as(OWNER).post(`${API}/sales/deals/${id}/won-exception`).send({ decision, ...(reason === undefined ? {} : { reason }), version: v ?? (await version(id)) });
/** The response, after checking its status (the decision helper reads the version first, so it cannot chain .expect). */
async function want(status: number, pending: Promise<{ status: number; body: Record<string, unknown> & { code?: string; message?: string } }>) {
  const res = await pending;
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res;
}

let n = 0;
async function newDeal(who: string): Promise<D> {
  n++;
  const site = `wonx${n}.test`;
  const leadId = (await as(who).post(`${API}/sales/leads`).send({ source: 'referral', fullName: `Client ${n}`, email: `c${n}@${site}`, company: { name: `Client Co ${n}`, website: site } }).expect(201)).body.id;
  const d = (await as(who).post(`${API}/sales/deals`).send({ leadId, service: 'website', value: `${1000 + n}.00`, currency: 'USD', expectedClose: inDays(30), nextStep: 'Sign the contract', nextStepDate: inDays(2) }).expect(201)).body;
  return { id: d.id, number: d.number };
}
async function requestWon(who: string, d: D) {
  await as(who).post(`${API}/sales/deals/${d.id}/request-won`).send({ version: await version(d.id) }).expect(200);
}
/** The real Module 3 leaving step, then the sales reader. */
async function leave(empId: string) {
  await prisma.employee.update({ where: { empId }, data: { status: 'on_notice', lastWorkingDay: dbDate(inDays(-1)) } });
  await t.app.get(OffboardingService).process(empId);
  await runner.drain(SALES_OFFBOARDING_CONSUMER);
}

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  prisma = createTestPrisma();
  runner = t.app.get(OutboxConsumerRunner);
  today = pkDate(t.clock.now());
  for (const e of await prisma.employee.findMany({ select: { id: true, empId: true } })) ids[e.empId] = e.id;
  await runner.drain(SALES_OFFBOARDING_CONSUMER);
  await runner.drain(BILLING_CONSUMER);

  // Deals the Director owns and asked to mark Won (A to D), a deal of Hira's the Director asked for (F), Hira's own (K),
  // and Kamran's own (H).
  for (const k of ['A', 'B', 'C', 'D']) {
    deal[k] = await newDeal(DIRECTOR);
    await requestWon(DIRECTOR, deal[k]);
  }
  deal.F = await newDeal(HIRA);
  await requestWon(DIRECTOR, deal.F);
  deal.K = await newDeal(HIRA);
  await requestWon(HIRA, deal.K);
  deal.H = await newDeal(KAMRAN);
  await requestWon(KAMRAN, deal.H);
  // Kamran leaves: H moves to the Director (the one sales manager), so it is a deal a Director owns (B1 applies).
  await leave(KAMRAN);
  expect((await row(deal.H.id)).ownerId).toBe(ids[DIRECTOR]);
  // The CTO becomes the sales manager, then the Director leaves: A to D move to the CTO; F (Hira's) does not move.
  const duty = await prisma.duty.findUniqueOrThrow({ where: { key: 'sales_manager' } });
  await prisma.employeeDuty.create({ data: { employeeId: ids[CTO], dutyId: duty.id } });
}, 240000);
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M15.5 exceptional Won decision', () => {
  it('B1 is unchanged: a Director-owned deal is not an exception; the Owner confirms it on the normal route', async () => {
    await t.stepUp(OWNER);
    expect((await want(409, decide(deal.H.id, 'confirm', 'Kamran left; confirming as an exception'))).body).toMatchObject({ code: 'exception_not_applicable', message: expect.stringMatching(/Director owns.*B1/) });
    await as(OWNER).post(`${API}/sales/deals/${deal.H.id}/confirm-won`).send({ version: await version(deal.H.id) }).expect(200);
    expect(await row(deal.H.id)).toMatchObject({ stage: 'won', wonStatus: 'confirmed', wonConfirmedById: ids[OWNER], wonRequestedById: ids[KAMRAN] });
    // and now the Director leaves
    await leave(DIRECTOR);
    for (const k of ['A', 'B', 'C', 'D']) expect((await row(deal[k].id)).ownerId, k).toBe(ids[CTO]);
    expect((await row(deal.F.id)).ownerId).toBe(ids[HIRA]);
  });

  it('only the Owner role holds the permission; the deal page shows the decision only when it applies', async () => {
    const perms = await prisma.rolePermission.findMany({ where: { permission: { key: 'sales.won_decide_exception' } }, include: { role: { select: { key: true } } } });
    expect(perms.map((p) => p.role.key)).toEqual(['owner']);
    // (the migration also writes a permissions audit row where roles already exist; the test database is seeded afterwards)
    // the Owner gained no sales-management right
    const ownerTargets = await prisma.rolePermission.count({ where: { role: { key: 'owner' }, permission: { key: 'sales.targets' } } });
    expect(ownerTargets).toBe(0);
    for (const who of [FINANCE, CTO, HIRA]) {
      await t.stepUp(who);
      expect((await as(who).post(`${API}/sales/deals/${deal.A.id}/won-exception`).send({ decision: 'confirm', reason: 'Trying without the right', version: await version(deal.A.id) })).status, who).toBe(403);
    }
    expect((await as(OWNER).get(`${API}/sales/deals/${deal.A.id}`).expect(200)).body.wonExceptionEligible).toBe(true);
    expect((await as(CTO).get(`${API}/sales/deals/${deal.A.id}`).expect(200)).body.wonExceptionEligible).toBe(false);
    expect((await as(OWNER).get(`${API}/sales/deals/${deal.F.id}`).expect(200)).body.wonExceptionEligible).toBe(false);
    // the usual routes stay closed to the Owner for a deal a Director does not own
    expect((await as(OWNER).post(`${API}/sales/deals/${deal.A.id}/confirm-won`).send({ version: await version(deal.A.id) }).expect(403)).body.code).toBe('owner_confirms_director_deals_only');
  });

  it('a reason of 5 to 500 characters and a known decision are required; step-up is required (as for payroll approval)', async () => {
    t.clock.advance(6 * 60_000); // past the 5-minute step-up window of the first test (sessions last 30 minutes idle)
    await want(400, decide(deal.A.id, 'confirm', undefined));
    await want(400, decide(deal.A.id, 'confirm', 'ok'));
    await want(400, decide(deal.A.id, 'confirm', 'x'.repeat(501)));
    await want(400, decide(deal.A.id, 'approve', 'Valid reason here'));
    expect((await want(403, decide(deal.A.id, 'confirm', 'The contract is signed'))).body.code).toBe('step_up_required');
    expect(await prisma.auditLog.count({ where: { action: 'access.denied', reason: 'step_up_required', details: { path: ['attempted'], equals: 'sales_won_exception' } } })).toBeGreaterThanOrEqual(1);
    expect(await row(deal.A.id)).toMatchObject({ wonStatus: 'pending' });
  });

  it('every condition is checked: requester still active, deal not moved, a sales manager who can decide, a stale version', async () => {
    await t.stepUp(OWNER);
    expect((await want(409, decide(deal.K.id, 'confirm', 'Exception for an active requester'))).body.message).toMatch(/has not left/);
    expect((await want(409, decide(deal.F.id, 'confirm', 'Exception for a deal never moved'))).body.message).toMatch(/not moved/);
    // someone who can decide it the normal way: a sales-manager duty held above the CTO in the reporting line (here,
    // briefly, by the CEO / Owner, who could then confirm on the normal route), so the exception does not apply
    const duty = await prisma.duty.findUniqueOrThrow({ where: { key: 'sales_manager' } });
    const temporary = await prisma.employeeDuty.create({ data: { employeeId: ids[OWNER], dutyId: duty.id } });
    expect((await want(409, decide(deal.A.id, 'confirm', 'Someone else could decide this'))).body.message).toMatch(/ACV-0001 can decide it the normal way/);
    await prisma.employeeDuty.update({ where: { id: temporary.id }, data: { endedAt: new Date() } });
    expect((await want(409, decide(deal.A.id, 'confirm', 'An old version of the deal', 1))).body.code).toBe('stale_version');
    expect(await prisma.salesWonException.count()).toBe(0);
  });

  it('Confirm: Won with the Owner as confirmer, the insert-only record keeps the original request, one Module 13 draft invoice', async () => {
    await t.stepUp(OWNER);
    const before = await row(deal.A.id);
    const historyBefore = await prisma.salesDealHistory.findMany({ where: { dealId: deal.A.id }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    const res = (await want(200, decide(deal.A.id, 'confirm', 'Client signed; the Director who asked has left'))).body;
    expect(res).toMatchObject({ stage: 'won', wonStatus: 'confirmed', wonExceptionEligible: false });
    expect(await row(deal.A.id)).toMatchObject({ stage: 'won', wonConfirmedById: ids[OWNER], ownerId: ids[CTO], wonRequestedById: ids[DIRECTOR] });
    const x = await prisma.salesWonException.findFirstOrThrow({ where: { dealId: deal.A.id } });
    expect(x).toMatchObject({ decision: 'confirm', reason: 'Client signed; the Director who asked has left', basis: 'requester_left_no_confirmer', decidedById: ids[OWNER], requesterId: ids[DIRECTOR], ownerAtRequestId: ids[DIRECTOR], currentOwnerId: ids[CTO] });
    expect(x.requestedAt).toEqual(before.wonRequestedAt);
    // the earlier history is untouched; one new entry with the reason and the note
    const history = await prisma.salesDealHistory.findMany({ where: { dealId: deal.A.id }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    expect(history.slice(0, historyBefore.length)).toEqual(historyBefore);
    expect(history).toHaveLength(historyBefore.length + 1);
    expect(history.at(-1)).toMatchObject({ event: 'won_confirmed', actorId: ids[OWNER], reason: 'Client signed; the Director who asked has left', note: expect.stringMatching(/^Exceptional decision: ACV-0003/) });
    expect(historyBefore.map((h) => h.event)).toEqual(expect.arrayContaining(['won_requested', 'owner_changed']));
    expect(await prisma.auditLog.count({ where: { action: 'sales.deal.won_confirmed_exception', targetId: deal.A.number, actorId: ids[OWNER] } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'sales.deal.won_confirmed', targetId: deal.A.number } })).toBe(0);
    // exactly one event for Module 13, and exactly one draft invoice
    expect(await prisma.outboxEvent.count({ where: { type: 'sales.deal.won_confirmed', payload: { path: ['dealNumber'], equals: deal.A.number } } })).toBe(1);
    await runner.drain(BILLING_CONSUMER);
    await runner.drain(BILLING_CONSUMER);
    expect(await prisma.invoice.count({ where: { sourceDealNumber: deal.A.number } })).toBe(1);
    // Module 4 recorded it
    await t.app.get(ActivityRecorder).flush();
    expect(await prisma.activityEvent.count({ where: { module: 'Sales', employeeId: ids[OWNER], description: `Confirmed the deal ${deal.A.number} as Won (exceptional decision)` } })).toBe(1);
    // a second decision on the same deal is refused
    expect((await want(409, decide(deal.A.id, 'confirm', 'Again, by mistake'))).body.code).toBe('exception_not_applicable');
  });

  it('Send back: the deal stays open with its new owner; the record keeps who asked and when; the history keeps the reason', async () => {
    await t.stepUp(OWNER);
    const before = await row(deal.B.id);
    await want(200, decide(deal.B.id, 'send_back', 'Not signed yet; the new owner should ask again'));
    expect(await row(deal.B.id)).toMatchObject({ stage: before.stage, wonStatus: 'none', ownerId: ids[CTO], wonRequestedById: null, wonRequestedAt: null });
    const x = await prisma.salesWonException.findFirstOrThrow({ where: { dealId: deal.B.id } });
    expect(x).toMatchObject({ decision: 'send_back', requesterId: ids[DIRECTOR], ownerAtRequestId: ids[DIRECTOR], currentOwnerId: ids[CTO] });
    expect(x.requestedAt).toEqual(before.wonRequestedAt);
    expect((await prisma.salesDealHistory.findMany({ where: { dealId: deal.B.id }, orderBy: [{ at: 'asc' }, { id: 'asc' }] })).at(-1)).toMatchObject({ event: 'won_rejected', reason: 'Not signed yet; the new owner should ask again', note: expect.stringMatching(/^Exceptional decision/) });
    expect(await prisma.auditLog.count({ where: { action: 'sales.deal.won_rejected_exception', targetId: deal.B.number } })).toBe(1);
    expect(await prisma.outboxEvent.count({ where: { type: 'sales.deal.won_confirmed', payload: { path: ['dealNumber'], equals: deal.B.number } } })).toBe(0);
  });

  it('two decisions at the same moment: exactly one happens', async () => {
    await t.stepUp(OWNER);
    const v = await version(deal.C.id);
    const [a, b] = await Promise.all([decide(deal.C.id, 'confirm', 'First click', v), decide(deal.C.id, 'send_back', 'Second click', v)]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect(await prisma.salesWonException.count({ where: { dealId: deal.C.id } })).toBe(1);
    const winner = await prisma.salesWonException.findFirstOrThrow({ where: { dealId: deal.C.id } });
    expect(await prisma.outboxEvent.count({ where: { type: 'sales.deal.won_confirmed', payload: { path: ['dealNumber'], equals: deal.C.number } } })).toBe(winner.decision === 'confirm' ? 1 : 0);
  });

  it('the database: no Level 1 confirmation without the matching record of the same transaction; records are insert-only', async () => {
    const d = await row(deal.D.id);
    const confirm = { stage: 'won' as const, wonStatus: 'confirmed' as const, wonConfirmedById: ids[OWNER], wonConfirmedAt: new Date(), closedAt: new Date() };
    const record = (decision: string, dealId = deal.D.id) => ({ dealId, decision, reason: 'Direct database attempt', basis: 'requester_left_no_confirmer', decidedById: ids[OWNER], requesterId: ids[DIRECTOR], requestedAt: d.wonRequestedAt!, ownerAtRequestId: ids[DIRECTOR], currentOwnerId: ids[CTO], details: {} });
    // no record at all
    await expect(prisma.salesDeal.update({ where: { id: deal.D.id }, data: confirm })).rejects.toThrow(/owner_confirms_director_deals_only/);
    // a "send back" record in the same transaction does not let a confirmation through
    await expect(prisma.$transaction(async (tx) => { await tx.salesWonException.create({ data: record('send_back') }); await tx.salesDeal.update({ where: { id: deal.D.id }, data: confirm }); })).rejects.toThrow(/owner_confirms_director_deals_only/);
    // a record for another deal does not either
    await expect(prisma.$transaction(async (tx) => { await tx.salesWonException.create({ data: record('confirm', deal.B.id) }); await tx.salesDeal.update({ where: { id: deal.D.id }, data: confirm }); })).rejects.toThrow(/owner_confirms_director_deals_only/);
    // a record committed earlier (another transaction) does not either
    const earlier = await prisma.salesWonException.create({ data: record('confirm') });
    await expect(prisma.salesDeal.update({ where: { id: deal.D.id }, data: confirm })).rejects.toThrow(/owner_confirms_director_deals_only/);
    // insert-only, and the decider is never the current owner or the person who asked
    await expect(prisma.salesWonException.update({ where: { id: earlier.id }, data: { reason: 'Changed afterwards' } })).rejects.toThrow(/insert-only/);
    await expect(prisma.salesWonException.delete({ where: { id: earlier.id } })).rejects.toThrow(/insert-only/);
    await expect(prisma.salesWonException.create({ data: { ...record('send_back'), decidedById: ids[CTO] } })).rejects.toThrow();
    await expect(prisma.salesWonException.create({ data: { ...record('send_back'), decidedById: ids[DIRECTOR] } })).rejects.toThrow();
    expect(await row(deal.D.id)).toMatchObject({ wonStatus: 'pending' });
    // the normal B1 guard: still no Level 1 confirmation of a deal a Director does not own (Hira's)
    await expect(prisma.salesDeal.update({ where: { id: deal.K.id }, data: confirm })).rejects.toThrow(/owner_confirms_director_deals_only/);
  });
});
