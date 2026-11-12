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

/**
 * The server's role key, as a screen role. The keys are the same, except that the server's Level 5 role "employee" is
 * "developer" here (shown as "Developer / SQA"). An unknown key falls back to the default role of the level.
 */
export function roleFromApi(roleKey: string, level: number, departmentId: string, duties: string[]): RoleKey {
  switch (roleKey) {
    case "owner":
    case "director":
    case "cto":
    case "sales":
    case "finance":
      return roleKey;
    case "employee":
      return "developer";
    default:
      if (level === 4 && duties.includes("finance")) return "finance";
      return level >= 1 && level <= 5 ? roleFor(level as Level, departmentId) : "developer";
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
