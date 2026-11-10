/**
 * Module 8 service functions. Mock today; each JSDoc names the real endpoint (spec §7.3).
 * Payroll data is highly confidential (plan §16): callers without payroll.view get 404, like the server.
 * Chain (maker-checker): Prepared (Finance, payroll.prepare) → Approved (Director, payroll.approve, step-up).
 * The CEO / Founder / Owner has payroll.view and payroll.export only: views every run, acts on none.
 */
import { ApiError, mock, notFound } from "@/lib/api/mock";
import { getViewer } from "@/lib/auth/viewer";
import { employeesTable } from "@/lib/directory";
import { money, toNumber } from "@/lib/format";
import { uid } from "@/lib/utils";
import { nextNumber, table } from "@/mocks/db";
import { HOLIDAY_DATES } from "@/mocks/seed/calendar";
import { PAY } from "@/mocks/seed/people";
import { buildPayslips, seedAdjustments, seedAdvances, seedPayrollLines, seedPayrollRuns } from "@/mocks/seed/payroll";
import type { ApprovalStep } from "@/types";
import { isTopLevelRole } from "@/types";
import { APPROVED_LABEL, calculateLine, DEFAULT_TAX_SLABS, nextMonthKey, PAYROLL_APPROVER, PREPARED_LABEL, totalsOf, workingDaysInMonth } from "./logic";
import type { NewAdvanceInput, PayrollAdjustment, PayrollLine, PayrollRun, Payslip, RunDetail, SalaryAdvance, TaxSlab } from "./types";

export const runsTable = () => table<PayrollRun>("payroll.runs", seedPayrollRuns);
export const linesTable = () => table<PayrollLine>("payroll.lines", seedPayrollLines);
const payTable = () => table<{ empId: string; base: number; allowances: { name: string; amount: number }[]; bank: string; account: string }>("payroll.pay", () =>
  Object.entries(PAY).map(([empId, p]) => ({ empId, ...structuredClone(p) })),
);
const payslipsTable = () => table<Payslip>("payroll.payslips", () => buildPayslips(runsTable(), linesTable()));
const advancesTable = () => table<SalaryAdvance>("payroll.advances", seedAdvances);
const adjustmentsTable = () => table<PayrollAdjustment>("payroll.adjustments", seedAdjustments);
const taxSlabsTable = () => table<TaxSlab>("payroll.taxSlabs", () => structuredClone(DEFAULT_TAX_SLABS));

function requireView() {
  const v = getViewer();
  if (!v.can("payroll.view")) notFound("Payroll");
  return v;
}

function step(run: PayrollRun, i: number, patch: Partial<ApprovalStep>) {
  run.chain[i] = { ...run.chain[i], ...patch };
}

/** Chain positions: 0 Prepared (Finance), 1 Approved (Director). */
const PREPARED = 0;
const APPROVED = 1;

/** Preparation (start, lock, prepare, payslips, posting, bank transfer, advances, adjustments) is Finance's work. */
function canPrepare(v: ReturnType<typeof getViewer>) {
  return v.can("payroll.prepare");
}

/** Build lines for a month from pay, active advances and carried adjustments. */
function buildLines(runId: string, month: string, workingDays: number): PayrollLine[] {
  const [y, m] = month.split("-").map(Number);
  const end = new Date(y, m, 0);
  const prevRun = runsTable().find((r) => r.month === runsTable().map((x) => x.month).filter((x) => x < month).sort().pop());
  const prevLines = prevRun ? linesTable().filter((l) => l.runId === prevRun.id) : [];
  return employeesTable()
    .filter((e) => e.status !== "left" && new Date(e.joiningDate) <= end)
    .flatMap((e) => {
      const pay = payTable().find((p) => p.empId === e.empId);
      if (!pay) return [];
      const allowances = pay.allowances.reduce((a, x) => a + x.amount, 0);
      const adv = advancesTable().filter((a) => a.empId === e.empId && a.status === "active" && a.startMonth <= month);
      const other = adv.reduce((s, a) => s + Math.min(toNumber(a.monthlyDeduction), toNumber(a.remaining)), 0);
      const adjs = adjustmentsTable().filter((a) => a.empId === e.empId && a.toMonth === month);
      const adjustment = adjs.reduce((s, a) => s + toNumber(a.amount), 0);
      const r = calculateLine({ base: pay.base, allowances, bonus: 0, commission: 0, unpaidDays: 0, otherDeductions: other, adjustment, workingDays }, taxSlabsTable());
      const prev = prevLines.find((l) => l.empId === e.empId);
      return [
        {
          id: uid("pl"),
          runId,
          empId: e.empId,
          base: money(pay.base),
          allowances: money(allowances),
          bonus: money(0),
          commission: money(0),
          unpaidDays: 0,
          unpaidDeduction: money(r.unpaidDeduction),
          tax: money(r.tax),
          otherDeductions: money(other),
          otherNote: other ? "Salary advance repayment" : undefined,
          adjustment: money(adjustment),
          adjustmentNote: adjs.map((a) => a.note).join("; ") || undefined,
          gross: money(r.gross),
          net: money(r.net),
          lastMonthNet: prev?.net,
          bankName: pay.bank,
          accountNumber: pay.account,
        } satisfies PayrollLine,
      ];
    });
}

export type RunAction = "calculate" | "prepare" | "approve" | "return" | "send_payslips" | "post" | "mark_paid";

export const payrollApi = {
  /** GET /payroll/runs */
  listRuns: () =>
    mock(() => {
      requireView();
      return [...runsTable()].sort((a, b) => b.month.localeCompare(a.month));
    }),

  /** GET /payroll/runs/:id (+ lines) */
  getRun: (id: string) =>
    mock<RunDetail>(() => {
      requireView();
      const run = runsTable().find((r) => r.id === id || r.number === id);
      if (!run) notFound("Payroll run");
      return { run, lines: linesTable().filter((l) => l.runId === run.id) };
    }),

  /** POST /payroll/runs { month } (Finance) */
  startRun: (month: string) =>
    mock(() => {
      const v = requireView();
      if (!canPrepare(v)) throw new ApiError("forbidden", "Only Finance starts a payroll run.", 403);
      if (runsTable().some((r) => r.month === month)) throw new ApiError("conflict", "A run for this month already exists.");
      const workingDays = workingDaysInMonth(month, HOLIDAY_DATES);
      const id = `pr_${month}`;
      const lines = buildLines(id, month, workingDays);
      const run: PayrollRun = {
        id,
        number: `PR-${month}`,
        month,
        stage: "draft",
        workingDays,
        totals: totalsOf(lines),
        headcount: lines.length,
        chain: [
          { label: PREPARED_LABEL, empId: v.employee.empId, state: "pending" },
          { label: APPROVED_LABEL, empId: PAYROLL_APPROVER, state: "pending" },
        ],
        createdAt: new Date().toISOString(),
      };
      runsTable().push(run);
      linesTable().push(...lines);
      return run;
    }),

  /** POST /payroll/runs/:id/{lock|calculate|prepare|approve|return|send-payslips|post|mark-paid} */
  act: (id: string, action: RunAction, opts: { note?: string } = {}) =>
    mock(() => {
      const v = requireView();
      const me = v.employee.empId;
      const run = runsTable().find((r) => r.id === id);
      if (!run) notFound("Payroll run");
      const now = new Date().toISOString();
      const lines = linesTable().filter((l) => l.runId === run.id);
      const needs = (cond: boolean, msg: string) => {
        if (!cond) throw new ApiError("forbidden", msg, 403);
      };

      switch (action) {
        case "calculate":
          needs(run.stage === "draft" && canPrepare(v), "Only Finance can lock attendance for payroll.");
          run.attendanceLockedAt = now;
          run.stage = "calculated";
          break;
        case "prepare":
          needs(run.stage === "calculated" && canPrepare(v), "Only Finance prepares payroll.");
          run.stage = "prepared";
          run.preparedBy = me;
          run.preparedAt = now;
          run.returnedNote = undefined;
          step(run, PREPARED, { empId: me, state: "done", at: now });
          step(run, APPROVED, { empId: PAYROLL_APPROVER, state: "waiting", at: undefined, note: undefined });
          break;
        case "approve":
          needs(run.stage === "prepared" && v.can("payroll.approve"), "Only the Director approves payroll.");
          needs(run.preparedBy !== me, "You prepared this payroll, so you can't approve it.");
          run.stage = "approved";
          run.approvedBy = me;
          run.approvedAt = now;
          step(run, APPROVED, { empId: me, state: "done", at: now, note: opts.note });
          break;
        case "return":
          needs(run.stage === "prepared", "Only a run waiting for approval can be sent back.");
          needs(v.can("payroll.approve") && run.preparedBy !== me, "Only the Director can send payroll back.");
          needs(!!opts.note, "A reason is required.");
          step(run, APPROVED, { empId: me, state: "rejected", at: now, note: opts.note });
          run.stage = "calculated";
          run.returnedNote = opts.note;
          break;
        case "send_payslips": {
          needs(run.stage === "approved" && canPrepare(v), "Finance sends payslips after the Director approves.");
          run.stage = "payslips_sent";
          run.payslipsSentAt = now;
          const fresh = buildPayslips(runsTable(), linesTable()).filter((p) => p.runId === run.id);
          payslipsTable().unshift(...fresh);
          break;
        }
        case "post":
          needs(run.stage === "payslips_sent" && canPrepare(v), "Payslips must be sent before Finance posts the run.");
          run.stage = "posted";
          run.postedAt = now;
          run.journalEntryNumber = `JE-${run.month.slice(0, 4)}-0${nextNumber("payroll.je", 330)}`;
          break;
        case "mark_paid":
          needs(run.stage === "posted" && canPrepare(v), "Finance records the bank transfer after posting.");
          run.stage = "paid";
          run.paidAt = now;
          run.paymentEntryNumber = `JE-${run.month.slice(0, 4)}-0${nextNumber("payroll.je", 330)}`;
          // Advance repayments are now settled.
          lines.forEach((l) => {
            const adv = advancesTable().find((a) => a.empId === l.empId && a.status === "active");
            if (!adv || !toNumber(l.otherDeductions)) return;
            const left = Math.max(0, toNumber(adv.remaining) - toNumber(l.otherDeductions));
            adv.remaining = money(left);
            if (!left) adv.status = "repaid";
          });
          break;
      }
    }),

  /** POST /payroll/runs/:id/adjustments (fix after approval goes into next month) */
  addAdjustment: (input: { runId: string; empId: string; amount: number; note: string }) =>
    mock(() => {
      const v = requireView();
      if (!canPrepare(v)) throw new ApiError("forbidden", "Only Finance adds payroll adjustments.", 403);
      const run = runsTable().find((r) => r.id === input.runId);
      if (!run) notFound("Payroll run");
      const adj: PayrollAdjustment = {
        id: uid("adj"),
        fromRunId: run.id,
        toMonth: nextMonthKey(run.month),
        empId: input.empId,
        amount: money(input.amount),
        note: input.note,
        createdBy: v.employee.empId,
        createdAt: new Date().toISOString(),
      };
      adjustmentsTable().push(adj);
      return adj;
    }),

  /** GET /payroll/adjustments?month= */
  adjustments: () =>
    mock(() => {
      requireView();
      return adjustmentsTable();
    }),

  /** GET /payslips?empId= (own unless payroll.view) */
  payslips: (empId?: string) =>
    mock(() => {
      const v = getViewer();
      const target = empId ?? v.employee.empId;
      if (target !== v.employee.empId && !v.can("payroll.view")) notFound("Payslip");
      return payslipsTable().filter((p) => p.empId === target);
    }),

  /** GET /payslips/:runId/:empId */
  payslipFor: (runId: string, empId: string) =>
    mock(() => {
      const v = getViewer();
      if (empId !== v.employee.empId && !v.can("payroll.view")) notFound("Payslip");
      return payslipsTable().find((p) => p.runId === runId && p.empId === empId) ?? null;
    }),

  /** GET /payroll/advances (own unless payroll.view) */
  advances: () =>
    mock(() => {
      const v = getViewer();
      return advancesTable().filter((a) => v.can("payroll.view") || a.empId === v.employee.empId);
    }),

  /** POST /payroll/advances */
  createAdvance: (input: NewAdvanceInput) =>
    mock(() => {
      const v = requireView();
      if (!canPrepare(v)) throw new ApiError("forbidden", "Only Finance records salary advances.", 403);
      const target = employeesTable().find((e) => e.empId === input.empId);
      if (!target || isTopLevelRole(target.role)) throw new ApiError("validation", "Salary advances are for employees, not the Owner or CEO.");
      const adv: SalaryAdvance = {
        id: uid("adv"),
        empId: input.empId,
        amount: money(input.amount),
        monthlyDeduction: money(input.monthlyDeduction),
        startMonth: input.startMonth,
        remaining: money(input.amount),
        reason: input.reason,
        status: "active",
        createdBy: v.employee.empId,
        createdAt: new Date().toISOString(),
      };
      advancesTable().unshift(adv);
      return adv;
    }),

  /** GET /settings/tax-slabs */
  taxSlabs: () => mock(() => taxSlabsTable(), { delay: 80 }),
};

/** Settings (M12) writes the tax slabs here so payroll uses the new values (mock only). */
export function currentTaxSlabs() {
  return taxSlabsTable();
}
export function setTaxSlabs(slabs: TaxSlab[]) {
  const t = taxSlabsTable();
  t.splice(0, t.length, ...structuredClone(slabs));
}
