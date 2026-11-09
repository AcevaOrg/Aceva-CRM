/**
 * Data scope (plan §5): each person sees their own data and the data of everyone
 * below them in their reporting line, never above or beside.
 * The server applies the same rule as a filter on every query.
 */
import type { Employee } from "@/types";
import { employeesTable } from "@/lib/directory";

function childrenOf(empId: string, list: Employee[]) {
  return list.filter((e) => e.reportsTo === empId);
}

/** Every Emp-ID below this person, at any depth. */
export function descendantsOf(empId: string, list: Employee[] = employeesTable()): string[] {
  const out: string[] = [];
  const walk = (id: string) => {
    for (const c of childrenOf(id, list)) {
      out.push(c.empId);
      walk(c.empId);
    }
  };
  walk(empId);
  return out;
}

/** Self + everyone below. */
export function scopeOf(empId: string, list: Employee[] = employeesTable()): Set<string> {
  return new Set([empId, ...descendantsOf(empId, list)]);
}

export function isInScope(viewerEmpId: string, targetEmpId: string, list: Employee[] = employeesTable()) {
  return viewerEmpId === targetEmpId || descendantsOf(viewerEmpId, list).includes(targetEmpId);
}

/** The chain above a person: [manager, manager's manager, …]. */
export function chainAbove(empId: string, list: Employee[] = employeesTable()): Employee[] {
  const out: Employee[] = [];
  let cur = list.find((e) => e.empId === empId);
  while (cur?.reportsTo) {
    const boss = list.find((e) => e.empId === cur!.reportsTo);
    if (!boss) break;
    out.push(boss);
    cur = boss;
  }
  return out;
}

/** Direct reports only. */
export function directReports(empId: string, list: Employee[] = employeesTable()) {
  return childrenOf(empId, list);
}
