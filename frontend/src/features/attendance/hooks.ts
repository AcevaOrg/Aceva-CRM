"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth/session";
import { useTodayCheck } from "@/components/layout/topbar-widgets";
import { isLive } from "@/lib/api/http";
import { attendanceApi } from "./api";
import { liveAttendanceApi } from "./live-api";
import { HOLIDAYS as MOCK_HOLIDAYS } from "@/mocks/seed/calendar";
import type { Holiday, NewCorrectionInput, NewLeaveInput } from "./types";

export const attendanceKeys = {
  all: ["attendance"] as const,
  month: (empId: string, month: string, today?: string) => ["attendance", "month", empId, month, today] as const,
  teamToday: (empId: string | null, today?: string) => ["attendance", "team-today", empId, today] as const,
  teamMonth: (empId: string | null, month: string) => ["attendance", "team-month", empId, month] as const,
  corrections: (empId: string | null, scope: string) => ["attendance", "corrections", empId, scope] as const,
  balances: (empId: string | null) => ["attendance", "balances", empId] as const,
  requests: (empId: string | null, scope: string) => ["attendance", "leave-requests", empId, scope] as const,
  calendar: (empId: string | null, month: string) => ["attendance", "leave-calendar", empId, month] as const,
};

/** A string that changes when the viewer checks in or out, so dependent queries refetch. */
function useTodayStamp() {
  const c = useTodayCheck();
  return `${c?.in ?? ""}|${c?.out ?? ""}`;
}

/** One person's month (defaults to the viewer). */
export function useMonthAttendance(month: string, empId?: string) {
  const me = useSession((s) => s.empId);
  const stamp = useTodayStamp();
  const id = empId ?? me ?? "";
  return useQuery({ queryKey: attendanceKeys.month(id, month, stamp), queryFn: () => attendanceApi.month(id, month), enabled: !!id });
}

/**
 * Who's in today for the viewer's team.
 * Returns TeamTodayRow[]: { empId, state: "in"|"late"|"not_in"|"leave"|"checked_out"|"off", checkIn?, checkOut?, firstLogin?, lateMinutes?, leaveTypeName? }
 */
export function useTeamToday() {
  const me = useSession((s) => s.empId);
  const stamp = useTodayStamp();
  return useQuery({ queryKey: attendanceKeys.teamToday(me, stamp), queryFn: attendanceApi.teamToday, enabled: !!me });
}

export function useTeamMonth(month: string) {
  const me = useSession((s) => s.empId);
  return useQuery({ queryKey: attendanceKeys.teamMonth(me, month), queryFn: () => attendanceApi.teamMonth(month), enabled: !!me });
}

export function useCorrections(scope: "mine" | "team") {
  const me = useSession((s) => s.empId);
  return useQuery({ queryKey: attendanceKeys.corrections(me, scope), queryFn: () => attendanceApi.corrections(scope), enabled: !!me });
}

export function useLeaveTypes() {
  return useQuery({ queryKey: ["attendance", "leave-types"], queryFn: attendanceApi.leaveTypes, staleTime: Infinity });
}

export function useAttendanceHolidays() {
  return useQuery({ queryKey: ["attendance", "holidays"], queryFn: attendanceApi.holidays, staleTime: Infinity });
}

/** The company holiday calendar for the screens: the server's in live mode (m7), the demo seed otherwise. */
export function useHolidayList(): Holiday[] {
  const q = useAttendanceHolidays();
  return isLive("m7") ? (q.data ?? []) : MOCK_HOLIDAYS;
}

/**
 * Leave balances (defaults to the viewer).
 * Returns LeaveBalanceView[]: { leaveTypeId, leaveType: { name, color, yearlyDays, paid }, total, used, pending, remaining: number | null }
 */
export function useLeaveBalances(empId?: string) {
  const me = useSession((s) => s.empId);
  const id = empId ?? me;
  return useQuery({ queryKey: attendanceKeys.balances(id), queryFn: () => attendanceApi.balances(id ?? undefined), enabled: !!id });
}

export function useLeaveRequests(scope: "mine" | "team") {
  const me = useSession((s) => s.empId);
  return useQuery({ queryKey: attendanceKeys.requests(me, scope), queryFn: () => attendanceApi.leaveRequests(scope), enabled: !!me });
}

export function useLeaveCalendar(month: string) {
  const me = useSession((s) => s.empId);
  return useQuery({ queryKey: attendanceKeys.calendar(me, month), queryFn: () => attendanceApi.calendar(month), enabled: !!me });
}

export function useLeaveClashes(from: string, to: string) {
  const me = useSession((s) => s.empId);
  return useQuery({ queryKey: ["attendance", "clashes", me, from, to], queryFn: () => attendanceApi.clashes(from, to), enabled: !!me && !!from && !!to && to >= from });
}

/**
 * Live (m7): the server's own count of a planned leave, the balance after it and who would approve it (Module 1 routing).
 * Errors (no working days, past month...) are left to the form; the server answers again when the request is sent.
 */
export function useLeavePreview(leaveTypeId: string, from: string, to: string, halfDay: boolean) {
  const me = useSession((s) => s.empId);
  return useQuery({
    queryKey: ["attendance", "leave-preview", me, leaveTypeId, from, to, halfDay],
    queryFn: () => liveAttendanceApi.preview(leaveTypeId, from, to, halfDay),
    enabled: isLive("m7") && !!me && !!leaveTypeId && !!from && !!to && to >= from,
    retry: false,
  });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["attendance"] });
    qc.invalidateQueries({ queryKey: ["approvals"] });
  };
}

export function useRequestLeave() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (input: NewLeaveInput) => attendanceApi.requestLeave(input), onSuccess: done });
}

export function useCancelLeave() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (id: string) => attendanceApi.cancelLeave(id), onSuccess: done });
}

export function useDecideLeave() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, approve, note }: { id: string; approve: boolean; note?: string }) => attendanceApi.decideLeave(id, approve, note), onSuccess: done });
}

export function useRequestCorrection() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (input: NewCorrectionInput) => attendanceApi.requestCorrection(input), onSuccess: done });
}

export function useDecideCorrection() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, approve, note }: { id: string; approve: boolean; note?: string }) => attendanceApi.decideCorrection(id, approve, note), onSuccess: done });
}

/** Call after checking in or out so calendars and team boards refresh. */
export function useRefreshAttendance() {
  return useInvalidate();
}
