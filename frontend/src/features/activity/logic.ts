/**
 * Who sees and does what in Module 4 (spec §9.4). Mirrored on the server.
 * Structure: CEO / Founder → Director → CTO → Engineering; Director → Sales.
 * - Online now, timeline, reports: managers (CEO / Founder, Director, CTO), each within their own reporting line.
 * - Search with export: the Director and the CEO / Founder.
 * - Security alerts: CTO, Director and CEO / Founder.
 * - Everyone sees their own activity.
 */
import { ROLE_LABEL } from "@/lib/auth/permissions";
import type { Viewer } from "@/lib/auth/viewer";
import type { Employee } from "@/types";

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
    // "Director and above" (spec §9.4): the CTO sees engineers through the timeline and reports, not a company-wide search.
    search: v.can("activity.view_all") && v.employee.level <= 2,
    alerts: v.can("activity.security"),
  };
}

/**
 * Forcing a sign-out, locking and unlocking only go downward: someone below you in your reporting line.
 * The CEO / Founder is above everyone, so they can act on anyone but themselves.
 */
export function canActOn(viewerEmpId: string, targetEmpId: string, below: string[]) {
  return targetEmpId !== viewerEmpId && below.includes(targetEmpId);
}

/**
 * Maker-checker for alerts: nobody checks an alert about themselves. An alert is checked by someone above the person
 * in their reporting line; alerts about the CEO / Founder are checked by the Director (a second pair of eyes).
 */
export function canCheckAlert(viewer: Pick<Employee, "empId" | "role">, alertEmpId: string, below: string[], list: Pick<Employee, "empId" | "role">[]) {
  if (alertEmpId === viewer.empId) return false;
  if (below.includes(alertEmpId)) return true;
  return viewer.role === "director" && list.find((e) => e.empId === alertEmpId)?.role === "ceo";
}

/** Short "who checks this" line for an alert the viewer can see but not check. */
export function alertCheckerLabel(alertEmpId: string, list: Pick<Employee, "empId" | "role" | "reportsTo">[]) {
  const e = list.find((x) => x.empId === alertEmpId);
  if (!e) return "their manager";
  if (e.role === "ceo") return "the Director";
  const boss = list.find((x) => x.empId === e.reportsTo);
  return boss ? `the ${ROLE_LABEL[boss.role]}` : "their manager";
}
