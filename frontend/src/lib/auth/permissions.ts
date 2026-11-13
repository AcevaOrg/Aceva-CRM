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
  "finance.view", "finance.entry_create", "finance.entry_approve", "finance.close", "finance.close_approve", "finance.reopen", "finance.export", "finance.authority_manage",
  "statements.view", "statements.export", "sheet.view", "sheet.import", "insights.view",
  "audit.view", "settings.view", "settings.manage", "backup.view",
  "billing.view", "billing.manage", "subscriptions.view", "subscriptions.manage",
  "comms.use", "comms.admin", "announcements.publish",
  "sales.own", "sales.team", "sales.all", "sales.targets", "sales.commission_view", "sales.commission_approve", "sales.export",
  "integrations.view", "integrations.manage",
] as const;

export type Permission = (typeof PERMISSIONS)[number];

/*
 * Aceva structure (development plan §5, five levels):
 *   L1 Owner      — oversight: sees everything (all activity, all data) but approves nothing. Changes levels and reporting lines.
 *   L2 CEO        — oversight plus the sign-off of the Director's own leave. Changes levels and reporting lines.
 *   L3 Director   — the single approver for the whole company, plus HR duty. Gives extra duties.
 *   L3 CTO        — runs development (assigns and reviews development work, first step of developers' leave).
 *   L4 Heads/Leads — Sales, Finance (finance duty) and HR (HR duty) people: prepare, never approve company items.
 *   L5 Employees  — own work.
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

/** L1 Owner and L2 CEO: oversight. Every "view" and export; they change levels and reporting lines, nothing else. */
const OVERSIGHT: Permission[] = [
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
  "org.manage",
];

/**
 * L1 Owner: oversight, plus what the plan sends to the top: the Director's own leave and corrections (approvals move up),
 * finance entries above the CEO's limit and all capital and loan entries (section 13), and reopening a closed month.
 * Mirrors backend/prisma/permission-catalogue.ts (the server is the real lock).
 */
/** Decision D22: only the Owner changes approval limits, finance-wide security settings and the "Owner approves" rule. */
const OWNER: Permission[] = [...OVERSIGHT, "leave.approve", "attendance.approve_correction", "finance.entry_approve", "finance.reopen", "finance.authority_manage"];

/** L2 CEO: oversight, the Director's own leave; plan sections 12-13: approves payroll and the month close, entries up to the CEO limit, reopens months. */
const CEO: Permission[] = [
  ...OVERSIGHT, "standin.manage", "auth.unlock_account", "session.force_logout", "leave.approve", "attendance.approve_correction",
  "payroll.approve", "finance.entry_approve", "finance.close_approve", "finance.reopen",
];

/** L2 Director: the approver for everything, plus HR duty, sales-manager duty and company administration. Prepares no finance items. */
const DIRECTOR: Permission[] = [
  ...MANAGER,
  "roles.manage", "people.view_personal", "people.view_pay", "people.manage", "people.manage_pay",
  "activity.security", "performance.weights",
  // Plan section 12: the Director REVIEWS payroll and the CEO approves it. Section 13: the finance duty person runs the
  // month close, the CEO approves it, and only the Owner or CEO reopen a closed month.
  "payroll.view", "payroll.review", "payroll.export",
  "finance.view", "finance.entry_approve", "finance.export",
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

/** L4 Department Head / Team Lead (default Level 4 role): own work plus a team lead's basics. Extra duties add more. */
const LEVEL4_DEFAULT: Permission[] = [
  ...BASE, "standin.manage", "task.assign", "task.review", "task.view_team",
  // Plan section 11: leave goes to the team lead first, corrections to the manager; team attendance down the line.
  "leave.approve", "attendance.approve_correction", "attendance.view_team",
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

/** L5 Software Development employees. */
const DEVELOPER: Permission[] = [...BASE];

export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  owner: OWNER,
  ceo: CEO,
  level4_default: LEVEL4_DEFAULT,
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
  ],
  hr: ["people.view_job", "people.view_personal", "people.manage", "auth.unlock_account"],
  sales_manager: ["sales.own", "sales.team", "sales.targets", "sales.export"],
};

export const ROLE_LABEL: Record<RoleKey, string> = {
  owner: "Owner",
  ceo: "CEO",
  level4_default: "Department Head / Team Lead",
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

export const LEVEL_LABEL: Record<number, string> = {
  1: "Owner",
  2: "CEO",
  3: "Director / CTO",
  4: "Department Head / Team Lead",
  5: "Employee",
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
