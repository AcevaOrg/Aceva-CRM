/**
 * Module 11 service functions: spreadsheet rows, saved views, import, insights graphs.
 * Everything is read from the ledger; nothing here changes a posted number (plan §15).
 */
import { flatten, inBooks, lineBase, m2, monthKeyOf, num } from "@/features/ledger/logic";
import { accountsTable, bookLines, entriesTable, isLocked, partiesTable, projectsList, saveEntry } from "@/features/ledger/store";
import { agingByDoc, AGING_BUCKETS, dayEnd, dayStart, projectProfit } from "@/features/statements/logic";
import { buildContext, rateAt } from "@/features/statements/api";
import { ApiError, mock, notFound } from "@/lib/api/mock";
import type { Permission } from "@/lib/auth/permissions";
import { getViewer } from "@/lib/auth/viewer";
import { employeeName } from "@/lib/directory";
import { formatMonthShort } from "@/lib/dates";
import { uid } from "@/lib/utils";
import { table } from "@/mocks/db";
import type { Currency } from "@/types";
import { goodEntries, parseImport, pctChange } from "./logic";
import type { DrillKind, DrillLine, FinanceKpis, ImportRow, InsightsData, InsightsParams, LedgerRow, MonthlySeries, SavedView } from "./types";

function guard(p: Permission) {
  const v = getViewer();
  if (!v.can(p)) notFound("Page");
  return v;
}

const thisMonth = () => monthKeyOf(new Date());

const viewsTable = () =>
  table<SavedView>("analysis.views", () => [
    { id: "v-all", name: "All lines in the books", filters: { status: "in_books", month: "all", group: "all", currency: "all" }, createdBy: "system", builtIn: true },
    {
      id: "v-month-exp",
      name: `${new Date().toLocaleString("en-GB", { month: "long" })} expenses by project`,
      filters: { status: "in_books", month: thisMonth(), group: "expense", currency: "all" },
      sort: [{ colId: "project", sort: "asc" }],
      createdBy: "system",
      builtIn: true,
    },
    { id: "v-pending", name: "Waiting for approval", filters: { status: "pending_approval", month: "all", group: "all", currency: "all" }, createdBy: "system", builtIn: true },
    { id: "v-usd", name: "USD lines", filters: { status: "all", month: "all", group: "all", currency: "USD" }, createdBy: "system", builtIn: true },
    { id: "v-revenue", name: "Revenue by client", filters: { status: "in_books", month: "all", group: "income", currency: "all" }, sort: [{ colId: "client", sort: "asc" }], createdBy: "system", builtIn: true },
  ]);

function rowsAll(): LedgerRow[] {
  const accounts = new Map(accountsTable().map((a) => [a.id, a]));
  const parties = new Map(partiesTable().map((p) => [p.id, p.name]));
  const projects = new Map(projectsList().map((p) => [p.id, p.name]));
  const out: LedgerRow[] = [];
  for (const e of entriesTable()) {
    for (const l of e.lines) {
      const a = accounts.get(l.accountId);
      const b = lineBase(l, e);
      out.push({
        id: `${e.id}:${l.id}`,
        entryId: e.id,
        lineId: l.id,
        date: e.date,
        month: monthKeyOf(e.date),
        entryNumber: e.number,
        accountId: l.accountId,
        accountCode: a?.code ?? "",
        account: a ? `${a.code} · ${a.name}` : l.accountId,
        group: a?.group ?? "asset",
        description: l.description || e.description,
        client: l.partyId ? (parties.get(l.partyId) ?? "") : "",
        project: e.projectId ? (projects.get(e.projectId) ?? e.projectId) : "",
        employee: l.empId ? employeeName(l.empId) : "",
        debit: b.dr,
        credit: b.cr,
        currency: e.currency,
        exchangeRate: num(e.exchangeRate),
        status: e.status,
        source: e.source,
        locked: e.status === "posted" || e.status === "reversed",
      });
    }
  }
  return out.sort((x, y) => y.date.localeCompare(x.date));
}

/* ---------------- Insights ---------------- */

function plSplit(lines: ReturnType<typeof bookLines>, from: number, to: number) {
  const accounts = new Map(accountsTable().map((a) => [a.id, a]));
  let revenue = 0;
  let expenses = 0;
  let other = 0;
  for (const l of lines) {
    if (l.time < from || l.time > to) continue;
    const a = accounts.get(l.accountId);
    if (!a) continue;
    if (a.group === "income") {
      if (a.kind === "revenue") revenue += l.cr - l.dr;
      else other += l.cr - l.dr;
    } else if (a.group === "expense") expenses += l.dr - l.cr;
  }
  return { revenue, expenses, profit: revenue + other - expenses };
}

function cashAt(lines: ReturnType<typeof bookLines>, t: number) {
  const cash = new Set(accountsTable().filter((a) => a.kind === "cash").map((a) => a.id));
  return lines.filter((l) => cash.has(l.accountId) && l.time <= t).reduce((s, l) => s + l.dr - l.cr, 0);
}

export function computeKpis(currency: Currency = "PKR"): FinanceKpis {
  const lines = bookLines();
  const now = new Date();
  const div = currency === "USD" ? rateAt(now.getTime()) : 1;
  const mStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  const lastStart = new Date(now.getFullYear(), now.getMonth() - 1, 1).getTime();
  const lastSameDay = new Date(now.getFullYear(), now.getMonth() - 1, Math.min(now.getDate(), new Date(now.getFullYear(), now.getMonth(), 0).getDate()), 23, 59, 59).getTime();
  const cur = plSplit(lines, mStart, now.getTime());
  const prev = plSplit(lines, lastStart, lastSameDay);
  const cashNow = cashAt(lines, now.getTime());
  const cashPrev = cashAt(lines, mStart - 1);
  const aging = agingByDoc(buildContext(), now.getTime());
  const unpaid = aging.reduce((s, d) => s + d.pkr, 0);
  const money = (n: number) => ({ amount: m2(n / div), currency });
  return {
    asOf: now.toISOString(),
    currency,
    cash: money(cashNow),
    cashDelta: pctChange(cashNow, cashPrev),
    revenue: money(cur.revenue),
    revenueDelta: pctChange(cur.revenue, prev.revenue),
    expenses: money(cur.expenses),
    expensesDelta: pctChange(cur.expenses, prev.expenses),
    profit: money(cur.profit),
    profitDelta: pctChange(cur.profit, prev.profit),
    unpaidInvoices: money(unpaid),
    unpaidCount: aging.length,
    overdueCount: aging.filter((d) => d.days > 0).length,
  };
}

export function computeSeries(from: number, to: number, currency: Currency = "PKR"): MonthlySeries {
  const lines = bookLines();
  const div = currency === "USD" ? rateAt(to) : 1;
  const months: string[] = [];
  const s: MonthlySeries = { currency, months, labels: [], revenue: [], expenses: [], profit: [], cash: [] };
  const start = new Date(from);
  for (let d = new Date(start.getFullYear(), start.getMonth(), 1); d.getTime() <= to; d = new Date(d.getFullYear(), d.getMonth() + 1, 1)) {
    const mFrom = d.getTime();
    const mTo = Math.min(new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59, 999).getTime(), to);
    const pl = plSplit(lines, mFrom, mTo);
    months.push(monthKeyOf(d));
    s.labels.push(formatMonthShort(d));
    s.revenue.push(Math.round(pl.revenue / div));
    s.expenses.push(Math.round(pl.expenses / div));
    s.profit.push(Math.round(pl.profit / div));
    s.cash.push(Math.round(cashAt(lines, mTo) / div));
  }
  return s;
}

export const analysisApi = {
  /** GET /ledger/rows (spreadsheet) */
  rows: () => mock(() => (guard("sheet.view"), rowsAll()), { delay: 250 }),

  /** GET /sheet/views */
  views: () =>
    mock(() => {
      const me = guard("sheet.view").employee.empId;
      return viewsTable().filter((v) => v.builtIn || v.createdBy === me);
    }, { delay: 80 }),

  /** POST /sheet/views */
  saveView: (view: Omit<SavedView, "id" | "createdBy">) =>
    mock(() => {
      const me = guard("sheet.view").employee.empId;
      const v: SavedView = { ...view, id: uid("view"), createdBy: me };
      viewsTable().push(v);
      return v;
    }),

  /** DELETE /sheet/views/:id */
  deleteView: (id: string) =>
    mock(() => {
      const me = guard("sheet.view").employee.empId;
      const list = viewsTable();
      const i = list.findIndex((v) => v.id === id && v.createdBy === me);
      if (i >= 0) list.splice(i, 1);
    }),

  /** POST /sheet/import (preview, nothing saved) */
  importPreview: (csv: string) =>
    mock<ImportRow[]>(() => {
      guard("sheet.import");
      return parseImport(csv, accountsTable(), isLocked);
    }, { delay: 300 }),

  /** POST /sheet/import/commit → good entries saved as drafts for approval */
  importCommit: (rows: ImportRow[]) =>
    mock(() => {
      const me = guard("sheet.import").employee.empId;
      const good = goodEntries(rows);
      if (!good.length) throw new ApiError("validation", "There are no good rows to save.");
      const accounts = accountsTable();
      const refs = [...new Set(good.map((r) => r.ref))];
      return refs.map((ref) => {
        const g = good.filter((r) => r.ref === ref);
        return saveEntry(
          {
            date: new Date(g[0].date).toISOString(),
            description: g[0].description || `Imported entry ${ref}`,
            currency: "PKR",
            exchangeRate: "1",
            projectId: g.find((r) => r.project)?.project,
            lines: g.map((r) => ({ accountId: accounts.find((a) => a.code === r.accountCode)!.id, description: r.description, debit: m2(r.debit), credit: m2(r.credit) })),
            submit: false,
          },
          me,
        ).number;
      });
    }),

  /** PATCH /journal-entries/:id/lines/:lineId (drafts only) */
  updateDraftLine: (entryId: string, lineId: string, field: "description" | "debit" | "credit", value: string) =>
    mock(() => {
      guard("finance.entry_create");
      const e = entriesTable().find((x) => x.id === entryId);
      if (!e) notFound("Entry");
      if (e.status !== "draft") throw new ApiError("validation", "Only drafts can be edited here.");
      const l = e.lines.find((x) => x.id === lineId);
      if (!l) notFound("Line");
      if (field === "description") l.description = value;
      else l[field] = m2(num(value) / (num(e.exchangeRate) || 1));
      e.history.push({ at: new Date().toISOString(), by: getViewer().employee.empId, action: "edited", note: `Changed ${field} in the spreadsheet` });
    }),

  /** GET /insights?from&to&currency */
  insights: (p: InsightsParams) =>
    mock<InsightsData>(() => {
      guard("insights.view");
      const from = dayStart(p.from);
      const to = dayEnd(p.to);
      const div = p.currency === "USD" ? rateAt(to) : 1;
      const lines = bookLines();
      const accounts = accountsTable();
      const exp = new Map<string, number>();
      for (const l of lines) {
        if (l.time < from || l.time > to) continue;
        const a = accounts.find((x) => x.id === l.accountId);
        if (a?.group === "expense") exp.set(a.id, (exp.get(a.id) ?? 0) + l.dr - l.cr);
      }
      const sorted = [...exp].filter(([, v]) => v > 0).sort((a, b) => b[1] - a[1]);
      const top = sorted.slice(0, 6).map(([id, v]) => ({ key: id, name: accounts.find((a) => a.id === id)!.name, value: Math.round(v / div) }));
      const rest = sorted.slice(6).reduce((s, [, v]) => s + v, 0);
      if (rest > 0) top.push({ key: "other", name: "Everything else", value: Math.round(rest / div) });
      const aging = agingByDoc(buildContext(), Math.min(to, Date.now()));
      return {
        kpis: computeKpis(p.currency),
        series: computeSeries(from, to, p.currency),
        expenseBreakdown: top,
        aging: AGING_BUCKETS.map((b) => {
          const docs = aging.filter((d) => d.bucket === b.key);
          return { key: b.key, label: b.label, value: Math.round(docs.reduce((s, d) => s + d.pkr, 0) / div), count: docs.length };
        }),
        projects: projectProfit({ lines, accounts, projects: projectsList() }, from, to)
          .filter((r) => r.id !== "_none")
          .map((r) => ({ key: r.id, name: r.name, revenue: Math.round(r.revenue / div), costs: Math.round(r.costs / div), profit: Math.round(r.profit / div) }))
          .sort((a, b) => b.profit - a.profit),
      };
    }, { delay: 300 }),

  /** GET /insights/drill?kind&key&from&to (the entries behind a bar or slice) */
  drill: (kind: DrillKind, key: string, p: InsightsParams) =>
    mock<DrillLine[]>(() => {
      guard("insights.view");
      const div = p.currency === "USD" ? rateAt(dayEnd(p.to)) : 1;
      const accounts = new Map(accountsTable().map((a) => [a.id, a]));
      const from = dayStart(p.from);
      const to = dayEnd(p.to);
      if (kind === "aging-bucket") {
        return agingByDoc(buildContext(), Math.min(to, Date.now()))
          .filter((d) => d.bucket === key)
          .map((d) => ({
            key: d.doc.id,
            entryId: d.doc.entryId,
            number: d.doc.number,
            date: d.doc.dueDate,
            label: partiesTable().find((x) => x.id === d.doc.clientId)?.name ?? "",
            description: d.days > 0 ? `${d.days} days overdue` : "Not yet due",
            amount: d.pkr / div,
          }));
      }
      const lines = flatten(entriesTable().filter(inBooks)).filter((l) => {
        const a = accounts.get(l.accountId);
        if (!a) return false;
        const inMonth = monthKeyOf(l.date) === key;
        switch (kind) {
          case "revenue-month":
            return inMonth && a.group === "income" && a.kind === "revenue";
          case "expense-month":
            return inMonth && a.group === "expense";
          case "profit-month":
            return inMonth && (a.group === "income" || a.group === "expense");
          case "cash-month":
            return inMonth && a.kind === "cash";
          case "expense-account":
            return l.time >= from && l.time <= to && (key === "other" ? a.group === "expense" : l.accountId === key);
          case "project":
            return l.time >= from && l.time <= to && l.projectId === key && (a.group === "income" || a.group === "expense");
        }
        return false;
      });
      return lines
        .sort((x, y) => y.time - x.time)
        .map((l) => {
          const a = accounts.get(l.accountId)!;
          const natural = a.group === "income" || a.group === "liability" || a.group === "equity" ? l.cr - l.dr : l.dr - l.cr;
          return { key: l.key, entryId: l.entryId, number: l.entryNumber, date: l.date, label: `${a.code} · ${a.name}`, description: l.description, amount: natural / div };
        });
    }),

  /** GET /insights/kpis (Home dashboard) */
  kpis: (currency: Currency = "PKR") => mock(() => (guard("insights.view"), computeKpis(currency)), { delay: 150 }),

  /** GET /insights/revenue-expense (Home dashboard): last 6 months */
  revenueExpense: () =>
    mock(() => {
      guard("insights.view");
      const now = new Date();
      return computeSeries(new Date(now.getFullYear(), now.getMonth() - 5, 1).getTime(), now.getTime(), "PKR");
    }, { delay: 150 }),
};
