/** Seed: roles, stand-ins and recent access changes (Module 1). */
import type { OrgChange, Role, StandIn } from "@/features/access/types";
import { DUTY_LABEL, DUTY_PERMISSIONS, ROLE_LABEL, ROLE_PERMISSIONS } from "@/lib/auth/permissions";
import type { Duty, Level, RoleKey } from "@/types";
import { daysFromNow, minutesAgo } from "../time";

const ROLE_META: Record<RoleKey, { level: Level; description: string }> = {
  owner: { level: 1, description: "Every permission. Can change levels and reporting lines." },
  ceo: { level: 2, description: "Runs the company. Approves payroll and month close." },
  director: { level: 3, description: "Department summaries, finance review, pay fields and settings." },
  cto: { level: 3, description: "Technology, security alerts and sales tool connections." },
  hr_lead: { level: 4, description: "Leads a team. HR work comes from the HR duty add-on." },
  team_lead: { level: 4, description: "Assigns and reviews tasks for their team." },
  sales_lead: { level: 4, description: "Leads the sales team." },
  employee: { level: 5, description: "Own tasks, attendance, leave, scorecard and payslips." },
  sales_exec: { level: 5, description: "Employee with their own leads and deals." },
};

const DUTY_DESCRIPTION: Record<Duty, string> = {
  finance: "Prepares entries and payroll. Given by the Director in writing, reviewed every 3 months.",
  hr: "Profiles, onboarding, offboarding and account unlocks.",
  sales_manager: "Sets sales targets, moves leads and confirms Won deals.",
};

export function seedRoles(): Role[] {
  const levelRoles: Role[] = (Object.keys(ROLE_PERMISSIONS) as RoleKey[]).map((key) => ({
    id: `role_${key}`,
    key,
    name: ROLE_LABEL[key],
    level: ROLE_META[key].level,
    isDuty: false,
    description: ROLE_META[key].description,
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

export function seedStandIns(): StandIn[] {
  return [
    { id: "si_1", managerEmpId: "ACV-0014", standInEmpId: "ACV-0003", from: daysFromNow(-1, "00:00"), to: daysFromNow(2, "23:59"), reason: "Client visit in Lahore", createdBy: "ACV-0014", createdAt: daysFromNow(-3, "11:20") },
    { id: "si_2", managerEmpId: "ACV-0006", standInEmpId: "ACV-0004", from: daysFromNow(7, "00:00"), to: daysFromNow(11, "23:59"), reason: "Annual leave", createdBy: "ACV-0006", createdAt: daysFromNow(-1, "16:05") },
    { id: "si_3", managerEmpId: "ACV-0005", standInEmpId: "ACV-0003", from: daysFromNow(-30, "00:00"), to: daysFromNow(-27, "23:59"), reason: "Sick leave", createdBy: "ACV-0005", createdAt: daysFromNow(-31, "09:40") },
  ];
}

export function seedOrgChanges(): OrgChange[] {
  return [
    { id: "oc_1", kind: "reporting_line", summary: "Nida Aslam now reports to Fahad Khan", reason: "Intern placed with the engineering team", by: "ACV-0002", at: minutesAgo(60 * 24 * 12) },
    { id: "oc_2", kind: "role_permissions", summary: "Finance duty: added Subscriptions view", reason: "Finance tracks renewal costs", by: "ACV-0001", at: minutesAgo(60 * 24 * 6) },
    { id: "oc_3", kind: "stand_in", summary: "Bilal Ahmed stands in for Saad Mirza", reason: "Client visit in Lahore", by: "ACV-0014", at: minutesAgo(60 * 24 * 3) },
    { id: "oc_4", kind: "office", summary: "Office added: Karachi Studio", reason: "New studio for the design team", by: "ACV-0002", at: minutesAgo(60 * 24 * 40) },
  ];
}
