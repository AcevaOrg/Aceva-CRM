"use client";
import * as React from "react";
import { toast } from "sonner";
import {
  CalendarClock, CheckCircle2, Circle, CircleSlash, Hourglass, MessageSquare, Paperclip, Pause, Play, Send, Star, Upload,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { Avatar, Progress } from "@/components/ui/misc";
import { PageHeader } from "@/components/layout/page-header";
import { DeadlineChip, StatusBadge } from "@/components/shared/chips";
import { useReason } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { DetailList, StarRating } from "@/components/shared/pickers";
import { ErrorState, ListSkeleton } from "@/components/shared/states";
import { FileCard, Timeline } from "@/components/shared/timeline";
import { useLookup } from "@/hooks/use-directory";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate, formatDateTime, formatRelative } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useAddComment, useDecideExtension, useProjects, useTask, useToggleChecklist, useTransitionTask } from "../hooks";
import { allowedTransitions, isOpen, isSettled, sizeRule, STATUS_LABEL } from "../logic";
import type { TaskStatus } from "../types";
import { PriorityLabel, SizeChip, STATUS_COLOR, TaskStatusBadge } from "./task-bits";
import { DeadlineDialog, ExtensionDialog, ReviewDialog } from "./task-dialogs";

export function TaskDetail({ id }: { id: string }) {
  const q = useTask(id);
  const viewer = useViewer();
  const lookup = useLookup();
  const projects = useProjects();
  const transition = useTransitionTask();
  const toggle = useToggleChecklist();
  const decideExt = useDecideExtension();
  const askReason = useReason();
  const [review, setReview] = React.useState<null | "approve" | "rework">(null);
  const [extOpen, setExtOpen] = React.useState(false);
  const [dlOpen, setDlOpen] = React.useState(false);

  if (q.isPending) return <ListSkeleton rows={8} className="mt-6" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} className="mt-6" />;

  const { task, comments, extensions, history } = q.data;
  const me = viewer?.employee.empId ?? "";
  const isAssignee = task.assignee === me;
  const isAssigner = task.assignedBy === me;
  const allowed = allowedTransitions(task, { empId: me, isAssigner, isReviewer: isAssigner });
  const pendingExt = extensions.find((e) => e.status === "pending");
  const project = projects.data?.find((p) => p.id === task.projectId);
  const doneSteps = task.checklist.filter((c) => c.done).length;
  const open = isOpen(task.status);

  const move = async (to: TaskStatus, needsReason?: string) => {
    let reason: string | undefined;
    if (needsReason) {
      reason = (await askReason({ title: needsReason, destructive: to === "cancelled", confirmLabel: needsReason })) ?? undefined;
      if (!reason) return;
    }
    await transition.mutateAsync({ id: task.id, to, reason });
    toast.success(`Task is now ${STATUS_LABEL[to].toLowerCase()}`);
  };

  return (
    <>
      <PageHeader
        back={{ href: "/tasks", label: "Tasks" }}
        title={task.title}
        meta={
          <>
            <span className="font-mono text-[12px] text-muted-foreground">{task.number}</span>
            <TaskStatusBadge status={task.status} />
            {task.isOverdue && <StatusBadge label="Overdue" tone="danger" />}
            <SizeChip size={task.size} />
            <PriorityLabel priority={task.priority} />
            {task.personal && <Badge tone="outline">Personal to-do · not scored</Badge>}
          </>
        }
        seal="internal"
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_340px]">
        <div className="grid content-start gap-6">
          {task.status === "rework" && task.reviewComment && (
            <div className="rounded-xl border border-warning/40 bg-warning/10 p-4 text-[13px]">
              <p className="font-semibold">Sent back for rework</p>
              <p className="mt-0.5">“{task.reviewComment}”</p>
            </div>
          )}
          {task.status === "approved" && task.rating && (
            <div className="flex flex-wrap items-center gap-3 rounded-xl border border-success/35 bg-success/10 p-4 text-[13px]">
              <StarRating value={task.rating} size={18} />
              <span className="font-medium">Approved by {lookup.employee(task.assignedBy)?.name}</span>
              {task.reviewComment && <span className="text-muted-foreground">“{task.reviewComment}”</span>}
            </div>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Description</CardTitle>
            </CardHeader>
            <CardContent className="text-[13.5px] leading-relaxed">{task.description || <span className="text-muted-foreground">No description.</span>}</CardContent>
          </Card>

          {task.checklist.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Checklist</CardTitle>
                <span className="text-[12.5px] text-muted-foreground tabular">
                  {doneSteps} of {task.checklist.length}
                </span>
              </CardHeader>
              <CardContent className="grid gap-1">
                <Progress value={doneSteps} max={task.checklist.length} className="mb-2" barClassName="bg-zone-work" />
                {task.checklist.map((c) => (
                  <button
                    key={c.id}
                    disabled={!isAssignee || !open}
                    onClick={() => toggle.mutate({ id: task.id, itemId: c.id })}
                    className="flex items-center gap-2.5 rounded-md px-2 py-1.5 text-left text-[13.5px] transition enabled:hover:bg-muted disabled:cursor-default"
                  >
                    {c.done ? <CheckCircle2 className="size-4 text-success" /> : <Circle className="size-4 text-muted-foreground" />}
                    <span className={cn(c.done && "text-muted-foreground line-through")}>{c.text}</span>
                  </button>
                ))}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Attachments</CardTitle>
              <Button size="sm" variant="outline" onClick={() => toast("File upload goes to private storage once the backend is connected (demo).")}>
                <Upload /> Attach file
              </Button>
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2">
              {task.attachments.length ? task.attachments.map((a) => <FileCard key={a.id} file={a} />) : <p className="text-[13px] text-muted-foreground">No files yet.</p>}
            </CardContent>
          </Card>

          <Comments taskId={task.id} comments={comments} />
        </div>

        <aside className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Actions</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {allowed.includes("in_progress") && task.status === "assigned" && (
                <Button onClick={() => move("in_progress")} loading={transition.isPending}>
                  <Play /> Start work
                </Button>
              )}
              {allowed.includes("submitted") && (
                <Button onClick={() => move("submitted")} loading={transition.isPending}>
                  <Send /> Submit for review
                </Button>
              )}
              {allowed.includes("under_review") && (
                <Button variant="outline" onClick={() => move("under_review")}>
                  Start review
                </Button>
              )}
              {allowed.includes("approved") && (
                <Button onClick={() => setReview("approve")}>
                  <Star /> Approve with rating
                </Button>
              )}
              {allowed.includes("rework") && (
                <Button variant="outline" onClick={() => setReview("rework")}>
                  Send to rework
                </Button>
              )}
              {isAssignee && open && !["submitted", "under_review"].includes(task.status) && !task.personal && (
                <Button variant="outline" onClick={() => setExtOpen(true)} disabled={!!pendingExt}>
                  <Hourglass /> {pendingExt ? "Extension requested" : "Request more time"}
                </Button>
              )}
              {isAssigner && open && !task.personal && (
                <Button variant="ghost" onClick={() => setDlOpen(true)}>
                  <CalendarClock /> Change deadline
                </Button>
              )}
              {allowed.includes("in_progress") && task.status === "on_hold" && (
                <Button variant="outline" onClick={() => move("in_progress")}>
                  <Play /> Resume
                </Button>
              )}
              {allowed.includes("on_hold") && (
                <Button variant="ghost" onClick={() => move("on_hold", "Put on hold")}>
                  <Pause /> Put on hold
                </Button>
              )}
              {allowed.includes("cancelled") && (
                <Button variant="ghost" className="text-danger" onClick={() => move("cancelled", "Cancel task")}>
                  <CircleSlash /> Cancel task
                </Button>
              )}
              {!allowed.length && !(isAssignee && open) && (
                <p className="text-[12.5px] text-muted-foreground">
                  {task.status === "approved" ? "This task is finished." : task.status === "cancelled" ? "This task was cancelled." : "No actions for you on this task right now."}
                </p>
              )}
            </CardContent>
          </Card>

          {pendingExt && (
            <Card className="border-warning/40">
              <CardHeader>
                <CardTitle>Extension requested</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-3 text-[13px]">
                <p>
                  {formatDate(pendingExt.currentDeadline)} → <span className="font-semibold">{formatDate(pendingExt.requestedDeadline)}</span>
                </p>
                <p className="text-muted-foreground">“{pendingExt.reason}”</p>
                {pendingExt.late && <StatusBadge label="Asked after the deadline: counts as late" tone="warning" />}
                {isAssigner && (
                  <div className="flex gap-2">
                    <Button size="sm" onClick={() => decideExt.mutate({ extId: pendingExt.id, approve: true }, { onSuccess: () => toast.success("Extension approved. New deadline saved.") })}>
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        const reason = await askReason({ title: "Reject extension" });
                        if (reason) decideExt.mutate({ extId: pendingExt.id, approve: false, reason }, { onSuccess: () => toast("Extension rejected") });
                      }}
                    >
                      Reject
                    </Button>
                  </div>
                )}
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <DetailList
                items={[
                  ["Assigned to", <EmpChip key="a" empId={task.assignee} />],
                  ["Assigned by", <EmpChip key="b" empId={task.assignedBy} />],
                  ["Deadline", <span key="d" className="grid gap-1"><DeadlineChip deadline={task.deadline} done={isSettled(task.status)} />{task.originalDeadline !== task.deadline && <span className="text-[12px] text-muted-foreground">Original: {formatDateTime(task.originalDeadline)}</span>}</span>],
                  ["Start", formatDate(task.startDate)],
                  ["Size", `${task.size} · ${sizeRule(task.size).hoursLabel} · ${task.points} pts`],
                  ["Estimated hours", `${task.estimatedHours} h`],
                  ["Project", project?.name ?? "—"],
                  ["Repeats", task.repeat ? (task.repeat.every === "week" ? `Weekly on ${["", "Mon", "Tue", "Wed", "Thu", "Fri"][task.repeat.on]}` : `Monthly on day ${task.repeat.on}`) : "No"],
                  ["Extensions", String(task.extensionsCount)],
                ]}
              />
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
            </CardHeader>
            <CardContent>
              <Timeline
                items={[...history].reverse().map((h) => ({
                  id: h.id,
                  color: STATUS_COLOR[h.to],
                  title: h.from === h.to ? (h.reason ?? "Updated") : `${STATUS_LABEL[h.to]}`,
                  meta: `${lookup.employee(h.by)?.name ?? h.by}${h.reason && h.from !== h.to ? ` · “${h.reason}”` : ""}`,
                  time: formatRelative(h.at),
                }))}
              />
            </CardContent>
          </Card>
        </aside>
      </div>

      <ReviewDialog task={task} open={!!review} initial={review ?? "approve"} onOpenChange={(o) => !o && setReview(null)} />
      <ExtensionDialog task={task} open={extOpen} onOpenChange={setExtOpen} />
      <DeadlineDialog task={task} open={dlOpen} onOpenChange={setDlOpen} />
    </>
  );
}

function Comments({ taskId, comments }: { taskId: string; comments: { id: string; author: string; body: string; at: string }[] }) {
  const [body, setBody] = React.useState("");
  const add = useAddComment();
  const lookup = useLookup();
  const viewer = useViewer();
  const render = (text: string) =>
    text.split(/(@\w+)/g).map((part, i) =>
      part.startsWith("@") ? (
        <span key={i} className="rounded bg-primary/10 px-1 font-medium text-primary">
          {part}
        </span>
      ) : (
        part
      ),
    );
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <MessageSquare className="size-4 text-muted-foreground" /> Comments
        </CardTitle>
      </CardHeader>
      <CardContent className="grid gap-4">
        {comments.map((c) => {
          const e = lookup.employee(c.author);
          return (
            <div key={c.id} className="flex gap-3">
              <Avatar name={e?.name ?? c.author} hue={e?.avatarHue} size={30} />
              <div className="min-w-0 flex-1">
                <p className="text-[13px]">
                  <span className="font-semibold">{e?.name ?? c.author}</span> <span className="text-[11.5px] text-muted-foreground">{formatRelative(c.at)}</span>
                </p>
                <p className="mt-0.5 whitespace-pre-wrap text-[13.5px]">{render(c.body)}</p>
              </div>
            </div>
          );
        })}
        {!comments.length && <p className="text-[13px] text-muted-foreground">No comments yet. Ask a question or share progress.</p>}
        <form
          className="flex gap-3"
          onSubmit={async (e) => {
            e.preventDefault();
            if (!body.trim()) return;
            await add.mutateAsync({ id: taskId, body: body.trim() });
            setBody("");
          }}
        >
          {viewer && <Avatar name={viewer.employee.name} hue={viewer.employee.avatarHue} size={30} />}
          <div className="grid flex-1 gap-2">
            <Textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a comment. Use @Name to mention someone." />
            <div className="flex items-center justify-between">
              <button type="button" className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => toast("Attachments upload once storage is connected (demo).")}>
                <Paperclip className="size-3.5" /> Attach
              </button>
              <Button size="sm" type="submit" loading={add.isPending} disabled={!body.trim()}>
                Comment
              </Button>
            </div>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}
