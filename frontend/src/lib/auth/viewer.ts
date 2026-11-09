"use client";
/**
 * Who is using the app right now, and what they may do (spec §8).
 * useViewer() / useCan() for components; getViewer() for mock api.ts code.
 */
import { useMemo } from "react";
import type { Employee } from "@/types";
import { EMPLOYEES } from "@/mocks/seed/people";
import { permissionsFor, type Permission } from "./permissions";
import { useSession } from "./session";

export interface Viewer {
  employee: Employee;
  permissions: Set<Permission>;
  can: (p: Permission | Permission[]) => boolean;
  isSales: boolean;
  hasFinanceDuty: boolean;
}

/** Build the viewer object for any person (mock mode; used for oversight lists). */
export function viewerFor(empId: string | null): Viewer | null {
  const employee = EMPLOYEES.find((e) => e.empId === empId);
  if (!employee) return null;
  const permissions = permissionsFor(employee.role, employee.duties);
  return {
    employee,
    permissions,
    can: (p) => (Array.isArray(p) ? p.some((x) => permissions.has(x)) : permissions.has(p)),
    isSales: employee.departmentId === "dep-sales",
    hasFinanceDuty: employee.duties.includes("finance"),
  };
}

/** Non-hook access for api.ts (mock mode only). */
export function getViewer(): Viewer {
  const v = viewerFor(useSession.getState().empId);
  if (!v) throw new Error("Not signed in");
  return v;
}

export function useViewer(): Viewer | null {
  const empId = useSession((s) => s.empId);
  return useMemo(() => viewerFor(empId), [empId]);
}

/** true if the viewer has the permission (or any of a list). */
export function useCan(p: Permission | Permission[]) {
  const viewer = useViewer();
  return viewer ? viewer.can(p) : false;
}

/** Mock rule for who needs 2FA: levels 1–3 and anyone with finance duty (plan §6). */
export function requires2fa(e: Employee) {
  return e.level <= 3 || e.duties.includes("finance");
}
