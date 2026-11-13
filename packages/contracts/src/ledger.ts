import { z } from 'zod';
import { empIdSchema } from './events';
import { currencySchema, daySchema, decisionReasonSchema, moneySchema, monthSchema, pageQuerySchema, positiveMoneySchema, rateSchema } from './shared';

/**
 * Module 9 finance ledger: request schemas (validated by the server with createZodDto) and response types, shared with the website.
 * Owner: Track C. Other tracks read this file; they never edit it. A breaking change is coordinated through the schema owner.
 *
 * Money is always a decimal STRING ("1250.00"); responses carry exactly 2 decimals. PKR is the base currency; a USD entry keeps
 * the exchange rate (PKR per 1 USD) it was made with, and every line also carries its PKR ("base") amount.
 */

export const ledgerMonthQuerySchema = z.object({ month: monthSchema });
export const ledgerDayQuerySchema = z.object({ date: daySchema.optional() });

export const accountGroupSchema = z.enum(['asset', 'liability', 'equity', 'income', 'expense']);
export type AccountGroup = z.infer<typeof accountGroupSchema>;

export const journalSourceSchema = z.enum(['manual', 'invoice', 'bill', 'payment', 'transfer', 'payroll', 'payroll_payment', 'advance', 'reversal', 'revaluation', 'opening']);
export type JournalSource = z.infer<typeof journalSourceSchema>;

/** Stored statuses plus "reversed" (a posted entry whose reversing entry is posted; shown, never stored). */
export const entryStatusSchema = z.enum(['draft', 'pending_approval', 'posted', 'rejected', 'reversed']);
export type EntryStatus = z.infer<typeof entryStatusSchema>;

/** Amount on one side of a line: "0" / "0.00" / missing means "not this side". */
const sideSchema = moneySchema.optional();
const uuid = z.uuid();
const text = (max: number) => z.string().trim().min(1).max(max);
const optionalText = (max: number) => z.string().trim().max(max).optional();

// ----------------------------------------------------------------------------------------------------------- chart of accounts

/** Codes are numbers in the plan's five groups: 1xxx assets, 2xxx liabilities, 3xxx equity, 4xxx income, 5xxx expenses. */
export const GROUP_FIRST_DIGIT: Record<AccountGroup, string> = { asset: '1', liability: '2', equity: '3', income: '4', expense: '5' };

export const createAccountSchema = z
  .object({
    code: z.string().trim().regex(/^[1-5]\d{3,5}$/, 'An account code is 4 to 6 digits starting with 1 to 5'),
    name: text(120),
    group: accountGroupSchema,
    parentId: uuid.optional(),
    currency: currencySchema.default('PKR'),
    requiresOwnerApproval: z.boolean().optional(),
    isOci: z.boolean().optional(),
  })
  .refine((v) => v.code.startsWith(GROUP_FIRST_DIGIT[v.group]), { message: 'The code must start with the digit of its group (1 assets ... 5 expenses)', path: ['code'] });

/** PUT /accounts/:id/owner-approval (Owner only, decision D22). */
export const ownerApprovalSchema = z.object({ required: z.boolean(), reason: decisionReasonSchema });

export const updateAccountSchema = z.object({
  name: text(120).optional(),
  archived: z.boolean().optional(),
  requiresOwnerApproval: z.boolean().optional(),
  isOci: z.boolean().optional(),
  reason: decisionReasonSchema,
});

export interface AccountView {
  id: string;
  code: string;
  name: string;
  group: AccountGroup;
  parentId: string | null;
  currency: 'PKR' | 'USD';
  isBank: boolean;
  /** Has active child accounts: groups others and takes no postings. */
  isHeader: boolean;
  requiresOwnerApproval: boolean;
  isOci: boolean;
  systemRole: string | null;
  active: boolean;
  /** PKR balance of POSTED lines, natural sign (debit balance for assets and expenses, credit balance for the rest). */
  balance: string;
  /** USD accounts: USD balance of posted USD lines, natural sign. */
  foreignBalance: string | null;
}

// ----------------------------------------------------------------------------------------------------------- bank accounts

export const createBankAccountSchema = z.object({
  code: z.string().trim().regex(/^1\d{3,5}$/, 'A bank account is an asset: its code starts with 1'),
  name: text(120),
  currency: currencySchema,
  bankName: text(120),
  accountNumber: z.string().trim().regex(/^[A-Za-z0-9 -]{4,40}$/, 'Enter the account number or IBAN'),
});

export const bankDetailsSchema = z.object({
  bankName: text(120),
  accountNumber: z.string().trim().regex(/^[A-Za-z0-9 -]{4,40}$/, 'Enter the account number or IBAN'),
  reason: decisionReasonSchema,
});

export interface BankAccountView {
  id: string;
  code: string;
  name: string;
  currency: 'PKR' | 'USD';
  bankName: string | null;
  /** Never the number: "•••• 1234" (or null when no details are stored). */
  accountNumberMasked: string | null;
  active: boolean;
  /** PKR book balance of posted lines. */
  balance: string;
  /** USD accounts: the USD balance. */
  foreignBalance: string | null;
}

// ----------------------------------------------------------------------------------------------------------- parties, projects, rates

export const partyKindSchema = z.enum(['client', 'vendor']);
export const createPartySchema = z.object({
  kind: partyKindSchema,
  name: text(160),
  email: z.email().max(200).optional(),
  phone: optionalText(40),
  country: optionalText(80),
  address: optionalText(400),
  currency: currencySchema.default('PKR'),
});
export const updatePartySchema = createPartySchema.omit({ kind: true }).partial().extend({ archived: z.boolean().optional() });
export const partyListQuerySchema = pageQuerySchema.extend({
  kind: partyKindSchema.optional(),
  q: z.string().trim().max(100).optional(),
  includeArchived: z.enum(['true', 'false']).optional(),
});

export interface PartyView {
  id: string;
  kind: 'client' | 'vendor';
  name: string;
  email: string | null;
  phone: string | null;
  country: string | null;
  address: string | null;
  currency: 'PKR' | 'USD';
  active: boolean;
  /** Receivable (client) or payable (vendor) in PKR, from posted lines on the receivable / payable account. */
  balance: string;
}

export const createProjectSchema = z.object({ code: z.string().trim().regex(/^[A-Za-z0-9_-]{2,20}$/, 'A short code, e.g. ACME-WEB'), name: text(160) });
export const updateProjectSchema = z.object({ name: text(160).optional(), archived: z.boolean().optional() });
export interface ProjectView {
  id: string;
  code: string;
  name: string;
  active: boolean;
}

export const createRateSchema = z.object({ date: daySchema, currency: z.literal('USD').default('USD'), rate: rateSchema, source: optionalText(120) });
export const rateQuerySchema = z.object({ from: daySchema.optional(), to: daySchema.optional() });
export interface ExchangeRateView {
  id: string;
  date: string;
  currency: 'USD';
  /** PKR per 1 USD, 6 decimals. */
  rate: string;
  source: string | null;
}

// ----------------------------------------------------------------------------------------------------------- journal entries

export const entryLineSchema = z
  .object({
    accountId: uuid,
    description: optionalText(300),
    debit: sideSchema,
    credit: sideSchema,
    partyId: uuid.optional(),
    empId: empIdSchema.optional(),
  })
  .refine((l) => (Number(l.debit ?? 0) > 0) !== (Number(l.credit ?? 0) > 0), { message: 'A line has a debit or a credit (one of them, more than zero)' });

export const createEntrySchema = z.object({
  date: daySchema,
  description: text(300),
  projectId: uuid.optional(),
  currency: currencySchema.default('PKR'),
  /** USD only: PKR per 1 USD. Missing = the saved rate for the entry date. */
  exchangeRate: rateSchema.optional(),
  lines: z.array(entryLineSchema).min(2, 'An entry needs at least two lines').max(200),
  /** Also submit it for approval in the same step. */
  submit: z.boolean().optional(),
});
export const updateEntrySchema = createEntrySchema.omit({ submit: true });

export const reverseEntrySchema = z.object({ reason: decisionReasonSchema, date: daySchema.optional() });
export const approveEntrySchema = z.object({ note: optionalText(500) });

export const entryListQuerySchema = pageQuerySchema.extend({
  status: entryStatusSchema.or(z.literal('all')).optional(),
  month: monthSchema.optional(),
  source: journalSourceSchema.or(z.literal('all')).optional(),
  accountId: uuid.optional(),
  partyId: uuid.optional(),
  projectId: uuid.optional(),
  /** Only entries waiting for the caller's approval. */
  awaitingMe: z.enum(['true', 'false']).optional(),
  q: z.string().trim().max(100).optional(),
});

export interface EntryLineView {
  id: string;
  lineNo: number;
  accountId: string;
  accountCode: string;
  accountName: string;
  description: string | null;
  debit: string;
  credit: string;
  baseDebit: string;
  baseCredit: string;
  partyId: string | null;
  partyName: string | null;
  empId: string | null;
}

export interface EntryEventView {
  at: string;
  action: string;
  byEmpId: string | null;
  byName: string | null;
  note: string | null;
}

export interface EntryView {
  id: string;
  number: string;
  date: string;
  description: string;
  source: JournalSource;
  sourceRef: string | null;
  purpose: string | null;
  projectId: string | null;
  projectCode: string | null;
  currency: 'PKR' | 'USD';
  exchangeRate: string;
  /** Total debits in the entry currency. */
  total: string;
  /** Total debits in PKR: drives the approval tier. */
  totalBase: string;
  status: EntryStatus;
  /** The tier the amount needs (a level number; 1 = Owner). Set when submitted; for a draft, what it would need now. */
  requiredLevel: number | null;
  requiredApproverLabel: string | null;
  /** Approving needs "confirm again" (the PKR total is above the finance setting). */
  needsStepUp: boolean;
  /** The caller may approve or reject it now (permission, tier, not the maker). */
  canApprove: boolean;
  makerEmpId: string;
  makerName: string;
  createdAt: string;
  submittedAt: string | null;
  approvedByEmpId: string | null;
  postedAt: string | null;
  rejectedByEmpId: string | null;
  rejectedReason: string | null;
  reversalOfId: string | null;
  reversalOfNumber: string | null;
  reversedById: string | null;
  reversedByNumber: string | null;
  lines: EntryLineView[];
  events: EntryEventView[];
  receipts: ReceiptView[];
}

export interface ReceiptView {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  uploadedAt: string;
}

// ----------------------------------------------------------------------------------------------------------- invoices, bills, payments

const accountRef = { accountId: uuid.optional(), accountCode: z.string().trim().regex(/^\d{4,6}$/).optional() };

export const invoiceLineSchema = z
  .object({
    description: text(300),
    quantity: z.string().trim().regex(/^\d{1,8}(\.\d{1,2})?$/, 'A quantity looks like 1 or 2.5').refine((v) => Number(v) > 0, 'The quantity must be more than zero'),
    unitPrice: moneySchema,
    ...accountRef,
  })
  .refine((l) => !!l.accountId !== !!l.accountCode, { message: 'Choose the income account of the line' });

export const createInvoiceSchema = z
  .object({
    partyId: uuid,
    issueDate: daySchema,
    dueDate: daySchema,
    currency: currencySchema.default('PKR'),
    exchangeRate: rateSchema.optional(),
    projectId: uuid.optional(),
    notes: optionalText(1000),
    lines: z.array(invoiceLineSchema).min(1).max(100),
  })
  .refine((v) => v.dueDate >= v.issueDate, { message: 'The due date cannot be before the issue date', path: ['dueDate'] });

export const documentStatusSchema = z.enum(['unpaid', 'part_paid', 'paid']);
export const documentListQuerySchema = pageQuerySchema.extend({
  partyId: uuid.optional(),
  status: documentStatusSchema.or(z.literal('all')).optional(),
});

export interface InvoiceView {
  id: string;
  number: string;
  partyId: string;
  partyName: string;
  issueDate: string;
  dueDate: string;
  currency: 'PKR' | 'USD';
  exchangeRate: string;
  total: string;
  totalBase: string;
  /** Paid by POSTED payments (entry currency). */
  paid: string;
  /** Total minus everything allocated by payments that are not rejected (what can still be allocated). */
  open: string;
  /** Calculated, never stored: from the allocations of payments whose entries are posted. */
  status: 'unpaid' | 'part_paid' | 'paid';
  projectId: string | null;
  notes: string | null;
  entryId: string | null;
  entryNumber: string | null;
  entryStatus: EntryStatus | null;
  lines: { lineNo: number; description: string; quantity: string; unitPrice: string; amount: string; accountId: string; accountCode: string }[];
}

export const createBillSchema = z
  .object({
    partyId: uuid,
    billDate: daySchema,
    dueDate: daySchema,
    currency: currencySchema.default('PKR'),
    exchangeRate: rateSchema.optional(),
    ...accountRef,
    projectId: uuid.optional(),
    description: text(300),
    vendorRef: optionalText(80),
    total: positiveMoneySchema,
  })
  .refine((v) => !!v.accountId !== !!v.accountCode, { message: 'Choose the expense account', path: ['accountId'] })
  .refine((v) => v.dueDate >= v.billDate, { message: 'The due date cannot be before the bill date', path: ['dueDate'] });

export interface BillView {
  id: string;
  number: string;
  partyId: string;
  partyName: string;
  vendorRef: string | null;
  billDate: string;
  dueDate: string;
  currency: 'PKR' | 'USD';
  exchangeRate: string;
  total: string;
  totalBase: string;
  paid: string;
  open: string;
  status: 'unpaid' | 'part_paid' | 'paid';
  accountId: string;
  accountCode: string;
  projectId: string | null;
  description: string;
  entryId: string | null;
  entryNumber: string | null;
  entryStatus: EntryStatus | null;
  receipts: ReceiptView[];
}

export const paymentAllocationSchema = z
  .object({ invoiceId: uuid.optional(), billId: uuid.optional(), amount: positiveMoneySchema })
  .refine((a) => !!a.invoiceId !== !!a.billId, { message: 'An allocation is for one invoice or one bill' });

export const createPaymentSchema = z.object({
  direction: z.enum(['received', 'made']),
  partyId: uuid,
  bankAccountId: uuid,
  paymentDate: daySchema,
  amount: positiveMoneySchema,
  /** USD bank accounts only. Missing = the saved rate for the payment date. */
  exchangeRate: rateSchema.optional(),
  method: optionalText(40),
  reference: optionalText(80),
  projectId: uuid.optional(),
  allocations: z.array(paymentAllocationSchema).max(50).default([]),
});

export interface PaymentView {
  id: string;
  direction: 'received' | 'made';
  partyId: string;
  partyName: string;
  bankAccountId: string;
  bankAccountName: string;
  paymentDate: string;
  currency: 'PKR' | 'USD';
  exchangeRate: string;
  amount: string;
  method: string | null;
  reference: string | null;
  entryId: string | null;
  entryNumber: string | null;
  entryStatus: EntryStatus | null;
  allocations: { invoiceId: string | null; billId: string | null; documentNumber: string; amount: string }[];
}

export const createTransferSchema = z
  .object({
    fromAccountId: uuid,
    toAccountId: uuid,
    date: daySchema,
    /** In the FROM account's currency. */
    amount: positiveMoneySchema,
    /** Different currencies: the amount that arrived, in the TO account's currency. */
    toAmount: positiveMoneySchema.optional(),
    /** Same-currency USD transfers: PKR per 1 USD (missing = the saved rate for the date). */
    exchangeRate: rateSchema.optional(),
    description: optionalText(300),
  })
  .refine((v) => v.fromAccountId !== v.toAccountId, { message: 'Choose two different accounts', path: ['toAccountId'] });

// ----------------------------------------------------------------------------------------------------------- bank reconciliation

export const statementQuerySchema = z.object({ bankAccountId: uuid, month: monthSchema });
export const matchLineSchema = z.object({ journalLineId: uuid });
export const autoMatchSchema = z.object({ bankAccountId: uuid, month: monthSchema });
export const statementEntrySchema = z.object({
  counterAccountId: uuid,
  description: optionalText(300),
  partyId: uuid.optional(),
  submit: z.boolean().optional(),
});

export interface StatementImportResult {
  importId: string;
  lineCount: number;
}

export interface LedgerBankLineView {
  journalLineId: string;
  entryId: string;
  entryNumber: string;
  date: string;
  description: string;
  /** Signed, in the bank account's currency: positive = money in. */
  amount: string;
  matched: boolean;
}

export interface StatementLineView {
  id: string;
  importId: string;
  lineNo: number;
  date: string;
  description: string;
  reference: string | null;
  /** Signed, in the bank account's currency: positive = money in. */
  amount: string;
  matchedJournalLineId: string | null;
  matchedEntryId: string | null;
  matchedEntryNumber: string | null;
  /** Posted ledger lines on this bank account with the same signed amount within 3 days, not yet matched. */
  suggestions: LedgerBankLineView[];
}

export interface ReconciliationView {
  bankAccountId: string;
  month: string;
  statement: StatementLineView[];
  ledger: LedgerBankLineView[];
  /** Statement lines with no match and no suggestion: money the ledger does not know about yet. */
  missingInLedger: StatementLineView[];
  /** Posted ledger lines in the month that no statement line matches. */
  missingInBank: LedgerBankLineView[];
}

// ----------------------------------------------------------------------------------------------------------- periods, revaluation

export const revaluationSchema = z.object({ rate: rateSchema.optional() });
export const reopenSchema = z.object({ reason: decisionReasonSchema });

export type ChecklistKey = 'entries_posted' | 'bank_reconciled' | 'payroll_posted' | 'usd_revalued' | 'trial_balance';
export interface ChecklistItemView {
  key: ChecklistKey;
  label: string;
  done: boolean;
  detail: string;
}

export interface PeriodView {
  month: string;
  /** "reopened" = open again after having been closed (shown, from the period history). */
  status: 'open' | 'closing' | 'closed' | 'reopened';
  checklist: ChecklistItemView[];
  closeRequestedByEmpId: string | null;
  closeRequestedAt: string | null;
  closedByEmpId: string | null;
  closedAt: string | null;
  /** The caller may approve or reject the close request now. */
  canApproveClose: boolean;
  events: { at: string; action: string; byEmpId: string; reason: string | null }[];
}

export interface RevaluationPreviewView {
  month: string;
  date: string;
  rate: string;
  rows: { accountId: string; code: string; name: string; foreign: string; bookBase: string; revaluedBase: string; difference: string }[];
  /** Net gain (+) or loss (-) in PKR. */
  total: string;
  existingEntryId: string | null;
  existingEntryNumber: string | null;
  existingEntryStatus: EntryStatus | null;
}

// ----------------------------------------------------------------------------------------------------------- settings

export const approvalLimitsSchema = z.object({
  limits: z
    .array(z.object({ approverLevel: z.number().int().min(1).max(5), maxAmount: positiveMoneySchema.nullable(), label: text(120) }))
    .min(1)
    .max(5),
  reason: decisionReasonSchema,
});
export interface ApprovalLimitView {
  approverLevel: number;
  /** Null = no upper limit. */
  maxAmount: string | null;
  label: string;
}

export const financeSettingsSchema = z.object({
  stepUpAbove: moneySchema,
  financeYearStartMonth: z.number().int().min(1).max(12),
  reason: decisionReasonSchema,
});
export interface FinanceSettingsView {
  stepUpAbove: string;
  financeYearStartMonth: number;
}

// ----------------------------------------------------------------------------------------------------------- reports

export const reportRangeQuerySchema = z.object({ from: daySchema, to: daySchema }).refine((v) => v.from <= v.to, { message: 'The range ends before it starts' });
export const generalLedgerQuerySchema = z
  .object({ accountId: uuid, from: daySchema, to: daySchema })
  .refine((v) => v.from <= v.to, { message: 'The range ends before it starts' });

export interface TrialBalanceView {
  date: string;
  rows: { accountId: string; code: string; name: string; group: AccountGroup; debit: string; credit: string }[];
  totalDebit: string;
  totalCredit: string;
  balanced: boolean;
}

export interface GeneralLedgerView {
  accountId: string;
  code: string;
  name: string;
  from: string;
  to: string;
  opening: string;
  lines: { date: string; entryId: string; entryNumber: string; description: string; debit: string; credit: string; balance: string }[];
  closing: string;
}

export interface AgingView {
  date: string;
  buckets: { label: '0-30' | '31-60' | '61-90' | '90+'; amount: string; count: number }[];
  items: { id: string; number: string; partyId: string; partyName: string; issueDate: string; dueDate: string; ageDays: number; bucket: string; currency: 'PKR' | 'USD'; open: string; openBase: string }[];
  total: string;
}

export interface BillsDueView {
  date: string;
  items: { id: string; number: string; partyId: string; partyName: string; dueDate: string; overdueDays: number; currency: 'PKR' | 'USD'; open: string; openBase: string }[];
  total: string;
}

export interface ProfitView {
  from: string;
  to: string;
  rows: { id: string | null; label: string; income: string; expense: string; profit: string }[];
}
