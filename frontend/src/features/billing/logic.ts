/**
 * Pure billing rules (plan §18). Mirrored on the server; unit-test these.
 */
import { addDays, differenceInCalendarDays, startOfDay } from "date-fns";
import type { BadgeTone } from "@/components/ui/badge";
import type { Currency, Money } from "@/types";
import type {
  Invoice, InvoiceLine, InvoiceStatus, InvoiceType, PaymentMethod, ReminderRule, Subscription, SubscriptionCategory,
  SubscriptionPeriod, SubscriptionStatus, BillingPeriod,
} from "./types";

/** Saved exchange rate used to show totals in PKR (Settings → Currencies). */
export const USD_TO_PKR = 280;

export const toPkr = (m: Money | { amount: string; currency: Currency }) => Number(m.amount) * (m.currency === "USD" ? USD_TO_PKR : 1);

export const round2 = (n: number) => Math.round(n * 100) / 100;
export const money = (n: number, currency: Currency): Money => ({ amount: round2(n).toFixed(2), currency });

export function lineAmount(l: Pick<InvoiceLine, "qty" | "rate">) {
  return round2((Number(l.qty) || 0) * (Number(l.rate) || 0));
}

export function lineTax(l: Pick<InvoiceLine, "qty" | "rate" | "taxRate">) {
  return round2(lineAmount(l) * ((l.taxRate ?? 0) / 100));
}

export function invoiceTotals(lines: Pick<InvoiceLine, "qty" | "rate" | "taxRate">[]) {
  const subtotal = round2(lines.reduce((s, l) => s + lineAmount(l), 0));
  const tax = round2(lines.reduce((s, l) => s + lineTax(l), 0));
  return { subtotal, tax, total: round2(subtotal + tax) };
}

/** Due date = issue date + payment terms (calendar days). */
export function dueDateFrom(issueDate: string | Date, termsDays: number) {
  const d = addDays(startOfDay(new Date(issueDate)), termsDays);
  d.setHours(17, 0, 0, 0);
  return d;
}

export function reminderLabel(offset: number) {
  if (offset === 0) return "On the due date";
  const n = Math.abs(offset);
  return `${n} day${n === 1 ? "" : "s"} ${offset < 0 ? "before" : "after"}`;
}

/** When each reminder will go out, in date order. */
export function reminderSchedule(dueDate: string | Date, rules: ReminderRule[]) {
  return [...rules]
    .sort((a, b) => a.offsetDays - b.offsetDays)
    .map((r) => {
      const d = addDays(new Date(dueDate), r.offsetDays);
      d.setHours(10, 0, 0, 0);
      return { offsetDays: r.offsetDays, date: d, label: reminderLabel(r.offsetDays) };
    });
}

export const DEFAULT_REMINDERS: ReminderRule[] = [{ offsetDays: -3 }, { offsetDays: 0 }, { offsetDays: 3 }, { offsetDays: 7 }];

/** Status from money and dates. Draft and cancelled are set by people, not computed. */
export function computeStatus(inv: Pick<Invoice, "status" | "total" | "paid" | "dueDate">, now = new Date()): InvoiceStatus {
  if (inv.status === "draft" || inv.status === "cancelled") return inv.status;
  const total = Number(inv.total.amount);
  const paid = Number(inv.paid.amount);
  if (paid >= total - 0.005) return "paid";
  if (new Date(inv.dueDate).getTime() < now.getTime()) return "overdue";
  if (paid > 0) return "part_paid";
  return "sent";
}

export function daysUntil(date: string | Date, now = new Date()) {
  return differenceInCalendarDays(new Date(date), now);
}

export function subscriptionStatus(s: Pick<Subscription, "status" | "renewalDate" | "alertDaysBefore">, now = new Date()): SubscriptionStatus {
  if (s.status === "cancelled" || s.status === "changed") return s.status;
  return daysUntil(s.renewalDate, now) <= s.alertDaysBefore ? "renewing_soon" : "active";
}

/** Monthly equivalent in PKR for the register total. */
export function monthlyCostPkr(s: Pick<Subscription, "cost" | "period" | "status">) {
  if (s.status === "cancelled") return 0;
  const pkr = toPkr(s.cost);
  const div: Record<SubscriptionPeriod, number> = { monthly: 1, quarterly: 3, yearly: 12, usage: 1 };
  return pkr / div[s.period];
}

export function usagePercent(used: number, limit?: number) {
  if (!limit) return undefined;
  return Math.round((used / limit) * 100);
}

/** Flag near-limit (≥ 80 %) or unusual (latest reading > 1.5× the earlier average). */
export function usageFlag(u?: Subscription["usage"]): "near_limit" | "unusual" | undefined {
  if (!u) return undefined;
  const pct = usagePercent(u.used, u.limit);
  if (pct !== undefined && pct >= 80) return "near_limit";
  if (u.trend && u.trend.length >= 3) {
    const prev = u.trend.slice(0, -1);
    const avgDelta = prev.slice(1).reduce((s, v, i) => s + (v - prev[i]), 0) / Math.max(1, prev.length - 1);
    const lastDelta = u.trend[u.trend.length - 1] - u.trend[u.trend.length - 2];
    if (avgDelta > 0 && lastDelta > avgDelta * 1.5) return "unusual";
  }
  return undefined;
}

/* ---------- Labels and tones ---------- */

export const INVOICE_STATUS: Record<InvoiceStatus, { label: string; tone: BadgeTone }> = {
  draft: { label: "Draft", tone: "outline" },
  sent: { label: "Sent", tone: "info" },
  part_paid: { label: "Part paid", tone: "warning" },
  paid: { label: "Paid", tone: "success" },
  overdue: { label: "Overdue", tone: "danger" },
  cancelled: { label: "Cancelled", tone: "neutral" },
};

export const INVOICE_TYPE: Record<InvoiceType, string> = { one_time: "One-time", recurring: "Recurring", rental: "Rental" };
export const PERIOD_LABEL: Record<BillingPeriod, string> = { monthly: "Monthly", quarterly: "Quarterly", yearly: "Yearly" };

export const PAYMENT_METHOD: Record<PaymentMethod, string> = {
  bank_transfer: "Bank transfer",
  cash: "Cash",
  cheque: "Cheque",
  card_provider: "Card (payment provider)",
  other: "Other",
};

export const SUB_STATUS: Record<SubscriptionStatus, { label: string; tone: BadgeTone }> = {
  active: { label: "Active", tone: "success" },
  renewing_soon: { label: "Renewing soon", tone: "warning" },
  cancelled: { label: "Cancelled", tone: "neutral" },
  changed: { label: "Changed", tone: "info" },
};

export const SUB_PERIOD: Record<SubscriptionPeriod, string> = { monthly: "per month", quarterly: "per quarter", yearly: "per year", usage: "usage-based" };

export const SUB_CATEGORY: Record<SubscriptionCategory, string> = {
  sales_tools: "Sales tools",
  domains_email: "Domains and mailboxes",
  ai: "AI assistants",
  hosting: "Hosting and storage",
  api: "APIs",
  dev_tools: "Developer tools",
  crm: "CRM",
};
