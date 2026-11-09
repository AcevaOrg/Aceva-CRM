/**
 * Module 3 · Employee profiles (plan §7)
 * Owner: Developer C (cycle 1). Spec §9.3.
 * API contract for the module. The Employee record itself is shared (src/types).
 */
import type { Employee, EmploymentStatus, EmploymentType, Level, Money } from "@/types";

export type { Employee, EmploymentStatus, EmploymentType };

export interface EmergencyContact {
  name: string;
  relation: string;
  phone: string;
}

/** Personal part (Confidential). CNIC is masked by the server unless revealed. */
export interface PersonalDetails {
  cnic: string;
  phone: string;
  address: string;
  emergencyContact: EmergencyContact;
}

export interface Allowance {
  name: string;
  amount: Money;
}

/** Pay part (Highly confidential). Account number is masked unless revealed. */
export interface PayDetails {
  baseSalary: Money;
  allowances: Allowance[];
  bankName: string;
  accountNumber: string;
}

export type DocumentKind = "cv" | "contract" | "cnic" | "certificate" | "other";

export interface EmployeeDocument {
  id: string;
  empId: string;
  kind: DocumentKind;
  fileName: string;
  sizeBytes: number;
  uploadedAt: string;
  uploadedBy: string;
}

export type ProfileSection = "basic" | "job" | "personal" | "pay" | "documents" | "history";

export interface FieldChange {
  id: string;
  empId: string;
  section: ProfileSection;
  field: string;
  oldValue: string;
  newValue: string;
  changedBy: string;
  changedAt: string;
  reason?: string;
}

/** What the viewer may see and edit on one profile (computed by the server). */
export interface ProfileAccess {
  see: Record<ProfileSection, boolean>;
  edit: { basic: boolean; job: boolean; personal: "none" | "contact" | "all"; pay: boolean; documents: boolean };
  revealCnic: boolean;
  revealPay: boolean;
  isSelf: boolean;
}

export interface ProfileView {
  employee: Employee;
  access: ProfileAccess;
  personal?: PersonalDetails;
  pay?: PayDetails;
  documents?: EmployeeDocument[];
  history?: FieldChange[];
}

export interface BasicPatch {
  name?: string;
  designation?: string;
  departmentId?: string;
  officeId?: string;
  officialEmail?: string;
}

export interface JobPatch {
  level?: Level;
  reportsTo?: string;
  joiningDate?: string;
  type?: EmploymentType;
  status?: Exclude<EmploymentStatus, "left">;
  weeklyCapacityHours?: number;
}

export type PersonalPatch = Partial<PersonalDetails>;

export interface PayPatch {
  baseSalary?: number;
  allowances?: { name: string; amount: number }[];
  bankName?: string;
  accountNumber?: string;
}

export interface OnboardingInput {
  name: string;
  designation: string;
  departmentId: string;
  officeId: string;
  officialEmail: string;
  level: Level;
  reportsTo: string;
  joiningDate: string;
  type: EmploymentType;
  pay?: { baseSalary: number; allowanceName?: string; allowanceAmount?: number; bankName: string; accountNumber: string };
}

export interface OffboardPreview {
  openTasks: number;
  manager?: string;
  directReports: number;
  isSales: boolean;
  activeSessions: number;
}

export interface OffboardInput {
  lastWorkingDay: string;
  reason: string;
}
