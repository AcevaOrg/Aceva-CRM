/**
 * Module 9 · Finance ledger (plan §13)
 * Owner: Developer C (cycle 3), finance review by Developer A and the CTO. Spec §9.9.
 * This file is the API contract for the module.
 *
 * Money amounts are decimal STRINGS with 2 decimals. PKR is the base currency;
 * USD entries keep the exchange rate used on the entry (plan §13).
 */
import type { ApprovalStep, Attachment, Currency, Money, RoleKey } from "@/types";

export type AccountGroup = "asset" | "liability" | "equity" | "income" | "expense";

/** Finer role of an account, used by the statement builders (cash flow, tax summary …). */
export type AccountKind =
  | "cash"
  | "receivable"
  | "prepayment"
  | "tax_asset"
  | "fixed_asset"
  | "accumulated_depreciation"
  | "payable"
  | "salary_payable"
  | "tax_payable"
  | "accrued"
  | "customer_advance"
  | "loan"
  | "share_capital"
  | "retained_earnings"
  | "dividends"
  | "oci_reserve"
  | "revenue"
  | "other_income"
  | "expense"
  | "depreciation"
  | "finance_cost"
  | "fx";

export interface Account {
  id: string;
  code: string;
  name: string;
  group: AccountGroup;
  kind?: AccountKind;
  parentId?: string;
  /** Header accounts group others and cannot take postings. */
  isHeader?: boolean;
  currency: Currency;
  isBank?: boolean;
  /** Bank account number (highly confidential, masked). */
  bankAccountNumber?: string;
  bankName?: string;
  active: boolean;
  /** Balance in PKR from posted entries (natural sign: debit for assets/expenses, credit for the rest). */
  balance: Money;
  /** For USD accounts: balance in USD. */
  foreignBalance?: Money;
}

export type EntryStatus = "draft" | "pending_approval" | "posted" | "reversed";

export type EntrySource = "manual" | "invoice" | "bill" | "payroll" | "payroll_payment" | "advance" | "payment" | "reversal" | "revaluation" | "transfer" | "opening";

export interface JournalLine {
  id: string;
  accountId: string;
  description?: string;
  /** In the entry's currency. */
  debit: string;
  credit: string;
  /** PKR override when the base amount isn't amount × rate (e.g. USD collections at a new rate). */
  baseDebit?: string;
  baseCredit?: string;
  partyId?: string;
  empId?: string;
}

export interface EntryEvent {
  at: string;
  by: string;
  action: "created" | "edited" | "submitted" | "approved" | "rejected" | "posted" | "reversed" | "ceo_notified" | "blocked";
  note?: string;
}

export interface JournalEntry {
  id: string;
  number: string;
  date: string;
  description: string;
  source: EntrySource;
  projectId?: string;
  currency: Currency;
  /** PKR per 1 unit of the entry currency ("1" for PKR). */
  exchangeRate: string;
  lines: JournalLine[];
  /** Total debits in the entry currency. */
  total: Money;
  /** Total debits in PKR (drives the approval level). */
  baseTotal: Money;
  status: EntryStatus;
  /** Who approves: always the Director, any amount (maker-checker). */
  approverEmpId?: string;
  /** Above PKR 500,000, or a share-capital or loan entry: the CEO / Founder / Owner is notified (view only). */
  ceoNotified?: boolean;
  /** The Director made it, so nobody else may approve it and it can't be posted. */
  blocked?: boolean;
  createdBy: string;
  createdAt: string;
  postedAt?: string;
  chain: ApprovalStep[];
  reversalOf?: string;
  reversedBy?: string;
  attachments: Attachment[];
  history: EntryEvent[];
  /** Note left when an approver sent it back. */
  rejectionNote?: string;
  /**
   * Live mode (m9): the SERVER decides the approval tier from the amount (plan section 13, limits in Settings). These come
   * from the API and the screens show them instead of deciding anything themselves.
   */
  requiredLevel?: number | null;
  requiredApproverLabel?: string | null;
  /** The viewer may approve or reject it now (permission, tier, not the maker). */
  canApprove?: boolean;
  /** Approving it asks for the password again (large entry, plan section 16). */
  needsStepUp?: boolean;
  /** The maker's display name (live). */
  makerName?: string;
  /**
   * Live mode: an approver rejected it (with `rejectionNote`). A rejected entry never changes; the maker makes a new one.
   * Its `status` stays "draft" for the screens that only know the four statuses, but nothing on it can be edited or submitted.
   */
  rejected?: boolean;
}

export interface Party {
  id: string;
  kind: "client" | "vendor";
  name: string;
  email?: string;
  country?: string;
  currency: Currency;
  /** Receivable (client) or payable (vendor) in PKR. */
  balance: Money;
  contactName?: string;
  terms?: string;
}

/** Client invoice as seen by the ledger (AR documents). Billing (M13) owns the full invoice. */
export interface ReceivableDoc {
  id: string;
  number: string;
  clientId: string;
  date: string;
  dueDate: string;
  total: Money;
  paid: Money;
  baseTotal: Money;
  basePaid: Money;
  status: "unpaid" | "part_paid" | "paid";
  entryId?: string;
  projectId?: string;
}

export interface Bill {
  id: string;
  number: string;
  vendorId: string;
  date: string;
  dueDate: string;
  description: string;
  categoryAccountId: string;
  total: Money;
  paid: Money;
  status: "unpaid" | "part_paid" | "paid";
  receipt?: Attachment;
  entryId?: string;
}

export interface BankStatementLine {
  id: string;
  bankAccountId: string;
  date: string;
  description: string;
  /** Positive = money in, negative = money out (PKR). */
  amount: string;
  matchedLineKey?: string;
  suggestion?: string;
}

/** A cash line in the ledger that can be matched: `${entryId}:${lineId}`. */
export interface LedgerCashLine {
  key: string;
  entryId: string;
  entryNumber: string;
  date: string;
  description: string;
  amount: string;
  matched: boolean;
}

export type PeriodStatus = "open" | "closing" | "closed" | "reopened";

export interface ChecklistItem {
  key: "entries_posted" | "bank_reconciled" | "payroll_posted" | "usd_revalued" | "trial_balance";
  label: string;
  done: boolean;
  detail?: string;
}

export interface FinancePeriod {
  month: string;
  status: PeriodStatus;
  checklist: ChecklistItem[];
  closedBy?: string;
  closedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  reopenReason?: string;
  /** Live mode: the viewer may approve or send back this close (server decides: the CEO, never the person who ran it). */
  canApproveClose?: boolean;
}

export interface ExchangeRate {
  month: string;
  /** PKR per USD at month end. */
  rate: string;
}

export interface FinanceProject {
  id: string;
  name: string;
  client?: string;
}

export interface ApprovalLimit {
  /** The role that approves journal entries (only the Director). */
  role: RoleKey;
  label: string;
  upTo: number | null;
}

export interface EntryListParams {
  status?: EntryStatus | "all";
  month?: string;
  source?: EntrySource | "all";
}

export interface NewEntryInput {
  date: string;
  description: string;
  projectId?: string;
  currency: Currency;
  exchangeRate: string;
  lines: Omit<JournalLine, "id">[];
  source?: EntrySource;
  submit: boolean;
  attachments?: Attachment[];
  /** Editing an existing draft. */
  draftId?: string;
}

export interface RevaluationPreview {
  month: string;
  rate: string;
  rows: { accountId: string; foreign: string; bookBase: string; revaluedBase: string; difference: string }[];
  total: string;
}
