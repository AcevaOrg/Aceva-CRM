/**
 * Module 1 service functions. Each one talks to the real API when Module 1 is live
 * (NEXT_PUBLIC_LIVE_MODULES=m1 or NEXT_PUBLIC_API_MODE=live) and to the in-browser mock otherwise.
 * The JSDoc of each function names the real endpoint (spec §7.3). The server is the real lock:
 * the checks in the mock branches only mirror it so the demo behaves the same.
 */
import type { AccessMe, DepartmentsResponse, OrgChangeView, StandInView } from "@aceva/contracts";
import { http, isLive } from "@/lib/api/http";
import { ApiError, mock, notFound } from "@/lib/api/mock";
import { fetchLiveOrgNodes } from "@/lib/live-org";
import { PERMISSIONS, type Permission } from "@/lib/auth/permissions";
import { descendantsOf, scopeOf } from "@/lib/auth/scope";
import { getViewer } from "@/lib/auth/viewer";
import { departmentsTable, employeesTable, employeeName, officesTable } from "@/lib/directory";
import { uid } from "@/lib/utils";
import { table } from "@/mocks/db";
import { DEPARTMENTS } from "@/mocks/seed/people";
import { seedOrgChanges, seedRoles, seedStandIns } from "@/mocks/seed/access";
import { LEVEL_ROLE, roleFor, type Duty, type RoleKey } from "@/types";
import { canReportTo, isManager, REPORTS_TO_HINT, roleEditBlock, validateStandIn, wouldCreateCycle } from "./logic";
import type {
  ChangeLevelInput,
  DepartmentInput,
  DepartmentsView,
  DutyInput,
  MoveInput,
  OfficeInput,
  OrgChange,
  OrgNode,
  Role,
  StandIn,
  StandInInput,
} from "./types";

const live = () => isLive("m1");

const rolesTable = () => table<Role>("access.roles", seedRoles);
const standInsTable = () => table<StandIn>("access.standins", seedStandIns);
const changesTable = () => table<OrgChange>("access.changes", seedOrgChanges);

function logChange(kind: OrgChange["kind"], summary: string, reason: string) {
  changesTable().unshift({ id: uid("oc"), kind, summary, reason, by: getViewer().employee.empId, at: new Date().toISOString() });
}

function requirePermission(p: Permission, message: string) {
  if (!getViewer().can(p)) throw new ApiError("forbidden", message, 403);
}

const notInLive = (what: string): never => {
  throw new ApiError("not_available", `${what} isn't part of Module 1 yet, so it is switched off while the real server is connected.`, 501);
};

const KNOWN_PERMISSIONS = new Set<string>(PERMISSIONS);
const ROLE_KEY_FROM_API: Record<string, RoleKey> = { owner: "owner", ceo: "ceo", director: "director", cto: "cto", sales: "sales", level4_default: "level4_default", employee: "developer" };

export const accessApi = {
  /** GET /org/tree */
  tree: (): Promise<OrgNode[]> =>
    live()
      ? fetchLiveOrgNodes().then((nodes) => nodes.filter((n) => n.status !== "left"))
      : mock<OrgNode[]>(() =>
          employeesTable()
            .filter((e) => e.status !== "left")
            .map(({ empId, name, designation, level, departmentId, officeId, reportsTo, avatarHue, status, role, duties }) => ({
              empId, name, designation, level, departmentId, officeId, reportsTo, avatarHue, status, role, duties,
            })),
        ),

  /** GET /access/me: who am I and what may I do (role permissions plus duty permissions). Live only. */
  me: () => http.get<AccessMe>("/access/me"),

  /** PATCH /org/employees/:empId/reporting-line { reportsToEmpId, reason }: Owner or CEO only; never their own line */
  move: async ({ empId, reportsTo, reason }: MoveInput) => {
    if (live()) return http.patch(`/org/employees/${empId}/reporting-line`, { reportsToEmpId: reportsTo, reason });
    return mock(() => {
      requirePermission("org.manage", "Only the Owner or the CEO can change reporting lines.");
      const list = employeesTable();
      const emp = list.find((e) => e.empId === empId);
      if (!emp) notFound("Employee");
      if (emp.empId === getViewer().employee.empId) throw new ApiError("forbidden", "Nobody changes their own reporting line.", 403);
      if (wouldCreateCycle(empId, reportsTo, list)) throw new ApiError("validation", "That would put someone above their own manager.");
      const boss = list.find((e) => e.empId === reportsTo);
      if (!boss || !canReportTo(emp, boss)) throw new ApiError("validation", `${REPORTS_TO_HINT[emp.level]} Choose someone allowed.`);
      if (!reason.trim()) throw new ApiError("validation", "A reason is required.");
      emp.reportsTo = reportsTo;
      logChange("reporting_line", `${emp.name} now reports to ${employeeName(reportsTo)}`, reason);
    });
  },

  /** PATCH /org/employees/:empId/level { level, reason }: Owner or CEO only, never at or above their own level */
  changeLevel: async ({ empId, level, reason }: ChangeLevelInput) => {
    if (live()) return http.patch(`/org/employees/${empId}/level`, { level, reason });
    return mock(() => {
      const v = getViewer();
      requirePermission("org.manage", "Only the Owner or the CEO can change levels.");
      const emp = employeesTable().find((e) => e.empId === empId);
      if (!emp) notFound("Employee");
      if (level <= v.employee.level) throw new ApiError("forbidden", `You can't assign Level ${level}.`, 403);
      if (!reason.trim()) throw new ApiError("validation", "A reason is required.");
      emp.level = level;
      emp.role = emp.duties.includes("finance") ? "finance" : level === 4 ? roleFor(4, emp.departmentId) : LEVEL_ROLE[level];
      logChange("level", `${emp.name} moved to Level ${level}`, reason);
    });
  },

  /** POST /org/employees/:empId/duties { dutyKey, reason }: the Director gives an extra duty */
  assignDuty: async ({ empId, duty, reason }: DutyInput) => {
    if (live()) return http.post(`/org/employees/${empId}/duties`, { dutyKey: duty, reason });
    return mock(() => {
      requirePermission("roles.manage", "Only the Director gives extra duties.");
      const emp = employeesTable().find((e) => e.empId === empId);
      if (!emp) notFound("Employee");
      if (emp.empId === getViewer().employee.empId) throw new ApiError("forbidden", "Nobody gives themselves a duty.", 403);
      if (emp.duties.includes(duty)) throw new ApiError("conflict", "They already hold this duty.", 409);
      emp.duties.push(duty);
      logChange("duty", `${emp.name} was given the ${duty} duty`, reason);
    });
  },

  /** DELETE /org/employees/:empId/duties/:dutyKey { reason }: the Director ends a duty (the record is kept) */
  endDuty: async ({ empId, duty, reason }: DutyInput) => {
    if (live()) return http.delete(`/org/employees/${empId}/duties/${duty}`, { reason });
    return mock(() => {
      requirePermission("roles.manage", "Only the Director ends extra duties.");
      const emp = employeesTable().find((e) => e.empId === empId);
      if (!emp) notFound("Employee");
      emp.duties = emp.duties.filter((d: Duty) => d !== duty);
      logChange("duty", `${emp.name} no longer holds the ${duty} duty`, reason);
    });
  },

  /** GET /org/departments (departments and offices with headcount) */
  departments: async (): Promise<DepartmentsView> => {
    if (live()) {
      const res = await http.get<DepartmentsResponse>("/org/departments");
      const colors = new Map(DEPARTMENTS.map((d) => [d.id, d.color]));
      return {
        departments: res.departments.map((d, i) => ({
          id: d.id,
          name: d.name,
          headEmpId: d.headEmpId ?? "",
          officeIds: d.officeIds,
          color: colors.get(d.id) ?? `var(--chart-${(i % 5) + 1})`,
        })),
        offices: res.offices,
        headcount: res.headcount,
        officeHeadcount: res.officeHeadcount,
      };
    }
    return mock<DepartmentsView>(() => {
      const active = employeesTable().filter((e) => e.status !== "left");
      const headcount: Record<string, number> = {};
      const officeHeadcount: Record<string, number> = {};
      active.forEach((e) => {
        headcount[e.departmentId] = (headcount[e.departmentId] ?? 0) + 1;
        officeHeadcount[e.officeId] = (officeHeadcount[e.officeId] ?? 0) + 1;
      });
      return { departments: departmentsTable(), offices: officesTable(), headcount, officeHeadcount };
    });
  },

  /** POST /org/departments { name, headEmpId, reason }: Owner or CEO */
  createDepartment: async (input: DepartmentInput) => {
    if (live()) return http.post("/org/departments", { name: input.name, headEmpId: input.headEmpId || undefined, reason: input.reason });
    return mock(() => {
      requirePermission("org.manage", "Only the Owner or the CEO can add departments.");
      const head = employeesTable().find((e) => e.empId === input.headEmpId);
      if (!head || !isManager(head)) throw new ApiError("validation", "A department head must be a manager.");
      const hues = ["var(--chart-1)", "var(--chart-2)", "var(--chart-3)", "var(--chart-4)", "var(--chart-5)"];
      departmentsTable().push({ id: uid("dep"), name: input.name, headEmpId: input.headEmpId, officeIds: input.officeIds, color: hues[departmentsTable().length % hues.length] });
      logChange("department", `Department added: ${input.name}`, input.reason);
    });
  },

  /** PATCH /org/departments/:code { headEmpId, reason }: Owner or CEO (an explicit head, audited) */
  changeDepartmentHead: async ({ departmentId, headEmpId, reason }: { departmentId: string; headEmpId: string; reason: string }) => {
    if (live()) return http.patch(`/org/departments/${departmentId}`, { headEmpId, reason });
    return mock(() => {
      requirePermission("org.manage", "Only the Owner or the CEO can change a department head.");
      const dep = departmentsTable().find((d) => d.id === departmentId);
      if (!dep) notFound("Department");
      dep.headEmpId = headEmpId;
      logChange("department", `${employeeName(headEmpId)} is now head of ${dep.name}`, reason);
    });
  },

  /** POST /org/offices { name, city, reason }: Owner or CEO */
  addOffice: async (input: OfficeInput) => {
    if (live()) return http.post("/org/offices", { name: input.name, city: input.city || undefined, reason: input.reason ?? "New office" });
    return mock(() => {
      requirePermission("org.manage", "Only the Owner or the CEO can add offices.");
      officesTable().push({ id: uid("off"), name: input.name, city: input.city });
      logChange("office", `Office added: ${input.name}`, "New office");
    });
  },

  /** GET /access/roles and /access/duties (live: read only) */
  roles: async (): Promise<Role[]> => {
    if (live()) {
      const [roles, duties] = await Promise.all([
        http.get<Array<{ key: string; name: string; level: number; permissions: string[] }>>("/access/roles"),
        http.get<Array<{ key: string; name: string; permissions: string[] }>>("/access/duties"),
      ]);
      const text = new Map(seedRoles().map((r) => [r.key, r.description]));
      const known = (ps: string[]) => ps.filter((p) => KNOWN_PERMISSIONS.has(p)) as Permission[];
      const levelRoles: Role[] = roles
        .filter((r) => r.key in ROLE_KEY_FROM_API)
        .map((r) => {
          const key = ROLE_KEY_FROM_API[r.key];
          return { id: `role_${key}`, key, name: r.name, level: r.level as Role["level"], isDuty: false, description: text.get(key) ?? "", permissions: known(r.permissions) };
        });
      const dutyRoles: Role[] = duties
        .filter((d) => d.key === "finance" || d.key === "hr" || d.key === "sales_manager")
        .map((d) => ({ id: `duty_${d.key}`, key: d.key as Duty, name: d.name, isDuty: true, description: text.get(d.key as Duty) ?? "", permissions: known(d.permissions) }));
      return [...levelRoles, ...dutyRoles];
    }
    return mock(() => rolesTable());
  },

  /** PATCH /roles/:id/permissions: not available. Role permissions are read only and change only through duties (decision). */
  updateRole: async (roleId: string, permissions: Permission[], reason: string, summary: string) => {
    if (live()) return notInLive("Editing role permissions");
    return mock(() => {
      requirePermission("roles.manage", "Only the Director edits roles and permissions.");
      const role = rolesTable().find((r) => r.id === roleId);
      if (!role) notFound("Role");
      const blocked = roleEditBlock(getViewer().employee, role);
      if (blocked) throw new ApiError("forbidden", blocked, 403);
      role.permissions = permissions;
      role.updatedAt = new Date().toISOString();
      role.updatedBy = getViewer().employee.empId;
      logChange("role_permissions", `${role.name}: ${summary}`, reason);
    });
  },

  /** GET /stand-ins (people in my reporting line, and the ones where I am the stand-in) */
  standIns: async (): Promise<StandIn[]> => {
    if (live()) {
      const rows = await http.get<StandInView[]>("/stand-ins");
      return rows.map((s) => ({
        id: s.id,
        managerEmpId: s.manager,
        standInEmpId: s.standIn,
        from: s.startsOn,
        to: `${s.endsOn}T23:59:00`,
        reason: s.reason ?? undefined,
        createdBy: s.manager,
        createdAt: s.startsOn,
        endedAt: s.revokedAt ?? undefined,
      }));
    }
    return mock(() => {
      const v = getViewer();
      const scope = scopeOf(v.employee.empId);
      return standInsTable().filter((s) => scope.has(s.managerEmpId) || s.standInEmpId === v.employee.empId);
    });
  },

  /** POST /stand-ins { standInEmpId?, startsOn, endsOn, reason? }: I am away; no stand-in means approvals go one level up */
  createStandIn: async (input: StandInInput) => {
    if (live()) {
      return http.post("/stand-ins", {
        standInEmpId: input.standInEmpId || undefined,
        startsOn: input.from.slice(0, 10),
        endsOn: input.to.slice(0, 10),
        reason: input.reason,
      });
    }
    return mock(() => {
      const v = getViewer();
      if (!v.can("standin.manage") || !isManager(v.employee)) throw new ApiError("forbidden", "Only managers set stand-ins.", 403);
      const forOther = input.managerEmpId !== v.employee.empId;
      if (forOther && !(v.can("roles.manage") && descendantsOf(v.employee.empId).includes(input.managerEmpId)))
        throw new ApiError("forbidden", "You can set a stand-in for yourself, or for a manager below you.", 403);
      const err = validateStandIn(input, employeesTable());
      if (err) throw new ApiError("validation", err);
      standInsTable().unshift({ id: uid("si"), ...input, standInEmpId: input.standInEmpId || null, createdBy: v.employee.empId, createdAt: new Date().toISOString() });
      logChange("stand_in", input.standInEmpId ? `${employeeName(input.standInEmpId)} stands in for ${employeeName(input.managerEmpId)}` : `${employeeName(input.managerEmpId)} is away with no stand-in`, input.reason || "Stand-in set");
    });
  },

  /** DELETE /stand-ins/:id { reason } (ends early, kept in history) */
  endStandIn: async (id: string, reason: string) => {
    if (live()) return http.delete(`/stand-ins/${id}`, { reason });
    return mock(() => {
      const s = standInsTable().find((x) => x.id === id);
      if (!s) notFound("Stand-in");
      const v = getViewer();
      if (!v.can("standin.manage")) throw new ApiError("forbidden", "View only. Managers end their own stand-ins.", 403);
      if (s.managerEmpId !== v.employee.empId && !(v.can("roles.manage") && descendantsOf(v.employee.empId).includes(s.managerEmpId)))
        throw new ApiError("forbidden", "Only the manager, or someone above them, can end this stand-in.", 403);
      s.endedAt = new Date().toISOString();
      s.endReason = reason;
      logChange("stand_in", `Stand-in ended early for ${employeeName(s.managerEmpId)}`, reason);
    });
  },

  /** GET /org/changes (from the audit log; the Owner, CEO and Director) */
  changes: async (): Promise<OrgChange[]> => {
    if (live()) {
      try {
        const rows = await http.get<OrgChangeView[]>("/org/changes");
        return rows.map((r) => ({ id: r.id, kind: r.kind, summary: r.summary, reason: r.reason, by: r.by ?? "", at: r.at }));
      } catch (err) {
        if (err instanceof ApiError && err.status === 403) return []; // not allowed to see the audit log: show nothing
        throw err;
      }
    }
    return mock(() => changesTable().slice(0, 12));
  },
};
