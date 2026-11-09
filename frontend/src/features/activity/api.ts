/**
 * Module 4 service functions. Mock today; each JSDoc names the real endpoint (spec §7.3).
 * Tracking tables only allow adding rows: there are no update or delete functions for events.
 */
import { ApiError, mock } from "@/lib/api/mock";
import { scopeOf } from "@/lib/auth/scope";
import { getViewer } from "@/lib/auth/viewer";
import { employeeName, employeesTable } from "@/lib/directory";
import { isoDay } from "@/lib/dates";
import { liveHeartbeats, liveScreens } from "@/lib/telemetry";
import { uid } from "@/lib/utils";
import { table } from "@/mocks/db";
import { seedAlerts, seedEvents, seedLocks, seedOnline, seedSummaries } from "@/mocks/seed/activity";
import type { AccountLock, ActivityEvent, ActivityQuery, DailySummary, MyActivity, OnlineSession, SecurityAlert } from "./types";

const eventsTable = () => table<ActivityEvent>("activity.events", seedEvents);
const onlineTable = () => table<OnlineSession>("activity.online", () => seedOnline(eventsTable()));
const summariesTable = () => table<DailySummary>("activity.summaries", () => seedSummaries(eventsTable()));
const alertsTable = () => table<SecurityAlert>("activity.alerts", seedAlerts);
const locksTable = () => table<AccountLock>("activity.locks", seedLocks);

/** Everyone the viewer may see (self + reporting line below; Owner sees all). */
function scope() {
  return scopeOf(getViewer().employee.empId, employeesTable());
}

/** Mock helper for other modules: record an action by the current viewer (server does this automatically). */
export function recordActivity(e: Pick<ActivityEvent, "action" | "module" | "description"> & Partial<Pick<ActivityEvent, "target" | "changes" | "source">>) {
  eventsTable().unshift({ id: uid("ev"), empId: getViewer().employee.empId, at: new Date().toISOString(), source: e.source ?? "aceva", ...e });
}

/** All signed-in sessions (used for the presence dot in the directory; never shown as a metric). */
export function sessionsFor() {
  return onlineTable();
}

function inRange(at: string, from?: string, to?: string) {
  const day = isoDay(at);
  return (!from || day >= from) && (!to || day <= to);
}

export const activityApi = {
  /** GET /activity/online (Director, CTO, CEO, Owner) */
  online: () =>
    mock(() => {
      if (!getViewer().can("activity.view_all")) return [];
      const s = scope();
      return onlineTable().filter((o) => s.has(o.empId) && o.empId !== getViewer().employee.empId);
    }),

  /** GET /activity/events?empId&from&to&module&action&source */
  events: (q: ActivityQuery) =>
    mock(() => {
      const v = getViewer();
      const s = scope();
      const all = v.can("activity.view_all");
      const dept = q.departmentId ? new Set(employeesTable().filter((e) => e.departmentId === q.departmentId).map((e) => e.empId)) : null;
      return eventsTable()
        .filter((e) => (all ? s.has(e.empId) : e.empId === v.employee.empId))
        .filter((e) => !q.empId || e.empId === q.empId)
        .filter((e) => !dept || dept.has(e.empId))
        .filter((e) => !q.module || e.module === q.module)
        .filter((e) => !q.action || e.action === q.action)
        .filter((e) => !q.source || e.source === q.source)
        .filter((e) => inRange(e.at, q.from, q.to));
    }),

  /** GET /activity/summaries?from&to&scope=team */
  summaries: (from: string, to: string) =>
    mock(() => {
      const v = getViewer();
      if (!v.can(["activity.view_team", "activity.view_all"])) return [];
      const s = scope();
      return summariesTable().filter((d) => s.has(d.empId) && d.empId !== v.employee.empId && d.date >= from && d.date <= to);
    }),

  /** GET /activity/timeline?empId&date — summary always; full events only for Director and above */
  timeline: (empId: string, date: string) =>
    mock(() => {
      const v = getViewer();
      if (empId !== v.employee.empId && !scope().has(empId)) throw new ApiError("forbidden", "This person is outside your reporting line.", 403);
      const full = empId === v.employee.empId || v.can("activity.view_all");
      return {
        summary: summariesTable().find((d) => d.empId === empId && d.date === date),
        events: full ? eventsTable().filter((e) => e.empId === empId && isoDay(e.at) === date).sort((a, b) => a.at.localeCompare(b.at)) : null,
      };
    }),

  /** GET /activity/alerts?status */
  alerts: () =>
    mock(() => {
      const v = getViewer();
      if (!v.can(["activity.view_all", "activity.security"])) return [];
      const s = scope();
      return alertsTable().filter((a) => v.can("activity.security") || s.has(a.empId));
    }),

  /** POST /activity/alerts/:id/check { note } */
  checkAlert: (id: string, note: string) =>
    mock(() => {
      const a = alertsTable().find((x) => x.id === id);
      if (!a) return;
      Object.assign(a, { status: "checked", checkedBy: getViewer().employee.empId, checkedAt: new Date().toISOString(), note });
      recordActivity({ action: "edit", module: "Activity", target: id, description: `Marked alert “${a.rule}” as checked` });
    }),

  /** POST /sessions/:id/force-logout { reason } */
  forceLogout: (sessionId: string, reason: string) =>
    mock(() => {
      if (!getViewer().can("session.force_logout")) throw new ApiError("forbidden", "You can't end other people's sessions.", 403);
      const list = onlineTable();
      const i = list.findIndex((s) => s.sessionId === sessionId);
      if (i < 0) return;
      const [s] = list.splice(i, 1);
      eventsTable().unshift({ id: uid("ev"), empId: s.empId, at: new Date().toISOString(), source: "aceva", action: "logout", module: "Login", description: `Signed out by ${getViewer().employee.name}: ${reason}`, how: "forced" });
      recordActivity({ action: "security", module: "Activity", target: s.empId, description: `Forced sign-out of ${employeeName(s.empId)}` });
    }),

  /** GET /accounts/locked */
  locks: () => mock(() => locksTable()),

  /** POST /employees/:empId/lock { reason } */
  lock: (empId: string, reason: string) =>
    mock(() => {
      if (!getViewer().can("auth.unlock_account")) throw new ApiError("forbidden", "You can't lock accounts.", 403);
      if (!locksTable().some((l) => l.empId === empId)) locksTable().push({ empId, at: new Date().toISOString(), by: getViewer().employee.empId, reason });
      const list = onlineTable();
      const i = list.findIndex((s) => s.empId === empId);
      if (i >= 0) list.splice(i, 1);
      recordActivity({ action: "security", module: "Activity", target: empId, description: `Locked the account of ${employeeName(empId)}` });
    }),

  /** POST /employees/:empId/unlock */
  unlock: (empId: string) =>
    mock(() => {
      if (!getViewer().can("auth.unlock_account")) throw new ApiError("forbidden", "You can't unlock accounts.", 403);
      const list = locksTable();
      const i = list.findIndex((l) => l.empId === empId);
      if (i >= 0) list.splice(i, 1);
      recordActivity({ action: "security", module: "Activity", target: empId, description: `Unlocked the account of ${employeeName(empId)}` });
    }),

  /** POST /activity/export — the export itself is logged (plan §8) */
  logExport: (rows: number, format: string) =>
    mock(() => recordActivity({ action: "export", module: "Activity", description: `Exported ${rows} activity rows (${format})` }), { delay: 60 }),

  /** GET /activity/me */
  mine: () =>
    mock<MyActivity>(() => {
      const me = getViewer().employee.empId;
      const today = isoDay(new Date());
      return {
        today: summariesTable().find((d) => d.empId === me && d.date === today),
        events: eventsTable().filter((e) => e.empId === me),
        liveScreens: liveScreens().filter((s) => s.empId === me).slice(0, 40),
        heartbeats: liveHeartbeats().filter((h) => h.empId === me).slice(0, 120),
      };
    }, { delay: 120 }),
};
