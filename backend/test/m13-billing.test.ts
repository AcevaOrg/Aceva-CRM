import { randomUUID } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { addMonths } from '../src/billing/billing-dates';
import { BillingDailyService } from '../src/billing/billing-daily.service';
import { BILLING_CONSUMER } from '../src/billing/billing-events.consumer';
import { BillingService } from '../src/billing/billing.service';
import { CustomerEmailService } from '../src/billing/customer-email.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { addDays, pkDate } from '../src/common/pakistan-time';
import { OutboxConsumerRunner } from '../src/events/outbox-consumer-runner.service';
import { OutboxService } from '../src/events/outbox.service';
import { createTestApp, type SignedIn, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 13: customer billing, subscriptions and renewal management (plan section 18), against the real database.
 * Module 9 stays the only writer of money: a draft has no ledger entry; issuing creates the entry and it waits for the
 * Director's approval; cancelling a posted invoice is a reversing entry; payments are Module 9 payments.
 */
const API = '/api/v1';
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003';
const DEV = 'ACV-0006';
const FINANCE = 'ACV-0010';
let CEO = '';

let t: TestApp;
let prisma: PrismaClient;
let runner: OutboxConsumerRunner;
let outbox: OutboxService;
let daily: BillingDailyService;
let mail: CustomerEmailService;
const acc: Record<string, string> = {};
const ids: Record<string, string> = {};
const today = pkDate(new Date());

const fin = () => t.as(FINANCE);
const put = (who: string, url: string) => request(t.app.getHttpServer()).put(url).set((t.as(who) as SignedIn).headers());
const approve = async (entryId: string, who = DIRECTOR) => (await t.as(who).post(`${API}/journal-entries/${entryId}/approve`).send({}).expect(200)).body;
const drain = () => runner.drain(BILLING_CONSUMER);
const detail = async (id: string) => (await fin().get(`${API}/billing/invoices/${id}`).expect(200)).body;
const notes = async (empId: string, type: string) => prisma.notification.findMany({ where: { recipientId: ids[empId], type }, orderBy: { createdAt: 'asc' } });
const events = async (type: string) => prisma.outboxEvent.findMany({ where: { type }, orderBy: { createdAt: 'asc' } });

let client = '';
let clientEmail = '';

async function draft(over: Record<string, unknown> = {}) {
  return (
    await fin()
      .post(`${API}/billing/invoices`)
      .send({ requestKey: randomUUID(), partyId: client, issueDate: today, termsDays: 14, currency: 'PKR', lines: [{ description: 'Website build', quantity: '1', unitPrice: '10000.00' }], ...over })
      .expect(201)
  ).body;
}

async function issued(over: Record<string, unknown> = {}) {
  const d = await draft(over);
  return (await fin().post(`${API}/billing/invoices/${d.invoice.id}/issue`).send({}).expect(200)).body;
}

async function billingSettings(value: Record<string, unknown>) {
  const current = (await t.as(DIRECTOR).get(`${API}/settings/modules/billing`).expect(200)).body;
  await t.stepUp(DIRECTOR);
  return put(DIRECTOR, `${API}/settings/modules/billing`).send({ value: { ...current.value, ...value }, version: current.version, reason: 'Billing test settings' });
}

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  CEO = OWNER; // final company structure (main): the CEO, Founder and Owner are one person, ACV-0001
  prisma = createTestPrisma();
  runner = t.app.get(OutboxConsumerRunner);
  outbox = t.app.get(OutboxService);
  daily = t.app.get(BillingDailyService);
  mail = t.app.get(CustomerEmailService);
  for (const a of await prisma.ledgerAccount.findMany()) acc[a.code] = a.id;
  for (const e of await prisma.employee.findMany({ select: { id: true, empId: true } })) ids[e.empId] = e.id;
  await drain(); // the reader starts here
  clientEmail = 'accounts@northwind.test';
}, 180000);
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M13 access: finance screens, server-side', () => {
  it('billing answers "not found" without billing.view; viewers cannot change anything; the finance duty person manages', async () => {
    await t.as(DEV).get(`${API}/billing/invoices`).expect(404);
    await t.as(DEV).get(`${API}/billing/subscriptions`).expect(404);
    await t.as(CEO).get(`${API}/billing/invoices`).expect(200); // the CEO views
    await t.as(DIRECTOR).get(`${API}/billing/overview`).expect(200);
    // creating is the finance duty person's (billing.manage): the Director and the CEO only view
    await t.as(DIRECTOR).post(`${API}/billing/customers`).send({ name: 'Nope Ltd' }).expect(404);
    await t.as(CEO).post(`${API}/billing/invoices`).send({}).expect(404);
    const c = (await fin().post(`${API}/billing/customers`).send({ name: 'Northwind Traders', contactName: 'Ayesha Khan', email: clientEmail, currency: 'PKR', termsDays: 14, taxId: 'NTN-1' }).expect(201)).body;
    expect(c).toMatchObject({ name: 'Northwind Traders', contactName: 'Ayesha Khan', termsDays: 14, invoiceCount: 0, outstanding: '0.00' });
    client = c.id;
    expect(await prisma.party.count({ where: { id: client, kind: 'client' } })).toBe(1); // a Module 9 client, not a second customer table
    expect(await prisma.auditLog.count({ where: { action: 'billing.customer.created', targetId: client } })).toBe(1);
  });

  it('the finance idle limit applies: after 10 minutes without activity a billing request needs a new login', async () => {
    t.clock.advance(11 * 60_000);
    await fin().get(`${API}/billing/invoices`).expect(401);
    t.clock.reset();
    await t.signInAll();
    await fin().get(`${API}/billing/invoices`).expect(200);
  });
});

describe('M13 invoices extend Module 9: draft, issue, payments', () => {
  let id = '';

  it('a draft has a DRAFT number and NO ledger entry; a retried create returns the same draft; Module 9 lists do not show drafts', async () => {
    const entriesBefore = await prisma.journalEntry.count();
    const key = randomUUID();
    const body = { requestKey: key, partyId: client, issueDate: today, termsDays: 14, currency: 'PKR', lines: [{ description: 'Design', quantity: '2', unitPrice: '1500.50' }, { description: 'Hosting', quantity: '1', unitPrice: '999.99' }] };
    const first = (await fin().post(`${API}/billing/invoices`).send(body).expect(201)).body;
    const again = (await fin().post(`${API}/billing/invoices`).send(body).expect(201)).body;
    id = first.invoice.id;
    expect(again.invoice.id).toBe(id);
    expect(first.invoice).toMatchObject({ status: 'draft', total: '4000.99', entryId: null, kind: 'one_time', reminderOffsets: [-3, 0, 3, 7], assignedToEmpId: FINANCE });
    expect(first.invoice.number).toMatch(/^DRAFT-[0-9A-F]{8}$/);
    expect(first.invoice.lines.map((l: { accountCode: string }) => l.accountCode)).toEqual(['4100', '4100']); // the default income account
    expect(await prisma.journalEntry.count()).toBe(entriesBefore); // nothing in the ledger
    expect(await prisma.invoice.count({ where: { requestKey: key } })).toBe(1);
    expect((await fin().get(`${API}/invoices`).expect(200)).body.items.map((i: { id: string }) => i.id)).not.toContain(id);
  });

  it('a draft can be edited; payments cannot be recorded against it', async () => {
    const d = (await fin().patch(`${API}/billing/invoices/${id}`).send({ partyId: client, issueDate: today, termsDays: 10, currency: 'PKR', lines: [{ description: 'Design and build', quantity: '1', unitPrice: '12000.00' }] }).expect(200)).body;
    expect(d.invoice).toMatchObject({ total: '12000.00', termsDays: 10, dueDate: addDays(today, 10) });
    const pay = await fin().post(`${API}/billing/invoices/${id}/payments`).send({ requestKey: randomUUID(), bankAccountId: acc['1100'], date: today, amount: '100.00', method: 'bank_transfer' }).expect(409);
    expect(pay.body.message).toContain('Issue the invoice');
  });

  it('issuing numbers it INV-YYYY-NNNN, creates the Dr receivable / Cr income entry WAITING for approval, and schedules 8 reminders', async () => {
    const d = (await fin().post(`${API}/billing/invoices/${id}/issue`).send({}).expect(200)).body;
    expect(d.invoice.number).toMatch(new RegExp(`^INV-${today.slice(0, 4)}-\\d{4}$`));
    expect(d.invoice).toMatchObject({ status: 'issued', issueDate: today, dueDate: addDays(today, 10), entryStatus: 'pending_approval', issuedByEmpId: FINANCE, balance: '12000.00' });
    const entry = await prisma.journalEntry.findUniqueOrThrow({ where: { id: d.invoice.entryId }, include: { lines: { include: { account: true }, orderBy: { lineNo: 'asc' } } } });
    expect(entry).toMatchObject({ source: 'invoice', sourceRef: id, status: 'pending_approval', makerId: ids[FINANCE] });
    expect(entry.lines.map((l) => [l.account.systemRole ?? l.account.code, l.debit.toFixed(2), l.credit.toFixed(2)])).toEqual([
      ['accounts_receivable', '12000.00', '0.00'],
      ['4100', '0.00', '12000.00'],
    ]);
    expect(d.reminders).toHaveLength(8);
    expect(d.reminders.filter((r: { status: string }) => r.status === 'scheduled')).toHaveLength(8);
    expect(d.reminders.map((r: { scheduledFor: string }) => r.scheduledFor)).toContain(addDays(today, 7)); // 3 days before the due date
    expect(d.emails).toHaveLength(0); // customer emails are off until the sending address is set
    expect((await events('billing.invoice.issued')).map((e) => (e.payload as { invoiceNumber: string }).invoiceNumber)).toContain(d.invoice.number);
    expect(await prisma.auditLog.count({ where: { action: 'finance.invoice.issued', targetId: d.invoice.number } })).toBe(1);
    // issued once only; an issued invoice is not edited
    expect((await fin().post(`${API}/billing/invoices/${id}/issue`).send({}).expect(409)).body.code).toBe('invalid_transition');
    await fin().patch(`${API}/billing/invoices/${id}`).send({ partyId: client, issueDate: today, termsDays: 10, currency: 'PKR', lines: [{ description: 'x', quantity: '1', unitPrice: '1.00' }] }).expect(409);
  });

  it('the database itself refuses changing the amounts or lines of an issued invoice, or deleting it', async () => {
    await expect(prisma.invoice.update({ where: { id }, data: { total: '1.00' } })).rejects.toThrow(/invoice_issued/);
    await expect(prisma.invoiceLine.updateMany({ where: { invoiceId: id }, data: { amount: '1.00' } })).rejects.toThrow(/invoice_issued/);
    await expect(prisma.invoice.delete({ where: { id } })).rejects.toThrow(/invoice_issued/);
  });

  it('the issuer cannot approve the entry; the Director approves it (posted)', async () => {
    const d = await detail(id);
    await fin().post(`${API}/journal-entries/${d.invoice.entryId}/approve`).send({}).expect(404); // Finance has no approval permission
    await t.stepUp(DIRECTOR);
    await approve(d.invoice.entryId);
    expect((await detail(id)).invoice.entryStatus).toBe('posted');
  });

  it('a payment is a Module 9 payment waiting for approval; a retry with the same key records nothing more; a card number is refused', async () => {
    const key = randomUUID();
    const body = { requestKey: key, bankAccountId: acc['1100'], date: today, amount: '5000.00', method: 'bank_transfer', reference: 'TT-778' };
    const r1 = (await fin().post(`${API}/billing/invoices/${id}/payments`).send(body).expect(201)).body;
    await fin().post(`${API}/billing/invoices/${id}/payments`).send(body).expect(201);
    expect(await prisma.payment.count({ where: { requestKey: key } })).toBe(1);
    expect(r1.payments).toHaveLength(1);
    expect(r1.payments[0]).toMatchObject({ amount: '5000.00', method: 'bank_transfer', reference: 'TT-778', entryStatus: 'pending_approval' });
    // not paid until the payment's entry is posted
    expect(r1.invoice).toMatchObject({ status: 'issued', paid: '0.00', pendingPayments: '5000.00', balance: '12000.00' });
    const card = await fin().post(`${API}/billing/invoices/${id}/payments`).send({ ...body, requestKey: randomUUID(), reference: '4111 1111 1111 1111' }).expect(400);
    expect(JSON.stringify(card.body)).toContain('card number');
    // more than is still open is refused by Module 9
    await fin().post(`${API}/billing/invoices/${id}/payments`).send({ ...body, requestKey: randomUUID(), amount: '7000.01' }).expect(400);

    await approve((await prisma.payment.findUniqueOrThrow({ where: { requestKey: key } })).journalEntryId!);
    expect((await detail(id)).invoice).toMatchObject({ status: 'part_paid', paid: '5000.00', balance: '7000.00', pendingPayments: '0.00' });
    await drain();
    expect(await events('billing.invoice.paid')).toHaveLength(0); // part paid is not paid
  });

  it('when the last payment is posted: the "invoice paid" event once, remaining reminders stopped, and never sent', async () => {
    const key = randomUUID();
    await fin().post(`${API}/billing/invoices/${id}/payments`).send({ requestKey: key, bankAccountId: acc['1100'], date: today, amount: '7000.00', method: 'cheque', reference: 'CHQ-12' }).expect(201);
    // while the payment waits for approval, the reminder is not sent either
    const before = await daily.runReminders(addDays(today, 7));
    expect(before.sent).toBe(0);
    await approve((await prisma.payment.findUniqueOrThrow({ where: { requestKey: key } })).journalEntryId!);
    expect((await drain())[BILLING_CONSUMER]).toMatchObject({ done: expect.any(Number) });
    await drain();
    const paid = await events('billing.invoice.paid');
    expect(paid).toHaveLength(1);
    expect(paid[0].payload).toMatchObject({ invoiceNumber: (await detail(id)).invoice.number, paidOn: today, sourceDealNumber: null, firstForClient: true });
    const d = await detail(id);
    expect(d.invoice.status).toBe('paid');
    expect(d.reminders.every((r: { status: string }) => r.status === 'skipped')).toBe(true);
    expect(await daily.runReminders(addDays(today, 30))).toMatchObject({ sent: 0 });
    expect(await notes(FINANCE, 'invoice_due')).toHaveLength(0);
  });
});

describe('M13 reminders: 3 days before, on the due date, 3 and 7 days after; to the client and the assigned staff member', () => {
  let id = '';
  let due = '';
  let num = '';

  it('while the entry waits for approval: the staff member is reminded; the client gets nothing (recorded as skipped)', async () => {
    const d = await issued({ termsDays: 5 });
    id = d.invoice.id;
    due = d.invoice.dueDate;
    num = d.invoice.number;
    const r = await daily.runReminders(addDays(due, -3));
    expect(r.sent).toBe(1);
    const n = await notes(FINANCE, 'invoice_due');
    expect(n).toHaveLength(1);
    expect(n[0]).toMatchObject({ title: `Invoice ${d.invoice.number} is due in 3 days`, link: `/billing/invoices/${id}` });
    const rem = (await detail(id)).reminders.filter((x: { offsetDays: number }) => x.offsetDays === -3);
    expect(rem.find((x: { audience: string }) => x.audience === 'customer')).toMatchObject({ status: 'skipped', reason: 'The ledger entry of the invoice is not approved yet' });
    // the same day again: nothing new
    expect(await daily.runReminders(addDays(due, -3))).toMatchObject({ sent: 0 });
    expect(await notes(FINANCE, 'invoice_due')).toHaveLength(1);
    // approved while customer emails are off: nothing is queued for the client (it can be emailed by hand later)
    await t.stepUp(DIRECTOR);
    await approve(d.invoice.entryId);
    await drain();
    expect(await prisma.billingCustomerEmail.count({ where: { invoiceId: id } })).toBe(0);
  });

  it('customer emails cannot be switched on without the real sending address and company name; changing settings needs "confirm again"', async () => {
    const current = (await t.as(DIRECTOR).get(`${API}/settings/modules/billing`).expect(200)).body;
    expect(current.value).toMatchObject({ customerEmails: { enabled: false, fromAddress: null }, company: { legalName: null }, reminderOffsets: [-3, 0, 3, 7] });
    await t.as(CEO).get(`${API}/settings/modules/billing`).expect(200); // viewers see them
    const refused = await billingSettings({ customerEmails: { enabled: true, fromAddress: null, replyTo: null } });
    expect(refused.status).toBe(400);
    // Finance sees them but cannot change them (settings.manage is the Director's)
    expect((await put(FINANCE, `${API}/settings/modules/billing`).send({ value: current.value, version: current.version, reason: 'Finance tries' })).status).toBe(403);
    const ok = await billingSettings({ company: { ...current.value.company, legalName: 'Test Company (Pvt) Ltd', paymentDetails: 'Bank: Test Bank' }, customerEmails: { enabled: true, fromAddress: 'billing@company.test', replyTo: 'accounts@company.test' } });
    expect(ok.status).toBe(200);
    expect(await prisma.auditLog.count({ where: { action: 'settings.module.changed', targetId: 'billing' } })).toBe(1);
  });

  it('on the due date: the client gets one email from the configured address; the staff member one notification', async () => {
    t.mailer.clear();
    expect(await daily.runReminders(due)).toMatchObject({ sent: 2 });
    expect(await mail.drain()).toMatchObject({ sent: 1 });
    const m = t.mailer.lastTo(clientEmail)!;
    expect(m).toMatchObject({ from: 'billing@company.test', replyTo: 'accounts@company.test' });
    expect(m.subject).toContain('is due');
    expect(m.text).toContain('is due today');
    expect(m.text).toContain('Test Company (Pvt) Ltd');
    // retries of both stages send nothing more
    await daily.runReminders(due);
    await mail.drain();
    expect(t.mailer.sent.filter((x) => x.to === clientEmail)).toHaveLength(1);
    expect(await notes(FINANCE, 'invoice_due')).toHaveLength(2);
  });

  it('after the due date: overdue reminders, the overdue event once; missed days send only the latest reminder', async () => {
    expect(await daily.runOverdue(addDays(due, 1))).toBe(1);
    expect(await daily.runOverdue(addDays(due, 2))).toBe(0);
    const ev = (await events('billing.invoice.overdue')).filter((e) => (e.payload as { invoiceNumber: string }).invoiceNumber === num);
    expect(ev.map((e) => e.payload)).toEqual([{ invoiceNumber: num, dueDate: due, daysOverdue: 1 }]);
    // the server "was down" from day +3: on day +7 only the +7 reminder goes out; +3 is replaced
    t.mailer.clear();
    const r = await daily.runReminders(addDays(due, 7));
    expect(r).toMatchObject({ sent: 2, skipped: 2 });
    await mail.drain();
    expect(t.mailer.sent.filter((x) => x.to === clientEmail)).toHaveLength(1);
    expect(t.mailer.lastTo(clientEmail)!.text).toContain(`was due on ${due}`);
    const overdue = await notes(FINANCE, 'invoice_overdue');
    expect(overdue.map((n) => n.title)).toEqual([expect.stringContaining('is 7 days overdue')]);
    const d = await detail(id); // (its shown status follows the real date, so it is not checked here)
    expect(d.reminders.filter((x: { offsetDays: number }) => x.offsetDays === 3).every((x: { reason: string }) => x.reason === 'A later reminder replaced it')).toBe(true);
  });

  it('a reminder email queued before the invoice was paid is not sent once it is paid', async () => {
    const d = await issued({ termsDays: 3 });
    await t.stepUp(DIRECTOR);
    await approve(d.invoice.entryId);
    await daily.runReminders(d.invoice.dueDate); // queues the client email
    const key = randomUUID();
    await fin().post(`${API}/billing/invoices/${d.invoice.id}/payments`).send({ requestKey: key, bankAccountId: acc['1100'], date: today, amount: '10000.00', method: 'bank_transfer' }).expect(201);
    t.mailer.clear();
    await mail.drain();
    // the payment is recorded and waits for approval: no reminder
    expect(t.mailer.sent.filter((m) => m.subject.startsWith('Reminder'))).toHaveLength(0);
    const emails = (await detail(d.invoice.id)).emails;
    expect(emails.some((e: { kind: string; status: string }) => e.kind === 'reminder' && e.status === 'skipped')).toBe(true);
  });

  it('issuing does NOT email the client: nothing while the entry waits for approval, and it cannot be emailed by hand yet', async () => {
    t.mailer.clear();
    const d = await issued();
    expect(d.emails).toHaveLength(0);
    await drain();
    await mail.drain();
    expect(await prisma.billingCustomerEmail.count({ where: { invoiceId: d.invoice.id } })).toBe(0);
    expect((await fin().post(`${API}/billing/invoices/${d.invoice.id}/email`).send({}).expect(409)).body.code).toBe('entry_not_approved');
    expect(t.mailer.sent.filter((m) => m.subject.startsWith(`Invoice ${d.invoice.number}`))).toHaveLength(0);
  });

  it('a rejected entry never emails the client', async () => {
    t.mailer.clear();
    const d = await issued();
    await t.as(DIRECTOR).post(`${API}/journal-entries/${d.invoice.entryId}/reject`).send({ reason: 'Wrong amount on the invoice' }).expect(200);
    await drain();
    await mail.drain();
    expect(await prisma.billingCustomerEmail.count({ where: { invoiceId: d.invoice.id } })).toBe(0);
    expect((await fin().post(`${API}/billing/invoices/${d.invoice.id}/email`).send({}).expect(409)).body.code).toBe('entry_not_approved');
    expect(t.mailer.sent).toHaveLength(0);
  });

  it('the approval of the entry emails the client exactly once, even when the event is processed again', async () => {
    t.mailer.clear();
    const d = await issued();
    await t.stepUp(DIRECTOR);
    await approve(d.invoice.entryId);
    await drain();
    await drain();
    const rows = await prisma.billingCustomerEmail.findMany({ where: { invoiceId: d.invoice.id } });
    expect(rows.map((r) => [r.kind, r.dedupeKey, r.status])).toEqual([['invoice', `invoice:${d.invoice.id}`, 'pending']]);
    // the same approval handled a second time (a retried event): nothing more is queued
    const svc = t.app.get(BillingService);
    const again = await t.app.get(PrismaService).$transaction((tx) => svc.onInvoiceEntryPosted(tx, d.invoice.entryId, d.invoice.entryNumber));
    expect(again).toBe('already_queued');
    await mail.drain();
    await mail.drain();
    const sent = t.mailer.sent.filter((m) => m.to === clientEmail);
    expect(sent).toHaveLength(1);
    expect(sent[0].subject).toBe(`Invoice ${d.invoice.number} from Test Company (Pvt) Ltd`);
    expect(sent[0].html).toContain('Bank: Test Bank');
    expect((await detail(d.invoice.id)).invoice.emailedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'billing.invoice.email_queued', targetId: d.invoice.number } })).toBe(1);
    expect((await fin().post(`${API}/billing/invoices/${d.invoice.id}/email`).send({}).expect(409)).body.code).toBe('already_emailed');
  });

  it('the sender checks again: an invoice email that exists for an unapproved entry is never sent', async () => {
    t.mailer.clear();
    const d = await issued();
    await prisma.billingCustomerEmail.create({ data: { invoiceId: d.invoice.id, kind: 'invoice', toAddress: clientEmail, dedupeKey: `test-forced:${d.invoice.id}`, nextAttemptAt: new Date(Date.now() - 1000) } });
    await mail.drain();
    expect(t.mailer.sent).toHaveLength(0);
    expect(await prisma.billingCustomerEmail.findUniqueOrThrow({ where: { dedupeKey: `test-forced:${d.invoice.id}` } })).toMatchObject({ status: 'skipped', note: 'The ledger entry of the invoice is not approved' });
  });

  it('an invoice made through Module 9 directly (POST /invoices) is not emailed when its entry is approved', async () => {
    const inv = (await fin().post(`${API}/invoices`).send({ partyId: client, issueDate: today, dueDate: addDays(today, 10), lines: [{ description: 'Direct M9', quantity: '1', unitPrice: '100.00', accountCode: '4100' }] }).expect(201)).body;
    await t.stepUp(DIRECTOR);
    await approve(inv.entryId);
    await drain();
    expect(await prisma.billingCustomerEmail.count({ where: { invoiceId: inv.id } })).toBe(0);
  });
});

describe('M13 cancellation uses a reversing entry', () => {
  it('a draft is cancelled without any entry', async () => {
    const d = await draft();
    const entries = await prisma.journalEntry.count();
    const c = (await fin().post(`${API}/billing/invoices/${d.invoice.id}/cancel`).send({ reason: 'Created by mistake' }).expect(200)).body;
    expect(c.invoice).toMatchObject({ status: 'cancelled', cancelReason: 'Created by mistake', cancelEntryNumber: null });
    expect(await prisma.journalEntry.count()).toBe(entries);
  });

  it('an issued invoice needs "confirm again"; while its entry waits for approval it cannot be cancelled', async () => {
    const d = await issued();
    expect((await fin().post(`${API}/billing/invoices/${d.invoice.id}/cancel`).send({ reason: 'Wrong client' }).expect(403)).body.code).toBe('step_up_required');
    await t.stepUp(FINANCE);
    expect((await fin().post(`${API}/billing/invoices/${d.invoice.id}/cancel`).send({ reason: 'Wrong client' }).expect(409)).body.code).toBe('entry_pending');
  });

  it('a posted invoice: a reversing entry waits for approval; reminders and payments stop; approved, the receivable is back to zero', async () => {
    const d = await issued({ lines: [{ description: 'Audit', quantity: '1', unitPrice: '3000.00' }] });
    await t.stepUp(DIRECTOR);
    await approve(d.invoice.entryId);
    await t.stepUp(FINANCE);
    const c = (await fin().post(`${API}/billing/invoices/${d.invoice.id}/cancel`).send({ reason: 'Client cancelled the order' }).expect(200)).body;
    expect(c.invoice).toMatchObject({ status: 'cancelled', cancelEntryStatus: 'pending_approval' });
    const rev = await prisma.journalEntry.findUniqueOrThrow({ where: { number: c.invoice.cancelEntryNumber }, include: { lines: { include: { account: true }, orderBy: { lineNo: 'asc' } } } });
    expect(rev).toMatchObject({ source: 'reversal', reversalOfId: d.invoice.entryId, status: 'pending_approval', makerId: ids[FINANCE] });
    expect(rev.lines.map((l) => [l.account.systemRole ?? l.account.code, l.debit.toFixed(2), l.credit.toFixed(2)])).toEqual([
      ['accounts_receivable', '0.00', '3000.00'],
      ['4100', '3000.00', '0.00'],
    ]);
    expect(c.reminders.every((r: { status: string }) => r.status === 'skipped')).toBe(true);
    await fin().post(`${API}/billing/invoices/${d.invoice.id}/payments`).send({ requestKey: randomUUID(), bankAccountId: acc['1100'], date: today, amount: '1.00', method: 'cash' }).expect(409);
    await approve(rev.id);
    const lines = await prisma.journalLine.findMany({ where: { partyId: client, account: { systemRole: 'accounts_receivable' }, entry: { status: 'posted', OR: [{ id: d.invoice.entryId }, { id: rev.id }] } } });
    expect(lines.reduce((s, l) => s + Number(l.debit) - Number(l.credit), 0)).toBe(0);
    expect((await detail(d.invoice.id)).invoice.cancelEntryStatus).toBe('posted');
  });

  it('a cancellation whose reversing entry is rejected can be restored', async () => {
    const d = await issued({ lines: [{ description: 'Support', quantity: '1', unitPrice: '2000.00' }] });
    await t.stepUp(DIRECTOR);
    await approve(d.invoice.entryId);
    await t.stepUp(FINANCE);
    const c = (await fin().post(`${API}/billing/invoices/${d.invoice.id}/cancel`).send({ reason: 'Thought it was a duplicate' }).expect(200)).body;
    const rev = await prisma.journalEntry.findUniqueOrThrow({ where: { number: c.invoice.cancelEntryNumber } });
    await t.as(DIRECTOR).post(`${API}/journal-entries/${rev.id}/reject`).send({ reason: 'It is not a duplicate' }).expect(200);
    const r = (await fin().post(`${API}/billing/invoices/${d.invoice.id}/restore`).send({}).expect(200)).body;
    expect(r.invoice).toMatchObject({ status: 'issued', cancelledAt: null, cancelEntryNumber: null });
  });

  it('an invoice with payments recorded cannot be cancelled', async () => {
    const d = await issued();
    await t.stepUp(DIRECTOR);
    await approve(d.invoice.entryId);
    await fin().post(`${API}/billing/invoices/${d.invoice.id}/payments`).send({ requestKey: randomUUID(), bankAccountId: acc['1100'], date: today, amount: '100.00', method: 'cash' }).expect(201);
    await t.stepUp(FINANCE);
    expect((await fin().post(`${API}/billing/invoices/${d.invoice.id}/cancel`).send({ reason: 'Change of mind' }).expect(409)).body.code).toBe('has_payments');
  });
});

describe('M13 recurring and rental invoices', () => {
  it('a monthly recurring invoice: the first draft now, then exactly one draft per period from the daily run; stopping it stops them', async () => {
    const start = '2026-01-31';
    const d = await draft({ kind: 'recurring', period: 'monthly', periodStart: start, issueDate: start, lines: [{ description: 'Maintenance', quantity: '1', unitPrice: '2500.00' }] });
    expect(d.invoice).toMatchObject({ kind: 'recurring', period: 'monthly', periodStart: '2026-01-31', periodEnd: '2026-02-27' });
    expect(d.recurringRule).toMatchObject({ status: 'active', nextPeriodStart: '2026-02-28', total: '2500.00', invoiceCount: 1 });
    const ruleId = d.recurringRule.id;
    expect(await daily.run('2026-03-01')).toMatchObject({ recurringDrafts: 1 });
    expect(await daily.run('2026-03-01')).toMatchObject({ recurringDrafts: 0 }); // a re-run adds nothing
    const drafts = await prisma.invoice.findMany({ where: { recurringRuleId: ruleId }, orderBy: { periodStart: 'asc' } });
    expect(drafts.map((x) => [x.status, x.periodStart?.toISOString().slice(0, 10)])).toEqual([
      ['draft', '2026-01-31'],
      ['draft', '2026-02-28'],
    ]);
    expect(await notes(FINANCE, 'invoice_draft_ready')).toHaveLength(1);
    await fin().post(`${API}/billing/recurring/${ruleId}/stop`).send({ reason: 'Contract ended' }).expect(200);
    expect(await daily.run('2026-06-01')).toMatchObject({ recurringDrafts: 0 });
    expect(await prisma.invoice.count({ where: { recurringRuleId: ruleId } })).toBe(2);
  });

  it('a rental invoice with an end date bills its periods and then ends by itself', async () => {
    const d = await draft({ kind: 'rental', period: 'quarterly', periodStart: '2025-01-01', periodEnd: '2025-06-30', issueDate: '2025-01-01', lines: [{ description: 'Server rental', quantity: '1', unitPrice: '9000.00' }] });
    await daily.run('2026-01-01');
    const rule = (await fin().get(`${API}/billing/recurring`).expect(200)).body.find((r: { id: string }) => r.id === d.recurringRule.id);
    expect(rule).toMatchObject({ kind: 'rental', status: 'ended', invoiceCount: 2, nextPeriodStart: null });
  });

  it('one-time invoices have no billing period; recurring ones need one', async () => {
    await fin().post(`${API}/billing/invoices`).send({ requestKey: randomUUID(), partyId: client, kind: 'recurring', issueDate: today, termsDays: 14, lines: [{ description: 'x', quantity: '1', unitPrice: '1.00' }] }).expect(400);
  });
});

describe('M13 connection point for Module 15: a confirmed Won deal (exact, unique client names only)', () => {
  const won = (dealNumber: string, clientPart: Record<string, unknown>, value = '4500.00') => ({
    dealNumber,
    ownerEmpId: DEV,
    confirmedByEmpId: DIRECTOR,
    client: { partyId: null, email: null, country: null, ...clientPart } as { partyId: string | null; name: string; email: string | null; country: string | null },
    service: 'Mobile app',
    value,
    currency: 'PKR' as const,
  });
  const emit = (payload: ReturnType<typeof won>) => outbox.emit({ type: 'sales.deal.won_confirmed', actor: DIRECTOR, payload });
  const handover = (dealNumber: string) => prisma.dealHandover.findUnique({ where: { dealNumber } });

  it('no client with that name: a new client marked "needs review"; one draft even for a repeated event; it cannot be issued until confirmed', async () => {
    const told = (await notes(FINANCE, 'invoice_draft_ready')).length;
    const payload = won('DEAL-T-0001', { name: 'Globex LLC', email: 'ap@globex.test', country: 'US' });
    await emit(payload);
    await emit(payload); // a retry upstream: a second event for the same deal
    await drain();
    await drain();
    const inv = await prisma.invoice.findMany({ where: { sourceDealNumber: 'DEAL-T-0001' }, include: { party: { include: { billingProfile: true } }, lines: true } });
    expect(inv).toHaveLength(1);
    expect(inv[0]).toMatchObject({ status: 'draft', journalEntryId: null });
    expect(inv[0].party).toMatchObject({ name: 'Globex LLC', kind: 'client' });
    expect(inv[0].party.billingProfile).toMatchObject({ needsReview: true, createdFromDeal: 'DEAL-T-0001' });
    expect(inv[0].lines.map((l) => [l.description, l.amount.toFixed(2)])).toEqual([['Mobile app', '4500.00']]);
    expect(await handover('DEAL-T-0001')).toMatchObject({ status: 'drafted', invoiceId: inv[0].id });
    expect(await notes(FINANCE, 'invoice_draft_ready')).toHaveLength(told + 1);
    expect((await fin().post(`${API}/billing/invoices/${inv[0].id}/issue`).send({}).expect(409)).body.code).toBe('client_needs_review');
    const confirmed = (await fin().post(`${API}/billing/customers/${inv[0].partyId}/confirm`).send({}).expect(200)).body;
    expect(confirmed).toMatchObject({ needsReview: false, createdFromDeal: 'DEAL-T-0001' });
    expect((await fin().post(`${API}/billing/customers/${inv[0].partyId}/confirm`).send({}).expect(409)).body.code).toBe('already_reviewed');
    expect(await prisma.auditLog.count({ where: { action: 'billing.customer.reviewed', targetId: inv[0].partyId } })).toBe(1);
    await fin().post(`${API}/billing/invoices/${inv[0].id}/issue`).send({}).expect(200);
    const ov = (await fin().get(`${API}/billing/overview`).expect(200)).body;
    expect(ov.dealsNeedingClient).toEqual([]);
  });

  it('exactly one client with exactly that name: its draft goes to that client; a different spelling is not a match', async () => {
    const parties = await prisma.party.count();
    await emit(won('DEAL-T-0002', { name: 'Northwind Traders' }));
    await drain();
    const exact = await prisma.invoice.findUniqueOrThrow({ where: { sourceDealNumber: 'DEAL-T-0002' } });
    expect(exact.partyId).toBe(client);
    expect(await prisma.party.count()).toBe(parties);
    await emit(won('DEAL-T-0003', { name: 'NORTHWIND TRADERS' }));
    await drain();
    const other = await prisma.invoice.findUniqueOrThrow({ where: { sourceDealNumber: 'DEAL-T-0003' }, include: { party: { include: { billingProfile: true } } } });
    expect(other.partyId).not.toBe(client);
    expect(other.party.billingProfile?.needsReview).toBe(true);
  });

  it('the client named by Module 15 is used as it is', async () => {
    await emit(won('DEAL-T-0004', { partyId: client, name: 'Some other name' }));
    await drain();
    expect((await prisma.invoice.findUniqueOrThrow({ where: { sourceDealNumber: 'DEAL-T-0004' } })).partyId).toBe(client);
  });

  it('several clients with exactly that name: no draft and no guess; Finance chooses the client, once', async () => {
    const a = (await fin().post(`${API}/billing/customers`).send({ name: 'Initech', email: 'a@initech.test', currency: 'PKR' }).expect(201)).body.id;
    const b = (await fin().post(`${API}/billing/customers`).send({ name: 'Initech', email: 'b@initech.test', currency: 'PKR' }).expect(201)).body.id;
    const payload = won('DEAL-T-0005', { name: 'Initech' }, '1200.00');
    await emit(payload);
    await emit(payload);
    await drain();
    await drain();
    expect(await prisma.invoice.count({ where: { sourceDealNumber: 'DEAL-T-0005' } })).toBe(0);
    const h = (await handover('DEAL-T-0005'))!;
    expect(h).toMatchObject({ status: 'needs_client', invoiceId: null });
    expect([...h.candidatePartyIds].sort()).toEqual([a, b].sort());
    expect(await prisma.dealHandover.count({ where: { dealNumber: 'DEAL-T-0005' } })).toBe(1);
    expect((await notes(FINANCE, 'invoice_draft_ready')).filter((n) => n.title === 'A Won deal needs its client chosen')).toHaveLength(1);
    const waiting = (await fin().get(`${API}/billing/overview`).expect(200)).body.dealsNeedingClient;
    expect(waiting.map((x: { dealNumber: string; candidates: unknown[] }) => [x.dealNumber, x.candidates.length])).toEqual([['DEAL-T-0005', 2]]);
    await t.as(DEV).post(`${API}/billing/deal-handovers/${h.id}/resolve`).send({ partyId: b }).expect(404);
    await t.as(DIRECTOR).post(`${API}/billing/deal-handovers/${h.id}/resolve`).send({ partyId: b }).expect(404); // the Director views billing; Finance manages it
    const r = (await fin().post(`${API}/billing/deal-handovers/${h.id}/resolve`).send({ partyId: b }).expect(200)).body;
    expect(r).toMatchObject({ status: 'drafted' });
    const inv = await prisma.invoice.findUniqueOrThrow({ where: { sourceDealNumber: 'DEAL-T-0005' } });
    expect(inv).toMatchObject({ partyId: b, status: 'draft', createdBy: ids[FINANCE] });
    expect(r.invoiceId).toBe(inv.id);
    expect((await fin().post(`${API}/billing/deal-handovers/${h.id}/resolve`).send({ partyId: a }).expect(409)).body.code).toBe('already_resolved');
    expect(await prisma.invoice.count({ where: { sourceDealNumber: 'DEAL-T-0005' } })).toBe(1);
    expect(await prisma.auditLog.count({ where: { action: 'billing.deal_handover.resolved', targetId: 'DEAL-T-0005' } })).toBe(1);
    expect((await fin().get(`${API}/billing/deal-handovers`).expect(200)).body).toEqual([]);
  });
});

describe('M13 subscriptions, renewals, usage and costs', () => {
  let sub = '';

  it('the Director manages the register; Finance, the CEO and the Owner view; others get "not found"', async () => {
    const body = { vendor: 'Apollo', product: 'Apollo.io', category: 'sales_tools', ownerEmpId: DIRECTOR, plan: 'Basic, 2 seats', cost: '98.00', currency: 'USD', period: 'monthly', renewalDate: addDays(today, 5), alertDaysBefore: 7, seats: 2, usageMetric: 'Export credits', usageUnit: 'credits', usageLimit: '1000' };
    await fin().post(`${API}/billing/subscriptions`).send(body).expect(404);
    const s = (await t.as(DIRECTOR).post(`${API}/billing/subscriptions`).send(body).expect(201)).body;
    sub = s.id;
    expect(s).toMatchObject({ status: 'renewing_soon', usageFlag: null, cost: '98.00' });
    expect(s.number).toMatch(/^SUB-\d{4}-\d{4}$/);
    await fin().get(`${API}/billing/subscriptions`).expect(200);
    await t.as(CEO).get(`${API}/billing/subscriptions`).expect(200);
    await t.as(OWNER).get(`${API}/billing/subscriptions`).expect(200);
    await t.as(DEV).get(`${API}/billing/subscriptions`).expect(404);
  });

  it('a renewal alert once per renewal date, to the responsible person, with its event', async () => {
    expect(await daily.run(today)).toMatchObject({ renewalAlerts: 1 });
    expect(await daily.run(today)).toMatchObject({ renewalAlerts: 0 });
    const n = await notes(DIRECTOR, 'renewal_due');
    expect(n).toHaveLength(1);
    expect(n[0].title).toBe(`Apollo Apollo.io renews on ${addDays(today, 5)}`);
    expect((await events('billing.subscription.renewal_due')).map((e) => e.payload)).toEqual([expect.objectContaining({ renewsOn: addDays(today, 5), ownerEmpId: DIRECTOR })]);
  });

  it('a renewal decision moves the date on and is kept in an insert-only history', async () => {
    const r = (await t.as(DIRECTOR).post(`${API}/billing/subscriptions/${sub}/renewal-decision`).send({ decision: 'renewed', note: 'Still needed' }).expect(200)).body;
    expect(r).toMatchObject({ renewalDate: addMonths(addDays(today, 5), 1), status: 'active' });
    const changed = (await t.as(DIRECTOR).post(`${API}/billing/subscriptions/${sub}/renewal-decision`).send({ decision: 'changed', newPlan: 'Pro, 3 seats', newCost: '149.00' }).expect(200)).body;
    expect(changed).toMatchObject({ plan: 'Pro, 3 seats', cost: '149.00' });
    const history = (await fin().get(`${API}/billing/subscriptions/renewal-events`).expect(200)).body;
    expect(history.map((e: { kind: string }) => e.kind)).toEqual(['changed', 'renewed', 'alert']);
    expect(history[0]).toMatchObject({ oldCost: '98.00', newCost: '149.00', byEmpId: DIRECTOR });
    await expect(prisma.subscriptionRenewalEvent.deleteMany({ where: { subscriptionId: sub } })).rejects.toThrow();
  });

  it('usage readings are typed in; near the limit the responsible person is told once; costs are Estimated unless backed', async () => {
    await t.as(DIRECTOR).post(`${API}/billing/subscriptions/${sub}/usage`).send({ readingDate: addDays(today, -2), used: '300' }).expect(201);
    const near = (await t.as(DIRECTOR).post(`${API}/billing/subscriptions/${sub}/usage`).send({ readingDate: today, used: '850', estimatedCost: '12.50' }).expect(201)).body;
    expect(near.usageFlag).toBe('near_limit');
    expect(near.usage.at(-1)).toMatchObject({ used: '850', limit: '1000', estimatedCost: '12.50', source: 'manual' });
    expect(await notes(DIRECTOR, 'usage_alert')).toHaveLength(1);
    await expect(prisma.usageSnapshot.updateMany({ where: { subscriptionId: sub }, data: { used: '1' } })).rejects.toThrow();

    const month = today.slice(0, 7);
    const est = (await put(DIRECTOR, `${API}/billing/subscriptions/${sub}/costs/${month}`).send({ amount: '149.00', currency: 'USD', estimated: true }).expect(200)).body;
    expect(est.costs[0]).toMatchObject({ month, amount: '149.00', estimated: true });
    await put(DIRECTOR, `${API}/billing/subscriptions/${sub}/costs/${month}`).send({ amount: '151.20', currency: 'USD', estimated: false }).expect(400); // actual needs a bill or reference
    const actual = (await put(DIRECTOR, `${API}/billing/subscriptions/${sub}/costs/${month}`).send({ amount: '151.20', currency: 'USD', estimated: false, reference: 'APOLLO-INV-991' }).expect(200)).body;
    expect(actual.costs).toHaveLength(1);
    expect(actual.costs[0]).toMatchObject({ amount: '151.20', estimated: false, reference: 'APOLLO-INV-991' });
    expect(await prisma.auditLog.count({ where: { action: 'billing.subscription.cost_recorded' } })).toBe(2);
    await expect(prisma.subscriptionCost.update({ where: { subscriptionId_month: { subscriptionId: sub, month } }, data: { estimated: false, reference: null } })).rejects.toThrow();
  });

  it('a cancelled subscription gets no more alerts', async () => {
    await t.as(DIRECTOR).post(`${API}/billing/subscriptions/${sub}/renewal-decision`).send({ decision: 'cancelled' }).expect(400); // a note is required
    const c = (await t.as(DIRECTOR).post(`${API}/billing/subscriptions/${sub}/renewal-decision`).send({ decision: 'cancelled', note: 'Moved to another tool' }).expect(200)).body;
    expect(c.status).toBe('cancelled');
    expect(await daily.run(addDays(today, 60))).toMatchObject({ renewalAlerts: 0 });
  });
});

describe('M13 overview, payment history, export', () => {
  it('the overview and the client history come from the ledger', async () => {
    const ov = (await t.as(CEO).get(`${API}/billing/overview`).expect(200)).body;
    expect(Number(ov.collectedThisMonth)).toBeGreaterThanOrEqual(12000);
    expect(ov.history).toHaveLength(6);
    expect(ov.customerEmailsEnabled).toBe(true);
    const customers = (await fin().get(`${API}/billing/customers`).expect(200)).body;
    const nw = customers.find((c: { id: string }) => c.id === client);
    expect(nw.invoiceCount).toBeGreaterThanOrEqual(3);
    expect(nw.lastPaymentAt).toBe(today);
    const payments = (await fin().get(`${API}/billing/payments`).expect(200)).body;
    expect(payments.length).toBeGreaterThanOrEqual(3);
  });

  it('the CSV export needs finance.export and "confirm again", is watermarked and logged', async () => {
    await fin().get(`${API}/billing/invoices/export`).expect(404); // Finance duty has no finance.export
    await t.stepUp(DIRECTOR);
    const res = await t.as(DIRECTOR).get(`${API}/billing/invoices/export`).expect(200);
    expect(res.text.split('\r\n')[0]).toContain(`Confidential, exported by ${DIRECTOR}`);
    expect(await prisma.auditLog.count({ where: { action: 'billing.invoices.exported' } })).toBe(1);
  });

  it('the printable invoice shows only the company details that are set', async () => {
    const d = await issued();
    const html = (await fin().get(`${API}/billing/invoices/${d.invoice.id}/document`).expect(200)).text;
    expect(html).toContain('Test Company (Pvt) Ltd');
    expect(html).toContain(d.invoice.number);
    expect(html).not.toContain('null'); // details that are not set are left out, never invented
  });
});
