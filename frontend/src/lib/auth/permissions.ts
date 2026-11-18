/**
 * Permission strings and the default role → permission map (Module 1, plan §5).
 * Spec §8. The server is the real lock; the UI only hides what a person can't use.
 * These lists are the same as the server's (backend/prisma/permission-catalogue.ts): keep the two in step.
 */
import type { Duty, RoleKey } from "@/types";

export const PERMISSIONS = [
  "org.view", "org.manage", "roles.manage", "standin.manage",
  "people.view_directory", "people.view_job", "people.view_personal", "people.view_pay", "people.manage", "people.manage_pay", "people.approve_hire",
  "auth.unlock_account", "session.force_logout",
  "activity.view_own", "activity.view_team", "activity.view_all", "activity.security",
  "task.view_own", "task.assign", "task.review", "task.view_team",
  "performance.view_own", "performance.view_team", "performance.view_all", "performance.weights",
  "attendance.self", "attendance.view_team", "attendance.approve_correction", "leave.request", "leave.approve",
  "payroll.view_own", "payroll.view", "payroll.prepare", "payroll.review", "payroll.approve", "payroll.export",
  "finance.view", "finance.entry_create", "finance.entry_approve", "finance.close", "finance.close_approve", "finance.reopen", "finance.authority_manage", "finance.export",
  "statements.view", "statements.export", "sheet.view", "sheet.import", "insights.view",
  "audit.view", "settings.view", "settings.manage", "backup.view",
  "billing.view", "billing.manage", "subscriptions.view", "subscriptions.manage",
  "comms.use", "comms.admin", "announcements.publish",
  "sales.own", "sales.team", "sales.all", "sales.targets", "sales.commission_view", "sales.commission_approve", "sales.export",
  "integrations.view", "integrations.manage",
  "approval.approve", "duty.assign", "auth.set_temporary_password", "auth.reset_two_factor",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/*
 * Aceva structure (final, decided by the owner of the company):
 *   L1 CEO / Founder / Owner — one person. Sees everything (every view and export, all activity, audit, finance, payroll,
 *                              sales, settings) but approves, prepares, assigns and manages nothing. The one exception:
 *                              nobody approves their own request, so the Director's own leave and attendance corrections
 *                              come to him (he approves only for his direct report).
 *   L2 Director   — reports to L1. The single approver for the whole company and the org administrator: levels, reporting
 *                   lines, departments and offices, hiring, roles and duties. Holds HR duty and sales-manager duty.
 *   L3 CTO        — reports to the Director: runs development (assigns and reviews work, first step of developers' leave).
 *   L4 Sales and the finance person (Finance duty) — report to the Director: prepare, never approve.
 *   L5 Developer / SQA — report to the CTO: own work.
 * Maker-checker: the finance person (or anyone) prepares, the Director approves. The Director never prepares finance
 * items, so there is always a second person.
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
  "auth.unlock_account", "session.force_logout", "comms.admin", "announcements.publish", "approval.approve",
];

/**
 * L1 CEO / Founder / Owner: oversight. Every "view" and export; nothing to manage or approve. leave.approve,
 * attendance.approve_correction and approval.approve exist only for the Director's own items; unlocking and resetting the
 * authenticator only for the Director (the server enforces both limits).
 */
const OWNER: Permission[] = [
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
  // Decision D25: only for the Director's own items (leave, corrections, journal entries, hire requests)
  "leave.approve", "attendance.approve_correction", "approval.approve", "finance.entry_approve", "people.approve_hire",
  "auth.unlock_account", "auth.reset_two_factor",
];

/** L2 Director: the approver for everything and the org administrator, plus HR duty and sales-manager duty. Prepares no finance items. */
const DIRECTOR: Permission[] = [
  ...MANAGER,
  "org.manage", "roles.manage", "duty.assign", "people.view_personal", "people.view_pay", "people.manage", "people.manage_pay",
  "auth.set_temporary_password", "auth.reset_two_factor",
  "activity.security", "performance.weights",
  // Decision D25: the Director approves everything below the Owner in one step (payroll, month close, reopening, entries, hires)
  "payroll.view", "payroll.approve", "payroll.export",
  "finance.view", "finance.entry_approve", "finance.close_approve", "finance.reopen", "finance.authority_manage", "finance.export", "people.approve_hire",
  "statements.view", "statements.export", "sheet.view", "insights.view",
  "audit.view", "settings.view", "settings.manage", "backup.view",
  "billing.view", "subscriptions.view", "subscriptions.manage",
  "sales.own", "sales.team", "sales.all", "sales.targets", "sales.commission_view", "sales.commission_approve", "sales.export",
  "integrations.view", "integrations.manage",
];

/** L3 CTO: runs development, security events, backups and the sales tool connections. No finance, payroll or sales data. */
const CTO: Permission[] = [
  ...MANAGER,
  "activity.security", "settings.view", "backup.view", "integrations.view", "integrations.manage",
];

/** L4 Sales: own leads, deals, follow-ups and daily report. Manages nobody. */
const SALES: Permission[] = [...BASE, "sales.own"];

/** L4 Finance person: the role adds nothing; the finance permissions come from the Finance duty (prepares, never approves). */
const FINANCE: Permission[] = [...BASE];

/** L5 Developer / SQA. */
const DEVELOPER: Permission[] = [...BASE];

export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  owner: OWNER,
  director: DIRECTOR,
  cto: CTO,
  sales: SALES,
  finance: FINANCE,
  developer: DEVELOPER,
};

/** Duties add permissions on top of a role. Finance duty: the finance person. HR and sales-manager duty: the Director. */
export const DUTY_PERMISSIONS: Record<Duty, Permission[]> = {
  finance: [
    "finance.view", "finance.entry_create", "finance.close", "payroll.view", "payroll.prepare",
    "statements.view", "sheet.view", "sheet.import", "insights.view",
    "billing.view", "billing.manage", "subscriptions.view", "sales.commission_view",
    "people.view_pay",
  ],
  hr: ["people.view_job", "people.view_personal", "people.manage", "auth.unlock_account", "auth.set_temporary_password", "auth.reset_two_factor"],
  sales_manager: ["sales.own", "sales.team", "sales.targets", "sales.export"],
};

export const ROLE_LABEL: Record<RoleKey, string> = {
  owner: "CEO / Founder / Owner",
  director: "Director",
  cto: "CTO",
  sales: "Sales",
  finance: "Finance",
  developer: "Developer / SQA",
};

export const DUTY_LABEL: Record<Duty, string> = {
  finance: "Finance duty",
  hr: "HR duty",
  sales_manager: "Sales manager",
};

/** The same names as the server's levels table. */
export const LEVEL_LABEL: Record<number, string> = {
  1: "CEO / Founder / Owner",
  2: "Director",
  3: "CTO",
  4: "Sales and Finance",
  5: "Developer / SQA",
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
