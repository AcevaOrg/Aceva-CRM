"use client";
/** KPI row for leads, directors and executives: headcount, present today, open and overdue tasks. */
import { useRouter } from "next/navigation";
import { AlarmClock, ListTodo, UserCheck, Users } from "lucide-react";
import { StatCard } from "@/components/shared/metrics";
import { useTeamToday } from "@/features/attendance/hooks";
import { useTasks } from "@/features/tasks/hooks";
import { isOpen } from "@/features/tasks/logic";
import { useLookup } from "@/hooks/use-directory";
import { descendantsOf } from "@/lib/auth/scope";
import { useViewer } from "@/lib/auth/viewer";

export function TeamKpiRow({ scopeLabel = "team" }: { scopeLabel?: string }) {
  const viewer = useViewer();
  const router = useRouter();
  const lookup = useLookup();
  const today = useTeamToday();
  const tasks = useTasks({ scope: "team" });
  if (!viewer) return null;
  const below = descendantsOf(viewer.employee.empId, lookup.employees).filter((id) => lookup.employee(id)?.status !== "left");
  const rows = today.data ?? [];
  const present = rows.filter((r) => r.state === "in" || r.state === "late" || r.state === "checked_out").length;
  const late = rows.filter((r) => r.state === "late").length;
  const onLeave = rows.filter((r) => r.state === "leave").length;
  const open = (tasks.data ?? []).filter((t) => isOpen(t.status));
  const overdue = open.filter((t) => t.isOverdue).length;
  return (
    <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
      <StatCard label={`People in my ${scopeLabel}`} value={below.length} icon={<Users />} accent="var(--zone-work)" onClick={() => router.push("/people")} />
      <StatCard
        label="Present today"
        value={today.isPending ? "…" : `${present} / ${rows.length || below.length}`}
        hint={`${late} late · ${onLeave} on leave`}
        icon={<UserCheck />}
        accent="var(--signal)"
        onClick={() => router.push("/attendance?tab=team")}
      />
      <StatCard label="Open tasks" value={tasks.isPending ? "…" : open.length} icon={<ListTodo />} accent="var(--info)" onClick={() => router.push("/tasks?view=list")} />
      <StatCard
        label="Overdue tasks"
        value={tasks.isPending ? "…" : overdue}
        hint={overdue ? "Needs attention" : "All on track"}
        icon={<AlarmClock />}
        accent={overdue ? "var(--danger)" : "var(--success)"}
        onClick={() => router.push("/tasks?view=list")}
      />
    </div>
  );
}
