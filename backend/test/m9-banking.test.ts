import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type SignedIn, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/** M9 bank accounts (encrypted, masked numbers; logged reveal) and bank reconciliation (CSV import, match, missing). */
const DIRECTOR = 'ACV-0003';
const FINANCE = 'ACV-0010';
const DEV = 'ACV-0006';
const NUMBER = 'PK36SCBL0000001123456702';

let t: TestApp;
let prisma: PrismaClient;
const acc: Record<string, string> = {};
const API = '/api/v1';
const fin = () => t.as(FINANCE);
/** PUT as a signed-in person (the shared test client has no put). */
const put = (who: string, url: string) => request(t.app.getHttpServer()).put(url).set((t.as(who) as SignedIn).headers());
let bank = '';
const lineOf: Record<string, string> = {};

async function postedEntry(date: string, lines: Array<{ code: string; debit?: string; credit?: string }>) {
  const e = (await fin().post(`${API}/journal-entries`).send({ date, description: `Entry ${date}`, submit: true, lines: lines.map((l) => ({ accountId: acc[l.code], debit: l.debit, credit: l.credit })) }).expect(201)).body;
  await t.as(DIRECTOR).post(`${API}/journal-entries/${e.id}/approve`).send({}).expect(200);
  return e as { id: string; lines: Array<{ id: string; accountCode: string }> };
}
const upload = (csv: string, account = bank, name = 'october.csv') => fin().post(`${API}/bank-statements`).field('bankAccountId', account).attach('file', Buffer.from(csv), { filename: name, contentType: 'text/csv' });

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  prisma = createTestPrisma();
  for (const a of await prisma.ledgerAccount.findMany()) acc[a.code] = a.id;
}, 180000);
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M9 bank accounts: numbers encrypted at rest and masked', () => {
  it('creates a bank account; only the last 4 digits are kept in clear and the number is never logged', async () => {
    const r = await fin().post(`${API}/bank-accounts`).send({ code: '1120', name: 'Bank: Meezan current', currency: 'PKR', bankName: 'Meezan', accountNumber: NUMBER }).expect(201);
    bank = r.body.id;
    acc['1120'] = bank;
    expect(r.body).toMatchObject({ code: '1120', accountNumberMasked: '•••• 6702', bankName: 'Meezan', balance: '0.00' });
    expect(JSON.stringify(r.body)).not.toContain('0000001123456702');
    const row = await prisma.bankAccountDetail.findUniqueOrThrow({ where: { accountId: bank } });
    expect(row.accountNumberLast4).toBe('6702');
    expect(row.accountNumberEncrypted).not.toContain('123456702');
    const audits = await prisma.auditLog.findMany({ where: { targetId: '1120' } });
    expect(audits.length).toBeGreaterThan(0);
    for (const a of audits) expect(JSON.stringify(a.details)).not.toContain('123456702');
    expect((await fin().post(`${API}/bank-accounts`).send({ code: '1120', name: 'Again', currency: 'PKR', bankName: 'X', accountNumber: '12345678' }).expect(409)).body.code).toBe('code_taken');
    await fin().post(`${API}/bank-accounts`).send({ code: '5120', name: 'Not an asset', currency: 'PKR', bankName: 'X', accountNumber: '12345678' }).expect(400);
    const list = (await fin().get(`${API}/bank-accounts`).expect(200)).body;
    expect(list.map((b: { code: string }) => b.code)).toEqual(['1100', '1110', '1120']);
    await put(FINANCE, `${API}/bank-accounts/${acc['1100']}/details`).send({ bankName: 'HBL', accountNumber: '0011 2233 4455', reason: 'Details from the bank letter' }).expect(200);
    expect((await fin().get(`${API}/bank-accounts`).expect(200)).body[0].accountNumberMasked).toBe('•••• 4455');
  });

  it('shows the full number only after "confirm again", and logs every reveal (never the number)', async () => {
    expect((await t.as(DIRECTOR).post(`${API}/bank-accounts/${bank}/reveal`).expect(403)).body.code).toBe('step_up_required');
    await t.as(DEV).post(`${API}/bank-accounts/${bank}/reveal`).expect(404);
    await t.stepUp(DIRECTOR);
    expect((await t.as(DIRECTOR).post(`${API}/bank-accounts/${bank}/reveal`).expect(200)).body.value).toBe(NUMBER);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'finance.bank_number.revealed', targetId: '1120' } });
    expect(JSON.stringify(audit)).not.toContain('123456702');
  });

  it('balances come from posted lines only', async () => {
    const e = (await fin().post(`${API}/journal-entries`).send({ date: '2026-10-02', description: 'Capital in', submit: true, lines: [{ accountId: bank, debit: '5000.00' }, { accountId: acc['3300'], credit: '5000.00' }] }).expect(201)).body;
    expect((await fin().get(`${API}/bank-accounts`).expect(200)).body.find((b: { id: string }) => b.id === bank).balance).toBe('0.00');
    await t.as(DIRECTOR).post(`${API}/journal-entries/${e.id}/approve`).send({}).expect(200);
    lineOf.deposit = e.lines.find((l: { accountCode: string }) => l.accountCode === '1120').id;
    expect((await fin().get(`${API}/bank-accounts`).expect(200)).body.find((b: { id: string }) => b.id === bank).balance).toBe('5000.00');
  });
});

describe('M9 bank reconciliation', () => {
  const CSV = 'date,description,amount,reference\r\n2026-10-03,Deposit,5000.00,DEP1\r\n2026-10-05,"Office rent, October",-1200.00,\r\n2026-10-20,Bank charges,-150.00,\r\n';

  it('imports a statement CSV; the same file twice is refused; every bad row is listed and nothing is saved', async () => {
    const rent = await postedEntry('2026-10-05', [{ code: '5200', debit: '1200.00' }, { code: '1120', credit: '1200.00' }]);
    lineOf.rent = rent.lines.find((l) => l.accountCode === '1120')!.id;
    const fee = await postedEntry('2026-10-08', [{ code: '5200', debit: '300.00' }, { code: '1120', credit: '300.00' }]);
    lineOf.fee = fee.lines.find((l) => l.accountCode === '1120')!.id;

    const bad = await upload('date,description,amount\n2026-13-01,Bad month,10\n2026-10-02,,abc\n2026-10-03,Zero,0\n2026-10-04,Fine,"1,250.50"\n', bank, 'bad.csv').expect(400);
    expect(bad.body.code).toBe('invalid_statement');
    expect(bad.body.errors.map((e: { row: number }) => e.row)).toEqual([2, 3, 4]);
    expect((await upload('when,what,how much\n2026-10-01,x,1\n', bank, 'h.csv').expect(400)).body.code).toBe('invalid_statement');
    expect(await prisma.bankStatementImport.count()).toBe(0);
    await fin().post(`${API}/bank-statements`).attach('file', Buffer.from(CSV), { filename: 'x.csv' }).expect(400); // no bank account

    expect((await upload(CSV).expect(201)).body.lineCount).toBe(3);
    expect((await upload(CSV, bank, 'renamed.csv').expect(409)).body.code).toBe('duplicate_statement');
    expect(await prisma.auditLog.count({ where: { action: 'finance.statement.imported' } })).toBe(1);
  });

  it('suggests posted lines with the same amount within 3 days, and lists what is missing on each side', async () => {
    const v = (await fin().get(`${API}/bank-statements?bankAccountId=${bank}&month=2026-10`).expect(200)).body;
    expect(v.statement).toHaveLength(3);
    const [deposit, rent, charges] = v.statement;
    expect(deposit.suggestions.map((s: { journalLineId: string }) => s.journalLineId)).toEqual([lineOf.deposit]);
    expect(rent.description).toBe('Office rent, October');
    expect(rent.suggestions.map((s: { journalLineId: string }) => s.journalLineId)).toEqual([lineOf.rent]);
    expect(charges.suggestions).toEqual([]);
    expect(v.missingInLedger.map((l: { id: string }) => l.id)).toEqual([charges.id]);
    expect(v.missingInBank.map((l: { journalLineId: string }) => l.journalLineId).sort()).toEqual([lineOf.deposit, lineOf.fee, lineOf.rent].sort());
  });

  it('matches and unmatches; amounts must agree and a line is matched once', async () => {
    const v = (await fin().get(`${API}/bank-statements?bankAccountId=${bank}&month=2026-10`).expect(200)).body;
    const [deposit, rent] = v.statement;
    expect((await fin().post(`${API}/bank-statements/lines/${deposit.id}/match`).send({ journalLineId: lineOf.rent }).expect(400)).body.code).toBe('amount_mismatch');
    const m = (await fin().post(`${API}/bank-statements/lines/${deposit.id}/match`).send({ journalLineId: lineOf.deposit }).expect(200)).body;
    expect(m.matchedJournalLineId).toBe(lineOf.deposit);
    expect((await fin().post(`${API}/bank-statements/lines/${deposit.id}/match`).send({ journalLineId: lineOf.deposit }).expect(409)).body.code).toBe('already_matched');
    await fin().post(`${API}/bank-statements/lines/${deposit.id}/unmatch`).expect(200);
    expect((await fin().post(`${API}/bank-statements/lines/${deposit.id}/unmatch`).expect(409)).body.code).toBe('not_matched');
    const auto = (await fin().post(`${API}/bank-statements/auto-match`).send({ bankAccountId: bank, month: '2026-10' }).expect(200)).body;
    expect(auto.matched).toBe(2);
    const after = (await fin().get(`${API}/bank-statements?bankAccountId=${bank}&month=2026-10`).expect(200)).body;
    expect(after.statement.filter((s: { matchedJournalLineId: string | null }) => s.matchedJournalLineId).map((s: { id: string }) => s.id).sort()).toEqual([deposit.id, rent.id].sort());
    expect(after.missingInBank.map((l: { journalLineId: string }) => l.journalLineId)).toEqual([lineOf.fee]);
    expect(await prisma.auditLog.count({ where: { action: 'finance.statement.matched' } })).toBe(3);
    await t.as(DEV).post(`${API}/bank-statements/lines/${rent.id}/unmatch`).expect(404);
  });

  it('"missing in ledger" creates a draft entry prefilled from the statement line; once posted it can be matched', async () => {
    const v = (await fin().get(`${API}/bank-statements?bankAccountId=${bank}&month=2026-10`).expect(200)).body;
    const charges = v.missingInLedger[0];
    let period = (await fin().get(`${API}/periods/2026-10`).expect(200)).body;
    expect(period.checklist.find((c: { key: string }) => c.key === 'bank_reconciled')).toMatchObject({ done: false, detail: '1 of 3 statement lines not matched' });
    const e = (await fin().post(`${API}/bank-statements/lines/${charges.id}/create-entry`).send({ counterAccountId: acc['5200'] }).expect(201)).body;
    expect(e).toMatchObject({ status: 'draft', date: '2026-10-20', source: 'manual', description: 'Bank: Bank charges' });
    expect(e.lines.map((l: { accountCode: string; debit: string; credit: string }) => [l.accountCode, l.debit, l.credit])).toEqual([
      ['1120', '0.00', '150.00'],
      ['5200', '150.00', '0.00'],
    ]);
    await fin().post(`${API}/journal-entries/${e.id}/submit`).expect(200);
    await t.as(DIRECTOR).post(`${API}/journal-entries/${e.id}/approve`).send({}).expect(200);
    const bankLine = e.lines.find((l: { accountCode: string }) => l.accountCode === '1120').id;
    await fin().post(`${API}/bank-statements/lines/${charges.id}/match`).send({ journalLineId: bankLine }).expect(200);
    period = (await fin().get(`${API}/periods/2026-10`).expect(200)).body;
    expect(period.checklist.find((c: { key: string }) => c.key === 'bank_reconciled').done).toBe(true);
  });
});
