/**
 * Pure rules for Module 1 (plan §5). Mirrored on the server; unit-test these.
 */
import type { Duty, Employee, Level } from "@/types";
import type { Permission } from "@/lib/auth/permissions";
import type { OrgNode, Role, StandIn, StandInInput, StandInStatus } from "./types";

/**
 * Who may report to whom (plan §5, decision C2). Mirrors the server, which is the real check.
 * Normally a person reports to someone at a strictly higher level. Same-level reporting is allowed only where it is
 * configured: the CTO reports to the Director (both Level 3).
 */
export function canReportTo(
  employee: Pick<Employee, "level" | "role">,
  boss: Pick<Employee, "level" | "role" | "status">,
): boolean {
  if (boss.status === "left" || employee.level === 1) return false;
  if (boss.level < employee.level) return true;
  return boss.level === employee.level && boss.role === "director" && employee.role === "cto";
}

/** Level-only helper for the profile screens (Module 3 mock): the level a new person normally reports to. */
export function reportsToLevel(level: Level): Level | null {
  return ({ 1: null, 2: 1, 3: 2, 4: 3, 5: 3 } as Record<Level, Level | null>)[level];
}

/** Hint shown next to a "Reports to" picker. */
export const REPORTS_TO_HINT: Record<Level, string> = {
  1: "The Owner reports to nobody.",
  2: "The CEO reports to the Owner.",
  3: "The Director reports to the CEO. The CTO reports to the Director (the one same-level line).",
  4: "Heads and leads report to a Level 3 manager, usually the Director.",
  5: "Employees report to a manager above them, usually the CTO.",
};

/**
 * People who manage others and can approve for them: the CEO, the Director, the CTO and Level 4 heads and leads.
 * The Owner oversees everything but approves nothing.
 */
export const isManager = (e: Pick<Employee, "role">) => e.role === "ceo" || e.role === "director" || e.role === "cto" || e.role === "lead";

/**
 * Maker-checker on the roles matrix (only roles.manage, the Director, edits it):
 * - the CEO / Founder / Owner role is fixed: every view and export, no approve / create / manage;
 * - nobody changes their own role, a role above it, or a duty they hold.
 * Returns why the column is locked, or null when the viewer may edit it.
 */
export function roleEditBlock(
  viewer: Pick<Employee, "role" | "level" | "duties">,
  role: Pick<Role, "key" | "level" | "isDuty">,
): string | null {
  if (role.key === "owner" || role.key === "ceo") return "Fixed by the structure: the Owner and CEO roles are oversight roles.";
  if (role.isDuty) return viewer.duties.includes(role.key as Duty) ? "You hold this duty, so you can't change it." : null;
  if (role.key === viewer.role) return "Nobody changes the permissions of their own role.";
  if (role.level !== undefined && role.level < viewer.level) return "You can't change a role above yours.";
  return null;
}

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

/**
 * Stand-in rules (plan §5): a manager names a stand-in (or nobody) for set dates. The stand-in must be able to approve (not the
 * Owner), at the manager's level or higher, and not the manager. Without a stand-in, approvals go one level up.
 * The server repeats every check.
 */
export function validateStandIn(input: StandInInput, list: Pick<Employee, "empId" | "level" | "role">[]): string | null {
  if (!input.managerEmpId) return "Choose the manager.";
  const m = list.find((e) => e.empId === input.managerEmpId);
  if (m && !isManager(m)) return "Only managers have stand-ins.";
  if (input.standInEmpId) {
    if (input.managerEmpId === input.standInEmpId) return "You can't be your own stand-in.";
    const s = list.find((e) => e.empId === input.standInEmpId);
    if (s && s.role === "owner") return "The Owner approves nothing, so can't be a stand-in.";
    if (s && !isManager(s)) return "A stand-in must be someone who can approve (a manager).";
    if (m && s && s.level > m.level) return "A stand-in must be at the same level or higher.";
  }
  if (!input.from || !input.to) return "Choose the dates.";
  if (new Date(input.to) < new Date(input.from)) return "The end date is before the start date.";
  return null;
}

/** Who can stand in for this manager (another manager at the same level or higher; never the Owner). */
export function standInCandidates<T extends Pick<Employee, "empId" | "level" | "role" | "status">>(manager: Pick<Employee, "empId" | "level"> | undefined, list: T[]): T[] {
  if (!manager) return [];
  return list.filter((e) => e.status !== "left" && e.empId !== manager.empId && isManager(e) && e.level <= manager.level);
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
  "payroll.prepare": "Prepare payroll runs",
  "payroll.approve": "Approve payroll",
  "settings.view": "See settings",
  "settings.manage": "Change settings",
  "finance.entry_create": "Create journal entries",
  "finance.entry_approve": "Approve journal entries",
  "finance.close": "Run or approve the month close",
  "finance.reopen": "Reopen a closed month",
  "sales.commission_approve": "Approve commission",
};

/** "task.assign" → "Assign tasks"; falls back to a humanised action. */
export function permissionLabel(p: Permission) {
  if (ACTION_LABEL[p]) return ACTION_LABEL[p]!;
  const action = p.split(".")[1].replace(/_/g, " ");
  return action.charAt(0).toUpperCase() + action.slice(1);
}
