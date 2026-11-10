/** Seed: roles, stand-ins and recent access changes (Module 1). */
import type { OrgChange, Role, StandIn } from "@/features/access/types";
import { DUTY_LABEL, DUTY_PERMISSIONS, ROLE_LABEL, ROLE_PERMISSIONS } from "@/lib/auth/permissions";
import { ROLE_LEVEL, type Duty, type RoleKey } from "@/types";
import { daysFromNow, minutesAgo } from "../time";

/** Roles of the five levels (plan §5): Owner, CEO, Director and CTO, Heads and Leads, Employees. */
const ROLE_DESCRIPTION: Record<RoleKey, string> = {
  owner: "Level 1. Sees everything (all activity, data, reports and exports) but approves, prepares and assigns nothing. Changes employee levels and reporting lines, with a reason, and every change is logged.",
  ceo: "Level 2. Oversight like the Owner, plus signs off the Director's own leave and attendance corrections. Changes levels and reporting lines below the CEO, with a reason.",
  lead: "Level 4 default role: Department Heads and Team Leads. Own work plus assigning tasks to, and approving for, the people below. HR and Finance people hold their extra duty on top.",
  director: "The approver for the whole company: payroll, journal entries, month close and reopen, Won deals, commission, targets, the last step of leave, settings. Also holds HR duty and sales-manager duty, and gives extra duties such as Finance. Prepares no finance items. Level 3, reports to the CEO.",
  cto: "Runs development: assigns and reviews tasks, first step of developers' leave and corrections, security alerts, backups and integrations. No finance, payroll or sales data. Level 3, reports to the Director (the one configured same-level reporting line).",
  sales: "Own leads, deals, follow-ups, targets and daily report. Reports to the Director. Manages nobody.",
  finance: "The finance person. Prepares journal entries, payroll runs, bills, invoices, payments, bank reconciliation, salary advances and the month close. Approves nothing: the Director approves. Reports to the Director.",
  developer: "Software Development. Own tasks, attendance, leave, scorecard and payslips. Reports to the CTO.",
};

const DUTY_DESCRIPTION: Record<Duty, string> = {
  finance: "Held by the finance person. Prepares entries, payroll, bills and the month close; the Director approves. Reviewed every 3 months.",
  hr: "Held by the Director. Profiles, onboarding, offboarding, pay edits and account unlocks.",
  sales_manager: "Held by the Director. Sets sales targets, moves leads, confirms Won deals and approves commission.",
};

export function seedRoles(): Role[] {
  const levelRoles: Role[] = (Object.keys(ROLE_PERMISSIONS) as RoleKey[]).map((key) => ({
    id: `role_${key}`,
    key,
    name: ROLE_LABEL[key],
    level: ROLE_LEVEL[key],
    isDuty: false,
    description: ROLE_DESCRIPTION[key],
    permissions: [...ROLE_PERMISSIONS[key]],
  }));
  const duties: Role[] = (Object.keys(DUTY_PERMISSIONS) as Duty[]).map((key) => ({
    id: `duty_${key}`,
    key,
    name: DUTY_LABEL[key],
    isDuty: true,
    description: DUTY_DESCRIPTION[key],
    permissions: [...DUTY_PERMISSIONS[key]],
  }));
  return [...levelRoles, ...duties];
}

/**
 * Only managers (Director, CTO) have stand-ins; a stand-in is another manager at the same level or higher.
 * The CEO / Founder / Owner approves nothing, so the Director has no stand-in: their approvals wait.
 */
export function seedStandIns(): StandIn[] {
  return [
    { id: "si_1", managerEmpId: "ACV-0004", standInEmpId: "ACV-0003", from: daysFromNow(-24, "00:00"), to: daysFromNow(-22, "23:59"), reason: "Conference in Lahore", createdBy: "ACV-0004", createdAt: daysFromNow(-27, "11:20") },
    { id: "si_2", managerEmpId: "ACV-0004", standInEmpId: "ACV-0003", from: daysFromNow(7, "00:00"), to: daysFromNow(11, "23:59"), reason: "Annual leave", createdBy: "ACV-0004", createdAt: daysFromNow(-1, "16:05") },
  ];
}

/** Org and access changes: only the Director (org.manage, roles.manage) makes them; managers set their own stand-ins. */
export function seedOrgChanges(): OrgChange[] {
  const list: OrgChange[] = [
    { id: "oc_1", kind: "reporting_line", summary: "Nida Aslam now reports to Omar Farooq", reason: "Every developer reports to the CTO", by: "ACV-0003", at: minutesAgo(60 * 24 * 12) },
    { id: "oc_2", kind: "role_permissions", summary: "Finance duty: added Subscriptions view", reason: "Finance tracks renewal costs", by: "ACV-0003", at: minutesAgo(60 * 24 * 6) },
    { id: "oc_3", kind: "stand_in", summary: "Bilal Ahmed stood in for Omar Farooq", reason: "Conference in Lahore", by: "ACV-0004", at: minutesAgo(60 * 24 * 27) },
    { id: "oc_4", kind: "office", summary: "Office added: Karachi Studio", reason: "New studio for the development team", by: "ACV-0003", at: minutesAgo(60 * 24 * 40) },
    { id: "oc_5", kind: "stand_in", summary: "Bilal Ahmed stands in for Omar Farooq", reason: "Annual leave", by: "ACV-0004", at: minutesAgo(60 * 24 * 1) },
  ];
  return list.sort((a, b) => b.at.localeCompare(a.at));
}
