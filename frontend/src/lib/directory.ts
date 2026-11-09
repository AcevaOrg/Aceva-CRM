/**
 * Company directory: the list of people every module refers to by Emp-ID.
 * Mock: the "employees" table (Module 3 writes to it on onboarding/offboarding).
 * Live: GET /employees?fields=directory
 */
import type { Department, Employee, Office } from "@/types";
import { mock } from "@/lib/api/mock";
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
  /** GET /directory */
  get: () => mock<Directory>(() => ({ employees: employeesTable(), departments: departmentsTable(), offices: officesTable() }), { delay: 80 }),
};

/** Synchronous lookup for mock api.ts code. */
export function findEmployee(empId: string | null | undefined) {
  return empId ? employeesTable().find((e) => e.empId === empId) : undefined;
}

export function employeeName(empId: string | null | undefined) {
  return findEmployee(empId)?.name ?? empId ?? "Unknown";
}
