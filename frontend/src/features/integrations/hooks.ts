"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth/session";
import { integrationsApi } from "./api";
import type { ToolId } from "./types";

export const integrationKeys = {
  all: ["integrations"] as const,
  overview: (empId: string | null) => ["integrations", "overview", empId] as const,
  tool: (tool: ToolId) => ["integrations", "tool", tool] as const,
  runs: ["integrations", "runs"] as const,
  mailboxes: ["integrations", "mailboxes"] as const,
  unmatched: ["integrations", "unmatched"] as const,
};

export function useIntegrationsOverview() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: integrationKeys.overview(empId), queryFn: integrationsApi.overview, enabled: !!empId });
}

export function useTool(tool: ToolId) {
  return useQuery({ queryKey: integrationKeys.tool(tool), queryFn: () => integrationsApi.get(tool) });
}

export function useSyncRuns() {
  return useQuery({ queryKey: integrationKeys.runs, queryFn: integrationsApi.syncRuns });
}

export function useMailboxes() {
  return useQuery({ queryKey: integrationKeys.mailboxes, queryFn: integrationsApi.mailboxes });
}

export function useUnmatched() {
  return useQuery({ queryKey: integrationKeys.unmatched, queryFn: integrationsApi.unmatched });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["integrations"] });
    qc.invalidateQueries({ queryKey: ["sales"] });
  };
}

export function useSaveKey() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ tool, key, imapHost }: { tool: ToolId; key: string; imapHost?: string }) => integrationsApi.saveKey(tool, key, imapHost), onSuccess: done });
}

export function useTestConnection() {
  return useMutation({ mutationFn: (tool: ToolId) => integrationsApi.test(tool) });
}

export function useLinkUser() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ tool, externalUserId, empId }: { tool: ToolId; externalUserId: string; empId: string | null }) => integrationsApi.linkUser(tool, externalUserId, empId),
    onSuccess: done,
  });
}

export function useUpdateConnection() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ tool, patch }: { tool: ToolId; patch: { syncEveryMin?: 15 | 30; status?: "working" | "paused" } }) => integrationsApi.update(tool, patch),
    onSuccess: done,
  });
}

export function useSyncNow() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (tool: ToolId) => integrationsApi.syncNow(tool), onSuccess: done });
}

export function usePauseMailbox() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ mailbox, paused }: { mailbox: string; paused: boolean }) => integrationsApi.pauseMailbox(mailbox, paused), onSuccess: done });
}
