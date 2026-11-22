"use client";
import * as React from "react";
import { toast } from "sonner";
import {
  CalendarClock, CheckCircle2, Circle, CircleSlash, Hourglass, MessageSquare, Paperclip, Pause, Play, Repeat, RotateCcw, Send, Star, Upload, X,
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
import { ApiError } from "@/lib/api/mock";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate, formatDateTime, formatRelative } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { Attachment } from "@/types";
import {
  useAddComment, useAttachFile, useDecideExtension, useDownloadAttachment, useProjects, useSizeRules, useStopRepeat, useTask, useToggleChecklist, useTransitionTask,
} from "../hooks";
import { allowedTransitions, approvedBy, fileProblem, historyMeta, historyTitle, isOpen, isSettled, repeatLabel, sizeRule, STATUS_LABEL, TASK_FILE_ACCEPT } from "../logic";
import type { TaskComment, TaskStatus } from "../types";
import { PriorityLabel, SizeChip, STATUS_COLOR, TaskStatusBadge } from "./task-bits";
import { DeadlineDialog, ExtensionDialog, ReviewDialog } from "./task-dialogs";

const errorText = (e: unknown, fallback: string) => (e instanceof ApiError ? e.message : fallback);

export function TaskDetail({ id }: { id: string }) {
  const q = useTask(id);
  const viewer = useViewer();
  const lookup = useLookup();
  const projects = useProjects();
  const rules = useSizeRules();
  const transition = useTransitionTask();
  const toggle = useToggleChecklist();
  const decideExt = useDecideExtension();
  const attach = useAttachFile();
  const download = useDownloadAttachment();
  const stopRepeat = useStopRepeat();
  const askReason = useReason();
  const fileInput = React.useRef<HTMLInputElement>(null);
  const [review, setReview] = React.useState<null | "approve" | "rework">(null);
  const [extOpen, setExtOpen] = React.useState(false);
  const [dlOpen, setDlOpen] = React.useState(false);

  if (q.isPending) return <ListSkeleton rows={8} className="mt-6" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} className="mt-6" />;

  const { task, comments, extensions, history, reviewer, actingAssigner } = q.data;
  const me = viewer?.employee.empId ?? "";
  const isAssignee = task.assignee === me;
  // The server says who holds the assigner's powers now: the assigner while he is here and may assign, otherwise the first person up the line who may.
  const isAssigner = actingAssigner === me;
  // The server says who reviews this task now (the assigner, their stand-in, or the next level up); never the assignee.
  const isReviewer = !task.personal && reviewer === me;
  const allowed = allowedTransitions(task, { empId: me, isAssigner, isReviewer });
  const pendingExt = extensions.find((e) => e.status === "pending");
  const project = projects.data?.find((p) => p.id === task.projectId);
  const doneSteps = task.checklist.filter((c) => c.done).length;
  const open = isOpen(task.status);
  const canAssign = !!viewer?.can("task.assign");
  // A request can be made or answered only while the task is still being worked on (not handed in, under review or closed); the server answers 409 otherwise.
  const extensionOpen = open && !["submitted", "under_review"].includes(task.status);
  // The server lets only the current reviewer (the assigner, or the stand-in while the assigner is away) answer an extension request.
  const canDecideExt = isReviewer && canAssign && extensionOpen;
  // Files go on a task from the person doing it or the person who assigned it, while it is open; nobody else (the Director above a CTO's task, the Owner).
  const canAttach = open && (isAssignee || (isAssigner && !task.personal && canAssign));
  const repeating = !!task.repeat && task.repeat.active !== false;
  // The CEO / Founder / Owner only watches work tasks: the server refuses his comments and files, so the controls are not shown.
  const watchOnly = viewer?.employee.role === "owner" && !task.personal;

  const move = async (to: TaskStatus, opts: { needsReason?: string; rating?: number } = {}) => {
    let reason: string | undefined;
    if (opts.needsReason) {
      reason = (await askReason({ title: opts.needsReason, destructive: to === "cancelled", confirmLabel: opts.needsReason })) ?? undefined;
      if (!reason) return;
    }
    try {
      await transition.mutateAsync({ id: task.id, to, reason, rating: opts.rating, from: task.status, personal: task.personal });
    } catch (e) {
      toast.error(errorText(e, "Couldn't change the status."));
      return;
    }
    toast.success(task.personal && to === "approved" ? "To-do marked as done" : `Task is now ${STATUS_LABEL[to].toLowerCase()}`);
  };

  const onFile = async (file: File | undefined) => {
    if (!file) return;
    const problem = fileProblem(file);
    if (problem) return toast.error(problem);
    try {
      await attach.mutateAsync({ id: task.id, file });
    } catch (e) {
      toast.error(errorText(e, "Couldn't attach the file."));
      return;
    }
    toast.success("File attached", { description: file.name });
  };

  const openFile = async (file: Attachment) => {
    try {
      const saved = await download.mutateAsync({ taskId: task.id, file });
      if (!saved) toast("This is demo data, so there is no file to download.");
    } catch (e) {
      toast.error(errorText(e, "Couldn't download the file."));
    }
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
            <SizeChip size={task.size} points={task.points} />
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
              <span className="font-medium">Approved by {lookup.employee(approvedBy(history) ?? task.assignedBy)?.name}</span>
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
                    onClick={() => toggle.mutate({ id: task.id, itemId: c.id }, { onError: (e) => toast.error(errorText(e, "Couldn't update the step.")) })}
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
              <input ref={fileInput} type="file" hidden accept={TASK_FILE_ACCEPT} onChange={(e) => { void onFile(e.target.files?.[0]); e.target.value = ""; }} />
              {canAttach && (
                <Button size="sm" variant="outline" loading={attach.isPending} onClick={() => fileInput.current?.click()}>
                  <Upload /> Attach file
                </Button>
              )}
            </CardHeader>
            <CardContent className="grid gap-2 sm:grid-cols-2">
              {task.attachments.length ? task.attachments.map((a) => <FileCard key={a.id} file={a} onOpen={() => void openFile(a)} />) : <p className="text-[13px] text-muted-foreground">No files yet.</p>}
            </CardContent>
          </Card>

          <Comments taskId={task.id} comments={comments} onOpenFile={openFile} canWrite={!watchOnly} />
        </div>

        <aside className="grid content-start gap-4">
          <Card>
            <CardHeader>
              <CardTitle>Actions</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2">
              {allowed.includes("in_progress") && (task.status === "assigned" || task.status === "rework") && (
                <Button onClick={() => move("in_progress")} loading={transition.isPending}>
                  <Play /> {task.status === "rework" ? "Start rework" : "Start work"}
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
              {allowed.includes("approved") && !task.personal && (
                <Button onClick={() => setReview("approve")}>
                  <Star /> Approve with rating
                </Button>
              )}
              {allowed.includes("approved") && task.personal && (
                <Button onClick={() => move("approved", { rating: 5 })} loading={transition.isPending}>
                  <CheckCircle2 /> Mark as done
                </Button>
              )}
              {allowed.includes("rework") && (
                <Button variant="outline" onClick={() => setReview("rework")}>
                  Send to rework
                </Button>
              )}
              {task.personal && allowed.includes("assigned") && (
                <Button variant="outline" onClick={() => move("assigned")} loading={transition.isPending}>
                  <RotateCcw /> Reopen
                </Button>
              )}
              {isAssignee && extensionOpen && !task.personal && (
                <Button variant="outline" onClick={() => setExtOpen(true)} disabled={!!pendingExt}>
                  <Hourglass /> {pendingExt ? "Extension requested" : "Request more time"}
                </Button>
              )}
              {isAssigner && !isAssignee && open && !task.personal && (
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
                <Button variant="ghost" onClick={() => move("on_hold", { needsReason: "Put on hold" })}>
                  <Pause /> Put on hold
                </Button>
              )}
              {isAssigner && !isAssignee && repeating && (
                <Button
                  variant="ghost"
                  loading={stopRepeat.isPending}
                  onClick={async () => {
                    const reason = await askReason({ title: "Stop repeating", description: "Tasks already made stay. No new ones are created after this.", confirmLabel: "Stop repeating" });
                    if (!reason) return;
                    stopRepeat.mutate({ id: task.id, reason }, { onSuccess: () => toast("This task will not repeat any more"), onError: (e) => toast.error(errorText(e, "Couldn't stop the repeat.")) });
                  }}
                >
                  <Repeat /> Stop repeating
                </Button>
              )}
              {allowed.includes("cancelled") && (
                <Button variant="ghost" className="text-danger" onClick={() => move("cancelled", { needsReason: task.personal ? "Cancel to-do" : "Cancel task" })}>
                  <CircleSlash /> {task.personal ? "Cancel to-do" : "Cancel task"}
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
                {canDecideExt && (
                  <div className="flex gap-2">
                    <Button
                      size="sm"
                      loading={decideExt.isPending}
                      onClick={() =>
                        decideExt.mutate(
                          { extId: pendingExt.id, approve: true },
                          { onSuccess: () => toast.success("Extension approved. New deadline saved."), onError: (e) => toast.error(errorText(e, "Couldn't approve the extension.")) },
                        )
                      }
                    >
                      Approve
                    </Button>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={async () => {
                        const reason = await askReason({ title: "Reject extension" });
                        if (reason)
                          decideExt.mutate(
                            { extId: pendingExt.id, approve: false, reason },
                            { onSuccess: () => toast("Extension rejected"), onError: (e) => toast.error(errorText(e, "Couldn't reject the extension.")) },
                          );
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
                  ...(reviewer && reviewer !== task.assignedBy ? [["Reviewer", <EmpChip key="r" empId={reviewer} />] as [string, React.ReactNode]] : []),
                  ["Deadline", <span key="d" className="grid gap-1"><DeadlineChip deadline={task.deadline} done={isSettled(task.status)} />{task.originalDeadline !== task.deadline && <span className="text-[12px] text-muted-foreground">Original: {formatDateTime(task.originalDeadline)}</span>}</span>],
                  ["Start", formatDate(task.startDate)],
                  ["Size", `${task.size} · ${sizeRule(task.size, rules).hoursLabel} · ${task.points} pts`],
                  ["Estimated hours", `${task.estimatedHours} h`],
                  ["Project", project?.name ?? "—"],
                  ["Repeats", task.repeat ? repeatLabel(task.repeat, formatDate) : "No"],
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
                  title: historyTitle(h),
                  meta: historyMeta(h, h.by === "system" ? "System" : (lookup.employee(h.by)?.name ?? h.by), { when: formatDateTime, name: (e) => lookup.employee(e)?.name ?? e }),
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

/** Highlights @Firstname and @ACV-0007 mentions. */
const MENTION = /(@(?:ACV-\d{4}|\w+))/g;

function Comments({ taskId, comments, onOpenFile, canWrite = true }: { taskId: string; comments: TaskComment[]; onOpenFile: (file: Attachment) => void; canWrite?: boolean }) {
  const [body, setBody] = React.useState("");
  const [file, setFile] = React.useState<File | null>(null);
  const fileInput = React.useRef<HTMLInputElement>(null);
  const add = useAddComment();
  const lookup = useLookup();
  const viewer = useViewer();
  const render = (text: string) =>
    text.split(MENTION).map((part, i) =>
      part.startsWith("@") ? (
        <span key={i} className="rounded bg-primary/10 px-1 font-medium text-primary">
          {part}
        </span>
      ) : (
        part
      ),
    );
  const pick = (f: File | undefined) => {
    if (!f) return;
    const problem = fileProblem(f);
    if (problem) return toast.error(problem);
    setFile(f);
  };
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
                {c.attachments.length > 0 && (
                  <div className="mt-2 grid gap-2 sm:grid-cols-2">
                    {c.attachments.map((a) => (
                      <FileCard key={a.id} file={a} onOpen={() => onOpenFile(a)} />
                    ))}
                  </div>
                )}
              </div>
            </div>
          );
        })}
        {!comments.length && <p className="text-[13px] text-muted-foreground">No comments yet. Ask a question or share progress.</p>}
        {canWrite && (
          <form
            className="flex gap-3"
            onSubmit={async (e) => {
              e.preventDefault();
              if (!body.trim()) return;
              try {
                await add.mutateAsync({ id: taskId, body: body.trim(), file: file ?? undefined });
              } catch (err) {
                toast.error(errorText(err, "Couldn't post the comment."));
                return;
              }
              setBody("");
              setFile(null);
            }}
          >
            {viewer && <Avatar name={viewer.employee.name} hue={viewer.employee.avatarHue} size={30} />}
            <div className="grid flex-1 gap-2">
              <Textarea rows={2} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Write a comment. Use @Firstname or @ACV-0007 to mention someone." />
              <div className="flex items-center justify-between gap-2">
                <input ref={fileInput} type="file" hidden accept={TASK_FILE_ACCEPT} onChange={(e) => { pick(e.target.files?.[0]); e.target.value = ""; }} />
                {file ? (
                  <span className="inline-flex min-w-0 items-center gap-1.5 text-[12px] text-muted-foreground">
                    <Paperclip className="size-3.5 shrink-0" />
                    <span className="truncate">{file.name}</span>
                    <button type="button" aria-label="Remove the file" className="rounded p-0.5 hover:text-foreground" onClick={() => setFile(null)}>
                      <X className="size-3.5" />
                    </button>
                  </span>
                ) : (
                  <button type="button" className="inline-flex items-center gap-1 text-[12px] text-muted-foreground hover:text-foreground" onClick={() => fileInput.current?.click()}>
                    <Paperclip className="size-3.5" /> Attach
                  </button>
                )}
                <Button size="sm" type="submit" loading={add.isPending} disabled={!body.trim()}>
                  Comment
                </Button>
              </div>
            </div>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
