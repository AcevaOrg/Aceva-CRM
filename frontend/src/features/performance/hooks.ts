"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth/session";
import { performanceApi } from "./api";

export const performanceKeys = {
  all: ["performance"] as const,
  live: (viewer: string | null, empId?: string) => ["performance", "live", viewer, empId ?? "me"] as const,
  latest: (viewer: string | null, empId?: string) => ["performance", "latest", viewer, empId ?? "me"] as const,
  list: (viewer: string | null, empId?: string) => ["performance", "list", viewer, empId ?? "me"] as const,
  detail: (id: string) => ["performance", "detail", id] as const,
  team: (viewer: string | null) => ["performance", "team", viewer] as const,
  disputes: (viewer: string | null) => ["performance", "disputes", viewer] as const,
};

/**
 * This month's live figures (defaults to the viewer).
 * Returns LivePerformance: { empId, month, kind: "standard"|"sales", metrics, score (0–100), band, taskCount, smallSample, weights, trend: { month, score }[], tasks }
 */
export function useLivePerformance(empId?: string) {
  const me = useSession((s) => s.empId);
  return useQuery({ queryKey: performanceKeys.live(me, empId), queryFn: () => performanceApi.live(empId), enabled: !!me });
}

/**
 * The newest scorecard the viewer may see (defaults to the viewer; their own drafts are hidden).
 * Returns Scorecard | null: { id, month, kind, metrics, score, band, status: "draft"|"released"|"acknowledged", reviewerRemark?, … }
 */
export function useLatestScorecard(empId?: string) {
  const me = useSession((s) => s.empId);
  return useQuery({ queryKey: performanceKeys.latest(me, empId), queryFn: () => performanceApi.latest(empId), enabled: !!me });
}

export function useScorecards(empId?: string) {
  const me = useSession((s) => s.empId);
  return useQuery({ queryKey: performanceKeys.list(me, empId), queryFn: () => performanceApi.list(empId), enabled: !!me });
}

export function useScorecard(id: string) {
  return useQuery({ queryKey: performanceKeys.detail(id), queryFn: () => performanceApi.get(id) });
}

export function useTeamPerformance() {
  const me = useSession((s) => s.empId);
  return useQuery({ queryKey: performanceKeys.team(me), queryFn: performanceApi.team, enabled: !!me });
}

export function useDisputes() {
  const me = useSession((s) => s.empId);
  return useQuery({ queryKey: performanceKeys.disputes(me), queryFn: performanceApi.disputes, enabled: !!me });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["performance"] });
    qc.invalidateQueries({ queryKey: ["approvals"] });
  };
}

export function useAddRemark() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, remark }: { id: string; remark: string }) => performanceApi.remark(id, remark), onSuccess: done });
}

export function useReleaseScorecard() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, remark }: { id: string; remark?: string }) => performanceApi.release(id, remark), onSuccess: done });
}

export function useAcknowledgeScorecard() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, comment }: { id: string; comment?: string }) => performanceApi.acknowledge(id, comment), onSuccess: done });
}

export function useRaiseDispute() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ scorecardId, taskNumber, reason }: { scorecardId: string; taskNumber: string; reason: string }) => performanceApi.raiseDispute(scorecardId, taskNumber, reason),
    onSuccess: done,
  });
}

export function useDecideDispute() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, change, decision, newRating }: { id: string; change: boolean; decision: string; newRating?: number }) => performanceApi.decideDispute(id, change, decision, newRating),
    onSuccess: done,
  });
}
