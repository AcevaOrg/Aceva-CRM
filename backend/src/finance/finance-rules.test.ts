import { describe, expect, it } from 'vitest';
import {
  approvalLimitsSchema,
  createAccountSchema,
  createBillSchema,
  createEntrySchema,
  createInvoiceSchema,
  createPaymentSchema,
  createTransferSchema,
  entryLineSchema,
  reverseEntrySchema,
} from '@aceva/contracts';
import { dec } from '../common/money';
import { requiredApprovalLevel, type Tier } from './approval-tier';
import { csvCell } from './finance-export.service';
import { parseCsv, parseStatement } from './statement-csv';

/** Pure M9 rules: approval tiers, statement CSV, CSV export cells, and the shared request schemas. */
const TIERS: Tier[] = [
  { approverLevel: 3, maxAmount: dec(50000), label: 'Director (plan example limit)' },
  { approverLevel: 2, maxAmount: dec(500000), label: 'CEO (plan example limit)' },
  { approverLevel: 1, maxAmount: null, label: 'Owner' },
];

describe('approval tier (plan section 13)', () => {
  it('picks the tier whose limit covers the PKR total', () => {
    expect(requiredApprovalLevel(dec('50000.00'), TIERS, false, 4)).toEqual({ ok: true, level: 3, label: 'Director' });
    expect(requiredApprovalLevel(dec('50000.01'), TIERS, false, 4)).toMatchObject({ level: 2, label: 'CEO' });
    expect(requiredApprovalLevel(dec('500000.00'), TIERS, false, 4)).toMatchObject({ level: 2 });
    expect(requiredApprovalLevel(dec('500000.01'), TIERS, false, 4)).toMatchObject({ level: 1 });
  });

  it('capital and loan accounts always need the Owner', () => {
    expect(requiredApprovalLevel(dec('10'), TIERS, true, 4)).toMatchObject({ level: 1 });
  });

  it('goes one level up when the maker is at the required level or above it', () => {
    expect(requiredApprovalLevel(dec('100'), TIERS, false, 3)).toMatchObject({ level: 2 });
    expect(requiredApprovalLevel(dec('100'), TIERS, false, 2)).toMatchObject({ level: 1 });
    expect(requiredApprovalLevel(dec('600000'), TIERS, false, 2)).toMatchObject({ level: 1 });
    expect(requiredApprovalLevel(dec('100'), TIERS, false, 1)).toEqual({ ok: false, reason: 'no_eligible_approver' });
    expect(requiredApprovalLevel(dec('100'), TIERS, true, 1)).toEqual({ ok: false, reason: 'no_eligible_approver' });
  });

  it('without a tier covering the amount there is no approver', () => {
    expect(requiredApprovalLevel(dec('100'), TIERS.slice(0, 1), false, 4)).toMatchObject({ level: 3 });
    expect(requiredApprovalLevel(dec('60000'), TIERS.slice(0, 1), false, 4)).toEqual({ ok: false, reason: 'no_tier' });
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

  it('approval limits: amounts are money strings or null', () => {
    expect(approvalLimitsSchema.safeParse({ reason: 'Board decision', limits: [{ approverLevel: 3, maxAmount: '50000', label: 'Director' }, { approverLevel: 1, maxAmount: null, label: 'Owner' }] }).success).toBe(true);
    expect(approvalLimitsSchema.safeParse({ reason: 'Board decision', limits: [{ approverLevel: 6, maxAmount: null, label: 'X' }] }).success).toBe(false);
  });
});
