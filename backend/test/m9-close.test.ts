import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dec } from '../src/common/money';
import type { PrismaClient } from '../src/generated/prisma/client';
import { LedgerPostingPort } from '../src/finance/ledger-posting.port';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type SignedIn, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/** M9 month close (checklist, run by finance, approved by the Director, reopened only by the Director or the Owner: D25) and USD revaluation. */
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003';
const FINANCE = 'ACV-0010';
let CEO = '';

let t: TestApp;
let prisma: PrismaClient;
const acc: Record<string, string> = {};
const API = '/api/v1';
const MONTH = '2026-08';
const fin = () => t.as(FINANCE);
/** PUT as a signed-in person (the shared test client has no put). */
const put = (who: string, url: string) => request(t.app.getHttpServer()).put(url).set((t.as(who) as SignedIn).headers());
const approve = (id: string, who = DIRECTOR) => t.as(who).post(`${API}/journal-entries/${id}/approve`).send({});
const period = async () => (await fin().get(`${API}/periods/${MONTH}`).expect(200)).body;
const item = (p: { checklist: Array<{ key: string; done: boolean }> }, key: string) => p.checklist.find((c) => c.key === key)!;

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  CEO = 'ACV-0001';
  prisma = createTestPrisma();
  for (const a of await prisma.ledgerAccount.findMany()) acc[a.code] = a.id;
}, 180000);
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M9 month close checklist and USD revaluation', () => {
  let pendingId = '';

  it('a month without a row is open; the checklist is computed live and the close is refused until it is complete', async () => {
    const p = await period();
    expect(p.status).toBe('open');
    expect(item(p, 'entries_posted').done).toBe(true);
    expect(item(p, 'trial_balance').done).toBe(true);
    expect(item(p, 'payroll_posted').done).toBe(false);
    const r = await fin().post(`${API}/periods/${MONTH}/close`).expect(409);
    expect(r.body.code).toBe('checklist_incomplete');
    expect(r.body.checklist.find((c: { key: string }) => c.key === 'payroll_posted').done).toBe(false);

    pendingId = (await fin().post(`${API}/journal-entries`).send({ date: '2026-08-10', description: 'Stationery', submit: true, lines: [{ accountId: acc['5200'], debit: '450.00' }, { accountId: acc['1100'], credit: '450.00' }] }).expect(201)).body.id;
    expect(item(await period(), 'entries_posted')).toMatchObject({ done: false, detail: '1 entry is still draft or waiting for approval' });
  });

  it('payroll posted: a posted payroll entry dated in the month', async () => {
    const finance = await prisma.employee.findUniqueOrThrow({ where: { empId: FINANCE } });
    const r = await t.app.get(PrismaService).$transaction((tx) =>
      t.app.get(LedgerPostingPort).createSystemEntry(tx, {
        source: 'payroll',
        sourceRef: 'run-2026-08',
        purpose: 'salary',
        entryDate: '2026-08-31',
        description: 'Salaries August',
        makerId: finance.id,
        lines: [
          { accountRole: 'salary_expense', debit: dec('30000') },
          { accountRole: 'salary_payable', credit: dec('30000') },
        ],
      }),
    );
    expect(item(await period(), 'payroll_posted').done).toBe(false); // waiting for approval
    await approve(r.id).expect(200);
    expect(item(await period(), 'payroll_posted').done).toBe(true);
  });

  it('USD entries carry PKR amounts at their rate; the revaluation posts the difference to FX gain/loss, once', async () => {
    const usd = (await fin().post(`${API}/journal-entries`).send({ date: '2026-08-05', description: 'USD received', currency: 'USD', exchangeRate: '278', submit: true, lines: [{ accountId: acc['1110'], debit: '1000.00' }, { accountId: acc['3300'], credit: '1000.00' }] }).expect(201)).body;
    expect(usd.totalBase).toBe('278000.00');
    await t.stepUp(CEO);
    expect((await approve(usd.id, CEO).expect(403)).body.code).toBe('approval_limit'); // D25: the CEO only views
    await t.stepUp(DIRECTOR);
    await approve(usd.id).expect(200); // PKR 278,000: within the Director's limit
    expect(item(await period(), 'usd_revalued').done).toBe(false);

    expect((await fin().post(`${API}/periods/${MONTH}/revaluation-preview`).send({}).expect(400)).body.code).toBe('rate_missing');
    await fin().post(`${API}/exchange-rates`).send({ date: '2026-08-31', rate: '280.50' }).expect(201);
    const preview = (await fin().post(`${API}/periods/${MONTH}/revaluation-preview`).send({}).expect(200)).body;
    expect(preview).toMatchObject({ rate: '280.500000', total: '2500.00', date: '2026-08-31' });
    expect(preview.rows[0]).toMatchObject({ code: '1110', foreign: '1000.00', bookBase: '278000.00', revaluedBase: '280500.00', difference: '2500.00' });
    const reval = (await fin().post(`${API}/periods/${MONTH}/revalue`).send({}).expect(201)).body;
    expect(reval).toMatchObject({ source: 'revaluation', sourceRef: MONTH, status: 'pending_approval', date: '2026-08-31', totalBase: '2500.00' });
    expect(reval.lines.map((l: { accountCode: string; debit: string; credit: string }) => [l.accountCode, l.debit, l.credit])).toEqual([
      ['1110', '2500.00', '0.00'],
      ['4900', '0.00', '2500.00'],
    ]);
    expect((await fin().post(`${API}/periods/${MONTH}/revalue`).send({ rate: '300' }).expect(201)).body.id).toBe(reval.id); // idempotent
    await approve(reval.id).expect(200);
    const usdBank = (await fin().get(`${API}/bank-accounts`).expect(200)).body.find((b: { code: string }) => b.code === '1110');
    expect(usdBank).toMatchObject({ foreignBalance: '1000.00', balance: '280500.00' });
    expect(item(await period(), 'usd_revalued').done).toBe(true);
    expect((await fin().post(`${API}/periods/${MONTH}/revaluation-preview`).send({}).expect(200)).body.total).toBe('0.00');
  });

  it('runs the close (finance), and only the Director approves it (D25); the month is then locked', async () => {
    await approve(pendingId).expect(200);
    const ready = await period();
    expect(ready.checklist.every((c: { done: boolean }) => c.done)).toBe(true);
    await t.as(CEO).post(`${API}/periods/${MONTH}/close`).expect(404); // the CEO does not run closes (no finance.close)
    const closing = (await fin().post(`${API}/periods/${MONTH}/close`).expect(200)).body;
    expect(closing).toMatchObject({ status: 'closing', closeRequestedByEmpId: FINANCE });
    expect((await fin().post(`${API}/periods/${MONTH}/close`).expect(409)).body.code).toBe('invalid_transition');
    await fin().post(`${API}/periods/${MONTH}/approve-close`).expect(404);
    await t.as(CEO).post(`${API}/periods/${MONTH}/approve-close`).expect(404); // D25: the CEO only views
    expect((await t.as(CEO).get(`${API}/periods/${MONTH}`).expect(200)).body.canApproveClose).toBe(false);
    expect((await t.as(DIRECTOR).get(`${API}/periods/${MONTH}`).expect(200)).body.canApproveClose).toBe(true);
    const closed = (await t.as(DIRECTOR).post(`${API}/periods/${MONTH}/approve-close`).expect(200)).body;
    expect(closed).toMatchObject({ status: 'closed', closedByEmpId: DIRECTOR });
    expect((await t.as(DIRECTOR).post(`${API}/periods/${MONTH}/approve-close`).expect(409)).body.code).toBe('invalid_transition');
    expect(await prisma.financePeriodEvent.count({ where: { month: MONTH } })).toBe(2);
  });

  it('a closed month refuses entries in the API and in the database; a reversal is dated in an open month', async () => {
    const r = await fin().post(`${API}/journal-entries`).send({ date: '2026-08-20', description: 'Late', lines: [{ accountId: acc['5200'], debit: '10' }, { accountId: acc['1100'], credit: '10' }] }).expect(409);
    expect(r.body.code).toBe('period_closed');
    expect((await fin().post(`${API}/journal-entries/${pendingId}/reverse`).send({ reason: 'Wrong month', date: '2026-08-25' }).expect(409)).body.code).toBe('period_closed');
    const rev = (await fin().post(`${API}/journal-entries/${pendingId}/reverse`).send({ reason: 'Wrong amount' }).expect(201)).body;
    expect(rev.date >= '2026-11-01').toBe(true);
    const party = (await fin().post(`${API}/parties`).send({ kind: 'vendor', name: 'Late vendor', currency: 'PKR' }).expect(201)).body;
    expect((await fin().post(`${API}/bills`).send({ partyId: party.id, billDate: '2026-08-12', dueDate: '2026-08-30', accountCode: '5200', description: 'x', total: '5' }).expect(409)).body.code).toBe('period_closed');
    const maker = await prisma.employee.findUniqueOrThrow({ where: { empId: FINANCE } });
    await expect(prisma.journalEntry.create({ data: { entryDate: new Date('2026-08-21'), description: 'Direct', makerId: maker.id } })).rejects.toThrow(/period_closed/);
  });

  it('only the Director reopens (D26), with a reason and "confirm again"; it is logged and alerted; the Owner only views', async () => {
    await t.as(CEO).post(`${API}/periods/${MONTH}/reopen`).send({ reason: 'Owner tries to reopen' }).expect(404); // D26: the Owner only views
    await fin().post(`${API}/periods/${MONTH}/reopen`).send({ reason: 'Finance tries to reopen' }).expect(404);
    await t.as(DIRECTOR).post(`${API}/periods/${MONTH}/reopen`).send({}).expect(400);
    t.clock.advance(6 * 60_000);
    expect((await t.as(DIRECTOR).post(`${API}/periods/${MONTH}/reopen`).send({ reason: 'Missing supplier invoice' }).expect(403)).body.code).toBe('step_up_required');
    await t.stepUp(DIRECTOR);
    const open = (await t.as(DIRECTOR).post(`${API}/periods/${MONTH}/reopen`).send({ reason: 'Missing supplier invoice' }).expect(200)).body;
    expect(open.status).toBe('reopened');
    expect(open.events.at(-1)).toMatchObject({ action: 'reopened', byEmpId: DIRECTOR, reason: 'Missing supplier invoice' });
    const event = await prisma.outboxEvent.findFirstOrThrow({ where: { type: 'finance.period.reopened' } });
    expect(event.payload).toEqual({ month: MONTH, byEmpId: DIRECTOR, reason: 'Missing supplier invoice' });
    expect(await prisma.auditLog.count({ where: { action: 'finance.period.reopened', targetId: MONTH, reason: 'Missing supplier invoice' } })).toBe(1);
    // entries are accepted again
    await fin().post(`${API}/journal-entries`).send({ date: '2026-08-20', description: 'Late', lines: [{ accountId: acc['5200'], debit: '10' }, { accountId: acc['1100'], credit: '10' }] }).expect(201);
  });

  it('the Director can send a close back with a reason, and can also reopen; the Owner cannot', async () => {
    // the draft made above must be submitted and posted first
    const drafts = await prisma.journalEntry.findMany({ where: { entryDate: { gte: new Date('2026-08-01'), lte: new Date('2026-08-31') }, status: 'draft' } });
    for (const d of drafts) {
      await fin().post(`${API}/journal-entries/${d.id}/submit`).expect(200);
      await approve(d.id).expect(200);
    }
    await fin().post(`${API}/periods/${MONTH}/close`).expect(200);
    await t.as(CEO).post(`${API}/periods/${MONTH}/reject-close`).send({ reason: 'Owner sends it back' }).expect(404);
    await t.as(DIRECTOR).post(`${API}/periods/${MONTH}/reject-close`).send({ reason: 'no' }).expect(400);
    expect((await t.as(DIRECTOR).post(`${API}/periods/${MONTH}/reject-close`).send({ reason: 'Check the August rent again' }).expect(200)).body.status).toBe('reopened');
    await fin().post(`${API}/periods/${MONTH}/close`).expect(200);
    await t.as(DIRECTOR).post(`${API}/periods/${MONTH}/approve-close`).expect(200);
    t.clock.advance(6 * 60_000);
    expect((await t.as(DIRECTOR).post(`${API}/periods/${MONTH}/reopen`).send({ reason: 'Auditor adjustment' }).expect(403)).body.code).toBe('step_up_required');
    await t.stepUp(DIRECTOR);
    expect((await t.as(DIRECTOR).post(`${API}/periods/${MONTH}/reopen`).send({ reason: 'Auditor adjustment' }).expect(200)).body.status).toBe('reopened');
    const list = (await fin().get(`${API}/periods`).expect(200)).body;
    expect(list.map((p: { month: string }) => p.month)).toContain(MONTH);
  });
});

describe('M9 finance settings (the Director changes them, decision D26)', () => {
  it('everyone in finance reads them; only the Director changes them, with a reason and "confirm again", validated and logged; approval limits no longer exist', async () => {
    expect((await fin().get(`${API}/settings/finance`).expect(200)).body).toEqual({ stepUpAbove: '50000.00', ownerNotifyAbove: '500000.00', financeYearStartMonth: 7 });
    await fin().get(`${API}/settings/approval-limits`).expect(404); // the tiers are gone: the Director approves any amount
    const next = { stepUpAbove: '70000', ownerNotifyAbove: '400000', financeYearStartMonth: 7, reason: 'Management decision' };
    // Finance and the Owner (view only) do not reach the change
    await put(FINANCE, `${API}/settings/finance`).send(next).expect(404);
    await t.stepUp(OWNER);
    await put(OWNER, `${API}/settings/finance`).send(next).expect(404);
    await t.stepUp(DIRECTOR);
    await put(DIRECTOR, `${API}/settings/finance`).send({ ...next, financeYearStartMonth: 13 }).expect(400);
    // changing a finance setting needs "confirm again", checked by the server (past the 5-minute window of the Director's last one)
    t.clock.advance(6 * 60_000);
    expect((await put(DIRECTOR, `${API}/settings/finance`).send(next).expect(403)).body.code).toBe('step_up_required');
    await t.stepUp(DIRECTOR);
    const changed = (await put(DIRECTOR, `${API}/settings/finance`).send(next).expect(200)).body;
    expect(changed).toMatchObject({ stepUpAbove: '70000.00', ownerNotifyAbove: '400000.00' });
    expect(await prisma.auditLog.count({ where: { action: 'finance.settings.changed', reason: next.reason } })).toBe(1);
    // an entry Finance makes needs the Director whatever its amount, and 60,000 is now below the confirm-again amount
    const e = (await fin().post(`${API}/journal-entries`).send({ date: '2026-10-01', description: 'Laptop', submit: true, lines: [{ accountId: acc['5200'], debit: '60000' }, { accountId: acc['1100'], credit: '60000' }] }).expect(201)).body;
    expect(e.requiredLevel).toBe(2);
    expect((await approve(e.id).expect(200)).body.status).toBe('posted');
  });

  it('the report-to-Owner flag: on by default for equity, only ever added, and it tells the Owner instead of waiting for the Owner', async () => {
    const equity = (await fin().post(`${API}/accounts`).send({ code: '3400', name: 'Partner capital (test)', group: 'equity', currency: 'PKR' }).expect(201)).body;
    expect(equity.requiresOwnerApproval).toBe(true);
    expect((await fin().post(`${API}/accounts`).send({ code: '3500', name: 'Unflagged capital (test)', group: 'equity', currency: 'PKR', requiresOwnerApproval: false }).expect(403)).body.code).toBe('owner_flag_locked');
    const share = acc['3100'];
    expect((await fin().patch(`${API}/accounts/${share}`).send({ requiresOwnerApproval: false, reason: 'Finance tries to drop the flag' }).expect(403)).body.code).toBe('owner_flag_locked');
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: share } })).requiresOwnerApproval).toBe(true);
    // the old Owner-approval route is gone for everybody
    await t.as(OWNER).put(`${API}/accounts/${share}/owner-approval`).send({ required: false, reason: 'Owner tries' }).expect(404);
    await t.as(DIRECTOR).put(`${API}/accounts/${share}/owner-approval`).send({ required: false, reason: 'Director tries' }).expect(404);
    // an entry on a flagged account still needs the Director (not the Owner), and the Owner is told through the audit log
    await fin().patch(`${API}/accounts/${acc['5300']}`).send({ requiresOwnerApproval: true, reason: 'Owner wants to see software spend' }).expect(200);
    const e = (await fin().post(`${API}/journal-entries`).send({ date: '2026-10-02', description: 'Software', submit: true, lines: [{ accountId: acc['5300'], debit: '1000' }, { accountId: acc['1100'], credit: '1000' }] }).expect(201)).body;
    expect(e.requiredLevel).toBe(2);
    expect(await prisma.auditLog.count({ where: { action: 'finance.entry.owner_notified', targetId: e.number } })).toBe(1);
    expect((await approve(e.id, OWNER).expect(403)).body.code).toBe('approval_limit');
    expect((await approve(e.id).expect(200)).body.status).toBe('posted');
    // removing the flag is refused
    expect((await fin().patch(`${API}/accounts/${acc['5300']}`).send({ requiresOwnerApproval: false, reason: 'Finance tries again' }).expect(403)).body.code).toBe('owner_flag_locked');
  });
});
