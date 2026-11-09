"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { Permission } from "@/lib/auth/permissions";
import { useSession } from "@/lib/auth/session";
import { accessApi } from "./api";
import type { DepartmentInput, MoveInput, OfficeInput, StandInInput } from "./types";

export const accessKeys = {
  all: ["access"] as const,
  tree: ["access", "tree"] as const,
  departments: ["access", "departments"] as const,
  roles: ["access", "roles"] as const,
  standIns: (empId: string | null) => ["access", "standins", empId] as const,
  changes: ["access", "changes"] as const,
};

export function useOrgTree() {
  return useQuery({ queryKey: accessKeys.tree, queryFn: accessApi.tree });
}

export function useDepartments() {
  return useQuery({ queryKey: accessKeys.departments, queryFn: accessApi.departments });
}

export function useRoles() {
  return useQuery({ queryKey: accessKeys.roles, queryFn: accessApi.roles });
}

export function useStandIns() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: accessKeys.standIns(empId), queryFn: accessApi.standIns, enabled: !!empId });
}

export function useOrgChanges() {
  return useQuery({ queryKey: accessKeys.changes, queryFn: accessApi.changes });
}

function useDone() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["access"] });
    qc.invalidateQueries({ queryKey: ["people"] });
  };
}

export function useMoveEmployee() {
  const done = useDone();
  return useMutation({ mutationFn: (input: MoveInput) => accessApi.move(input), onSuccess: done });
}

export function useCreateDepartment() {
  const done = useDone();
  return useMutation({ mutationFn: (input: DepartmentInput) => accessApi.createDepartment(input), onSuccess: done });
}

export function useAddOffice() {
  const done = useDone();
  return useMutation({ mutationFn: (input: OfficeInput) => accessApi.addOffice(input), onSuccess: done });
}

export function useUpdateRole() {
  const done = useDone();
  return useMutation({
    mutationFn: ({ roleId, permissions, reason, summary }: { roleId: string; permissions: Permission[]; reason: string; summary: string }) =>
      accessApi.updateRole(roleId, permissions, reason, summary),
    onSuccess: done,
  });
}

export function useCreateStandIn() {
  const done = useDone();
  return useMutation({ mutationFn: (input: StandInInput) => accessApi.createStandIn(input), onSuccess: done });
}

export function useEndStandIn() {
  const done = useDone();
  return useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => accessApi.endStandIn(id, reason), onSuccess: done });
}
