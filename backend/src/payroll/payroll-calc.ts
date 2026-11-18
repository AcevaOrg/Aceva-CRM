import { dec, Decimal, minDec, round2, sum, ZERO, type DecimalInput } from '../common/money';

/**
 * The payroll calculation (plan section 12), as pure functions over exact decimals. No database, no clock.
 *
 *   gross                  = base + allowances + bonus - unpaid leave deduction
 *   unpaid leave deduction = base / working days in the month x unpaid days          (rounded to paisa)
 *   taxable income         = gross                                                    (development default D9)
 *   monthly tax            = yearly tax(taxable x 12) / 12                            (rounded to paisa)
 *   yearly tax             = fixed + (income - from) x rate, for the slab with from < income <= to
 *   advance deduction      = for each active advance: min(monthly deduction, remaining)
 *   other deductions       = the deduction items (manual and adjustment)
 *   net                    = gross - tax - advance deduction - other deductions      (never negative: refused)
 *
 * Every amount is rounded half up to 2 decimals at the step that produces it; sums of 2-decimal amounts are exact.
 */

export interface TaxSlabRow {
  from: DecimalInput;
  /** null = no upper limit */
  to: DecimalInput | null;
  fixed: DecimalInput;
  rate: DecimalInput;
}

export interface AdvanceInput {
  id: string;
  monthlyDeduction: DecimalInput;
  /** Still to be repaid (amount minus repayments taken by approved runs). */
  remaining: DecimalInput;
}

export interface LineInput {
  base: DecimalInput;
  allowances: DecimalInput;
  /** Bonus amounts (manual bonus items and adjustment items of kind bonus). */
  bonuses: DecimalInput[];
  /** Deduction amounts (manual deduction items and adjustment items of kind deduction). */
  deductions: DecimalInput[];
  workingDays: number;
  unpaidDays: DecimalInput;
  /** Active advances, in the order they are repaid (oldest first). */
  advances: AdvanceInput[];
}

export interface AdvanceTake {
  advanceId: string;
  amount: Decimal;
}

export interface LineResult {
  base: Decimal;
  allowances: Decimal;
  bonus: Decimal;
  unpaidDays: Decimal;
  unpaidDeduction: Decimal;
  gross: Decimal;
  taxableIncome: Decimal;
  tax: Decimal;
  advanceDeduction: Decimal;
  advanceTakes: AdvanceTake[];
  otherDeductions: Decimal;
  /** May be negative here; the caller refuses to save a negative net (409 negative_net). */
  net: Decimal;
  /** Set when there are no working days in the month, so no unpaid leave deduction could be worked out. */
  noWorkingDays: boolean;
}

/** Tax for a whole year of taxable income: fixed + (income - from) x rate, using the slab with from < income <= to. */
export function yearlyTax(annualIncome: DecimalInput, slabs: TaxSlabRow[]): Decimal {
  const income = dec(annualIncome);
  if (income.lte(0)) return ZERO;
  const slab = slabs.find((s) => income.gt(dec(s.from)) && (s.to === null || income.lte(dec(s.to))));
  if (!slab) throw new Error('No tax slab covers this income');
  return dec(slab.fixed).plus(income.minus(dec(slab.from)).times(dec(slab.rate)));
}

/** Monthly tax: the yearly tax on (monthly taxable income x 12), divided by 12, rounded to paisa. */
export function monthlyTax(monthlyTaxable: DecimalInput, slabs: TaxSlabRow[]): Decimal {
  return round2(yearlyTax(dec(monthlyTaxable).times(12), slabs).div(12));
}

/**
 * Unpaid leave deduction: base / working days x unpaid days, rounded to paisa. Worked out as base x unpaid days / working
 * days (the same value, without an intermediate rounding). No working days, or no unpaid days: nothing is deducted.
 */
export function unpaidLeaveDeduction(base: DecimalInput, workingDays: number, unpaidDays: DecimalInput): Decimal {
  const days = dec(unpaidDays);
  if (!workingDays || workingDays <= 0 || days.lte(0)) return ZERO;
  return round2(dec(base).times(days).div(workingDays));
}

/** What each active advance repays this month: min(monthly deduction, remaining), oldest first. */
export function advanceTakes(advances: AdvanceInput[]): AdvanceTake[] {
  return advances
    .map((a) => ({ advanceId: a.id, amount: round2(minDec(a.monthlyDeduction, a.remaining)) }))
    .filter((t) => t.amount.gt(0));
}

export function calculateLine(input: LineInput, slabs: TaxSlabRow[]): LineResult {
  const base = round2(input.base);
  const allowances = round2(input.allowances);
  const bonus = round2(sum(input.bonuses));
  const unpaidDays = dec(input.unpaidDays);
  const noWorkingDays = !input.workingDays || input.workingDays <= 0;
  const unpaidDeduction = unpaidLeaveDeduction(base, input.workingDays, unpaidDays);
  const gross = base.plus(allowances).plus(bonus).minus(unpaidDeduction);
  const taxableIncome = gross.gt(0) ? gross : ZERO;
  const tax = monthlyTax(taxableIncome, slabs);
  const takes = advanceTakes(input.advances);
  const advanceDeduction = sum(takes.map((t) => t.amount));
  const otherDeductions = round2(sum(input.deductions));
  const net = gross.minus(tax).minus(advanceDeduction).minus(otherDeductions);
  return { base, allowances, bonus, unpaidDays, unpaidDeduction, gross, taxableIncome, tax, advanceDeduction, advanceTakes: takes, otherDeductions, net, noWorkingDays };
}

export interface RunTotals {
  gross: Decimal;
  tax: Decimal;
  advanceDeductions: Decimal;
  otherDeductions: Decimal;
  net: Decimal;
}

export interface StoredLineAmounts {
  baseSalary: DecimalInput;
  allowances: DecimalInput;
  bonus: DecimalInput;
  unpaidDeduction: DecimalInput;
  tax: DecimalInput;
  advanceDeduction: DecimalInput;
  otherDeductions: DecimalInput;
  net: DecimalInput;
}

/** Gross of a saved line: base + allowances + bonus - unpaid leave deduction. */
export function grossOf(l: StoredLineAmounts): Decimal {
  return dec(l.baseSalary).plus(dec(l.allowances)).plus(dec(l.bonus)).minus(dec(l.unpaidDeduction));
}

export function runTotals(lines: StoredLineAmounts[]): RunTotals {
  return {
    gross: sum(lines.map(grossOf)),
    tax: sum(lines.map((l) => l.tax)),
    advanceDeductions: sum(lines.map((l) => l.advanceDeduction)),
    otherDeductions: sum(lines.map((l) => l.otherDeductions)),
    net: sum(lines.map((l) => l.net)),
  };
}

export interface SalaryEntryLine {
  side: 'debit' | 'credit';
  role: 'salary_expense' | 'tax_payable' | 'employee_advances' | 'payroll_deductions' | 'salary_payable';
  amount: Decimal;
}

/**
 * The salary journal entry of an approved run: Dr salary expense (total gross) / Cr tax payable (total tax), Cr employee
 * advances (advance repayments), Cr payroll deductions (other deductions), Cr salary payable (total net). Zero lines are left
 * out (a journal line always has one positive side). Balanced by construction: gross = tax + advances + other + net.
 */
export function salaryEntryLines(t: RunTotals): SalaryEntryLine[] {
  const lines: SalaryEntryLine[] = [
    { side: 'debit', role: 'salary_expense', amount: t.gross },
    { side: 'credit', role: 'tax_payable', amount: t.tax },
    { side: 'credit', role: 'employee_advances', amount: t.advanceDeductions },
    { side: 'credit', role: 'payroll_deductions', amount: t.otherDeductions },
    { side: 'credit', role: 'salary_payable', amount: t.net },
  ];
  return lines.filter((l) => l.amount.gt(0));
}

/**
 * Splits a line's advance deduction over the person's advances at approval (oldest first, never more than what remains).
 * Returns null when the advances no longer cover the amount (another run repaid them in the meantime): calculate again.
 */
export function allocateAdvanceDeduction(total: DecimalInput, advances: AdvanceInput[]): AdvanceTake[] | null {
  let left = dec(total);
  const takes: AdvanceTake[] = [];
  for (const t of advanceTakes(advances)) {
    if (left.lte(0)) break;
    const amount = minDec(t.amount, left);
    takes.push({ advanceId: t.advanceId, amount });
    left = left.minus(amount);
  }
  return left.gt(0) ? null : takes;
}

/** Validates a slab list (the request schema checks the same; this guards data entered any other way). */
export function slabsProblem(slabs: TaxSlabRow[]): string | null {
  if (!slabs.length) return 'No slabs';
  if (!dec(slabs[0].from).eq(0)) return 'The first slab starts at 0';
  for (let i = 0; i < slabs.length; i++) {
    const s = slabs[i];
    const rate = dec(s.rate);
    if (rate.lt(0) || rate.gt(1)) return 'A rate is between 0 and 1';
    if (dec(s.fixed).lt(0)) return 'The fixed tax cannot be negative';
    const last = i === slabs.length - 1;
    if (s.to === null && !last) return 'Only the last slab has no upper limit';
    if (s.to !== null && last) return 'The last slab has no upper limit';
    if (s.to !== null && dec(s.to).lte(dec(s.from))) return 'A slab ends above where it starts';
    if (i > 0 && !dec(s.from).eq(dec(slabs[i - 1].to as DecimalInput))) return 'Each slab starts where the previous one ends';
  }
  return null;
}
