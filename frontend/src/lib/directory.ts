/**
 * Company directory: the list of people every module refers to by Emp-ID.
 * Mock: the "employees" table (Module 3 writes to it on onboarding/offboarding).
 * Live: GET /employees?fields=directory
 */
import type { Department, Employee, Office } from "@/types";
import { isLive } from "@/lib/api/http";
import { mock } from "@/lib/api/mock";
import { fetchLiveOrgNodes } from "@/lib/live-org";
import { table } from "@/mocks/db";
import { DEPARTMENTS, OFFICES, seedEmployees } from "@/mocks/seed/people";

export const employeesTable = () => table<Employee>("employees", seedEmployees);
export const departmentsTable = () => table<Department>("departments", () => structuredClone(DEPARTMENTS));
export const officesTable = () => table<Office>("offices", () => structuredClone(OFFICES));

export interface Directory {
  employees: Employee[];
  departments: Department[];
  offices: Office[];
}

export const directoryApi = {
  /**
   * GET /directory
   * Module 3 (profiles) is still mock, so names and profile data come from the mock roster. While Module 1 is live, the
   * hierarchy fields (level, role, reports to, duties, status, department, office) come from the real server, so every
   * screen shows the same reporting lines as the org chart.
   */
  get: async (): Promise<Directory> => {
    const base = await mock<Directory>(() => ({ employees: employeesTable(), departments: departmentsTable(), offices: officesTable() }), { delay: 80 });
    if (!isLive("m1")) return base;
    const live = new Map((await fetchLiveOrgNodes()).map((n) => [n.empId, n]));
    return {
      ...base,
      employees: base.employees.map((e) => {
        const n = live.get(e.empId);
        return n
          ? { ...e, level: n.level, role: n.role, reportsTo: n.reportsTo, duties: n.duties, status: n.status, departmentId: n.departmentId, officeId: n.officeId, designation: n.designation }
          : e;
      }),
    };
  },
};

/** Synchronous lookup for mock api.ts code. */
export function findEmployee(empId: string | null | undefined) {
  return empId ? employeesTable().find((e) => e.empId === empId) : undefined;
}

export function employeeName(empId: string | null | undefined) {
  return findEmployee(empId)?.name ?? empId ?? "Unknown";
}
