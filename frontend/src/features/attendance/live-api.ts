/**
 * Module 7 against the REAL API (NEXT_PUBLIC_LIVE_MODULES contains m7). Same function names and result shapes as the mock in
 * api.ts, so the screens do not change. The server decides everything (the time of a check-in, lateness, who approves, balances,
 * who sees whom); these functions only translate between the API and the shapes the screens use.
 */
import type {
  AttendanceDayView, AttendanceMonthResponse, CorrectionView, HolidayView, LeaveBalancesResponse, LeaveCalendarEntryView,
  LeaveChainStep, LeavePreviewResponse, LeaveRequestView, LeaveTypeView, OfficeNetworkView, Page, TeamMonthResponse,
  TeamTodayResponse, TodayResponse, WorkScheduleResponse, WorkScheduleView,
} from "@aceva/contracts";
import { ApiError } from "@/lib/api/mock";
import { http } from "@/lib/api/http";
import { useSession } from "@/lib/auth/session";
import type { ApprovalStep } from "@/types";
import type {
  AttendanceCorrection, AttendanceDay, Holiday, LeaveBalanceView, LeaveCalendarEntry, LeaveRequest, LeaveType,
  NewCorrectionInput, NewLeaveInput, TeamMonthRow, TeamTodayRow, WorkSchedule,
} from "./types";

const PKT_OFFSET_MS = 5 * 3600_000;
const FALLBACK_COLORS = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];

/** 'HH:MM' Pakistan time of an ISO instant (the server takes correction times as Pakistan clock times). */
export function pkClock(iso: string | undefined): string | undefined {
  if (!iso) return undefined;
  return new Date(new Date(iso).getTime() + PKT_OFFSET_MS).toISOString().slice(11, 16);
}

/** Today in Pakistan, 'YYYY-MM-DD'. */
export function pkToday(): string {
  return new Date(Date.now() + PKT_OFFSET_MS).toISOString().slice(0, 10);
}

const opt = <T>(v: T | null | undefined): T | undefined => (v === null || v === undefined ? undefined : v);

export function mapSchedule(s: WorkScheduleView): WorkSchedule {
  const [sh, sm] = s.start.split(":").map(Number);
  const [eh] = s.end.split(":").map(Number);
  return { startHour: sh, startMinute: sm, graceMinutes: s.graceMinutes, endHour: eh, workingDays: s.workingWeekdays.map((d) => d % 7), officeOnlyCheckIn: s.officeOnlyCheckIn };
}

function mapDay(d: AttendanceDayView): AttendanceDay {
  return {
    empId: d.empId,
    date: d.date,
    checkIn: opt(d.checkIn),
    checkOut: opt(d.checkOut),
    status: d.status,
    lateMinutes: d.lateMinutes || undefined,
    firstLogin: opt(d.firstLogin),
    correctionId: opt(d.correctionId),
    note: opt(d.note),
  };
}

function mapCorrection(c: CorrectionView): AttendanceCorrection {
  return {
    id: c.id,
    empId: c.empId,
    date: c.date,
    original: { checkIn: opt(c.original.checkIn), checkOut: opt(c.original.checkOut) },
    requested: { checkIn: opt(c.requested.checkIn), checkOut: opt(c.requested.checkOut) },
    reason: c.reason,
    // A request withdrawn by its owner is closed like a refused one on these screens.
    status: c.status === "cancelled" ? "rejected" : c.status,
    decidedBy: opt(c.decidedBy),
    decidedAt: opt(c.decidedAt),
    decisionNote: c.status === "cancelled" ? "Withdrawn by the employee" : opt(c.decisionNote),
    at: c.createdAt,
    approverEmpId: c.approverEmpId,
    canDecide: c.canDecide,
  };
}

function mapType(t: LeaveTypeView, i: number): LeaveType {
  return { id: t.id, name: t.name, yearlyDays: t.yearlyDays ?? 0, paid: t.paid, color: t.color ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length] };
}

export function mapStep(s: LeaveChainStep): ApprovalStep {
  return { label: s.label, empId: opt(s.approverEmpId), state: s.state, at: opt(s.at), note: opt(s.note) };
}

function mapRequest(r: LeaveRequestView): LeaveRequest {
  return {
    id: r.id,
    number: r.number,
    empId: r.empId,
    leaveTypeId: r.leaveTypeId,
    from: r.from,
    to: r.to,
    days: r.days,
    halfDay: r.halfDay || undefined,
    reason: r.reason,
    status: r.status,
    chain: r.chain.map(mapStep),
    at: r.createdAt,
    canDecide: r.canDecide,
    canCancel: r.canCancel,
  };
}

/** Holidays and working weekdays cached for the synchronous day counter used while filling in the leave form. */
const cache: { holidays: Set<string>; weekdays: number[] } = { holidays: new Set(), weekdays: [1, 2, 3, 4, 5] };

async function loadHolidays(): Promise<Holiday[]> {
  const year = Number(pkToday().slice(0, 4));
  const lists = await Promise.all([year, year + 1].map((y) => http.get<HolidayView[]>("/holidays", { year: y })));
  const all = lists.flat().map((h) => ({ date: h.date, name: h.name }));
  cache.holidays = new Set(all.map((h) => h.date));
  return all;
}

function isoWeekday(day: string) {
  const d = new Date(`${day}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

function countDays(from: string, to: string, halfDay: boolean) {
  if (!from || !to || to < from) return 0;
  let n = 0;
  for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
    if (cache.weekdays.includes(isoWeekday(d)) && !cache.holidays.has(d)) n++;
  }
  return halfDay ? (n === 1 ? 0.5 : 0) : n;
}

const myEmpId = () => {
  const id = useSession.getState().empId;
  if (!id) throw new ApiError("unauthenticated", "Please log in", 401);
  return id;
};

async function allPages<T>(path: string, params: Record<string, string | number>): Promise<T[]> {
  const first = await http.get<Page<T>>(path, { ...params, page: 1, pageSize: 200 });
  const items = [...first.items];
  for (let page = 2; items.length < first.total && page <= 20; page++) {
    items.push(...(await http.get<Page<T>>(path, { ...params, page, pageSize: 200 })).items);
  }
  return items;
}

export const liveAttendanceApi = {
  /** GET /settings/work-schedule: the schedule in force today */
  schedule: async (): Promise<WorkSchedule> => {
    const res = await http.get<WorkScheduleResponse>("/settings/work-schedule");
    if (!res.current) throw new ApiError("not_found", "No work schedule is set yet", 404);
    cache.weekdays = res.current.workingWeekdays;
    return mapSchedule(res.current);
  },

  /** GET /holidays?year (this year and next) */
  holidays: loadHolidays,

  /** GET /attendance/employees/:empId?month */
  month: async (empId: string, month: string): Promise<AttendanceDay[]> =>
    (await http.get<AttendanceMonthResponse>(`/attendance/employees/${empId}`, { month })).days.map(mapDay),

  /** GET /attendance/team (people below the viewer; nobody below = an empty board) */
  teamToday: async (): Promise<TeamTodayRow[]> => {
    try {
      const res = await http.get<TeamTodayResponse>("/attendance/team");
      return res.rows.map((r) => ({
        empId: r.empId,
        state: r.state,
        checkIn: opt(r.checkIn),
        checkOut: opt(r.checkOut),
        firstLogin: opt(r.firstLogin),
        lateMinutes: r.lateMinutes || undefined,
        leaveTypeName: opt(r.leaveTypeName),
      }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) return [];
      throw e;
    }
  },

  /** GET /attendance/team/summary?month */
  teamMonth: async (month: string): Promise<TeamMonthRow[]> => {
    try {
      const res = await http.get<TeamMonthResponse>("/attendance/team/summary", { month });
      return res.rows.map((r) => ({
        empId: r.empId,
        present: r.present,
        late: r.late,
        leave: r.leave,
        absent: r.absent,
        missedCheckout: r.missedCheckouts,
        workingDays: r.workingDays,
        avgLoginGapMin: r.avgLoginGapMin,
        avgCheckIn: r.avgCheckIn,
      }));
    } catch (e) {
      if (e instanceof ApiError && e.status === 403) return [];
      throw e;
    }
  },

  /** GET /attendance/corrections?scope=mine|team */
  corrections: async (scope: "mine" | "team"): Promise<AttendanceCorrection[]> => {
    try {
      return (await allPages<CorrectionView>("/attendance/corrections", { scope })).map(mapCorrection);
    } catch (e) {
      if (scope === "team" && e instanceof ApiError && e.status === 403) return [];
      throw e;
    }
  },

  /** POST /attendance/corrections (times are sent as Pakistan clock times) */
  requestCorrection: async (input: NewCorrectionInput): Promise<AttendanceCorrection> =>
    mapCorrection(await http.post<CorrectionView>("/attendance/corrections", { date: input.date, checkIn: pkClock(input.checkIn), checkOut: pkClock(input.checkOut), reason: input.reason })),

  /** POST /attendance/corrections/:id/{approve|reject} */
  decideCorrection: async (id: string, approve: boolean, note?: string): Promise<void> => {
    if (approve) await http.post(`/attendance/corrections/${id}/approve`, { note: note || undefined });
    else await http.post(`/attendance/corrections/${id}/reject`, { reason: note ?? "" });
  },

  /** POST /attendance/corrections/:id/cancel */
  cancelCorrection: async (id: string): Promise<void> => {
    await http.post(`/attendance/corrections/${id}/cancel`, {});
  },

  /** GET /leave/types */
  leaveTypes: async (): Promise<LeaveType[]> => (await http.get<LeaveTypeView[]>("/leave/types")).map(mapType),

  /** GET /leave/balances/:empId?year */
  balances: async (empId?: string): Promise<LeaveBalanceView[]> => {
    const id = empId ?? myEmpId();
    const [res, types] = await Promise.all([http.get<LeaveBalancesResponse>(`/leave/balances/${id}`), http.get<LeaveTypeView[]>("/leave/types", { includeArchived: "true" })]);
    const typeIndex = new Map(types.map((t, i) => [t.id, mapType(t, i)]));
    return res.balances.map((b, i) => {
      const leaveType = typeIndex.get(b.leaveTypeId) ?? { id: b.leaveTypeId, name: b.name, yearlyDays: b.total ?? 0, paid: b.paid, color: b.color ?? FALLBACK_COLORS[i % FALLBACK_COLORS.length] };
      return { leaveTypeId: b.leaveTypeId, total: b.total ?? 0, used: b.used, pending: b.pending, leaveType, remaining: b.remaining };
    });
  },

  /** GET /leave/requests?scope=mine|team */
  leaveRequests: async (scope: "mine" | "team"): Promise<LeaveRequest[]> => (await allPages<LeaveRequestView>("/leave/requests", { scope })).map(mapRequest),

  /** Task deadlines inside a planned leave come from Module 5 (tasks); none are served by the attendance API. */
  clashes: (() => Promise.resolve([])) as (from: string, to: string) => Promise<{ taskId: string; number: string; title: string; deadline: string }[]>,

  /** POST /leave/requests */
  requestLeave: async (input: NewLeaveInput): Promise<LeaveRequest> =>
    mapRequest(await http.post<LeaveRequestView>("/leave/requests", { leaveTypeId: input.leaveTypeId, from: input.from, to: input.to, halfDay: input.halfDay, reason: input.reason })),

  /** POST /leave/requests/:id/cancel */
  cancelLeave: async (id: string): Promise<void> => {
    await http.post(`/leave/requests/${id}/cancel`, {});
  },

  /** POST /leave/requests/:id/{approve|reject} */
  decideLeave: async (id: string, approve: boolean, note?: string): Promise<void> => {
    if (approve) await http.post(`/leave/requests/${id}/approve`, { note: note || undefined });
    else await http.post(`/leave/requests/${id}/reject`, { reason: note ?? "" });
  },

  /** GET /leave/calendar?month */
  calendar: async (month: string): Promise<LeaveCalendarEntry[]> =>
    (await http.get<LeaveCalendarEntryView[]>("/leave/calendar", { month })).map((e) => ({
      requestId: e.requestId, empId: e.empId, leaveTypeId: e.leaveTypeId, from: e.from, to: e.to, status: e.status, deadlineClashes: [],
    })),

  /** Days in a request, for live counting in forms (the server counts again and decides). */
  countDays,

  /** GET /leave/preview: the server's own count and the balance after the request. */
  preview: (leaveTypeId: string, from: string, to: string, halfDay: boolean) =>
    http.get<LeavePreviewResponse>("/leave/preview", { leaveTypeId, from, to, halfDay: String(halfDay) }),

  // ---------------------------------------------------------------- today (check-in card and topbar pill)

  /** GET /attendance/today */
  today: () => http.get<TodayResponse>("/attendance/today"),
  /** POST /attendance/check-in (the server clock decides the time) */
  checkIn: () => http.post<TodayResponse>("/attendance/check-in", {}),
  /** POST /attendance/check-out */
  checkOut: () => http.post<TodayResponse>("/attendance/check-out", {}),
};

/** Settings for Module 7 (Director, settings.manage). Every change carries a reason that is kept in the audit log. */
export const liveAttendanceSettingsApi = {
  schedule: () => http.get<WorkScheduleResponse>("/settings/work-schedule"),
  newSchedule: (body: { effectiveFrom: string; start: string; end: string; graceMinutes: number; workingWeekdays: number[]; officeOnlyCheckIn: boolean; reason: string }) =>
    http.post<WorkScheduleResponse>("/settings/work-schedule", body),
  holidays: (year: number) => http.get<HolidayView[]>("/holidays", { year, includeArchived: "true" }),
  addHoliday: (body: { date: string; name: string; reason: string }) => http.post<HolidayView>("/holidays", body),
  archiveHoliday: (id: string, reason: string) => http.post<HolidayView>(`/holidays/${id}/archive`, { reason }),
  leaveTypes: () => http.get<LeaveTypeView[]>("/leave/types", { includeArchived: "true" }),
  addLeaveType: (body: { key: string; name: string; yearlyDays: number | null; paid: boolean; color?: string; reason: string }) => http.post<LeaveTypeView>("/leave/types", body),
  updateLeaveType: (id: string, body: { name?: string; yearlyDays?: number | null; paid?: boolean; reason: string }) => http.patch<LeaveTypeView>(`/leave/types/${id}`, body),
  archiveLeaveType: (id: string, reason: string) => http.post<LeaveTypeView>(`/leave/types/${id}/archive`, { reason }),
  officeNetworks: () => http.get<OfficeNetworkView[]>("/settings/office-networks"),
  addOfficeNetwork: (body: { officeCode: string; cidr: string; label?: string; reason: string }) => http.post<OfficeNetworkView>("/settings/office-networks", body),
  archiveOfficeNetwork: (id: string, reason: string) => http.post<OfficeNetworkView>(`/settings/office-networks/${id}/archive`, { reason }),
};
