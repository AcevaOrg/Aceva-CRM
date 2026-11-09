/**
 * Module 13 · Customer billing, subscriptions and renewal management (plan §18)
 * Owner: Developer A (cycle 5). Spec §9.13.
 * This file is the API contract for the module.
 */
import type { Currency, Money } from "@/types";

export type InvoiceType = "one_time" | "recurring" | "rental";
export type InvoiceStatus = "draft" | "sent" | "part_paid" | "paid" | "overdue" | "cancelled";
export type BillingPeriod = "monthly" | "quarterly" | "yearly";

export interface InvoiceLine {
  id: string;
  description: string;
  qty: number;
  /** Unit rate, decimal string. */
  rate: string;
  /** Percent, e.g. 15 for Sindh sales tax on services. */
  taxRate?: number;
}

/** A reminder relative to the due date: −3 = 3 days before, 0 = on the day, 7 = 7 days after. */
export interface ReminderRule {
  offsetDays: number;
}

export interface ReminderEvent {
  id: string;
  invoiceId: string;
  offsetDays: number;
  scheduledFor: string;
  status: "scheduled" | "sent" | "skipped";
  sentAt?: string;
  reason?: string;
}

export interface Invoice {
  id: string;
  number: string;
  customerId: string;
  type: InvoiceType;
  period?: BillingPeriod;
  /** Recurring/rental: first and last period (no end = until cancelled). */
  periodStart?: string;
  periodEnd?: string;
  issueDate: string;
  dueDate: string;
  termsDays: number;
  currency: Currency;
  lines: InvoiceLine[];
  subtotal: Money;
  tax: Money;
  total: Money;
  paid: Money;
  balance: Money;
  status: InvoiceStatus;
  reminders: ReminderRule[];
  /** Draft created automatically when a deal is marked Won (M15). */
  source?: { kind: "deal"; dealId: string; dealNumber: string; ownerEmpId: string };
  ledgerEntryNumber?: string;
  notes?: string;
  createdBy: string;
  createdAt: string;
  sentAt?: string;
  cancelReason?: string;
}

export interface Customer {
  id: string;
  name: string;
  contactName: string;
  email: string;
  country: string;
  currency: Currency;
  termsDays: number;
  address: string;
  taxId?: string;
}

export interface CustomerSummary extends Customer {
  totalBilled: Money;
  outstanding: Money;
  invoiceCount: number;
  lastPaymentAt?: string;
}

export type PaymentMethod = "bank_transfer" | "cash" | "cheque" | "card_provider" | "other";

export interface Payment {
  id: string;
  invoiceId: string;
  customerId: string;
  date: string;
  amount: Money;
  method: PaymentMethod;
  reference?: string;
  ledgerEntryNumber?: string;
  recordedBy: string;
}

export type SubscriptionCategory = "sales_tools" | "domains_email" | "ai" | "hosting" | "api" | "dev_tools" | "crm";
export type SubscriptionStatus = "active" | "renewing_soon" | "cancelled" | "changed";
export type SubscriptionPeriod = "monthly" | "quarterly" | "yearly" | "usage";

export interface SubscriptionUsage {
  metric: string;
  used: number;
  limit?: number;
  unit?: string;
  source: "api" | "manual";
  updatedAt: string;
  /** Who typed the last value in, for providers without an API. */
  enteredBy?: string;
  /** Only an estimate when the provider doesn't expose exact costs. */
  estimatedCost?: Money;
  /** Last 7 readings, oldest first. */
  trend?: number[];
}

export interface Subscription {
  id: string;
  vendor: string;
  product: string;
  category: SubscriptionCategory;
  ownerEmpId: string;
  plan: string;
  cost: Money;
  period: SubscriptionPeriod;
  renewalDate: string;
  status: SubscriptionStatus;
  alertDaysBefore: number;
  seats?: number;
  usage?: SubscriptionUsage;
  notes?: string;
}

export interface RenewalDecision {
  id: string;
  subscriptionId: string;
  decision: "renewed" | "cancelled" | "changed";
  at: string;
  by: string;
  note?: string;
  newCost?: Money;
}

export interface MonthlyBilling {
  month: string;
  billed: number;
  collected: number;
}

export interface BillingOverview {
  /** All amounts in PKR; USD converted at the saved rate. */
  billedThisMonth: Money;
  collectedThisMonth: Money;
  outstanding: Money;
  overdueCount: number;
  overdueAmount: Money;
  upcomingDue: Invoice[];
  overdue: Invoice[];
  renewalsSoon: Subscription[];
  draftsFromSales: Invoice[];
  history: MonthlyBilling[];
  usdRate: number;
}

export interface InvoiceDetail {
  invoice: Invoice;
  customer: Customer;
  payments: Payment[];
  reminders: ReminderEvent[];
}

export interface NewInvoiceInput {
  customerId: string;
  type: InvoiceType;
  period?: BillingPeriod;
  periodStart?: string;
  periodEnd?: string;
  issueDate: string;
  termsDays: number;
  currency: Currency;
  lines: Omit<InvoiceLine, "id">[];
  reminders: ReminderRule[];
  notes?: string;
}

export interface RecordPaymentInput {
  date: string;
  amount: string;
  method: PaymentMethod;
  reference?: string;
}
