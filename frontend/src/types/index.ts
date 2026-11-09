/**
 * Shared domain types used by more than one module.
 * Module-specific types live in src/features/<module>/types.ts (the API contract).
 * Spec: ../../spec.md §7.2
 */

/**
 * Hierarchy level (Aceva structure, spec §2.1):
 * 1 CEO / Founder / Owner · 2 Director · 3 CTO · 4 Sales and Finance · 5 Software Development employees
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
 * The structure is fixed: CEO / Founder / Owner → Director → (CTO → Development) · Sales · Finance.
 * "ceo" is one person who is the CEO, the Founder and the Owner: sees everything, approves nothing.
 * "finance" is the finance person (finance duty): prepares; the Director approves.
 */
export type RoleKey = "ceo" | "director" | "cto" | "sales" | "finance" | "developer";

export const ROLE_LEVEL: Record<RoleKey, Level> = { ceo: 1, director: 2, cto: 3, sales: 4, finance: 4, developer: 5 };

/** Default role for a level. Level 4 holds both Sales and Finance: use roleFor() when the department is known. */
export const LEVEL_ROLE: Record<Level, RoleKey> = { 1: "ceo", 2: "director", 3: "cto", 4: "sales", 5: "developer" };

/** Role for a level in a department (level 4 in the Finance department is the finance person). */
export function roleFor(level: Level, departmentId?: string): RoleKey {
  if (level === 4 && departmentId === "dep-fin") return "finance";
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
