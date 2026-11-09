/**
 * Pure rules for Module 11: CSV import validation and small aggregations.
 */
import { balanceCheck, m2 } from "@/features/ledger/logic";
import type { Account } from "@/features/ledger/types";
import type { ImportRow } from "./types";

export const IMPORT_COLUMNS = ["ref", "date", "account", "description", "debit", "credit", "project"] as const;

export const SAMPLE_IMPORT = [
  "ref,date,account,description,debit,credit,project",
  "A1,{d1},5300,Internet top-up,15000,,",
  "A1,{d1},1120,Internet top-up,,15000,",
  "A2,{d2},5600,Facebook ads for Harbor launch,42000,,prj-harbor",
  "A2,{d2},2100,Facebook ads for Harbor launch,,40000,prj-harbor",
  "A3,{d2},5999,Team dinner,8000,,",
  "A3,{d2},1140,Team dinner,,8000,",
  "A4,{d3},5660,Stationery,3500,,",
  "A4,{d3},1140,Stationery,,3500,",
].join("\n");

/** Split one CSV line, honouring quotes. */
function splitCsv(line: string) {
  const out: string[] = [];
  let cur = "";
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') {
      if (q && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else q = !q;
    } else if (c === "," && !q) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out.map((s) => s.trim());
}

/**
 * Validate an import (plan §15): unknown account, debits ≠ credits per entry, closed month.
 * Good entries are saved as drafts for approval.
 */
export function parseImport(text: string, accounts: Account[], isClosed: (iso: string) => boolean): ImportRow[] {
  const lines = text.split(/\r?\n/).filter((l) => l.trim());
  if (!lines.length) return [];
  const header = splitCsv(lines[0]).map((h) => h.toLowerCase());
  const idx = (k: string) => header.indexOf(k);
  const rows: ImportRow[] = lines.slice(1).map((line, i) => {
    const c = splitCsv(line);
    const get = (k: string) => (idx(k) >= 0 ? (c[idx(k)] ?? "") : "");
    const code = get("account");
    const acc = accounts.find((a) => a.code === code);
    const date = get("date");
    const debit = Number(get("debit") || 0);
    const credit = Number(get("credit") || 0);
    const errors: string[] = [];
    if (!acc) errors.push(`Unknown account ${code || "(blank)"}`);
    else if (acc.isHeader) errors.push(`${code} is a header account`);
    const d = new Date(date);
    if (!date || Number.isNaN(d.getTime())) errors.push("Date isn't valid (use YYYY-MM-DD)");
    else if (isClosed(d.toISOString())) errors.push("That month is closed");
    if (Number.isNaN(debit) || Number.isNaN(credit)) errors.push("Amounts must be numbers");
    else if ((debit > 0) === (credit > 0)) errors.push("Give a debit or a credit");
    return { row: i + 2, ref: get("ref") || `row-${i + 2}`, date, accountCode: code, accountName: acc?.name, description: get("description"), debit, credit, project: get("project") || undefined, errors };
  });
  // Entry-level check: debits must equal credits per reference.
  const refs = new Set(rows.map((r) => r.ref));
  for (const ref of refs) {
    const group = rows.filter((r) => r.ref === ref);
    const check = balanceCheck(group.map((r) => ({ debit: m2(r.debit), credit: m2(r.credit), accountId: r.accountCode })));
    if (!check.balanced) group.forEach((r) => r.errors.push(`Entry ${ref}: debits ${check.debit.toLocaleString("en-PK")} ≠ credits ${check.credit.toLocaleString("en-PK")}`));
  }
  return rows;
}

export function goodEntries(rows: ImportRow[]) {
  const bad = new Set(rows.filter((r) => r.errors.length).map((r) => r.ref));
  return rows.filter((r) => !bad.has(r.ref));
}

/** % change, or null when there is nothing to compare with. */
export function pctChange(now: number, before: number): number | null {
  if (Math.abs(before) < 0.5) return null;
  return ((now - before) / Math.abs(before)) * 100;
}

export type AggFn = "sum" | "avg" | "count" | "min" | "max";
export function aggregate(values: number[], fn: AggFn) {
  if (fn === "count") return values.length;
  if (!values.length) return 0;
  if (fn === "sum") return values.reduce((a, b) => a + b, 0);
  if (fn === "avg") return values.reduce((a, b) => a + b, 0) / values.length;
  if (fn === "min") return Math.min(...values);
  return Math.max(...values);
}
