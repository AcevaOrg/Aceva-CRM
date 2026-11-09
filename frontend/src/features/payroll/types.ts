/**
 * Module 8 · Payroll (plan §12)
 * Owner: Developer B (cycle 3), finance review by Developer A. Spec §9.8.
 * Chain (maker-checker): Prepared (Finance, ACV-0010) → Approved (Director, with step-up). No CEO step:
 * the CEO / Founder / Owner opens and views every run but approves nothing.
 * API contract for the module. All money is a decimal string (spec §7.2).
 */
import type { ApprovalStep, Money } from "@/types";

/** No separate review stage: Finance prepares and the Director approves. */
export type PayrollStage = "draft" | "calculated" | "prepared" | "approved" | "payslips_sent" | "posted" | "paid";

export interface PayrollTotals {
  gross: Money;
  deductions: Money;
  tax: Money;
  net: Money;
}

export interface PayrollRun {
  id: string;
  /** PR-2026-11 */
  number: string;
  /** "2026-11" */
  month: string;
  stage: PayrollStage;
  workingDays: number;
  totals: PayrollTotals;
  headcount: number;
  attendanceLockedAt?: string;
  preparedBy?: string;
  preparedAt?: string;
  approvedBy?: string;
  approvedAt?: string;
  payslipsSentAt?: string;
  /** Journal entry number created when posted (Module 9). */
  journalEntryNumber?: string;
  postedAt?: string;
  paymentEntryNumber?: string;
  paidAt?: string;
  /** Last rejection note, shown on the run until it is prepared again. */
  returnedNote?: string;
  chain: ApprovalStep[];
  createdAt: string;
}

export interface PayrollLine {
  id: string;
  runId: string;
  empId: string;
  base: Money;
  allowances: Money;
  bonus: Money;
  bonusNote?: string;
  /** Sales commission approved by the Director (Module 15). */
  commission: Money;
  unpaidDays: number;
  unpaidDeduction: Money;
  tax: Money;
  /** Advance repayments and other deductions. */
  otherDeductions: Money;
  otherNote?: string;
  /** Adjustment carried in from an earlier month (+ or −). */
  adjustment: Money;
  adjustmentNote?: string;
  gross: Money;
  net: Money;
  lastMonthNet?: Money;
  bankName: string;
  accountNumber: string;
}

export interface PayslipLine {
  label: string;
  kind: "earning" | "deduction";
  amount: Money;
}

export interface Payslip {
  id: string;
  runId: string;
  empId: string;
  month: string;
  lines: PayslipLine[];
  gross: Money;
  totalDeductions: Money;
  net: Money;
  ytdNet: Money;
  ytdTax: Money;
  workingDays: number;
  unpaidDays: number;
  bankName: string;
  accountNumber: string;
  issuedAt: string;
}

export interface SalaryAdvance {
  id: string;
  empId: string;
  amount: Money;
  monthlyDeduction: Money;
  startMonth: string;
  remaining: Money;
  reason: string;
  status: "active" | "repaid";
  createdBy: string;
  createdAt: string;
}

export interface PayrollAdjustment {
  id: string;
  fromRunId: string;
  toMonth: string;
  empId: string;
  amount: Money;
  note: string;
  createdBy: string;
  createdAt: string;
}

/** Yearly income tax slab (Settings; the Director updates it when the law changes, with the accountant). */
export interface TaxSlab {
  from: number;
  /** null = no upper limit */
  to: number | null;
  fixed: number;
  rate: number;
}

export interface JournalPreviewLine {
  account: string;
  code: string;
  debit: Money;
  credit: Money;
}

export interface RunDetail {
  run: PayrollRun;
  lines: PayrollLine[];
}

export interface NewAdvanceInput {
  empId: string;
  amount: number;
  monthlyDeduction: number;
  startMonth: string;
  reason: string;
}
