/**
 * Module 9 against the REAL API (NEXT_PUBLIC_LIVE_MODULES contains m9). Same function names and result shapes as the mock
 * in api.ts, so the screens keep working. The server decides everything (approval tier, who may approve, totals, paid /
 * unpaid status, the close checklist); these functions only translate between the API and the shapes the screens use.
 * Money stays a decimal string from the server.
 */
import type {
  AccountView, ApprovalLimitView, BankAccountView, BillView, EntryView, ExchangeRateView, InvoiceView, Page, PartyView, PaymentView, PeriodView,
  ProjectView, ReconciliationView, RevaluationPreviewView, StatementImportResult, StatementLineView,
} from "@aceva/contracts";
import { http } from "@/lib/api/http";
import { ApiError } from "@/lib/api/mock";
import type { ApprovalStep, Attachment, Currency, RoleKey } from "@/types";
import type { mockLedgerApi } from "./api";
import type {
  Account, AccountGroup, AccountKind, ApprovalLimit, BankStatementLine, Bill, EntryEvent, EntryListParams, ExchangeRate, FinancePeriod, FinanceProject,
  JournalEntry, LedgerCashLine, NewEntryInput, Party, ReceivableDoc, RevaluationPreview,
} from "./types";

type Api = Omit<typeof mockLedgerApi, "revealBankNumber" | "createRate">;

const PKR = (amount: string) => ({ amount, currency: "PKR" as Currency });
const in2 = (n: number) => n.toFixed(2); // form input (a number the person typed) to the API's decimal string
const positive = (s: string | undefined) => !!s && Number(s) > 0;

const KIND_BY_ROLE: Record<string, AccountKind> = {
  accounts_receivable: "receivable",
  accounts_payable: "payable",
  salary_payable: "salary_payable",
  tax_payable: "tax_payable",
  payroll_deductions: "accrued",
  employee_advances: "prepayment",
  salary_expense: "expense",
  fx_gain_loss: "fx",
};

function kindOf(a: AccountView): AccountKind | undefined {
  if (a.systemRole && KIND_BY_ROLE[a.systemRole]) return KIND_BY_ROLE[a.systemRole];
  if (a.isBank) return "cash";
  if (a.requiresOwnerApproval) return a.group === "equity" ? "share_capital" : "loan";
  if (a.group === "income") return "revenue";
  if (a.group === "expense") return "expense";
  return undefined;
}

function mapAccount(a: AccountView, bank?: BankAccountView): Account {
  return {
    id: a.id,
    code: a.code,
    name: a.name,
    group: a.group,
    kind: kindOf(a),
    parentId: a.parentId ?? undefined,
    isHeader: a.isHeader,
    currency: a.currency,
    isBank: a.isBank,
    // Never the number: the masked form only. The full number comes from the logged reveal (revealBankNumber).
    bankAccountNumber: bank?.accountNumberMasked ?? undefined,
    bankName: bank?.bankName ?? undefined,
    active: a.active,
    balance: PKR(a.balance),
    foreignBalance: a.foreignBalance ? { amount: a.foreignBalance, currency: "USD" } : undefined,
  };
}

const EVENT_ACTION: Record<string, EntryEvent["action"]> = {
  created: "created",
  edited: "edited",
  submitted: "submitted",
  approved: "approved",
  rejected: "rejected",
  posted: "posted",
  reversal_created: "reversed",
};

function chainOf(e: EntryView): ApprovalStep[] {
  const decided = e.status === "posted" || e.status === "reversed";
  return [
    { label: "Prepared", empId: e.makerEmpId, state: "done", at: e.submittedAt ?? e.createdAt },
    {
      label: e.requiredApproverLabel ? `${e.requiredApproverLabel} approval` : "Approval",
      empId: e.approvedByEmpId ?? e.rejectedByEmpId ?? undefined,
      state: decided ? "done" : e.status === "rejected" ? "rejected" : e.status === "pending_approval" ? "waiting" : "pending",
      at: e.postedAt ?? undefined,
      note: e.rejectedReason ?? undefined,
    },
  ];
}

export function mapEntry(e: EntryView): JournalEntry {
  return {
    id: e.id,
    number: e.number,
    date: e.date,
    description: e.description,
    source: e.source,
    projectId: e.projectId ?? undefined,
    currency: e.currency,
    exchangeRate: e.exchangeRate,
    lines: e.lines.map((l) => ({
      id: l.id,
      accountId: l.accountId,
      description: l.description ?? undefined,
      debit: l.debit,
      credit: l.credit,
      baseDebit: l.baseDebit,
      baseCredit: l.baseCredit,
      partyId: l.partyId ?? undefined,
      empId: l.empId ?? undefined,
    })),
    total: { amount: e.total, currency: e.currency },
    baseTotal: PKR(e.totalBase),
    status: e.status === "rejected" ? "draft" : e.status,
    rejected: e.status === "rejected",
    // The server decides who approves: these mock-era flags stay off in live mode.
    approverEmpId: undefined,
    ceoNotified: false,
    blocked: false,
    createdBy: e.makerEmpId,
    createdAt: e.createdAt,
    postedAt: e.postedAt ?? undefined,
    chain: chainOf(e),
    reversalOf: e.reversalOfId ?? undefined,
    reversedBy: e.reversedById ?? undefined,
    attachments: e.receipts.map((r) => ({ id: r.id, fileName: r.fileName, sizeBytes: r.sizeBytes, mimeType: r.mimeType, uploadedAt: r.uploadedAt, uploadedBy: "" })),
    history: e.events.map((ev) => ({ at: ev.at, by: ev.byEmpId ?? "system", action: EVENT_ACTION[ev.action] ?? "edited", note: ev.note ?? undefined })),
    rejectionNote: e.rejectedReason ?? undefined,
    requiredLevel: e.requiredLevel,
    requiredApproverLabel: e.requiredApproverLabel,
    canApprove: e.canApprove,
    needsStepUp: e.needsStepUp,
    makerName: e.makerName,
  };
}

const mapParty = (p: PartyView): Party => ({ id: p.id, kind: p.kind, name: p.name, email: p.email ?? undefined, country: p.country ?? undefined, currency: p.currency, balance: PKR(p.balance) });

const times = (a: string, rate: string) => (Number(a) * Number(rate)).toFixed(2); // display only (the server keeps the exact amounts)

const mapInvoice = (i: InvoiceView): ReceivableDoc => ({
  id: i.id,
  number: i.number,
  clientId: i.partyId,
  date: i.issueDate,
  dueDate: i.dueDate,
  total: { amount: i.total, currency: i.currency },
  paid: { amount: i.paid, currency: i.currency },
  baseTotal: PKR(i.totalBase),
  basePaid: PKR(times(i.paid, i.exchangeRate)),
  status: i.status,
  entryId: i.entryId ?? undefined,
  projectId: i.projectId ?? undefined,
});

const mapBill = (b: BillView): Bill => ({
  id: b.id,
  number: b.number,
  vendorId: b.partyId,
  date: b.billDate,
  dueDate: b.dueDate,
  description: b.description,
  categoryAccountId: b.accountId,
  total: { amount: b.total, currency: b.currency },
  paid: { amount: b.paid, currency: b.currency },
  status: b.status,
  receipt: b.receipts[0] ? { id: b.receipts[0].id, fileName: b.receipts[0].fileName, sizeBytes: b.receipts[0].sizeBytes, mimeType: b.receipts[0].mimeType, uploadedAt: b.receipts[0].uploadedAt, uploadedBy: "" } : undefined,
  entryId: b.entryId ?? undefined,
});

function mapPeriod(p: PeriodView): FinancePeriod {
  const reopen = [...p.events].reverse().find((e) => e.action === "reopened" || e.action === "close_rejected");
  return {
    month: p.month,
    status: p.status,
    checklist: p.checklist.map((c) => ({ key: c.key, label: c.label, done: c.done, detail: c.detail })),
    closedBy: p.closeRequestedByEmpId ?? undefined,
    closedAt: p.closeRequestedAt ?? undefined,
    approvedBy: p.closedByEmpId ?? undefined,
    approvedAt: p.closedAt ?? undefined,
    reopenReason: reopen?.reason ? `${reopen.reason} (${reopen.action === "reopened" ? "reopened" : "close sent back"} by ${reopen.byEmpId})` : undefined,
    canApproveClose: p.canApproveClose,
  };
}

const keyOf = (entryId: string, journalLineId: string) => `${entryId}:${journalLineId}`;

function mapStatementLine(bankAccountId: string, s: StatementLineView): BankStatementLine {
  return {
    id: s.id,
    bankAccountId,
    date: s.date,
    description: s.description,
    amount: s.amount,
    matchedLineKey: s.matchedEntryId && s.matchedJournalLineId ? keyOf(s.matchedEntryId, s.matchedJournalLineId) : undefined,
    // Only an unambiguous suggestion is shown as "suggested".
    suggestion: s.suggestions.length === 1 ? keyOf(s.suggestions[0].entryId, s.suggestions[0].journalLineId) : undefined,
  };
}

const ROLE_BY_LEVEL: Record<number, RoleKey> = { 1: "owner", 2: "ceo", 3: "director" };

/** Receipt files chosen in the bill form, kept until the bill is saved (the form only holds an Attachment description). */
const pendingReceipts = new Map<string, File>();
export function stashReceiptFile(attachmentId: string, file: File) {
  pendingReceipts.set(attachmentId, file);
}

async function allEntries(params: Record<string, string | number | undefined>): Promise<JournalEntry[]> {
  const page = await http.get<Page<EntryView>>("/journal-entries", { pageSize: 200, ...params });
  return page.items.map(mapEntry);
}

const entryLines = (lines: NewEntryInput["lines"]) =>
  lines
    .filter((l) => positive(l.debit) || positive(l.credit))
    .map((l) => ({
      accountId: l.accountId,
      description: l.description || undefined,
      ...(positive(l.debit) ? { debit: Number(l.debit).toFixed(2) } : { credit: Number(l.credit).toFixed(2) }),
      partyId: l.partyId || undefined,
      empId: l.empId || undefined,
    }));

async function bankAccounts(): Promise<Account[]> {
  const [accounts, banks] = await Promise.all([http.get<AccountView[]>("/accounts"), http.get<BankAccountView[]>("/bank-accounts")]);
  const byId = new Map(banks.map((b) => [b.id, b]));
  return accounts.filter((a) => a.isBank).map((a) => mapAccount(a, byId.get(a.id)));
}

export const liveLedgerApi: Api & {
  revealBankNumber: (accountId: string) => Promise<string>;
  createRate: (date: string, rate: string) => Promise<ExchangeRateView>;
} = {
  /** GET /accounts (+ GET /bank-accounts for the masked numbers) */
  accounts: async () => {
    const [accounts, banks] = await Promise.all([http.get<AccountView[]>("/accounts"), http.get<BankAccountView[]>("/bank-accounts")]);
    const byId = new Map(banks.map((b) => [b.id, b]));
    return accounts.map((a) => mapAccount(a, byId.get(a.id)));
  },

  /** POST /accounts */
  createAccount: async (input: { code: string; name: string; group: AccountGroup; parentId?: string; currency: Currency }) => mapAccount(await http.post<AccountView>("/accounts", input)),

  /** GET /journal-entries?status&month&source */
  entries: (params: EntryListParams = {}) => allEntries({ status: params.status, month: params.month, source: params.source }),

  /** GET /journal-entries/:id */
  entry: async (id: string) => mapEntry(await http.get<EntryView>(`/journal-entries/${id}`)),

  /** POST /journal-entries (PATCH + submit for a draft) */
  saveEntry: async (input: NewEntryInput) => {
    const body = {
      date: input.date.slice(0, 10),
      description: input.description,
      projectId: input.projectId || undefined,
      currency: input.currency,
      exchangeRate: input.currency === "USD" && positive(input.exchangeRate) ? input.exchangeRate : undefined,
      lines: entryLines(input.lines),
    };
    if (input.draftId) {
      const saved = await http.patch<EntryView>(`/journal-entries/${input.draftId}`, body);
      return mapEntry(input.submit ? await http.post<EntryView>(`/journal-entries/${saved.id}/submit`) : saved);
    }
    return mapEntry(await http.post<EntryView>("/journal-entries", { ...body, submit: input.submit }));
  },

  /** POST /journal-entries/:id/submit */
  submit: async (id: string) => {
    await http.post<EntryView>(`/journal-entries/${id}/submit`);
  },

  /** POST /journal-entries/:id/approve (the server checks the tier, maker-checker and "confirm again") */
  approve: async (id: string) => {
    await http.post<EntryView>(`/journal-entries/${id}/approve`, {});
  },

  /** POST /journal-entries/:id/reject { reason } */
  reject: async (id: string, reason: string) => {
    await http.post<EntryView>(`/journal-entries/${id}/reject`, { reason });
  },

  /** POST /journal-entries/:id/reverse { reason } → reversing draft */
  reverse: async (id: string, reason: string) => mapEntry(await http.post<EntryView>(`/journal-entries/${id}/reverse`, { reason })),

  /** Spreadsheet correction (M11): a reversing draft plus a corrected draft, both for normal approval. */
  correction: async (entryId: string, lineId: string, field: "description" | "debit" | "credit", value: string) => {
    const original = await http.get<EntryView>(`/journal-entries/${entryId}`);
    const reversal = mapEntry(await http.post<EntryView>(`/journal-entries/${entryId}/reverse`, { reason: `Correcting the ${field} of a line` }));
    const lines = original.lines.map((l) => ({ ...l }));
    const changed = lines.find((l) => l.id === lineId);
    if (!changed) throw new ApiError("not_found", "Line not found", 404);
    if (field === "description") changed.description = value;
    else {
      changed[field] = Number(value).toFixed(2);
      changed[field === "debit" ? "credit" : "debit"] = "0.00";
      if (lines.length === 2) {
        const other = lines.find((l) => l.id !== lineId)!;
        other.debit = field === "credit" ? changed.credit : "0.00";
        other.credit = field === "debit" ? changed.debit : "0.00";
      }
    }
    const corrected = mapEntry(
      await http.post<EntryView>("/journal-entries", {
        date: original.date,
        description: `Corrected copy of ${original.number}`,
        currency: original.currency,
        exchangeRate: original.currency === "USD" ? original.exchangeRate : undefined,
        projectId: original.projectId ?? undefined,
        lines: lines.map((l) => ({ accountId: l.accountId, description: l.description ?? undefined, ...(positive(l.debit) ? { debit: l.debit } : { credit: l.credit }), partyId: l.partyId ?? undefined, empId: l.empId ?? undefined })),
      }),
    );
    return { reversal, corrected };
  },

  /** GET /parties?kind */
  parties: async (kind?: Party["kind"]) => (await http.get<Page<PartyView>>("/parties", { kind, pageSize: 200 })).items.map(mapParty),

  /** POST /parties */
  createParty: async (input: Omit<Party, "id" | "balance">) =>
    mapParty(await http.post<PartyView>("/parties", { kind: input.kind, name: input.name, email: input.email || undefined, country: input.country || undefined, currency: input.currency })),

  /** GET /journal-entries?partyId */
  partyEntries: (partyId: string) => allEntries({ partyId, pageSize: 12 }),

  /** GET /invoices */
  receivables: async () => (await http.get<Page<InvoiceView>>("/invoices", { pageSize: 200 })).items.map(mapInvoice),

  /** GET /bills */
  bills: async () => (await http.get<Page<BillView>>("/bills", { pageSize: 200 })).items.map(mapBill),

  /** POST /bills, then POST /bills/:id/receipt with the chosen file */
  createBill: async (input: { vendorId: string; date: string; dueDate: string; description: string; categoryAccountId: string; amount: number; receipt?: Attachment }) => {
    let bill = await http.post<BillView>("/bills", {
      partyId: input.vendorId,
      billDate: input.date.slice(0, 10),
      dueDate: input.dueDate.slice(0, 10),
      accountId: input.categoryAccountId,
      description: input.description,
      total: in2(input.amount),
    });
    const file = input.receipt ? pendingReceipts.get(input.receipt.id) : undefined;
    if (file && input.receipt) {
      const form = new FormData();
      form.append("file", file, file.name);
      await http.upload(`/bills/${bill.id}/receipt`, form);
      pendingReceipts.delete(input.receipt.id);
      bill = await http.get<BillView>(`/bills/${bill.id}`);
    }
    return mapBill(bill);
  },

  /** POST /payments (made, allocated to the bill) */
  payBill: async (billId: string, amount: number, bankAccountId: string) => {
    const bill = await http.get<BillView>(`/bills/${billId}`);
    const today = new Date().toISOString().slice(0, 10);
    const pay = await http.post<PaymentView>("/payments", { direction: "made", partyId: bill.partyId, bankAccountId, paymentDate: today, amount: in2(amount), allocations: [{ billId, amount: in2(amount) }] });
    return mapEntry(await http.get<EntryView>(`/journal-entries/${pay.entryId}`));
  },

  /** GET /bank-accounts */
  bankAccounts,

  /** GET /transfers */
  transfers: async () => (await http.get<Page<EntryView>>("/transfers", { pageSize: 200 })).items.map(mapEntry),

  /** POST /transfers (the entry goes for approval) */
  createTransfer: async (input: { fromId: string; toId: string; amount: number; currency: Currency; rate: string; date: string; note: string }) => {
    const banks = await bankAccounts();
    const from = banks.find((b) => b.id === input.fromId);
    const to = banks.find((b) => b.id === input.toId);
    if (!from || !to) throw new ApiError("validation", "Choose two bank accounts.");
    const body: Record<string, unknown> = { fromAccountId: from.id, toAccountId: to.id, date: input.date.slice(0, 10), description: input.note || undefined };
    if (from.currency === to.currency) {
      body.amount = in2(input.amount);
      if (from.currency === "USD" && positive(input.rate)) body.exchangeRate = input.rate;
    } else {
      // The form takes one amount (in `currency`) and the rate; the server records both sides exactly.
      const rate = Number(input.rate);
      if (!(rate > 0)) throw new ApiError("validation", "Enter the exchange rate.");
      const other = input.currency === "USD" ? input.amount * rate : input.amount / rate;
      body.amount = in2(from.currency === input.currency ? input.amount : other);
      body.toAmount = in2(to.currency === input.currency ? input.amount : other);
    }
    return mapEntry(await http.post<EntryView>("/transfers", body));
  },

  /** GET /bank-statements?bankAccountId&month */
  reconciliation: async (bankAccountId: string, month: string) => {
    const v = await http.get<ReconciliationView>("/bank-statements", { bankAccountId, month });
    const matched = new Set(v.ledger.filter((l) => l.matched).map((l) => l.journalLineId));
    return {
      statement: v.statement.map((s) => mapStatementLine(bankAccountId, s)),
      ledger: v.ledger.map(
        (l): LedgerCashLine => ({ key: keyOf(l.entryId, l.journalLineId), entryId: l.entryId, entryNumber: l.entryNumber, date: l.date, description: l.description, amount: l.amount, matched: matched.has(l.journalLineId) }),
      ),
    };
  },

  /** POST /bank-statements (the CSV is rebuilt from the rows the screen read; the server validates every row again) */
  importStatement: async (bankAccountId: string, rows: { date: string; description: string; amount: number }[]) => {
    const esc = (v: string) => (/[",\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const csv = ["date,description,amount", ...rows.map((r) => [r.date.slice(0, 10), esc(r.description), in2(r.amount)].join(","))].join("\r\n");
    const form = new FormData();
    form.append("bankAccountId", bankAccountId);
    form.append("file", new Blob([csv], { type: "text/csv" }), "statement.csv");
    return (await http.upload<StatementImportResult>("/bank-statements", form)).lineCount;
  },

  /** POST /bank-statements/lines/:id/match { journalLineId } (null = unmatch) */
  match: async (statementLineId: string, lineKey: string | null) => {
    if (!lineKey) await http.post(`/bank-statements/lines/${statementLineId}/unmatch`);
    else await http.post(`/bank-statements/lines/${statementLineId}/match`, { journalLineId: lineKey.split(":")[1] });
  },

  /** POST /bank-statements/auto-match */
  acceptSuggestions: async (bankAccountId: string, month: string) => (await http.post<{ matched: number }>("/bank-statements/auto-match", { bankAccountId, month })).matched,

  /** POST /bank-statements/lines/:id/create-entry (missing in ledger → entry for approval) */
  entryFromStatement: async (statementLineId: string, counterAccountId: string) =>
    mapEntry(await http.post<EntryView>(`/bank-statements/lines/${statementLineId}/create-entry`, { counterAccountId, submit: true })),

  /** GET /periods (with the live close checklist) */
  periods: async () => (await http.get<PeriodView[]>("/periods")).map(mapPeriod),

  /** GET /periods/:month/revaluation?rate */
  revaluationPreview: async (month: string, rate?: number): Promise<RevaluationPreview> => {
    const p = await http.get<RevaluationPreviewView>(`/periods/${month}/revaluation`, { rate: rate ? String(rate) : undefined });
    return { month: p.month, rate: p.rate, rows: p.rows.map((r) => ({ accountId: r.accountId, foreign: r.foreign, bookBase: r.bookBase, revaluedBase: r.revaluedBase, difference: r.difference })), total: p.total };
  },

  /** POST /periods/:month/revalue { rate } → revaluation entry for approval */
  postRevaluation: async (month: string, rate: number) => mapEntry(await http.post<EntryView>(`/periods/${month}/revalue`, { rate: String(rate) })),

  /** POST /periods/:month/close */
  runClose: async (month: string) => {
    await http.post(`/periods/${month}/close`);
  },

  /** POST /periods/:month/approve-close (the CEO; never the person who ran it) */
  approveClose: async (month: string) => {
    await http.post(`/periods/${month}/approve-close`);
  },

  /** POST /periods/:month/reject-close { reason } */
  rejectClose: async (month: string, reason: string) => {
    await http.post(`/periods/${month}/reject-close`, { reason });
  },

  /** POST /periods/:month/reopen { reason } (Owner or CEO, after "confirm again"; logged and alerted) */
  reopen: async (month: string, reason: string) => {
    await http.post(`/periods/${month}/reopen`, { reason });
  },

  /** GET /exchange-rates → the latest saved rate of each month */
  rates: async () => {
    const rows = await http.get<ExchangeRateView[]>("/exchange-rates");
    const byMonth = new Map<string, ExchangeRate>();
    for (const r of [...rows].sort((a, b) => a.date.localeCompare(b.date))) byMonth.set(r.date.slice(0, 7), { month: r.date.slice(0, 7), rate: r.rate });
    return [...byMonth.values()];
  },

  /** GET /projects */
  projects: async (): Promise<FinanceProject[]> => (await http.get<ProjectView[]>("/projects")).map((p) => ({ id: p.id, name: `${p.code} · ${p.name}` })),

  /** GET /settings/approval-limits */
  approvalLimits: async (): Promise<ApprovalLimit[]> =>
    (await http.get<ApprovalLimitView[]>("/settings/approval-limits")).map((l) => ({ role: ROLE_BY_LEVEL[l.approverLevel] ?? "director", label: l.label, upTo: l.maxAmount === null ? null : Number(l.maxAmount) })),

  /** POST /bank-accounts/:id/reveal (the caller confirms again first; every reveal is logged) */
  revealBankNumber: async (accountId: string) => (await http.post<{ value: string }>(`/bank-accounts/${accountId}/reveal`)).value,

  /** POST /exchange-rates */
  createRate: (date: string, rate: string) => http.post<ExchangeRateView>("/exchange-rates", { date, rate }),
};
