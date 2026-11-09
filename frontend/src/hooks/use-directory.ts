"use client";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { directoryApi } from "@/lib/directory";
import type { Employee } from "@/types";

export const directoryKey = ["people", "directory"] as const;

export function useDirectory() {
  return useQuery({ queryKey: directoryKey, queryFn: directoryApi.get, staleTime: 5 * 60_000 });
}

/** Map of Emp-ID → Employee, plus department/office lookups. */
export function useLookup() {
  const { data } = useDirectory();
  return useMemo(() => {
    const byId = new Map<string, Employee>((data?.employees ?? []).map((e) => [e.empId, e]));
    const dept = new Map((data?.departments ?? []).map((d) => [d.id, d]));
    const office = new Map((data?.offices ?? []).map((o) => [o.id, o]));
    return {
      employee: (empId?: string | null) => (empId ? byId.get(empId) : undefined),
      department: (id?: string) => (id ? dept.get(id) : undefined),
      office: (id?: string) => (id ? office.get(id) : undefined),
      employees: data?.employees ?? [],
      departments: data?.departments ?? [],
      offices: data?.offices ?? [],
    };
  }, [data]);
}

export function useEmployee(empId?: string | null) {
  return useLookup().employee(empId);
}
