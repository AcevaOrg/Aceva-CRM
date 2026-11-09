/**
 * Seed: payroll runs, lines, payslips, advances, adjustments (Module 8).
 * July–October are paid; November is reviewed and waiting for the CEO's approval.
 */
import type { PayrollAdjustment, PayrollLine, PayrollRun, PayrollStage, Payslip, SalaryAdvance } from "@/features/payroll/types";
import { calculateLine, totalsOf, workingDaysInMonth } from "@/features/payroll/logic";
import { money, toNumber } from "@/lib/format";
import type { ApprovalStep } from "@/types";
import { HOLIDAY_DATES } from "./calendar";
import { EMPLOYEES, PAY } from "./people";
import { dayOfMonth, minutesAgo, monthFromNow } from "../time";

const OFFSETS = [-4, -3, -2, -1, 0];

const UNPAID: Record<number, Record<string, number>> = { [-3]: { "ACV-0012": 1 }, [-1]: { "ACV-0013": 2 }, [0]: { "ACV-0008": 1 } };
const BONUS: Record<number, Record<string, [number, string]>> = {
  [-3]: { "ACV-0007": [15_000, "Project completion bonus"] },
  [-1]: { "ACV-0006": [20_000, "Performance bonus"] },
};
const COMMISSION: Record<number, Record<string, number>> = { [-2]: { "ACV-0009": 12_000 }, [-1]: { "ACV-0012": 9_000 }, [0]: { "ACV-0009": 18_500 } };
const ADVANCE_DEDUCTION: Record<string, { from: number; amount: number; months: number }> = {
  "ACV-0011": { from: -2, amount: 10_000, months: 6 },
  "ACV-0012": { from: -1, amount: 15_000, months: 2 },
};
const ADJUSTMENT: Record<number, Record<string, [number, string]>> = { [0]: { "ACV-0010": [5_000, "Overtime for last month's close (adjustment)"] } };

function endOfMonthIso(offset: number) {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + offset + 1);
  d.setDate(0);
  return d;
}

function chainFor(offset: number, stage: PayrollStage): ApprovalStep[] {
  if (offset < 0)
    return [
      { label: "Prepared by", empId: "ACV-0010", state: "done", at: dayOfMonth(offset, 25, "16:20") },
      { label: "Reviewed by", empId: "ACV-0003", state: "done", at: dayOfMonth(offset, 26, "11:05") },
      { label: "Approved by", empId: "ACV-0002", state: "done", at: dayOfMonth(offset, 26, "15:40") },
    ];
  return [
    { label: "Prepared by", empId: "ACV-0010", state: "done", at: minutesAgo(60 * 26) },
    { label: "Reviewed by", empId: "ACV-0003", state: stage === "prepared" ? "waiting" : "done", at: stage === "prepared" ? undefined : minutesAgo(60 * 3) },
    { label: "Approved by", empId: "ACV-0002", state: stage === "reviewed" ? "waiting" : "pending" },
  ];
}

interface Built {
  runs: PayrollRun[];
  lines: PayrollLine[];
}

let cache: Built | null = null;

function build(): Built {
  if (cache) return structuredClone(cache);
  const runs: PayrollRun[] = [];
  const lines: PayrollLine[] = [];
  const prevNet = new Map<string, string>();

  for (const offset of OFFSETS) {
    const month = monthFromNow(offset);
    const runId = `pr_${month}`;
    const workingDays = workingDaysInMonth(month, HOLIDAY_DATES);
    const end = endOfMonthIso(offset);
    const stage: PayrollStage = offset < 0 ? "paid" : "reviewed";
    const runLines: PayrollLine[] = [];

    for (const e of EMPLOYEES) {
      const pay = PAY[e.empId];
      if (!pay || new Date(e.joiningDate) > end) continue;
      const allowances = pay.allowances.reduce((a, x) => a + x.amount, 0);
      const [bonus, bonusNote] = BONUS[offset]?.[e.empId] ?? [0, undefined];
      const commission = COMMISSION[offset]?.[e.empId] ?? 0;
      const unpaidDays = UNPAID[offset]?.[e.empId] ?? 0;
      const adv = ADVANCE_DEDUCTION[e.empId];
      const other = adv && offset >= adv.from && offset < adv.from + adv.months ? adv.amount : 0;
      const [adjustment, adjustmentNote] = ADJUSTMENT[offset]?.[e.empId] ?? [0, undefined];
      const r = calculateLine({ base: pay.base, allowances, bonus, commission, unpaidDays, otherDeductions: other, adjustment, workingDays });
      const line: PayrollLine = {
        id: `pl_${month}_${e.empId}`,
        runId,
        empId: e.empId,
        base: money(pay.base),
        allowances: money(allowances),
        bonus: money(bonus),
        bonusNote,
        commission: money(commission),
        unpaidDays,
        unpaidDeduction: money(r.unpaidDeduction),
        tax: money(r.tax),
        otherDeductions: money(other),
        otherNote: other ? "Salary advance repayment" : undefined,
        adjustment: money(adjustment),
        adjustmentNote,
        gross: money(r.gross),
        net: money(r.net),
        lastMonthNet: prevNet.has(e.empId) ? money(Number(prevNet.get(e.empId))) : undefined,
        bankName: pay.bank,
        accountNumber: pay.account,
      };
      runLines.push(line);
    }
    runLines.forEach((l) => prevNet.set(l.empId, l.net.amount));
    lines.push(...runLines);

    const n = 280 + (offset + 4) * 9;
    runs.push({
      id: runId,
      number: `PR-${month}`,
      month,
      stage,
      workingDays,
      totals: totalsOf(runLines),
      headcount: runLines.length,
      attendanceLockedAt: offset < 0 ? dayOfMonth(offset, 25, "10:00") : minutesAgo(60 * 28),
      preparedBy: "ACV-0010",
      preparedAt: offset < 0 ? dayOfMonth(offset, 25, "16:20") : minutesAgo(60 * 26),
      reviewedBy: "ACV-0003",
      reviewedAt: offset < 0 ? dayOfMonth(offset, 26, "11:05") : minutesAgo(60 * 3),
      approvedBy: offset < 0 ? "ACV-0002" : undefined,
      approvedAt: offset < 0 ? dayOfMonth(offset, 26, "15:40") : undefined,
      payslipsSentAt: offset < 0 ? dayOfMonth(offset, 27, "10:00") : undefined,
      journalEntryNumber: offset < 0 ? `JE-${month.slice(0, 4)}-0${n}` : undefined,
      postedAt: offset < 0 ? dayOfMonth(offset, 27, "10:30") : undefined,
      paymentEntryNumber: offset < 0 ? `JE-${month.slice(0, 4)}-0${n + 1}` : undefined,
      paidAt: offset < 0 ? dayOfMonth(offset, 28, "12:00") : undefined,
      chain: chainFor(offset, stage),
      createdAt: offset < 0 ? dayOfMonth(offset, 24, "09:30") : minutesAgo(60 * 30),
    });
  }
  cache = { runs, lines };
  return structuredClone(cache);
}

export const seedPayrollRuns = () => build().runs;
export const seedPayrollLines = () => build().lines;

/** Payslips for paid runs, with year-to-date totals from 1 July (finance year). */
export function payslipFromLine(line: PayrollLine, run: PayrollRun, ytdNet: number, ytdTax: number): Payslip {
  const earning = (label: string, m: { amount: string }) => ({ label, kind: "earning" as const, amount: money(Number(m.amount)) });
  const deduction = (label: string, m: { amount: string }) => ({ label, kind: "deduction" as const, amount: money(Number(m.amount)) });
  const pay = PAY[line.empId];
  const lines = [
    earning("Basic salary", line.base),
    ...(pay?.allowances ?? []).map((a) => earning(`${a.name} allowance`, money(a.amount))),
    ...(toNumber(line.bonus) ? [earning(line.bonusNote ?? "Bonus", line.bonus)] : []),
    ...(toNumber(line.commission) ? [earning("Sales commission", line.commission)] : []),
    ...(toNumber(line.adjustment) ? [earning(line.adjustmentNote ?? "Adjustment", line.adjustment)] : []),
    ...(line.unpaidDays ? [deduction(`Unpaid leave (${line.unpaidDays} day${line.unpaidDays > 1 ? "s" : ""})`, line.unpaidDeduction)] : []),
    deduction("Income tax", line.tax),
    ...(toNumber(line.otherDeductions) ? [deduction(line.otherNote ?? "Other deductions", line.otherDeductions)] : []),
  ];
  const totalDeductions = toNumber(line.tax) + toNumber(line.otherDeductions) + toNumber(line.unpaidDeduction);
  return {
    id: `ps_${run.month}_${line.empId}`,
    runId: run.id,
    empId: line.empId,
    month: run.month,
    lines,
    gross: money(toNumber(line.gross) + toNumber(line.unpaidDeduction)),
    totalDeductions: money(totalDeductions),
    net: line.net,
    ytdNet: money(ytdNet),
    ytdTax: money(ytdTax),
    workingDays: run.workingDays,
    unpaidDays: line.unpaidDays,
    bankName: line.bankName,
    accountNumber: line.accountNumber,
    issuedAt: run.payslipsSentAt ?? new Date().toISOString(),
  };
}

export function buildPayslips(runs: PayrollRun[], lines: PayrollLine[]): Payslip[] {
  const out: Payslip[] = [];
  const ytd = new Map<string, { net: number; tax: number; fy: string }>();
  const fyOf = (month: string) => {
    const [y, m] = month.split("-").map(Number);
    return m >= 7 ? `${y}` : `${y - 1}`;
  };
  [...runs]
    .sort((a, b) => a.month.localeCompare(b.month))
    .filter((r) => ["payslips_sent", "posted", "paid"].includes(r.stage))
    .forEach((run) => {
      lines
        .filter((l) => l.runId === run.id)
        .forEach((l) => {
          const fy = fyOf(run.month);
          const prev = ytd.get(l.empId);
          const base = prev && prev.fy === fy ? prev : { net: 0, tax: 0, fy };
          const next = { net: base.net + toNumber(l.net), tax: base.tax + toNumber(l.tax), fy };
          ytd.set(l.empId, next);
          out.push(payslipFromLine(l, run, next.net, next.tax));
        });
    });
  return out.reverse();
}

export function seedAdvances(): SalaryAdvance[] {
  return [
    { id: "adv_1", empId: "ACV-0011", amount: money(60_000), monthlyDeduction: money(10_000), startMonth: monthFromNow(-2), remaining: money(40_000), reason: "Family medical expense", status: "active", createdBy: "ACV-0010", createdAt: dayOfMonth(-3, 22) },
    { id: "adv_2", empId: "ACV-0012", amount: money(30_000), monthlyDeduction: money(15_000), startMonth: monthFromNow(-1), remaining: money(15_000), reason: "Relocation to Karachi", status: "active", createdBy: "ACV-0010", createdAt: dayOfMonth(-2, 20) },
    { id: "adv_3", empId: "ACV-0008", amount: money(20_000), monthlyDeduction: money(10_000), startMonth: monthFromNow(-6), remaining: money(0), reason: "Laptop repair", status: "repaid", createdBy: "ACV-0010", createdAt: dayOfMonth(-7, 18) },
  ];
}

export function seedAdjustments(): PayrollAdjustment[] {
  return [
    { id: "adj_1", fromRunId: `pr_${monthFromNow(-1)}`, toMonth: monthFromNow(0), empId: "ACV-0010", amount: money(5_000), note: "Overtime for last month's close", createdBy: "ACV-0003", createdAt: dayOfMonth(-1, 29, "14:00") },
  ];
}
