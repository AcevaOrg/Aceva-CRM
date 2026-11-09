/**
 * Seed: Module 9 finance ledger. Six months of balanced double-entry data (PKR base, USD with rates),
 * client invoices (AR), vendor bills (AP), a bank statement for reconciliation and finance periods.
 * Generated in date order so USD revaluation and exchange differences are computed like the real system.
 */
import type {
  Account, AccountGroup, AccountKind, BankStatementLine, Bill, EntrySource, EntryStatus, ExchangeRate, FinancePeriod,
  FinanceProject, JournalEntry, JournalLine, Party, ReceivableDoc,
} from "@/features/ledger/types";
import { approverFor, ceoNotified, CEO_NOTIFY_ABOVE, lineBase, m2, round2 } from "@/features/ledger/logic";
import type { Currency } from "@/types";
import { EMPLOYEES } from "./people";
import { dayOfMonth } from "../time";

/* ------------------------------------------------------------------ */
/* Chart of accounts                                                   */
/* ------------------------------------------------------------------ */

type AccSeed = [code: string, name: string, group: AccountGroup, kind?: AccountKind, opts?: Partial<Account>];

const ACC: AccSeed[] = [
  ["1000", "Assets", "asset", undefined, { isHeader: true }],
  ["1100", "Cash and bank", "asset", undefined, { isHeader: true, parentId: "acc-1000" }],
  ["1110", "Meezan Bank – Current", "asset", "cash", { parentId: "acc-1100", isBank: true, bankName: "Meezan Bank", bankAccountNumber: "0101-0109887412" }],
  ["1120", "HBL – Operations", "asset", "cash", { parentId: "acc-1100", isBank: true, bankName: "HBL", bankAccountNumber: "1234-7900213365" }],
  ["1130", "Payoneer – USD", "asset", "cash", { parentId: "acc-1100", isBank: true, currency: "USD", bankName: "Payoneer", bankAccountNumber: "PAYO-5521-8847-1290" }],
  ["1140", "Petty cash", "asset", "cash", { parentId: "acc-1100" }],
  ["1200", "Receivables", "asset", undefined, { isHeader: true, parentId: "acc-1000" }],
  ["1210", "Trade receivables – PKR", "asset", "receivable", { parentId: "acc-1200" }],
  ["1220", "Trade receivables – USD", "asset", "receivable", { parentId: "acc-1200", currency: "USD" }],
  ["1300", "Prepayments and advances", "asset", undefined, { isHeader: true, parentId: "acc-1000" }],
  ["1310", "Prepaid hosting and software", "asset", "prepayment", { parentId: "acc-1300" }],
  ["1320", "Salary advances", "asset", "prepayment", { parentId: "acc-1300" }],
  ["1410", "Advance income tax", "asset", "tax_asset", { parentId: "acc-1000" }],
  ["1500", "Fixed assets", "asset", undefined, { isHeader: true, parentId: "acc-1000" }],
  ["1510", "Computers and equipment", "asset", "fixed_asset", { parentId: "acc-1500" }],
  ["1520", "Office furniture", "asset", "fixed_asset", { parentId: "acc-1500" }],
  ["1590", "Accumulated depreciation", "asset", "accumulated_depreciation", { parentId: "acc-1500" }],
  ["2000", "Liabilities", "liability", undefined, { isHeader: true }],
  ["2100", "Accounts payable", "liability", "payable", { parentId: "acc-2000" }],
  ["2200", "Salary payable", "liability", "salary_payable", { parentId: "acc-2000" }],
  ["2300", "Income tax withheld (salaries)", "liability", "tax_payable", { parentId: "acc-2000" }],
  ["2310", "Sindh sales tax payable", "liability", "tax_payable", { parentId: "acc-2000" }],
  ["2400", "Accrued expenses", "liability", "accrued", { parentId: "acc-2000" }],
  ["2500", "Customer advances", "liability", "customer_advance", { parentId: "acc-2000" }],
  ["2700", "Bank loan – Meezan", "liability", "loan", { parentId: "acc-2000" }],
  ["3000", "Equity", "equity", undefined, { isHeader: true }],
  ["3100", "Share capital", "equity", "share_capital", { parentId: "acc-3000" }],
  ["3200", "Retained earnings", "equity", "retained_earnings", { parentId: "acc-3000" }],
  ["3400", "Dividends", "equity", "dividends", { parentId: "acc-3000" }],
  ["3500", "Other comprehensive income reserve", "equity", "oci_reserve", { parentId: "acc-3000" }],
  ["4000", "Income", "income", undefined, { isHeader: true }],
  ["4100", "Website development", "income", "revenue", { parentId: "acc-4000" }],
  ["4200", "Custom software", "income", "revenue", { parentId: "acc-4000" }],
  ["4300", "AI automation", "income", "revenue", { parentId: "acc-4000" }],
  ["4400", "Mobile apps", "income", "revenue", { parentId: "acc-4000" }],
  ["4500", "E-commerce stores", "income", "revenue", { parentId: "acc-4000" }],
  ["4800", "Profit on bank deposits", "income", "other_income", { parentId: "acc-4000" }],
  ["4900", "Exchange gain", "income", "fx", { parentId: "acc-4000" }],
  ["5000", "Expenses", "expense", undefined, { isHeader: true }],
  ["5100", "Salaries and allowances", "expense", "expense", { parentId: "acc-5000" }],
  ["5200", "Office rent", "expense", "expense", { parentId: "acc-5000" }],
  ["5300", "Utilities and internet", "expense", "expense", { parentId: "acc-5000" }],
  ["5400", "Hosting and cloud", "expense", "expense", { parentId: "acc-5000" }],
  ["5500", "Software subscriptions", "expense", "expense", { parentId: "acc-5000" }],
  ["5600", "Marketing and outreach", "expense", "expense", { parentId: "acc-5000" }],
  ["5650", "Staff welfare", "expense", "expense", { parentId: "acc-5000" }],
  ["5660", "Office supplies", "expense", "expense", { parentId: "acc-5000" }],
  ["5800", "Depreciation", "expense", "depreciation", { parentId: "acc-5000" }],
  ["5850", "Bank charges", "expense", "expense", { parentId: "acc-5000" }],
  ["5860", "Finance costs (loan interest)", "expense", "finance_cost", { parentId: "acc-5000" }],
  ["5900", "Exchange loss", "expense", "fx", { parentId: "acc-5000" }],
];

export function seedAccounts(): Account[] {
  return ACC.map(([code, name, group, kind, opts]) => ({
    id: `acc-${code}`,
    code,
    name,
    group,
    kind,
    currency: "PKR" as Currency,
    active: true,
    balance: { amount: "0.00", currency: "PKR" as Currency },
    ...opts,
  }));
}

/* ------------------------------------------------------------------ */
/* Clients, vendors, projects, rates                                    */
/* ------------------------------------------------------------------ */

export function seedParties(): Party[] {
  const p = (id: string, kind: "client" | "vendor", name: string, currency: Currency, country: string, email: string, contactName?: string, terms = "Net 30"): Party => ({
    id, kind, name, currency, country, email, contactName, terms, balance: { amount: "0.00", currency: "PKR" },
  });
  return [
    p("cl-northwind", "client", "Northwind Studio", "USD", "United Kingdom", "accounts@northwind.studio", "Emma Clarke"),
    p("cl-harbor", "client", "Harbor & Co", "USD", "United States", "ap@harborandco.com", "Olivia Grant"),
    p("cl-zarai", "client", "Zarai Connect FZ-LLC", "USD", "United Arab Emirates", "finance@zaraiconnect.ae", "Omar Haddad"),
    p("cl-brightpath", "client", "Bright Path Academy", "PKR", "Pakistan", "accounts@brightpath.edu.pk", "Sadia Rehman"),
    p("cl-qasim", "client", "Qasim Logistics", "PKR", "Pakistan", "finance@qasimlogistics.pk", "Qasim Ali"),
    p("vn-apollo", "vendor", "Apollo.io", "USD", "United States", "billing@apollo.io", undefined, "Card on file"),
    p("vn-millionverifier", "vendor", "MillionVerifier", "USD", "Netherlands", "billing@millionverifier.com", undefined, "Prepaid"),
    p("vn-anthropic", "vendor", "Anthropic (Claude)", "USD", "United States", "billing@anthropic.com", undefined, "Card on file"),
    p("vn-openai", "vendor", "OpenAI (ChatGPT)", "USD", "United States", "billing@openai.com", undefined, "Card on file"),
    p("vn-hostinger", "vendor", "Hostinger", "USD", "Lithuania", "billing@hostinger.com", undefined, "Card on file"),
    p("vn-pixel", "vendor", "Pixel Ads Agency", "PKR", "Pakistan", "accounts@pixelads.pk", "Faraz Ahmed"),
    p("vn-landlord", "vendor", "Dadu Properties", "PKR", "Pakistan", "rent@daduproperties.pk", "Haji Rasool"),
    p("vn-silicon", "vendor", "Silicon Plaza Computers", "PKR", "Pakistan", "sales@siliconplaza.pk", "Waqas Butt"),
    p("vn-furniture", "vendor", "Furniture Hub", "PKR", "Pakistan", "orders@furniturehub.pk"),
    p("vn-ptcl", "vendor", "PTCL and K-Electric", "PKR", "Pakistan", "corporate@ptcl.net.pk"),
  ];
}

export const FIN_PROJECTS: FinanceProject[] = [
  { id: "prj-northwind", name: "Northwind Studio website", client: "Northwind Studio" },
  { id: "prj-harbor", name: "Harbor & Co e-commerce", client: "Harbor & Co" },
  { id: "prj-zarai", name: "Zarai Connect mobile app", client: "Zarai Connect FZ-LLC" },
  { id: "prj-brightpath", name: "Bright Path Academy LMS", client: "Bright Path Academy" },
  { id: "prj-qasim", name: "Qasim Logistics automation", client: "Qasim Logistics" },
  { id: "prj-ads", name: "Aceva Digital System", client: "Internal" },
  { id: "prj-ops", name: "Operations", client: "Internal" },
];

const RATES = [279.4, 280.1, 280.9, 281.7, 282.4, 283.1];

/* ------------------------------------------------------------------ */
/* Generator                                                            */
/* ------------------------------------------------------------------ */

interface L {
  a: string;
  dr?: number;
  cr?: number;
  bdr?: number;
  bcr?: number;
  party?: string;
  emp?: string;
  desc?: string;
}

export interface LedgerSeed {
  entries: JournalEntry[];
  receivables: ReceivableDoc[];
  bills: Bill[];
  statement: BankStatementLine[];
  periods: FinancePeriod[];
  rates: ExchangeRate[];
}

const CAPITAL_OR_LOAN = new Set(["3100", "2700"]);

/** The finance person prepares every entry, runs the close and records bills (maker). */
const FINANCE = "ACV-0010";
/** The Director approves every entry and the month close (checker). */
const DIRECTOR = "ACV-0003";

function lastDayOf(offset: number) {
  const d = new Date();
  return new Date(d.getFullYear(), d.getMonth() + offset + 1, 0).getDate();
}

function addDaysIso(iso: string, days: number) {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export function generateLedger(): LedgerSeed {
  const entries: JournalEntry[] = [];
  const receivables: ReceivableDoc[] = [];
  const bills: Bill[] = [];
  let lineSeq = 0;
  let invSeq = 20;
  let billSeq = 10;
  const today = new Date();
  const todayDay = today.getDate();

  const make = (o: {
    date: string;
    desc: string;
    source: EntrySource;
    currency?: Currency;
    rate?: number;
    lines: L[];
    project?: string;
    status?: EntryStatus;
    maker?: string;
  }): JournalEntry => {
    const currency = o.currency ?? "PKR";
    const rate = currency === "PKR" ? 1 : (o.rate ?? 280);
    const lines: JournalLine[] = o.lines.map((l) => ({
      id: `ln_${++lineSeq}`,
      accountId: `acc-${l.a}`,
      description: l.desc,
      debit: m2(l.dr ?? 0),
      credit: m2(l.cr ?? 0),
      baseDebit: l.bdr !== undefined ? m2(l.bdr) : undefined,
      baseCredit: l.bcr !== undefined ? m2(l.bcr) : undefined,
      partyId: l.party,
      empId: l.emp,
    }));
    const tmp = { exchangeRate: String(rate), lines };
    const baseTotal = round2(lines.reduce((s, l) => s + lineBase(l, tmp).dr, 0));
    const total = round2(lines.reduce((s, l) => s + Number(l.debit), 0));
    const capital = o.lines.some((l) => CAPITAL_OR_LOAN.has(l.a));
    // The finance person (ACV-0010) prepares every entry; the Director approves, any amount (maker-checker).
    const maker = o.maker ?? FINANCE;
    const notify = ceoNotified(baseTotal, capital);
    const appr = approverFor(maker, EMPLOYEES);
    const approver = appr.empId ?? DIRECTOR;
    const status = o.status ?? "posted";
    const createdAt = o.date;
    const postedAt = status === "posted" || status === "reversed" ? addDaysIso(o.date, 0) : undefined;
    const e: JournalEntry = {
      id: `je_${entries.length + 1}`,
      number: "",
      date: o.date,
      description: o.desc,
      source: o.source,
      projectId: o.project,
      currency,
      exchangeRate: String(rate),
      lines,
      total: { amount: m2(total), currency },
      baseTotal: { amount: m2(baseTotal), currency: "PKR" },
      status,
      approverEmpId: appr.empId,
      ceoNotified: notify || undefined,
      createdBy: maker,
      createdAt,
      postedAt,
      chain: [
        { label: "Prepared by (Finance)", empId: maker, state: status === "draft" ? "waiting" : "done", at: status === "draft" ? undefined : createdAt },
        {
          label: "Approved by (Director)",
          empId: appr.empId,
          state: postedAt ? "done" : status === "pending_approval" ? "waiting" : "pending",
          at: postedAt,
        },
      ],
      attachments: [],
      history: [
        { at: createdAt, by: maker, action: "created" },
        ...(status !== "draft" ? [{ at: createdAt, by: maker, action: "submitted" as const }] : []),
        ...(notify && status !== "draft"
          ? [{ at: createdAt, by: maker, action: "ceo_notified" as const, note: `Above PKR ${CEO_NOTIFY_ABOVE.toLocaleString("en-PK")}, or a capital or loan entry: the CEO / Founder / Owner is notified (view only).` }]
          : []),
        ...(postedAt ? [{ at: postedAt, by: approver, action: "approved" as const }, { at: postedAt, by: approver, action: "posted" as const }] : []),
      ],
    };
    entries.push(e);
    return e;
  };

  /** Posted PKR base and USD balance of an account so far. */
  const bal = (code: string) => {
    let base = 0;
    let usd = 0;
    for (const e of entries) {
      if (e.status !== "posted" && e.status !== "reversed") continue;
      for (const l of e.lines) {
        if (l.accountId !== `acc-${code}`) continue;
        const b = lineBase(l, e);
        base += b.dr - b.cr;
        if (e.currency === "USD") usd += Number(l.debit) - Number(l.credit);
      }
    }
    return { base: round2(base), usd: round2(usd) };
  };

  /** Move USD out of an account at its book rate; the difference goes to exchange gain/loss. */
  const usdOut = (code: string, usd: number, rate: number): L[] => {
    const b = bal(code);
    const bookRate = b.usd ? b.base / b.usd : rate;
    const bookBase = round2(usd * bookRate);
    const diff = round2(usd * rate - bookBase);
    const lines: L[] = [{ a: code, cr: usd, bcr: bookBase }];
    if (diff > 0) lines.push({ a: "4900", cr: 0, bcr: diff, desc: "Exchange difference" });
    if (diff < 0) lines.push({ a: "5900", dr: 0, bdr: -diff, desc: "Exchange difference" });
    return lines;
  };

  const invoice = (date: string, clientId: string, project: string, revenueCode: string, currency: Currency, net: number, rate: number) => {
    const isPkr = currency === "PKR";
    const tax = isPkr ? round2(net * 0.15) : 0;
    const total = net + tax;
    const number = `INV-2026-${String(++invSeq).padStart(4, "0")}`;
    const e = make({
      date,
      desc: `Invoice ${number}`,
      source: "invoice",
      currency,
      rate,
      project,
      lines: [
        { a: isPkr ? "1210" : "1220", dr: total, party: clientId },
        { a: revenueCode, cr: net, party: clientId },
        ...(tax ? [{ a: "2310", cr: tax, desc: "Sindh sales tax 15%" }] : []),
      ],
    });
    receivables.push({
      id: `ar_${invSeq}`,
      number,
      clientId,
      date,
      dueDate: addDaysIso(date, 30),
      total: { amount: m2(total), currency },
      paid: { amount: "0.00", currency },
      baseTotal: { amount: m2(total * (isPkr ? 1 : rate)), currency: "PKR" },
      basePaid: { amount: "0.00", currency: "PKR" },
      status: "unpaid",
      entryId: e.id,
      projectId: project,
    });
  };

  const collect = (date: string, doc: ReceivableDoc, amount: number, rate: number) => {
    const isPkr = doc.total.currency === "PKR";
    const e = isPkr
      ? make({ date, desc: `Payment received for ${doc.number}`, source: "payment", lines: [{ a: "1110", dr: amount }, { a: "1210", cr: amount, party: doc.clientId }] })
      : make({
          date,
          desc: `Payment received for ${doc.number}`,
          source: "payment",
          currency: "USD",
          rate,
          lines: [{ a: "1130", dr: amount }, ...usdOut("1220", amount, rate).map((l, i) => (i === 0 ? { ...l, party: doc.clientId } : l))],
        });
    const paid = Number(doc.paid.amount) + amount;
    doc.paid = { amount: m2(paid), currency: doc.total.currency };
    doc.basePaid = { amount: m2(Number(doc.basePaid.amount) + amount * (isPkr ? 1 : rate)), currency: "PKR" };
    doc.status = paid >= Number(doc.total.amount) - 0.005 ? "paid" : "part_paid";
    return e;
  };

  const bill = (date: string, vendorId: string, desc: string, category: string, amount: number, paidOn?: string) => {
    const number = `BILL-2026-${String(++billSeq).padStart(4, "0")}`;
    const e = make({ date, desc: `${desc} (${number})`, source: "bill", lines: [{ a: category, dr: amount, party: vendorId }, { a: "2100", cr: amount, party: vendorId }] });
    const b: Bill = {
      id: `bill_${billSeq}`,
      number,
      vendorId,
      date,
      dueDate: addDaysIso(date, 30),
      description: desc,
      categoryAccountId: `acc-${category}`,
      total: { amount: m2(amount), currency: "PKR" },
      paid: { amount: "0.00", currency: "PKR" },
      status: "unpaid",
      receipt: { id: `rc_${billSeq}`, fileName: `${number.toLowerCase()}-receipt.pdf`, sizeBytes: 96_000 + billSeq * 1300, mimeType: "application/pdf", uploadedAt: date, uploadedBy: FINANCE },
      entryId: e.id,
    };
    bills.push(b);
    if (paidOn) {
      make({ date: paidOn, desc: `Payment for ${number}`, source: "payment", lines: [{ a: "2100", dr: amount, party: vendorId }, { a: "1120", cr: amount }] });
      b.paid = { amount: m2(amount), currency: "PKR" };
      b.status = "paid";
    }
  };

  const revalue = (date: string, rate: number) => {
    for (const code of ["1130", "1220"]) {
      const b = bal(code);
      const diff = round2(b.usd * rate - b.base);
      if (Math.abs(diff) < 0.01) continue;
      make({
        date,
        desc: `Month-end revaluation of ${code === "1130" ? "Payoneer USD" : "USD receivables"} at ${rate.toFixed(2)}`,
        source: "revaluation",
        lines: diff > 0 ? [{ a: code, dr: diff }, { a: "4900", cr: diff }] : [{ a: "5900", dr: -diff }, { a: code, cr: -diff }],
      });
    }
  };

  // ---------- Opening balances (first day of the first month) ----------
  const d0 = (day: number, time = "10:00") => dayOfMonth(-5, day, time);
  make({
    date: d0(1, "09:00"),
    desc: "Opening balances (auditor sign-off)",
    source: "opening",
    lines: [
      { a: "1110", dr: 3_500_000 },
      { a: "1120", dr: 1_200_000 },
      { a: "1140", dr: 40_000 },
      { a: "1210", dr: 650_000, party: "cl-brightpath" },
      { a: "1510", dr: 1_800_000 },
      { a: "1520", dr: 400_000 },
      { a: "1590", cr: 300_000 },
      { a: "2100", cr: 220_000, party: "vn-pixel" },
      { a: "3100", cr: 5_000_000 },
      { a: "3200", cr: 2_070_000 },
    ],
  });
  make({
    date: d0(1, "09:05"),
    desc: "Opening balance – Payoneer USD 26,000",
    source: "opening",
    currency: "USD",
    rate: 279.4,
    lines: [{ a: "1130", dr: 26_000 }, { a: "3200", cr: 26_000 }],
  });

  const NORTHWIND = [6200, 6500, 6800, 6400, 7000];
  const HARBOR = [4800, 5200, 5600, 5000, 5400];
  const ZARAI = [0, 3600, 3900, 4100, 4200];
  const BRIGHT = [880_000, 920_000, 950_000, 960_000, 990_000];
  const QASIM = [360_000, 0, 420_000, 0, 450_000];
  const UTIL = [58_200, 61_500, 63_800, 60_100, 59_400, 57_800];
  const HOSTING = [310, 325, 340, 335, 350, 360];
  const MARKETING = [76_000, 82_000, 88_000, 90_000, 85_000];
  const GROSS = 3_423_000;
  const WHT = 342_300;
  const NET = GROSS - WHT;

  for (let idx = 0; idx <= 5; idx++) {
    const m = idx - 5;
    const R = RATES[idx];
    const current = m === 0;
    const last = lastDayOf(m);
    const on = (day: number) => !current || day < todayDay;
    const d = (day: number, time = "11:00") => dayOfMonth(m, Math.min(day, last), time);

    if (on(1)) make({ date: d(1, "10:00"), desc: "Office rent", source: "payment", lines: [{ a: "5200", dr: 250_000, party: "vn-landlord" }, { a: "1120", cr: 250_000 }] });
    if (idx > 0 && on(1)) make({ date: d(1, "12:00"), desc: "Salaries paid by bank transfer", source: "payroll", lines: [{ a: "2200", dr: NET }, { a: "1110", cr: NET }] });
    if (on(2)) {
      const sales = idx % 2 === 0 ? 372 : 297;
      make({
        date: d(2),
        desc: idx % 2 === 0 ? "Apollo seats and MillionVerifier credits" : "Apollo seats",
        source: "payment",
        currency: "USD",
        rate: R,
        project: "prj-ops",
        lines: [{ a: "5500", dr: sales, party: "vn-apollo" }, ...usdOut("1130", sales, R)],
      });
      make({ date: d(2, "11:30"), desc: "Claude and ChatGPT team plans", source: "payment", currency: "USD", rate: R, project: "prj-ads", lines: [{ a: "5500", dr: 210, party: "vn-anthropic" }, ...usdOut("1130", 210, R)] });
    }
    // Collections of last month's invoices
    if (on(3)) {
      if (idx === 0) {
        const opening: ReceivableDoc = {
          id: "ar_open", number: "INV-2026-0019", clientId: "cl-brightpath", date: dayOfMonth(-6, 20), dueDate: dayOfMonth(-5, 20),
          total: { amount: "650000.00", currency: "PKR" }, paid: { amount: "0.00", currency: "PKR" },
          baseTotal: { amount: "650000.00", currency: "PKR" }, basePaid: { amount: "0.00", currency: "PKR" }, status: "unpaid", projectId: "prj-brightpath",
        };
        receivables.push(opening);
        collect(d(5), opening, 650_000, R);
      } else {
        const prevMonth = dayOfMonth(m - 1, 15).slice(0, 7);
        for (const doc of receivables.filter((r) => r.status !== "paid" && r.date.slice(0, 7) === prevMonth && r.id !== "ar_open")) {
          const outstanding = Number(doc.total.amount) - Number(doc.paid.amount);
          if (idx === 3 && doc.clientId === "cl-qasim") continue; // Aug invoice still unpaid
          if (idx === 5 && (doc.clientId === "cl-harbor" || doc.clientId === "cl-zarai")) continue; // Oct invoices not yet due
          const pay = idx === 4 && doc.clientId === "cl-brightpath" ? outstanding - 185_000 : outstanding;
          collect(d(doc.clientId === "cl-qasim" ? 4 : 3), doc, round2(pay), R);
        }
      }
    }
    if (on(4)) make({ date: d(4), desc: "Electricity, internet and phones", source: "payment", lines: [{ a: "5300", dr: UTIL[idx], party: "vn-ptcl" }, { a: "1120", cr: UTIL[idx] }] });
    if (current && on(5)) invoice(d(5, "15:00"), "cl-northwind", "prj-northwind", "4100", "USD", 3_500, R);
    if (on(6)) make({ date: d(6), desc: "Hosting and cloud servers", source: "payment", currency: "USD", rate: R, project: "prj-ads", lines: [{ a: "5400", dr: HOSTING[idx], party: "vn-hostinger" }, ...usdOut("1130", HOSTING[idx], R)] });
    if (current) continue;

    if (idx === 1) make({ date: d(8), desc: "Bank loan received from Meezan (3 years)", source: "manual", lines: [{ a: "1120", dr: 3_000_000 }, { a: "2700", cr: 3_000_000 }] });
    if (idx === 3) make({ date: d(9), desc: "Laptops for new developers", source: "manual", project: "prj-ops", lines: [{ a: "1510", dr: 650_000, party: "vn-silicon" }, { a: "1110", cr: 650_000 }] });
    bill(d(10), "vn-pixel", "LinkedIn and Google ads", "5600", MARKETING[idx], idx === 4 ? undefined : d(25));
    make({ date: d(12, "16:00"), desc: "Transfer USD 3,000 from Payoneer to HBL", source: "transfer", currency: "USD", rate: R, lines: [{ a: "1120", dr: 3_000 }, ...usdOut("1130", 3_000, R)] });
    if (idx === 2) make({ date: d(12), desc: "Share capital issued to the founder", source: "manual", lines: [{ a: "1110", dr: 2_000_000 }, { a: "3100", cr: 2_000_000 }] });
    if (idx === 4) make({ date: d(14), desc: "Interim dividend paid to shareholders", source: "manual", lines: [{ a: "3400", dr: 500_000 }, { a: "1110", cr: 500_000 }] });
    if (idx > 0) make({ date: d(15), desc: "Salary income tax deposited with FBR", source: "payment", lines: [{ a: "2300", dr: WHT }, { a: "1120", cr: WHT }] });
    if (idx >= 2) make({ date: d(15, "12:00"), desc: "Loan instalment (principal and interest)", source: "payment", lines: [{ a: "2700", dr: 100_000 }, { a: "5860", dr: 35_000 }, { a: "1120", cr: 135_000 }] });
    if (idx === 4) make({ date: d(17), desc: "Salary advance to Ali Raza", source: "payment", lines: [{ a: "1320", dr: 80_000, emp: "ACV-0008" }, { a: "1110", cr: 80_000 }] });
    if (idx === 4) bill(d(18), "vn-furniture", "Office chairs for the Karachi studio", "1520", 140_000);
    // Invoices
    invoice(d(20, "15:00"), "cl-northwind", "prj-northwind", "4100", "USD", NORTHWIND[idx], R);
    invoice(d(20, "15:10"), "cl-harbor", "prj-harbor", "4500", "USD", HARBOR[idx], R);
    if (ZARAI[idx]) invoice(d(20, "15:20"), "cl-zarai", "prj-zarai", "4400", "USD", ZARAI[idx], R);
    invoice(d(20, "15:30"), "cl-brightpath", "prj-brightpath", "4200", "PKR", BRIGHT[idx], R);
    if (QASIM[idx]) invoice(d(20, "15:40"), "cl-qasim", "prj-qasim", "4300", "PKR", QASIM[idx], R);
    if (idx === 4) {
      const dup = make({ date: d(21), desc: "Office rent (entered twice by mistake)", source: "payment", lines: [{ a: "5200", dr: 250_000, party: "vn-landlord" }, { a: "1120", cr: 250_000 }] });
      const rev = make({ date: d(22), desc: `Reversal of duplicate rent entry`, source: "reversal", lines: [{ a: "1120", dr: 250_000 }, { a: "5200", cr: 250_000, party: "vn-landlord" }] });
      dup.status = "reversed";
      dup.reversedBy = rev.id;
      rev.reversalOf = dup.id;
    }
    make({ date: d(26), desc: "Bank charges", source: "payment", lines: [{ a: "5850", dr: 2_400 }, { a: "1110", cr: 2_400 }] });
    make({ date: d(27, "16:00"), desc: "Transfer USD 9,500 from Payoneer to Meezan for payroll", source: "transfer", currency: "USD", rate: R, lines: [{ a: "1110", dr: 9_500 }, ...usdOut("1130", 9_500, R)] });
    make({
      date: d(last, "17:00"),
      desc: `Payroll for ${new Date(d(15)).toLocaleString("en-GB", { month: "long", year: "numeric" })}`,
      source: "payroll",
      lines: [{ a: "5100", dr: GROSS }, { a: "2200", cr: NET }, { a: "2300", cr: WHT }],
    });
    make({ date: d(last, "17:30"), desc: "Monthly depreciation", source: "manual", lines: [{ a: "5800", dr: 55_000 }, { a: "1590", cr: 55_000 }] });
    revalue(d(last, "18:00"), R);
  }

  // ---------- Current month: waiting for approval and drafts ----------
  const t = (h: string) => dayOfMonth(0, Math.max(1, todayDay), h);
  const posted = entries.filter((e) => e.status !== "draft" && e.status !== "pending_approval").sort((a, b) => a.date.localeCompare(b.date));
  const startNo = 311 - posted.length;
  posted.forEach((e, i) => (e.number = `JE-2026-${String(startNo + i).padStart(4, "0")}`));

  const pending = [
    make({ date: t("09:40"), desc: "Annual hosting prepayment", source: "manual", status: "pending_approval", project: "prj-ads", lines: [{ a: "1310", dr: 120_000, party: "vn-hostinger" }, { a: "1110", cr: 120_000 }] }),
    make({ date: t("10:15"), desc: "Team lunch for the go-live rehearsal", source: "manual", status: "pending_approval", project: "prj-ads", lines: [{ a: "5650", dr: 35_000 }, { a: "1120", cr: 35_000 }] }),
    make({ date: t("11:05"), desc: "New laptops for interns", source: "manual", status: "pending_approval", project: "prj-ops", lines: [{ a: "1510", dr: 640_000, party: "vn-silicon" }, { a: "2100", cr: 640_000, party: "vn-silicon" }] }),
    make({ date: t("12:20"), desc: "Office supplies (printer paper, toner)", source: "manual", status: "draft", lines: [{ a: "5660", dr: 12_500 }, { a: "1140", cr: 12_500 }] }),
    make({ date: t("08:50"), desc: "Client dinner with Harbor & Co", source: "manual", status: "draft", project: "prj-harbor", lines: [{ a: "5650", dr: 18_000 }, { a: "1140", cr: 18_000 }] }),
  ];
  pending.forEach((e, i) => (e.number = `JE-2026-${String(311 + i).padStart(4, "0")}`));
  const rejected = pending[4];
  rejected.rejectionNote = "Attach the receipt and tag the client project, then submit again.";
  rejected.history.push(
    { at: t("09:30"), by: FINANCE, action: "submitted" },
    { at: t("09:45"), by: rejected.approverEmpId ?? DIRECTOR, action: "rejected", note: rejected.rejectionNote },
  );

  // ---------- Bank statement (Meezan, current month) ----------
  const statement: BankStatementLine[] = [];
  let sl = 0;
  const addStmt = (day: number, description: string, amount: number) => {
    if (day >= todayDay) return;
    statement.push({ id: `bs_${++sl}`, bankAccountId: "acc-1110", date: dayOfMonth(0, day, "12:00"), description, amount: m2(amount) });
  };
  addStmt(1, "BULK SALARY TRANSFER OCT", -NET);
  const brightOct = receivables.find((r) => r.clientId === "cl-brightpath" && r.date.slice(0, 7) === dayOfMonth(-1, 15).slice(0, 7));
  const qasimOct = receivables.find((r) => r.clientId === "cl-qasim" && r.date.slice(0, 7) === dayOfMonth(-1, 15).slice(0, 7));
  if (brightOct) addStmt(3, "IBFT IN BRIGHT PATH ACADEMY", Number(brightOct.total.amount));
  if (qasimOct) addStmt(5, "IBFT IN QASIM LOGISTICS PVT", Number(qasimOct.total.amount));
  addStmt(4, "SMS ALERT CHARGES", -350);
  addStmt(6, "PROFIT ON PLS DEPOSIT", 4_812.4);

  // ---------- Periods and rates ----------
  const periods: FinancePeriod[] = [];
  const rates: ExchangeRate[] = [];
  for (let idx = 0; idx <= 5; idx++) {
    const m = idx - 5;
    const month = dayOfMonth(m, 15).slice(0, 7);
    rates.push({ month, rate: RATES[idx].toFixed(2) });
    if (m < 0)
      periods.push({
        month,
        status: "closed",
        checklist: [],
        closedBy: FINANCE,
        closedAt: dayOfMonth(m + 1, 3, "15:00"),
        approvedBy: DIRECTOR,
        approvedAt: dayOfMonth(m + 1, 4, "11:00"),
      });
    else periods.push({ month, status: "open", checklist: [] });
  }

  return { entries, receivables, bills, statement, periods, rates };
}
