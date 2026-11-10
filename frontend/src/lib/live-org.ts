/**
 * Live Module 1 data (the real API), mapped to the shapes the screens already use.
 * Shared by the org screens and by the staff directory, so every screen sees the same real hierarchy.
 */
import type { OrgNode as ApiOrgNode } from "@aceva/contracts";
import { http } from "@/lib/api/http";
import type { Duty, Employee, Level, RoleKey } from "@/types";
import { roleFor } from "@/types";

export type LiveOrgNode = Pick<
  Employee,
  "empId" | "name" | "designation" | "level" | "departmentId" | "officeId" | "reportsTo" | "avatarHue" | "status" | "role" | "duties"
>;

/** The server's role key, as a screen role. Level 4 heads and Finance/Sales people are told apart by duty and department. */
export function roleFromApi(roleKey: string, level: number, departmentId: string, duties: string[]): RoleKey {
  switch (roleKey) {
    case "owner":
    case "ceo":
    case "director":
    case "cto":
    case "sales":
      return roleKey;
    case "employee":
      return "developer";
    default:
      if (duties.includes("finance")) return "finance";
      return level === 4 ? roleFor(4, departmentId) : level === 3 ? "cto" : "developer";
  }
}

/** A stable colour for an avatar, from the Emp-ID. */
const hueFor = (empId: string) => (Number(empId.replace(/\D/g, "")) * 47) % 360;

function flatten(nodes: ApiOrgNode[], out: LiveOrgNode[] = []): LiveOrgNode[] {
  for (const n of nodes) {
    const duties = n.duties as Duty[];
    out.push({
      empId: n.empId,
      name: n.name,
      designation: n.designation,
      level: n.level as Level,
      departmentId: n.departmentId,
      officeId: n.officeId,
      reportsTo: n.reportsTo,
      avatarHue: hueFor(n.empId),
      status: n.status,
      role: roleFromApi(n.roleKey, n.level, n.departmentId, duties),
      duties,
    });
    flatten(n.children, out);
  }
  return out;
}

/** GET /org/tree, flattened. */
export async function fetchLiveOrgNodes(): Promise<LiveOrgNode[]> {
  return flatten(await http.get<ApiOrgNode[]>("/org/tree"));
}
