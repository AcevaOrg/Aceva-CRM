/**
 * Module 10 · Financial statements and reports (plan §14)
 * Owner: Developer A (cycle 4), reviewed by Developer B and the CTO. Spec §9.10.
 * This file is the API contract for the module.
 */
import type { Currency } from "@/types";

export type StatementType =
  | "balance-sheet"
  | "income"
  | "cash-flow"
  | "equity"
  | "comprehensive"
  | "trial-balance"
  | "general-ledger"
  | "ar-aging"
  | "ap-due"
  | "profit-by-project"
  | "tax-payable";

export interface StatementLine {
  key: string;
  accountId?: string;
  code?: string;
  label: string;
  depth: number;
  amount: string;
  compareAmount?: string;
  isTotal?: boolean;
  isSubtotal?: boolean;
  note?: string;
}

export interface StatementSection {
  title: string;
  lines: StatementLine[];
}

export interface StatementCheck {
  label: string;
  left: { label: string; amount: string };
  right: { label: string; amount: string };
  pass: boolean;
}

export interface ReportColumn {
  key: string;
  label: string;
  align?: "left" | "right";
  kind?: "money" | "text" | "date" | "mono" | "number" | "percent";
}

export interface ReportRow {
  id: string;
  cells: Record<string, string | number | null>;
  accountId?: string;
  href?: string;
  tone?: "danger" | "warning" | "muted";
  isTotal?: boolean;
}

export interface ReportTable {
  columns: ReportColumn[];
  rows: ReportRow[];
}

export type StatementStatus = "draft" | "final" | "snapshot";

export interface Statement {
  type: StatementType;
  title: string;
  description: string;
  from: string;
  to: string;
  currency: Currency;
  /** PKR per USD used for display when currency is USD. */
  rate: string;
  compare?: { from: string; to: string };
  sections: StatementSection[];
  table?: ReportTable;
  checks: StatementCheck[];
  status: StatementStatus;
  snapshotAt?: string;
  finalBy?: string;
  generatedAt: string;
  /** For the general ledger: which account is shown. */
  accountId?: string;
}

export interface StatementParams {
  type: StatementType;
  /** YYYY-MM-DD (local) */
  from: string;
  to: string;
  currency: Currency;
  compare: boolean;
  accountId?: string;
}

export const STATEMENT_META: Record<StatementType, { title: string; short: string; description: string; isStatement: boolean }> = {
  "balance-sheet": { title: "Balance sheet", short: "Balance sheet", description: "Assets, liabilities and equity on one date", isStatement: true },
  income: { title: "Income statement", short: "Income statement", description: "Revenue minus expenses equals profit for the period", isStatement: true },
  "cash-flow": { title: "Cash flow statement", short: "Cash flow", description: "Cash in and out: operating, investing, financing (indirect method)", isStatement: true },
  equity: { title: "Statement of changes in equity", short: "Changes in equity", description: "Opening equity, comprehensive income, shares issued and dividends", isStatement: true },
  comprehensive: { title: "Statement of comprehensive income", short: "Comprehensive income", description: "Net profit plus other comprehensive income", isStatement: true },
  "trial-balance": { title: "Trial balance", short: "Trial balance", description: "Every account's debit or credit balance", isStatement: false },
  "general-ledger": { title: "General ledger", short: "General ledger", description: "Every posted line for one account with a running balance", isStatement: false },
  "ar-aging": { title: "Unpaid invoices by age", short: "Unpaid invoices by age", description: "What clients owe, by how late it is", isStatement: false },
  "ap-due": { title: "Bills to pay", short: "Bills to pay", description: "Unpaid vendor bills by due date", isStatement: false },
  "profit-by-project": { title: "Profit by project or client", short: "Profit by project", description: "Revenue, direct costs and margin per project", isStatement: false },
  "tax-payable": { title: "Tax payable summary", short: "Tax payable", description: "Tax withheld and collected, paid and still owed", isStatement: false },
};

export const STATEMENT_ORDER: StatementType[] = ["balance-sheet", "income", "cash-flow", "equity", "comprehensive"];
export const REPORT_ORDER: StatementType[] = ["trial-balance", "general-ledger", "ar-aging", "ap-due", "profit-by-project", "tax-payable"];
