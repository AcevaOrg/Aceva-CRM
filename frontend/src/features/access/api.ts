/**
 * Module 1 service functions. Mock today; each JSDoc names the real endpoint (spec §7.3).
 */
import { ApiError, mock, notFound } from "@/lib/api/mock";
import type { Permission } from "@/lib/auth/permissions";
import { descendantsOf, scopeOf } from "@/lib/auth/scope";
import { getViewer } from "@/lib/auth/viewer";
import { departmentsTable, employeesTable, employeeName, officesTable } from "@/lib/directory";
import { uid } from "@/lib/utils";
import { table } from "@/mocks/db";
import { seedOrgChanges, seedRoles, seedStandIns } from "@/mocks/seed/access";
import { isManager, REPORTS_TO_HINT, reportsToLevel, roleEditBlock, validateStandIn, wouldCreateCycle } from "./logic";
import type { DepartmentInput, DepartmentsView, MoveInput, OfficeInput, OrgChange, OrgNode, Role, StandIn, StandInInput } from "./types";

const rolesTable = () => table<Role>("access.roles", seedRoles);
const standInsTable = () => table<StandIn>("access.standins", seedStandIns);
const changesTable = () => table<OrgChange>("access.changes", seedOrgChanges);

function logChange(kind: OrgChange["kind"], summary: string, reason: string) {
  changesTable().unshift({ id: uid("oc"), kind, summary, reason, by: getViewer().employee.empId, at: new Date().toISOString() });
}

function requirePermission(p: Permission, message: string) {
  if (!getViewer().can(p)) throw new ApiError("forbidden", message, 403);
}

export const accessApi = {
  /** GET /org/tree */
  tree: () =>
    mock<OrgNode[]>(() =>
      employeesTable()
        .filter((e) => e.status !== "left")
        .map(({ empId, name, designation, level, departmentId, officeId, reportsTo, avatarHue, status, role, duties }) => ({
          empId, name, designation, level, departmentId, officeId, reportsTo, avatarHue, status, role, duties,
        })),
    ),

  /** PATCH /org/reporting-line { empId, reportsTo, reason } — the Director only (org.manage); never their own line */
  move: ({ empId, reportsTo, reason }: MoveInput) =>
    mock(() => {
      requirePermission("org.manage", "Only the Director can change reporting lines.");
      const list = employeesTable();
      const emp = list.find((e) => e.empId === empId);
      if (!emp) notFound("Employee");
      if (emp.empId === getViewer().employee.empId) throw new ApiError("forbidden", "Nobody changes their own reporting line.", 403);
      if (wouldCreateCycle(empId, reportsTo, list)) throw new ApiError("validation", "That would put someone above their own manager.");
      const boss = list.find((e) => e.empId === reportsTo);
      if (!boss || boss.level !== reportsToLevel(emp.level)) throw new ApiError("validation", `${REPORTS_TO_HINT[emp.level]} Choose someone at that level.`);
      if (!reason.trim()) throw new ApiError("validation", "A reason is required.");
      emp.reportsTo = reportsTo;
      logChange("reporting_line", `${emp.name} now reports to ${employeeName(reportsTo)}`, reason);
    }),

  /** GET /departments · GET /offices */
  departments: () =>
    mock<DepartmentsView>(() => {
      const active = employeesTable().filter((e) => e.status !== "left");
      const headcount: Record<string, number> = {};
      const officeHeadcount: Record<string, number> = {};
      active.forEach((e) => {
        headcount[e.departmentId] = (headcount[e.departmentId] ?? 0) + 1;
        officeHeadcount[e.officeId] = (officeHeadcount[e.officeId] ?? 0) + 1;
      });
      return { departments: departmentsTable(), offices: officesTable(), headcount, officeHeadcount };
    }),

  /** POST /departments */
  createDepartment: (input: DepartmentInput) =>
    mock(() => {
      requirePermission("org.manage", "Only the Director can add departments.");
      const head = employeesTable().find((e) => e.empId === input.headEmpId);
      if (!head || !isManager(head)) throw new ApiError("validation", "A department head must be a manager: the Director or the CTO.");
      const hues = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
      departmentsTable().push({ id: uid("dep"), name: input.name, headEmpId: input.headEmpId, officeIds: input.officeIds, color: hues[departmentsTable().length % hues.length] });
      logChange("department", `Department added: ${input.name}`, input.reason);
    }),

  /** POST /offices */
  addOffice: (input: OfficeInput) =>
    mock(() => {
      requirePermission("org.manage", "Only the Director can add offices.");
      officesTable().push({ id: uid("off"), name: input.name, city: input.city });
      logChange("office", `Office added: ${input.name}`, "New office");
    }),

  /** GET /roles */
  roles: () => mock(() => rolesTable()),

  /** PATCH /roles/:id/permissions { permissions, reason } */
  updateRole: (roleId: string, permissions: Permission[], reason: string, summary: string) =>
    mock(() => {
      requirePermission("roles.manage", "Only the Director edits roles and permissions.");
      const role = rolesTable().find((r) => r.id === roleId);
      if (!role) notFound("Role");
      const blocked = roleEditBlock(getViewer().employee, role);
      if (blocked) throw new ApiError("forbidden", blocked, 403);
      role.permissions = permissions;
      role.updatedAt = new Date().toISOString();
      role.updatedBy = getViewer().employee.empId;
      logChange("role_permissions", `${role.name}: ${summary}`, reason);
    }),

  /** GET /stand-ins (own, the managers below you, and the ones where you stand in; the CEO / Founder / Owner views all) */
  standIns: () =>
    mock(() => {
      const v = getViewer();
      const scope = scopeOf(v.employee.empId);
      return standInsTable().filter((s) => scope.has(s.managerEmpId) || s.standInEmpId === v.employee.empId);
    }),

  /** POST /stand-ins — managers only (Director, CTO); for someone else only with roles.manage and only below you */
  createStandIn: (input: StandInInput) =>
    mock(() => {
      const v = getViewer();
      if (!v.can("standin.manage") || !isManager(v.employee)) throw new ApiError("forbidden", "Only managers (Director, CTO) set stand-ins.", 403);
      const forOther = input.managerEmpId !== v.employee.empId;
      if (forOther && !(v.can("roles.manage") && descendantsOf(v.employee.empId).includes(input.managerEmpId)))
        throw new ApiError("forbidden", "You can set a stand-in for yourself, or for a manager below you.", 403);
      const err = validateStandIn(input, employeesTable());
      if (err) throw new ApiError("validation", err);
      standInsTable().unshift({ id: uid("si"), ...input, createdBy: v.employee.empId, createdAt: new Date().toISOString() });
      logChange("stand_in", `${employeeName(input.standInEmpId)} stands in for ${employeeName(input.managerEmpId)}`, input.reason || "Stand-in set");
    }),

  /** DELETE /stand-ins/:id (ends early, kept in history) */
  endStandIn: (id: string, reason: string) =>
    mock(() => {
      const s = standInsTable().find((x) => x.id === id);
      if (!s) notFound("Stand-in");
      const v = getViewer();
      if (!v.can("standin.manage")) throw new ApiError("forbidden", "View only. Managers end their own stand-ins.", 403);
      if (s.managerEmpId !== v.employee.empId && !(v.can("roles.manage") && descendantsOf(v.employee.empId).includes(s.managerEmpId)))
        throw new ApiError("forbidden", "Only the manager, or someone above them, can end this stand-in.", 403);
      s.endedAt = new Date().toISOString();
      s.endReason = reason;
      logChange("stand_in", `Stand-in ended early for ${employeeName(s.managerEmpId)}`, reason);
    }),

  /** GET /org/changes (from the audit log) */
  changes: () => mock(() => changesTable().slice(0, 12)),
};
