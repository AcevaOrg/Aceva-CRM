/**
 * Module 13 against the REAL API (NEXT_PUBLIC_LIVE_MODULES contains m13). Same function names and result shapes as the
 * mock in api.ts, so the screens keep working. The server decides everything: statuses (paid only from POSTED payments),
 * who may do what, the ledger entries (Module 9) and the reminders. Money stays a decimal string from the server.
 */
import type {
  BillingCustomerView, BillingInvoiceDetailView, BillingInvoiceView, BillingOverviewView, BillingPaymentView, BillingSettings, DealHandoverView, ModuleSettingsView,
  Page, RecurringRuleView, RenewalEventView, SubscriptionView,
} from "@aceva/contracts";
import { http } from "@/lib/api/http";
import { getViewer } from "@/lib/auth/viewer";
import { isoDay } from "@/lib/dates";
import type { Currency, Money } from "@/types";
import { PAYMENT_METHOD, setUsdRate, USD_TO_PKR } from "./logic";
import type {
  BankAccountOption, BillingOverview, Customer, CustomerSummary, DealHandover, Invoice, InvoiceDetail, NewCustomerInput, NewInvoiceInput, Payment, PaymentMethod,
  RecordPaymentInput, RecurringRule, RenewalDecision, Subscription, SubscriptionCost, SubscriptionCostInput,
} from "./types";

const M = (amount: string, currency: Currency): Money => ({ amount, currency });
const day = (iso: string | undefined) => (iso ? (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? iso : isoDay(new Date(iso))) : undefined);
const uuid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`);

export function mapInvoice(v: BillingInvoiceView): Invoice {
  const c = v.currency;
  return {
    id: v.id,
    number: v.number,
    customerId: v.partyId,
    type: v.kind,
    period: v.period ?? undefined,
    periodStart: v.periodStart ?? undefined,
    periodEnd: v.periodEnd ?? undefined,
    issueDate: v.issueDate,
    dueDate: v.dueDate,
    termsDays: v.termsDays ?? 0,
    currency: c,
    lines: v.lines.map((l) => ({ id: `${v.id}-${l.lineNo}`, description: l.description, qty: Number(l.quantity), rate: l.unitPrice })),
    subtotal: M(v.total, c),
    tax: M("0.00", c), // no sales tax on invoices (decision D13)
    total: M(v.total, c),
    paid: M(v.paid, c),
    balance: M(v.balance, c),
    pendingPayments: M(v.pendingPayments, c),
    status: v.status === "issued" ? "sent" : v.status,
    reminders: v.reminderOffsets.map((offsetDays) => ({ offsetDays })),
    source: v.sourceDealNumber ? { kind: "deal", dealId: v.sourceDealNumber, dealNumber: v.sourceDealNumber, ownerEmpId: v.sourceDealOwnerEmpId ?? "" } : undefined,
    ledgerEntryNumber: v.entryNumber ?? undefined,
    ledgerEntryStatus: v.entryStatus ?? undefined,
    cancelEntryNumber: v.cancelEntryNumber ?? undefined,
    cancelEntryStatus: v.cancelEntryStatus ?? undefined,
    notes: v.notes ?? undefined,
    createdBy: v.createdByEmpId ?? "",
    createdAt: v.createdAt,
    sentAt: v.issuedAt ?? undefined,
    emailedAt: v.emailedAt ?? undefined,
    assignedTo: v.assignedToEmpId ?? undefined,
    recurringRuleId: v.recurringRuleId ?? undefined,
    cancelReason: v.cancelReason ?? undefined,
  };
}

function mapCustomer(c: BillingCustomerView): CustomerSummary {
  return {
    id: c.id,
    name: c.name,
    contactName: c.contactName ?? "",
    email: c.email ?? "",
    country: c.country ?? "",
    currency: c.currency,
    termsDays: c.termsDays,
    address: c.address ?? "",
    taxId: c.taxId ?? undefined,
    totalBilled: M(c.totalBilled, c.currency),
    outstanding: M(c.outstanding, c.currency),
    invoiceCount: c.invoiceCount,
    lastPaymentAt: c.lastPaymentAt ?? undefined,
    needsReview: c.needsReview,
    createdFromDeal: c.createdFromDeal ?? undefined,
  };
}

function mapHandover(h: DealHandoverView): DealHandover {
  return { id: h.id, dealNumber: h.dealNumber, clientName: h.clientName, service: h.service, value: M(h.value, h.currency), ownerEmpId: h.ownerEmpId, candidates: h.candidates.map((c) => ({ id: c.id, name: c.name, email: c.email ?? undefined, country: c.country ?? undefined })), createdAt: h.createdAt };
}

function mapPayment(p: BillingPaymentView): Payment {
  return {
    id: `${p.id}:${p.invoiceId}`,
    invoiceId: p.invoiceId,
    customerId: p.partyId,
    date: p.date,
    amount: M(p.amount, p.currency),
    method: (p.method && p.method in PAYMENT_METHOD ? p.method : "other") as PaymentMethod,
    reference: p.reference ?? undefined,
    ledgerEntryNumber: p.entryNumber ?? undefined,
    ledgerEntryStatus: p.entryStatus ?? undefined,
    bankAccountName: p.bankAccountName,
    recordedBy: p.recordedByEmpId ?? "",
  };
}

function mapRule(r: RecurringRuleView): RecurringRule {
  return { id: r.id, kind: r.kind, period: r.period, total: M(r.total, r.currency), startDate: r.startDate, endDate: r.endDate ?? undefined, nextPeriodStart: r.nextPeriodStart ?? undefined, status: r.status, endReason: r.endReason ?? undefined, invoiceCount: r.invoiceCount };
}

function mapSubscription(s: SubscriptionView): Subscription {
  const latest = s.usage[s.usage.length - 1];
  const tracked = !!s.usageMetric || s.usage.length > 0;
  return {
    id: s.id,
    number: s.number,
    vendor: s.vendor,
    product: s.product,
    category: s.category,
    ownerEmpId: s.ownerEmpId,
    plan: s.plan,
    cost: M(s.cost, s.currency),
    period: s.period,
    renewalDate: s.renewalDate,
    status: s.status,
    alertDaysBefore: s.alertDaysBefore,
    seats: s.seats ?? undefined,
    notes: s.notes ?? undefined,
    usageSetup: { metric: s.usageMetric ?? undefined, unit: s.usageUnit ?? undefined, limit: s.usageLimit ? Number(s.usageLimit) : undefined },
    usage: tracked
      ? {
          metric: s.usageMetric ?? "Usage",
          used: latest ? Number(latest.used) : 0,
          limit: latest?.limit ? Number(latest.limit) : s.usageLimit ? Number(s.usageLimit) : undefined,
          unit: s.usageUnit ?? undefined,
          source: "manual",
          updatedAt: latest?.createdAt ?? s.renewalDate,
          enteredBy: latest?.enteredByEmpId ?? undefined,
          estimatedCost: latest?.estimatedCost ? M(latest.estimatedCost, s.currency) : undefined,
          trend: s.usage.map((u) => Number(u.used)),
        }
      : undefined,
    costs: s.costs.map(
      (c): SubscriptionCost => ({ id: c.id, month: c.month, amount: M(c.amount, c.currency), estimated: c.estimated, reference: c.reference ?? undefined, billId: c.billId ?? undefined, note: c.note ?? undefined, updatedAt: c.updatedAt }),
    ),
  };
}

async function subscriptions(): Promise<Subscription[]> {
  if (!USD_TO_PKR) {
    // The register total in PKR needs the latest saved USD rate (Module 9); without one, USD costs are not counted.
    const o = await http.get<BillingOverviewView>("/billing/overview").catch(() => null);
    if (o?.usdRate) setUsdRate(Number(o.usdRate));
  }
  return (await http.get<SubscriptionView[]>("/billing/subscriptions")).map(mapSubscription);
}

async function invoiceList(): Promise<Invoice[]> {
  const page = await http.get<Page<BillingInvoiceView>>("/billing/invoices", { pageSize: 200 });
  return page.items.map(mapInvoice);
}

export const liveBillingApi = {
  /** GET /billing/overview (+ GET /billing/subscriptions for renewals, when the viewer may see them) */
  overview: async (): Promise<BillingOverview> => {
    const o = await http.get<BillingOverviewView>("/billing/overview");
    if (o.usdRate) setUsdRate(Number(o.usdRate));
    const subs = getViewer().can("subscriptions.view") ? await subscriptions().catch(() => []) : [];
    const pkr = (a: string) => M(a, "PKR");
    return {
      billedThisMonth: pkr(o.billedThisMonth),
      collectedThisMonth: pkr(o.collectedThisMonth),
      outstanding: pkr(o.outstanding),
      overdueCount: o.overdueCount,
      overdueAmount: pkr(o.overdueAmount),
      upcomingDue: o.upcomingDue.map(mapInvoice),
      overdue: o.overdue.map(mapInvoice),
      renewalsSoon: subs.filter((s) => s.status === "renewing_soon"),
      draftsFromSales: o.draftsFromSales.map(mapInvoice),
      history: o.history.map((h) => ({ month: h.month, billed: Number(h.billed), collected: Number(h.collected) })),
      // The server converts each USD invoice at its own rate; 0 = say so instead of naming one rate.
      usdRate: 0,
      customerEmailsEnabled: o.customerEmailsEnabled,
      dealsNeedingClient: o.dealsNeedingClient.map(mapHandover),
      drafts: o.drafts,
    };
  },

  invoices: invoiceList,

  /** GET /billing/invoices/:id */
  invoice: async (id: string): Promise<InvoiceDetail> => {
    const d = await http.get<BillingInvoiceDetailView>(`/billing/invoices/${id}`);
    const c = mapCustomer(d.customer);
    return {
      invoice: mapInvoice(d.invoice),
      customer: c,
      payments: d.payments.map(mapPayment),
      reminders: d.reminders.map((r) => ({ id: r.id, invoiceId: d.invoice.id, offsetDays: r.offsetDays, scheduledFor: r.scheduledFor, status: r.status, sentAt: r.sentAt ?? undefined, reason: r.reason ?? undefined, audience: r.audience })),
      emails: d.emails.map((e) => ({ id: e.id, kind: e.kind, status: e.status, note: e.note ?? undefined, sentAt: e.sentAt ?? undefined, createdAt: e.createdAt })),
      recurringRule: d.recurringRule ? mapRule(d.recurringRule) : undefined,
    };
  },

  /** POST /billing/invoices (a draft), then POST /billing/invoices/:id/issue when send = true */
  create: async (input: NewInvoiceInput, send: boolean): Promise<Invoice> => {
    const d = await http.post<BillingInvoiceDetailView>("/billing/invoices", {
      requestKey: input.requestKey ?? uuid(),
      partyId: input.customerId,
      kind: input.type,
      period: input.type === "one_time" ? undefined : input.period,
      periodStart: input.type === "one_time" ? undefined : day(input.periodStart),
      periodEnd: input.type === "one_time" ? undefined : day(input.periodEnd),
      issueDate: day(input.issueDate),
      termsDays: input.termsDays,
      currency: input.currency,
      lines: input.lines.map((l) => ({ description: l.description, quantity: String(l.qty), unitPrice: Number(l.rate).toFixed(2) })),
      reminderOffsets: input.reminders.map((r) => r.offsetDays),
      notes: input.notes,
    });
    if (!send) return mapInvoice(d.invoice);
    const issued = await http.post<BillingInvoiceDetailView>(`/billing/invoices/${d.invoice.id}/issue`, {});
    return mapInvoice(issued.invoice);
  },

  /** POST /billing/invoices/:id/issue (the ledger entry is created and waits for approval) */
  send: async (id: string) => {
    await http.post(`/billing/invoices/${id}/issue`, {});
  },

  /** POST /billing/invoices/:id/cancel { reason } (an issued invoice: "confirm again" first) */
  cancel: async (id: string, reason: string) => {
    await http.post(`/billing/invoices/${id}/cancel`, { reason });
  },

  /** POST /billing/invoices/:id/payments (a Module 9 payment; counted once its entry is approved) */
  recordPayment: async (id: string, input: RecordPaymentInput): Promise<Payment> => {
    const d = await http.post<BillingInvoiceDetailView>(`/billing/invoices/${id}/payments`, {
      requestKey: input.requestKey ?? uuid(),
      bankAccountId: input.bankAccountId,
      date: day(input.date),
      amount: Number(input.amount).toFixed(2),
      method: input.method,
      reference: input.reference || undefined,
    });
    return mapPayment(d.payments[0]);
  },

  customers: async (): Promise<CustomerSummary[]> => (await http.get<BillingCustomerView[]>("/billing/customers")).map(mapCustomer),
  customerList: async (): Promise<Customer[]> => (await http.get<BillingCustomerView[]>("/billing/customers")).map(mapCustomer),
  payments: async (): Promise<Payment[]> => (await http.get<BillingPaymentView[]>("/billing/payments")).map(mapPayment),

  subscriptions,

  /** GET /billing/subscriptions/renewal-events (decisions only; alerts are not decisions) */
  renewalDecisions: async (): Promise<RenewalDecision[]> => {
    const [events, subs] = await Promise.all([http.get<RenewalEventView[]>("/billing/subscriptions/renewal-events"), subscriptions()]);
    const currency = new Map(subs.map((s) => [s.id, s.cost.currency]));
    return events
      .filter((e) => e.kind !== "alert")
      .map((e) => ({
        id: e.id,
        subscriptionId: e.subscriptionId,
        decision: e.kind as RenewalDecision["decision"],
        at: e.at,
        by: e.byEmpId ?? "",
        note: e.note ?? undefined,
        newCost: e.newCost ? M(e.newCost, currency.get(e.subscriptionId) ?? "PKR") : undefined,
      }));
  },

  /** POST /billing/subscriptions | PATCH /billing/subscriptions/:id (details only: cost, plan and renewal date change by a renewal decision) */
  saveSubscription: async (sub: Omit<Subscription, "status"> & { status?: Subscription["status"] }) => {
    const setup = {
      usageMetric: sub.usageSetup?.metric || undefined,
      usageUnit: sub.usageSetup?.unit || undefined,
      usageLimit: sub.usageSetup?.limit ? String(sub.usageSetup.limit) : undefined,
    };
    const details = { vendor: sub.vendor, product: sub.product, category: sub.category, ownerEmpId: sub.ownerEmpId, alertDaysBefore: sub.alertDaysBefore, seats: sub.seats, notes: sub.notes, ...setup };
    if (sub.id) await http.patch(`/billing/subscriptions/${sub.id}`, details);
    else await http.post("/billing/subscriptions", { ...details, plan: sub.plan, cost: sub.cost.amount, currency: sub.cost.currency, period: sub.period, renewalDate: day(sub.renewalDate) });
  },

  /** POST /billing/subscriptions/:id/renewal-decision */
  decideRenewal: async (id: string, decision: RenewalDecision["decision"], note?: string, newCost?: string) => {
    await http.post(`/billing/subscriptions/${id}/renewal-decision`, { decision, note, newCost: decision === "changed" ? newCost : undefined });
  },

  /** POST /billing/subscriptions/:id/usage (typed in; a cost on it is an estimate) */
  addUsageReading: async (id: string, used: number, estimatedCost?: string) => {
    await http.post(`/billing/subscriptions/${id}/usage`, { readingDate: isoDay(new Date()), used: String(used), estimatedCost: estimatedCost || undefined });
  },

  // ---- live only (the mock has simple stand-ins) ----

  /** PUT /billing/subscriptions/:id/costs/:month */
  setSubscriptionCost: async (id: string, input: SubscriptionCostInput) => {
    await http.put(`/billing/subscriptions/${id}/costs/${input.month}`, { amount: Number(input.amount).toFixed(2), currency: input.currency, estimated: input.estimated, reference: input.reference || undefined });
  },

  /** Module 9 bank accounts (GET /bank-accounts) for recording a payment. */
  bankAccounts: async (): Promise<BankAccountOption[]> => {
    const rows = await http.get<Array<{ id: string; code: string; name: string; currency: Currency; active: boolean }>>("/bank-accounts");
    return rows.filter((b) => b.active).map((b) => ({ id: b.id, label: `${b.code} ${b.name}`, currency: b.currency }));
  },

  /** POST /billing/invoices/:id/email */
  emailInvoice: async (id: string) => {
    await http.post(`/billing/invoices/${id}/email`, {});
  },

  /** POST /billing/invoices/:id/restore */
  restoreInvoice: async (id: string) => {
    await http.post(`/billing/invoices/${id}/restore`, {});
  },

  /** POST /billing/recurring/:id/stop */
  stopRecurring: async (id: string, reason: string) => {
    await http.post(`/billing/recurring/${id}/stop`, { reason });
  },

  /** POST /billing/customers */
  createCustomer: async (input: NewCustomerInput): Promise<Customer> =>
    mapCustomer(await http.post<BillingCustomerView>("/billing/customers", { ...input, email: input.email || undefined, contactName: input.contactName || undefined, country: input.country || undefined, address: input.address || undefined, taxId: input.taxId || undefined })),

  /** POST /billing/deal-handovers/:id/resolve: Finance chooses the client; the draft invoice is made (once) */
  resolveDealHandover: async (id: string, partyId: string) => {
    await http.post(`/billing/deal-handovers/${id}/resolve`, { partyId });
  },

  /** POST /billing/customers/:id/confirm: a client created from a Won deal is reviewed */
  confirmCustomer: async (id: string) => {
    await http.post(`/billing/customers/${id}/confirm`, {});
  },

  /** GET /settings/modules/billing */
  settings: async (): Promise<{ value: BillingSettings; version: number; updatedAt: string | null; updatedByEmpId: string | null }> => {
    const s = await http.get<ModuleSettingsView>("/settings/modules/billing");
    return { value: s.value as unknown as BillingSettings, version: s.version, updatedAt: s.updatedAt, updatedByEmpId: s.updatedByEmpId };
  },

  /** PUT /settings/modules/billing (the Director; "confirm again") */
  saveSettings: async (value: BillingSettings, version: number, reason: string) => {
    await http.put("/settings/modules/billing", { value, version, reason });
  },
};
