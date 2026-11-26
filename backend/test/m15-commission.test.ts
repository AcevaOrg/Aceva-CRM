import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { BILLING_CONSUMER } from '../src/billing/billing-events.consumer';
import { addDays, dbDate, pkDate } from '../src/common/pakistan-time';
import { OutboxConsumerRunner } from '../src/events/outbox-consumer-runner.service';
import { OutboxService } from '../src/events/outbox.service';
import { Prisma, type PrismaClient } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { SALES_COMMISSION_CONSUMER, SalesCommissionService } from '../src/sales/sales-commission.service';
import { createTestApp, type SignedIn, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 15.7, sales commission (the approved and corrected M15.7 scope), against the real database:
 *  - one immutable baseline; only invoices whose completing payment was POSTED at or after it earn commission (never the
 *    event's handling time, never the payment's own date); the first rule starts on the baseline's business day;
 *  - eligibility fixed at Won confirmation (legacy deals: at the baseline); later role or department changes change nothing;
 *    only an earner who has LEFT is held (on notice is still employed);
 *  - the event and the daily reconciliation make one line per deal, idempotently;
 *  - the Director decides normal lines; only the Owner decides the Director's own and leaver-held lines (step-up, reason);
 *    the Director and the Finance duty hold or reject normal lines only;
 *  - access: own, team or all, 404 otherwise; the database freezes what was decided; no ledger writes, nothing marked as
 *    included in payroll.
 */
// Several tests run whole deal-to-payment flows (Won, invoice, payments, ledger approvals): more than the default 20 s.
vi.setConfig({ testTimeout: 90_000 });

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
let svc: SalesCommissionService;
let today = '';
let baselineDay = '';
const ids: Record<string, string> = {};
const acc: Record<string, string> = {};
type D = { id: string; number: string; leadId: string };

const as = (who: string) => t.as(who);
const put = (who: string, url: string) => request(t.app.getHttpServer()).put(url).set((t.as(who) as SignedIn).headers());
const inDays = (n: number) => addDays(today, n);
const dealRow = (id: string) => prisma.salesDeal.findUniqueOrThrow({ where: { id } });
const lineOf = (dealId: string) => prisma.salesCommissionLine.findUnique({ where: { dealId } });
const lineView = async (who: string, id: string) => (await as(who).get(`${API}/sales/commission/${id}`).expect(200)).body;
const drainBilling = async () => {
  await runner.drain(BILLING_CONSUMER);
  await runner.drain(BILLING_CONSUMER);
};
const drainAll = async () => {
  await drainBilling();
  await runner.drain(SALES_COMMISSION_CONSUMER);
};
const approveEntry = (entryId: string) => as(DIRECTOR).post(`${API}/journal-entries/${entryId}/approve`).send({}).expect(200);
const notes = (empId: string, type: string) => prisma.notification.findMany({ where: { recipientId: ids[empId], type }, orderBy: { createdAt: 'asc' } });
const skipped = (dealNumber: string, reason: string) => prisma.auditLog.count({ where: { action: 'sales.commission.skipped', targetId: dealNumber, reason } });
async function want(status: number, pending: Promise<{ status: number; body: Record<string, unknown> & { code?: string } }>) {
  const res = await pending;
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res;
}

let n = 0;
async function newDeal(who: string, currency: 'PKR' | 'USD', value: string): Promise<D> {
  n++;
  const site = `comm${n}.test`;
  const leadId = (await as(who).post(`${API}/sales/leads`).send({ source: 'referral', fullName: `Buyer ${n}`, email: `b${n}@${site}`, company: { name: `Commission Co ${n}`, website: site } }).expect(201)).body.id;
  const d = (await as(who).post(`${API}/sales/deals`).send({ leadId, service: 'website', value, currency, expectedClose: inDays(30), nextStep: 'Sign', nextStepDate: inDays(2) }).expect(201)).body;
  return { id: d.id, number: d.number, leadId };
}
async function requestWon(owner: string, d: D) {
  await as(owner).post(`${API}/sales/deals/${d.id}/request-won`).send({ version: (await dealRow(d.id)).version }).expect(200);
}
/** Confirmed by the Director (the Owner for a deal the Director owns, decision B1). */
async function confirmWon(owner: string, d: D) {
  const confirmer = owner === DIRECTOR ? OWNER : DIRECTOR;
  if (confirmer === OWNER) await t.stepUp(OWNER);
  await as(confirmer).post(`${API}/sales/deals/${d.id}/confirm-won`).send({ version: (await dealRow(d.id)).version }).expect(200);
}
async function won(owner: string, d: D) {
  await requestWon(owner, d);
  await confirmWon(owner, d);
}
/** Module 13 makes the draft; Finance confirms the new client and issues it; the Director approves its entry. */
async function issue(d: D, rate?: string): Promise<string> {
  await runner.drain(BILLING_CONSUMER);
  const inv = await prisma.invoice.findUniqueOrThrow({ where: { sourceDealNumber: d.number } });
  const profile = await prisma.billingProfile.findUnique({ where: { partyId: inv.partyId } });
  if (profile?.needsReview) await as(FINANCE).post(`${API}/billing/customers/${inv.partyId}/confirm`).send({}).expect(200);
  const issued = (await as(FINANCE).post(`${API}/billing/invoices/${inv.id}/issue`).send(rate ? { exchangeRate: rate } : {}).expect(200)).body;
  await approveEntry(issued.invoice.entryId);
  return inv.id;
}
/** A Module 9 payment against the invoice (USD at the given rate; a payment date may be given), approved (posted). */
async function pay(invoiceId: string, amount: string, opts: { rate?: string; date?: string } = {}) {
  const key = randomUUID();
  await as(FINANCE)
    .post(`${API}/billing/invoices/${invoiceId}/payments`)
    .send({ requestKey: key, bankAccountId: opts.rate ? acc['1110'] : acc['1100'], date: opts.date ?? today, amount, method: 'bank_transfer', reference: `T-${key.slice(0, 6)}`, ...(opts.rate ? { exchangeRate: opts.rate } : {}) })
    .expect(201);
  await approveEntry((await prisma.payment.findUniqueOrThrow({ where: { requestKey: key } })).journalEntryId!);
}
async function wonAndPaid(owner: string, value: string): Promise<D> {
  const d = await newDeal(owner, 'PKR', value);
  await won(owner, d);
  await pay(await issue(d), value);
  return d;
}
async function setRule(ratePercent: string, effectiveFrom: string, reason = 'Approved company commission rate') {
  await t.stepUp(DIRECTOR);
  return put(DIRECTOR, `${API}/sales/commission/rules`).send({ ratePercent, effectiveFrom, reason });
}
/** Past the 5-minute step-up window; the clock only moves forward (a sign-in never reuses an earlier code). */
async function stepUpExpires() {
  t.clock.advance(6 * 60_000);
  await t.signInAll();
}
const dec = (v: string) => new Prisma.Decimal(v);
const half = (v: Prisma.Decimal) => v.toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);

const deals: Record<string, D> = {};

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  prisma = createTestPrisma();
  runner = t.app.get(OutboxConsumerRunner);
  svc = t.app.get(SalesCommissionService);
  today = pkDate(t.clock.now());
  for (const e of await prisma.employee.findMany({ select: { id: true, empId: true } })) ids[e.empId] = e.id;
  for (const a of await prisma.ledgerAccount.findMany()) acc[a.code] = a.id;
  await drainAll();

  // Before the baseline: P0 is Won and fully paid (its "invoice paid" event is NOT handled yet: a delayed event);
  // LEG is Won but not paid yet (a legacy deal: no eligibility snapshot until the baseline).
  deals.P0 = await wonAndPaid(HIRA, '5000.00');
  await drainBilling();
  deals.LEG = await newDeal(SAAD, 'PKR', '2500.00');
  await won(SAAD, deals.LEG);
  expect(await prisma.salesCommissionEligibility.count()).toBe(0); // no snapshots before the baseline
  const b = await svc.recordBaseline();
  baselineDay = b.businessDay;
  expect(b.legacySnapshots).toBe(2);
}, 300000);
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M15.7 commission: baseline, payment time, rate', () => {
  it('the baseline is recorded once and never changes; deals Won before it get a legacy snapshot', async () => {
    const row = await prisma.salesCommissionBaseline.findUniqueOrThrow({ where: { id: 1 } });
    expect(pkDate(row.baselineAt)).toBe(baselineDay);
    const again = await svc.recordBaseline();
    expect(again).toMatchObject({ businessDay: baselineDay, legacySnapshots: 0 });
    expect(again.baselineAt.toISOString()).toBe(row.baselineAt.toISOString());
    await expect(prisma.salesCommissionBaseline.update({ where: { id: 1 }, data: { baselineAt: new Date(0) } })).rejects.toThrow();
    for (const k of ['P0', 'LEG']) expect(await prisma.salesCommissionEligibility.findUnique({ where: { dealId: deals[k].id } }), k).toMatchObject({ basis: 'legacy_baseline', eligible: true });
    expect(await prisma.auditLog.count({ where: { action: 'sales.commission.baseline_recorded' } })).toBe(1);
  });

  it('a delayed event changes nothing: P0 was fully paid (posted) before the baseline, so neither the reader nor the reconciliation makes a line', async () => {
    await runner.drain(SALES_COMMISSION_CONSUMER); // the delayed event is handled now, after the baseline
    expect(await lineOf(deals.P0.id)).toBeNull();
    expect(await skipped(deals.P0.number, 'paid_before_baseline')).toBe(1);
    await svc.reconcile();
    await svc.reconcile();
    expect(await lineOf(deals.P0.id)).toBeNull();
    expect(await skipped(deals.P0.number, 'paid_before_baseline')).toBe(1); // audited once
  });

  it('a legacy deal (Won before the baseline) paid after it earns, judged at the baseline; no rule yet: waiting for a rate', async () => {
    await pay(await issue(deals.LEG), '2500.00');
    deals.P1 = await newDeal(HIRA, 'PKR', '12345.65');
    await won(HIRA, deals.P1);
    await pay(await issue(deals.P1), '12345.65');
    await drainAll();
    expect(await lineOf(deals.LEG.id)).toMatchObject({ status: 'waiting_rate', amount: null, earnerId: ids[SAAD], source: 'event' });
    const p1 = await lineOf(deals.P1.id);
    expect(p1).toMatchObject({ status: 'waiting_rate', amount: null, ruleId: null, earnerId: ids[HIRA], wonOwnerId: ids[HIRA], invoiceCurrency: 'PKR' });
    expect(p1!.collectedBase.toFixed(2)).toBe('12345.65');
    expect((await lineView(DIRECTOR, p1!.id)).eligibility.basis).toBe('won_confirmation');
    expect((await lineView(DIRECTOR, (await lineOf(deals.LEG.id))!.id)).eligibility.basis).toBe('legacy_baseline');
  });

  it('rules: the Director only, step-up and reason; the FIRST rule must start on the baseline day; then waiting lines are calculated', async () => {
    const view = (await as(DIRECTOR).get(`${API}/sales/commission/rules`).expect(200)).body;
    expect(view).toMatchObject({ current: null, versions: [], baselineDay });
    await as(FINANCE).get(`${API}/sales/commission/rules`).expect(404);
    await as(HIRA).get(`${API}/sales/commission/rules`).expect(404);
    await as(OWNER).get(`${API}/sales/commission/rules`).expect(200);
    await t.stepUp(OWNER);
    await put(OWNER, `${API}/sales/commission/rules`).send({ ratePercent: '10', effectiveFrom: baselineDay, reason: 'Owner tries' }).expect(404);
    // no step-up yet in this suite for the Director
    const noStep = await put(DIRECTOR, `${API}/sales/commission/rules`).send({ ratePercent: '10', effectiveFrom: baselineDay, reason: 'No step-up' });
    expect([noStep.status, noStep.body.code]).toEqual([403, 'step_up_required']);
    await want(400, setRule('0', baselineDay));
    expect((await want(400, setRule('10', addDays(baselineDay, 1)))).body.code).toBe('first_rule_baseline_day');
    expect((await want(400, setRule('10', addDays(baselineDay, -1)))).body.code).toBe('first_rule_baseline_day');
    const set = (await want(200, setRule('10', baselineDay))).body;
    expect(set.current).toMatchObject({ version: 1, ratePercent: '10.00', effectiveFrom: baselineDay, setBy: { empId: DIRECTOR } });
    expect((await want(400, setRule('12', addDays(today, -1)))).body.code).toBe('rule_in_past');
    // 12345.65 x 10% = 1234.565, rounded half up to 1234.57
    const p1 = await lineOf(deals.P1.id);
    expect(p1).toMatchObject({ status: 'calculated', ruleVersion: 1 });
    expect(p1!.amount!.toFixed(2)).toBe('1234.57');
    expect((await lineOf(deals.LEG.id))!.amount!.toFixed(2)).toBe('250.00');
    expect(await prisma.auditLog.count({ where: { action: 'sales.commission.rule_set', targetId: '1' } })).toBe(1);
    expect((await notes(DIRECTOR, 'approval_waiting')).some((x) => x.dedupeKey === `sales_commission_approval:${p1!.id}`)).toBe(true);
    // the database refuses a rule before the baseline day
    await expect(prisma.salesCommissionRule.create({ data: { version: 99, ratePercent: dec('5'), effectiveFrom: dbDate(addDays(baselineDay, -1)), reason: 'Before the baseline', setById: ids[DIRECTOR] } })).rejects.toThrow(/commission_rule_before_baseline/);
  });

  it('a partial payment makes nothing; the payment that completes it makes the line', async () => {
    deals.P2 = await newDeal(SAAD, 'PKR', '8000.00');
    await won(SAAD, deals.P2);
    const inv = await issue(deals.P2);
    await pay(inv, '3000.00');
    await drainAll();
    await svc.reconcile();
    expect(await lineOf(deals.P2.id)).toBeNull();
    await pay(inv, '5000.00');
    await drainAll();
    const line = await lineOf(deals.P2.id);
    expect(line).toMatchObject({ status: 'calculated', earnerId: ids[SAAD] });
    expect(line!.amount!.toFixed(2)).toBe('800.00');
  });

  it('a backdated payment date changes nothing: the posting moment decides, and its day picks the rule', async () => {
    deals.BD = await newDeal(HIRA, 'PKR', '1000.00');
    await won(HIRA, deals.BD);
    await pay(await issue(deals.BD), '1000.00', { date: addDays(baselineDay, -20) });
    await drainAll();
    const line = await lineOf(deals.BD.id);
    expect(line).toMatchObject({ status: 'calculated', ruleVersion: 1 });
    expect(pkDate(line!.paidOn)).toBe(pkDate(line!.fullyPaidAt));
    expect(pkDate(line!.paidOn) >= baselineDay).toBe(true);
    const payEntry = await prisma.journalEntry.findFirstOrThrow({ where: { source: 'payment', postedAt: { not: null } }, orderBy: { postedAt: 'desc' } });
    expect(line!.fullyPaidAt.toISOString()).toBe(payEntry.postedAt!.toISOString());
  });

  it('USD: every posted allocation at its own payment rate, rounded half up per allocation; the commission is in PKR', async () => {
    deals.U1 = await newDeal(HIRA, 'USD', '1000.00');
    await won(HIRA, deals.U1);
    const inv = await issue(deals.U1, '280.000000');
    await pay(inv, '333.33', { rate: '278.555555' });
    await pay(inv, '666.67', { rate: '281.250001' });
    await drainAll();
    const line = await lineOf(deals.U1.id);
    const pkr = half(dec('333.33').times('278.555555')).plus(half(dec('666.67').times('281.250001')));
    expect(line).toMatchObject({ status: 'calculated', invoiceCurrency: 'USD', currency: 'PKR' });
    expect(line!.collectedBase.toFixed(2)).toBe('1000.00');
    expect(line!.basePkr.toFixed(2)).toBe(pkr.toFixed(2));
    expect(line!.amount!.toFixed(2)).toBe(half(pkr.times('10').dividedBy(100)).toFixed(2));
    const list = (await as(DIRECTOR).get(`${API}/sales/commission?status=calculated`).expect(200)).body;
    expect(list.totals.find((x: { status: string }) => x.status === 'calculated').collected.map((c: { currency: string }) => c.currency)).toEqual(['PKR', 'USD']);
  });
});

describe('M15.7 commission: duplicates and the reconciliation', () => {
  it('a repeated event, or two readers and the reconciliation at the same moment, never make a second line', async () => {
    const before = await prisma.salesCommissionLine.count();
    const number = (await prisma.invoice.findUniqueOrThrow({ where: { sourceDealNumber: deals.P2.number } })).number;
    const original = await prisma.outboxEvent.findFirstOrThrow({ where: { type: 'billing.invoice.paid', payload: { path: ['invoiceNumber'], equals: number } } });
    await t.app.get(OutboxService).emit({ type: 'billing.invoice.paid', actor: DIRECTOR, payload: original.payload as never });
    await drainAll();
    expect(await prisma.salesCommissionLine.count()).toBe(before);
    const db = t.app.get(PrismaService);
    deals.P3 = await wonAndPaid(KAMRAN, '1000.00');
    await drainBilling();
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { sourceDealNumber: deals.P3.number } });
    const ev = await prisma.outboxEvent.findFirstOrThrow({ where: { type: 'billing.invoice.paid', payload: { path: ['invoiceNumber'], equals: inv.number } } });
    const event = { id: ev.id, type: ev.type, version: ev.version, actor: ev.actor, occurredAt: ev.occurredAt.toISOString(), payload: ev.payload } as never;
    await Promise.all([db.$transaction((tx) => svc.onInvoicePaid(event, tx)), db.$transaction((tx) => svc.onInvoicePaid(event, tx)), svc.reconcile()]);
    expect(await prisma.salesCommissionLine.count({ where: { dealId: deals.P3.id } })).toBe(1);
    await runner.drain(SALES_COMMISSION_CONSUMER);
    expect(await prisma.salesCommissionLine.count({ where: { dealId: deals.P3.id } })).toBe(1);
  });

  it('a missed event: the reconciliation finds the invoice once (source reconciliation); later runs and the late event add nothing', async () => {
    deals.CU = await wonAndPaid(HIRA, '1800.00');
    await drainBilling(); // the "invoice paid" event exists, but the commission reader has not run
    const first = await svc.reconcile();
    expect(first.recorded).toBe(1);
    expect(await lineOf(deals.CU.id)).toMatchObject({ source: 'reconciliation', paidEventId: null, status: 'calculated' });
    expect((await svc.reconcile()).recorded).toBe(0);
    await runner.drain(SALES_COMMISSION_CONSUMER);
    expect(await prisma.salesCommissionLine.count({ where: { dealId: deals.CU.id } })).toBe(1);
  });
});

describe('M15.7 commission: eligibility frozen at Won; leavers', () => {
  it('the earner is the owner at Won confirmation: moving the lead afterwards changes nothing', async () => {
    deals.F1 = await newDeal(HIRA, 'PKR', '2000.00');
    await won(HIRA, deals.F1);
    const lead = await prisma.salesLead.findUniqueOrThrow({ where: { id: deals.F1.leadId } });
    await as(DIRECTOR).post(`${API}/sales/leads/${lead.id}/owner`).send({ toEmpId: SAAD, reason: 'Saad looks after this client now', version: lead.version }).expect(200);
    expect((await dealRow(deals.F1.id)).ownerId).toBe(ids[HIRA]);
    await pay(await issue(deals.F1), '2000.00');
    await drainAll();
    expect(await lineOf(deals.F1.id)).toMatchObject({ earnerId: ids[HIRA], wonOwnerId: ids[HIRA] });
  });

  it('a department change AFTER Won keeps the commission; not sales staff AT Won means no line (audited), whatever happens later', async () => {
    const hr = await prisma.department.findUniqueOrThrow({ where: { code: 'dep-hr' } });
    const sales = await prisma.department.findUniqueOrThrow({ where: { code: 'dep-sales' } });
    deals.E1 = await newDeal(SAAD, 'PKR', '1500.00');
    await won(SAAD, deals.E1);
    await prisma.employee.update({ where: { id: ids[SAAD] }, data: { departmentId: hr.id } });
    await pay(await issue(deals.E1), '1500.00');
    await drainAll();
    expect(await lineOf(deals.E1.id)).toMatchObject({ status: 'calculated', earnerId: ids[SAAD] });
    deals.E2 = await newDeal(HIRA, 'PKR', '1600.00');
    await requestWon(HIRA, deals.E2);
    await prisma.employee.update({ where: { id: ids[HIRA] }, data: { departmentId: hr.id } });
    await confirmWon(HIRA, deals.E2);
    await prisma.employee.update({ where: { id: ids[HIRA] }, data: { departmentId: sales.id } });
    await prisma.employee.update({ where: { id: ids[SAAD] }, data: { departmentId: sales.id } });
    expect(await prisma.salesCommissionEligibility.findUniqueOrThrow({ where: { dealId: deals.E2.id } })).toMatchObject({ eligible: false, basis: 'won_confirmation', departmentCode: 'dep-hr' });
    await pay(await issue(deals.E2), '1600.00');
    await drainAll();
    await svc.reconcile();
    expect(await lineOf(deals.E2.id)).toBeNull();
    expect(await skipped(deals.E2.number, 'earner_not_eligible_at_won')).toBe(1);
  });

  it('on notice is still employed (calculated, not held); a role change after Won changes nothing', async () => {
    deals.N1 = await newDeal(KAMRAN, 'PKR', '1200.00');
    await won(KAMRAN, deals.N1);
    const inv = await issue(deals.N1);
    const sales = await prisma.role.findUniqueOrThrow({ where: { key: 'sales' } });
    const finance = await prisma.role.findUniqueOrThrow({ where: { key: 'finance' } }); // Level 4, no sales rights
    await prisma.employee.update({ where: { id: ids[KAMRAN] }, data: { status: 'on_notice', roleId: finance.id } });
    await pay(inv, '1200.00');
    await drainAll();
    await prisma.employee.update({ where: { id: ids[KAMRAN] }, data: { status: 'active', roleId: sales.id } });
    expect(await lineOf(deals.N1.id)).toMatchObject({ status: 'calculated', holdReason: null, earnerId: ids[KAMRAN] });
  });

  it('LEFT before the invoice was paid: held for the Owner, who alone decides (step-up, reason), once; never moved to anyone', async () => {
    deals.L1 = await newDeal(KAMRAN, 'PKR', '3000.00');
    await won(KAMRAN, deals.L1);
    const inv = await issue(deals.L1);
    await prisma.employee.update({ where: { id: ids[KAMRAN] }, data: { status: 'left', lastWorkingDay: dbDate(inDays(-1)) } });
    await pay(inv, '3000.00');
    await drainAll();
    const line = (await lineOf(deals.L1.id))!;
    expect(line).toMatchObject({ status: 'held', holdReason: 'earner_left', earnerId: ids[KAMRAN] });
    expect(line.amount!.toFixed(2)).toBe('300.00');
    expect((await notes(OWNER, 'approval_waiting')).some((x) => x.dedupeKey === `sales_commission_leaver:${line.id}`)).toBe(true);
    await prisma.employee.update({ where: { id: ids[KAMRAN] }, data: { status: 'active', lastWorkingDay: null } }); // only so the test can sign everyone in
    expect((await as(DIRECTOR).post(`${API}/sales/commission/${line.id}/approve`).send({ version: line.version }).expect(409)).body.code).toBe('leaver_decision');
    await want(409, as(FINANCE).post(`${API}/sales/commission/${line.id}/reject`).send({ reason: 'Finance tries the leaver', version: line.version }));
    await as(DIRECTOR).post(`${API}/sales/commission/${line.id}/leaver-decision`).send({ decision: 'pay', reason: 'Pay in the final settlement', version: line.version }).expect(403);
    await stepUpExpires();
    expect((await as(OWNER).post(`${API}/sales/commission/${line.id}/leaver-decision`).send({ decision: 'pay', reason: 'Pay in the final settlement', version: line.version }).expect(403)).body.code).toBe('step_up_required');
    await t.stepUp(OWNER);
    const v = (await as(OWNER).post(`${API}/sales/commission/${line.id}/leaver-decision`).send({ decision: 'pay', reason: 'Pay in the final settlement', version: line.version }).expect(200)).body;
    expect(v).toMatchObject({ status: 'approved', leaverDecision: { decision: 'pay', by: { empId: OWNER }, reason: 'Pay in the final settlement' }, approval: { by: { empId: OWNER } } });
    await want(409, as(OWNER).post(`${API}/sales/commission/${line.id}/leaver-decision`).send({ decision: 'forfeit', reason: 'Changed my mind', version: v.version }));
    expect(await prisma.auditLog.count({ where: { action: 'sales.commission.leaver_decided', targetId: line.id } })).toBe(1);
  });
});

describe('M15.7 commission: decisions', () => {
  it('the Director approves a normal line (audited, history, the earner told, the approved event sent); never their own; no ledger writes', async () => {
    const line = (await lineOf(deals.P1.id))!;
    const entries = await prisma.journalEntry.count();
    await as(HIRA).post(`${API}/sales/commission/${line.id}/approve`).send({ version: line.version }).expect(403);
    await as(FINANCE).post(`${API}/sales/commission/${line.id}/approve`).send({ version: line.version }).expect(403);
    await want(409, as(DIRECTOR).post(`${API}/sales/commission/${line.id}/approve`).send({ version: line.version + 5 }));
    const v = (await as(DIRECTOR).post(`${API}/sales/commission/${line.id}/approve`).send({ version: line.version }).expect(200)).body;
    expect(v).toMatchObject({ status: 'approved', approval: { by: { empId: DIRECTOR }, payrollMonth: pkDate(t.clock.now()).slice(0, 7) }, amount: '1234.57', includedAt: null });
    expect(v.history.map((h: { event: string }) => h.event)).toEqual(['waiting_rate', 'calculated', 'approved']);
    expect(await prisma.auditLog.count({ where: { action: 'sales.commission.approved', targetId: line.id } })).toBe(1);
    expect((await notes(HIRA, 'sales_commission_decided')).length).toBeGreaterThan(0);
    const ev = await prisma.outboxEvent.findMany({ where: { type: 'sales.commission.approved' } });
    expect(ev.map((e) => (e.payload as { dealNumber: string }).dealNumber)).toContain(deals.P1.number);
    expect(await prisma.journalEntry.count()).toBe(entries);
  });

  it("the Director's own lines: only the Owner decides them (fresh step-up and a reason); Finance and the Director cannot hold, reject or approve", async () => {
    deals.DIR = await wonAndPaid(DIRECTOR, '4000.00');
    deals.DIR2 = await wonAndPaid(DIRECTOR, '4100.00');
    await drainAll();
    const own = (await lineOf(deals.DIR.id))!;
    const own2 = (await lineOf(deals.DIR2.id))!;
    expect(own).toMatchObject({ status: 'calculated', earnerId: ids[DIRECTOR] });
    expect((await notes(OWNER, 'approval_waiting')).some((x) => x.dedupeKey === `sales_commission_approval:${own.id}`)).toBe(true);
    expect((await notes(DIRECTOR, 'approval_waiting')).some((x) => x.dedupeKey === `sales_commission_approval:${own.id}`)).toBe(false);
    expect((await as(DIRECTOR).post(`${API}/sales/commission/${own.id}/approve`).send({ version: own.version }).expect(403)).body.code).toBe('self_approval');
    await as(FINANCE).post(`${API}/sales/commission/${own.id}/hold`).send({ reason: 'Finance tries to hold', version: own.version }).expect(403);
    await as(FINANCE).post(`${API}/sales/commission/${own.id}/reject`).send({ reason: 'Finance tries to reject', version: own.version }).expect(403);
    expect((await lineView(FINANCE, own.id)).can).toEqual({ approve: false, reject: false, hold: false, decideLeaver: false });
    const inbox = (await as(OWNER).get(`${API}/approvals`).expect(200)).body.items;
    expect(inbox.some((i: { id: string }) => i.id === `commission:${own.id}`)).toBe(true);
    expect((await as(OWNER).post(`${API}/approvals/commission:${own.id}/approve`).send({}).expect(409)).body.code).toBe('decide_on_commission_page');
    await stepUpExpires();
    expect((await as(OWNER).post(`${API}/sales/commission/${own.id}/approve`).send({ version: own.version, reason: 'Signed off by the Owner' }).expect(403)).body.code).toBe('step_up_required');
    await t.stepUp(OWNER);
    expect((await as(OWNER).post(`${API}/sales/commission/${own.id}/approve`).send({ version: own.version }).expect(400)).body.code).toBe('reason_required');
    const v = (await as(OWNER).post(`${API}/sales/commission/${own.id}/approve`).send({ version: own.version, reason: 'Signed off by the Owner' }).expect(200)).body;
    expect(v).toMatchObject({ status: 'approved', approval: { by: { empId: OWNER } } });
    const r = (await as(OWNER).post(`${API}/sales/commission/${own2.id}/reject`).send({ reason: 'Not a new client after all', version: own2.version }).expect(200)).body;
    expect(r).toMatchObject({ status: 'rejected', rejection: { by: { empId: OWNER }, reason: 'Not a new client after all' } });
    expect(await prisma.auditLog.count({ where: { action: 'sales.commission.rejected', targetId: own2.id, actorId: ids[OWNER] } })).toBe(1);
    const p2 = (await lineOf(deals.P2.id))!;
    await as(OWNER).post(`${API}/sales/commission/${p2.id}/approve`).send({ version: p2.version, reason: 'Owner tries a normal line' }).expect(403);
  });

  it('the Director approves a normal line through the approvals inbox', async () => {
    const p2 = (await lineOf(deals.P2.id))!;
    const inbox = (await as(DIRECTOR).get(`${API}/approvals`).expect(200)).body.items;
    expect(inbox.some((i: { id: string }) => i.id === `commission:${p2.id}`)).toBe(true);
    await as(DIRECTOR).post(`${API}/approvals/commission:${p2.id}/approve`).send({}).expect(200);
    expect(await lineOf(deals.P2.id)).toMatchObject({ status: 'approved', approvedById: ids[DIRECTOR] });
  });

  it('Finance holds an approved normal line (refund or reversal), the Director approves it again; Finance rejects; a rejected line is final', async () => {
    const line = (await lineOf(deals.U1.id))!;
    await as(DIRECTOR).post(`${API}/sales/commission/${line.id}/approve`).send({ version: line.version }).expect(200);
    let cur = (await lineOf(deals.U1.id))!;
    await want(400, as(FINANCE).post(`${API}/sales/commission/${line.id}/hold`).send({ reason: 'x', version: cur.version }));
    await as(HIRA).post(`${API}/sales/commission/${line.id}/hold`).send({ reason: 'I hold my own', version: cur.version }).expect(403);
    const held = (await as(FINANCE).post(`${API}/sales/commission/${line.id}/hold`).send({ reason: 'The client asked for a refund', version: cur.version }).expect(200)).body;
    expect(held).toMatchObject({ status: 'held', hold: { reason: 'manual', note: 'The client asked for a refund', by: { empId: FINANCE } } });
    cur = (await lineOf(deals.U1.id))!;
    await as(DIRECTOR).post(`${API}/sales/commission/${line.id}/approve`).send({ version: cur.version }).expect(200);
    cur = (await lineOf(deals.U1.id))!;
    const rejected = (await as(FINANCE).post(`${API}/sales/commission/${line.id}/reject`).send({ reason: 'The payment was reversed in the ledger', version: cur.version }).expect(200)).body;
    expect(rejected).toMatchObject({ status: 'rejected', rejection: { by: { empId: FINANCE } } });
    cur = (await lineOf(deals.U1.id))!;
    await want(409, as(DIRECTOR).post(`${API}/sales/commission/${line.id}/approve`).send({ version: cur.version }));
    const told = await notes(HIRA, 'sales_commission_decided');
    expect(told.map((x) => x.title)).toEqual(expect.arrayContaining([`Commission on ${deals.U1.number} is on hold`, `Commission on ${deals.U1.number} was rejected`]));
  });
});

describe('M15.7 commission: access and database rules', () => {
  it('own lines for a salesperson, team lines for a sales manager, all for the Director, Owner and Finance; 404 for everyone else', async () => {
    const p1 = (await lineOf(deals.P1.id))!;
    await as(DEV).get(`${API}/sales/commission`).expect(404);
    await as(DEV).get(`${API}/sales/commission/${p1.id}`).expect(404);
    const mine = (await as(SAAD).get(`${API}/sales/commission`).expect(200)).body;
    expect(mine.scope).toBe('own');
    expect(mine.lines.every((l: { earner: { empId: string } }) => l.earner.empId === SAAD)).toBe(true);
    await as(SAAD).get(`${API}/sales/commission/${p1.id}`).expect(404);
    const duty = await prisma.duty.findUniqueOrThrow({ where: { key: 'sales_manager' } });
    const held = await prisma.employeeDuty.create({ data: { employeeId: ids[CTO], dutyId: duty.id } });
    expect((await as(CTO).get(`${API}/sales/commission`).expect(200)).body).toMatchObject({ scope: 'team', lines: [] });
    await prisma.employeeDuty.update({ where: { id: held.id }, data: { endedAt: new Date() } });
    for (const who of [DIRECTOR, OWNER, FINANCE]) expect((await as(who).get(`${API}/sales/commission`).expect(200)).body.scope, who).toBe('all');
    expect(await lineView(FINANCE, (await lineOf(deals.P2.id))!.id)).toMatchObject({ status: 'approved', includedAt: null, can: { approve: false, hold: true } });
    expect(await prisma.salesCommissionLine.count({ where: { status: 'included' } })).toBe(0); // only the separate M8 change includes lines
  });

  it('the database: insert-only rules, snapshots and history; frozen lines and approvals; the baseline boundary; no self-approval; no delete', async () => {
    const line = (await lineOf(deals.P2.id))!;
    const fails = async (p: Promise<unknown>, text: RegExp) => expect(p).rejects.toThrow(text);
    await fails(prisma.salesCommissionRule.updateMany({ data: { ratePercent: dec('20') } }), /modif|insert-only|not allowed/i);
    await fails(prisma.salesCommissionEligibility.updateMany({ data: { eligible: false } }), /modif|insert-only|not allowed/i);
    await fails(prisma.salesCommissionLineEvent.deleteMany({ where: { lineId: line.id } }), /modif|insert-only|not allowed/i);
    await fails(prisma.salesCommissionLine.update({ where: { id: line.id }, data: { amount: dec('1.00'), version: { increment: 1 } } }), /commission_amount_frozen/);
    await fails(prisma.salesCommissionLine.update({ where: { id: line.id }, data: { fullyPaidAt: new Date(0), version: { increment: 1 } } }), /commission_line_frozen/);
    await fails(prisma.salesCommissionLine.update({ where: { id: line.id }, data: { payrollMonth: '2030-01', version: { increment: 1 } } }), /commission_invalid_transition/);
    await fails(
      prisma.salesCommissionLine.update({ where: { id: line.id }, data: { status: 'held', holdReason: 'manual', holdNote: 'Testing the freeze', heldById: ids[FINANCE], heldAt: new Date(), payrollMonth: '2030-01', version: { increment: 1 } } }),
      /commission_approval_frozen/,
    );
    await fails(prisma.salesCommissionLine.delete({ where: { id: line.id } }), /delete|not allowed|cannot/i);
    const f1 = (await lineOf(deals.F1.id))!;
    await fails(prisma.salesCommissionLine.update({ where: { id: f1.id }, data: { status: 'approved', approvedById: ids[HIRA], approvedAt: new Date(), payrollMonth: '2026-12', version: { increment: 1 } } }), /not_self/);
    // a line needs the eligible snapshot of its deal, and a completing payment posted at or after the baseline
    const e2 = await prisma.salesCommissionEligibility.findUniqueOrThrow({ where: { dealId: deals.E2.id } });
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { sourceDealNumber: deals.E2.number } });
    const base = { source: 'reconciliation' as const, earnerId: ids[HIRA], wonOwnerId: ids[HIRA], invoiceCurrency: 'PKR' as const, collectedBase: dec('1600'), basePkr: dec('1600'), status: 'waiting_rate' as const };
    const now = t.clock.now();
    await fails(prisma.salesCommissionLine.create({ data: { ...base, dealId: deals.E2.id, invoiceId: inv.id, eligibilityId: e2.id, fullyPaidAt: now, paidOn: dbDate(pkDate(now)) } }), /commission_not_eligible/);
    const p0snap = await prisma.salesCommissionEligibility.findUniqueOrThrow({ where: { dealId: deals.P0.id } });
    const p0inv = await prisma.invoice.findUniqueOrThrow({ where: { sourceDealNumber: deals.P0.number } });
    const old = new Date((await prisma.salesCommissionBaseline.findUniqueOrThrow({ where: { id: 1 } })).baselineAt.getTime() - 60_000);
    await fails(prisma.salesCommissionLine.create({ data: { ...base, dealId: deals.P0.id, invoiceId: p0inv.id, eligibilityId: p0snap.id, fullyPaidAt: old, paidOn: dbDate(pkDate(old)) } }), /commission_before_baseline/);
  });
});
