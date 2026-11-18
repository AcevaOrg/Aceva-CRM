"use client";
/**
 * Today's own check-in in LIVE mode (m7): the server is the only source (GET /attendance/today), and checking in or out is a
 * server call whose time comes from the server clock. The topbar pill, the check-in card and the command palette share this.
 * In mock mode nothing here runs: the session store keeps the browser-only demo state.
 */
import * as React from "react";
import { type QueryClient, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { TodayResponse } from "@aceva/contracts";
import { isLive } from "@/lib/api/http";
import { useSession } from "@/lib/auth/session";
import { liveAttendanceApi } from "./live-api";

export const TODAY_EVENT = "aceva:attendance-changed";
export const liveTodayKey = (empId: string | null) => ["attendance", "live-today", empId] as const;

/** Tell every screen that today's check-in changed (used by callers outside React Query, e.g. the session store). */
export function announceAttendanceChange() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(TODAY_EVENT));
}

/** The app's query client, kept so code outside React (the approvals provider) can refresh screens after a server call. */
let sharedClient: QueryClient | null = null;
export function refreshQueries(queryKey?: readonly unknown[]) {
  void sharedClient?.invalidateQueries(queryKey ? { queryKey } : undefined);
}

export function useLiveToday() {
  const live = isLive("m7");
  const empId = useSession((s) => s.empId);
  const qc = useQueryClient();
  React.useEffect(() => {
    sharedClient = qc;
    if (!live) return;
    const onChange = () => void qc.invalidateQueries({ queryKey: ["attendance"] });
    window.addEventListener(TODAY_EVENT, onChange);
    return () => window.removeEventListener(TODAY_EVENT, onChange);
  }, [live, qc]);
  return useQuery<TodayResponse>({
    queryKey: liveTodayKey(empId),
    queryFn: liveAttendanceApi.today,
    enabled: live && !!empId,
    refetchInterval: 60_000,
    staleTime: 15_000,
  });
}

/** Check in or out on the server; every attendance and approvals view refreshes afterwards. */
export function useLiveCheck() {
  const qc = useQueryClient();
  const empId = useSession((s) => s.empId);
  const done = (data: TodayResponse) => {
    qc.setQueryData(liveTodayKey(empId), data);
    void qc.invalidateQueries({ queryKey: ["attendance"] });
  };
  const checkIn = useMutation({ mutationFn: liveAttendanceApi.checkIn, onSuccess: done });
  const checkOut = useMutation({ mutationFn: liveAttendanceApi.checkOut, onSuccess: done });
  return { checkIn, checkOut };
}
