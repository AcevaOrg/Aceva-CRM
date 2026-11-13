/**
 * Module 7 service functions. Mock today; each JSDoc names the real endpoint (spec §7.3).
 * Today's own check-in comes from the session store (the topbar pill and the check-in card share it).
 */
import { endOfMonth, startOfMonth } from "date-fns";
import { ApiError, mock, notFound } from "@/lib/api/mock";
import { isLive } from "@/lib/api/http";
import { descendantsOf, isInScope } from "@/lib/auth/scope";
import { useSession } from "@/lib/auth/session";
import { getViewer } from "@/lib/auth/viewer";
import { employeesTable } from "@/lib/directory";
import { isoDay, isWorkingDay } from "@/lib/dates";
import { uid } from "@/lib/utils";
import { nextNumber, table } from "@/mocks/db";
import { HOLIDAYS, HOLIDAY_DATES } from "@/mocks/seed/calendar";
import {
  LEAVE_TYPES, seedAttendance, seedBaseUsed, seedCorrections, seedLeaveRequests, TODAY_PLAN,
} from "@/mocks/seed/attendance";
import { tasksTable } from "@/features/tasks/api";
import { isOpen } from "@/features/tasks/logic";
import { liveAttendanceApi } from "./live-api";
import { averageClock, buildLeaveChain, correctionApprover, DEFAULT_SCHEDULE, isPendingLeave, lateMinutes, leaveDays, minutesBetween } from "./logic";
import type {
  AttendanceCorrection, AttendanceDay, LeaveBalanceView, LeaveCalendarEntry, LeaveRequest, LeaveType, NewCorrectionInput,
  NewLeaveInput, TeamMonthRow, TeamTodayRow,
} from "./types";

export const attendanceTable = () => table<AttendanceDay>("attendance.days", seedAttendance);
export const correctionsTable = () => table<AttendanceCorrection>("attendance.corrections", seedCorrections);
const leaveTypesTable = () => table<LeaveType>("attendance.leave_types", () => structuredClone(LEAVE_TYPES));
const baseUsedTable = () => table<{ empId: string; leaveTypeId: string; used: number }>("attendance.base_used", seedBaseUsed);
export const leaveRequestsTable = () => table<LeaveRequest>("attendance.leave_requests", seedLeaveRequests);

const holidayName = (iso: string) => HOLIDAYS.find((h) => h.date === iso)?.name;

function approvedLeaveOn(empId: string, iso: string) {
  return leaveRequestsTable().find((r) => r.empId === empId && r.status === "approved" && r.from <= iso && r.to >= iso);
}

function hm(day: Date, clock: string) {
  const [h, m] = clock.split(":").map(Number);
  const d = new Date(day);
  d.setHours(h, m, 0, 0);
  return d;
}

/** Today's record: the viewer's comes from the session; others from the seed plan. */
function todayRecord(empId: string): AttendanceDay {
  const now = new Date();
  const date = isoDay(now);
  const session = useSession.getState();
  if (empId === session.empId) {
    const c = session.checks[empId];
    if (c && c.date === date && c.in) {
      const lm = lateMinutes(c.in);
      return { empId, date, checkIn: c.in, checkOut: c.out, status: lm > 0 ? "late" : "on_time", lateMinutes: lm || undefined, firstLogin: session.signedInAt ?? undefined };
    }
    return { empId, date, status: "future", firstLogin: session.signedInAt ?? undefined };
  }
  const plan = TODAY_PLAN[empId];
  if (plan?.inAt) {
    const inAt = hm(now, plan.inAt);
    if (inAt <= now) {
      const lm = lateMinutes(inAt);
      const login = new Date(inAt.getTime() + (plan.loginGap ?? 2) * 60_000);
      return { empId, date, checkIn: inAt.toISOString(), status: lm > 0 ? "late" : "on_time", lateMinutes: lm || undefined, firstLogin: login <= now ? login.toISOString() : undefined };
    }
  }
  return { empId, date, status: "future" };
}

/** One day for one person, combining weekends, holidays, approved leave and check-ins. */
function dayFor(empId: string, date: Date): AttendanceDay {
  const iso = isoDay(date);
  const today = isoDay(new Date());
  const emp = employeesTable().find((e) => e.empId === empId);
  if (iso > today || (emp && iso < isoDay(emp.joiningDate))) return { empId, date: iso, status: "future" };
  const leave = approvedLeaveOn(empId, iso);
  const holiday = holidayName(iso);
  const weekend = date.getDay() === 0 || date.getDay() === 6;
  if (iso === today) {
    const rec = todayRecord(empId);
    if (rec.checkIn) return { ...rec, note: holiday };
    if (leave && !weekend && !holiday) return { empId, date: iso, status: "leave", note: leaveTypesTable().find((t) => t.id === leave.leaveTypeId)?.name };
    if (holiday) return { ...rec, status: "holiday", note: holiday };
    if (weekend) return { ...rec, status: "weekend" };
    return rec;
  }
  if (holiday) return { empId, date: iso, status: "holiday", note: holiday };
  if (weekend) return { empId, date: iso, status: "weekend" };
  if (leave) return { empId, date: iso, status: "leave", note: leaveTypesTable().find((t) => t.id === leave.leaveTypeId)?.name };
  const rec = attendanceTable().find((d) => d.empId === empId && d.date === iso);
  return rec ?? { empId, date: iso, status: "absent" };
}

function monthDays(month: string) {
  const [y, m] = month.split("-").map(Number);
  const start = startOfMonth(new Date(y, m - 1, 1));
  const end = endOfMonth(start);
  const out: Date[] = [];
  for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) out.push(new Date(d));
  return out;
}

/**
 * Attendance metric input for Performance (plan §10 "A"): days present on time ÷ working days so far.
 * Synchronous, mock-mode only; live mode reads it from GET /performance/live.
 */
export function attendanceRate(empId: string, month: string) {
  const days = monthDays(month).map((d) => dayFor(empId, d));
  const counted = days.filter((d) => ["on_time", "late", "missed_checkout", "absent"].includes(d.status));
  const onTime = counted.filter((d) => d.status === "on_time" || d.status === "missed_checkout").length;
  return { onTime, counted: counted.length, rate: counted.length ? (onTime / counted.length) * 100 : null };
}

function assertScope(empId: string) {
  const me = getViewer().employee.empId;
  if (!isInScope(me, empId)) throw new ApiError("forbidden", "You can only see your own attendance and your team's.", 403);
}

/**
 * The people a viewer sees on team boards and the leave calendar.
 * CEO / Founder / Owner: everyone (view only). Director: everyone below (CTO, Sales, Finance, Development).
 * CTO: Development. Sales, Finance and Development manage no one: their peers in the same department with the
 * same manager (so Sales never see Finance or the CTO, and Development never see Sales).
 */
function teamOf(me: string) {
  const below = descendantsOf(me);
  if (below.length) return below;
  const self = employeesTable().find((e) => e.empId === me);
  return employeesTable()
    .filter((e) => e.reportsTo && e.reportsTo === self?.reportsTo && e.departmentId === self?.departmentId && e.role === self?.role && e.status !== "left")
    .map((e) => e.empId);
}

/** Apply a leave decision (shared by the Leave screen and the Approvals inbox). */
export function applyLeaveDecision(req: LeaveRequest, approve: boolean, me: string, note?: string) {
  const now = new Date().toISOString();
  const idx = req.chain.findIndex((s) => s.state === "waiting");
  if (idx < 0) return;
  if (!approve) {
    req.chain[idx] = { ...req.chain[idx], empId: me, state: "rejected", at: now, note };
    req.chain = req.chain.map((s, i) => (i > idx ? { ...s, state: "skipped" } : s));
    req.status = "rejected";
    return;
  }
  req.chain[idx] = { ...req.chain[idx], empId: me, state: "done", at: now, note };
  if (idx + 1 < req.chain.length) {
    req.chain[idx + 1] = { ...req.chain[idx + 1], state: "waiting" };
    req.status = "pending_director";
  } else req.status = "approved";
}

/** The person who must act on a pending leave request now (null when none). */
export function currentLeaveApprover(req: LeaveRequest) {
  if (!isPendingLeave(req.status)) return null;
  return req.chain.find((s) => s.state === "waiting")?.empId ?? null;
}

export function applyCorrectionDecision(c: AttendanceCorrection, approve: boolean, me: string, note?: string) {
  c.status = approve ? "approved" : "rejected";
  c.decidedBy = me;
  c.decidedAt = new Date().toISOString();
  c.decisionNote = note;
  if (!approve) return;
  const list = attendanceTable();
  let rec = list.find((d) => d.empId === c.empId && d.date === c.date);
  if (!rec) {
    rec = { empId: c.empId, date: c.date, status: "absent" };
    list.push(rec);
  }
  rec.checkIn = c.requested.checkIn ?? rec.checkIn;
  rec.checkOut = c.requested.checkOut ?? rec.checkOut;
  rec.correctionId = c.id;
  const lm = rec.checkIn ? lateMinutes(rec.checkIn) : 0;
  rec.lateMinutes = lm || undefined;
  rec.status = !rec.checkIn ? "absent" : lm > 0 ? "late" : "on_time";
}

function balancesFor(empId: string): LeaveBalanceView[] {
  const year = new Date().getFullYear();
  const reqs = leaveRequestsTable().filter((r) => r.empId === empId && new Date(r.from).getFullYear() === year);
  return leaveTypesTable().map((lt) => {
    const base = baseUsedTable().find((b) => b.empId === empId && b.leaveTypeId === lt.id)?.used ?? 0;
    const mine = reqs.filter((r) => r.leaveTypeId === lt.id);
    const used = base + mine.filter((r) => r.status === "approved").reduce((n, r) => n + r.days, 0);
    const pending = mine.filter((r) => isPendingLeave(r.status)).reduce((n, r) => n + r.days, 0);
    return { leaveTypeId: lt.id, total: lt.yearlyDays, used, pending, leaveType: lt, remaining: lt.yearlyDays ? lt.yearlyDays - used - pending : null };
  });
}

function clashesFor(empId: string, from: string, to: string) {
  return tasksTable()
    .filter((t) => t.assignee === empId && !t.personal && isOpen(t.status))
    .filter((t) => {
      const d = isoDay(t.deadline);
      return d >= from && d <= to;
    })
    .map((t) => ({ taskId: t.id, number: t.number, title: t.title, deadline: t.deadline }));
}

export const mockAttendanceApi = {
  /** GET /settings/work-schedule */
  schedule: () => mock(() => DEFAULT_SCHEDULE, { delay: 60 }),

  /** GET /holidays?year */
  holidays: () => mock(() => HOLIDAYS, { delay: 60 }),

  /** GET /attendance?empId&month */
  month: (empId: string, month: string) =>
    mock(() => {
      assertScope(empId);
      return monthDays(month).map((d) => dayFor(empId, d));
    }),

  /** GET /attendance/team?date=today */
  teamToday: () =>
    mock<TeamTodayRow[]>(() => {
      const me = getViewer().employee.empId;
      // The CEO / Founder / Owner sees everyone, the Director everyone below, the CTO Development.
      // Sales, Finance and Development only see their own day.
      const below = descendantsOf(me);
      const ids = below.length ? below : [me];
      const today = isoDay(new Date());
      const off = !isWorkingDay(new Date(), HOLIDAY_DATES);
      return ids.map((empId) => {
        const leave = approvedLeaveOn(empId, today);
        const rec = todayRecord(empId);
        if (rec.checkIn) {
          return {
            empId,
            state: rec.checkOut ? "checked_out" : rec.status === "late" ? "late" : "in",
            checkIn: rec.checkIn,
            checkOut: rec.checkOut,
            firstLogin: rec.firstLogin,
            lateMinutes: rec.lateMinutes,
          } satisfies TeamTodayRow;
        }
        if (leave && !off) return { empId, state: "leave", leaveTypeName: leaveTypesTable().find((t) => t.id === leave.leaveTypeId)?.name } satisfies TeamTodayRow;
        return { empId, state: off ? "off" : "not_in" } satisfies TeamTodayRow;
      });
    }),

  /** GET /attendance/team/summary?month */
  teamMonth: (month: string) =>
    mock<TeamMonthRow[]>(() => {
      const me = getViewer().employee.empId;
      return descendantsOf(me).map((empId) => {
        const days = monthDays(month).map((d) => dayFor(empId, d));
        const counted = days.filter((d) => !["future", "weekend", "holiday"].includes(d.status));
        const withIn = counted.filter((d) => d.checkIn);
        const gaps = withIn.map((d) => minutesBetween(d.checkIn, d.firstLogin)).filter((g): g is number => g !== null);
        return {
          empId,
          present: counted.filter((d) => ["on_time", "late", "missed_checkout"].includes(d.status)).length,
          late: counted.filter((d) => d.status === "late").length,
          leave: counted.filter((d) => d.status === "leave").length,
          absent: counted.filter((d) => d.status === "absent").length,
          missedCheckout: counted.filter((d) => d.status === "missed_checkout").length,
          workingDays: counted.length,
          avgLoginGapMin: gaps.length ? Math.round(gaps.reduce((a, b) => a + b, 0) / gaps.length) : null,
          avgCheckIn: averageClock(withIn.map((d) => d.checkIn!)),
        };
      });
    }),

  /** GET /attendance/corrections?scope=mine|team */
  corrections: (scope: "mine" | "team") =>
    mock(() => {
      const me = getViewer().employee.empId;
      const below = new Set(descendantsOf(me));
      return correctionsTable()
        .filter((c) => (scope === "mine" ? c.empId === me : below.has(c.empId)))
        .sort((a, b) => b.at.localeCompare(a.at));
    }),

  /** POST /attendance/corrections */
  requestCorrection: (input: NewCorrectionInput) =>
    mock(() => {
      const me = getViewer().employee.empId;
      if (input.date >= isoDay(new Date())) throw new ApiError("validation", "You can only correct past days.");
      if (!correctionApprover(me, employeesTable()))
        throw new ApiError("validation", "Corrections are approved by your manager. As CEO / Founder / Owner there is no one above you, so this record can't be corrected here.");
      if (correctionsTable().some((c) => c.empId === me && c.date === input.date && c.status === "pending"))
        throw new ApiError("validation", "There is already a pending correction for this day.");
      const rec = attendanceTable().find((d) => d.empId === me && d.date === input.date);
      const c: AttendanceCorrection = {
        id: uid("cor"),
        empId: me,
        date: input.date,
        original: { checkIn: rec?.checkIn, checkOut: rec?.checkOut },
        requested: { checkIn: input.checkIn, checkOut: input.checkOut },
        reason: input.reason,
        status: "pending",
        at: new Date().toISOString(),
      };
      correctionsTable().unshift(c);
      return c;
    }),

  /** POST /attendance/corrections/:id/{approve|reject} */
  decideCorrection: (id: string, approve: boolean, note?: string) =>
    mock(() => {
      const viewer = getViewer();
      const me = viewer.employee.empId;
      const c = correctionsTable().find((x) => x.id === id);
      if (!c) notFound("Correction");
      if (!viewer.can("attendance.approve_correction")) throw new ApiError("forbidden", "View only. The person's manager approves corrections.", 403);
      if (c.empId === me) throw new ApiError("forbidden", "You can't approve your own correction.", 403);
      if (c.status !== "pending") throw new ApiError("validation", "This correction was already decided.");
      if (correctionApprover(c.empId, employeesTable())?.empId !== me) throw new ApiError("forbidden", "Only this person's manager approves the correction.", 403);
      applyCorrectionDecision(c, approve, me, note);
    }),

  /** GET /leave/types */
  leaveTypes: () => mock(() => leaveTypesTable(), { delay: 60 }),

  /** GET /leave/balances?empId */
  balances: (empId?: string) =>
    mock(() => {
      const id = empId ?? getViewer().employee.empId;
      assertScope(id);
      return balancesFor(id);
    }),

  /** GET /leave/requests?scope=mine|team */
  leaveRequests: (scope: "mine" | "team") =>
    mock(() => {
      const me = getViewer().employee.empId;
      const below = new Set(descendantsOf(me));
      return leaveRequestsTable()
        .filter((r) => (scope === "mine" ? r.empId === me : r.empId !== me && (below.has(r.empId) || r.chain.some((s) => s.empId === me))))
        .sort((a, b) => b.at.localeCompare(a.at));
    }),

  /** Task deadlines that fall inside a planned leave (shown while requesting). */
  clashes: (from: string, to: string) => mock(() => clashesFor(getViewer().employee.empId, from, to), { delay: 80 }),

  /** POST /leave/requests */
  requestLeave: (input: NewLeaveInput) =>
    mock(() => {
      const me = getViewer().employee.empId;
      const type = leaveTypesTable().find((t) => t.id === input.leaveTypeId);
      if (!type) throw new ApiError("validation", "Choose a leave type.");
      const days = leaveDays(input.from, input.to, HOLIDAY_DATES, input.halfDay);
      if (days <= 0) throw new ApiError("validation", "The dates you picked have no working days.");
      if (input.from < isoDay(new Date())) throw new ApiError("validation", "Leave can't start in the past. Ask for an attendance correction instead.");
      const bal = balancesFor(me).find((b) => b.leaveTypeId === type.id)!;
      if (bal.remaining !== null && days > bal.remaining) throw new ApiError("validation", `You have ${bal.remaining} ${type.name.toLowerCase()} days left. Choose fewer days or unpaid leave.`);
      const overlap = leaveRequestsTable().find(
        (r) => r.empId === me && (r.status === "approved" || isPendingLeave(r.status)) && r.from <= input.to && r.to >= input.from,
      );
      if (overlap) throw new ApiError("validation", `These dates overlap request ${overlap.number}.`);
      const chain = buildLeaveChain(me, employeesTable()).map((s, i) => ({ ...s, state: i === 0 ? ("waiting" as const) : ("pending" as const) }));
      const req: LeaveRequest = {
        id: uid("lv"),
        number: `LV-${String(nextNumber("leave", 430)).padStart(4, "0")}`,
        empId: me,
        leaveTypeId: type.id,
        from: input.from,
        to: input.to,
        days,
        halfDay: input.halfDay && days === 0.5,
        reason: input.reason,
        // The CEO / Founder / Owner has no one above (empty chain), so their leave is recorded as approved.
        status: chain.length ? "pending_manager" : "approved",
        chain,
        at: new Date().toISOString(),
      };
      leaveRequestsTable().unshift(req);
      return req;
    }),

  /** POST /leave/requests/:id/cancel */
  cancelLeave: (id: string) =>
    mock(() => {
      const me = getViewer().employee.empId;
      const r = leaveRequestsTable().find((x) => x.id === id);
      if (!r || r.empId !== me) notFound("Leave request");
      if (r.status === "approved" && r.from <= isoDay(new Date())) {
        const self = employeesTable().find((e) => e.empId === me);
        throw new ApiError("validation", `Leave that has started can't be cancelled. Ask ${self?.role === "director" ? "the CEO / Founder / Owner" : "the Director (HR duty)"}.`);
      }
      r.status = "cancelled";
    }),

  /** POST /leave/requests/:id/{approve|reject} */
  decideLeave: (id: string, approve: boolean, note?: string) =>
    mock(() => {
      const viewer = getViewer();
      const me = viewer.employee.empId;
      const r = leaveRequestsTable().find((x) => x.id === id);
      if (!r) notFound("Leave request");
      if (!viewer.can("leave.approve")) throw new ApiError("forbidden", "View only. The person's manager and the Director approve leave.", 403);
      if (r.empId === me) throw new ApiError("forbidden", "You can't approve your own leave.", 403);
      if (currentLeaveApprover(r) !== me) throw new ApiError("forbidden", "This request is waiting for someone else.", 403);
      applyLeaveDecision(r, approve, me, note);
    }),

  /** GET /leave/calendar?month&scope */
  calendar: (month: string) =>
    mock<LeaveCalendarEntry[]>(() => {
      const me = getViewer().employee.empId;
      // Full detail (type, waiting requests, task clashes) for the viewer and everyone below them.
      const scope = new Set([me, ...descendantsOf(me)]);
      // Sales and Development also see who in their own team (and their manager) is away: approved leave only,
      // without the leave type or anyone else's tasks.
      const away = new Set(teamOf(me).filter((id) => !scope.has(id)));
      const self = employeesTable().find((e) => e.empId === me);
      if (self?.reportsTo && !descendantsOf(me).length) away.add(self.reportsTo);
      const first = `${month}-01`;
      const last = isoDay(endOfMonth(new Date(`${month}-01T12:00:00`)));
      return leaveRequestsTable()
        .filter((r) => r.from <= last && r.to >= first)
        .filter((r) => (scope.has(r.empId) && (r.status === "approved" || isPendingLeave(r.status))) || (away.has(r.empId) && r.status === "approved"))
        .map((r) =>
          scope.has(r.empId)
            ? { requestId: r.id, empId: r.empId, leaveTypeId: r.leaveTypeId, from: r.from, to: r.to, status: r.status, deadlineClashes: clashesFor(r.empId, r.from, r.to) }
            : { requestId: r.id, empId: r.empId, leaveTypeId: "", from: r.from, to: r.to, status: r.status, deadlineClashes: [] },
        );
    }),

  /** Days in a request, for live counting in forms. */
  countDays: (from: string, to: string, halfDay: boolean) => leaveDays(from, to, HOLIDAY_DATES, halfDay),
};

/** Module 7 is live when NEXT_PUBLIC_LIVE_MODULES contains m7 (or the whole app is live); otherwise the in-browser mock above. */
export const attendanceApi = (isLive("m7") ? liveAttendanceApi : mockAttendanceApi) as typeof mockAttendanceApi;
