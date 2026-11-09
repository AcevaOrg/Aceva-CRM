"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth/session";
import { approvalsApi } from "./api";
import type { ApprovalItem, DecideOptions } from "./types";

export const approvalKeys = { all: ["approvals"] as const, list: (empId: string | null) => ["approvals", "list", empId] as const };

export function useApprovals() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: approvalKeys.list(empId), queryFn: approvalsApi.list, enabled: !!empId });
}

export function useApprovalsCount() {
  return useApprovals().data?.items.length ?? 0;
}

/**
 * Approve or reject from the inbox. Invalidates everything because an approval
 * changes the source module's data too (leave, tasks, ledger …).
 */
export function useDecide() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ item, decision, opts }: { item: ApprovalItem; decision: "approve" | "reject"; opts?: DecideOptions }) =>
      approvalsApi.decide(item, decision, opts),
    onSuccess: () => qc.invalidateQueries(),
  });
}
