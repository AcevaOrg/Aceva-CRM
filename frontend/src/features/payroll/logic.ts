/**
 * Pure payroll rules (plan §12). Mirrored on the server; unit-test these.
 *   Net = base + allowances + bonus − unpaid leave − tax − other deductions
 *   Unpaid leave deduction = base ÷ working days in the month × unpaid days
 */
import { workingDaysBetween } from "@/lib/dates";
import { money, toNumber } from "@/lib/format";
import type { Money } from "@/types";
import type { JournalPreviewLine, PayrollLine, PayrollStage, PayrollTotals, TaxSlab } from "./types";

/** Salaried-person slabs (yearly PKR). Example values; the outside accountant confirms them and the Director enters them in Settings. */
export const DEFAULT_TAX_SLABS: TaxSlab[] = [
  { from: 0, to: 600_000, fixed: 0, rate: 0 },
  { from: 600_000, to: 1_200_000, fixed: 0, rate: 0.01 },
  { from: 1_200_000, to: 2_200_000, fixed: 6_000, rate: 0.11 },
  { from: 2_200_000, to: 3_200_000, fixed: 116_000, rate: 0.23 },
  { from: 3_200_000, to: 4_100_000, fixed: 346_000, rate: 0.3 },
  { from: 4_100_000, to: null, fixed: 616_000, rate: 0.35 },
];

const round2 = (n: number) => Math.round(n * 100) / 100;

export function yearlyTax(annualIncome: number, slabs: TaxSlab[] = DEFAULT_TAX_SLABS) {
  const slab = slabs.find((s) => annualIncome > s.from && (s.to === null || annualIncome <= s.to));
  if (!slab) return 0;
  return slab.fixed + (annualIncome - slab.from) * slab.rate;
}

/** Monthly tax: tax on the month's taxable pay × 12, divided by 12. */
export function monthlyTax(monthlyTaxable: number, slabs: TaxSlab[] = DEFAULT_TAX_SLABS) {
  return round2(yearlyTax(monthlyTaxable * 12, slabs) / 12);
}

export function unpaidLeaveDeduction(base: number, workingDays: number, unpaidDays: number) {
  if (!workingDays || !unpaidDays) return 0;
  return round2((base / workingDays) * unpaidDays);
}

export function workingDaysInMonth(monthKey: string, holidays: string[] = []) {
  const [y, m] = monthKey.split("-").map(Number);
  return workingDaysBetween(new Date(y, m - 1, 1), new Date(y, m, 0), holidays);
}

export interface LineInput {
  base: number;
  allowances: number;
  bonus: number;
  commission: number;
  unpaidDays: number;
  otherDeductions: number;
  adjustment: number;
  workingDays: number;
}

export interface LineResult {
  unpaidDeduction: number;
  gross: number;
  tax: number;
  net: number;
}

export function calculateLine(i: LineInput, slabs: TaxSlab[] = DEFAULT_TAX_SLABS): LineResult {
  const unpaidDeduction = unpaidLeaveDeduction(i.base, i.workingDays, i.unpaidDays);
  const gross = round2(i.base + i.allowances + i.bonus + i.commission + i.adjustment - unpaidDeduction);
  const tax = monthlyTax(gross, slabs);
  const net = round2(gross - tax - i.otherDeductions);
  return { unpaidDeduction, gross, tax, net };
}

export function totalsOf(lines: PayrollLine[]): PayrollTotals {
  const s = (f: (l: PayrollLine) => Money) => lines.reduce((a, l) => a + toNumber(f(l)), 0);
  return {
    gross: money(s((l) => l.gross)),
    tax: money(s((l) => l.tax)),
    deductions: money(s((l) => l.tax) + s((l) => l.otherDeductions)),
    net: money(s((l) => l.net)),
  };
}

/** Change vs last month in %, or undefined when there is no previous line. */
export function variancePct(line: Pick<PayrollLine, "net" | "lastMonthNet">) {
  if (!line.lastMonthNet) return undefined;
  const prev = toNumber(line.lastMonthNet);
  if (!prev) return undefined;
  return ((toNumber(line.net) - prev) / prev) * 100;
}

export const VARIANCE_FLAG = 10;

/**
 * The salary entry created when the run is approved (plan section 12): Dr salary expense / Cr income tax payable,
 * Cr employee advances, Cr other payroll deductions, Cr salary payable. Accounts are found by their system role; the codes
 * are those of the development chart (the accountant maps the real ones). In live mode the server creates the entry and it
 * then waits for the normal ledger approval; this is only the preview.
 */
export function journalPreview(lines: PayrollLine[]): JournalPreviewLine[] {
  const s = (f: (l: PayrollLine) => Money) => lines.reduce((a, l) => a + toNumber(f(l)), 0);
  const gross = s((l) => l.gross);
  const tax = s((l) => l.tax);
  const deductions = s((l) => l.otherDeductions);
  // Mock lines carry advance repayments in otherDeductions; live lines say how much of it is advances.
  const advances = lines.some((l) => l.advanceDeduction !== undefined) ? s((l) => l.advanceDeduction ?? money(0)) : deductions;
  const other = deductions - advances;
  const net = s((l) => l.net);
  const zero = money(0);
  return [
    { code: "5100", account: "Salary expense", debit: money(gross), credit: zero },
    { code: "2300", account: "Income tax payable", debit: zero, credit: money(tax) },
    { code: "1300", account: "Employee advances", debit: zero, credit: money(advances) },
    { code: "2400", account: "Other payroll deductions", debit: zero, credit: money(other) },
    { code: "2200", account: "Salary payable", debit: zero, credit: money(net) },
  ];
}

/**
 * Payroll chain (plan section 12): Prepared (Finance) -> Reviewed (Director) -> Approved (CEO, confirming the password again).
 * The person who prepared a run never reviews or approves it. These Emp-IDs only fill the chain in mock mode; who may act is
 * decided by permissions (payroll.prepare / payroll.review / payroll.approve), and in live mode the server fills the chain.
 * The demo roster has no CEO, so the mock approver is left empty.
 */
export const PAYROLL_PREPARER = "ACV-0010";
export const PAYROLL_REVIEWER = "ACV-0003";
export const PAYROLL_APPROVER: string | undefined = undefined;
export const PREPARED_LABEL = "Prepared (Finance)";
export const REVIEWED_LABEL = "Reviewed (Director)";
export const APPROVED_LABEL = "Approved (CEO)";

/**
 * Stages shown on the stepper. The server has draft, calculated, prepared, reviewed and approved; after approval the screen
 * shows "payslips sent" (payslips are issued on approval), "posted" (the salary entry was posted in the ledger) and "paid"
 * (the bank transfer was recorded).
 */
export const STAGES: { key: PayrollStage; label: string; short: string }[] = [
  { key: "draft", label: "Attendance open", short: "Draft" },
  { key: "calculated", label: "Calculated", short: "Calculated" },
  { key: "prepared", label: "Prepared", short: "Prepared" },
  { key: "reviewed", label: "Reviewed", short: "Reviewed" },
  { key: "approved", label: "Approved", short: "Approved" },
  { key: "payslips_sent", label: "Payslips sent", short: "Payslips" },
  { key: "posted", label: "Posted to ledger", short: "Posted" },
  { key: "paid", label: "Paid", short: "Paid" },
];

export const stageIndex = (s: PayrollStage) => STAGES.findIndex((x) => x.key === s);
export const stageLabel = (s: PayrollStage) => STAGES.find((x) => x.key === s)?.label ?? s;

/** Approved runs can't be edited; fixes go to next month as an adjustment (plan §12). */
export const isLocked = (s: PayrollStage) => stageIndex(s) >= stageIndex("approved");

export function nextMonthKey(key: string) {
  const [y, m] = key.split("-").map(Number);
  const d = new Date(y, m, 15);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}
