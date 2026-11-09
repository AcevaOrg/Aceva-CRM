/**
 * Statement builders (plan §14). Pure functions over posted ledger lines.
 * Every statement runs its built-in check by computing the same figure two independent ways.
 */
import { m2, naturalSign, type FlatLine } from "@/features/ledger/logic";
import type { Account, AccountKind, Bill, FinanceProject, Party, ReceivableDoc } from "@/features/ledger/types";
import type { ReportRow, ReportTable, StatementCheck, StatementLine, StatementSection } from "./types";

export interface BuildContext {
  lines: FlatLine[];
  accounts: Account[];
  receivables: ReceivableDoc[];
  bills: Bill[];
  parties: Party[];
  projects: FinanceProject[];
  /** PKR per USD at a time. */
  rateAt: (time: number) => number;
  /** Display divisor (1 for PKR, the closing rate for USD). */
  divisor: number;
}

export interface Built {
  sections: StatementSection[];
  table?: ReportTable;
  checks: StatementCheck[];
}

const DAY = 86_400_000;

export function dayStart(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d, 0, 0, 0, 0).getTime();
}
export function dayEnd(ymd: string) {
  const [y, m, d] = ymd.split("-").map(Number);
  return new Date(y, m - 1, d, 23, 59, 59, 999).getTime();
}
export function ymd(t: number | Date) {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

/** Pakistan's tax year: 1 July to 30 June (plan §14). */
export function fyStart(t: number) {
  const d = new Date(t);
  const y = d.getMonth() >= 6 ? d.getFullYear() : d.getFullYear() - 1;
  return new Date(y, 6, 1).getTime();
}

/** Lower-case the first word unless it is a name (bank, province). */
const PROPER = ["Sindh", "HBL", "Meezan", "Payoneer", "USD", "PKR"];
function lowerFirst(name: string) {
  const first = name.split(" ")[0];
  return PROPER.includes(first) ? name : name.charAt(0).toLowerCase() + name.slice(1);
}

const PL = (a: Account) => a.group === "income" || a.group === "expense";

function netMap(lines: FlatLine[], pred: (l: FlatLine) => boolean) {
  const m = new Map<string, number>();
  for (const l of lines) if (pred(l)) m.set(l.accountId, (m.get(l.accountId) ?? 0) + l.dr - l.cr);
  return m;
}

/** Profit = −Σ(dr − cr) over income and expense accounts. */
function profitOf(ctx: BuildContext, pred: (l: FlatLine) => boolean) {
  const pl = new Set(ctx.accounts.filter(PL).map((a) => a.id));
  return -ctx.lines.filter((l) => pl.has(l.accountId) && pred(l)).reduce((s, l) => s + l.dr - l.cr, 0);
}

function makeLine(ctx: BuildContext, key: string, label: string, value: number, extra: Partial<StatementLine> = {}): StatementLine {
  return { key, label, depth: 0, amount: m2(value / ctx.divisor), ...extra };
}

function check(ctx: BuildContext, label: string, left: [string, number], right: [string, number]): StatementCheck {
  return {
    label,
    left: { label: left[0], amount: m2(left[1] / ctx.divisor) },
    right: { label: right[0], amount: m2(right[1] / ctx.divisor) },
    pass: Math.abs(left[1] - right[1]) < 0.5,
  };
}

/* ======================= Balance sheet ======================= */

interface BsResult extends Built {
  assets: number;
  liabilities: number;
  equity: number;
  cash: number;
}

export function balanceSheet(ctx: BuildContext, T: number): BsResult {
  const net = netMap(ctx.lines, (l) => l.time <= T);
  const fy = fyStart(T);
  const currentProfit = profitOf(ctx, (l) => l.time >= fy && l.time <= T);
  const priorProfit = profitOf(ctx, (l) => l.time < fy);

  const groupLines = (headerId: string) => {
    const lines: StatementLine[] = [];
    let total = 0;
    for (const a of ctx.accounts.filter((x) => x.parentId === headerId)) {
      if (a.isHeader) {
        const kids = ctx.accounts.filter((k) => k.parentId === a.id);
        const vals = kids.map((k) => ({ k, v: (net.get(k.id) ?? 0) * naturalSign(k.group) }));
        if (!vals.some((x) => Math.abs(x.v) >= 0.005)) continue;
        lines.push({ key: `hdr:${a.id}`, label: a.name, depth: 0, amount: "" });
        let sub = 0;
        for (const { k, v } of vals) {
          if (Math.abs(v) < 0.005) continue;
          sub += v;
          lines.push(makeLine(ctx, `acc:${k.id}`, k.name, v, { accountId: k.id, code: k.code, depth: 1 }));
        }
        lines.push(makeLine(ctx, `sub:${a.id}`, `Total ${a.name.toLowerCase()}`, sub, { isSubtotal: true, depth: 0 }));
        total += sub;
      } else {
        const v = (net.get(a.id) ?? 0) * naturalSign(a.group);
        if (Math.abs(v) < 0.005 && a.kind !== "retained_earnings") continue;
        total += v;
        lines.push(makeLine(ctx, `acc:${a.id}`, a.name, v, { accountId: a.id, code: a.code }));
      }
    }
    return { lines, total };
  };

  const assets = groupLines("acc-1000");
  const liabilities = groupLines("acc-2000");

  // Equity: accounts + profit not yet closed into retained earnings.
  const eq: StatementLine[] = [];
  let equity = 0;
  for (const a of ctx.accounts.filter((x) => x.parentId === "acc-3000")) {
    let v = (net.get(a.id) ?? 0) * naturalSign(a.group);
    if (a.kind === "retained_earnings") v += priorProfit;
    if (Math.abs(v) < 0.005) continue;
    equity += v;
    eq.push(makeLine(ctx, `acc:${a.id}`, a.kind === "retained_earnings" ? "Retained earnings (incl. prior-year profit)" : a.name, v, { accountId: a.id, code: a.code }));
  }
  equity += currentProfit;
  eq.push(makeLine(ctx, "eq:current-profit", "Profit for the current year", currentProfit, { note: `From 1 Jul ${new Date(fy).getFullYear()}` }));

  const cash = ctx.accounts.filter((a) => a.kind === "cash").reduce((s, a) => s + (net.get(a.id) ?? 0), 0);

  // Independent route for the check: sum every balance-sheet account straight from the lines.
  const bsIds = new Set(ctx.accounts.filter((a) => !PL(a)).map((a) => a.id));
  const assetIds = new Set(ctx.accounts.filter((a) => a.group === "asset").map((a) => a.id));
  const rawAssets = [...net].filter(([id]) => assetIds.has(id)).reduce((s, [, v]) => s + v, 0);
  const rawClaims = -[...net].filter(([id]) => bsIds.has(id) && !assetIds.has(id)).reduce((s, [, v]) => s + v, 0) + priorProfit + currentProfit;

  return {
    assets: assets.total,
    liabilities: liabilities.total,
    equity,
    cash,
    sections: [
      { title: "Assets", lines: [...assets.lines, makeLine(ctx, "total:assets", "Total assets", assets.total, { isTotal: true })] },
      { title: "Liabilities", lines: [...liabilities.lines, makeLine(ctx, "total:liabilities", "Total liabilities", liabilities.total, { isTotal: true })] },
      {
        title: "Equity",
        lines: [
          ...eq,
          makeLine(ctx, "total:equity", "Total equity", equity, { isTotal: true }),
          makeLine(ctx, "total:le", "Total liabilities and equity", liabilities.total + equity, { isTotal: true }),
        ],
      },
    ],
    checks: [
      check(ctx, "Assets must equal liabilities plus equity", ["Total assets", rawAssets], ["Liabilities + equity", rawClaims]),
    ],
  };
}

/* ======================= Income statement ======================= */

const OPEX: (AccountKind | undefined)[] = ["expense", "depreciation", undefined];

export function incomeStatement(ctx: BuildContext, from: number, to: number) {
  const net = netMap(ctx.lines, (l) => l.time >= from && l.time <= to);
  const val = (a: Account) => (net.get(a.id) ?? 0) * naturalSign(a.group);
  const pick = (pred: (a: Account) => boolean) => ctx.accounts.filter((a) => !a.isHeader && pred(a)).map((a) => ({ a, v: val(a) })).filter((x) => Math.abs(x.v) >= 0.005);

  const revenue = pick((a) => a.group === "income" && a.kind === "revenue");
  const otherIncome = pick((a) => a.group === "income" && a.kind !== "revenue");
  const opex = pick((a) => a.group === "expense" && OPEX.includes(a.kind));
  const otherCosts = pick((a) => a.group === "expense" && !OPEX.includes(a.kind));
  const sum = (xs: { v: number }[]) => xs.reduce((s, x) => s + x.v, 0);
  const rev = sum(revenue);
  const op = sum(opex);
  const oi = sum(otherIncome);
  const oc = sum(otherCosts);
  const operatingProfit = rev - op;
  const netProfit = operatingProfit + oi - oc;
  const accLine = (x: { a: Account; v: number }, neg = false) => makeLine(ctx, `acc:${x.a.id}`, x.a.name, neg ? -x.v : x.v, { accountId: x.a.id, code: x.a.code, depth: 1 });

  const sections: StatementSection[] = [
    { title: "Revenue", lines: [...revenue.map((x) => accLine(x)), makeLine(ctx, "sub:revenue", "Total revenue", rev, { isSubtotal: true })] },
    { title: "Operating expenses", lines: [...opex.map((x) => accLine(x, true)), makeLine(ctx, "sub:opex", "Total operating expenses", -op, { isSubtotal: true }), makeLine(ctx, "total:operating", "Operating profit", operatingProfit, { isTotal: true })] },
    {
      title: "Other income and costs",
      lines: [...otherIncome.map((x) => accLine(x)), ...otherCosts.map((x) => accLine(x, true)), makeLine(ctx, "total:net", "Net profit for the period", netProfit, { isTotal: true })],
    },
  ];
  return { sections, netProfit, revenue: rev, expenses: op + oc - oi };
}

export function incomeChecks(ctx: BuildContext, to: number, bs: BsResult): StatementCheck[] {
  const fy = fyStart(to);
  const ytd = incomeStatement(ctx, fy, to).netProfit;
  // Balance-sheet route: what's left of assets after liabilities and booked equity.
  const net = netMap(ctx.lines, (l) => l.time <= to);
  const eqAccounts = ctx.accounts.filter((a) => a.group === "equity" && !a.isHeader).reduce((s, a) => s - (net.get(a.id) ?? 0), 0);
  const prior = profitOf(ctx, (l) => l.time < fy);
  const bsProfit = bs.assets - bs.liabilities - eqAccounts - prior;
  return [check(ctx, "Profit must equal the current-year profit in equity", [`Profit from 1 Jul ${new Date(fy).getFullYear()} (income statement)`, ytd], ["Current-year profit (balance sheet)", bsProfit])];
}

/* ======================= Cash flow (indirect) ======================= */

const WC: AccountKind[] = ["receivable", "prepayment", "tax_asset", "payable", "salary_payable", "tax_payable", "accrued", "customer_advance"];
const INVESTING: AccountKind[] = ["fixed_asset"];
const FINANCING: AccountKind[] = ["loan", "share_capital", "dividends", "oci_reserve", "retained_earnings"];

export function cashFlow(ctx: BuildContext, from: number, to: number, bs: BsResult): Built & { closing: number } {
  const inPeriod = (l: FlatLine) => l.time >= from && l.time <= to && l.source !== "opening";
  const opening = (l: FlatLine) => l.time <= to && (l.time < from || l.source === "opening");
  const delta = netMap(ctx.lines, inPeriod);
  const acc = (id: string) => ctx.accounts.find((a) => a.id === id)!;
  const profit = profitOf(ctx, inPeriod);
  const cashIds = new Set(ctx.accounts.filter((a) => a.kind === "cash").map((a) => a.id));
  const fxOnCash = ctx.lines.filter((l) => inPeriod(l) && l.source === "revaluation" && cashIds.has(l.accountId)).reduce((s, l) => s + l.dr - l.cr, 0);

  const effect = (kinds: AccountKind[]) =>
    ctx.accounts
      .filter((a) => !a.isHeader && a.kind && kinds.includes(a.kind))
      .map((a) => ({ a, v: -(delta.get(a.id) ?? 0) }))
      .filter((x) => Math.abs(x.v) >= 0.005);

  const dep = effect(["accumulated_depreciation"]).reduce((s, x) => s + x.v, 0);
  const wc = effect(WC);
  const inv = effect(INVESTING);
  const fin = effect(FINANCING);
  const sum = (xs: { v: number }[]) => xs.reduce((s, x) => s + x.v, 0);
  const operating = profit + dep - fxOnCash + sum(wc);
  const investing = sum(inv);
  const financing = sum(fin);
  const change = operating + investing + financing + fxOnCash;
  const openingCash = ctx.lines.filter((l) => opening(l) && cashIds.has(l.accountId)).reduce((s, l) => s + l.dr - l.cr, 0);
  const closing = openingCash + change;

  const wcLabel = (a: Account, v: number) => {
    const asset = a.group === "asset";
    const word = asset ? (v >= 0 ? "Decrease" : "Increase") : v >= 0 ? "Increase" : "Decrease";
    return `${word} in ${lowerFirst(a.name)}`;
  };
  const line = (x: { a: Account; v: number }, label?: string) => makeLine(ctx, `acc:${x.a.id}`, label ?? x.a.name, x.v, { accountId: x.a.id, code: x.a.code, depth: 1 });

  return {
    closing,
    sections: [
      {
        title: "Operating activities",
        lines: [
          makeLine(ctx, "cf:profit", "Net profit for the period", profit, { depth: 1 }),
          ...(dep ? [makeLine(ctx, "cf:dep", "Add back: depreciation", dep, { depth: 1, accountId: "acc-1590" })] : []),
          ...(fxOnCash ? [makeLine(ctx, "cf:fx-adj", "Less: unrealised exchange gain on cash", -fxOnCash, { depth: 1 })] : []),
          ...wc.map((x) => line(x, wcLabel(acc(x.a.id), x.v))),
          makeLine(ctx, "sub:operating", "Net cash from operating activities", operating, { isSubtotal: true }),
        ],
      },
      {
        title: "Investing activities",
        lines: [...inv.map((x) => line(x, x.v < 0 ? `Purchase of ${lowerFirst(x.a.name)}` : `Sale of ${lowerFirst(x.a.name)}`)), makeLine(ctx, "sub:investing", "Net cash from investing activities", investing, { isSubtotal: true })],
      },
      {
        title: "Financing activities",
        lines: [...fin.map((x) => line(x)), makeLine(ctx, "sub:financing", "Net cash from financing activities", financing, { isSubtotal: true })],
      },
      {
        title: "Cash position",
        lines: [
          makeLine(ctx, "cf:fx", "Effect of exchange rate changes on cash", fxOnCash),
          makeLine(ctx, "cf:change", change >= 0 ? "Net increase in cash" : "Net decrease in cash", change, { isSubtotal: true }),
          makeLine(ctx, "cf:open", "Cash and bank at the start of the period", openingCash),
          makeLine(ctx, "cf:close", "Cash and bank at the end of the period", closing, { isTotal: true }),
        ],
      },
    ],
    checks: [check(ctx, "Closing cash must equal cash and bank on the balance sheet", ["Closing cash (cash flow)", closing], ["Cash and bank (balance sheet)", bs.cash])],
  };
}

/* ======================= Changes in equity ======================= */

export function equityStatement(ctx: BuildContext, from: number, to: number, bs: BsResult): Built {
  const inPeriod = (l: FlatLine) => l.time >= from && l.time <= to && l.source !== "opening";
  const opening = (l: FlatLine) => l.time <= to && (l.time < from || l.source === "opening");
  const eqIds = new Set(ctx.accounts.filter((a) => a.group === "equity" || PL(a)).map((a) => a.id));
  const openingEquity = -ctx.lines.filter((l) => opening(l) && eqIds.has(l.accountId)).reduce((s, l) => s + l.dr - l.cr, 0);
  const delta = netMap(ctx.lines, inPeriod);
  const byKind = (k: AccountKind) => ctx.accounts.filter((a) => a.kind === k).reduce((s, a) => s - (delta.get(a.id) ?? 0), 0);
  const profit = profitOf(ctx, inPeriod);
  const oci = byKind("oci_reserve");
  const shares = byKind("share_capital");
  const dividends = byKind("dividends");
  const other = byKind("retained_earnings");
  const closing = openingEquity + profit + oci + shares + dividends + other;
  return {
    sections: [
      {
        title: "Movements",
        lines: [
          makeLine(ctx, "eq:open", "Equity at the start of the period", openingEquity, { isSubtotal: true }),
          makeLine(ctx, "eq:profit", "Profit for the period", profit, { depth: 1 }),
          makeLine(ctx, "eq:oci", "Other comprehensive income", oci, { depth: 1, accountId: "acc-3500" }),
          makeLine(ctx, "eq:tci", "Total comprehensive income", profit + oci, { isSubtotal: true }),
          makeLine(ctx, "eq:shares", "Shares issued", shares, { depth: 1, accountId: "acc-3100" }),
          makeLine(ctx, "eq:div", "Dividends", dividends, { depth: 1, accountId: "acc-3400" }),
          ...(Math.abs(other) >= 0.005 ? [makeLine(ctx, "eq:other", "Other movements in retained earnings", other, { depth: 1, accountId: "acc-3200" })] : []),
          makeLine(ctx, "eq:close", "Equity at the end of the period", closing, { isTotal: true }),
        ],
      },
    ],
    checks: [check(ctx, "Closing equity must equal equity on the balance sheet", ["Closing equity (this statement)", closing], ["Total equity (balance sheet)", bs.equity])],
  };
}

/* ======================= Comprehensive income ======================= */

export function comprehensiveIncome(ctx: BuildContext, from: number, to: number): Built {
  const inPeriod = (l: FlatLine) => l.time >= from && l.time <= to && l.source !== "opening";
  const profit = profitOf(ctx, inPeriod);
  const delta = netMap(ctx.lines, inPeriod);
  const oci = ctx.accounts.filter((a) => a.kind === "oci_reserve").reduce((s, a) => s - (delta.get(a.id) ?? 0), 0);
  const is = incomeStatement(ctx, from, to);
  return {
    sections: [
      { title: "Profit or loss", lines: [makeLine(ctx, "ci:revenue", "Revenue", is.revenue, { depth: 1 }), makeLine(ctx, "ci:costs", "Expenses net of other income", -is.expenses, { depth: 1 }), makeLine(ctx, "ci:profit", "Net profit for the period", profit, { isSubtotal: true })] },
      {
        title: "Other comprehensive income",
        lines: [
          makeLine(ctx, "ci:oci", "Items that will not be reclassified to profit or loss", oci, { depth: 1, accountId: "acc-3500", note: oci === 0 ? "None this period: exchange differences go to profit or loss" : undefined }),
          makeLine(ctx, "ci:total", "Total comprehensive income", profit + oci, { isTotal: true }),
        ],
      },
    ],
    checks: [check(ctx, "Net profit must match the income statement", ["Net profit (this statement)", profit], ["Net profit (income statement)", is.netProfit])],
  };
}

/* ======================= Reports ======================= */

export function trialBalance(ctx: BuildContext, to: number): Built {
  const net = netMap(ctx.lines, (l) => l.time <= to);
  let dr = 0;
  let cr = 0;
  const rows: ReportRow[] = ctx.accounts
    .filter((a) => !a.isHeader && Math.abs(net.get(a.id) ?? 0) >= 0.005)
    .map((a) => {
      const v = net.get(a.id)!;
      if (v > 0) dr += v;
      else cr -= v;
      return { id: a.id, accountId: a.id, cells: { code: a.code, account: a.name, debit: v > 0 ? m2(v / ctx.divisor) : null, credit: v < 0 ? m2(-v / ctx.divisor) : null } };
    });
  rows.push({ id: "total", cells: { code: "", account: "Total", debit: m2(dr / ctx.divisor), credit: m2(cr / ctx.divisor) }, isTotal: true });
  return {
    sections: [],
    table: {
      columns: [
        { key: "code", label: "Code", kind: "mono" },
        { key: "account", label: "Account" },
        { key: "debit", label: "Debit", align: "right", kind: "money" },
        { key: "credit", label: "Credit", align: "right", kind: "money" },
      ],
      rows,
    },
    checks: [check(ctx, "Total debits must equal total credits", ["Total debits", dr], ["Total credits", cr])],
  };
}

export function generalLedger(ctx: BuildContext, accountId: string, from: number, to: number): Built {
  const a = ctx.accounts.find((x) => x.id === accountId);
  const sign = a ? naturalSign(a.group) : 1;
  const mine = ctx.lines.filter((l) => l.accountId === accountId).sort((x, y) => x.time - y.time);
  const openingBal = mine.filter((l) => l.time < from).reduce((s, l) => s + (l.dr - l.cr) * sign, 0);
  let run = openingBal;
  const rows: ReportRow[] = [
    { id: "open", cells: { date: ymd(from), number: "", description: "Opening balance", debit: null, credit: null, balance: m2(openingBal / ctx.divisor) }, tone: "muted" as const },
    ...mine
      .filter((l) => l.time >= from && l.time <= to)
      .map((l) => {
        run += (l.dr - l.cr) * sign;
        return {
          id: l.key,
          href: `/finance/ledger/${l.entryId}`,
          cells: { date: ymd(l.time), number: l.entryNumber, description: l.description, debit: l.dr ? m2(l.dr / ctx.divisor) : null, credit: l.cr ? m2(l.cr / ctx.divisor) : null, balance: m2(run / ctx.divisor) },
        };
      }),
  ];
  rows.push({ id: "close", cells: { date: ymd(to), number: "", description: "Closing balance", debit: null, credit: null, balance: m2(run / ctx.divisor) }, isTotal: true });
  return {
    sections: [],
    table: {
      columns: [
        { key: "date", label: "Date", kind: "date" },
        { key: "number", label: "Entry", kind: "mono" },
        { key: "description", label: "Description" },
        { key: "debit", label: "Debit", align: "right", kind: "money" },
        { key: "credit", label: "Credit", align: "right", kind: "money" },
        { key: "balance", label: "Balance", align: "right", kind: "money" },
      ],
      rows,
    },
    checks: [],
  };
}

const BUCKETS = [
  { key: "current", label: "Not yet due", test: (d: number) => d <= 0 },
  { key: "b30", label: "1–30 days", test: (d: number) => d >= 1 && d <= 30 },
  { key: "b60", label: "31–60 days", test: (d: number) => d >= 31 && d <= 60 },
  { key: "b90", label: "61–90 days", test: (d: number) => d >= 61 && d <= 90 },
  { key: "b90p", label: "Over 90 days", test: (d: number) => d > 90 },
];
export const AGING_BUCKETS = BUCKETS.map(({ key, label }) => ({ key, label }));

/** Outstanding invoice amounts in PKR, by age bucket, as at `to`. */
export function agingByDoc(ctx: Pick<BuildContext, "receivables" | "rateAt">, to: number) {
  return ctx.receivables
    .filter((r) => new Date(r.date).getTime() <= to && r.status !== "paid")
    .map((r) => {
      const outstanding = Number(r.total.amount) - Number(r.paid.amount);
      const pkr = r.total.currency === "USD" ? outstanding * ctx.rateAt(to) : outstanding;
      const days = Math.floor((to - new Date(r.dueDate).getTime()) / DAY);
      return { doc: r, outstanding, pkr, days, bucket: BUCKETS.find((b) => b.test(days))!.key };
    });
}

export function arAging(ctx: BuildContext, to: number): Built {
  const docs = agingByDoc(ctx, to);
  const byClient = new Map<string, Record<string, number>>();
  for (const d of docs) {
    const row = byClient.get(d.doc.clientId) ?? {};
    row[d.bucket] = (row[d.bucket] ?? 0) + d.pkr;
    row.total = (row.total ?? 0) + d.pkr;
    row.count = (row.count ?? 0) + 1;
    byClient.set(d.doc.clientId, row);
  }
  const fmt = (n?: number) => (n ? m2(n / ctx.divisor) : null);
  const rows: ReportRow[] = [...byClient].map(([clientId, r]) => ({
    id: clientId,
    tone: r.b60 || r.b90 || r.b90p ? "danger" : r.b30 ? "warning" : undefined,
    cells: { client: ctx.parties.find((p) => p.id === clientId)?.name ?? clientId, invoices: r.count, ...Object.fromEntries(BUCKETS.map((b) => [b.key, fmt(r[b.key])])), total: fmt(r.total) },
  }));
  const tot = (k: string) => docs.filter((d) => k === "total" || d.bucket === k).reduce((s, d) => s + d.pkr, 0);
  rows.push({ id: "total", isTotal: true, cells: { client: "Total", invoices: docs.length, ...Object.fromEntries(BUCKETS.map((b) => [b.key, fmt(tot(b.key))])), total: fmt(tot("total")) } });
  return {
    sections: [],
    table: {
      columns: [
        { key: "client", label: "Client" },
        { key: "invoices", label: "Invoices", align: "right", kind: "number" },
        ...BUCKETS.map((b) => ({ key: b.key, label: b.label, align: "right" as const, kind: "money" as const })),
        { key: "total", label: "Total", align: "right", kind: "money" },
      ],
      rows,
    },
    checks: [],
  };
}

export function apDue(ctx: BuildContext, to: number): Built {
  const open = ctx.bills.filter((b) => b.status !== "paid").sort((a, b) => a.dueDate.localeCompare(b.dueDate));
  const rows: ReportRow[] = open.map((b) => {
    const days = Math.floor((new Date(b.dueDate).getTime() - to) / DAY);
    const outstanding = Number(b.total.amount) - Number(b.paid.amount);
    return {
      id: b.id,
      tone: days < 0 ? "danger" : days <= 7 ? "warning" : undefined,
      cells: {
        number: b.number,
        vendor: ctx.parties.find((p) => p.id === b.vendorId)?.name ?? b.vendorId,
        description: b.description,
        due: ymd(new Date(b.dueDate)),
        when: days < 0 ? `${-days} days overdue` : days === 0 ? "Due today" : `In ${days} days`,
        outstanding: m2(outstanding / ctx.divisor),
      },
    };
  });
  rows.push({ id: "total", isTotal: true, cells: { number: "", vendor: "Total", description: "", due: "", when: "", outstanding: m2(open.reduce((s, b) => s + Number(b.total.amount) - Number(b.paid.amount), 0) / ctx.divisor) } });
  return {
    sections: [],
    table: {
      columns: [
        { key: "number", label: "Bill", kind: "mono" },
        { key: "vendor", label: "Vendor" },
        { key: "description", label: "Description" },
        { key: "due", label: "Due", kind: "date" },
        { key: "when", label: "When" },
        { key: "outstanding", label: "Outstanding", align: "right", kind: "money" },
      ],
      rows,
    },
    checks: [],
  };
}

/** Revenue, direct costs and profit per project tag; untagged costs are overheads. */
export function projectProfit(ctx: Pick<BuildContext, "lines" | "accounts" | "projects">, from: number, to: number) {
  const accounts = new Map(ctx.accounts.map((a) => [a.id, a]));
  const rows = new Map<string, { revenue: number; costs: number }>();
  for (const l of ctx.lines) {
    if (l.time < from || l.time > to) continue;
    const a = accounts.get(l.accountId);
    if (!a || !PL(a)) continue;
    const key = l.projectId ?? "_none";
    const r = rows.get(key) ?? { revenue: 0, costs: 0 };
    if (a.group === "income") r.revenue += l.cr - l.dr;
    else r.costs += l.dr - l.cr;
    rows.set(key, r);
  }
  return [...rows].map(([id, r]) => ({
    id,
    name: id === "_none" ? "Overheads (not tagged to a project)" : (ctx.projects.find((p) => p.id === id)?.name ?? id),
    client: ctx.projects.find((p) => p.id === id)?.client,
    revenue: r.revenue,
    costs: r.costs,
    profit: r.revenue - r.costs,
  }));
}

export function profitByProject(ctx: BuildContext, from: number, to: number): Built {
  const list = projectProfit(ctx, from, to).sort((a, b) => (a.id === "_none" ? 1 : b.id === "_none" ? -1 : b.profit - a.profit));
  const f = (n: number) => m2(n / ctx.divisor);
  const tot = list.reduce((s, r) => ({ revenue: s.revenue + r.revenue, costs: s.costs + r.costs }), { revenue: 0, costs: 0 });
  return {
    sections: [],
    table: {
      columns: [
        { key: "project", label: "Project" },
        { key: "client", label: "Client" },
        { key: "revenue", label: "Revenue", align: "right", kind: "money" },
        { key: "costs", label: "Direct costs", align: "right", kind: "money" },
        { key: "profit", label: "Profit", align: "right", kind: "money" },
        { key: "margin", label: "Margin", align: "right", kind: "percent" },
      ],
      rows: [
        ...list.map((r) => ({
          id: r.id,
          tone: r.profit < 0 ? ("danger" as const) : undefined,
          cells: { project: r.name, client: r.client ?? "—", revenue: f(r.revenue), costs: f(r.costs), profit: f(r.profit), margin: r.revenue ? Math.round((r.profit / r.revenue) * 100) : null },
        })),
        { id: "total", isTotal: true, cells: { project: "Net profit", client: "", revenue: f(tot.revenue), costs: f(tot.costs), profit: f(tot.revenue - tot.costs), margin: tot.revenue ? Math.round(((tot.revenue - tot.costs) / tot.revenue) * 100) : null } },
      ],
    },
    checks: [],
  };
}

export function taxPayable(ctx: BuildContext, from: number, to: number): Built {
  const f = (n: number) => m2(n / ctx.divisor);
  const rows = ctx.accounts
    .filter((a) => a.kind === "tax_payable" || a.kind === "tax_asset")
    .map((a) => {
      const sign = naturalSign(a.group);
      const mine = ctx.lines.filter((l) => l.accountId === a.id && l.time <= to);
      const opening = mine.filter((l) => l.time < from).reduce((s, l) => s + (l.dr - l.cr) * sign, 0);
      const period = mine.filter((l) => l.time >= from);
      const added = period.reduce((s, l) => s + (sign > 0 ? l.dr : l.cr), 0);
      const paid = period.reduce((s, l) => s + (sign > 0 ? l.cr : l.dr), 0);
      return { id: a.id, accountId: a.id, cells: { account: a.name, code: a.code, opening: f(opening), added: f(added), paid: f(paid), closing: f(opening + added - paid) } };
    });
  return {
    sections: [],
    table: {
      columns: [
        { key: "code", label: "Code", kind: "mono" },
        { key: "account", label: "Tax account" },
        { key: "opening", label: "Opening", align: "right", kind: "money" },
        { key: "added", label: "Withheld or charged", align: "right", kind: "money" },
        { key: "paid", label: "Paid or adjusted", align: "right", kind: "money" },
        { key: "closing", label: "Closing", align: "right", kind: "money" },
      ],
      rows,
    },
    checks: [],
  };
}

/** Attach previous-period amounts by line key. */
export function mergeCompare(cur: StatementSection[], prev: StatementSection[]) {
  const map = new Map(prev.flatMap((s) => s.lines).map((l) => [l.key, l.amount]));
  return cur.map((s) => ({ ...s, lines: s.lines.map((l) => (l.amount === "" ? l : { ...l, compareAmount: map.get(l.key) ?? "0.00" })) }));
}
