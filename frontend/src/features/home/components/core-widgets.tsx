"use client";
/** Home widgets built on Tasks (M5) and the Approvals inbox. */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { AlarmClock, ClipboardCheck, Gauge, Inbox, ListTodo } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { DeadlineChip } from "@/components/shared/chips";
import { EmpChip } from "@/components/shared/emp-chip";
import { Money } from "@/components/shared/money";
import { WorkloadBar } from "@/components/shared/metrics";
import { useApprovals } from "@/features/approvals/hooks";
import { APPROVAL_TYPE_LABEL } from "@/features/approvals/types";
import { useTasks, useWorkload } from "@/features/tasks/hooks";
import { isOpen } from "@/features/tasks/logic";
import { formatRelative } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { Widget, WidgetEmpty, WidgetSkeleton } from "./widget";

export function MyTasksWidget({ limit = 5 }: { limit?: number }) {
  const q = useTasks({ scope: "mine" });
  const open = (q.data ?? []).filter((t) => isOpen(t.status) && t.status !== "submitted" && t.status !== "under_review").sort((a, b) => a.deadline.localeCompare(b.deadline));
  return (
    <Widget title="My tasks" icon={<ListTodo />} href="/tasks">
      {q.isPending ? (
        <WidgetSkeleton />
      ) : open.length ? (
        <ul className="-mx-2 grid">
          {open.slice(0, limit).map((t) => (
            <li key={t.id}>
              <Link href={`/tasks/${t.id}`} className={cn("flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-muted", t.isOverdue && "text-danger")}>
                <span className={cn("size-1.5 shrink-0 rounded-full", t.isOverdue ? "bg-danger" : t.status === "rework" ? "bg-warning" : "bg-zone-work")} />
                <span className="min-w-0 flex-1 truncate text-[13.5px] text-foreground">{t.title}</span>
                <Badge tone="work" className="font-mono">
                  {t.size}
                </Badge>
                <DeadlineChip deadline={t.deadline} />
              </Link>
            </li>
          ))}
          {open.length > limit && <li className="px-2 pt-1 text-[12px] text-muted-foreground">+{open.length - limit} more open</li>}
        </ul>
      ) : (
        <WidgetEmpty>No open tasks. Nice.</WidgetEmpty>
      )}
    </Widget>
  );
}

export function ApprovalsWidget({ limit = 5, title = "Waiting for you" }: { limit?: number; title?: string }) {
  const q = useApprovals();
  const items = q.data?.items ?? [];
  return (
    <Widget title={title} icon={<Inbox />} href="/approvals" linkLabel={items.length ? `All ${items.length}` : "Open inbox"}>
      {q.isPending ? (
        <WidgetSkeleton />
      ) : items.length ? (
        <ul className="-mx-2 grid">
          {items.slice(0, limit).map((i) => (
            <li key={i.id}>
              <Link href="/approvals" className="flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-muted">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">{i.title}</span>
                  <span className="block truncate text-[11.5px] text-muted-foreground">
                    {APPROVAL_TYPE_LABEL[i.type]} · waiting {formatRelative(i.createdAt).replace(" ago", "")}
                  </span>
                </span>
                {i.amount && <Money value={i.amount} compact className="text-[12.5px]" />}
                <EmpChip empId={i.requester} size="sm" showId={false} link={false} className="hidden w-32 sm:inline-flex" />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <WidgetEmpty>Nothing is waiting for your decision.</WidgetEmpty>
      )}
    </Widget>
  );
}

export function ReviewQueueWidget() {
  const q = useApprovals();
  const router = useRouter();
  const reviews = (q.data?.items ?? []).filter((i) => i.type === "task_review");
  return (
    <Widget title="Work waiting for my review" icon={<ClipboardCheck />} href="/approvals?type=task_review">
      {q.isPending ? (
        <WidgetSkeleton />
      ) : reviews.length ? (
        <ul className="-mx-2 grid">
          {reviews.slice(0, 5).map((i) => (
            <li key={i.id}>
              <button onClick={() => router.push(i.href)} className="flex w-full items-center gap-3 rounded-lg px-2 py-2 text-left transition hover:bg-muted">
                <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium">{i.title}</span>
                <EmpChip empId={i.requester} size="sm" showId={false} link={false} className="w-32" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <WidgetEmpty>No submitted work to review.</WidgetEmpty>
      )}
    </Widget>
  );
}

export function TeamWorkloadWidget() {
  const q = useWorkload();
  const rows = [...(q.data ?? [])].sort((a, b) => b.openHours / b.capacity - a.openHours / a.capacity);
  return (
    <Widget title="Team workload" icon={<Gauge />} href="/tasks?view=workload">
      {q.isPending ? (
        <WidgetSkeleton rows={4} />
      ) : rows.length ? (
        <ul className="grid gap-3">
          {rows.slice(0, 6).map((r) => (
            <li key={r.empId} className="grid items-center gap-2 sm:grid-cols-[150px_1fr]">
              <EmpChip empId={r.empId} size="sm" showId={false} />
              <WorkloadBar hours={r.openHours} capacity={r.capacity} compact />
            </li>
          ))}
        </ul>
      ) : (
        <WidgetEmpty>Nobody reports to you yet.</WidgetEmpty>
      )}
    </Widget>
  );
}

export function TeamOverdueWidget() {
  const q = useTasks({ scope: "team" });
  const overdue = (q.data ?? []).filter((t) => t.isOverdue).sort((a, b) => a.deadline.localeCompare(b.deadline));
  return (
    <Widget title="Overdue in my team" icon={<AlarmClock />} href="/tasks?view=list">
      {q.isPending ? (
        <WidgetSkeleton />
      ) : overdue.length ? (
        <ul className="-mx-2 grid">
          {overdue.slice(0, 5).map((t) => (
            <li key={t.id}>
              <Link href={`/tasks/${t.id}`} className="flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-muted">
                <span className="min-w-0 flex-1 truncate text-[13.5px]">{t.title}</span>
                <EmpChip empId={t.assignee} size="sm" showId={false} link={false} className="hidden w-28 sm:inline-flex" />
                <DeadlineChip deadline={t.deadline} />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <WidgetEmpty>No overdue tasks in your team.</WidgetEmpty>
      )}
    </Widget>
  );
}
