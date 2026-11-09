/**
 * Shared domain types used by more than one module.
 * Module-specific types live in src/features/<module>/types.ts (the API contract).
 * Spec: ../../spec.md §7.2
 */

/** Hierarchy level: 1 Owner, 2 CEO, 3 Director/CTO, 4 Leads, 5 Employees */
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

export type RoleKey =
  | "owner"
  | "ceo"
  | "director"
  | "cto"
  | "hr_lead"
  | "team_lead"
  | "sales_lead"
  | "employee"
  | "sales_exec";

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
