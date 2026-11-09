/**
 * Pure rules for Module 1 (plan §5). Mirrored on the server; unit-test these.
 */
import type { Employee } from "@/types";
import type { Permission } from "@/lib/auth/permissions";
import type { OrgNode, StandIn, StandInInput, StandInStatus } from "./types";

export interface TreeNode {
  node: OrgNode;
  children: TreeNode[];
  /** Everyone below, at any depth. */
  size: number;
}

/** Nest a flat list into trees (roots = nobody to report to, or boss not in the list). */
export function buildTree(list: OrgNode[]): TreeNode[] {
  const ids = new Set(list.map((n) => n.empId));
  const make = (n: OrgNode): TreeNode => {
    const children = list.filter((c) => c.reportsTo === n.empId).map(make);
    return { node: n, children, size: children.reduce((s, c) => s + 1 + c.size, 0) };
  };
  return list.filter((n) => !n.reportsTo || !ids.has(n.reportsTo)).map(make);
}

export function descendantIds(empId: string, list: Pick<Employee, "empId" | "reportsTo">[]): string[] {
  const out: string[] = [];
  const walk = (id: string) =>
    list.filter((e) => e.reportsTo === id).forEach((c) => {
      out.push(c.empId);
      walk(c.empId);
    });
  walk(empId);
  return out;
}

/** Moving someone under themselves or under their own report would make a loop. */
export function wouldCreateCycle(empId: string, newBoss: string, list: Pick<Employee, "empId" | "reportsTo">[]) {
  return empId === newBoss || descendantIds(empId, list).includes(newBoss);
}

export function standInStatus(s: StandIn, now = Date.now()): StandInStatus {
  if (s.endedAt) return "ended";
  const from = new Date(s.from).getTime();
  const to = new Date(s.to).getTime();
  if (to < now) return "ended";
  if (from > now) return "upcoming";
  return "active";
}

/** Stand-in rules: not yourself, same level or higher, valid dates (plan §5). */
export function validateStandIn(input: StandInInput, list: Pick<Employee, "empId" | "level">[]): string | null {
  if (!input.managerEmpId || !input.standInEmpId) return "Choose both people.";
  if (input.managerEmpId === input.standInEmpId) return "You can't be your own stand-in.";
  const m = list.find((e) => e.empId === input.managerEmpId);
  const s = list.find((e) => e.empId === input.standInEmpId);
  if (m && s && s.level > m.level) return "A stand-in must be at the same level or higher.";
  if (!input.from || !input.to) return "Choose the dates.";
  if (new Date(input.to) < new Date(input.from)) return "The end date is before the start date.";
  return null;
}

const GROUP_LABEL: Record<string, string> = {
  org: "Org chart",
  roles: "Roles",
  standin: "Stand-ins",
  people: "People",
  auth: "Login and sessions",
  session: "Sessions",
  activity: "Activity tracking",
  task: "Tasks",
  performance: "Performance",
  attendance: "Attendance",
  leave: "Leave",
  payroll: "Payroll",
  finance: "Finance ledger",
  statements: "Statements",
  sheet: "Spreadsheet",
  insights: "Insights",
  audit: "Audit log",
  settings: "Settings",
  backup: "Backups",
  billing: "Billing",
  subscriptions: "Subscriptions",
  comms: "Messages",
  announcements: "Announcements",
  sales: "Sales",
  integrations: "Integrations",
};

export const groupLabel = (prefix: string) => GROUP_LABEL[prefix] ?? prefix;

const ACTION_LABEL: Partial<Record<Permission, string>> = {
  "org.view": "See the org chart",
  "org.manage": "Change levels and reporting lines",
  "roles.manage": "Edit roles and permissions",
  "standin.manage": "Set stand-ins",
  "people.view_directory": "See the staff directory",
  "people.view_job": "See job details",
  "people.view_personal": "See personal details (CNIC, address)",
  "people.view_pay": "See pay details",
  "people.manage": "Add and edit employees",
  "people.manage_pay": "Edit pay",
  "auth.unlock_account": "Unlock accounts",
  "session.force_logout": "Force a sign-out",
  "task.assign": "Assign tasks",
  "task.review": "Review tasks",
  "payroll.approve": "Approve payroll",
  "finance.entry_create": "Create journal entries",
  "finance.entry_approve": "Approve journal entries",
  "finance.close": "Run or approve month close",
  "finance.reopen": "Reopen a closed month",
  "sales.commission_approve": "Approve commission",
};

/** "task.assign" → "Assign tasks"; falls back to a humanised action. */
export function permissionLabel(p: Permission) {
  if (ACTION_LABEL[p]) return ACTION_LABEL[p]!;
  const action = p.split(".")[1].replace(/_/g, " ");
  return action.charAt(0).toUpperCase() + action.slice(1);
}
