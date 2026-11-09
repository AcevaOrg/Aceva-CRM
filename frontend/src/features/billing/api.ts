/**
 * Module 13 service functions. Mock today; each JSDoc names the real endpoint (spec §7.3).
 * Only approved finance or account-management roles can see or change billing (plan §18).
 */
import { ApiError, mock, notFound } from "@/lib/api/mock";
import { getViewer } from "@/lib/auth/viewer";
import type { Permission } from "@/lib/auth/permissions";
import { monthKey } from "@/lib/dates";
import { uid } from "@/lib/utils";
import { nextNumber, table } from "@/mocks/db";
import {
  BILLING_HISTORY, CUSTOMERS, seedInvoices, seedPayments, seedReminders, seedRenewalDecisions, seedSubscriptions,
} from "@/mocks/seed/billing";
import {
  computeStatus, daysUntil, dueDateFrom, invoiceTotals, money, reminderSchedule, subscriptionStatus, toPkr, USD_TO_PKR,
} from "./logic";
import type {
  BillingOverview, Customer, CustomerSummary, Invoice, InvoiceDetail, NewInvoiceInput, Payment, RecordPaymentInput,
  ReminderEvent, RenewalDecision, Subscription,
} from "./types";

const customersTable = () => table<Customer>("billing.customers", () => structuredClone(CUSTOMERS));
export const invoicesTable = () => table<Invoice>("billing.invoices", seedInvoices);
const paymentsTable = () => table<Payment>("billing.payments", seedPayments);
const remindersTable = () => table<ReminderEvent>("billing.reminders", () => seedReminders(invoicesTable()));
const subscriptionsTable = () => table<Subscription>("billing.subscriptions", seedSubscriptions);
const decisionsTable = () => table<RenewalDecision>("billing.renewal_decisions", seedRenewalDecisions);

/** Finance data returns "not found" to people without access (plan §16). */
function requireView(p: Permission, what = "Page") {
  if (!getViewer().can(p)) notFound(what);
}
function requireManage(p: Permission) {
  if (!getViewer().can(p)) throw new ApiError("forbidden", "Only finance or account-management roles can do this.", 403);
}

const fresh = (inv: Invoice): Invoice => ({ ...inv, status: computeStatus(inv) });
const freshSub = (s: Subscription): Subscription => ({ ...s, status: subscriptionStatus(s) });
const pkrMoney = (n: number) => money(n, "PKR");

function scheduleReminders(inv: Invoice) {
  const list = remindersTable();
  for (let i = list.length - 1; i >= 0; i--) if (list[i].invoiceId === inv.id && list[i].status === "scheduled") list.splice(i, 1);
  reminderSchedule(inv.dueDate, inv.reminders).forEach((r) =>
    list.push({ id: uid("rem"), invoiceId: inv.id, offsetDays: r.offsetDays, scheduledFor: r.date.toISOString(), status: "scheduled" }),
  );
}

function buildInvoice(input: NewInvoiceInput, me: string, extra: Partial<Invoice> = {}): Invoice {
  const lines = input.lines.map((l) => ({ ...l, id: uid("ln") }));
  const t = invoiceTotals(lines);
  const n = nextNumber("invoice", 52);
  const now = new Date().toISOString();
  return {
    id: uid("inv"),
    number: `INV-2026-${String(n).padStart(4, "0")}`,
    customerId: input.customerId,
    type: input.type,
    period: input.type === "one_time" ? undefined : input.period,
    periodStart: input.type === "one_time" ? undefined : input.periodStart || input.issueDate,
    periodEnd: input.type === "one_time" ? undefined : input.periodEnd || undefined,
    issueDate: input.issueDate,
    dueDate: dueDateFrom(input.issueDate, input.termsDays).toISOString(),
    termsDays: input.termsDays,
    currency: input.currency,
    lines,
    subtotal: money(t.subtotal, input.currency),
    tax: money(t.tax, input.currency),
    total: money(t.total, input.currency),
    paid: money(0, input.currency),
    balance: money(t.total, input.currency),
    status: "draft",
    reminders: input.reminders,
    notes: input.notes,
    createdBy: me,
    createdAt: now,
    ...extra,
  };
}

export const billingApi = {
  /** GET /billing/overview */
  overview: () =>
    mock<BillingOverview>(() => {
      requireView("billing.view");
      const invoices = invoicesTable().map(fresh);
      const thisMonth = monthKey();
      const open = invoices.filter((i) => ["sent", "part_paid", "overdue"].includes(i.status));
      const overdue = open.filter((i) => i.status === "overdue");
      const billed = invoices.filter((i) => i.status !== "draft" && i.status !== "cancelled" && monthKey(i.issueDate) === thisMonth).reduce((s, i) => s + toPkr(i.total), 0);
      const collected = paymentsTable().filter((p) => monthKey(p.date) === thisMonth).reduce((s, p) => s + toPkr(p.amount), 0);
      return {
        billedThisMonth: pkrMoney(billed),
        collectedThisMonth: pkrMoney(collected),
        outstanding: pkrMoney(open.reduce((s, i) => s + toPkr(i.balance), 0)),
        overdueCount: overdue.length,
        overdueAmount: pkrMoney(overdue.reduce((s, i) => s + toPkr(i.balance), 0)),
        upcomingDue: open.filter((i) => i.status !== "overdue" && daysUntil(i.dueDate) <= 14).sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
        overdue: overdue.sort((a, b) => a.dueDate.localeCompare(b.dueDate)),
        renewalsSoon: subscriptionsTable()
          .map(freshSub)
          .filter((s) => s.status !== "cancelled" && daysUntil(s.renewalDate) >= 0 && daysUntil(s.renewalDate) <= 14)
          .sort((a, b) => a.renewalDate.localeCompare(b.renewalDate)),
        draftsFromSales: invoices.filter((i) => i.status === "draft" && i.source?.kind === "deal"),
        history: [...BILLING_HISTORY, { month: thisMonth, billed, collected }],
        usdRate: USD_TO_PKR,
      };
    }),

  /** GET /invoices */
  invoices: () =>
    mock(() => {
      requireView("billing.view");
      return invoicesTable().map(fresh);
    }),

  /** GET /invoices/:id (+ customer, payments, reminders) */
  invoice: (id: string) =>
    mock<InvoiceDetail>(() => {
      requireView("billing.view");
      const inv = invoicesTable().find((i) => i.id === id || i.number === id);
      if (!inv) notFound("Invoice");
      return {
        invoice: fresh(inv),
        customer: customersTable().find((c) => c.id === inv.customerId)!,
        payments: paymentsTable().filter((p) => p.invoiceId === inv.id).sort((a, b) => a.date.localeCompare(b.date)),
        reminders: remindersTable().filter((r) => r.invoiceId === inv.id).sort((a, b) => a.scheduledFor.localeCompare(b.scheduledFor)),
      };
    }),

  /** POST /invoices (send=true → POST /invoices then /invoices/:id/send) */
  create: (input: NewInvoiceInput, send: boolean) =>
    mock(() => {
      requireManage("billing.manage");
      if (!input.lines.length || input.lines.some((l) => !l.description.trim())) throw new ApiError("validation", "Every line needs a description.");
      const inv = buildInvoice(input, getViewer().employee.empId);
      if (send) {
        inv.status = "sent";
        inv.sentAt = new Date().toISOString();
        inv.ledgerEntryNumber = `JE-2026-0${nextNumber("je-billing", 360)}`;
        inv.status = computeStatus(inv);
        scheduleReminders(inv);
      }
      invoicesTable().unshift(inv);
      return inv;
    }),

  /** POST /invoices/:id/send */
  send: (id: string) =>
    mock(() => {
      requireManage("billing.manage");
      const inv = invoicesTable().find((i) => i.id === id);
      if (!inv) notFound("Invoice");
      if (inv.status !== "draft") throw new ApiError("validation", "Only drafts can be sent.");
      inv.status = "sent";
      inv.sentAt = new Date().toISOString();
      inv.ledgerEntryNumber = `JE-2026-0${nextNumber("je-billing", 360)}`;
      inv.status = computeStatus(inv);
      scheduleReminders(inv);
    }),

  /** POST /invoices/:id/cancel { reason } */
  cancel: (id: string, reason: string) =>
    mock(() => {
      requireManage("billing.manage");
      const inv = invoicesTable().find((i) => i.id === id);
      if (!inv) notFound("Invoice");
      if (Number(inv.paid.amount) > 0) throw new ApiError("validation", "This invoice has payments. Record a credit note instead of cancelling.");
      inv.status = "cancelled";
      inv.cancelReason = reason;
      remindersTable().forEach((r) => {
        if (r.invoiceId === id && r.status === "scheduled") Object.assign(r, { status: "skipped", reason: "Invoice cancelled" });
      });
    }),

  /** POST /invoices/:id/payments */
  recordPayment: (id: string, input: RecordPaymentInput) =>
    mock(() => {
      requireManage("billing.manage");
      const inv = invoicesTable().find((i) => i.id === id);
      if (!inv) notFound("Invoice");
      const amount = Number(input.amount);
      const balance = Number(inv.balance.amount);
      if (!(amount > 0)) throw new ApiError("validation", "Enter an amount above zero.");
      if (amount > balance + 0.005) throw new ApiError("validation", `The amount is more than the balance (${inv.currency} ${balance.toFixed(2)}).`);
      const p: Payment = {
        id: uid("pay"),
        invoiceId: inv.id,
        customerId: inv.customerId,
        date: input.date,
        amount: money(amount, inv.currency),
        method: input.method,
        reference: input.reference || undefined,
        ledgerEntryNumber: `JE-2026-0${nextNumber("je-billing", 360)}`,
        recordedBy: getViewer().employee.empId,
      };
      paymentsTable().unshift(p);
      inv.paid = money(Number(inv.paid.amount) + amount, inv.currency);
      inv.balance = money(Number(inv.total.amount) - Number(inv.paid.amount), inv.currency);
      inv.status = computeStatus({ ...inv, status: "sent" });
      // No duplicate reminders for a paid invoice (plan §18).
      if (inv.status === "paid") {
        remindersTable().forEach((r) => {
          if (r.invoiceId === id && r.status === "scheduled") Object.assign(r, { status: "skipped", reason: "Already paid" });
        });
      }
      return p;
    }),

  /** GET /customers */
  customers: () =>
    mock<CustomerSummary[]>(() => {
      requireView("billing.view");
      const invoices = invoicesTable().map(fresh);
      const payments = paymentsTable();
      return customersTable().map((c) => {
        const mine = invoices.filter((i) => i.customerId === c.id && i.status !== "draft" && i.status !== "cancelled");
        const last = payments.filter((p) => p.customerId === c.id).sort((a, b) => b.date.localeCompare(a.date))[0];
        return {
          ...c,
          totalBilled: money(mine.reduce((s, i) => s + Number(i.total.amount), 0), c.currency),
          outstanding: money(mine.reduce((s, i) => s + Number(i.balance.amount), 0), c.currency),
          invoiceCount: mine.length,
          lastPaymentAt: last?.date,
        };
      });
    }),

  /** GET /customers (light list for pickers) */
  customerList: () => mock(() => customersTable(), { delay: 60 }),

  /** GET /payments */
  payments: () =>
    mock(() => {
      requireView("billing.view");
      return paymentsTable();
    }),

  /** GET /subscriptions */
  subscriptions: () =>
    mock(() => {
      requireView("subscriptions.view");
      return subscriptionsTable().map(freshSub);
    }),

  /** GET /subscriptions/renewal-decisions */
  renewalDecisions: () =>
    mock(() => {
      requireView("subscriptions.view");
      return [...decisionsTable()].sort((a, b) => b.at.localeCompare(a.at));
    }),

  /** POST /subscriptions | PATCH /subscriptions/:id */
  saveSubscription: (sub: Omit<Subscription, "status"> & { status?: Subscription["status"] }) =>
    mock(() => {
      requireManage("subscriptions.manage");
      const list = subscriptionsTable();
      const i = list.findIndex((s) => s.id === sub.id);
      const next: Subscription = { ...sub, status: sub.status ?? "active" };
      if (i >= 0) list[i] = { ...list[i], ...next };
      else list.unshift({ ...next, id: uid("sub") });
    }),

  /** POST /subscriptions/:id/renewal-decision */
  decideRenewal: (id: string, decision: RenewalDecision["decision"], note?: string, newCost?: string) =>
    mock(() => {
      requireManage("subscriptions.manage");
      const s = subscriptionsTable().find((x) => x.id === id);
      if (!s) notFound("Subscription");
      const me = getViewer().employee.empId;
      if (decision === "renewed") {
        const d = new Date(s.renewalDate);
        const months = { monthly: 1, quarterly: 3, yearly: 12, usage: 1 }[s.period];
        d.setMonth(d.getMonth() + months);
        s.renewalDate = d.toISOString();
        s.status = "active";
      }
      if (decision === "cancelled") s.status = "cancelled";
      if (decision === "changed") {
        s.status = "changed";
        if (newCost) s.cost = money(Number(newCost), s.cost.currency);
      }
      decisionsTable().unshift({
        id: uid("rd"),
        subscriptionId: id,
        decision,
        at: new Date().toISOString(),
        by: me,
        note,
        newCost: decision === "changed" && newCost ? money(Number(newCost), s.cost.currency) : undefined,
      });
    }),

  /** POST /subscriptions/:id/usage (manual reading for providers without an API) */
  addUsageReading: (id: string, used: number) =>
    mock(() => {
      requireManage("subscriptions.manage");
      const s = subscriptionsTable().find((x) => x.id === id);
      if (!s?.usage) notFound("Subscription");
      s.usage.trend = [...(s.usage.trend ?? [s.usage.used]), used].slice(-7);
      s.usage.used = used;
      s.usage.updatedAt = new Date().toISOString();
      s.usage.enteredBy = getViewer().employee.empId;
    }),
};

/**
 * Cross-module (M15 → M13): a Won deal creates a draft invoice for the finance duty person to check.
 * Live: done by the server when the sales manager confirms the deal.
 */
export function createDraftInvoiceFromDeal(input: {
  dealId: string;
  dealNumber: string;
  ownerEmpId: string;
  customerName: string;
  amount: string;
  currency: "PKR" | "USD";
  service: string;
}) {
  let customer = customersTable().find((c) => c.name.toLowerCase() === input.customerName.toLowerCase());
  if (!customer) {
    customer = { id: uid("cus"), name: input.customerName, contactName: "", email: "", country: "", currency: input.currency, termsDays: 14, address: "" };
    customersTable().push(customer);
  }
  const inv = buildInvoice(
    {
      customerId: customer.id,
      type: "one_time",
      issueDate: new Date().toISOString(),
      termsDays: customer.termsDays,
      currency: input.currency,
      lines: [{ description: input.service, qty: 1, rate: Number(input.amount).toFixed(2) }],
      reminders: [{ offsetDays: -3 }, { offsetDays: 0 }, { offsetDays: 3 }],
      notes: "Created automatically from a Won deal. Check the scope and amount, then send.",
    },
    "ACV-0010",
    { source: { kind: "deal", dealId: input.dealId, dealNumber: input.dealNumber, ownerEmpId: input.ownerEmpId } },
  );
  invoicesTable().unshift(inv);
  return inv;
}
