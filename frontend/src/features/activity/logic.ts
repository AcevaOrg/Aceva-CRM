/**
 * Who sees and does what in Module 4 (spec §9.4). Mirrored on the server.
 * Structure: CEO / Founder / Owner → Director → CTO → Development; Director → Sales, Finance.
 * - Online now, timeline, reports: the CEO / Founder / Owner (everyone), the Director and the CTO (their reporting line).
 * - Search with export: the CEO / Founder / Owner and the Director (audit.view).
 * - Security alerts: the CEO / Founder / Owner sees every alert (view only); the Director and the CTO check them.
 * - Acting (force sign-out, lock, unlock, checking alerts) needs an action permission the CEO / Founder / Owner doesn't have.
 * - Everyone sees their own activity.
 */
import type { ActivityModuleName, ALERTS_CHECKED_LIMIT } from "@aceva/contracts";
import { ROLE_LABEL } from "@/lib/auth/permissions";
import type { Viewer } from "@/lib/auth/viewer";
import type { Employee } from "@/types";
import { isTopLevelRole } from "@/types";

/**
 * Every module label the server records on an activity event: the options of the search "Module" filter. The server
 * matches the label exactly, so an option that is missing here cannot be searched for. This is a Record on purpose: the
 * compiler fails here when a label is added to or removed from ACTIVITY_MODULES in packages/contracts.
 */
const MODULE_LABELS: Record<ActivityModuleName, true> = {
  Home: true,
  Login: true,
  People: true,
  Org: true,
  Approvals: true,
  Activity: true,
  Tasks: true,
  Performance: true,
  Attendance: true,
  Leave: true,
  Payroll: true,
  Finance: true,
  Ledger: true,
  Banking: true,
  "Bills and expenses": true,
  "Month close": true,
  Statements: true,
  Spreadsheet: true,
  Insights: true,
  Billing: true,
  Subscriptions: true,
  Settings: true,
  Audit: true,
  Messages: true,
  Announcements: true,
  Meetings: true,
  Sales: true,
  Integrations: true,
  Notifications: true,
  System: true,
};
export const ACTIVITY_MODULES = Object.keys(MODULE_LABELS) as ActivityModuleName[];

/**
 * GET /activity/alerts returns EVERY open alert plus at most this many of the newest checked ones (ALERTS_CHECKED_LIMIT in
 * packages/contracts; the type keeps the two numbers equal).
 */
export const CHECKED_ALERTS_LIMIT: typeof ALERTS_CHECKED_LIMIT = 500;

/** Did the checked alerts reach the server's limit? Then older checked alerts exist that the list does not show. */
export const checkedAlertsCut = (checkedShown: number) => checkedShown >= CHECKED_ALERTS_LIMIT;

export interface ActivityAccess {
  online: boolean;
  timeline: boolean;
  search: boolean;
  reports: boolean;
  alerts: boolean;
}

export function activityAccess(v: Viewer | null): ActivityAccess {
  if (!v) return { online: false, timeline: false, search: false, reports: false, alerts: false };
  const manager = v.can(["activity.view_all", "activity.view_team"]);
  return {
    online: v.can("activity.view_all"),
    timeline: manager,
    reports: manager,
    // The CEO / Founder / Owner and the Director (audit.view): the CTO sees developers through the timeline and reports, not a company-wide search.
    search: v.can("activity.view_all") && v.can("audit.view"),
    alerts: v.can("activity.security"),
  };
}

/**
 * Forcing a sign-out, locking and unlocking only go downward: someone below you in your reporting line.
 * Callers also check the action permission (session.force_logout, auth.unlock_account), which the CEO / Founder / Owner lacks.
 */
export function canActOn(viewerEmpId: string, targetEmpId: string, below: string[]) {
  return targetEmpId !== viewerEmpId && below.includes(targetEmpId);
}

/**
 * Locking and unlocking from the activity screens needs both control permissions (the Director and the CTO), the same
 * rule as the server. The CEO / Founder / Owner holds auth.unlock_account only for Module 2's unlock of his direct report
 * (My account / People), so on these screens he stays view only.
 */
export const canLockAccounts = (v: Pick<Viewer, "can"> | null) => !!v?.can("session.force_logout") && !!v.can("auth.unlock_account");

/** Checking an alert is an action: only people with security actions (Director, CTO). The CEO / Founder / Owner views alerts only. */
export const canActOnAlerts = (v: Pick<Viewer, "can"> | null) => !!v?.can("activity.security") && !!v.can("session.force_logout");

/**
 * Maker-checker for alerts: nobody checks an alert about themselves. An alert is checked by a manager above the person
 * in their reporting line. Nobody above the Director acts, so the CTO (security) checks alerts about the Director, and
 * the Director checks alerts about the CEO / Founder / Owner.
 */
export function canCheckAlert(viewer: Pick<Viewer, "can" | "employee">, alertEmpId: string, below: string[], list: Pick<Employee, "empId" | "role">[]) {
  const me = viewer.employee;
  if (!canActOnAlerts(viewer) || alertEmpId === me.empId) return false;
  if (below.includes(alertEmpId)) return true;
  const role = list.find((e) => e.empId === alertEmpId)?.role;
  return (me.role === "director" && role === "owner") || (me.role === "cto" && role === "director");
}

/** Short "who checks this" label for an alert the viewer can see but not check. */
export function alertCheckerLabel(alertEmpId: string, list: Pick<Employee, "empId" | "role" | "reportsTo">[]) {
  const e = list.find((x) => x.empId === alertEmpId);
  if (!e) return "their manager";
  if (e.role === "owner") return "the Director";
  if (e.role === "director") return "the CTO";
  const boss = list.find((x) => x.empId === e.reportsTo);
  return boss && !isTopLevelRole(boss.role) ? `the ${ROLE_LABEL[boss.role]}` : "their manager";
}
