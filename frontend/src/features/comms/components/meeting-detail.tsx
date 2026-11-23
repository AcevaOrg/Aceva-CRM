"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Ban, CalendarClock, CalendarPlus, Clock, ListTodo, MapPin, Paperclip, Save, User, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { Tip } from "@/components/ui/overlays";
import { PageHeader } from "@/components/layout/page-header";
import { NotFoundBlock, RequireAccess } from "@/components/shared/can";
import { StatusBadge } from "@/components/shared/chips";
import { useReason } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { ErrorState } from "@/components/shared/states";
import { NativeSelect } from "@/components/ui/controls";
import { useTasks } from "@/features/tasks/hooks";
import { isLive } from "@/lib/api/http";
import { useQueryClient } from "@tanstack/react-query";
import { commsKeys } from "../hooks";
import { liveCommsApi } from "../live-api";
import { checkFile } from "../logic";
import { CommsFile } from "./comms-file";
import { STATUS_LABEL } from "@/features/tasks/logic";
import type { TaskStatus } from "@/features/tasks/types";
import { ApiError } from "@/lib/api/mock";
import { useViewer } from "@/lib/auth/viewer";
import { formatDateTime, formatRelative, formatWeekdayLong } from "@/lib/dates";
import { useCancelMeeting, useMeeting, useSaveMeetingNotes } from "../hooks";
import { isPast, RsvpBadge, RsvpControl, timeRange } from "./meeting-bits";

const LIVE = isLive("m14");

export function MeetingDetail({ id }: { id: string }) {
  return (
    <RequireAccess permission="comms.use">
      <MeetingBody id={id} />
    </RequireAccess>
  );
}

function MeetingBody({ id }: { id: string }) {
  const q = useMeeting(id);
  const viewer = useViewer();
  const saveNotes = useSaveMeetingNotes();
  const cancel = useCancelMeeting();
  const askReason = useReason();
  const [notes, setNotes] = React.useState<string | null>(null);
  const qc = useQueryClient();
  const tasks = useTasks({ scope: "all" });
  const fileRef = React.useRef<HTMLInputElement>(null);
  const [adding, setAdding] = React.useState(false);
  const refresh = () => qc.invalidateQueries({ queryKey: commsKeys.meeting(id) });
  const addFile = async (file: File | undefined) => {
    if (!file) return;
    const err = checkFile(file.name, file.size);
    if (err) return void toast.error(`Can't add ${file.name}`, { description: err });
    setAdding(true);
    try {
      const saved = await liveCommsApi.uploadMeetingFile(id, file);
      if (saved.scan === "blocked") toast.error(`${file.name} was blocked`, { description: "Malware was found in it. It was removed and cannot be shared." });
      else toast.success(saved.scan === "clean" ? "File added" : "File added: being checked for viruses");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't add the file.");
    } finally {
      setAdding(false);
      if (fileRef.current) fileRef.current.value = "";
      void refresh();
    }
  };
  const linkTask = async (taskId: string, on: boolean) => {
    try {
      await (on ? liveCommsApi.linkMeetingTask(id, taskId) : liveCommsApi.unlinkMeetingTask(id, taskId));
      void refresh();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't change the linked tasks.");
    }
  };

  if (q.isPending)
    return (
      <div className="grid gap-4 pt-6">
        <Skeleton className="h-16 w-1/2" />
        <Skeleton className="h-72 w-full rounded-xl" />
      </div>
    );
  if (q.isError) {
    if (q.error instanceof ApiError && q.error.status === 404) return <NotFoundBlock />;
    return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  }

  const { meeting: m, linkedTasks, hiddenLinkedTasks = 0 } = q.data;
  // Live: the organizer adds files and links tasks here (not when the meeting is cancelled).
  const manage = LIVE && !!m.canAddFiles;
  const me = viewer?.employee.empId;
  const organizer = m.organizer === me;
  const mine = m.participants.find((p) => p.empId === me);
  const past = isPast(m);
  const draft = notes ?? m.notes ?? "";
  const counts = {
    yes: m.participants.filter((p) => p.rsvp === "yes").length,
    maybe: m.participants.filter((p) => p.rsvp === "maybe").length,
    no: m.participants.filter((p) => p.rsvp === "no").length,
    pending: m.participants.filter((p) => p.rsvp === "pending").length,
  };

  const onCancel = async () => {
    const reason = await askReason({ title: `Cancel “${m.title}”`, description: "Everyone invited is notified. The meeting stays in the list as cancelled.", confirmLabel: "Cancel meeting", destructive: true });
    if (!reason) return;
    try {
      await cancel.mutateAsync({ id: m.id, reason });
      toast.success("Meeting cancelled", { description: "Invitees were notified." });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't cancel it.");
    }
  };

  return (
    <>
      <PageHeader
        title={<span className={m.cancelled ? "line-through decoration-2" : undefined}>{m.title}</span>}
        description={`${formatWeekdayLong(m.start)} · ${timeRange(m)}`}
        back={{ href: "/meetings", label: "Meetings" }}
        meta={
          <>
            {m.cancelled ? <Badge tone="neutral">Cancelled</Badge> : past ? <Badge tone="outline">Finished</Badge> : <Badge tone="info">Upcoming · {formatRelative(m.start)}</Badge>}
            {organizer && <Badge tone="primary">You organise</Badge>}
          </>
        }
        actions={
          <>
            <Tip content="Calendar integration can be added if the Director approves it.">
              <span tabIndex={0}>
                <Button variant="outline" disabled>
                  <CalendarPlus /> Add to calendar
                </Button>
              </span>
            </Tip>
            {organizer && !m.cancelled && !past && (
              <Button variant="ghost" onClick={onCancel} loading={cancel.isPending}>
                <Ban /> Cancel meeting
              </Button>
            )}
          </>
        }
      />

      {mine && !m.cancelled && !past && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3 shadow-strata">
          <p className="text-[13.5px] font-medium">Are you going?</p>
          <RsvpControl meetingId={m.id} value={mine.rsvp} />
        </div>
      )}

      <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.6fr)_minmax(280px,1fr)]">
        <div className="grid gap-5">
          <Card>
            <CardHeader>
              <CardTitle>Agenda</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{m.agenda}</p>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <div>
                <CardTitle>Notes</CardTitle>
                <CardDescription>
                  {organizer ? "Only you, the organiser, can edit the notes. Everyone invited can read them." : m.notesUpdatedAt ? `Updated ${formatRelative(m.notesUpdatedAt)} by the organiser.` : "The organiser adds notes during or after the meeting."}
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent className="grid gap-3">
              {organizer ? (
                <>
                  <Textarea rows={7} value={draft} onChange={(e) => setNotes(e.target.value)} placeholder="Decisions, owners and next steps" aria-label="Meeting notes" />
                  <div className="flex items-center justify-between gap-3">
                    <span className="text-[12px] text-muted-foreground">{m.notesUpdatedAt ? `Last saved ${formatDateTime(m.notesUpdatedAt)}` : "Not saved yet"}</span>
                    <Button
                      size="sm"
                      disabled={notes === null || notes === (m.notes ?? "")}
                      loading={saveNotes.isPending}
                      onClick={async () => {
                        await saveNotes.mutateAsync({ id: m.id, notes: draft });
                        setNotes(null);
                        toast.success("Notes saved");
                      }}
                    >
                      <Save /> Save notes
                    </Button>
                  </div>
                </>
              ) : m.notes ? (
                <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{m.notes}</p>
              ) : (
                <p className="text-[13px] text-muted-foreground">No notes yet.</p>
              )}
            </CardContent>
          </Card>

          {(LIVE || m.attachments.length > 0 || linkedTasks.length > 0) && (
            <div className="grid gap-5 md:grid-cols-2">
              <Card>
                <CardHeader>
                  <div className="flex items-center justify-between gap-2">
                    <CardTitle>Files</CardTitle>
                    {manage && (
                      <>
                        <input ref={fileRef} type="file" hidden aria-label="Choose a file for the meeting" onChange={(e) => void addFile(e.target.files?.[0])} />
                        <Button size="sm" variant="outline" onClick={() => fileRef.current?.click()} loading={adding}>
                          <Paperclip /> Add file
                        </Button>
                      </>
                    )}
                  </div>
                </CardHeader>
                <CardContent className="grid gap-2">
                  {m.attachments.length ? (
                    m.attachments.map((a) => <CommsFile key={a.id} file={a} />)
                  ) : (
                    <p className="text-[13px] text-muted-foreground">No files.</p>
                  )}
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Linked tasks</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-2">
                  {manage && (
                    <NativeSelect aria-label="Link a task" value="" onChange={(e) => e.target.value && void linkTask(e.target.value, true)}>
                      <option value="">Link a task…</option>
                      {tasks.data
                        ?.filter((t) => !t.personal && !linkedTasks.some((l) => l.id === t.id))
                        .map((t) => (
                          <option key={t.id} value={t.id}>
                            {t.number} · {t.title}
                          </option>
                        ))}
                    </NativeSelect>
                  )}
                  {linkedTasks.length ? (
                    linkedTasks.map((t) => (
                      <Link key={t.id} href={`/tasks/${t.id}`} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[13px] hover:bg-muted">
                        <ListTodo className="size-4 shrink-0 text-zone-work" />
                        <span className="font-mono text-[11.5px] text-muted-foreground">{t.number}</span>
                        <span className="min-w-0 flex-1 truncate">{t.title}</span>
                        <StatusBadge label={STATUS_LABEL[t.status as TaskStatus] ?? t.status} tone="outline" />
                        {manage && (
                          <button
                            type="button"
                            onClick={(e) => {
                              e.preventDefault();
                              void linkTask(t.id, false);
                            }}
                            className="rounded p-0.5 text-muted-foreground hover:bg-card hover:text-foreground"
                            aria-label={`Unlink ${t.number}`}
                          >
                            <X className="size-3.5" />
                          </button>
                        )}
                      </Link>
                    ))
                  ) : (
                    !hiddenLinkedTasks && <p className="text-[13px] text-muted-foreground">No linked tasks.</p>
                  )}
                  {hiddenLinkedTasks > 0 && (
                    <p className="text-[12.5px] text-muted-foreground">
                      {hiddenLinkedTasks === 1 ? "1 linked task" : `${hiddenLinkedTasks} linked tasks`} you can&apos;t open (Module 5 decides who sees a task).
                    </p>
                  )}
                </CardContent>
              </Card>
            </div>
          )}
        </div>

        <div className="grid gap-5">
          <Card>
            <CardHeader>
              <CardTitle>When and where</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-2.5 text-[13px]">
              <p className="flex items-center gap-2">
                <CalendarClock className="size-4 text-muted-foreground" /> {formatWeekdayLong(m.start)}
              </p>
              <p className="flex items-center gap-2">
                <Clock className="size-4 text-muted-foreground" /> {timeRange(m)} · {m.durationMin} min
              </p>
              <p className="flex items-center gap-2">
                <MapPin className="size-4 text-muted-foreground" /> {m.location}
              </p>
              <p className="flex items-center gap-2">
                <User className="size-4 text-muted-foreground" /> Organised by <EmpChip empId={m.organizer} size="sm" showId={false} />
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <div>
                <CardTitle>People · {m.participants.length + 1}</CardTitle>
                <CardDescription>
                  {counts.yes + 1} going · {counts.maybe} maybe · {counts.no} not going · {counts.pending} no reply
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <ul className="grid gap-2">
                <li className="flex items-center justify-between gap-2">
                  <EmpChip empId={m.organizer} size="sm" />
                  <Badge tone="primary">Organiser</Badge>
                </li>
                {m.participants.map((p) => (
                  <li key={p.empId} className="flex items-center justify-between gap-2">
                    <EmpChip empId={p.empId} size="sm" />
                    <RsvpBadge rsvp={p.rsvp} />
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}
