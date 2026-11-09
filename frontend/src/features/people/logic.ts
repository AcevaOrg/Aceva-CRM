/**
 * Who can see and edit which part of a profile (plan §7 table). Mirrored on the server.
 */
import type { Viewer } from "@/lib/auth/viewer";
import type { Employee, EmploymentStatus, EmploymentType } from "@/types";
import type { DocumentKind, ProfileAccess } from "./types";

/**
 * - Basic: everyone (staff directory)
 * - Job: the employee and the levels above them (+ HR)
 * - Personal: the employee, HR, Director and above
 * - Pay: the employee (own only), Director, CEO, Owner, finance duty
 * - Documents: the employee, HR, Director and above
 */
export function profileAccess(viewer: Viewer, target: Employee, isAbove: boolean): ProfileAccess {
  const self = viewer.employee.empId === target.empId;
  const personalRole = viewer.can("people.view_personal");
  const payRole = viewer.can("people.view_pay") || viewer.can("payroll.prepare");
  const job = self || isAbove || viewer.can("people.view_job") || viewer.can("people.manage");
  return {
    isSelf: self,
    see: {
      basic: true,
      job,
      personal: self || personalRole,
      pay: self || payRole,
      documents: self || personalRole,
      history: job,
    },
    edit: {
      basic: viewer.can("people.manage"),
      job: viewer.can("people.manage") && !self,
      personal: viewer.can("people.manage") ? "all" : self ? "contact" : "none",
      pay: viewer.can("people.manage_pay") && !self,
      documents: self || viewer.can("people.manage"),
    },
    revealCnic: self || personalRole,
    revealPay: self || payRole,
  };
}

export const TYPE_LABEL: Record<EmploymentType, string> = { full_time: "Full-time", part_time: "Part-time", intern: "Intern" };

export const STATUS_INFO: Record<EmploymentStatus, { label: string; tone: "success" | "warning" | "outline" }> = {
  active: { label: "Active", tone: "success" },
  on_notice: { label: "On notice", tone: "warning" },
  left: { label: "Left", tone: "outline" },
};

export const DOC_LABEL: Record<DocumentKind, string> = { cv: "CV", contract: "Contract", cnic: "CNIC copy", certificate: "Certificate", other: "Other" };

/** Default weekly capacity (plan §9): 40 h, lower for part-time staff and interns. */
export const capacityFor = (type: EmploymentType) => (type === "full_time" ? 40 : 20);

/** Suggest firstname@acevatech.com, adding the last name if taken. */
export function suggestEmail(name: string, taken: string[]) {
  const parts = name.trim().toLowerCase().replace(/[^a-z\s]/g, "").split(/\s+/).filter(Boolean);
  if (!parts.length) return "";
  const first = `${parts[0]}@acevatech.com`;
  if (!taken.includes(first)) return first;
  return `${parts[0]}.${parts[parts.length - 1]}@acevatech.com`;
}

/** Next Emp-ID: ACV-0001, ACV-0002 … never reused (plan §6). */
export function nextEmpId(existing: string[]) {
  const max = existing.reduce((m, id) => Math.max(m, Number(id.replace(/\D/g, "")) || 0), 0);
  return `ACV-${String(max + 1).padStart(4, "0")}`;
}
