import { describe, expect, it } from 'vitest';
import {
  createAccountSchema,
  financeSettingsSchema,
  createBillSchema,
  createEntrySchema,
  createInvoiceSchema,
  createPaymentSchema,
  createTransferSchema,
  entryLineSchema,
  reverseEntrySchema,
} from '@aceva/contracts';
import { dec } from '../common/money';
import { labelFor, levelCovers, ownerNotice, requiredApprovalLevel } from './approval-tier';
import { csvCell } from './finance-export.service';
import { parseCsv, parseStatement } from './statement-csv';

/** Pure M9 rules: who approves an entry, statement CSV, CSV export cells, and the shared request schemas. */
describe('who approves an entry (decision D26)', () => {
  it('the Director approves every entry made by Level 3, 4 or 5, whatever the amount', () => {
    for (const makerLevel of [3, 4, 5]) expect(requiredApprovalLevel(makerLevel)).toEqual({ ok: true, level: 2, label: 'Director' });
    expect(requiredApprovalLevel(null)).toEqual({ ok: true, level: 2, label: 'Director' });
  });

  it('an entry the Director made goes one level up, to the Owner; an entry the Owner made has nobody above', () => {
    expect(requiredApprovalLevel(2)).toEqual({ ok: true, level: 1, label: 'CEO / Founder / Owner' });
    expect(requiredApprovalLevel(1)).toEqual({ ok: false, reason: 'no_eligible_approver' });
  });

  it('an entry is approved at exactly its level: the Owner never takes over the Director' + "'" + 's approvals', () => {
    expect(levelCovers(2, 2)).toBe(true);
    expect(levelCovers(1, 1)).toBe(true);
    expect(levelCovers(1, 2)).toBe(false); // the Owner only views what the Director approves
    expect(levelCovers(2, 1)).toBe(false);
    expect(levelCovers(3, 2)).toBe(false);
    expect(labelFor(2)).toBe('Director');
    expect(labelFor(1)).toBe('CEO / Founder / Owner');
  });

  it('the Owner is told about large entries and capital or loan entries, and about nothing else', () => {
    expect(ownerNotice(dec('500000.00'), dec('500000'), false)).toBeNull();
    expect(ownerNotice(dec('500000.01'), dec('500000'), false)).toBe('large_amount');
    expect(ownerNotice(dec('10'), dec('500000'), true)).toBe('capital_or_loan');
    expect(ownerNotice(dec('600000'), dec('500000'), true)).toBe('capital_or_loan');
  });
});

describe('bank statement CSV', () => {
  it('parses quotes, commas inside quotes, CRLF and a BOM', () => {
    expect(parseCsv('﻿a,"b, c","d ""q"""\r\n1,2,3\n')).toEqual([
      ['a', 'b, c', 'd "q"'],
      ['1', '2', '3'],
    ]);
  });

  it('reads columns by name and lists every problem by row', () => {
    const ok = parseStatement('Amount,Date,Description,Reference\n-1200.50,2026-10-05,Rent,R1\n"1,000",2026-10-06,In,\n');
    expect(ok.errors).toEqual([]);
    expect(ok.rows).toEqual([
      { lineNo: 1, date: '2026-10-05', description: 'Rent', amount: '-1200.50', reference: 'R1' },
      { lineNo: 2, date: '2026-10-06', description: 'In', amount: '1000', reference: null },
    ]);
    const bad = parseStatement('date,description,amount\n2026-02-30,x,1\n2026-10-01,,1.234\n');
    expect(bad.errors.map((e) => e.row)).toEqual([2, 3]);
    expect(bad.errors[1].message).toContain('description is empty');
    expect(parseStatement('').errors[0].message).toContain('empty');
    expect(parseStatement('date,amount\n2026-10-01,1\n').errors[0].row).toBe(1);
  });
});

describe('CSV export cells', () => {
  it('quotes separators and neutralises spreadsheet formulas', () => {
    expect(csvCell('a,b')).toBe('"a,b"');
    expect(csvCell('=HYPERLINK("x")')).toBe(`"'=HYPERLINK(""x"")"`);
    expect(csvCell('-5')).toBe("'-5");
    expect(csvCell(null)).toBe('');
  });
});

describe('M9 request schemas (packages/contracts/src/ledger.ts)', () => {
  const a = '00000000-0000-4000-8000-000000000001';
  const b = '00000000-0000-4000-8000-000000000002';

  it('entry lines have exactly one positive side', () => {
    expect(entryLineSchema.safeParse({ accountId: a, debit: '10.00' }).success).toBe(true);
    expect(entryLineSchema.safeParse({ accountId: a, debit: '10', credit: '0' }).success).toBe(true);
    expect(entryLineSchema.safeParse({ accountId: a, debit: '10', credit: '1' }).success).toBe(false);
    expect(entryLineSchema.safeParse({ accountId: a }).success).toBe(false);
    expect(entryLineSchema.safeParse({ accountId: a, debit: '-10' }).success).toBe(false);
    expect(entryLineSchema.safeParse({ accountId: a, debit: '10.001' }).success).toBe(false);
    expect(entryLineSchema.safeParse({ accountId: a, debit: 10 }).success).toBe(false); // money is a string, never a float
  });

  it('entries need a day, a description and two lines', () => {
    const lines = [
      { accountId: a, debit: '1' },
      { accountId: b, credit: '1' },
    ];
    expect(createEntrySchema.safeParse({ date: '2026-10-01', description: 'x', lines }).success).toBe(true);
    expect(createEntrySchema.parse({ date: '2026-10-01', description: 'x', lines }).currency).toBe('PKR');
    expect(createEntrySchema.safeParse({ date: '2026-10-01', description: 'x', lines: lines.slice(0, 1) }).success).toBe(false);
    expect(createEntrySchema.safeParse({ date: '01/10/2026', description: 'x', lines }).success).toBe(false);
    expect(createEntrySchema.safeParse({ date: '2026-10-01', description: 'x', currency: 'EUR', lines }).success).toBe(false);
    expect(createEntrySchema.safeParse({ date: '2026-10-01', description: 'x', currency: 'USD', exchangeRate: '0', lines }).success).toBe(false);
  });

  it('account codes start with the digit of their group', () => {
    expect(createAccountSchema.safeParse({ code: '5400', name: 'Travel', group: 'expense' }).success).toBe(true);
    expect(createAccountSchema.safeParse({ code: '4400', name: 'Travel', group: 'expense' }).success).toBe(false);
    expect(createAccountSchema.safeParse({ code: '54', name: 'Travel', group: 'expense' }).success).toBe(false);
  });

  it('invoices, bills, payments and transfers', () => {
    expect(createInvoiceSchema.safeParse({ partyId: a, issueDate: '2026-10-01', dueDate: '2026-10-31', lines: [{ description: 'x', quantity: '1', unitPrice: '10', accountCode: '4100' }] }).success).toBe(true);
    expect(createInvoiceSchema.safeParse({ partyId: a, issueDate: '2026-10-01', dueDate: '2026-09-30', lines: [{ description: 'x', quantity: '1', unitPrice: '10', accountCode: '4100' }] }).success).toBe(false);
    expect(createInvoiceSchema.safeParse({ partyId: a, issueDate: '2026-10-01', dueDate: '2026-10-31', lines: [{ description: 'x', quantity: '0', unitPrice: '10', accountCode: '4100' }] }).success).toBe(false);
    expect(createBillSchema.safeParse({ partyId: a, billDate: '2026-10-01', dueDate: '2026-10-31', accountCode: '5200', description: 'x', total: '0' }).success).toBe(false);
    expect(createPaymentSchema.safeParse({ direction: 'received', partyId: a, bankAccountId: b, paymentDate: '2026-10-01', amount: '5', allocations: [{ invoiceId: a, billId: b, amount: '5' }] }).success).toBe(false);
    expect(createTransferSchema.safeParse({ fromAccountId: a, toAccountId: a, date: '2026-10-01', amount: '5' }).success).toBe(false);
    expect(reverseEntrySchema.safeParse({ reason: 'no' }).success).toBe(false);
  });

  it('finance settings: both amounts are money strings and the year starts in a real month', () => {
    const ok = { stepUpAbove: '50000', ownerNotifyAbove: '500000', financeYearStartMonth: 7, reason: 'Board decision' };
    expect(financeSettingsSchema.safeParse(ok).success).toBe(true);
    expect(financeSettingsSchema.safeParse({ ...ok, ownerNotifyAbove: 'lots' }).success).toBe(false);
    expect(financeSettingsSchema.safeParse({ ...ok, financeYearStartMonth: 13 }).success).toBe(false);
  });
});
