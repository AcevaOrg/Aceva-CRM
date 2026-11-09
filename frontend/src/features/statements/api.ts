/**
 * Module 10 service functions. Statements are computed from posted ledger entries (plan §14).
 * Mock today; each JSDoc names the real endpoint (spec §7.3).
 */
import { monthKeyOf } from "@/features/ledger/logic";
import { accountsTable, billsTable, bookLines, partiesTable, periodsTable, projectsList, ratesTable, receivablesTable } from "@/features/ledger/store";
import { ApiError, mock, notFound } from "@/lib/api/mock";
import { getViewer } from "@/lib/auth/viewer";
import { table } from "@/mocks/db";
import {
  apDue, arAging, balanceSheet, cashFlow, comprehensiveIncome, dayEnd, dayStart, equityStatement, generalLedger, incomeChecks,
  incomeStatement, mergeCompare, profitByProject, taxPayable, trialBalance, ymd, type BuildContext, type Built,
} from "./logic";
import { STATEMENT_META, type Statement, type StatementParams } from "./types";

const finals = () => table<{ key: string; by: string; at: string }>("statements.final", () => []);
const keyOf = (p: StatementParams) => `${p.type}|${p.from}|${p.to}`;

export function rateAt(time: number) {
  const rates = ratesTable();
  const m = monthKeyOf(new Date(time));
  return Number((rates.find((r) => r.month === m) ?? rates[rates.length - 1])?.rate ?? 283);
}

export function buildContext(divisor = 1): BuildContext {
  return {
    lines: bookLines(),
    accounts: accountsTable(),
    receivables: receivablesTable(),
    bills: billsTable(),
    parties: partiesTable(),
    projects: projectsList(),
    rateAt,
    divisor,
  };
}

function build(ctx: BuildContext, p: StatementParams, from: number, to: number): Built {
  switch (p.type) {
    case "balance-sheet":
      return balanceSheet(ctx, to);
    case "income": {
      const is = incomeStatement(ctx, from, to);
      return { sections: is.sections, checks: incomeChecks(ctx, to, balanceSheet(ctx, to)) };
    }
    case "cash-flow":
      return cashFlow(ctx, from, to, balanceSheet(ctx, to));
    case "equity":
      return equityStatement(ctx, from, to, balanceSheet(ctx, to));
    case "comprehensive":
      return comprehensiveIncome(ctx, from, to);
    case "trial-balance":
      return trialBalance(ctx, to);
    case "general-ledger":
      return generalLedger(ctx, p.accountId ?? "acc-1110", from, to);
    case "ar-aging":
      return arAging(ctx, to);
    case "ap-due":
      return apDue(ctx, to);
    case "profit-by-project":
      return profitByProject(ctx, from, to);
    case "tax-payable":
      return taxPayable(ctx, from, to);
  }
}

function statusOf(p: StatementParams, from: number, to: number): Pick<Statement, "status" | "snapshotAt" | "finalBy"> {
  if (!STATEMENT_META[p.type].isStatement) return { status: "draft" };
  const months: string[] = [];
  for (let d = new Date(from); d.getTime() <= to; d.setMonth(d.getMonth() + 1, 1)) months.push(monthKeyOf(d));
  const periods = periodsTable();
  const allClosed = months.length > 0 && months.every((m) => periods.find((x) => x.month === m)?.status === "closed");
  const end = new Date(to);
  const monthEnd = new Date(end.getFullYear(), end.getMonth() + 1, 0).getDate() === end.getDate();
  if (allClosed && monthEnd) {
    const last = periods.find((x) => x.month === months[months.length - 1]);
    return { status: "snapshot", snapshotAt: last?.approvedAt };
  }
  const f = finals().find((x) => x.key === keyOf(p));
  return f ? { status: "final", finalBy: f.by } : { status: "draft" };
}

export const statementsApi = {
  /** GET /statements/:type?from&to&currency&compare (and /reports/:type) */
  get: (p: StatementParams) =>
    mock<Statement>(() => {
      if (!getViewer().can("statements.view")) notFound("Statement");
      const from = dayStart(p.from);
      const to = dayEnd(p.to);
      const divisor = p.currency === "USD" ? rateAt(to) : 1;
      const ctx = buildContext(divisor);
      const cur = build(ctx, p, from, to);
      let sections = cur.sections;
      let compare: Statement["compare"];
      if (p.compare && cur.sections.length) {
        const len = to - from;
        const prevTo = from - 1;
        const prevFrom = prevTo - len;
        sections = mergeCompare(cur.sections, build(ctx, p, prevFrom, prevTo).sections);
        compare = { from: ymd(prevFrom), to: ymd(prevTo) };
      }
      const meta = STATEMENT_META[p.type];
      return {
        type: p.type,
        title: meta.title,
        description: meta.description,
        from: p.from,
        to: p.to,
        currency: p.currency,
        rate: divisor.toFixed(2),
        compare,
        sections,
        table: cur.table,
        checks: cur.checks,
        generatedAt: new Date().toISOString(),
        accountId: p.type === "general-ledger" ? (p.accountId ?? "acc-1110") : undefined,
        ...statusOf(p, from, to),
      };
    }, { delay: 250 }),

  /** POST /statements/:type/mark-final (only when every check passes) */
  markFinal: (p: StatementParams) =>
    mock(() => {
      const v = getViewer();
      if (!v.can("statements.view") || !(v.can("finance.entry_approve") || v.can("finance.close"))) throw new ApiError("forbidden", "You can't mark statements final.", 403);
      const from = dayStart(p.from);
      const to = dayEnd(p.to);
      const built = build(buildContext(), p, from, to);
      if (built.checks.some((c) => !c.pass)) throw new ApiError("validation", "A built-in check failed, so this statement can't be marked final.");
      const list = finals();
      if (!list.some((x) => x.key === keyOf(p))) list.push({ key: keyOf(p), by: v.employee.empId, at: new Date().toISOString() });
    }),

  /** GET /accounts (for the general-ledger account picker) */
  accounts: () => mock(() => accountsTable().filter((a) => !a.isHeader), { delay: 60 }),
};
