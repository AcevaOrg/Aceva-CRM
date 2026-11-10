/**
 * Module 1 · Hierarchy and access control (plan §5)
 * Owner: Developer A (cycle 1). Spec §9.1.
 * API contract for the module.
 */
import type { Department, Duty, Employee, Level, Office, RoleKey } from "@/types";
import type { Permission } from "@/lib/auth/permissions";

export type { Department, Office };

/** One person in the org chart (a light view of Employee). */
export type OrgNode = Pick<
  Employee,
  "empId" | "name" | "designation" | "level" | "departmentId" | "officeId" | "reportsTo" | "avatarHue" | "status" | "role" | "duties"
>;

export interface Role {
  id: string;
  key: RoleKey | Duty;
  name: string;
  /** Default level for a level role; empty for duty add-ons. */
  level?: Level;
  isDuty: boolean;
  description: string;
  permissions: Permission[];
  updatedAt?: string;
  updatedBy?: string;
}

export interface StandIn {
  id: string;
  managerEmpId: string;
  /** Null when the manager is away with no stand-in: approvals go one level up. */
  standInEmpId: string | null;
  from: string;
  to: string;
  reason?: string;
  createdBy: string;
  createdAt: string;
  /** Set when ended early; the record is kept in history. */
  endedAt?: string;
  endReason?: string;
}

export type StandInStatus = "active" | "upcoming" | "ended";

export interface OrgChange {
  id: string;
  kind: "reporting_line" | "level" | "duty" | "role_permissions" | "department" | "office" | "stand_in";
  summary: string;
  reason: string;
  by: string;
  at: string;
}

export interface MoveInput {
  empId: string;
  reportsTo: string;
  reason: string;
}

export interface ChangeLevelInput {
  empId: string;
  level: Level;
  reason: string;
}

export interface DutyInput {
  empId: string;
  duty: Duty;
  reason: string;
}

export interface StandInInput {
  managerEmpId: string;
  /** Empty = away with no stand-in. */
  standInEmpId: string;
  from: string;
  to: string;
  reason?: string;
}

export interface DepartmentInput {
  name: string;
  headEmpId: string;
  officeIds: string[];
  reason: string;
}

export interface OfficeInput {
  name: string;
  city: string;
}

export interface DepartmentsView {
  departments: Department[];
  offices: Office[];
  /** departmentId → active headcount */
  headcount: Record<string, number>;
  /** officeId → active headcount */
  officeHeadcount: Record<string, number>;
}
