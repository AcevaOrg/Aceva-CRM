"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth/session";
import { useCan } from "@/lib/auth/viewer";
import { activityApi } from "./api";
import type { ActivityQuery } from "./types";

export const activityKeys = {
  all: ["activity"] as const,
  online: (empId: string | null) => ["activity", "online", empId] as const,
  events: (empId: string | null, q: ActivityQuery) => ["activity", "events", empId, q] as const,
  summaries: (empId: string | null, from: string, to: string) => ["activity", "summaries", empId, from, to] as const,
  timeline: (empId: string, date: string) => ["activity", "timeline", empId, date] as const,
  alerts: (empId: string | null) => ["activity", "alerts", empId] as const,
  locks: (empId: string | null) => ["activity", "locks", empId] as const,
  mine: (empId: string | null) => ["activity", "mine", empId] as const,
};

/**
 * Who is signed in right now (CEO / Founder, Director, CTO — each within their reporting line). Returns OnlineSession[]:
 * { sessionId, empId, since, currentScreen, state: "active" | "idle", device, city, newDevice? }.
 * Disabled (no data) for viewers without activity.view_all.
 */
export function useOnlineNow() {
  const empId = useSession((s) => s.empId);
  const allowed = useCan("activity.view_all");
  return useQuery({ queryKey: activityKeys.online(empId), queryFn: activityApi.online, enabled: !!empId && allowed, refetchInterval: 60_000 });
}

/**
 * Security alerts. Returns SecurityAlert[] filtered by status (default "open"):
 * { id, rule, severity: "low" | "medium" | "high", empId, at, details, status, checkedBy?, note?, kind? }.
 * CTO, Director and CEO / Founder (activity.security). Disabled for everyone else.
 */
export function useSecurityAlerts(status: "open" | "checked" | "all" = "open") {
  const empId = useSession((s) => s.empId);
  const allowed = useCan("activity.security");
  return useQuery({
    queryKey: activityKeys.alerts(empId),
    queryFn: activityApi.alerts,
    enabled: !!empId && allowed,
    select: (list) => (status === "all" ? list : list.filter((a) => a.status === status)).sort((a, b) => b.at.localeCompare(a.at)),
  });
}

export function useActivityEvents(q: ActivityQuery) {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: activityKeys.events(empId, q), queryFn: () => activityApi.events(q), enabled: !!empId });
}

export function useDailySummaries(from: string, to: string) {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: activityKeys.summaries(empId, from, to), queryFn: () => activityApi.summaries(from, to), enabled: !!empId });
}

export function useTimeline(empId: string, date: string) {
  return useQuery({ queryKey: activityKeys.timeline(empId, date), queryFn: () => activityApi.timeline(empId, date), enabled: !!empId && !!date });
}

export function useAccountLocks() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: activityKeys.locks(empId), queryFn: activityApi.locks, enabled: !!empId });
}

export function useMyActivity() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: activityKeys.mine(empId), queryFn: activityApi.mine, enabled: !!empId, refetchInterval: 30_000 });
}

function useDone() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["activity"] });
    qc.invalidateQueries({ queryKey: ["people"] });
  };
}

export function useCheckAlert() {
  const done = useDone();
  return useMutation({ mutationFn: ({ id, note }: { id: string; note: string }) => activityApi.checkAlert(id, note), onSuccess: done });
}

export function useForceLogout() {
  const done = useDone();
  return useMutation({ mutationFn: ({ sessionId, reason }: { sessionId: string; reason: string }) => activityApi.forceLogout(sessionId, reason), onSuccess: done });
}

export function useLockAccount() {
  const done = useDone();
  return useMutation({ mutationFn: ({ empId, reason }: { empId: string; reason: string }) => activityApi.lock(empId, reason), onSuccess: done });
}

export function useUnlockAccount() {
  const done = useDone();
  return useMutation({ mutationFn: (empId: string) => activityApi.unlock(empId), onSuccess: done });
}

export function useLogExport() {
  const done = useDone();
  return useMutation({ mutationFn: ({ rows, format }: { rows: number; format: string }) => activityApi.logExport(rows, format), onSuccess: done });
}
