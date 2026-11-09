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

const EMPLOYEE: Permission[] = [
  "org.view", "people.view_directory", "activity.view_own", "task.view_own", "performance.view_own",
  "attendance.self", "leave.request", "payroll.view_own", "comms.use",
];

const LEAD: Permission[] = [
  ...EMPLOYEE,
  "people.view_job", "standin.manage", "activity.view_team", "task.assign", "task.review", "task.view_team",
  "performance.view_team", "attendance.view_team", "attendance.approve_correction", "leave.approve",
];

const DIRECTOR: Permission[] = [
  ...LEAD,
  "roles.manage", "people.view_personal", "people.view_pay", "people.manage", "people.manage_pay",
  "auth.unlock_account", "session.force_logout", "activity.view_all",
  "performance.view_all", "performance.weights",
  "payroll.view", "payroll.review", "payroll.export",
  "finance.view", "finance.entry_approve", "finance.export",
  "statements.view", "statements.export", "sheet.view", "insights.view",
  "audit.view", "settings.view", "settings.manage", "backup.view",
  "billing.view", "subscriptions.view", "subscriptions.manage",
  "comms.admin", "announcements.publish",
  "sales.own", "sales.team", "sales.all", "sales.targets", "sales.commission_view", "sales.commission_approve", "sales.export",
  "integrations.view", "integrations.manage",
];

const CTO: Permission[] = [
  ...LEAD,
  "roles.manage", "auth.unlock_account", "session.force_logout", "activity.view_all", "activity.security",
  "performance.view_all", "audit.view", "settings.view", "backup.view",
  "comms.admin", "announcements.publish", "integrations.view", "integrations.manage",
];

const CEO: Permission[] = [
  ...DIRECTOR,
  "org.manage", "activity.security", "payroll.approve", "finance.close", "finance.reopen", "billing.manage",
];

export const ROLE_PERMISSIONS: Record<RoleKey, Permission[]> = {
  owner: [...PERMISSIONS],
  ceo: CEO,
  director: DIRECTOR,
  cto: CTO,
  hr_lead: LEAD,
  team_lead: LEAD,
  sales_lead: [...LEAD, "sales.own"],
  employee: EMPLOYEE,
  sales_exec: [...EMPLOYEE, "sales.own"],
};

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
  director: "Director",
  cto: "CTO",
  hr_lead: "HR lead",
  team_lead: "Team lead",
  sales_lead: "Sales team lead",
  employee: "Employee",
  sales_exec: "Sales executive",
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
  4: "Lead",
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
