"use client";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth/session";
import { statementsApi } from "./api";
import type { StatementParams } from "./types";

export function useStatement(p: StatementParams) {
  const u = useSession((s) => s.empId);
  return useQuery({ queryKey: ["statements", "get", u, p], queryFn: () => statementsApi.get(p), enabled: !!u, placeholderData: keepPreviousData });
}

export function useStatementAccounts() {
  return useQuery({ queryKey: ["statements", "accounts"], queryFn: statementsApi.accounts, staleTime: 60_000 });
}

export function useMarkFinal() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (p: StatementParams) => statementsApi.markFinal(p), onSuccess: () => qc.invalidateQueries({ queryKey: ["statements"] }) });
}
