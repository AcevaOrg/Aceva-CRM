import type { Prisma } from '../generated/prisma/client';
import type { Decimal } from '../common/money';

/**
 * M9 -> M8 integration contract (agreed before implementation; owner: Track C, consumer: Track B).
 * Module 8 creates its ledger entries ONLY through this port. Module 9 never imports anything from Module 8.
 *
 * Rules the implementation guarantees:
 *  - the entry is created as a Draft with its lines and then submitted, so it waits in "Pending approval" like every other
 *    entry (plan section 13: "the system creates it from an invoice, bill or payroll. It starts as a Draft"). It is never
 *    posted directly; a different person approves it at the level its amount needs;
 *  - debits must equal credits, or nothing is saved (`unbalanced_entry`);
 *  - (source, sourceRef, purpose) is unique: calling twice for the same payroll run never creates a second entry
 *    (the existing entry is returned);
 *  - a date in a closed month is refused (`period_closed`);
 *  - it runs inside the caller's transaction, so the payroll change and its ledger entry are saved together or not at all.
 */

/** Accounts that automatic postings use, found by role (never by code). The accountant maps them in the chart of accounts. */
export const SYSTEM_ACCOUNT_ROLES = {
  salaryExpense: 'salary_expense',
  salaryPayable: 'salary_payable',
  taxPayable: 'tax_payable',
  employeeAdvances: 'employee_advances',
  /** Other deductions taken through payroll (deduction lines). Which account they belong to is for the accountant to confirm. */
  payrollDeductions: 'payroll_deductions',
  accountsReceivable: 'accounts_receivable',
  accountsPayable: 'accounts_payable',
  fxGainLoss: 'fx_gain_loss',
} as const;
export type SystemAccountRole = (typeof SYSTEM_ACCOUNT_ROLES)[keyof typeof SYSTEM_ACCOUNT_ROLES];

export interface SystemEntryLine {
  /** Either an account role ... */
  accountRole?: SystemAccountRole;
  /** ... or a specific account (for example the bank account chosen for a payment). */
  accountId?: string;
  debit?: Decimal;
  credit?: Decimal;
  description?: string;
  /** Employee tag (UUID), for example on salary payable lines. */
  employeeId?: string;
}

export interface SystemEntryInput {
  source: 'payroll' | 'payroll_payment' | 'advance';
  /** The id of the thing that caused it (payroll run id, advance id). */
  sourceRef: string;
  /** Distinguishes several entries from one source, e.g. 'salary' and 'payment'. */
  purpose: string;
  /** Pakistan day of the entry. */
  entryDate: string;
  description: string;
  /** The maker (employee UUID): the person whose action created it. They can never approve it. */
  makerId: string;
  lines: SystemEntryLine[];
}

export interface SystemEntryResult {
  id: string;
  number: string;
  status: 'draft' | 'pending_approval' | 'posted' | 'rejected';
}

export abstract class LedgerPostingPort {
  abstract createSystemEntry(tx: Prisma.TransactionClient, input: SystemEntryInput): Promise<SystemEntryResult>;

  /** Number and status of entries by id (for the payroll screens: "salary entry JE-2026-0012, posted"). */
  abstract entryStatuses(ids: string[]): Promise<Map<string, { number: string; status: SystemEntryResult['status'] }>>;

  /** An active bank account by id, or null (validates the account chosen for a salary or advance payment). */
  abstract findBankAccount(accountId: string): Promise<{ id: string; code: string; name: string } | null>;
}
