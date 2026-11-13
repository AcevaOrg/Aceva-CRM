import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/** M9 clients and vendors, invoices, bills with receipts, payments, transfers and reports (plan section 13). */
const DIRECTOR = 'ACV-0003';
const FINANCE = 'ACV-0010';
const DEV = 'ACV-0006';
let CEO = '';

let t: TestApp;
let prisma: PrismaClient;
const acc: Record<string, string> = {};
const API = '/api/v1';
const fin = () => t.as(FINANCE);
const approve = async (entryId: string, who = DIRECTOR) => (await t.as(who).post(`${API}/journal-entries/${entryId}/approve`).send({}).expect(200)).body;

let acme = '';
let vendor = '';
let project = '';

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64, 1)]);

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((f) => (statSync(join(dir, f)).isDirectory() ? filesUnder(join(dir, f)) : [join(dir, f)]));
}

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

describe('M9 clients, vendors and projects', () => {
  it('creates, lists (paged), and archives instead of deleting', async () => {
    acme = (await fin().post(`${API}/parties`).send({ kind: 'client', name: 'Acme <b>Corp</b>', email: 'ap@acme.test', currency: 'PKR' }).expect(201)).body.id;
    vendor = (await fin().post(`${API}/parties`).send({ kind: 'vendor', name: 'Cloud Host', currency: 'PKR' }).expect(201)).body.id;
    const old = (await fin().post(`${API}/parties`).send({ kind: 'client', name: 'Old Client', currency: 'USD' }).expect(201)).body.id;
    await fin().post(`${API}/parties`).send({ kind: 'client', name: '' }).expect(400);
    const clients = (await fin().get(`${API}/parties?kind=client`).expect(200)).body;
    expect(clients).toMatchObject({ total: 2, page: 1 });
    await fin().patch(`${API}/parties/${old}`).send({ archived: true }).expect(200);
    expect((await fin().get(`${API}/parties?kind=client`).expect(200)).body.total).toBe(1);
    expect((await fin().get(`${API}/parties?kind=client&includeArchived=true`).expect(200)).body.total).toBe(2);
    expect(await prisma.party.count({ where: { id: old } })).toBe(1);
    project = (await fin().post(`${API}/projects`).send({ code: 'ACME-WEB', name: 'Acme website' }).expect(201)).body.id;
    expect((await fin().post(`${API}/projects`).send({ code: 'ACME-WEB', name: 'Again' }).expect(409)).body.code).toBe('code_taken');
    await t.as(DEV).post(`${API}/parties`).send({ kind: 'client', name: 'X', currency: 'PKR' }).expect(404);
  });
});

describe('M9 invoices: status is calculated from posted payment allocations', () => {
  let invoiceId = '';
  let invoiceEntry = '';

  it('creates the invoice and its entry (Dr receivable / Cr income), waiting for approval', async () => {
    const r = await fin()
      .post(`${API}/invoices`)
      .send({
        partyId: acme,
        issueDate: '2026-09-01',
        dueDate: '2026-09-30',
        projectId: project,
        lines: [
          { description: 'Design', quantity: '2', unitPrice: '1500.50', accountCode: '4100' },
          { description: 'Hosting', quantity: '1', unitPrice: '999.99', accountCode: '4100' },
        ],
      })
      .expect(201);
    invoiceId = r.body.id;
    invoiceEntry = r.body.entryId;
    expect(r.body).toMatchObject({ total: '4000.99', paid: '0.00', open: '4000.99', status: 'unpaid', entryStatus: 'pending_approval' });
    expect(r.body.number).toMatch(/^INV-\d{4}-\d{4}$/);
    const entry = (await fin().get(`${API}/journal-entries/${invoiceEntry}`).expect(200)).body;
    expect(entry.source).toBe('invoice');
    expect(entry.projectId).toBe(project);
    expect(entry.lines.map((l: { accountCode: string; debit: string; credit: string }) => [l.accountCode, l.debit, l.credit])).toEqual([
      ['1200', '4000.99', '0.00'],
      ['4100', '0.00', '3001.00'],
      ['4100', '0.00', '999.99'],
    ]);
  });

  it('refuses a vendor as the client, an account that is not income, and a due date before the issue date', async () => {
    const base = { partyId: acme, issueDate: '2026-09-01', dueDate: '2026-09-30', lines: [{ description: 'X', quantity: '1', unitPrice: '10', accountCode: '4100' }] };
    expect((await fin().post(`${API}/invoices`).send({ ...base, partyId: vendor }).expect(400)).body.code).toBe('wrong_party_kind');
    expect((await fin().post(`${API}/invoices`).send({ ...base, lines: [{ description: 'X', quantity: '1', unitPrice: '10', accountCode: '5200' }] }).expect(400)).body.code).toBe('invalid_account');
    await fin().post(`${API}/invoices`).send({ ...base, dueDate: '2026-08-01' }).expect(400);
  });

  it('a payment counts only once its entry is posted; more than what is open is refused', async () => {
    const pay = (amount: string, allocation = amount) =>
      fin().post(`${API}/payments`).send({ direction: 'received', partyId: acme, bankAccountId: acc['1100'], paymentDate: '2026-09-10', amount, allocations: [{ invoiceId, amount: allocation }] });
    expect((await pay('5000.00').expect(400)).body.code).toBe('overpayment');
    expect((await pay('100.00', '200.00').expect(400)).body.code).toBe('overpayment'); // allocations above the payment
    const first = (await pay('1000.00').expect(201)).body;
    expect(first.entryStatus).toBe('pending_approval');
    let inv = (await fin().get(`${API}/invoices/${invoiceId}`).expect(200)).body;
    expect(inv).toMatchObject({ status: 'unpaid', paid: '0.00', open: '3000.99' });
    expect((await pay('3001.00').expect(400)).body.code).toBe('overpayment'); // the pending 1000 is already committed

    await approve(invoiceEntry);
    await approve(first.entryId);
    inv = (await fin().get(`${API}/invoices/${invoiceId}`).expect(200)).body;
    expect(inv).toMatchObject({ status: 'part_paid', paid: '1000.00', open: '3000.99' });

    // a rejected payment frees its allocation again
    const rejected = (await pay('500.00').expect(201)).body;
    await t.as(DIRECTOR).post(`${API}/journal-entries/${rejected.entryId}/reject`).send({ reason: 'Bank says no such deposit' }).expect(200);
    expect((await fin().get(`${API}/invoices/${invoiceId}`).expect(200)).body.open).toBe('3000.99');

    const rest = (await pay('3000.99').expect(201)).body;
    await approve(rest.entryId);
    inv = (await fin().get(`${API}/invoices/${invoiceId}`).expect(200)).body;
    expect(inv).toMatchObject({ status: 'paid', paid: '4000.99', open: '0.00' });
    expect((await pay('0.01').expect(400)).body.code).toBe('overpayment');
    const list = (await fin().get(`${API}/invoices?status=paid`).expect(200)).body;
    expect(list.items.map((i: { id: string }) => i.id)).toContain(invoiceId);
    // the client's receivable balance is back to zero
    expect((await fin().get(`${API}/parties/${acme}`).expect(200)).body.balance).toBe('0.00');
  });

  it('refuses a payment from a bank account in another currency', async () => {
    const inv = (await fin().post(`${API}/invoices`).send({ partyId: acme, issueDate: '2026-09-05', dueDate: '2026-10-05', lines: [{ description: 'Support', quantity: '1', unitPrice: '700', accountCode: '4100' }] }).expect(201)).body;
    const r = await fin().post(`${API}/payments`).send({ direction: 'received', partyId: acme, bankAccountId: acc['1110'], paymentDate: '2026-09-10', amount: '10', exchangeRate: '280', allocations: [{ invoiceId: inv.id, amount: '10' }] }).expect(400);
    expect(r.body.code).toBe('currency_mismatch');
    await approve(inv.entryId);
  });

  it('serves a printable HTML invoice with Aceva and the escaped invoice details', async () => {
    const r = await fin().get(`${API}/invoices/${invoiceId}/document`).expect(200);
    expect(r.headers['content-type']).toContain('text/html');
    expect(r.headers['content-security-policy']).toContain("default-src 'none'");
    expect(r.text).toContain('Aceva');
    expect(r.text).toContain('Acme &lt;b&gt;Corp&lt;/b&gt;');
    expect(r.text).not.toContain('<b>Corp</b>');
    expect(r.text).toContain('4000.99');
  });
});

describe('M9 bills with the receipt uploaded', () => {
  let billId = '';
  it('creates the bill and its entry (Dr expense / Cr payable)', async () => {
    const r = await fin().post(`${API}/bills`).send({ partyId: vendor, billDate: '2026-09-03', dueDate: '2026-09-20', accountCode: '5300', projectId: project, description: 'Servers September', total: '12000.00' }).expect(201);
    billId = r.body.id;
    expect(r.body).toMatchObject({ status: 'unpaid', total: '12000.00', accountCode: '5300', entryStatus: 'pending_approval' });
    const entry = (await fin().get(`${API}/journal-entries/${r.body.entryId}`).expect(200)).body;
    expect(entry.lines.map((l: { accountCode: string; debit: string; credit: string }) => [l.accountCode, l.debit, l.credit])).toEqual([
      ['5300', '12000.00', '0.00'],
      ['2100', '0.00', '12000.00'],
    ]);
    expect((await fin().post(`${API}/bills`).send({ partyId: acme, billDate: '2026-09-03', dueDate: '2026-09-20', accountCode: '5300', description: 'x', total: '1' }).expect(400)).body.code).toBe('wrong_party_kind');
    await approve(r.body.entryId);
  });

  it('accepts a PDF, PNG or JPEG receipt by its real content, kept in private storage; refuses other files', async () => {
    const up = await fin().post(`${API}/bills/${billId}/receipt`).attach('file', PNG, { filename: 'receipt.png', contentType: 'image/png' }).expect(201);
    expect(up.body.mimeType).toBe('image/png');
    const txt = await fin().post(`${API}/bills/${billId}/receipt`).attach('file', Buffer.from('just text pretending'), { filename: 'receipt.pdf', contentType: 'application/pdf' }).expect(400);
    expect(txt.body.code).toBe('file_type_not_allowed');
    const docx = Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from('....word/document.xml....')]);
    expect((await fin().post(`${API}/bills/${billId}/receipt`).attach('file', docx, { filename: 'r.docx' }).expect(400)).body.code).toBe('file_type_not_allowed');
    await fin().post(`${API}/bills/${billId}/receipt`).attach('file', Buffer.concat([Buffer.from('%PDF-'), Buffer.alloc(10 * 1024 * 1024)]), { filename: 'big.pdf' }).expect(413);
    await fin().post(`${API}/bills/${billId}/receipt`).expect(400);

    const bill = (await fin().get(`${API}/bills/${billId}`).expect(200)).body;
    expect(bill.receipts).toHaveLength(1);
    const stored = filesUnder(t.storageRoot);
    expect(stored.some((f) => f.includes('receipts') && f.endsWith('.png') && !f.includes('receipt.png'))).toBe(true); // generated name
    const down = await fin().get(`${API}/receipts/${up.body.id}`).buffer(true).parse((res, cb) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => cb(null, Buffer.concat(chunks)));
    }).expect(200);
    expect(Buffer.compare(down.body as Buffer, PNG)).toBe(0);
    expect(await prisma.auditLog.count({ where: { action: 'finance.receipt.downloaded', targetId: up.body.id } })).toBe(1);
    await t.as(DEV).get(`${API}/receipts/${up.body.id}`).expect(404);
  });

  it('a payment made settles the bill once its entry is posted', async () => {
    const pay = (await fin().post(`${API}/payments`).send({ direction: 'made', partyId: vendor, bankAccountId: acc['1100'], paymentDate: '2026-09-15', amount: '12000.00', allocations: [{ billId, amount: '12000.00' }] }).expect(201)).body;
    const entry = (await fin().get(`${API}/journal-entries/${pay.entryId}`).expect(200)).body;
    expect(entry.lines.map((l: { accountCode: string; debit: string }) => [l.accountCode, l.debit])).toEqual([
      ['2100', '12000.00'],
      ['1100', '0.00'],
    ]);
    expect((await fin().get(`${API}/bills/${billId}`).expect(200)).body.status).toBe('unpaid');
    await approve(pay.entryId);
    expect((await fin().get(`${API}/bills/${billId}`).expect(200)).body).toMatchObject({ status: 'paid', paid: '12000.00' });
    expect((await fin().post(`${API}/payments`).send({ direction: 'made', partyId: vendor, bankAccountId: acc['1100'], paymentDate: '2026-09-15', amount: '1', allocations: [{ invoiceId: billId, amount: '1' }] }).expect(400)).body.code).toBe('wrong_document');
  });
});

describe('M9 transfers between bank accounts', () => {
  it('PKR to USD: both amounts given; the entry keeps the effective rate and exact PKR amounts', async () => {
    await fin().post(`${API}/transfers`).send({ fromAccountId: acc['1100'], toAccountId: acc['1100'], date: '2026-09-20', amount: '10' }).expect(400);
    expect((await fin().post(`${API}/transfers`).send({ fromAccountId: acc['1100'], toAccountId: acc['1110'], date: '2026-09-20', amount: '278000.00' }).expect(400)).body.code).toBe('to_amount_required');
    const e = (await fin().post(`${API}/transfers`).send({ fromAccountId: acc['1100'], toAccountId: acc['1110'], date: '2026-09-20', amount: '278000.00', toAmount: '1000.00' }).expect(201)).body;
    expect(e).toMatchObject({ source: 'transfer', currency: 'USD', exchangeRate: '278.000000', totalBase: '278000.00', status: 'pending_approval', requiredLevel: 2 });
    expect(e.lines.map((l: { accountCode: string; debit: string; baseDebit: string; baseCredit: string }) => [l.accountCode, l.debit, l.baseDebit, l.baseCredit])).toEqual([
      ['1110', '1000.00', '278000.00', '0.00'],
      ['1100', '0.00', '0.00', '278000.00'],
    ]);
    await t.stepUp(CEO);
    await approve(e.id, CEO);
    const banks = (await fin().get(`${API}/bank-accounts`).expect(200)).body;
    expect(banks.find((b: { code: string }) => b.code === '1110')).toMatchObject({ foreignBalance: '1000.00', balance: '278000.00' });
    expect((await fin().get(`${API}/transfers`).expect(200)).body.items.map((x: { id: string }) => x.id)).toContain(e.id);
  });
});

describe('M9 reports read posted lines only', () => {
  it('trial balance balances; aging, bills to pay, profit by project and by client, general ledger', async () => {
    const tb = (await fin().get(`${API}/ledger/reports/trial-balance?date=2026-09-30`).expect(200)).body;
    expect(tb.balanced).toBe(true);
    expect(tb.totalDebit).toBe(tb.totalCredit);

    const aging = (await fin().get(`${API}/ledger/reports/ar-aging?date=2026-11-12`).expect(200)).body;
    expect(aging.items).toHaveLength(1); // the 700.00 support invoice; the paid one is not listed
    expect(aging.items[0]).toMatchObject({ open: '700.00', bucket: '61-90' });

    const due = (await fin().get(`${API}/ledger/reports/ap-due?date=2026-11-12`).expect(200)).body;
    expect(due.items).toHaveLength(0);

    const byProject = (await fin().get(`${API}/ledger/reports/profit-by-project?from=2026-09-01&to=2026-09-30`).expect(200)).body;
    const acmeWeb = byProject.rows.find((r: { id: string }) => r.id === project);
    expect(acmeWeb).toMatchObject({ income: '4000.99', expense: '12000.00', profit: '-7999.01' });

    const byClient = (await fin().get(`${API}/ledger/reports/profit-by-client?from=2026-09-01&to=2026-09-30`).expect(200)).body;
    expect(byClient.rows.find((r: { id: string }) => r.id === acme)).toMatchObject({ income: '4700.99' });

    const gl = (await fin().get(`${API}/ledger/reports/general-ledger?accountId=${acc['1200']}&from=2026-09-01&to=2026-09-30`).expect(200)).body;
    expect(gl.opening).toBe('0.00');
    expect(gl.closing).toBe('700.00');
    await fin().get(`${API}/ledger/reports/profit-by-project?from=2026-09-30&to=2026-09-01`).expect(400);
  });

  it('exports posted lines as CSV only for levels 1-3, after "confirm again", watermarked and logged', async () => {
    await fin().get(`${API}/ledger/export?from=2026-09-01&to=2026-09-30`).expect(404); // the finance officer (level 4) has no finance.export
    expect((await t.as(DIRECTOR).get(`${API}/ledger/export?from=2026-09-01&to=2026-09-30`).expect(403)).body.code).toBe('step_up_required');
    await t.stepUp(DIRECTOR);
    const r = await t.as(DIRECTOR).get(`${API}/ledger/export?from=2026-09-01&to=2026-09-30`).expect(200);
    expect(r.text.split('\r\n')[0]).toMatch(/^"Confidential, exported by ACV-0003 on \d{4}-\d{2}-\d{2} \d{2}:\d{2} \(Pakistan time\)"$/);
    expect(r.text).toContain('INV-');
    expect(await prisma.auditLog.count({ where: { action: 'finance.export', actor: { empId: DIRECTOR } } })).toBe(1);
  });
});
