import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { dec } from '../src/common/money';
import { LedgerPostingPort } from '../src/finance/ledger-posting.port';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/** M9 journal entries: double entry, approval tiers, maker-checker, step-up, immutability, reversal (plan sections 13 and 16). */
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const DEV = 'ACV-0006';
const SALES = 'ACV-0009';
const FINANCE = 'ACV-0010';
let CEO = '';

let t: TestApp;
let prisma: PrismaClient;
const acc: Record<string, string> = {};
const API = '/api/v1';

type Line = { accountId: string; debit?: string; credit?: string; description?: string; partyId?: string; empId?: string };
const pair = (amount: string, debitCode = '5200', creditCode = '1100'): Line[] => [
  { accountId: acc[debitCode], debit: amount },
  { accountId: acc[creditCode], credit: amount },
];
const create = (body: Record<string, unknown>, who = FINANCE) => t.as(who).post(`${API}/journal-entries`).send({ date: '2026-10-15', description: 'Test entry', ...body });
async function submitted(amount: string, lines?: Line[]) {
  const r = await create({ lines: lines ?? pair(amount), submit: true }).expect(201);
  return r.body as { id: string; number: string; requiredLevel: number; status: string };
}
const approve = (id: string, who: string) => t.as(who).post(`${API}/journal-entries/${id}/approve`).send({});

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  CEO = t.fixtures.CEO;
  prisma = createTestPrisma();
  for (const a of await prisma.ledgerAccount.findMany()) acc[a.code] = a.id;
}, 180000);
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M9 finance routes are invisible to people without finance access', () => {
  const someId = '00000000-0000-4000-8000-000000000000';
  const routes: Array<[string, string]> = [
    ['get', '/journal-entries'],
    ['get', `/journal-entries/${someId}`],
    ['post', '/journal-entries'],
    ['post', `/journal-entries/${someId}/approve`],
    ['post', `/journal-entries/${someId}/reverse`],
    ['get', '/accounts'],
    ['post', '/accounts'],
    ['get', '/bank-accounts'],
    ['post', `/bank-accounts/${someId}/reveal`],
    ['get', '/parties'],
    ['get', '/projects'],
    ['get', '/exchange-rates'],
    ['get', '/invoices'],
    ['get', '/bills'],
    ['get', '/payments'],
    ['get', '/transfers'],
    ['get', `/bank-statements?bankAccountId=${someId}&month=2026-10`],
    ['post', '/bank-statements'],
    ['get', '/periods'],
    ['post', '/periods/2026-10/close'],
    ['post', '/periods/2026-10/reopen'],
    ['get', '/settings/approval-limits'],
    ['get', '/settings/finance'],
    ['get', '/ledger/reports/trial-balance'],
    ['get', '/ledger/export?from=2026-10-01&to=2026-10-31'],
  ];
  it.each([DEV, SALES, CTO])('%s gets 404 (not 403) on every finance route, and the refusal is audited', async (who) => {
    for (const [method, url] of routes) {
      const client = t.as(who);
      const r = await (method === 'get' ? client.get(`${API}${url}`) : client.post(`${API}${url}`).send({}));
      expect([r.status, url]).toEqual([404, url]);
    }
    const denied = await prisma.auditLog.count({ where: { action: 'access.denied', actor: { empId: who }, reason: 'missing_permission' } });
    expect(denied).toBeGreaterThanOrEqual(routes.length);
  });

  it('finance people can read: the finance officer, Director, CEO and Owner', async () => {
    for (const who of [FINANCE, DIRECTOR, CEO, OWNER]) await t.as(who).get(`${API}/journal-entries`).expect(200);
  });
});

describe('M9 debits must equal credits', () => {
  it('refuses an unbalanced entry at create (400 unbalanced_entry) and saves nothing', async () => {
    const before = await prisma.journalEntry.count();
    const r = await create({ lines: [{ accountId: acc['5200'], debit: '100.00' }, { accountId: acc['1100'], credit: '99.99' }] }).expect(400);
    expect(r.body.code).toBe('unbalanced_entry');
    expect(await prisma.journalEntry.count()).toBe(before);
  });

  it('validates lines: at least two, one positive side each, real active accounts', async () => {
    await create({ lines: [{ accountId: acc['5200'], debit: '100' }] }).expect(400);
    await create({ lines: [{ accountId: acc['5200'], debit: '100', credit: '100' }, { accountId: acc['1100'], credit: '100' }] }).expect(400);
    await create({ lines: [{ accountId: acc['5200'], debit: '0' }, { accountId: acc['1100'], credit: '0' }] }).expect(400);
    const unknown = await create({ lines: [{ accountId: '00000000-0000-4000-8000-000000000001', debit: '5' }, { accountId: acc['1100'], credit: '5' }] }).expect(400);
    expect(unknown.body.code).toBe('unknown_account');
    await create({ lines: pair('5.001') }).expect(400);
  });

  it('refuses unbalanced lines on PATCH and at submit; the database refuses an unbalanced entry at commit', async () => {
    const draft = (await create({ lines: pair('500.00') }).expect(201)).body;
    expect(draft.status).toBe('draft');
    const r = await t.as(FINANCE).patch(`${API}/journal-entries/${draft.id}`).send({ date: '2026-10-15', description: 'Edited', lines: [{ accountId: acc['5200'], debit: '500' }, { accountId: acc['1100'], credit: '400' }] }).expect(400);
    expect(r.body.code).toBe('unbalanced_entry');

    // Direct database attempt: an unbalanced draft moved to pending_approval fails when the transaction commits.
    const maker = await prisma.employee.findUniqueOrThrow({ where: { empId: FINANCE } });
    const bad = await prisma.journalEntry.create({ data: { entryDate: new Date('2026-10-16'), description: 'Direct', makerId: maker.id, totalBase: dec(100) } });
    await prisma.journalLine.createMany({
      data: [
        { entryId: bad.id, lineNo: 1, accountId: acc['5200'], debit: dec(100), baseDebit: dec(100) },
        { entryId: bad.id, lineNo: 2, accountId: acc['1100'], credit: dec(90), baseCredit: dec(90) },
      ],
    });
    await expect(prisma.journalEntry.update({ where: { id: bad.id }, data: { status: 'pending_approval' } })).rejects.toThrow(/unbalanced_entry/);
    expect((await prisma.journalEntry.findUniqueOrThrow({ where: { id: bad.id } })).status).toBe('draft');
    // ... and through the API its submit is refused with the clear code.
    const sub = await t.as(FINANCE).post(`${API}/journal-entries/${bad.id}/submit`).expect(400);
    expect(sub.body.code).toBe('unbalanced_entry');
  });

  it('adds money exactly (0.10 + 0.20 = 0.30, no floating point)', async () => {
    const r = await create({ lines: [{ accountId: acc['5200'], debit: '0.10' }, { accountId: acc['5300'], debit: '0.20' }, { accountId: acc['1100'], credit: '0.30' }] }).expect(201);
    expect(r.body.total).toBe('0.30');
    expect(r.body.totalBase).toBe('0.30');
    const big = await create({ lines: [{ accountId: acc['5200'], debit: '999999999999.99' }, { accountId: acc['1100'], credit: '999999999999.99' }] }).expect(201);
    expect(big.body.totalBase).toBe('999999999999.99');
  });
});

describe('M9 approval tiers and maker-checker (plan section 13)', () => {
  it('40,000: needs the Director (level 3); the Director approves it and it is posted, with history, audit and an event', async () => {
    const e = await submitted('40000.00');
    expect(e.status).toBe('pending_approval');
    expect(e.requiredLevel).toBe(3);
    const inbox = await t.as(DIRECTOR).get(`${API}/journal-entries?awaitingMe=true`).expect(200);
    expect(inbox.body.items.map((x: { id: string }) => x.id)).toContain(e.id);
    const r = await approve(e.id, DIRECTOR).expect(200);
    expect(r.body.status).toBe('posted');
    expect(r.body.approvedByEmpId).toBe(DIRECTOR);
    expect(r.body.events.map((x: { action: string }) => x.action)).toEqual(['created', 'submitted', 'approved', 'posted']);
    const posted = await prisma.outboxEvent.findMany({ where: { type: 'ledger.entry.posted', payload: { path: ['entryNumber'], equals: e.number } } });
    expect(posted).toHaveLength(1);
    expect(posted[0].payload).toEqual({ entryNumber: e.number, source: 'manual', entryDate: '2026-10-15' }); // no amounts in events
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'finance.entry.approved', targetId: e.number } });
    expect(JSON.stringify(audit.details)).not.toContain('40000');
    // a second approval is refused
    expect((await approve(e.id, DIRECTOR).expect(409)).body.code).toBe('invalid_transition');
  });

  it('60,000: needs the CEO; the Director is refused; the CEO must confirm again (above PKR 50,000)', async () => {
    const e = await submitted('60000.00');
    expect(e.requiredLevel).toBe(2);
    expect((await approve(e.id, DIRECTOR).expect(403)).body.code).toBe('approval_limit');
    const inbox = await t.as(DIRECTOR).get(`${API}/journal-entries?awaitingMe=true`).expect(200);
    expect(inbox.body.items.map((x: { id: string }) => x.id)).not.toContain(e.id);
    expect((await approve(e.id, CEO).expect(403)).body.code).toBe('step_up_required');
    await t.stepUp(CEO);
    expect((await approve(e.id, CEO).expect(200)).body.status).toBe('posted');
  });

  it('600,000 and any capital or loan account need the Owner', async () => {
    const big = await submitted('600000.00');
    expect(big.requiredLevel).toBe(1);
    await t.stepUp(CEO);
    expect((await approve(big.id, CEO).expect(403)).body.code).toBe('approval_limit');
    await t.stepUp(OWNER);
    expect((await approve(big.id, OWNER).expect(200)).body.status).toBe('posted');

    const capital = await submitted('1000.00', pair('1000.00', '1100', '3100'));
    expect(capital.requiredLevel).toBe(1);
    expect((await approve(capital.id, DIRECTOR).expect(403)).body.code).toBe('approval_limit');
    const loan = await submitted('500.00', pair('500.00', '1100', '2500'));
    expect(loan.requiredLevel).toBe(1);
  });

  it('an entry made by the Director goes one level up (CEO), and the Director cannot approve their own entry', async () => {
    const director = await prisma.employee.findUniqueOrThrow({ where: { empId: DIRECTOR } });
    const db = t.app.get(PrismaService);
    const port = t.app.get(LedgerPostingPort);
    const r = await db.$transaction((tx) =>
      port.createSystemEntry(tx, {
        source: 'advance',
        sourceRef: 'adv-1',
        purpose: 'payment',
        entryDate: '2026-10-20',
        description: 'Advance',
        makerId: director.id,
        lines: [
          { accountRole: 'employee_advances', debit: dec(10000) },
          { accountId: acc['1100'], credit: dec(10000) },
        ],
      }),
    );
    const view = (await t.as(DIRECTOR).get(`${API}/journal-entries/${r.id}`).expect(200)).body;
    expect(view.requiredLevel).toBe(2);
    expect(view.makerEmpId).toBe(DIRECTOR);
    expect(view.canApprove).toBe(false);
    expect((await approve(r.id, DIRECTOR).expect(403)).body.code).toBe('self_approval');
    expect(await prisma.auditLog.count({ where: { action: 'access.denied', reason: 'self_approval', targetId: r.number } })).toBe(1);
    expect((await approve(r.id, CEO).expect(200)).body.status).toBe('posted');
  });

  it('the finance officer cannot approve or reject (no permission: not found)', async () => {
    const e = await submitted('100.00');
    await approve(e.id, FINANCE).expect(404);
    await t.as(FINANCE).post(`${API}/journal-entries/${e.id}/reject`).send({ reason: 'Not mine to decide' }).expect(404);
  });

  it('rejecting needs a reason; a rejected entry never changes', async () => {
    const e = await submitted('200.00');
    await t.as(DIRECTOR).post(`${API}/journal-entries/${e.id}/reject`).send({ reason: 'no' }).expect(400);
    const r = await t.as(DIRECTOR).post(`${API}/journal-entries/${e.id}/reject`).send({ reason: 'Wrong expense account' }).expect(200);
    expect(r.body.status).toBe('rejected');
    expect(r.body.rejectedReason).toBe('Wrong expense account');
    expect((await approve(e.id, DIRECTOR).expect(409)).body.code).toBe('invalid_transition');
    await expect(prisma.journalEntry.update({ where: { id: e.id }, data: { description: 'changed' } })).rejects.toThrow(/never be edited/);
  });

  it('only the maker edits or submits a draft; a submitted entry cannot be edited', async () => {
    const draft = (await create({ lines: pair('300.00') }).expect(201)).body;
    await t.as(FINANCE).patch(`${API}/journal-entries/${draft.id}`).send({ date: '2026-10-18', description: 'Corrected', lines: pair('310.00') }).expect(200);
    const sub = await t.as(FINANCE).post(`${API}/journal-entries/${draft.id}/submit`).expect(200);
    expect(sub.body.totalBase).toBe('310.00');
    expect(sub.body.date).toBe('2026-10-18');
    expect((await t.as(FINANCE).post(`${API}/journal-entries/${draft.id}/submit`).expect(409)).body.code).toBe('invalid_transition');
    expect((await t.as(FINANCE).patch(`${API}/journal-entries/${draft.id}`).send({ date: '2026-10-18', description: 'x', lines: pair('1.00') }).expect(409)).body.code).toBe('invalid_transition');
  });
});

describe('M9 posted entries are never edited: reversal', () => {
  it('a posted entry cannot be changed or deleted, even directly in the database', async () => {
    const e = await submitted('700.00');
    await approve(e.id, DIRECTOR).expect(200);
    await expect(prisma.journalEntry.update({ where: { id: e.id }, data: { description: 'tampered' } })).rejects.toThrow(/never be edited/);
    await expect(prisma.journalEntry.delete({ where: { id: e.id } })).rejects.toThrow(/never deleted/);
    const line = await prisma.journalLine.findFirstOrThrow({ where: { entryId: e.id } });
    await expect(prisma.journalLine.update({ where: { id: line.id }, data: { debit: dec(1) } })).rejects.toThrow(/cannot change/);
    await expect(prisma.journalLine.delete({ where: { id: line.id } })).rejects.toThrow(/cannot change/);
    await expect(prisma.journalEntryEvent.deleteMany({ where: { entryId: e.id } })).rejects.toThrow();
    expect((await t.as(FINANCE).patch(`${API}/journal-entries/${e.id}`).send({ date: '2026-10-15', description: 'x', lines: pair('1.00') }).expect(409)).body.code).toBe('invalid_transition');
  });

  it('reverse creates a draft with swapped lines that follows normal approval; then the original shows "reversed"', async () => {
    const e = await submitted('800.00');
    await approve(e.id, DIRECTOR).expect(200);
    await t.as(FINANCE).post(`${API}/journal-entries/${e.id}/reverse`).send({ reason: 'x' }).expect(400);
    const rev = (await t.as(FINANCE).post(`${API}/journal-entries/${e.id}/reverse`).send({ reason: 'Booked to the wrong account', date: '2026-10-25' }).expect(201)).body;
    expect(rev.status).toBe('draft');
    expect(rev.source).toBe('reversal');
    expect(rev.reversalOfId).toBe(e.id);
    expect(rev.lines.map((l: { debit: string; credit: string }) => [l.debit, l.credit])).toEqual([
      ['0.00', '800.00'],
      ['800.00', '0.00'],
    ]);
    expect((await t.as(FINANCE).post(`${API}/journal-entries/${e.id}/reverse`).send({ reason: 'Second reversal' }).expect(409)).body.code).toBe('already_reversed');
    await t.as(FINANCE).post(`${API}/journal-entries/${rev.id}/submit`).expect(200);
    expect((await t.as(FINANCE).get(`${API}/journal-entries/${e.id}`).expect(200)).body.status).toBe('posted'); // not yet: the reversal waits
    await approve(rev.id, DIRECTOR).expect(200);
    const original = (await t.as(FINANCE).get(`${API}/journal-entries/${e.id}`).expect(200)).body;
    expect(original.status).toBe('reversed');
    expect(original.reversedByNumber).toBe(rev.number);
    const listed = await t.as(FINANCE).get(`${API}/journal-entries?status=reversed`).expect(200);
    expect(listed.body.items.map((x: { id: string }) => x.id)).toContain(e.id);
    // a draft cannot be reversed
    const draft = (await create({ lines: pair('5.00') }).expect(201)).body;
    expect((await t.as(FINANCE).post(`${API}/journal-entries/${draft.id}/reverse`).send({ reason: 'Not posted yet' }).expect(409)).body.code).toBe('invalid_transition');
  });

  it('a rejected reversal does not block a new one; two live reversals are refused by the database', async () => {
    const e = await submitted('900.00');
    await approve(e.id, DIRECTOR).expect(200);
    const first = (await t.as(FINANCE).post(`${API}/journal-entries/${e.id}/reverse`).send({ reason: 'First attempt at the reversal' }).expect(201)).body;
    await t.as(FINANCE).post(`${API}/journal-entries/${first.id}/submit`).expect(200);
    await t.as(DIRECTOR).post(`${API}/journal-entries/${first.id}/reject`).send({ reason: 'Wrong reversal date' }).expect(200);
    expect((await t.as(FINANCE).get(`${API}/journal-entries/${e.id}`).expect(200)).body.status).toBe('posted');
    const second = (await t.as(FINANCE).post(`${API}/journal-entries/${e.id}/reverse`).send({ reason: 'Second attempt, right date' }).expect(201)).body;
    expect(second.reversalOfId).toBe(e.id);
    expect((await t.as(FINANCE).post(`${API}/journal-entries/${e.id}/reverse`).send({ reason: 'A third one is refused' }).expect(409)).body.code).toBe('already_reversed');
    // the partial unique index itself: a second live reversal row cannot exist even if the service check were skipped
    const live = await prisma.journalEntry.findUniqueOrThrow({ where: { id: second.id } });
    await expect(
      prisma.journalEntry.create({ data: { entryDate: live.entryDate, description: 'bypass', source: 'reversal', reversalOfId: e.id, makerId: live.makerId } }),
    ).rejects.toThrow();
  });
});

describe('M9 USD entries keep their rate; PKR amounts are exact', () => {
  it('needs a rate (body, else the saved rate of the day); base = amount x rate rounded to paisa', async () => {
    const usd = [{ accountId: acc['1110'], debit: '100.00' }, { accountId: acc['4100'], credit: '100.00' }];
    expect((await create({ currency: 'USD', lines: usd }).expect(400)).body.code).toBe('rate_missing');
    await t.as(FINANCE).post(`${API}/exchange-rates`).send({ date: '2026-10-15', rate: '278.555' }).expect(201);
    expect((await t.as(FINANCE).post(`${API}/exchange-rates`).send({ date: '2026-10-15', rate: '279' }).expect(409)).body.code).toBe('rate_exists');
    const saved = (await create({ currency: 'USD', lines: usd }).expect(201)).body;
    expect(saved.exchangeRate).toBe('278.555000');
    expect(saved.totalBase).toBe('27855.50');
    const given = (await create({ currency: 'USD', exchangeRate: '280.10', lines: usd }).expect(201)).body;
    expect(given.lines[0].baseDebit).toBe('28010.00');
  });

  it('adjusts a few paisa of rounding on the largest line of the smaller side, and says so', async () => {
    const r = (
      await create({
        currency: 'USD',
        exchangeRate: '278.555',
        lines: [{ accountId: acc['1110'], debit: '0.01' }, { accountId: acc['1110'], debit: '0.01' }, { accountId: acc['4100'], credit: '0.02' }],
      }).expect(201)
    ).body;
    expect(r.lines.map((l: { baseDebit: string; baseCredit: string }) => [l.baseDebit, l.baseCredit])).toEqual([
      ['2.79', '0.00'],
      ['2.79', '0.00'],
      ['0.00', '5.58'],
    ]);
    expect(r.lines[2].description).toContain('PKR rounding adjusted by 0.01');
    expect(r.totalBase).toBe('5.58');
  });

  it('a PKR entry cannot touch a USD bank account', async () => {
    expect((await create({ lines: pair('10.00', '5200', '1110') }).expect(400)).body.code).toBe('currency_mismatch');
  });
});

describe('M9 closed months', () => {
  it('refuses an entry dated in a closed month in the API (409 period_closed) and in the database', async () => {
    // set up a closed month directly (the database needs the workflow event in the same transaction)
    const owner = await prisma.employee.findUniqueOrThrow({ where: { empId: OWNER } });
    await prisma.$transaction([
      prisma.financePeriod.create({ data: { month: '2026-02', status: 'closed' } }),
      prisma.financePeriodEvent.create({ data: { month: '2026-02', action: 'close_approved', actorId: owner.id } }),
    ]);
    const r = await create({ date: '2026-02-10', lines: pair('10.00') }).expect(409);
    expect(r.body.code).toBe('period_closed');
    const maker = await prisma.employee.findUniqueOrThrow({ where: { empId: FINANCE } });
    await expect(prisma.journalEntry.create({ data: { entryDate: new Date('2026-02-11'), description: 'Direct', makerId: maker.id } })).rejects.toThrow(/period_closed/);
  });
});
