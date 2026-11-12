/**
 * Shared domain types used by more than one module.
 * Module-specific types live in src/features/<module>/types.ts (the API contract).
 * Spec: ../../spec.md §7.2
 */

/**
 * Hierarchy level (the final company structure, five levels):
 * 1 CEO / Founder / Owner · 2 Director · 3 CTO · 4 Sales and Finance · 5 Developer / SQA
 * Everybody reports to someone at a strictly higher level: the Director to the CEO / Founder / Owner, the CTO, Sales
 * and Finance to the Director, Developer / SQA to the CTO. There is no same-level reporting line.
 */
export type Level = 1 | 2 | 3 | 4 | 5;

export type Currency = "PKR" | "USD";

/** Money is a decimal STRING with 2 decimals, never a float (spec §7.2). */
export interface Money {
  amount: string;
  currency: Currency;
}

export type Confidentiality = "highly" | "confidential" | "internal" | "own";

export type Zone = "home" | "work" | "finance" | "sales" | "control";

/** Extra duties added on top of a level (spec §2.1). */
export type Duty = "finance" | "hr" | "sales_manager";

/**
 * One role per person; the role belongs to a level. Extra duties (Finance, HR, sales manager) are separate.
 * The same keys as the server, except Level 5: the server's "employee" role is "developer" here (see roleFromApi).
 * "owner" is the CEO / Founder / Owner (one person); there is no separate CEO role.
 */
export type RoleKey = "owner" | "director" | "cto" | "sales" | "finance" | "developer";

export const ROLE_LEVEL: Record<RoleKey, Level> = { owner: 1, director: 2, cto: 3, sales: 4, finance: 4, developer: 5 };

/** Default role of each level (the same as the server). The Level 4 finance role is chosen by department (roleFor). */
export const LEVEL_ROLE: Record<Level, RoleKey> = { 1: "owner", 2: "director", 3: "cto", 4: "sales", 5: "developer" };

/** The role that oversees the whole company: the CEO / Founder / Owner (sees everything, approves nothing). */
export const isTopLevelRole = (role: RoleKey) => role === "owner";

/** Role for a level in a department (level 4 in the Finance department is the finance person). */
export function roleFor(level: Level, departmentId?: string): RoleKey {
  if (level === 4 && departmentId === "dep-fin") return "finance";
  if (level === 4 && departmentId === "dep-sales") return "sales";
  return LEVEL_ROLE[level];
}

export type EmploymentType = "full_time" | "part_time" | "intern";
export type EmploymentStatus = "active" | "on_notice" | "left";

export interface Employee {
  id: string;
  empId: string;
  name: string;
  designation: string;
  departmentId: string;
  officeId: string;
  officialEmail: string;
  level: Level;
  role: RoleKey;
  duties: Duty[];
  reportsTo: string | null;
  joiningDate: string;
  type: EmploymentType;
  status: EmploymentStatus;
  weeklyCapacityHours: number;
  avatarHue: number;
  lastWorkingDay?: string;
}

export interface Department {
  id: string;
  name: string;
  headEmpId: string;
  color: string;
  officeIds: string[];
}

export interface Office {
  id: string;
  name: string;
  city: string;
}

export interface Attachment {
  id: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  uploadedAt: string;
  uploadedBy: string;
}

export type ApprovalState = "done" | "waiting" | "pending" | "skipped" | "rejected";

/** One step of a maker-checker chain (spec §3.5.6). */
export interface ApprovalStep {
  label: string;
  empId?: string;
  state: ApprovalState;
  at?: string;
  note?: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  details?: Record<string, string[]>;
}
