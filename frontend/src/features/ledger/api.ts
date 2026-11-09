/**
 * Module 9 service functions. Mock today; each JSDoc names the real endpoint (spec §7.3).
 * Finance resources return 404 (not 403) to people without finance access (plan §16).
 */
import { ApiError, mock, notFound } from "@/lib/api/mock";
import type { Permission } from "@/lib/auth/permissions";
import { getViewer } from "@/lib/auth/viewer";
import { uid } from "@/lib/utils";
import type { Attachment, Currency } from "@/types";
import { APPROVAL_LIMITS, m2, monthKeyOf, num } from "./logic";
import {
  accountsTable, accountsWithBalances, approveClose, approveEntry, billsTable, cashLines, checklistFor, closeMonth, correctionFor,
  currentRate, entriesTable, findEntry, partiesTable, partyBalances, periodsTable, projectsList, ratesTable, receivablesTable,
  rejectClose, rejectEntry, reopenMonth, revaluationPreview, reverseEntry, saveEntry, statementTable, submitEntry, suggestMatches,
} from "./store";
import type { Account, AccountGroup, Bill, EntryListParams, FinancePeriod, JournalEntry, NewEntryInput, Party } from "./types";

function guard(p: Permission = "finance.view") {
  const v = getViewer();
  if (!v.can(p)) notFound("Page");
  return v;
}

export const ledgerApi = {
  /** GET /accounts */
  accounts: () => mock(() => (guard(), accountsWithBalances())),

  /** POST /accounts */
  createAccount: (input: { code: string; name: string; group: AccountGroup; parentId?: string; currency: Currency }) =>
    mock(() => {
      guard("finance.entry_create");
      if (accountsTable().some((a) => a.code === input.code)) throw new ApiError("validation", `Code ${input.code} is already used.`);
      const a: Account = { id: `acc-${input.code}`, ...input, kind: input.group === "income" ? "revenue" : input.group === "expense" ? "expense" : undefined, active: true, balance: { amount: "0.00", currency: "PKR" } };
      accountsTable().push(a);
      return a;
    }),

  /** GET /journal-entries?status&month&source */
  entries: (params: EntryListParams = {}) =>
    mock(() => {
      guard();
      return entriesTable()
        .filter((e) => !params.status || params.status === "all" || e.status === params.status)
        .filter((e) => !params.month || monthKeyOf(e.date) === params.month)
        .filter((e) => !params.source || params.source === "all" || e.source === params.source)
        .sort((a, b) => b.date.localeCompare(a.date) || b.number.localeCompare(a.number));
    }),

  /** GET /journal-entries/:id */
  entry: (id: string) => mock(() => (guard(), findEntry(id))),

  /** POST /journal-entries (or PATCH for a draft) */
  saveEntry: (input: NewEntryInput) => mock(() => saveEntry(input, guard("finance.entry_create").employee.empId)),

  /** POST /journal-entries/:id/submit */
  submit: (id: string) => mock(() => submitEntry(id, guard("finance.entry_create").employee.empId)),

  /** POST /journal-entries/:id/approve (Director only, any amount) */
  approve: (id: string) => mock(() => approveEntry(id, guard().employee.empId)),

  /** POST /journal-entries/:id/reject { reason } */
  reject: (id: string, reason: string) => mock(() => rejectEntry(id, guard().employee.empId, reason)),

  /** POST /journal-entries/:id/reverse { reason } → reversing draft */
  reverse: (id: string, reason: string) => mock(() => reverseEntry(id, guard("finance.entry_create").employee.empId, reason)),

  /** POST /journal-entries/:id/correction (spreadsheet edit of a posted row, M11) */
  correction: (entryId: string, lineId: string, field: "description" | "debit" | "credit", value: string) =>
    mock(() => correctionFor(entryId, lineId, field, value, guard("finance.entry_create").employee.empId)),

  /** GET /parties?kind */
  parties: (kind?: Party["kind"]) => mock(() => (guard(), partyBalances().filter((p) => !kind || p.kind === kind))),

  /** POST /parties */
  createParty: (input: Omit<Party, "id" | "balance">) =>
    mock(() => {
      guard("finance.entry_create");
      const p: Party = { ...input, id: uid(input.kind === "client" ? "cl" : "vn"), balance: { amount: "0.00", currency: "PKR" } };
      partiesTable().push(p);
      return p;
    }),

  /** GET /parties/:id/entries */
  partyEntries: (partyId: string) =>
    mock(() => {
      guard();
      return entriesTable()
        .filter((e) => e.lines.some((l) => l.partyId === partyId))
        .sort((a, b) => b.date.localeCompare(a.date))
        .slice(0, 12);
    }),

  /** GET /receivables (client invoices as AR documents) */
  receivables: () => mock(() => (guard(), receivablesTable())),

  /** GET /bills */
  bills: () => mock(() => (guard(), [...billsTable()].sort((a, b) => b.date.localeCompare(a.date)))),

  /** POST /bills (creates the bill and its entry for approval) */
  createBill: (input: { vendorId: string; date: string; dueDate: string; description: string; categoryAccountId: string; amount: number; receipt?: Attachment }) =>
    mock(() => {
      const v = guard("finance.entry_create");
      const n = billsTable().reduce((m, b) => Math.max(m, Number(b.number.split("-").pop())), 0) + 1;
      const number = `BILL-${new Date().getFullYear()}-${String(n).padStart(4, "0")}`;
      const e = saveEntry(
        {
          date: input.date,
          description: `${input.description} (${number})`,
          currency: "PKR",
          exchangeRate: "1",
          source: "bill",
          lines: [
            { accountId: input.categoryAccountId, debit: m2(input.amount), credit: "0.00", partyId: input.vendorId },
            { accountId: "acc-2100", debit: "0.00", credit: m2(input.amount), partyId: input.vendorId },
          ],
          attachments: input.receipt ? [input.receipt] : [],
          submit: true,
        },
        v.employee.empId,
      );
      const bill: Bill = {
        id: uid("bill"),
        number,
        vendorId: input.vendorId,
        date: input.date,
        dueDate: input.dueDate,
        description: input.description,
        categoryAccountId: input.categoryAccountId,
        total: { amount: m2(input.amount), currency: "PKR" },
        paid: { amount: "0.00", currency: "PKR" },
        status: "unpaid",
        receipt: input.receipt,
        entryId: e.id,
      };
      billsTable().unshift(bill);
      return bill;
    }),

  /** POST /bills/:id/payments (creates a payment entry for approval) */
  payBill: (billId: string, amount: number, bankAccountId: string) =>
    mock(() => {
      const v = guard("finance.entry_create");
      const b = billsTable().find((x) => x.id === billId);
      if (!b) notFound("Bill");
      const outstanding = num(b.total.amount) - num(b.paid.amount);
      if (amount <= 0 || amount > outstanding + 0.005) throw new ApiError("validation", `Pay between 1 and ${outstanding.toFixed(2)}.`);
      const e = saveEntry(
        {
          date: new Date().toISOString(),
          description: `Payment for ${b.number}`,
          currency: "PKR",
          exchangeRate: "1",
          source: "payment",
          lines: [
            { accountId: "acc-2100", debit: m2(amount), credit: "0.00", partyId: b.vendorId },
            { accountId: bankAccountId, debit: "0.00", credit: m2(amount) },
          ],
          submit: true,
        },
        v.employee.empId,
      );
      const paid = num(b.paid.amount) + amount;
      b.paid = { amount: m2(paid), currency: "PKR" };
      b.status = paid >= num(b.total.amount) - 0.005 ? "paid" : "part_paid";
      return e;
    }),

  /** GET /bank-accounts */
  bankAccounts: () => mock(() => (guard(), accountsWithBalances().filter((a) => a.isBank || a.kind === "cash"))),

  /** GET /transfers */
  transfers: () => mock(() => (guard(), entriesTable().filter((e) => e.source === "transfer").sort((a, b) => b.date.localeCompare(a.date)))),

  /** POST /transfers (entry goes for approval) */
  createTransfer: (input: { fromId: string; toId: string; amount: number; currency: Currency; rate: string; date: string; note: string }) =>
    mock(() => {
      const v = guard("finance.entry_create");
      if (input.fromId === input.toId) throw new ApiError("validation", "Choose two different accounts.");
      return saveEntry(
        {
          date: input.date,
          description: input.note || "Transfer between bank accounts",
          currency: input.currency,
          exchangeRate: input.currency === "PKR" ? "1" : input.rate,
          source: "transfer",
          lines: [
            { accountId: input.toId, debit: m2(input.amount), credit: "0.00" },
            { accountId: input.fromId, debit: "0.00", credit: m2(input.amount) },
          ],
          submit: true,
        },
        v.employee.empId,
      );
    }),

  /** GET /bank-statements?account&month (statement lines + ledger cash lines) */
  reconciliation: (bankAccountId: string, month: string) =>
    mock(() => {
      guard();
      suggestMatches(bankAccountId, month);
      return {
        statement: statementTable().filter((s) => s.bankAccountId === bankAccountId && monthKeyOf(s.date) === month),
        ledger: cashLines(bankAccountId, month),
      };
    }),

  /** POST /bank-statements (CSV import) */
  importStatement: (bankAccountId: string, rows: { date: string; description: string; amount: number }[]) =>
    mock(() => {
      guard("finance.entry_create");
      const months = new Set(rows.map((r) => monthKeyOf(r.date)));
      const list = statementTable();
      for (let i = list.length - 1; i >= 0; i--) if (list[i].bankAccountId === bankAccountId && months.has(monthKeyOf(list[i].date))) list.splice(i, 1);
      rows.forEach((r) => list.push({ id: uid("bs"), bankAccountId, date: r.date, description: r.description, amount: m2(r.amount) }));
      return rows.length;
    }),

  /** POST /bank-statements/lines/:id/match { lineKey } (null = unmatch) */
  match: (statementLineId: string, lineKey: string | null) =>
    mock(() => {
      guard("finance.entry_create");
      const s = statementTable().find((x) => x.id === statementLineId);
      if (!s) notFound("Statement line");
      s.matchedLineKey = lineKey ?? undefined;
      if (!lineKey) s.suggestion = undefined;
    }, { delay: 80 }),

  /** POST /bank-statements/auto-match */
  acceptSuggestions: (bankAccountId: string, month: string) =>
    mock(() => {
      guard("finance.entry_create");
      suggestMatches(bankAccountId, month);
      let n = 0;
      statementTable().forEach((s) => {
        if (s.bankAccountId === bankAccountId && monthKeyOf(s.date) === month && !s.matchedLineKey && s.suggestion && !s.suggestion.startsWith("entry:")) {
          s.matchedLineKey = s.suggestion;
          n++;
        }
      });
      return n;
    }),

  /** POST /bank-statements/lines/:id/create-entry (missing in ledger → entry for approval) */
  entryFromStatement: (statementLineId: string, counterAccountId: string) =>
    mock(() => {
      const v = guard("finance.entry_create");
      const s = statementTable().find((x) => x.id === statementLineId);
      if (!s) notFound("Statement line");
      const amt = Math.abs(num(s.amount));
      const inflow = num(s.amount) > 0;
      const e = saveEntry(
        {
          date: s.date,
          description: `Bank: ${s.description.toLowerCase()}`,
          currency: "PKR",
          exchangeRate: "1",
          source: "manual",
          lines: [
            { accountId: s.bankAccountId, debit: inflow ? m2(amt) : "0.00", credit: inflow ? "0.00" : m2(amt) },
            { accountId: counterAccountId, debit: inflow ? "0.00" : m2(amt), credit: inflow ? m2(amt) : "0.00" },
          ],
          submit: true,
        },
        v.employee.empId,
      );
      s.suggestion = `entry:${e.id}`;
      return e;
    }),

  /** GET /periods (with the live close checklist) */
  periods: () =>
    mock<FinancePeriod[]>(() => {
      guard();
      return [...periodsTable()].sort((a, b) => b.month.localeCompare(a.month)).map((p) => ({ ...p, checklist: checklistFor(p.month) }));
    }),

  /** GET /periods/:month/revaluation?rate */
  revaluationPreview: (month: string, rate?: number) => mock(() => (guard(), revaluationPreview(month, rate ?? currentRate()))),

  /** POST /periods/:month/revalue { rate } → revaluation entry for approval */
  postRevaluation: (month: string, rate: number) =>
    mock(() => {
      const v = guard("finance.entry_create");
      const p = revaluationPreview(month, rate);
      const lines = p.rows
        .filter((r) => Math.abs(num(r.difference)) >= 0.01)
        .flatMap((r) => {
          const d = num(r.difference);
          return d > 0
            ? [
                { accountId: r.accountId, debit: "0.00", credit: "0.00", baseDebit: m2(d), baseCredit: "0.00" },
                { accountId: "acc-4900", debit: "0.00", credit: "0.00", baseDebit: "0.00", baseCredit: m2(d) },
              ]
            : [
                { accountId: "acc-5900", debit: "0.00", credit: "0.00", baseDebit: m2(-d), baseCredit: "0.00" },
                { accountId: r.accountId, debit: "0.00", credit: "0.00", baseDebit: "0.00", baseCredit: m2(-d) },
              ];
        });
      if (!lines.length) throw new ApiError("validation", "Nothing to revalue at this rate.");
      // Base-only lines: write PKR amounts so the entry balances in PKR.
      const pkrLines = lines.map((l) => ({ ...l, debit: l.baseDebit, credit: l.baseCredit, baseDebit: undefined, baseCredit: undefined }));
      const e = saveEntry(
        { date: new Date().toISOString(), description: `Month-end revaluation of USD balances at ${rate.toFixed(2)}`, currency: "PKR", exchangeRate: "1", source: "revaluation", lines: pkrLines, submit: true },
        v.employee.empId,
      );
      const rates = ratesTable();
      const cur = rates.find((r) => r.month === month);
      if (cur) cur.rate = rate.toFixed(2);
      else rates.push({ month, rate: rate.toFixed(2) });
      return e;
    }),

  /** POST /periods/:month/close (the finance person runs it) */
  runClose: (month: string) => mock(() => closeMonth(month, guard().employee.empId)),

  /** POST /periods/:month/approve-close (Director only) */
  approveClose: (month: string) => mock(() => approveClose(month, guard().employee.empId)),

  /** POST /periods/:month/reject-close { reason } (Director only) */
  rejectClose: (month: string, reason: string) => mock(() => rejectClose(month, guard().employee.empId, reason)),

  /** POST /periods/:month/reopen { reason } (Director only, step-up; logged and the CEO / Founder / Owner is notified) */
  reopen: (month: string, reason: string) => mock(() => reopenMonth(month, guard().employee.empId, reason)),

  /** GET /exchange-rates */
  rates: () => mock(() => (guard(), ratesTable())),

  /** GET /projects */
  projects: () => mock(() => projectsList(), { delay: 60 }),

  /** GET /settings/approval-limits */
  approvalLimits: () => mock(() => APPROVAL_LIMITS, { delay: 60 }),
};

export type { JournalEntry };
