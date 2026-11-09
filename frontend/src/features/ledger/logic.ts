/**
 * Pure accounting rules for Module 9 (plan §13, §16). Mirrored on the server; unit-test these.
 */
import type { Employee, Level } from "@/types";
import type { Account, AccountGroup, ApprovalLimit, JournalEntry, JournalLine } from "./types";

export const num = (s: string | number | undefined | null) => (s === undefined || s === null || s === "" ? 0 : Number(s));
export const m2 = (n: number) => (Math.round(n * 100) / 100).toFixed(2);
export const round2 = (n: number) => Math.round(n * 100) / 100;

/** Example limits from the plan; management sets the real amounts in Settings. */
export const APPROVAL_LIMITS: ApprovalLimit[] = [
  { level: 3, label: "Director", upTo: 50_000 },
  { level: 2, label: "CEO", upTo: 500_000 },
  { level: 1, label: "Owner", upTo: null },
];

export const LEVEL_APPROVER_TITLE: Record<number, string> = { 1: "Owner", 2: "CEO", 3: "Director" };
const LEVEL_ROLE: Record<number, Employee["role"]> = { 1: "owner", 2: "ceo", 3: "director" };

export const GROUP_LABEL: Record<AccountGroup, string> = {
  asset: "Assets",
  liability: "Liabilities",
  equity: "Equity",
  income: "Income",
  expense: "Expenses",
};
export const GROUP_CODE: Record<AccountGroup, string> = { asset: "1000", liability: "2000", equity: "3000", income: "4000", expense: "5000" };
export const GROUP_ORDER: AccountGroup[] = ["asset", "liability", "equity", "income", "expense"];

/** +1 when the account's natural balance is a debit. */
export function naturalSign(group: AccountGroup) {
  return group === "asset" || group === "expense" ? 1 : -1;
}

export function lineTotals(lines: Pick<JournalLine, "debit" | "credit">[]) {
  const debit = round2(lines.reduce((s, l) => s + num(l.debit), 0));
  const credit = round2(lines.reduce((s, l) => s + num(l.credit), 0));
  return { debit, credit, diff: round2(debit - credit) };
}

/** Debits must equal credits, there must be at least two lines, and each line has exactly one side. */
export function balanceCheck(lines: Pick<JournalLine, "debit" | "credit" | "accountId">[]) {
  const t = lineTotals(lines);
  const used = lines.filter((l) => num(l.debit) > 0 || num(l.credit) > 0);
  const problems: string[] = [];
  if (used.length < 2) problems.push("An entry needs at least two lines.");
  if (used.some((l) => num(l.debit) > 0 && num(l.credit) > 0)) problems.push("A line can have a debit or a credit, not both.");
  if (used.some((l) => !l.accountId)) problems.push("Every line needs an account.");
  if (Math.abs(t.diff) >= 0.005) problems.push(t.diff > 0 ? `Credits short by ${Math.abs(t.diff).toFixed(2)}` : `Debits short by ${Math.abs(t.diff).toFixed(2)}`);
  return { ...t, balanced: Math.abs(t.diff) < 0.005 && t.debit > 0, ok: problems.length === 0 && t.debit > 0, problems };
}

/** PKR amounts of a line (uses the override when the entry stored one). */
export function lineBase(line: JournalLine, entry: Pick<JournalEntry, "exchangeRate">) {
  const rate = num(entry.exchangeRate) || 1;
  return {
    dr: line.baseDebit !== undefined ? num(line.baseDebit) : round2(num(line.debit) * rate),
    cr: line.baseCredit !== undefined ? num(line.baseCredit) : round2(num(line.credit) * rate),
  };
}

export function entryBaseTotal(entry: Pick<JournalEntry, "lines" | "exchangeRate">) {
  return round2(entry.lines.reduce((s, l) => s + lineBase(l, entry).dr, 0));
}

/**
 * Approval level from the PKR amount (plan §13): ≤ 50,000 Director · ≤ 500,000 CEO ·
 * above, and every share-capital or loan entry, Owner.
 */
export function requiredLevel(baseAmount: number, touchesCapitalOrLoan: boolean): Level {
  if (touchesCapitalOrLoan) return 1;
  if (baseAmount <= 50_000) return 3;
  if (baseAmount <= 500_000) return 2;
  return 1;
}

export function touchesCapitalOrLoan(lines: Pick<JournalLine, "accountId">[], accounts: Account[]) {
  return lines.some((l) => {
    const a = accounts.find((x) => x.id === l.accountId);
    return a?.kind === "share_capital" || a?.kind === "loan";
  });
}

/**
 * Who approves at a level. Nobody approves their own entry: if the approver is the maker,
 * it goes one level up (plan §5).
 */
export function approverFor(level: Level, makerEmpId: string, employees: Employee[]): { empId?: string; level: Level; routedUp: boolean } {
  let l = level as number;
  let routedUp = false;
  while (l >= 1) {
    const e = employees.find((x) => x.role === LEVEL_ROLE[l] && x.status !== "left");
    if (e && e.empId !== makerEmpId) return { empId: e.empId, level: l as Level, routedUp };
    routedUp = true;
    l--;
  }
  return { level: 1, routedUp };
}

export const monthOf = (iso: string) => iso.slice(0, 7);

/** Local YYYY-MM for a Date or ISO string (seed dates are local times). */
export function monthKeyOf(d: string | Date) {
  const x = typeof d === "string" ? new Date(d) : d;
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}`;
}

export function isPostingAccount(a: Account) {
  return !a.isHeader && a.active;
}

/* ---------- Flattened posted lines and balances (used by M9, M10, M11) ---------- */

export interface FlatLine {
  key: string;
  entryId: string;
  entryNumber: string;
  date: string;
  time: number;
  accountId: string;
  /** PKR base amounts. */
  dr: number;
  cr: number;
  /** Amounts in the entry currency. */
  fdr: number;
  fcr: number;
  currency: JournalEntry["currency"];
  partyId?: string;
  empId?: string;
  projectId?: string;
  description: string;
  source: JournalEntry["source"];
  status: JournalEntry["status"];
}

/** Every line of the given entries, with PKR base amounts. */
export function flatten(entries: JournalEntry[]): FlatLine[] {
  const out: FlatLine[] = [];
  for (const e of entries) {
    for (const l of e.lines) {
      const b = lineBase(l, e);
      out.push({
        key: `${e.id}:${l.id}`,
        entryId: e.id,
        entryNumber: e.number,
        date: e.date,
        time: new Date(e.date).getTime(),
        accountId: l.accountId,
        dr: b.dr,
        cr: b.cr,
        fdr: num(l.debit),
        fcr: num(l.credit),
        currency: e.currency,
        partyId: l.partyId,
        empId: l.empId,
        projectId: e.projectId,
        description: l.description || e.description,
        source: e.source,
        status: e.status,
      });
    }
  }
  return out;
}

/** Posted (and later reversed) entries count in the books; drafts and pending entries don't. */
export const inBooks = (e: Pick<JournalEntry, "status">) => e.status === "posted" || e.status === "reversed";

/** Net debit-minus-credit per account (PKR) and in USD for USD entries, optionally within [from, to]. */
export function netByAccount(lines: FlatLine[], range: { from?: number; to?: number } = {}) {
  const map = new Map<string, { base: number; usd: number }>();
  for (const l of lines) {
    if (range.from !== undefined && l.time < range.from) continue;
    if (range.to !== undefined && l.time > range.to) continue;
    const cur = map.get(l.accountId) ?? { base: 0, usd: 0 };
    cur.base += l.dr - l.cr;
    if (l.currency === "USD") cur.usd += l.fdr - l.fcr;
    map.set(l.accountId, cur);
  }
  return map;
}

export const SOURCE_LABEL: Record<string, string> = {
  manual: "Manual",
  invoice: "Invoice",
  bill: "Bill",
  payroll: "Payroll",
  payment: "Payment",
  reversal: "Reversal",
  revaluation: "Revaluation",
  transfer: "Transfer",
  opening: "Opening balance",
};

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  pending_approval: "Pending approval",
  posted: "Posted",
  reversed: "Reversed",
};
