/**
 * Who can see and edit which part of a profile (plan §7 table). Mirrored on the server.
 */
import type { Viewer } from "@/lib/auth/viewer";
import type { Employee, EmploymentStatus, EmploymentType, Level } from "@/types";
import type { DocumentKind, ProfileAccess } from "./types";

/**
 * Structure (spec §2.1): CEO / Founder / Owner → Director (HR and sales-manager duty) → CTO → Engineering; Director → Sales, Finance.
 * - Basic: everyone (staff directory)
 * - Job: the employee, the managers above them in their reporting line, the Director (HR duty) and the CEO / Founder / Owner (view)
 * - Personal: the employee, the Director (HR duty) and the CEO / Founder / Owner (view)
 * - Pay: the employee (own only), the Director, Finance (prepares payroll) and the CEO / Founder / Owner (view). Never the CTO.
 * - Documents: the employee, the Director (HR duty) and the CEO / Founder / Owner (view)
 * Edits only go downward and only with people.manage / people.manage_pay (the Director): never their own job or pay,
 * never someone above. The CEO / Founder / Owner sees every section and edits only their own contact details and documents.
 * Levels and reporting lines change only with org.manage (the Director).
 */
export function profileAccess(viewer: Viewer, target: Employee, isAbove: boolean): ProfileAccess {
  const self = viewer.employee.empId === target.empId;
  const personalRole = viewer.can("people.view_personal");
  const payRole = viewer.can("people.view_pay") || viewer.can("payroll.prepare");
  // people.view_job is a manager permission and follows the reporting line (isAbove), never beside.
  const job = self || isAbove || viewer.can("people.manage");
  const manage = viewer.can("people.manage");
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
      basic: manage && (isAbove || self),
      job: manage && isAbove,
      personal: manage && (isAbove || self) ? "all" : self ? "contact" : "none",
      pay: viewer.can("people.manage_pay") && isAbove,
      documents: self || (manage && isAbove),
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

/**
 * Which levels belong in which department (spec §2.1): Management holds the Director, Engineering and development
 * holds the CTO and engineers, Sales holds Sales and Finance holds the finance person (both level 4).
 * A department added later can take any level below the CEO / Founder / Owner.
 */
const LEVELS_BY_DEPARTMENT: Record<string, Level[]> = { "dep-mgmt": [2], "dep-eng": [3, 5], "dep-sales": [4], "dep-fin": [4] };

const levelsFor = (departmentId: string) => LEVELS_BY_DEPARTMENT[departmentId] ?? ([2, 3, 4, 5] as Level[]);

/** Whether a level belongs in a department. */
export const fitsDepartment = (level: Level, departmentId: string) => levelsFor(departmentId).includes(level);

/** Levels the viewer may hire into a department: only below their own level (the CEO / Founder / Owner is never hired). */
export function hireLevels(viewerLevel: Level, departmentId: string): Level[] {
  return levelsFor(departmentId).filter((l) => l > viewerLevel);
}

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

/** Next Emp-ID: one above the highest ever issued, so gaps from people who left are never reused (plan §6). */
export function nextEmpId(existing: string[]) {
  const max = existing.reduce((m, id) => Math.max(m, Number(id.replace(/\D/g, "")) || 0), 0);
  return `ACV-${String(max + 1).padStart(4, "0")}`;
}
