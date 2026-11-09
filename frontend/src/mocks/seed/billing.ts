/**
 * Seed: customers, invoices, payments, reminders, subscriptions (Module 13).
 * Invoices and payments are recorded by the finance person (ACV-0010); the Director and the CEO / Founder / Owner view them.
 * Renewal decisions and manual usage readings are the Director's (subscriptions.manage).
 * The CTO is the responsible person for technical subscriptions (hosting, domains, AI, dev tools, APIs)
 * and gets their renewal reminders, but does not see the register or its costs (no subscriptions.view).
 */
import type {
  Customer, Invoice, InvoiceLine, MonthlyBilling, Payment, ReminderEvent, ReminderRule, RenewalDecision, Subscription,
} from "@/features/billing/types";
import { computeStatus, DEFAULT_REMINDERS, invoiceTotals, money, reminderSchedule } from "@/features/billing/logic";
import type { Currency } from "@/types";
import { daysFromNow, minutesAgo, monthFromNow } from "../time";

/** The finance person: creates invoices and records payments. */
const FINANCE = "ACV-0010";

export const CUSTOMERS: Customer[] = [
  { id: "cus-northwind", name: "Northwind Studio", contactName: "James Whitaker", email: "accounts@northwindstudio.co.uk", country: "United Kingdom", currency: "USD", termsDays: 14, address: "14 Baltic Street, London EC1Y 0UJ" },
  { id: "cus-brightpath", name: "Bright Path Academy", contactName: "Saima Rehman", email: "finance@brightpath.edu.pk", country: "Pakistan", currency: "PKR", termsDays: 15, address: "Plot 22, Qasimabad, Hyderabad", taxId: "NTN 4419872-3" },
  { id: "cus-harbor", name: "Harbor & Co", contactName: "Olivia Grant", email: "olivia@harborandco.com", country: "United States", currency: "USD", termsDays: 30, address: "88 Water St, Portland, ME 04101" },
  { id: "cus-indus", name: "Indus Foods", contactName: "Arif Memon", email: "it@indusfoods.pk", country: "Pakistan", currency: "PKR", termsDays: 7, address: "SITE Area, Karachi", taxId: "NTN 3381220-1" },
  { id: "cus-crescent", name: "Crescent Clinics", contactName: "Dr. Huma Javed", email: "admin@crescentclinics.pk", country: "Pakistan", currency: "PKR", termsDays: 15, address: "Block 6, PECHS, Karachi", taxId: "NTN 5520031-8" },
  { id: "cus-maple", name: "Maple & Stone Realty", contactName: "Ethan Brooks", email: "ethan@maplestone.ca", country: "Canada", currency: "USD", termsDays: 14, address: "220 King St W, Toronto, ON" },
  { id: "cus-sindhcraft", name: "Sindh Craft Collective", contactName: "Rubina Soomro", email: "hello@sindhcraft.pk", country: "Pakistan", currency: "PKR", termsDays: 10, address: "Station Road, Dadu" },
  { id: "cus-alqasr", name: "Al Qasr Travels", contactName: "Yousef Haddad", email: "ops@alqasrtravels.ae", country: "United Arab Emirates", currency: "USD", termsDays: 14, address: "Office 1204, Bay Square, Dubai" },
];

type Seed = {
  n: number;
  customer: string;
  type: Invoice["type"];
  period?: Invoice["period"];
  issued: number;
  terms?: number;
  lines: [string, number, number][];
  tax?: number;
  paid?: number;
  status?: "draft" | "cancelled";
  source?: Invoice["source"];
  notes?: string;
  reminders?: ReminderRule[];
};

const SEEDS: Seed[] = [
  { n: 35, customer: "cus-northwind", type: "recurring", period: "quarterly", issued: -68, lines: [["Website care retainer, Q3", 1, 1500]], paid: 1500 },
  { n: 36, customer: "cus-crescent", type: "recurring", period: "monthly", issued: -40, lines: [["Clinic booking app maintenance, September", 1, 45000]], tax: 15, paid: 51750 },
  { n: 37, customer: "cus-indus", type: "rental", period: "monthly", issued: -38, lines: [["POS app rental, 6 tills", 6, 4000], ["Cloud server rental", 1, 6000]], tax: 15, paid: 34500 },
  { n: 38, customer: "cus-maple", type: "one_time", issued: -33, lines: [["Property listing website, final milestone", 1, 2400], ["Photography optimisation", 1, 300]], paid: 2700 },
  { n: 39, customer: "cus-harbor", type: "one_time", issued: -26, terms: 30, lines: [["E-commerce discovery and design sprint", 1, 3200]], paid: 3200 },
  { n: 40, customer: "cus-alqasr", type: "one_time", issued: -24, lines: [["Booking widget integration", 1, 1800]], paid: 900 },
  { n: 41, customer: "cus-sindhcraft", type: "one_time", issued: -22, terms: 10, lines: [["Online store setup", 1, 120000], ["Product photography (40 items)", 40, 750]], tax: 15 },
  { n: 42, customer: "cus-brightpath", type: "one_time", issued: -24, lines: [["LMS phase 2: quizzes and progress tracking", 1, 247826.09]], tax: 15, paid: 100000 },
  { n: 43, customer: "cus-crescent", type: "recurring", period: "monthly", issued: -10, lines: [["Clinic booking app maintenance, October", 1, 45000]], tax: 15, paid: 51750 },
  { n: 44, customer: "cus-indus", type: "rental", period: "monthly", issued: -8, lines: [["POS app rental, 6 tills", 6, 4000], ["Cloud server rental", 1, 6000]], tax: 15 },
  { n: 45, customer: "cus-northwind", type: "recurring", period: "quarterly", issued: -6, lines: [["Website care retainer, Q4", 1, 1500], ["Extra landing page", 1, 450]] },
  { n: 46, customer: "cus-harbor", type: "one_time", issued: -4, terms: 30, lines: [["E-commerce build, milestone 1 of 3", 1, 4500]] },
  { n: 47, customer: "cus-maple", type: "recurring", period: "monthly", issued: -2, lines: [["Hosting and care plan, November", 1, 180]] },
  { n: 48, customer: "cus-brightpath", type: "one_time", issued: -1, lines: [["Teacher training workshop", 2, 35000]], tax: 15 },
  { n: 49, customer: "cus-alqasr", type: "one_time", issued: -15, lines: [["Arabic language version", 1, 950]], status: "cancelled", notes: "Client postponed the Arabic site to next year." },
  { n: 50, customer: "cus-sindhcraft", type: "rental", period: "monthly", issued: 0, lines: [["Store hosting and care", 1, 15000]], tax: 15, status: "draft" },
  {
    n: 51, customer: "cus-maple", type: "one_time", issued: 0, lines: [["AI automation: lead follow-up assistant", 1, 3800]], status: "draft",
    source: { kind: "deal", dealId: "deal_19", dealNumber: "DL-0019", ownerEmpId: "ACV-0012" }, notes: "Created automatically from a Won deal. Check the scope and amount, then send.",
  },
  {
    n: 52, customer: "cus-harbor", type: "one_time", issued: 0, terms: 30, lines: [["Mobile app for Harbor & Co loyalty programme, deposit", 1, 2500]], status: "draft",
    source: { kind: "deal", dealId: "deal_17", dealNumber: "DL-0017", ownerEmpId: "ACV-0009" }, notes: "Created automatically from a Won deal.",
  },
];

const custById = (id: string) => CUSTOMERS.find((c) => c.id === id)!;

function build(s: Seed): Invoice {
  const c = custById(s.customer);
  const currency: Currency = c.currency;
  const terms = s.terms ?? c.termsDays;
  const lines: InvoiceLine[] = s.lines.map(([description, qty, rate], i) => ({ id: `ln_${s.n}_${i}`, description, qty, rate: rate.toFixed(2), taxRate: s.tax }));
  const t = invoiceTotals(lines);
  const issueDate = daysFromNow(s.issued, "11:00");
  const dueDate = daysFromNow(s.issued + terms, "17:00");
  const paid = Math.min(s.paid ?? 0, t.total);
  const base: Invoice = {
    id: `inv_${s.n}`,
    number: `INV-2026-${String(s.n).padStart(4, "0")}`,
    customerId: s.customer,
    type: s.type,
    period: s.period,
    periodStart: s.period ? issueDate : undefined,
    issueDate,
    dueDate,
    termsDays: terms,
    currency,
    lines,
    subtotal: money(t.subtotal, currency),
    tax: money(t.tax, currency),
    total: money(t.total, currency),
    paid: money(paid, currency),
    balance: money(t.total - paid, currency),
    status: s.status ?? "sent",
    reminders: s.reminders ?? DEFAULT_REMINDERS,
    source: s.source,
    ledgerEntryNumber: s.status ? undefined : `JE-2026-0${240 + s.n}`,
    notes: s.notes,
    createdBy: FINANCE,
    createdAt: daysFromNow(s.issued - 1, "16:00"),
    sentAt: s.status ? undefined : daysFromNow(s.issued, "11:05"),
    cancelReason: s.status === "cancelled" ? s.notes : undefined,
  };
  return { ...base, status: computeStatus(base) };
}

export function seedInvoices(): Invoice[] {
  return SEEDS.map(build).sort((a, b) => b.issueDate.localeCompare(a.issueDate));
}

export function seedPayments(): Payment[] {
  const out: Payment[] = [];
  let k = 0;
  for (const s of SEEDS) {
    if (!s.paid) continue;
    const inv = build(s);
    const total = Number(inv.paid.amount);
    // Split one or two payments for realism.
    const parts = s.n === 42 ? [100000] : s.n === 40 ? [900] : s.n % 3 === 0 ? [total * 0.5, total * 0.5] : [total];
    parts.forEach((amt, i) => {
      out.push({
        id: `pay_${++k}`,
        invoiceId: inv.id,
        customerId: s.customer,
        date: daysFromNow(s.issued + Math.min(inv.termsDays - 2, 5 + i * 6), "14:30"),
        amount: money(amt, inv.currency),
        method: inv.currency === "USD" ? "bank_transfer" : (["bank_transfer", "cheque", "bank_transfer"] as const)[k % 3],
        reference: inv.currency === "USD" ? `WISE-${48210 + k * 37}` : `IBFT ${7731200 + k * 911}`,
        ledgerEntryNumber: `JE-2026-0${300 + k}`,
        recordedBy: FINANCE,
      });
    });
  }
  return out.sort((a, b) => b.date.localeCompare(a.date));
}

export function seedReminders(invoices: Invoice[]): ReminderEvent[] {
  const now = Date.now();
  const out: ReminderEvent[] = [];
  for (const inv of invoices) {
    if (inv.status === "draft" || inv.status === "cancelled") continue;
    reminderSchedule(inv.dueDate, inv.reminders).forEach((r, i) => {
      const past = r.date.getTime() < now;
      const paidBefore = inv.status === "paid" && past && i > 0;
      out.push({
        id: `rem_${inv.id}_${i}`,
        invoiceId: inv.id,
        offsetDays: r.offsetDays,
        scheduledFor: r.date.toISOString(),
        status: !past ? "scheduled" : paidBefore ? "skipped" : "sent",
        sentAt: past && !paidBefore ? r.date.toISOString() : undefined,
        reason: paidBefore ? "Already paid" : undefined,
      });
    });
  }
  return out;
}

/** Billed and collected (PKR) for the 5 months before this one. */
export const BILLING_HISTORY: MonthlyBilling[] = [
  { month: monthFromNow(-5), billed: 1_420_000, collected: 1_180_000 },
  { month: monthFromNow(-4), billed: 1_610_000, collected: 1_550_000 },
  { month: monthFromNow(-3), billed: 1_380_000, collected: 1_300_000 },
  { month: monthFromNow(-2), billed: 1_920_000, collected: 1_640_000 },
  { month: monthFromNow(-1), billed: 2_140_000, collected: 1_870_000 },
];

const usd = (n: number) => money(n, "USD");
const pkr = (n: number) => money(n, "PKR");

export function seedSubscriptions(): Subscription[] {
  return [
    {
      id: "sub-apollo", vendor: "Apollo.io", product: "Sales prospecting and sequences", category: "sales_tools", ownerEmpId: "ACV-0003",
      plan: "Professional · 3 seats", seats: 3, cost: usd(297), period: "monthly", renewalDate: daysFromNow(6, "00:00"), status: "active", alertDaysBefore: 7,
      usage: { metric: "Export credits", used: 3820, limit: 6000, unit: "credits", source: "api", updatedAt: minutesAgo(14), trend: [1900, 2300, 2650, 2980, 3260, 3510, 3820] },
      notes: "Master API key used by Module 16 is changed every 3 months.",
    },
    {
      id: "sub-mv", vendor: "MillionVerifier", product: "Email verification credits", category: "sales_tools", ownerEmpId: "ACV-0003",
      plan: "50,000 credits pack", cost: usd(129), period: "usage", renewalDate: daysFromNow(9, "00:00"), status: "active", alertDaysBefore: 10,
      usage: { metric: "Credits used", used: 42550, limit: 50000, unit: "credits", source: "api", updatedAt: minutesAgo(22), trend: [28100, 30900, 33400, 35800, 37950, 40100, 42550], estimatedCost: usd(110) },
      notes: "About 9 days of credits left at this week's rate.",
    },
    {
      id: "sub-hostinger-mail", vendor: "Hostinger", product: "Business email · outreach mailboxes", category: "domains_email", ownerEmpId: "ACV-0004",
      plan: "Business Email · 6 mailboxes", seats: 6, cost: usd(215.28), period: "yearly", renewalDate: daysFromNow(47, "00:00"), status: "active", alertDaysBefore: 30,
      usage: { metric: "Mailboxes in use", used: 6, limit: 10, unit: "mailboxes", source: "manual", updatedAt: daysFromNow(-2, "10:20"), enteredBy: "ACV-0003" },
    },
    {
      id: "sub-dom-1", vendor: "Hostinger", product: "Outreach domain acevahq.com", category: "domains_email", ownerEmpId: "ACV-0004",
      plan: "Domain registration", cost: usd(11.99), period: "yearly", renewalDate: daysFromNow(12, "00:00"), status: "active", alertDaysBefore: 14,
    },
    {
      id: "sub-dom-2", vendor: "Hostinger", product: "Outreach domain tryaceva.com", category: "domains_email", ownerEmpId: "ACV-0004",
      plan: "Domain registration", cost: usd(11.99), period: "yearly", renewalDate: daysFromNow(76, "00:00"), status: "active", alertDaysBefore: 14,
    },
    {
      id: "sub-namecheap", vendor: "Namecheap", product: "acevatech.com (main domain)", category: "domains_email", ownerEmpId: "ACV-0004",
      plan: "Domain + WhoisGuard", cost: usd(15.88), period: "yearly", renewalDate: daysFromNow(38, "00:00"), status: "active", alertDaysBefore: 30,
      notes: "Auto-renew on. Losing this domain would stop every @acevatech.com mailbox.",
    },
    {
      id: "sub-claude", vendor: "Anthropic", product: "Claude Team", category: "ai", ownerEmpId: "ACV-0004",
      plan: "Team · 5 seats", seats: 5, cost: usd(150), period: "monthly", renewalDate: daysFromNow(19, "00:00"), status: "active", alertDaysBefore: 7,
      usage: { metric: "Seats used", used: 5, limit: 5, unit: "seats", source: "manual", updatedAt: daysFromNow(-6, "15:00"), enteredBy: "ACV-0003" },
    },
    {
      id: "sub-chatgpt", vendor: "OpenAI", product: "ChatGPT Team", category: "ai", ownerEmpId: "ACV-0003",
      plan: "Team · 3 seats", seats: 3, cost: usd(90), period: "monthly", renewalDate: daysFromNow(23, "00:00"), status: "active", alertDaysBefore: 7,
    },
    {
      id: "sub-salesforce", vendor: "Salesforce", product: "Sales Cloud", category: "crm", ownerEmpId: "ACV-0003",
      plan: "Not in use", cost: usd(0), period: "monthly", renewalDate: daysFromNow(-40, "00:00"), status: "cancelled", alertDaysBefore: 7,
      notes: "Not connected. Module 15 already does this job; connect only if a client requires it (plan §21).",
    },
    {
      id: "sub-vps", vendor: "Hetzner Cloud", product: "VPS for app.acevatech.com", category: "hosting", ownerEmpId: "ACV-0004",
      plan: "CPX31 · 4 vCPU, 8 GB, 160 GB", cost: usd(32.4), period: "monthly", renewalDate: daysFromNow(14, "00:00"), status: "active", alertDaysBefore: 5,
      usage: { metric: "Disk used", used: 92, limit: 160, unit: "GB", source: "api", updatedAt: minutesAgo(48), trend: [71, 74, 77, 80, 83, 86, 92] },
    },
    {
      id: "sub-r2", vendor: "Cloudflare", product: "R2 private file storage", category: "hosting", ownerEmpId: "ACV-0004",
      plan: "Pay as you go", cost: usd(4.2), period: "usage", renewalDate: daysFromNow(21, "00:00"), status: "active", alertDaysBefore: 5,
      usage: { metric: "Storage", used: 180, unit: "GB", source: "api", updatedAt: minutesAgo(65), estimatedCost: usd(4.2), trend: [140, 146, 152, 158, 165, 172, 180] },
    },
    {
      id: "sub-github", vendor: "GitHub", product: "GitHub Team", category: "dev_tools", ownerEmpId: "ACV-0004",
      plan: "Team · 4 seats", seats: 4, cost: usd(16), period: "monthly", renewalDate: daysFromNow(27, "00:00"), status: "active", alertDaysBefore: 7,
      usage: { metric: "Actions minutes", used: 2410, limit: 3000, unit: "min", source: "api", updatedAt: minutesAgo(130), trend: [800, 1100, 1350, 1600, 1820, 2010, 2410] },
    },
    {
      id: "sub-sentry", vendor: "Sentry", product: "Error monitoring", category: "dev_tools", ownerEmpId: "ACV-0004",
      plan: "Team", cost: usd(26), period: "monthly", renewalDate: daysFromNow(31, "00:00"), status: "active", alertDaysBefore: 7,
      usage: { metric: "Errors this month", used: 18400, limit: 50000, unit: "events", source: "api", updatedAt: minutesAgo(35), trend: [5200, 6100, 7000, 8100, 9300, 10500, 18400] },
    },
    {
      id: "sub-maps", vendor: "Google", product: "Maps Platform API (client projects)", category: "api", ownerEmpId: "ACV-0004",
      plan: "Pay as you go · USD 200 monthly credit", cost: pkr(0), period: "usage", renewalDate: daysFromNow(21, "00:00"), status: "active", alertDaysBefore: 5,
      usage: { metric: "Map loads", used: 21800, limit: 28000, unit: "loads", source: "manual", updatedAt: daysFromNow(-3, "12:10"), enteredBy: "ACV-0003", estimatedCost: usd(0) },
    },
  ];
}

export function seedRenewalDecisions(): RenewalDecision[] {
  return [
    { id: "rd1", subscriptionId: "sub-apollo", decision: "changed", at: daysFromNow(-24, "12:00"), by: "ACV-0003", note: "Upgraded from Basic to Professional for sequences and the dialer.", newCost: usd(297) },
    { id: "rd2", subscriptionId: "sub-salesforce", decision: "cancelled", at: daysFromNow(-40, "10:30"), by: "ACV-0003", note: "Module 15 replaces it. Avoids the Enterprise API add-on." },
    { id: "rd3", subscriptionId: "sub-github", decision: "renewed", at: daysFromNow(-3, "09:10"), by: "ACV-0003", note: "Same plan, 4 seats." },
    { id: "rd4", subscriptionId: "sub-claude", decision: "renewed", at: daysFromNow(-11, "15:20"), by: "ACV-0003" },
    { id: "rd5", subscriptionId: "sub-mv", decision: "renewed", at: daysFromNow(-30, "11:00"), by: "ACV-0003", note: "Bought a 50,000 credit pack." },
  ];
}
