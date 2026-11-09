/**
 * Mock-mode tables and synchronous operations for Module 9.
 * api.ts wraps these in mock(); approvals.ts calls them directly.
 * Deleted when the module is connected to the NestJS API (spec §13).
 */
import { ApiError, notFound } from "@/lib/api/mock";
import { employeesTable } from "@/lib/directory";
import { uid } from "@/lib/utils";
import { table } from "@/mocks/db";
import { FIN_PROJECTS, generateLedger, seedAccounts, seedParties, type LedgerSeed } from "@/mocks/seed/ledger";
import type { Currency } from "@/types";
import {
  approverFor, balanceCheck, entryBaseTotal, flatten, inBooks, LEVEL_APPROVER_TITLE, lineTotals, m2, monthKeyOf, netByAccount,
  num, requiredLevel, round2, touchesCapitalOrLoan,
} from "./logic";
import type {
  Account, BankStatementLine, Bill, ChecklistItem, FinancePeriod, JournalEntry, JournalLine, LedgerCashLine, NewEntryInput, Party,
  ReceivableDoc, RevaluationPreview,
} from "./types";

const seed = () => table<LedgerSeed>("ledger.seed", () => [generateLedger()])[0];

export const accountsTable = () => table<Account>("ledger.accounts", seedAccounts);
export const entriesTable = () => table<JournalEntry>("ledger.entries", () => seed().entries);
export const receivablesTable = () => table<ReceivableDoc>("ledger.receivables", () => seed().receivables);
export const billsTable = () => table<Bill>("ledger.bills", () => seed().bills);
export const statementTable = () => table<BankStatementLine>("ledger.statement", () => seed().statement);
export const periodsTable = () => table<FinancePeriod>("ledger.periods", () => seed().periods);
export const ratesTable = () => table("ledger.rates", () => seed().rates);
export const partiesTable = () => table<Party>("ledger.parties", seedParties);
export const projectsList = () => FIN_PROJECTS;

const nowIso = () => new Date().toISOString();

/* ---------------- Balances ---------------- */

export function bookLines() {
  return flatten(entriesTable().filter(inBooks));
}

/** Accounts with balances (natural sign, PKR) and USD balances; header accounts roll up children. */
export function accountsWithBalances(asOf?: number): Account[] {
  const net = netByAccount(bookLines(), { to: asOf });
  const accounts = accountsTable();
  const sign = (a: Account) => (a.group === "asset" || a.group === "expense" ? 1 : -1);
  const own = new Map(accounts.map((a) => [a.id, net.get(a.id) ?? { base: 0, usd: 0 }]));
  const rollup = (id: string): number => {
    const kids = accounts.filter((a) => a.parentId === id);
    return (own.get(id)?.base ?? 0) + kids.reduce((s, k) => s + rollup(k.id), 0);
  };
  return accounts.map((a) => {
    const base = a.isHeader ? rollup(a.id) : (own.get(a.id)?.base ?? 0);
    return {
      ...a,
      balance: { amount: m2(base * sign(a)), currency: "PKR" as Currency },
      foreignBalance: a.currency === "USD" ? { amount: m2((own.get(a.id)?.usd ?? 0) * sign(a)), currency: "USD" as Currency } : undefined,
    };
  });
}

export function currentRate(): number {
  const rates = ratesTable();
  return num(rates[rates.length - 1]?.rate ?? "283");
}

/* ---------------- Periods ---------------- */

export function periodOf(dateIso: string) {
  return periodsTable().find((p) => p.month === monthKeyOf(dateIso));
}

export function isLocked(dateIso: string) {
  const p = periodOf(dateIso);
  return p?.status === "closed" || p?.status === "closing";
}

export function checklistFor(month: string): ChecklistItem[] {
  const inMonth = entriesTable().filter((e) => monthKeyOf(e.date) === month);
  const waiting = inMonth.filter((e) => e.status === "draft" || e.status === "pending_approval").length;
  const stmt = statementTable().filter((s) => monthKeyOf(s.date) === month);
  const unmatched = stmt.filter((s) => !s.matchedLineKey).length;
  const payroll = inMonth.some((e) => inBooks(e) && e.source === "payroll" && e.lines.some((l) => l.accountId === "acc-5100"));
  const reval = inMonth.some((e) => inBooks(e) && e.source === "revaluation");
  // Trial balance: debit balances must equal credit balances across all accounts.
  const nets = [...netByAccount(bookLines()).values()].map((v) => v.base);
  const tb = lineTotals([{ debit: String(nets.filter((n) => n > 0).reduce((s, n) => s + n, 0)), credit: String(-nets.filter((n) => n < 0).reduce((s, n) => s + n, 0)) }]);
  const period = periodsTable().find((p) => p.month === month);
  // A month reconciled at an earlier close (and with no new statement lines) stays reconciled.
  const historic = !!period?.closedAt && stmt.length === 0;
  return [
    { key: "entries_posted", label: "All entries posted", done: waiting === 0, detail: waiting ? `${waiting} entr${waiting === 1 ? "y is" : "ies are"} still draft or waiting for approval` : "Nothing waiting" },
    {
      key: "bank_reconciled",
      label: "Bank reconciled",
      done: !!historic || (stmt.length > 0 && unmatched === 0),
      detail: historic ? "Reconciled" : stmt.length === 0 ? "No bank statement imported yet" : unmatched ? `${unmatched} statement line${unmatched === 1 ? "" : "s"} not matched` : "Every line matched",
    },
    { key: "payroll_posted", label: "Payroll posted", done: payroll, detail: payroll ? "Salary expense is in the ledger" : "Run payroll for the month first (Payroll module)" },
    { key: "usd_revalued", label: "USD balances revalued", done: reval, detail: reval ? "Revaluation posted" : "Post the month-end revaluation" },
    { key: "trial_balance", label: "Trial balance balanced", done: Math.abs(tb.diff) < 0.01, detail: `Debits ${tb.debit.toLocaleString("en-PK")} = credits ${tb.credit.toLocaleString("en-PK")}` },
  ];
}

/* ---------------- Entries ---------------- */

export function findEntry(idOrNumber: string) {
  const e = entriesTable().find((x) => x.id === idOrNumber || x.number === idOrNumber);
  if (!e) notFound("Journal entry");
  return e;
}

function nextEntryNumber() {
  const max = entriesTable().reduce((m, e) => Math.max(m, Number(e.number.split("-").pop()) || 0), 0);
  return `JE-${new Date().getFullYear()}-${String(max + 1).padStart(4, "0")}`;
}

function route(entry: JournalEntry) {
  const accounts = accountsTable();
  const base = entryBaseTotal(entry);
  const level = requiredLevel(base, touchesCapitalOrLoan(entry.lines, accounts));
  const appr = approverFor(level, entry.createdBy, employeesTable());
  entry.baseTotal = { amount: m2(base), currency: "PKR" };
  entry.total = { amount: m2(lineTotals(entry.lines).debit), currency: entry.currency };
  entry.requiredApproverLevel = level;
  entry.approverEmpId = appr.empId;
  entry.chain = [
    { label: "Prepared by", empId: entry.createdBy, state: entry.status === "draft" ? "waiting" : "done", at: entry.status === "draft" ? undefined : entry.createdAt },
    { label: `Approved by (${LEVEL_APPROVER_TITLE[appr.level]})`, empId: appr.empId, state: entry.status === "pending_approval" ? "waiting" : inBooks(entry) ? "done" : "pending", at: entry.postedAt },
  ];
  return appr;
}

export function validateEntry(input: Pick<NewEntryInput, "date" | "lines">) {
  const check = balanceCheck(input.lines);
  if (!check.ok) throw new ApiError("validation", check.problems[0] ?? "The entry is not balanced.");
  const accounts = accountsTable();
  for (const l of input.lines) {
    const a = accounts.find((x) => x.id === l.accountId);
    if (!a || a.isHeader || !a.active) throw new ApiError("validation", `Account ${a?.code ?? l.accountId} can't take postings.`);
  }
  if (isLocked(input.date)) {
    const p = periodOf(input.date)!;
    throw new ApiError("period_closed", `${p.month} is closed. Ask the CEO or Owner to reopen it.`);
  }
}

export function saveEntry(input: NewEntryInput, by: string): JournalEntry {
  const lines = input.lines.filter((l) => num(l.debit) > 0 || num(l.credit) > 0 || l.baseDebit || l.baseCredit);
  if (input.submit) validateEntry({ ...input, lines });
  else if (isLocked(input.date)) throw new ApiError("period_closed", "That month is closed. Ask the CEO or Owner to reopen it.");
  const now = nowIso();
  let entry = input.draftId ? entriesTable().find((e) => e.id === input.draftId) : undefined;
  if (entry && entry.status !== "draft") throw new ApiError("validation", "Only drafts can be edited. Posted entries are corrected with a reversing entry.");
  if (!entry) {
    entry = {
      id: uid("je"),
      number: nextEntryNumber(),
      date: input.date,
      description: input.description,
      source: input.source ?? "manual",
      projectId: input.projectId || undefined,
      currency: input.currency,
      exchangeRate: input.currency === "PKR" ? "1" : input.exchangeRate,
      lines: [],
      total: { amount: "0.00", currency: input.currency },
      baseTotal: { amount: "0.00", currency: "PKR" },
      status: "draft",
      requiredApproverLevel: 3,
      createdBy: by,
      createdAt: now,
      chain: [],
      attachments: input.attachments ?? [],
      history: [{ at: now, by, action: "created" }],
    };
    entriesTable().unshift(entry);
  } else {
    Object.assign(entry, {
      date: input.date,
      description: input.description,
      projectId: input.projectId || undefined,
      currency: input.currency,
      exchangeRate: input.currency === "PKR" ? "1" : input.exchangeRate,
      attachments: input.attachments ?? entry.attachments,
    });
    entry.history.push({ at: now, by, action: "edited" });
  }
  entry.lines = lines.map((l) => ({ ...l, id: uid("ln") }));
  entry.rejectionNote = undefined;
  if (input.submit) {
    entry.status = "pending_approval";
    entry.history.push({ at: now, by, action: "submitted" });
  }
  const appr = route(entry);
  if (input.submit && appr.routedUp) entry.history.push({ at: now, by, action: "routed_up", note: `You can't approve your own entry, so it goes to the ${LEVEL_APPROVER_TITLE[appr.level]}.` });
  return entry;
}

export function submitEntry(id: string, by: string) {
  const e = findEntry(id);
  if (e.status !== "draft") throw new ApiError("validation", "Only drafts can be submitted.");
  validateEntry(e);
  e.status = "pending_approval";
  e.rejectionNote = undefined;
  e.history.push({ at: nowIso(), by, action: "submitted" });
  route(e);
}

export function approveEntry(id: string, by: string) {
  const e = findEntry(id);
  if (e.status !== "pending_approval") throw new ApiError("validation", "This entry isn't waiting for approval.");
  if (e.createdBy === by) throw new ApiError("forbidden", "You prepared this entry, so you can't approve it.", 403);
  if (isLocked(e.date)) throw new ApiError("period_closed", "The entry's month is closed.");
  const now = nowIso();
  e.status = "posted";
  e.postedAt = now;
  e.history.push({ at: now, by, action: "approved" }, { at: now, by, action: "posted" });
  route(e);
  e.chain[1] = { ...e.chain[1], empId: by, state: "done", at: now };
  if (e.reversalOf) {
    const orig = entriesTable().find((x) => x.id === e.reversalOf);
    if (orig) {
      orig.status = "reversed";
      orig.reversedBy = e.id;
      orig.history.push({ at: now, by, action: "reversed", note: `Reversed by ${e.number}` });
    }
  }
  // Bank statement lines created from "missing in ledger" get matched automatically.
  statementTable().forEach((s) => {
    if (s.suggestion === `entry:${e.id}`) {
      const line = e.lines.find((l) => l.accountId === s.bankAccountId);
      if (line) s.matchedLineKey = `${e.id}:${line.id}`;
    }
  });
}

export function rejectEntry(id: string, by: string, reason: string) {
  const e = findEntry(id);
  if (e.status !== "pending_approval") throw new ApiError("validation", "This entry isn't waiting for approval.");
  e.status = "draft";
  e.rejectionNote = reason;
  e.history.push({ at: nowIso(), by, action: "rejected", note: reason });
  route(e);
}

/** A mistake is fixed with a reversing entry (plan §13). Creates a linked reversing DRAFT. */
export function reverseEntry(id: string, by: string, reason: string): JournalEntry {
  const e = findEntry(id);
  if (e.status !== "posted") throw new ApiError("validation", "Only posted entries can be reversed.");
  if (entriesTable().some((x) => x.reversalOf === e.id && x.status !== "reversed")) throw new ApiError("validation", "A reversal for this entry already exists.");
  const lines: Omit<JournalLine, "id">[] = e.lines.map((l) => ({
    accountId: l.accountId,
    description: l.description,
    debit: l.credit,
    credit: l.debit,
    baseDebit: l.baseCredit,
    baseCredit: l.baseDebit,
    partyId: l.partyId,
    empId: l.empId,
  }));
  const today = nowIso();
  // The reversal is dated today: the original month may already be closed.
  const r = saveEntry(
    { date: today, description: `Reversal of ${e.number}: ${reason}`, currency: e.currency, exchangeRate: e.exchangeRate, lines, projectId: e.projectId, source: "reversal", submit: false },
    by,
  );
  r.reversalOf = e.id;
  r.history.push({ at: today, by, action: "created", note: `Reverses ${e.number}` });
  return r;
}

/**
 * Spreadsheet edit of a posted row (M11): never changes the posted entry. Creates a reversing
 * draft and a corrected draft for normal approval (plan §15).
 */
export function correctionFor(entryId: string, lineId: string, field: "description" | "debit" | "credit", value: string, by: string) {
  const e = findEntry(entryId);
  const reversal = reverseEntry(e.id, by, `correcting ${field} on line`);
  const lines = e.lines.map((l) => {
    const copy: Omit<JournalLine, "id"> = { ...l };
    if (l.id === lineId) {
      if (field === "description") copy.description = value;
      else copy[field] = m2(num(value));
    }
    return copy;
  });
  // Rebalance a simple two-line entry so the corrected draft can be submitted after review.
  if (field !== "description" && lines.length === 2) {
    const other = lines.find((_, i) => e.lines[i].id !== lineId)!;
    const changed = lines.find((_, i) => e.lines[i].id === lineId)!;
    if (num(changed.debit) > 0) other.credit = changed.debit;
    else other.debit = changed.credit;
    delete other.baseDebit;
    delete other.baseCredit;
    delete changed.baseDebit;
    delete changed.baseCredit;
  }
  const corrected = saveEntry({ date: nowIso(), description: `Corrected copy of ${e.number}`, currency: e.currency, exchangeRate: e.exchangeRate, lines, projectId: e.projectId, submit: false }, by);
  return { reversal, corrected };
}

/* ---------------- Bank reconciliation ---------------- */

export function cashLines(bankAccountId: string, month: string): LedgerCashLine[] {
  const matched = new Set(statementTable().map((s) => s.matchedLineKey).filter(Boolean));
  return bookLines()
    .filter((l) => l.accountId === bankAccountId && monthKeyOf(l.date) === month)
    .map((l) => ({ key: l.key, entryId: l.entryId, entryNumber: l.entryNumber, date: l.date, description: l.description, amount: m2(l.dr - l.cr), matched: matched.has(l.key) }));
}

export function suggestMatches(bankAccountId: string, month: string) {
  const lines = cashLines(bankAccountId, month).filter((l) => !l.matched);
  const used = new Set<string>();
  for (const s of statementTable().filter((x) => x.bankAccountId === bankAccountId && monthKeyOf(x.date) === month && !x.matchedLineKey)) {
    const cand = lines.find(
      (l) => !used.has(l.key) && Math.abs(num(l.amount) - num(s.amount)) < 0.01 && Math.abs(new Date(l.date).getTime() - new Date(s.date).getTime()) <= 4 * 86_400_000,
    );
    if (cand) {
      used.add(cand.key);
      s.suggestion = cand.key;
    } else if (!s.suggestion?.startsWith("entry:")) s.suggestion = undefined;
  }
}

/* ---------------- Revaluation and close ---------------- */

export function revaluationPreview(month: string, rate: number): RevaluationPreview {
  const net = netByAccount(bookLines());
  const rows = accountsTable()
    .filter((a) => a.currency === "USD" && !a.isHeader)
    .map((a) => {
      const n = net.get(a.id) ?? { base: 0, usd: 0 };
      const revalued = round2(n.usd * rate);
      return { accountId: a.id, foreign: m2(n.usd), bookBase: m2(n.base), revaluedBase: m2(revalued), difference: m2(revalued - n.base) };
    });
  return { month, rate: rate.toFixed(2), rows, total: m2(rows.reduce((s, r) => s + num(r.difference), 0)) };
}

export function closeMonth(month: string, by: string) {
  const p = periodsTable().find((x) => x.month === month);
  if (!p) notFound("Period");
  const list = checklistFor(month);
  const missing = list.filter((c) => !c.done);
  if (missing.length) throw new ApiError("validation", `Finish the checklist first: ${missing.map((m) => m.label.toLowerCase()).join(", ")}.`);
  p.status = "closing";
  p.closedBy = by;
  p.closedAt = nowIso();
  p.approvedBy = undefined;
  p.approvedAt = undefined;
}

export function approveClose(month: string, by: string) {
  const p = periodsTable().find((x) => x.month === month);
  if (!p || p.status !== "closing") throw new ApiError("validation", "This month isn't waiting for close approval.");
  if (p.closedBy === by) throw new ApiError("forbidden", "You ran the close, so another person must approve it.", 403);
  p.status = "closed";
  p.approvedBy = by;
  p.approvedAt = nowIso();
}

export function rejectClose(month: string, by: string, reason: string) {
  const p = periodsTable().find((x) => x.month === month);
  if (!p) notFound("Period");
  p.status = "open";
  p.reopenReason = `Close sent back by ${by}: ${reason}`;
}

export function reopenMonth(month: string, by: string, reason: string) {
  const p = periodsTable().find((x) => x.month === month);
  if (!p || p.status !== "closed") throw new ApiError("validation", "Only a closed month can be reopened.");
  p.status = "reopened";
  p.reopenReason = `${reason} (reopened by ${by})`;
}

export function partyBalances(): Party[] {
  const lines = bookLines();
  return partiesTable().map((p) => {
    const rel = lines.filter((l) => l.partyId === p.id && (l.accountId === "acc-1210" || l.accountId === "acc-1220" || l.accountId === "acc-2100"));
    const net = rel.reduce((s, l) => s + l.dr - l.cr, 0);
    return { ...p, balance: { amount: m2(p.kind === "client" ? net : -net), currency: "PKR" } };
  });
}
