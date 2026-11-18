import { z } from 'zod';
import { empIdSchema } from './events';
import { daySchema, decisionReasonSchema, moneySchema, monthSchema, positiveMoneySchema } from './shared';

/**
 * Module 8 payroll: request schemas (validated by the server with createZodDto) and response types, shared with the website.
 * Owner: Track B. Other tracks read this file; they never edit it. A breaking change is coordinated through the schema owner.
 *
 * Money is always a decimal string ("1250.00"), never a float. People are Emp-IDs, never internal UUIDs.
 */

export const payrollMonthQuerySchema = z.object({ month: monthSchema });
export const payrollDayQuerySchema = z.object({ date: daySchema.optional() });

// ---------------------------------------------------------------------------------------------------------------- requests

export const payrollItemKindSchema = z.enum(['bonus', 'deduction']);
export type PayrollItemKind = z.infer<typeof payrollItemKindSchema>;

export const payrollStageSchema = z.enum(['draft', 'calculated', 'prepared', 'reviewed', 'approved']);
export type PayrollStageValue = z.infer<typeof payrollStageSchema>;

/** POST /payroll/runs */
export const createPayrollRunSchema = z.object({ month: monthSchema });
export type CreatePayrollRunRequest = z.infer<typeof createPayrollRunSchema>;

/** POST /payroll/runs/:id/items: a bonus or deduction line for one employee, before the run is prepared. */
export const addPayrollItemSchema = z.object({
  empId: empIdSchema,
  kind: payrollItemKindSchema,
  label: z.string().trim().min(2, 'Give the line a label').max(120),
  amount: positiveMoneySchema,
});
export type AddPayrollItemRequest = z.infer<typeof addPayrollItemSchema>;

/** POST /payroll/runs/:id/return: sent back to Finance with a reason. */
export const returnPayrollRunSchema = z.object({ reason: decisionReasonSchema });
export type ReturnPayrollRunRequest = z.infer<typeof returnPayrollRunSchema>;

/** POST /payroll/runs/:id/mark-paid: the bank transfer was made from this bank account on this day. */
export const markPayrollPaidSchema = z.object({ bankAccountId: z.uuid(), paidOn: daySchema });
export type MarkPayrollPaidRequest = z.infer<typeof markPayrollPaidSchema>;

/** POST /payroll/adjustments: a fix for an approved run, applied in a later month's run. */
export const createPayrollAdjustmentSchema = z.object({
  empId: empIdSchema,
  /** The approved run that had the mistake. */
  originRunId: z.uuid(),
  /** The month whose run carries the fix (later than the origin run's month). */
  targetMonth: monthSchema,
  kind: payrollItemKindSchema,
  amount: positiveMoneySchema,
  reason: decisionReasonSchema,
});
export type CreatePayrollAdjustmentRequest = z.infer<typeof createPayrollAdjustmentSchema>;

/** POST /payroll/advances */
export const createSalaryAdvanceSchema = z
  .object({
    empId: empIdSchema,
    amount: positiveMoneySchema,
    monthlyDeduction: positiveMoneySchema,
    /** First month whose payroll deducts a repayment. */
    startMonth: monthSchema,
    reason: decisionReasonSchema,
    /** The bank account the advance is paid from (Module 9 chart of accounts). */
    bankAccountId: z.uuid(),
  })
  .refine((v) => Number(v.monthlyDeduction) <= Number(v.amount), { message: 'The monthly deduction cannot be more than the advance', path: ['monthlyDeduction'] });
export type CreateSalaryAdvanceRequest = z.infer<typeof createSalaryAdvanceSchema>;

/** A tax rate as a decimal string between 0 and 1 with up to 4 decimals ("0.1100" = 11%). */
export const taxRateSchema = z
  .string()
  .trim()
  .regex(/^(0(\.\d{1,4})?|1(\.0{1,4})?)$/, 'A rate is between 0 and 1, for example 0.11 for 11%');

export const taxSlabInputSchema = z.object({
  /** Yearly taxable income above this amount ... */
  from: moneySchema,
  /** ... up to and including this amount; null = no upper limit (only the last slab). */
  to: moneySchema.nullable(),
  /** Tax on the part below `from`. */
  fixed: moneySchema,
  /** Rate on the part above `from`. */
  rate: taxRateSchema,
});
export type TaxSlabInput = z.infer<typeof taxSlabInputSchema>;

const cents = (v: string) => Math.round(Number(v) * 100);

/**
 * POST /settings/tax-slabs: a NEW version of the yearly slabs (old versions are kept; runs store the version they used).
 * The slabs must start at 0, follow each other without gaps or overlaps (each `from` = the previous `to`), increase, and the
 * last one must have no upper limit, so every income falls in exactly one slab.
 */
export const createTaxSlabSetSchema = z
  .object({
    effectiveFrom: daySchema,
    label: z.string().trim().min(3).max(120),
    slabs: z.array(taxSlabInputSchema).min(1).max(20),
  })
  .superRefine((v, ctx) => {
    const s = v.slabs;
    if (!s?.length) return; // reported by min(1)
    if (cents(s[0].from) !== 0) ctx.addIssue({ code: 'custom', path: ['slabs', 0, 'from'], message: 'The first slab starts at 0' });
    s.forEach((slab, i) => {
      const last = i === s.length - 1;
      if (slab.to === null && !last) ctx.addIssue({ code: 'custom', path: ['slabs', i, 'to'], message: 'Only the last slab has no upper limit' });
      if (slab.to !== null && last) ctx.addIssue({ code: 'custom', path: ['slabs', i, 'to'], message: 'The last slab has no upper limit' });
      if (slab.to !== null && cents(slab.to) <= cents(slab.from)) ctx.addIssue({ code: 'custom', path: ['slabs', i, 'to'], message: 'A slab ends above where it starts' });
      if (i > 0 && s[i - 1].to !== null && cents(slab.from) !== cents(s[i - 1].to as string)) {
        ctx.addIssue({ code: 'custom', path: ['slabs', i, 'from'], message: 'Each slab starts where the previous one ends' });
      }
      if (i > 0 && cents(slab.fixed) < cents(s[i - 1].fixed)) ctx.addIssue({ code: 'custom', path: ['slabs', i, 'fixed'], message: 'The fixed tax cannot go down from one slab to the next' });
    });
  });
export type CreateTaxSlabSetRequest = z.infer<typeof createTaxSlabSetSchema>;

// --------------------------------------------------------------------------------------------------------------- responses

export type LedgerEntryState = 'draft' | 'pending_approval' | 'posted' | 'rejected';

/** A Module 9 journal entry created by payroll: its number and where it is in the ledger approval. */
export interface PayrollLedgerEntryRef {
  number: string;
  status: LedgerEntryState;
}

export type PayrollLineFlag =
  | 'joined_mid_month'
  | 'left_mid_month'
  | 'final_settlement'
  | 'no_working_days'
  | 'missed_checkouts';

export interface PayrollPersonRef {
  empId: string;
  name: string;
}

export interface PayrollRunView {
  id: string;
  /** PR-2026-11 */
  number: string;
  month: string;
  stage: PayrollStageValue;
  /** True once the payment entry (bank transfer) was recorded. */
  paid: boolean;
  workingDays: number | null;
  headcount: number;
  totals: { gross: string; tax: string; advanceDeductions: string; otherDeductions: string; deductions: string; net: string };
  taxSlabSet: { id: string; label: string; effectiveFrom: string } | null;
  calculatedAt: string | null;
  preparedBy: PayrollPersonRef | null;
  preparedAt: string | null;
  reviewedBy: PayrollPersonRef | null;
  reviewedAt: string | null;
  approvedBy: PayrollPersonRef | null;
  approvedAt: string | null;
  returnedNote: string | null;
  /** The salary entry in Module 9 (created on approval; it then waits for the normal ledger approval). */
  salaryEntry: PayrollLedgerEntryRef | null;
  /** The payment entry that clears salary payable. */
  paymentEntry: PayrollLedgerEntryRef | null;
  paymentRecordedAt: string | null;
  createdAt: string;
  /** People employed during the month who are NOT in the run because no pay is on file. */
  missingPay: PayrollPersonRef[];
  /** Adjustments aimed at this month that are not in the lines yet (calculate again to apply them). */
  pendingAdjustments: number;
  /** Who acts next, decided by the server. */
  next: { action: 'calculate' | 'prepare' | 'review' | 'approve' | 'mark_paid' | null; label: string };
}

export interface PayrollItemView {
  id: string;
  empId: string;
  kind: PayrollItemKind;
  source: 'manual' | 'commission' | 'adjustment';
  label: string;
  amount: string;
  createdAt: string;
}

export interface PayrollLineView {
  id: string;
  empId: string;
  name: string;
  base: string;
  allowances: string;
  bonus: string;
  unpaidDays: string;
  unpaidDeduction: string;
  gross: string;
  taxableIncome: string;
  tax: string;
  advanceDeduction: string;
  otherDeductions: string;
  net: string;
  workingDays: number;
  presentDays: number;
  lateDays: number;
  absentDays: number;
  flags: PayrollLineFlag[];
  items: PayrollItemView[];
  /** Net of this person's line in the previous month's run, when there is one. */
  lastMonthNet: string | null;
}

export interface PayrollRunLinesResponse {
  run: PayrollRunView;
  lines: PayrollLineView[];
}

export interface PayslipLineView {
  label: string;
  kind: 'earning' | 'deduction';
  amount: string;
}

export interface PayslipSummary {
  id: string;
  empId: string;
  month: string;
  runNumber: string;
  net: string;
  issuedAt: string;
}

export interface PayslipView extends PayslipSummary {
  name: string;
  designation: string;
  lines: PayslipLineView[];
  earnings: string;
  deductions: string;
  gross: string;
  tax: string;
  /** Net pay of the calendar year up to and including this month. */
  ytdNet: string;
  ytdTax: string;
  workingDays: number;
  unpaidDays: string;
  bankName: string | null;
  /** Last 4 digits only. */
  accountMasked: string | null;
}

export interface SalaryAdvanceView {
  id: string;
  empId: string;
  name: string;
  amount: string;
  monthlyDeduction: string;
  startMonth: string;
  repaid: string;
  remaining: string;
  status: 'pending_payout' | 'active' | 'repaid' | 'cancelled';
  reason: string;
  payoutEntry: PayrollLedgerEntryRef | null;
  createdBy: string | null;
  createdAt: string;
}

export interface PayrollAdjustmentView {
  id: string;
  empId: string;
  name: string;
  originRunNumber: string | null;
  targetMonth: string;
  kind: PayrollItemKind;
  amount: string;
  reason: string;
  /** True once a run has taken it in as an item. */
  applied: boolean;
  createdBy: string | null;
  createdAt: string;
}

export interface TaxSlabView {
  from: string;
  to: string | null;
  fixed: string;
  rate: string;
}

export interface TaxSlabSetView {
  id: string;
  label: string;
  effectiveFrom: string;
  createdAt: string;
  createdBy: string | null;
  slabs: TaxSlabView[];
}

export interface TaxSlabsResponse {
  /** The version in force today, or null when none has been entered (payroll then refuses to calculate). */
  current: TaxSlabSetView | null;
  versions: TaxSlabSetView[];
}
