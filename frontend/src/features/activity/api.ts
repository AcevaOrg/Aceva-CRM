/**
 * Module 4 service functions. Each one talks to the real API when Module 4 is live (NEXT_PUBLIC_LIVE_MODULES contains
 * m4, or NEXT_PUBLIC_API_MODE=live) and to the in-browser mock otherwise; each JSDoc names the real endpoint (spec §7.3).
 * Tracking tables only allow adding rows: there are no update or delete functions for events.
 * Live, the server decides everything (who sees what, scope, maker-checker); the checks in the mock branches only
 * mirror it so the demo behaves the same.
 */
import type {
  AccountLockView, ActivityEventView, DailySummaryView, MyActivityResponse, OnlineSessionView, SecurityAlertView, TimelineResponse,
} from "@aceva/contracts";
import { http, isLive } from "@/lib/api/http";
import { ApiError, mock } from "@/lib/api/mock";
import { descendantsOf, scopeOf } from "@/lib/auth/scope";
import { getViewer } from "@/lib/auth/viewer";
import { employeeName, employeesTable } from "@/lib/directory";
import { isoDay } from "@/lib/dates";
import { liveHeartbeats, liveScreens } from "@/lib/telemetry";
import { uid } from "@/lib/utils";
import { table } from "@/mocks/db";
import { seedAlerts, seedEvents, seedLocks, seedOnline, seedSummaries } from "@/mocks/seed/activity";
import { activityAccess, alertCheckerLabel, canActOn, canActOnAlerts, canCheckAlert, canLockAccounts } from "./logic";
import type { AccountLock, ActivityEvent, ActivityQuery, DailySummary, MyActivity, OnlineSession, SecurityAlert } from "./types";

const eventsTable = () => table<ActivityEvent>("activity.events", seedEvents);
const onlineTable = () => table<OnlineSession>("activity.online", () => seedOnline(eventsTable()));
const summariesTable = () => table<DailySummary>("activity.summaries", () => seedSummaries(eventsTable()));
const alertsTable = () => table<SecurityAlert>("activity.alerts", seedAlerts);
const locksTable = () => table<AccountLock>("activity.locks", seedLocks);

/** Everyone the viewer may see (self + reporting line below; the CEO / Founder / Owner sees all). */
function scope() {
  return scopeOf(getViewer().employee.empId, employeesTable());
}

/** Force sign-out, lock and unlock only reach people below the viewer in their reporting line. */
function requireBelow(targetEmpId: string, message: string) {
  const me = getViewer().employee.empId;
  if (!canActOn(me, targetEmpId, descendantsOf(me, employeesTable()))) throw new ApiError("forbidden", message, 403);
}

/** Is Module 4 talking to the real server? (NEXT_PUBLIC_LIVE_MODULES contains m4, or NEXT_PUBLIC_API_MODE=live) */
const live = () => isLive("m4");

/**
 * Mock helper for other modules: record an action by the current viewer. Live it does nothing: the server's action
 * recorder records every request by itself, so the screens never report their own actions.
 */
export function recordActivity(e: Pick<ActivityEvent, "action" | "module" | "description"> & Partial<Pick<ActivityEvent, "target" | "changes" | "source">>) {
  if (live()) return;
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

const mockActivityApi = {
  /** GET /activity/online (CEO / Founder / Owner: everyone; Director, CTO: their reporting line) */
  online: () =>
    mock(() => {
      if (!activityAccess(getViewer()).online) return [];
      const s = scope();
      return onlineTable().filter((o) => s.has(o.empId) && o.empId !== getViewer().employee.empId);
    }),

  /** GET /activity/events?empId&from&to&module&action&source — others' events for the CEO / Founder / Owner and the Director, within their reporting line */
  events: (q: ActivityQuery) =>
    mock(() => {
      const v = getViewer();
      const s = scope();
      const all = activityAccess(v).search;
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
      if (!activityAccess(v).reports) return [];
      const s = scope();
      return summariesTable().filter((d) => s.has(d.empId) && d.empId !== v.employee.empId && d.date >= from && d.date <= to);
    }),

  /** GET /activity/timeline?empId&date — own, or people below you (CTO: developers; Director: their line; CEO / Founder / Owner: everyone) */
  timeline: (empId: string, date: string) =>
    mock<{ summary?: DailySummary; events: ActivityEvent[] | null }>(() => {
      const v = getViewer();
      if (empId !== v.employee.empId && (!activityAccess(v).timeline || !scope().has(empId))) throw new ApiError("forbidden", "This person is outside your reporting line.", 403);
      const full = empId === v.employee.empId || v.can("activity.view_all");
      return {
        summary: summariesTable().find((d) => d.empId === empId && d.date === date),
        events: full ? eventsTable().filter((e) => e.empId === empId && isoDay(e.at) === date).sort((a, b) => a.at.localeCompare(b.at)) : null,
      };
    }),

  /** GET /activity/alerts?status — CTO, Director and CEO / Founder / Owner (activity.security sees every alert; the server cuts only old checked ones) */
  alerts: () =>
    mock(() => {
      const v = getViewer();
      if (!activityAccess(v).alerts) return [];
      return alertsTable();
    }),

  /** POST /activity/alerts/:id/check { note } — Director or CTO; never your own alert; checked from above (spec §3.5.6 maker-checker) */
  checkAlert: (id: string, note: string) =>
    mock(() => {
      const a = alertsTable().find((x) => x.id === id);
      if (!a) return;
      const v = getViewer();
      const list = employeesTable();
      if (!activityAccess(v).alerts || !canCheckAlert(v, a.empId, descendantsOf(v.employee.empId, list), list))
        throw new ApiError(
          "forbidden",
          !canActOnAlerts(v)
            ? "View only. The Director and the CTO check alerts."
            : a.empId === v.employee.empId
              ? `This alert is about you, so ${alertCheckerLabel(a.empId, list)} checks it.`
              : `This alert is checked by ${alertCheckerLabel(a.empId, list)}, above this person.`,
          403,
        );
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
      requireBelow(list[i].empId, "You can only sign out people below you in your reporting line.");
      const [s] = list.splice(i, 1);
      eventsTable().unshift({ id: uid("ev"), empId: s.empId, at: new Date().toISOString(), source: "aceva", action: "logout", module: "Login", description: `Signed out by ${getViewer().employee.name}: ${reason}`, how: "forced" });
      recordActivity({ action: "security", module: "Activity", target: s.empId, description: `Forced sign-out of ${employeeName(s.empId)}` });
    }),

  /** GET /accounts/locked — your own, your reporting line, or everyone for security alerts */
  locks: () =>
    mock(() => {
      const v = getViewer();
      const s = scope();
      return locksTable().filter((l) => v.can("activity.security") || s.has(l.empId));
    }),

  /** POST /employees/:empId/lock { reason } — someone below you only */
  lock: (empId: string, reason: string) =>
    mock(() => {
      if (!canLockAccounts(getViewer())) throw new ApiError("forbidden", "You can't lock accounts.", 403);
      requireBelow(empId, "You can only lock the accounts of people below you in your reporting line.");
      if (!locksTable().some((l) => l.empId === empId)) locksTable().push({ empId, at: new Date().toISOString(), by: getViewer().employee.empId, reason });
      const list = onlineTable();
      const i = list.findIndex((s) => s.empId === empId);
      if (i >= 0) list.splice(i, 1);
      recordActivity({ action: "security", module: "Activity", target: empId, description: `Locked the account of ${employeeName(empId)}` });
    }),

  /** POST /employees/:empId/unlock — the person's manager or someone above them */
  unlock: (empId: string) =>
    mock(() => {
      if (!getViewer().can("auth.unlock_account")) throw new ApiError("forbidden", "You can't unlock accounts.", 403);
      requireBelow(empId, "Only a manager above this person can unlock their account.");
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

/** The export formats the server records (the export dialog offers Excel and PDF). */
const exportFormat = (format: string): "xlsx" | "pdf" | "csv" => (format === "pdf" || format === "csv" ? format : "xlsx");

/**
 * Module 4 against the REAL API. Same names and result shapes as the mock above, so the screens do not change. The
 * server applies every rule: who may see a screen, the reporting-line scope, maker-checker on alerts, the confirm-again
 * before a control (the screens ask for it first through POST /auth/step-up).
 */
const liveActivityApi: typeof mockActivityApi = {
  /** GET /activity/online: sessions of the people below me (activity.view_all) */
  online: () => http.get<OnlineSessionView[]>("/activity/online"),

  /** GET /activity/events?empId&departmentId&module&action&source&from&to: my line for the Director and the CEO / Founder / Owner, otherwise my own */
  events: (q: ActivityQuery) =>
    http.get<ActivityEventView[]>("/activity/events", {
      empId: q.empId || undefined,
      departmentId: q.departmentId || undefined,
      module: q.module || undefined,
      action: q.action || undefined,
      source: q.source || undefined,
      from: q.from || undefined,
      to: q.to || undefined,
    }),

  /** GET /activity/summaries?from&to&scope=team: the people below me */
  summaries: (from: string, to: string) => http.get<DailySummaryView[]>("/activity/summaries", { from, to, scope: "team" }),

  /** GET /activity/timeline?empId&date */
  timeline: (empId: string, date: string) => http.get<TimelineResponse>("/activity/timeline", { empId, date }),

  /** GET /activity/alerts: every open alert plus the newest checked ones (the screen filters open / checked; open is never cut off) */
  alerts: () => http.get<SecurityAlertView[]>("/activity/alerts", { status: "all" }),

  /** POST /activity/alerts/:id/check { note } */
  checkAlert: async (id: string, note: string) => {
    await http.post(`/activity/alerts/${id}/check`, { note });
  },

  /** POST /sessions/:id/force-logout { reason } (after the confirm-again) */
  forceLogout: async (sessionId: string, reason: string) => {
    await http.post(`/sessions/${sessionId}/force-logout`, { reason });
  },

  /** GET /accounts/locked */
  locks: () => http.get<AccountLockView[]>("/accounts/locked"),

  /** POST /employees/:empId/lock { reason } (after the confirm-again) */
  lock: async (empId: string, reason: string) => {
    await http.post(`/employees/${empId}/lock`, { reason });
  },

  /** POST /employees/:empId/unlock (after the confirm-again) */
  unlock: async (empId: string) => {
    await http.post(`/employees/${empId}/unlock`, {});
  },

  /** POST /activity/export { rows, format, module, dataset }: the server records the export (and checks it for the large-export alert) */
  logExport: async (rows: number, format: string) => {
    await http.post("/activity/export", { rows, format: exportFormat(format), module: "Activity", dataset: "Activity search results" });
  },

  /** GET /activity/me */
  mine: () => http.get<MyActivityResponse>("/activity/me"),
};

export const activityApi: typeof mockActivityApi = live() ? liveActivityApi : mockActivityApi;
