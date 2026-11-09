"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { differenceInCalendarDays, isSameDay } from "date-fns";
import { toast } from "sonner";
import { CheckCircle2, Circle, ListTodo, Paperclip, Plus, Repeat } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/controls";
import { Input } from "@/components/ui/input";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { DeadlineChip } from "@/components/shared/chips";
import { DataTable } from "@/components/shared/data-table";
import { EmpChip } from "@/components/shared/emp-chip";
import { KanbanBoard } from "@/components/shared/kanban-board";
import { WorkloadBar } from "@/components/shared/metrics";
import { MonthCalendar } from "@/components/shared/month-calendar";
import { useReason } from "@/components/shared/dialogs";
import { EmptyState, ListSkeleton, QueryState } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { useViewer } from "@/lib/auth/viewer";
import { formatTime, isoDay } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useCreateTask, useTasks, useTransitionTask, useWorkload } from "../hooks";
import { allowedTransitions, isOpen, isSettled, STATUS_LABEL } from "../logic";
import type { Task, TaskStatus } from "../types";
import { PriorityLabel, SizeChip, STATUS_COLOR, TaskStatusBadge } from "./task-bits";

/* ---------------- Row used by My tasks ---------------- */

function TaskRow({ task, showAssignee }: { task: Task; showAssignee?: boolean }) {
  const done = isSettled(task.status);
  const finished = !isOpen(task.status);
  return (
    <Link
      href={`/tasks/${task.id}`}
      className={cn(
        "group flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-border px-4 py-3 transition last:border-0 hover:bg-muted/50 sm:flex-nowrap",
        task.isOverdue && "shadow-[inset_3px_0_0_var(--danger)]",
      )}
    >
      <span className="hidden w-[86px] shrink-0 font-mono text-[11.5px] text-muted-foreground sm:block">{task.number}</span>
      <span className="min-w-0 flex-1 basis-full sm:basis-auto">
        <span className={cn("block truncate text-[13.5px] font-medium group-hover:underline", finished && "text-muted-foreground line-through")}>{task.title}</span>
        <span className="mt-0.5 flex items-center gap-2 text-[11.5px] text-muted-foreground">
          {task.repeat && (
            <span className="inline-flex items-center gap-1">
              <Repeat className="size-3" /> repeats
            </span>
          )}
          {task.attachments.length > 0 && <Paperclip className="size-3" />}
          {task.checklist.length > 0 && (
            <span className="tabular">
              {task.checklist.filter((c) => c.done).length}/{task.checklist.length} steps
            </span>
          )}
          {task.extensionsCount > 0 && <span>extended ×{task.extensionsCount}</span>}
        </span>
      </span>
      <SizeChip size={task.size} />
      <PriorityLabel priority={task.priority} compact />
      <TaskStatusBadge status={task.status} />
      {showAssignee && <EmpChip empId={task.assignee} size="sm" showId={false} link={false} className="w-36" />}
      <span className="ml-auto sm:ml-0 sm:w-36 sm:text-right">
        <DeadlineChip deadline={task.deadline} done={done} />
      </span>
    </Link>
  );
}

function Group({ title, tone, tasks, empty }: { title: string; tone?: string; tasks: Task[]; empty?: string }) {
  if (!tasks.length && !empty) return null;
  return (
    <section>
      <h3 className="mb-2 flex items-center gap-2 text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
        <span className="size-1.5 rounded-full" style={{ background: tone ?? "var(--muted-foreground)" }} />
        {title}
        <span className="rounded-full bg-muted px-1.5 text-[11px] tabular">{tasks.length}</span>
      </h3>
      <Card className="overflow-hidden">{tasks.length ? tasks.map((t) => <TaskRow key={t.id} task={t} />) : <p className="px-4 py-5 text-[13px] text-muted-foreground">{empty}</p>}</Card>
    </section>
  );
}

/* ---------------- My tasks ---------------- */

export function MyTasksView() {
  const q = useTasks({ scope: "mine", includePersonal: true });
  return (
    <QueryState query={q} skeleton={<ListSkeleton rows={6} />}>
      {(all) => {
        const work = all.filter((t) => !t.personal).sort((a, b) => a.deadline.localeCompare(b.deadline));
        const open = work.filter((t) => isOpen(t.status));
        const now = new Date();
        const overdue = open.filter((t) => t.isOverdue);
        const today = open.filter((t) => !t.isOverdue && isSameDay(new Date(t.deadline), now));
        const week = open.filter((t) => !t.isOverdue && !isSameDay(new Date(t.deadline), now) && differenceInCalendarDays(new Date(t.deadline), now) <= 7);
        const later = open.filter((t) => !overdue.includes(t) && !today.includes(t) && !week.includes(t));
        const done = work.filter((t) => !isOpen(t.status)).slice(0, 5);
        if (!work.length && !all.some((t) => t.personal))
          return <EmptyState icon={<ListTodo />} title="No tasks yet" description="When your manager assigns you work, it shows up here, sorted by deadline." />;
        return (
          <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_320px]">
            <div className="grid content-start gap-6">
              <Group title="Overdue" tone="var(--danger)" tasks={overdue} />
              <Group title="Due today" tone="var(--warning)" tasks={today} empty="Nothing due today." />
              <Group title="This week" tone="var(--info)" tasks={week} />
              <Group title="Later" tasks={later} />
              <Group title="Recently finished" tone="var(--success)" tasks={done} />
            </div>
            <PersonalTodos todos={all.filter((t) => t.personal)} />
          </div>
        );
      }}
    </QueryState>
  );
}

function PersonalTodos({ todos }: { todos: Task[] }) {
  const [text, setText] = React.useState("");
  const create = useCreateTask();
  const transition = useTransitionTask();
  const add = async () => {
    if (!text.trim()) return;
    const d = new Date();
    d.setHours(18, 0, 0, 0);
    if (d < new Date()) d.setDate(d.getDate() + 1);
    await create.mutateAsync({ title: text.trim(), description: "", assignee: "", priority: "low", size: "XS", estimatedHours: 1, startDate: new Date().toISOString(), deadline: d.toISOString(), checklist: [], personal: true });
    setText("");
  };
  return (
    <Card className="h-fit p-4">
      <h3 className="text-[13px] font-semibold">My to-dos</h3>
      <p className="text-[12px] text-muted-foreground">Personal reminders. Only you see them and they are not scored.</p>
      <form
        className="mt-3 flex gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          add();
        }}
      >
        <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="Add a to-do" aria-label="New to-do" />
        <Button type="submit" size="icon" variant="outline" loading={create.isPending} aria-label="Add to-do">
          <Plus />
        </Button>
      </form>
      <ul className="mt-3 grid gap-1">
        {todos.map((t) => {
          const done = t.status === "approved";
          return (
            <li key={t.id}>
              <button
                className="flex w-full items-center gap-2 rounded-md px-1.5 py-1.5 text-left text-[13px] hover:bg-muted"
                onClick={() => transition.mutate({ id: t.id, to: done ? "assigned" : "approved", rating: 5 })}
              >
                {done ? <CheckCircle2 className="size-4 text-success" /> : <Circle className="size-4 text-muted-foreground" />}
                <span className={cn("flex-1", done && "text-muted-foreground line-through")}>{t.title}</span>
                <span className="text-[11px] text-muted-foreground">{formatTime(t.deadline)}</span>
              </button>
            </li>
          );
        })}
        {!todos.length && <li className="py-2 text-[12.5px] text-muted-foreground">Nothing here.</li>}
      </ul>
    </Card>
  );
}

/* ---------------- List ---------------- */

export function TaskListView({ scope }: { scope: "mine" | "team" | "all" }) {
  const q = useTasks({ scope });
  const router = useRouter();
  const lookup = useLookup();
  const [status, setStatus] = React.useState<"open" | "all" | TaskStatus>("open");
  const [assignee, setAssignee] = React.useState("");
  const rows = (q.data ?? []).filter((t) => (status === "all" ? true : status === "open" ? isOpen(t.status) : t.status === status)).filter((t) => !assignee || t.assignee === assignee);
  const people = [...new Set((q.data ?? []).map((t) => t.assignee))];
  return (
    <DataTable
      rows={rows}
      loading={q.isPending}
      rowKey={(t) => t.id}
      onRowClick={(t) => router.push(`/tasks/${t.id}`)}
      rowClassName={(t) => (t.isOverdue ? "shadow-[inset_3px_0_0_var(--danger)]" : undefined)}
      searchable
      searchPlaceholder="Search tasks"
      searchText={(t) => `${t.number} ${t.title} ${lookup.employee(t.assignee)?.name ?? ""}`}
      initialSort={{ key: "deadline", dir: "asc" }}
      toolbar={
        <>
          <NativeSelect value={status} onChange={(e) => setStatus(e.target.value as typeof status)} className="w-40" aria-label="Status filter">
            <option value="open">Open</option>
            <option value="all">All statuses</option>
            {Object.entries(STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </NativeSelect>
          {scope !== "mine" && (
            <NativeSelect value={assignee} onChange={(e) => setAssignee(e.target.value)} className="w-48" aria-label="Assignee filter">
              <option value="">Everyone</option>
              {people.map((p) => (
                <option key={p} value={p}>
                  {lookup.employee(p)?.name ?? p}
                </option>
              ))}
            </NativeSelect>
          )}
        </>
      }
      columns={[
        { key: "number", header: "No.", cell: (t) => <span className="font-mono text-[12px] text-muted-foreground">{t.number}</span>, sortValue: (t) => t.number, hideOnMobile: true, width: "96px" },
        { key: "title", header: "Task", cell: (t) => <span className="font-medium">{t.title}</span>, sortValue: (t) => t.title },
        { key: "assignee", header: "Assignee", cell: (t) => <EmpChip empId={t.assignee} size="sm" showId={false} link={false} />, sortValue: (t) => lookup.employee(t.assignee)?.name ?? "" },
        { key: "size", header: "Size", cell: (t) => <SizeChip size={t.size} />, sortValue: (t) => t.points },
        { key: "priority", header: "Priority", cell: (t) => <PriorityLabel priority={t.priority} />, sortValue: (t) => ["low", "medium", "high", "urgent"].indexOf(t.priority), hideOnMobile: true },
        { key: "status", header: "Status", cell: (t) => <TaskStatusBadge status={t.status} />, sortValue: (t) => t.status },
        { key: "deadline", header: "Deadline", cell: (t) => <DeadlineChip deadline={t.deadline} done={isSettled(t.status)} />, sortValue: (t) => t.deadline },
      ]}
    />
  );
}

/* ---------------- Board ---------------- */

const BOARD_COLUMNS: TaskStatus[] = ["assigned", "in_progress", "submitted", "under_review", "rework", "approved", "on_hold"];

export function TaskBoardView({ scope }: { scope: "mine" | "team" | "all" }) {
  const q = useTasks({ scope });
  const viewer = useViewer();
  const transition = useTransitionTask();
  const askReason = useReason();
  if (q.isPending) return <ListSkeleton />;
  const me = viewer?.employee.empId ?? "";
  const actor = (t: Task) => ({ empId: me, isAssigner: t.assignedBy === me, isReviewer: t.assignedBy === me });
  return (
    <>
      <p className="mb-3 text-[12.5px] text-muted-foreground">Drag a card to move it. Only moves your role allows are accepted; approvals need a rating, so they open the task.</p>
      <KanbanBoard
        columns={BOARD_COLUMNS.map((s) => ({ id: s, title: STATUS_LABEL[s], color: STATUS_COLOR[s] }))}
        items={(q.data ?? []).filter((t) => t.status !== "cancelled")}
        columnOf={(t) => t.status}
        itemKey={(t) => t.id}
        canDrop={(t, to) => allowedTransitions(t, actor(t)).includes(to as TaskStatus)}
        onMove={async (t, to) => {
          const target = to as TaskStatus;
          if (target === "approved") {
            toast("Open the task to approve it with a rating.");
            return;
          }
          let reason: string | undefined;
          if (target === "rework" || target === "on_hold") {
            reason = (await askReason({ title: target === "rework" ? "Send back for rework" : "Put on hold", confirmLabel: "Confirm" })) ?? undefined;
            if (!reason) return;
          }
          await transition.mutateAsync({ id: t.id, to: target, reason });
          toast.success(`Moved to ${STATUS_LABEL[target]}`);
        }}
        renderCard={(t) => (
          <Link href={`/tasks/${t.id}`} draggable={false} className={cn("block rounded-lg border border-border bg-card p-3 shadow-strata transition hover:border-input", t.isOverdue && "border-l-[3px] border-l-danger")}>
            <p className="font-mono text-[11px] text-muted-foreground">{t.number}</p>
            <p className="mt-0.5 line-clamp-2 text-[13px] font-medium">{t.title}</p>
            <div className="mt-2.5 flex items-center justify-between gap-2">
              <span className="flex items-center gap-1.5">
                <SizeChip size={t.size} />
                <PriorityLabel priority={t.priority} compact />
              </span>
              <DeadlineChip deadline={t.deadline} done={isSettled(t.status)} />
            </div>
            {scope !== "mine" && <EmpChip empId={t.assignee} size="sm" showId={false} link={false} className="mt-2.5" />}
          </Link>
        )}
      />
    </>
  );
}

/* ---------------- Calendar ---------------- */

export function TaskCalendarView({ scope }: { scope: "mine" | "team" | "all" }) {
  const q = useTasks({ scope });
  const [month, setMonth] = React.useState(new Date());
  const [day, setDay] = React.useState<string | null>(null);
  const byDay = React.useMemo(() => {
    const m = new Map<string, Task[]>();
    (q.data ?? []).forEach((t) => {
      const k = isoDay(t.deadline);
      m.set(k, [...(m.get(k) ?? []), t]);
    });
    return m;
  }, [q.data]);
  const dayTasks = day ? (byDay.get(day) ?? []) : [];
  return (
    <>
      <MonthCalendar
        month={month}
        onMonthChange={setMonth}
        onSelect={setDay}
        selected={day ?? undefined}
        renderDay={(_, iso) => (
          <div className="mt-1 grid gap-0.5">
            {(byDay.get(iso) ?? []).slice(0, 3).map((t) => (
              <span key={t.id} className={cn("truncate rounded px-1 py-0.5 text-[10.5px] font-medium", t.isOverdue ? "bg-danger/15" : isOpen(t.status) ? "bg-zone-work/14" : "bg-muted text-muted-foreground line-through")}>
                {t.title}
              </span>
            ))}
            {(byDay.get(iso)?.length ?? 0) > 3 && <span className="px-1 text-[10.5px] text-muted-foreground">+{byDay.get(iso)!.length - 3} more</span>}
          </div>
        )}
      />
      <Sheet open={!!day} onOpenChange={(o) => !o && setDay(null)}>
        <SheetContent size="md">
          <SheetHeader>
            <SheetTitle>Due {day}</SheetTitle>
            <SheetDescription>{dayTasks.length} task(s)</SheetDescription>
          </SheetHeader>
          <SheetBody className="p-0">
            {dayTasks.length ? dayTasks.map((t) => <TaskRow key={t.id} task={t} showAssignee={scope !== "mine"} />) : <p className="p-6 text-[13px] text-muted-foreground">Nothing due on this day.</p>}
          </SheetBody>
        </SheetContent>
      </Sheet>
    </>
  );
}

/* ---------------- Workload ---------------- */

export function WorkloadView() {
  const q = useWorkload();
  const tasks = useTasks({ scope: "team" });
  const [who, setWho] = React.useState<string | null>(null);
  const lookup = useLookup();
  return (
    <QueryState query={q} isEmpty={(d) => !d.length} empty={<EmptyState title="No team members below you" description="Workload shows open task hours for the people you manage." />}>
      {(rows) => (
        <>
          <Card className="divide-y divide-border">
            {[...rows]
              .sort((a, b) => b.openHours / b.capacity - a.openHours / a.capacity)
              .map((r) => (
                <button key={r.empId} onClick={() => setWho(r.empId)} className="grid w-full items-center gap-3 px-5 py-3.5 text-left transition hover:bg-muted/50 sm:grid-cols-[240px_1fr_90px]">
                  <EmpChip empId={r.empId} link={false} subtitle={lookup.employee(r.empId)?.designation} />
                  <WorkloadBar hours={r.openHours} capacity={r.capacity} />
                  <span className="text-[12.5px] text-muted-foreground tabular sm:text-right">{r.openTasks} open</span>
                </button>
              ))}
          </Card>
          <Sheet open={!!who} onOpenChange={(o) => !o && setWho(null)}>
            <SheetContent size="lg">
              <SheetHeader>
                <SheetTitle>{lookup.employee(who)?.name}&apos;s open tasks</SheetTitle>
                <SheetDescription>Estimated hours count toward the weekly capacity.</SheetDescription>
              </SheetHeader>
              <SheetBody className="p-0">
                {(tasks.data ?? [])
                  .filter((t) => t.assignee === who && isOpen(t.status))
                  .map((t) => (
                    <TaskRow key={t.id} task={t} />
                  ))}
              </SheetBody>
            </SheetContent>
          </Sheet>
        </>
      )}
    </QueryState>
  );
}
