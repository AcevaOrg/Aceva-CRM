/**
 * Module 8 against the REAL API (NEXT_PUBLIC_LIVE_MODULES contains m8). Same function names and result shapes as the mock
 * in api.ts, so the screens keep working. The server decides everything (stages, who may act, totals, tax, the ledger
 * entries); these functions only translate between the API (packages/contracts/src/payroll.ts) and the screen types.
 *
 * Stages: the server has draft, calculated, prepared, reviewed and approved. After approval the screen shows
 * "payslips sent" (payslips are issued on approval), then "posted" once the salary entry is posted in the ledger (Module 9
 * approval), and "paid" once the bank transfer is recorded.
 */
import type {
  BankAccountView, PayrollAdjustmentView, PayrollLineView, PayrollRunLinesResponse, PayrollRunView, PayslipSummary, PayslipView,
  SalaryAdvanceView, TaxSlabsResponse,
} from "@aceva/contracts";
import { http } from "@/lib/api/http";
import { ApiError } from "@/lib/api/mock";
import { getViewer } from "@/lib/auth/viewer";
import type { ApprovalStep, Money } from "@/types";
import { APPROVED_LABEL, PREPARED_LABEL, REVIEWED_LABEL } from "./logic";
import type {
  NewAdvanceInput, PayrollAdjustment, PayrollBankAccount, PayrollLine, PayrollRun, PayrollStage, Payslip, RunDetail, SalaryAdvance, TaxSlab,
} from "./types";

type RunAction = "calculate" | "prepare" | "review" | "approve" | "return" | "send_payslips" | "post" | "mark_paid";
interface RunActionOptions {
  note?: string;
  bankAccountId?: string;
  paidOn?: string;
}

/** Server money strings are kept exactly as they are (never through a float). */
const pkr = (amount: string): Money => ({ amount, currency: "PKR" });
const sumOf = (values: string[]) => {
  // Sums of 2-decimal strings, done in whole paisa so no float error creeps in (exact far beyond any payroll total).
  const paisa = values.reduce((a, v) => a + Math.round(Number(v) * 100), 0);
  const abs = Math.abs(paisa).toString().padStart(3, "0");
  return `${paisa < 0 ? "-" : ""}${abs.slice(0, -2)}.${abs.slice(-2)}`;
};

function uiStage(v: PayrollRunView): PayrollStage {
  if (v.stage !== "approved") return v.stage;
  if (v.paid) return "paid";
  return v.salaryEntry?.status === "posted" ? "posted" : "payslips_sent";
}

function chainOf(v: PayrollRunView): ApprovalStep[] {
  const state = (done: boolean, turn: boolean): ApprovalStep["state"] => (done ? "done" : turn ? "waiting" : "pending");
  return [
    { label: PREPARED_LABEL, empId: v.preparedBy?.empId, state: state(!!v.preparedBy, v.stage === "calculated"), at: v.preparedAt ?? undefined },
    { label: REVIEWED_LABEL, empId: v.reviewedBy?.empId, state: state(!!v.reviewedBy, v.stage === "prepared"), at: v.reviewedAt ?? undefined },
    { label: APPROVED_LABEL, empId: v.approvedBy?.empId, state: state(!!v.approvedBy, v.stage === "reviewed"), at: v.approvedAt ?? undefined },
  ];
}

function mapRun(v: PayrollRunView): PayrollRun {
  return {
    id: v.id,
    number: v.number,
    month: v.month,
    stage: uiStage(v),
    workingDays: v.workingDays ?? 0,
    totals: { gross: pkr(v.totals.gross), deductions: pkr(v.totals.deductions), tax: pkr(v.totals.tax), net: pkr(v.totals.net) },
    headcount: v.headcount,
    attendanceLockedAt: v.calculatedAt ?? undefined,
    preparedBy: v.preparedBy?.empId,
    preparedAt: v.preparedAt ?? undefined,
    reviewedBy: v.reviewedBy?.empId,
    reviewedAt: v.reviewedAt ?? undefined,
    approvedBy: v.approvedBy?.empId,
    approvedAt: v.approvedAt ?? undefined,
    payslipsSentAt: v.approvedAt ?? undefined,
    journalEntryNumber: v.salaryEntry?.number,
    paymentEntryNumber: v.paymentEntry?.number,
    paidAt: v.paymentRecordedAt ?? undefined,
    returnedNote: v.returnedNote ?? undefined,
    chain: chainOf(v),
    createdAt: v.createdAt,
    salaryEntry: v.salaryEntry ?? undefined,
    paymentEntry: v.paymentEntry ?? undefined,
    next: v.next,
    missingPay: v.missingPay,
    pendingAdjustments: v.pendingAdjustments,
    taxSlabLabel: v.taxSlabSet?.label,
  };
}

function mapLine(runId: string, l: PayrollLineView): PayrollLine {
  const items = l.items;
  const of = (kind: "bonus" | "deduction", source: string) => items.filter((i) => i.kind === kind && i.source === source);
  const manualBonus = of("bonus", "manual");
  const commission = of("bonus", "commission");
  const adjustments = items.filter((i) => i.source === "adjustment");
  const manualDeductions = items.filter((i) => i.kind === "deduction" && i.source !== "adjustment");
  const adjustment = sumOf(adjustments.map((i) => (i.kind === "bonus" ? i.amount : `-${i.amount}`)));
  // The screen's "other deductions" are advance repayments plus deduction lines; adjustments have their own column.
  const other = sumOf([l.advanceDeduction, ...manualDeductions.map((i) => i.amount)]);
  const otherNotes = [...(Number(l.advanceDeduction) > 0 ? ["Salary advance repayment"] : []), ...manualDeductions.map((i) => i.label)];
  return {
    id: l.id,
    runId,
    empId: l.empId,
    base: pkr(l.base),
    allowances: pkr(l.allowances),
    bonus: pkr(sumOf(manualBonus.map((i) => i.amount))),
    bonusNote: manualBonus.map((i) => i.label).join("; ") || undefined,
    commission: pkr(sumOf(commission.map((i) => i.amount))),
    unpaidDays: Number(l.unpaidDays),
    unpaidDeduction: pkr(l.unpaidDeduction),
    tax: pkr(l.tax),
    otherDeductions: pkr(other),
    otherNote: otherNotes.join("; ") || undefined,
    adjustment: pkr(adjustment),
    adjustmentNote: adjustments.map((i) => i.label).join("; ") || undefined,
    gross: pkr(l.gross),
    net: pkr(l.net),
    lastMonthNet: l.lastMonthNet ? pkr(l.lastMonthNet) : undefined,
    // Bank details are not part of the run lines; they leave the system only through the logged bank sheet.
    bankName: "",
    accountNumber: "",
    advanceDeduction: pkr(l.advanceDeduction),
    flags: l.flags,
    items: items.map((i) => ({ id: i.id, kind: i.kind, source: i.source, label: i.label, amount: pkr(i.amount) })),
  };
}

function mapPayslip(v: PayslipView): Payslip {
  return {
    id: v.id,
    runId: v.runNumber,
    empId: v.empId,
    month: v.month,
    lines: v.lines.map((l) => ({ label: l.label, kind: l.kind, amount: pkr(l.amount) })),
    gross: pkr(v.earnings),
    totalDeductions: pkr(v.deductions),
    net: pkr(v.net),
    ytdNet: pkr(v.ytdNet),
    ytdTax: pkr(v.ytdTax),
    workingDays: v.workingDays,
    unpaidDays: Number(v.unpaidDays),
    bankName: v.bankName ?? "",
    accountNumber: v.accountMasked ?? "",
    issuedAt: v.issuedAt,
  };
}

function mapAdvance(a: SalaryAdvanceView): SalaryAdvance {
  return {
    id: a.id,
    empId: a.empId,
    amount: pkr(a.amount),
    monthlyDeduction: pkr(a.monthlyDeduction),
    startMonth: a.startMonth,
    remaining: pkr(a.remaining),
    reason: a.reason,
    status: a.status,
    payoutEntry: a.payoutEntry ?? undefined,
    createdBy: a.createdBy ?? "",
    createdAt: a.createdAt,
  };
}

function mapAdjustment(a: PayrollAdjustmentView): PayrollAdjustment {
  return {
    id: a.id,
    fromRunId: a.originRunNumber ?? "",
    toMonth: a.targetMonth,
    empId: a.empId,
    amount: pkr(a.kind === "deduction" ? `-${a.amount}` : a.amount),
    note: a.reason,
    createdBy: a.createdBy ?? "",
    createdAt: a.createdAt,
  };
}

const twoDecimals = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** The runs last read from the server: the approvals inbox (a synchronous provider) lists from here. */
let runCache: PayrollRun[] = [];
let runCacheAt = 0;
export const liveRunCache = () => ({ runs: runCache, at: runCacheAt });

async function listRuns(): Promise<PayrollRun[]> {
  const runs = (await http.get<PayrollRunView[]>("/payroll/runs")).map(mapRun);
  runCache = runs;
  runCacheAt = Date.now();
  return runs;
}

async function runAction(id: string, action: RunAction, opts: RunActionOptions = {}): Promise<void> {
  switch (action) {
    case "calculate":
    case "prepare":
    case "review":
    case "approve":
      await http.post(`/payroll/runs/${id}/${action}`, {});
      return;
    case "return":
      await http.post(`/payroll/runs/${id}/return`, { reason: opts.note ?? "" });
      return;
    case "mark_paid":
      if (!opts.bankAccountId || !opts.paidOn) throw new ApiError("validation", "Choose the bank account and the day of the transfer.", 400);
      await http.post(`/payroll/runs/${id}/mark-paid`, { bankAccountId: opts.bankAccountId, paidOn: opts.paidOn });
      return;
    default:
      throw new ApiError(
        "not_available",
        "Payslips are issued when the CEO approves the run, and the salary entry is posted through the ledger approval.",
        409,
      );
  }
}

async function payslipsOf(empId?: string): Promise<Payslip[]> {
  const me = getViewer().employee.empId;
  const own = !empId || empId === me;
  const list = await http.get<PayslipSummary[]>(own ? "/payslips/me" : `/payslips/employees/${empId}`);
  const full = await Promise.all(list.map((s) => http.get<PayslipView>(own ? `/payslips/me/${s.month}` : `/payslips/${s.id}`)));
  return full.map(mapPayslip);
}

async function payslipFor(_runId: string, empId: string, month?: string): Promise<Payslip | null> {
  const own = empId === getViewer().employee.empId;
  try {
    if (own && month) return mapPayslip(await http.get<PayslipView>(`/payslips/me/${month}`));
    const list = await http.get<PayslipSummary[]>(own ? "/payslips/me" : `/payslips/employees/${empId}`);
    const hit = list.find((s) => s.month === month);
    return hit ? mapPayslip(await http.get<PayslipView>(`/payslips/${hit.id}`)) : null;
  } catch (e) {
    if (e instanceof ApiError && e.status === 404) return null;
    throw e;
  }
}

function download(blob: Blob, fileName: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

export const livePayrollApi = {
  /** GET /payroll/runs */
  listRuns,

  /** GET /payroll/runs/:id/lines (a logged sensitive view) */
  getRun: async (id: string): Promise<RunDetail> => {
    const res = await http.get<PayrollRunLinesResponse>(`/payroll/runs/${id}/lines`);
    const run = mapRun(res.run);
    runCache = [run, ...runCache.filter((r) => r.id !== run.id)];
    return { run, lines: res.lines.map((l) => mapLine(run.id, l)) };
  },

  /** POST /payroll/runs { month } */
  startRun: async (month: string): Promise<PayrollRun> => mapRun(await http.post<PayrollRunView>("/payroll/runs", { month })),

  /** POST /payroll/runs/:id/{calculate|prepare|review|approve|return|mark-paid} */
  act: (id: string, action: RunAction, opts: RunActionOptions = {}) => runAction(id, action, opts),

  /** POST /payroll/adjustments: a fix for an approved run, carried into a later month */
  addAdjustment: async (input: { runId: string; empId: string; amount: number; note: string; targetMonth?: string }): Promise<PayrollAdjustment> => {
    if (!input.targetMonth) throw new ApiError("validation", "Choose the month that carries the adjustment.", 400);
    const body = { empId: input.empId, originRunId: input.runId, targetMonth: input.targetMonth, kind: input.amount < 0 ? "deduction" : "bonus", amount: twoDecimals(Math.abs(input.amount)), reason: input.note };
    return mapAdjustment(await http.post<PayrollAdjustmentView>("/payroll/adjustments", body));
  },

  /** GET /payroll/adjustments */
  adjustments: async (): Promise<PayrollAdjustment[]> => (await http.get<PayrollAdjustmentView[]>("/payroll/adjustments")).map(mapAdjustment),

  /** GET /payslips/me (own) or GET /payslips/employees/:empId (payroll.view, logged), with each payslip */
  payslips: (empId?: string) => payslipsOf(empId),

  /** The payslip of one person for one month (own, or logged for payroll.view) */
  payslipFor,

  /** GET /payroll/advances (payroll.view) or GET /payroll/advances/me */
  advances: async (): Promise<SalaryAdvance[]> => {
    const all = getViewer().can("payroll.view");
    return (await http.get<SalaryAdvanceView[]>(all ? "/payroll/advances" : "/payroll/advances/me")).map(mapAdvance);
  },

  /** POST /payroll/advances: the payout entry then waits for the ledger approval */
  createAdvance: async (input: NewAdvanceInput): Promise<SalaryAdvance> => {
    if (!input.bankAccountId) throw new ApiError("validation", "Choose the bank account the advance is paid from.", 400);
    const body = { empId: input.empId, amount: twoDecimals(input.amount), monthlyDeduction: twoDecimals(input.monthlyDeduction), startMonth: input.startMonth, reason: input.reason, bankAccountId: input.bankAccountId };
    return mapAdvance(await http.post<SalaryAdvanceView>("/payroll/advances", body));
  },

  /** GET /settings/tax-slabs: the version in force (empty when none was entered; payroll then refuses to calculate) */
  taxSlabs: async (): Promise<TaxSlab[]> => {
    const res = await http.get<TaxSlabsResponse>("/settings/tax-slabs");
    return (res.current?.slabs ?? []).map((s) => ({ from: Number(s.from), to: s.to === null ? null : Number(s.to), fixed: Number(s.fixed), rate: Number(s.rate) }));
  },

  /** POST /settings/tax-slabs: a NEW version (settings.manage; validated and logged by the server) */
  saveTaxSlabs: async (slabs: TaxSlab[], version: { effectiveFrom: string; label: string }): Promise<TaxSlab[]> => {
    const body = {
      ...version,
      slabs: slabs.map((s) => ({ from: twoDecimals(s.from), to: s.to === null ? null : twoDecimals(s.to), fixed: twoDecimals(s.fixed), rate: s.rate.toFixed(4) })),
    };
    const res = await http.post<TaxSlabsResponse>("/settings/tax-slabs", body);
    return (res.current?.slabs ?? []).map((s) => ({ from: Number(s.from), to: s.to === null ? null : Number(s.to), fixed: Number(s.fixed), rate: Number(s.rate) }));
  },

  /** GET /bank-accounts (Module 9): active PKR bank accounts a salary or an advance can be paid from */
  bankAccounts: async (): Promise<PayrollBankAccount[]> =>
    (await http.get<BankAccountView[]>("/bank-accounts")).filter((b) => b.active && b.currency === "PKR").map((b) => ({ id: b.id, code: b.code, name: b.name })),

  /** GET /payroll/runs/:id/bank-sheet: CSV, highly confidential; needs a fresh step-up; logged by the server */
  bankSheet: async (runId: string): Promise<void> => {
    const blob = await http.blob(`/payroll/runs/${runId}/bank-sheet`);
    const run = runCache.find((r) => r.id === runId);
    download(blob, `${run?.number ?? "payroll"}-bank-sheet-HIGHLY-CONFIDENTIAL.csv`);
  },
};
