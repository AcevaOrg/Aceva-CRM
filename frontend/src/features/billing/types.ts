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
  /** Live: who the reminder is for (the client by email, the assigned staff member in the app). */
  audience?: "customer" | "staff";
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
  /** Live (Module 9): the status of the invoice's ledger entry, e.g. pending_approval until the Director approves it. */
  ledgerEntryStatus?: string;
  /** Live: the reversing entry made when a posted invoice is cancelled. */
  cancelEntryNumber?: string;
  cancelEntryStatus?: string;
  /** Live: payments recorded but still waiting for approval (not counted as paid yet). */
  pendingPayments?: Money;
  /** Live: when the invoice email reached the client's mail server. */
  emailedAt?: string;
  /** Live: the staff member reminded about it. */
  assignedTo?: string;
  recurringRuleId?: string;
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
  /** Live: created automatically from a Won deal; Finance confirms it before its invoice can be issued. */
  needsReview?: boolean;
  createdFromDeal?: string;
}

/** Live: a Won deal whose client name matched several clients: Finance chooses the right one (never chosen silently). */
export interface DealHandover {
  id: string;
  dealNumber: string;
  clientName: string;
  service: string;
  value: Money;
  ownerEmpId: string;
  candidates: { id: string; name: string; email?: string; country?: string }[];
  createdAt: string;
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
  /** Live: the payment's ledger entry status (paid only once posted). */
  ledgerEntryStatus?: string;
  bankAccountName?: string;
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
  /** Live: SUB-YYYY-NNNN. */
  number?: string;
  /** What is tracked for usage (a reading is typed in by hand: no provider API is connected). */
  usageSetup?: { metric?: string; unit?: string; limit?: number };
  /** Live: monthly cost records, newest first. */
  costs?: SubscriptionCost[];
}

/** What a subscription cost in a month: Estimated unless backed by a bill or the provider's invoice reference. */
export interface SubscriptionCost {
  id: string;
  month: string;
  amount: Money;
  estimated: boolean;
  reference?: string;
  billId?: string;
  note?: string;
  updatedAt: string;
}

export interface SubscriptionCostInput {
  month: string;
  amount: string;
  currency: Currency;
  estimated: boolean;
  reference?: string;
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
  /** 0 = USD amounts are converted at each invoice's own rate (live). */
  usdRate: number;
  /** Live: are customer emails switched on in the billing settings? */
  customerEmailsEnabled?: boolean;
  /** Live: Won deals waiting for Finance to choose their client. */
  dealsNeedingClient?: DealHandover[];
  drafts?: number;
}

export interface InvoiceDetail {
  invoice: Invoice;
  customer: Customer;
  payments: Payment[];
  reminders: ReminderEvent[];
  /** Live: emails to the client (the invoice and reminders) with their status. */
  emails?: { id: string; kind: "invoice" | "reminder"; status: string; note?: string; sentAt?: string; createdAt: string }[];
  recurringRule?: RecurringRule;
}

export interface RecurringRule {
  id: string;
  kind: "recurring" | "rental";
  period: BillingPeriod;
  total: Money;
  startDate: string;
  endDate?: string;
  nextPeriodStart?: string;
  status: "active" | "ended";
  endReason?: string;
  invoiceCount: number;
}

export interface BankAccountOption {
  id: string;
  label: string;
  currency: Currency;
}

export interface NewCustomerInput {
  name: string;
  contactName?: string;
  email?: string;
  country?: string;
  address?: string;
  currency: Currency;
  termsDays: number;
  taxId?: string;
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
  /** Live: the same key sent again (a retry, a double click) returns the same draft. */
  requestKey?: string;
}

export interface RecordPaymentInput {
  date: string;
  amount: string;
  method: PaymentMethod;
  reference?: string;
  /** Live: the Module 9 bank account it was received in. */
  bankAccountId?: string;
  /** Live: the same key sent again records nothing more. */
  requestKey?: string;
}
