/**
 * Module 11 · Spreadsheet and analysis graphs (plan §15)
 * Owner: Developer B (cycle 4), reviewed by Developer C. Spec §9.11.
 * This file is the API contract for the module.
 */
import type { AccountGroup, EntrySource, EntryStatus } from "@/features/ledger/types";
import type { Currency, Money } from "@/types";

/** One ledger line as a spreadsheet row. Amounts are PKR base. */
export interface LedgerRow {
  id: string;
  entryId: string;
  lineId: string;
  date: string;
  month: string;
  entryNumber: string;
  accountId: string;
  accountCode: string;
  account: string;
  group: AccountGroup;
  description: string;
  client: string;
  project: string;
  employee: string;
  debit: number;
  credit: number;
  currency: Currency;
  exchangeRate: number;
  status: EntryStatus;
  source: EntrySource;
  /** Posted (or reversed) rows can't be changed in place. */
  locked: boolean;
}

export interface SheetFilters {
  status: EntryStatus | "all" | "in_books";
  month: string | "all";
  group: AccountGroup | "all";
  currency: Currency | "all";
}

export interface SavedView {
  id: string;
  name: string;
  filters: SheetFilters;
  /** AG Grid column filter model. */
  filterModel?: Record<string, unknown> | null;
  sort?: { colId: string; sort: "asc" | "desc" }[];
  createdBy: string;
  builtIn?: boolean;
}

export interface ImportRow {
  row: number;
  ref: string;
  date: string;
  accountCode: string;
  accountName?: string;
  description: string;
  debit: number;
  credit: number;
  project?: string;
  errors: string[];
}

export interface FinanceKpis {
  asOf: string;
  currency: Currency;
  cash: Money;
  /** % change vs the end of last month (null = nothing to compare). */
  cashDelta: number | null;
  revenue: Money;
  /** % change vs the same days last month (null = nothing to compare). */
  revenueDelta: number | null;
  expenses: Money;
  expensesDelta: number | null;
  profit: Money;
  profitDelta: number | null;
  unpaidInvoices: Money;
  unpaidCount: number;
  overdueCount: number;
}

export interface MonthlySeries {
  currency: Currency;
  /** YYYY-MM */
  months: string[];
  /** "Jun", "Jul" … */
  labels: string[];
  revenue: number[];
  expenses: number[];
  profit: number[];
  /** Cash and bank at each month end (or today for the current month). */
  cash: number[];
}

export interface InsightsParams {
  from: string;
  to: string;
  currency: Currency;
}

export interface InsightsData {
  kpis: FinanceKpis;
  series: MonthlySeries;
  expenseBreakdown: { key: string; name: string; value: number }[];
  aging: { key: string; label: string; value: number; count: number }[];
  projects: { key: string; name: string; revenue: number; costs: number; profit: number }[];
}

export type DrillKind = "revenue-month" | "expense-month" | "profit-month" | "cash-month" | "expense-account" | "aging-bucket" | "project";

export interface DrillLine {
  key: string;
  entryId?: string;
  number: string;
  date: string;
  label: string;
  description: string;
  amount: number;
}
