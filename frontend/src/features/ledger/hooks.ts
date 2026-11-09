"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth/session";
import { ledgerApi } from "./api";
import type { EntryListParams, NewEntryInput, Party } from "./types";

export const ledgerKeys = {
  all: ["ledger"] as const,
  accounts: (u: string | null) => ["ledger", "accounts", u] as const,
  entries: (u: string | null, p: EntryListParams) => ["ledger", "entries", u, p] as const,
  entry: (id: string) => ["ledger", "entry", id] as const,
};

const useUser = () => useSession((s) => s.empId);

export function useAccounts() {
  const u = useUser();
  return useQuery({ queryKey: ledgerKeys.accounts(u), queryFn: ledgerApi.accounts, enabled: !!u });
}

export function useEntries(params: EntryListParams = {}) {
  const u = useUser();
  return useQuery({ queryKey: ledgerKeys.entries(u, params), queryFn: () => ledgerApi.entries(params), enabled: !!u });
}

export function useEntry(id: string | undefined) {
  return useQuery({ queryKey: ledgerKeys.entry(id ?? ""), queryFn: () => ledgerApi.entry(id!), enabled: !!id, retry: false });
}

export function useParties(kind?: Party["kind"]) {
  const u = useUser();
  return useQuery({ queryKey: ["ledger", "parties", u, kind ?? "all"], queryFn: () => ledgerApi.parties(kind), enabled: !!u });
}

export function usePartyEntries(partyId: string | undefined) {
  return useQuery({ queryKey: ["ledger", "party-entries", partyId], queryFn: () => ledgerApi.partyEntries(partyId!), enabled: !!partyId });
}

export function useReceivables() {
  const u = useUser();
  return useQuery({ queryKey: ["ledger", "receivables", u], queryFn: ledgerApi.receivables, enabled: !!u });
}

export function useBills() {
  const u = useUser();
  return useQuery({ queryKey: ["ledger", "bills", u], queryFn: ledgerApi.bills, enabled: !!u });
}

export function useBankAccounts() {
  const u = useUser();
  return useQuery({ queryKey: ["ledger", "bank-accounts", u], queryFn: ledgerApi.bankAccounts, enabled: !!u });
}

export function useTransfers() {
  const u = useUser();
  return useQuery({ queryKey: ["ledger", "transfers", u], queryFn: ledgerApi.transfers, enabled: !!u });
}

export function useReconciliation(bankAccountId: string, month: string) {
  return useQuery({ queryKey: ["ledger", "reconciliation", bankAccountId, month], queryFn: () => ledgerApi.reconciliation(bankAccountId, month) });
}

export function usePeriods() {
  const u = useUser();
  return useQuery({ queryKey: ["ledger", "periods", u], queryFn: ledgerApi.periods, enabled: !!u });
}

export function useRevaluationPreview(month: string, rate?: number) {
  return useQuery({ queryKey: ["ledger", "revaluation", month, rate], queryFn: () => ledgerApi.revaluationPreview(month, rate) });
}

export function useRates() {
  const u = useUser();
  return useQuery({ queryKey: ["ledger", "rates", u], queryFn: ledgerApi.rates, enabled: !!u, staleTime: 5 * 60_000 });
}

export function useFinanceProjects() {
  return useQuery({ queryKey: ["ledger", "projects"], queryFn: ledgerApi.projects, staleTime: Infinity });
}

/** Invalidate ledger + statements + analysis + approvals after any change. */
export function useInvalidateFinance() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["ledger"] });
    qc.invalidateQueries({ queryKey: ["statements"] });
    qc.invalidateQueries({ queryKey: ["analysis"] });
    qc.invalidateQueries({ queryKey: ["approvals"] });
  };
}

function useFinanceMutation<A, R>(fn: (a: A) => Promise<R>) {
  const done = useInvalidateFinance();
  return useMutation({ mutationFn: fn, onSuccess: done });
}

export const useSaveEntry = () => useFinanceMutation((input: NewEntryInput) => ledgerApi.saveEntry(input));
export const useSubmitEntry = () => useFinanceMutation((id: string) => ledgerApi.submit(id));
export const useApproveEntry = () => useFinanceMutation((id: string) => ledgerApi.approve(id));
export const useRejectEntry = () => useFinanceMutation(({ id, reason }: { id: string; reason: string }) => ledgerApi.reject(id, reason));
export const useReverseEntry = () => useFinanceMutation(({ id, reason }: { id: string; reason: string }) => ledgerApi.reverse(id, reason));
export const useCreateAccount = () => useFinanceMutation(ledgerApi.createAccount);
export const useCreateParty = () => useFinanceMutation(ledgerApi.createParty);
export const useCreateBill = () => useFinanceMutation(ledgerApi.createBill);
export const usePayBill = () => useFinanceMutation(({ billId, amount, bankAccountId }: { billId: string; amount: number; bankAccountId: string }) => ledgerApi.payBill(billId, amount, bankAccountId));
export const useCreateTransfer = () => useFinanceMutation(ledgerApi.createTransfer);
export const useImportStatement = () =>
  useFinanceMutation(({ bankAccountId, rows }: { bankAccountId: string; rows: { date: string; description: string; amount: number }[] }) => ledgerApi.importStatement(bankAccountId, rows));
export const useMatchLine = () => useFinanceMutation(({ statementLineId, lineKey }: { statementLineId: string; lineKey: string | null }) => ledgerApi.match(statementLineId, lineKey));
export const useAcceptSuggestions = () => useFinanceMutation(({ bankAccountId, month }: { bankAccountId: string; month: string }) => ledgerApi.acceptSuggestions(bankAccountId, month));
export const useEntryFromStatement = () =>
  useFinanceMutation(({ statementLineId, counterAccountId }: { statementLineId: string; counterAccountId: string }) => ledgerApi.entryFromStatement(statementLineId, counterAccountId));
export const usePostRevaluation = () => useFinanceMutation(({ month, rate }: { month: string; rate: number }) => ledgerApi.postRevaluation(month, rate));
export const useRunClose = () => useFinanceMutation((month: string) => ledgerApi.runClose(month));
export const useApproveClose = () => useFinanceMutation((month: string) => ledgerApi.approveClose(month));
export const useRejectClose = () => useFinanceMutation(({ month, reason }: { month: string; reason: string }) => ledgerApi.rejectClose(month, reason));
export const useReopenMonth = () => useFinanceMutation(({ month, reason }: { month: string; reason: string }) => ledgerApi.reopen(month, reason));
export const useCorrection = () =>
  useFinanceMutation(({ entryId, lineId, field, value }: { entryId: string; lineId: string; field: "description" | "debit" | "credit"; value: string }) =>
    ledgerApi.correction(entryId, lineId, field, value),
  );
