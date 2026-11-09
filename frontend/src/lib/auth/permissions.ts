/**
 * Permission strings and the default role → permission map (Module 1, plan §5).
 * Spec §8. The server is the real lock; the UI only hides what a person can't use.
 */
import type { Duty, RoleKey } from "@/types";

export const PERMISSIONS = [
  "org.view", "org.manage", "roles.manage", "standin.manage",
  "people.view_directory", "people.view_job", "people.view_personal", "people.view_pay", "people.manage", "people.manage_pay",
  "auth.unlock_account", "session.force_logout",
  "activity.view_own", "activity.view_team", "activity.view_all", "activity.security",
  "task.view_own", "task.assign", "task.review", "task.view_team",
  "performance.view_own", "performance.view_team", "performance.view_all", "performance.weights",
  "attendance.self", "attendance.view_team", "attendance.approve_correction", "leave.request", "leave.approve",
  "payroll.view_own", "payroll.view", "payroll.prepare", "payroll.review", "payroll.approve", "payroll.export",
  "finance.view", "finance.entry_create", "finance.entry_approve", "finance.close", "finance.reopen", "finance.export",
  "statements.view", "statements.export", "sheet.view", "sheet.import", "insights.view",
  "audit.view", "settings.view", "settings.manage", "backup.view",
  "billing.view", "billing.manage", "subscriptions.view", "subscriptions.manage",
  "comms.use", "comms.admin", "announcements.publish",
  "sales.own", "sales.team", "sales.all", "sales.targets", "sales.commission_view", "sales.commission_approve", "sales.export",
  "integrations.view", "integrations.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/*
 * Aceva structure (strict, spec §2):
 *   L1 CEO / Founder / Owner — one person. Sees everything (all activity, all data) but APPROVES NOTHING.
 *   L2 Director              — the single approver for the whole company, plus HR duty and sales-manager duty.
 *   L3 CTO                   — runs engineering (assigns and reviews engineering work, first step of engineers' leave).
 *   L4 Sales                 — own leads, deals and targets.
 *   L4 Finance               — the finance person (finance duty): prepares entries, payroll, bills, invoices, the month close.
 *   L5 Engineering           — own work.
 * Maker-checker: the finance person (or anyone) prepares, the Director approves. The Director never
 * prepares finance items, so there is always a second person. The only thing that goes above the
 * Director is the Director's own leave or attendance correction, which the CEO / Founder / Owner signs off.
 */

/** Everyone: their own work, their own data, the directory and messages. */
const BASE: Permission[] = [
  "org.view", "people.view_directory", "activity.view_own", "task.view_own", "performance.view_own",
  "attendance.self", "leave.request", "payroll.view_own", "comms.use",
];

/** People who manage others (Director, CTO). Data stays limited to their reporting line. */
const MANAGER: Permission[] = [
  ...BASE,
  "people.view_job", "standin.manage", "activity.view_team", "activity.view_all", "task.assign", "task.review", "task.view_team",
  "performance.view_team", "performance.view_all", "attendance.view_team", "attendance.approve_correction", "leave.approve",
  "auth.unlock_account", "session.force_logout", "comms.admin", "announcements.publish",
];

/** L1 CEO / Founder / Owner: oversight only. Every "view" and export, no approve / create / manage. */
const CEO: Permission[] = [
  ...BASE,
  "people.view_job", "people.view_personal", "people.view_pay",
  "activity.view_team", "activity.view_all", "activity.security",
  "task.view_team", "performance.view_team", "performance.view_all", "attendance.view_team",
  "payroll.view", "payroll.export",
  "finance.view", "finance.export", "statements.view", "statements.export", "sheet.view", "insights.view",
  "audit.view", "settings.view", "backup.view",
  "billing.view", "subscriptions.view",
  "sales.own", "sales.team", "sales.all", "sales.commission_view", "sales.export",
  "integrations.view", "announcements.publish",
  // The Director's own leave / attendance correction can't be self-approved, so it comes here (spec §2.3).
  "leave.approve", "attendance.approve_correction",
];

/** L2 Director: the approver for everything, plus HR duty, sales-manager duty and company administration. Prepares no finance items. */
const DIRECTOR: Permission[] = [
  ...MANAGER,
  "org.manage", "roles.manage", "people.view_personal", "people.view_pay", "people.manage", "people.manage_pay",
  "activity.security", "performance.weights",
  "payroll.view", "payroll.review", "payroll.approve", "payroll.export",
  "finance.view", "finance.entry_approve", "finance.close", "finance.reopen", "finance.export",
  "statements.view", "statements.export", "sheet.view", "insights.view",
  "audit.view", "settings.view", "settings.manage", "backup.view",
  "billing.view", "subscriptions.view", "subscriptions.manage",
  "sales.own", "sales.team", "sales.all", "sales.targets", "sales.commission_view", "sales.commission_approve", "sales.export",
  "integrations.view", "integrations.manage",
];

/** L3 CTO: runs engineering, security events, backups and the sales tool connections. No finance, payroll or sales data. */
const CTO: Permission[] = [
  ...MANAGER,
  "activity.security", "settings.view", "backup.view", "integrations.view", "integrations.manage",
];

/** L4 Sales: own leads, deals, follow-ups and daily report. */
const SALES: Permission[] = [...BASE, "sales.own"];

/** L4 Finance person (finance duty): prepares; never approves. */
const FINANCE: Permission[] = [
  ...BASE,
  "finance.view", "finance.entry_create", "finance.close", "payroll.view", "payroll.prepare",
  "statements.view", "sheet.view", "sheet.import", "insights.view",
  "billing.view", "billing.manage", "subscriptions.view", "sales.commission_view",
];

/** L5 Engineering and development employees. */
const ENGINEER: Permission[] = [...BASE];

export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  ceo: CEO,
  director: DIRECTOR,
  cto: CTO,
  sales: SALES,
  finance: FINANCE,
  engineer: ENGINEER,
};

/** Duties add permissions on top of a role. Finance duty: the finance person. HR and sales-manager duty: the Director. */
export const DUTY_PERMISSIONS: Record<Duty, Permission[]> = {
  finance: [
    "finance.view", "finance.entry_create", "finance.close", "payroll.view", "payroll.prepare",
    "statements.view", "sheet.view", "sheet.import", "insights.view",
    "billing.view", "billing.manage", "subscriptions.view", "sales.commission_view",
  ],
  hr: ["people.view_job", "people.view_personal", "people.manage", "auth.unlock_account"],
  sales_manager: ["sales.own", "sales.team", "sales.targets", "sales.export"],
};

export const ROLE_LABEL: Record<RoleKey, string> = {
  ceo: "CEO / Founder / Owner",
  director: "Director",
  cto: "CTO",
  sales: "Sales",
  finance: "Finance",
  engineer: "Engineering",
};

export const DUTY_LABEL: Record<Duty, string> = {
  finance: "Finance duty",
  hr: "HR duty",
  sales_manager: "Sales manager",
};

export const LEVEL_LABEL: Record<number, string> = {
  1: "CEO / Founder / Owner",
  2: "Director",
  3: "CTO",
  4: "Sales and Finance",
  5: "Engineering",
};

export function permissionsFor(role: RoleKey, duties: Duty[] = []): Set<Permission> {
  const set = new Set<Permission>(ROLE_PERMISSIONS[role]);
  for (const d of duties) DUTY_PERMISSIONS[d].forEach((p) => set.add(p));
  return set;
}

/** Group permissions by module prefix for the roles matrix (M1). */
export function permissionGroups() {
  const groups: Record<string, Permission[]> = {};
  for (const p of PERMISSIONS) (groups[p.split(".")[0]] ||= []).push(p);
  return groups;
}
