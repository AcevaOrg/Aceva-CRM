"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth/session";
import { useCan } from "@/lib/auth/viewer";
import { billingApi } from "./api";
import type { BillingSettings } from "@aceva/contracts";
import type { NewCustomerInput, NewInvoiceInput, RecordPaymentInput, RenewalDecision, Subscription, SubscriptionCostInput } from "./types";

export const billingKeys = {
  all: ["billing"] as const,
  overview: (empId: string | null) => ["billing", "overview", empId] as const,
  invoices: (empId: string | null) => ["billing", "invoices", empId] as const,
  invoice: (id: string) => ["billing", "invoice", id] as const,
  customers: (empId: string | null) => ["billing", "customers", empId] as const,
  customerList: ["billing", "customer-list"] as const,
  payments: (empId: string | null) => ["billing", "payments", empId] as const,
  subscriptions: (empId: string | null) => ["billing", "subscriptions", empId] as const,
  decisions: (empId: string | null) => ["billing", "renewal-decisions", empId] as const,
  banks: ["billing", "bank-accounts"] as const,
  settings: ["billing", "settings"] as const,
};

/**
 * Billing overview for dashboards: billed/collected this month, outstanding and overdue (PKR),
 * upcoming due invoices, renewals in the next 14 days, drafts created from Won deals.
 * Disabled (no request) for people without billing.view.
 */
export function useBillingOverview() {
  const empId = useSession((s) => s.empId);
  const allowed = useCan("billing.view");
  return useQuery({ queryKey: billingKeys.overview(empId), queryFn: billingApi.overview, enabled: !!empId && allowed });
}

export function useInvoices() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: billingKeys.invoices(empId), queryFn: billingApi.invoices, enabled: !!empId });
}

export function useInvoice(id: string) {
  return useQuery({ queryKey: billingKeys.invoice(id), queryFn: () => billingApi.invoice(id) });
}

export function useCustomers() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: billingKeys.customers(empId), queryFn: billingApi.customers, enabled: !!empId });
}

export function useCustomerList() {
  return useQuery({ queryKey: billingKeys.customerList, queryFn: billingApi.customerList, staleTime: 5 * 60_000 });
}

export function usePayments() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: billingKeys.payments(empId), queryFn: billingApi.payments, enabled: !!empId });
}

export function useSubscriptions() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: billingKeys.subscriptions(empId), queryFn: billingApi.subscriptions, enabled: !!empId });
}

export function useRenewalDecisions() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: billingKeys.decisions(empId), queryFn: billingApi.renewalDecisions, enabled: !!empId });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: billingKeys.all });
}

export function useCreateInvoice() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ input, send }: { input: NewInvoiceInput; send: boolean }) => billingApi.create(input, send), onSuccess: done });
}

export function useSendInvoice() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (id: string) => billingApi.send(id), onSuccess: done });
}

export function useCancelInvoice() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => billingApi.cancel(id, reason), onSuccess: done });
}

export function useRecordPayment() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, input }: { id: string; input: RecordPaymentInput }) => billingApi.recordPayment(id, input), onSuccess: done });
}

export function useSaveSubscription() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (s: Omit<Subscription, "status"> & { status?: Subscription["status"] }) => billingApi.saveSubscription(s), onSuccess: done });
}

export function useDecideRenewal() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, decision, note, newCost }: { id: string; decision: RenewalDecision["decision"]; note?: string; newCost?: string }) =>
      billingApi.decideRenewal(id, decision, note, newCost),
    onSuccess: done,
  });
}

export function useAddUsageReading() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, used, estimatedCost }: { id: string; used: number; estimatedCost?: string }) => billingApi.addUsageReading(id, used, estimatedCost), onSuccess: done });
}

/** Module 9 bank accounts a payment can be received in (live; the finance duty person sees them). */
export function useBankAccounts(enabled = true) {
  return useQuery({ queryKey: billingKeys.banks, queryFn: billingApi.bankAccounts, enabled, staleTime: 5 * 60_000 });
}

export function useEmailInvoice() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (id: string) => billingApi.emailInvoice(id), onSuccess: done });
}

export function useRestoreInvoice() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (id: string) => billingApi.restoreInvoice(id), onSuccess: done });
}

export function useStopRecurring() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => billingApi.stopRecurring(id, reason), onSuccess: done });
}

export function useCreateCustomer() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (input: NewCustomerInput) => billingApi.createCustomer(input), onSuccess: done });
}

export function useResolveDealHandover() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, partyId }: { id: string; partyId: string }) => billingApi.resolveDealHandover(id, partyId), onSuccess: done });
}

export function useConfirmCustomer() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (id: string) => billingApi.confirmCustomer(id), onSuccess: done });
}

export function useSetSubscriptionCost() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, input }: { id: string; input: SubscriptionCostInput }) => billingApi.setSubscriptionCost(id, input), onSuccess: done });
}

/** Billing settings (company details on invoices, sending address, reminder timing). */
export function useBillingSettings(enabled = true) {
  return useQuery({ queryKey: billingKeys.settings, queryFn: billingApi.settings, enabled });
}

export function useSaveBillingSettings() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ value, version, reason }: { value: BillingSettings; version: number; reason: string }) => billingApi.saveSettings(value, version, reason), onSuccess: done });
}
