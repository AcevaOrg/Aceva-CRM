"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Hash, ListTodo, MessageSquare, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, NativeSelect, SegmentedControl } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { StatusBadge } from "@/components/shared/chips";
import { useTasks, useProjects } from "@/features/tasks/hooks";
import { STATUS_LABEL } from "@/features/tasks/logic";
import { useLookup } from "@/hooks/use-directory";
import { ApiError } from "@/lib/api/mock";
import { useViewer } from "@/lib/auth/viewer";
import { cn } from "@/lib/utils";
import { useCreateConversation, useDeleteMessage, useLinkTask } from "../hooks";
import { canCreateChannel } from "../logic";
import type { Message } from "../types";

export function DeleteMessageDialog({ message, onClose }: { message: Message; onClose: () => void }) {
  const del = useDeleteMessage();
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Delete this message?</DialogTitle>
          <DialogDescription>Others will see “Message deleted”. A record stays in the audit log, as company policy requires.</DialogDescription>
        </DialogHeader>
        <p className="line-clamp-3 rounded-lg bg-muted px-3 py-2 text-[13px]">{message.body || "File message"}</p>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Keep it
          </Button>
          <Button
            variant="destructive"
            loading={del.isPending}
            onClick={async () => {
              try {
                await del.mutateAsync(message.id);
                toast.success("Message deleted");
                onClose();
              } catch (e) {
                toast.error(e instanceof ApiError ? e.message : "Couldn't delete it.");
              }
            }}
          >
            Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function LinkTaskDialog({ message, onClose }: { message: Message; onClose: () => void }) {
  const tasks = useTasks({ scope: "all" });
  const link = useLinkTask();
  const [q, setQ] = React.useState("");
  const needle = q.trim().toLowerCase();
  const list = (tasks.data ?? []).filter((t) => !needle || `${t.number} ${t.title}`.toLowerCase().includes(needle)).slice(0, 30);
  const choose = async (taskId: string | null) => {
    try {
      await link.mutateAsync({ id: message.id, taskId });
      toast.success(taskId ? "Linked to the task" : "Link removed");
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't link it.");
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>Link to a task</DialogTitle>
          <DialogDescription>Only tasks you can see are listed. The link shows on the message and in the conversation details.</DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by number or title" className="pl-8" />
        </div>
        <ul className="max-h-80 overflow-y-auto rounded-lg border border-border scrollbar-thin">
          {tasks.isPending ? (
            <li className="p-4 text-[13px] text-muted-foreground">Loading tasks…</li>
          ) : list.length === 0 ? (
            <li className="p-4 text-[13px] text-muted-foreground">No tasks match.</li>
          ) : (
            list.map((t) => (
              <li key={t.id} className="border-b border-border last:border-0">
                <button onClick={() => choose(t.id)} className={cn("flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-muted", message.linkedTaskId === t.id && "bg-accent")}>
                  <ListTodo className="size-4 shrink-0 text-zone-work" />
                  <span className="font-mono text-[11.5px] text-muted-foreground">{t.number}</span>
                  <span className="min-w-0 flex-1 truncate text-[13px]">{t.title}</span>
                  <StatusBadge label={STATUS_LABEL[t.status]} tone="outline" />
                </button>
              </li>
            ))
          )}
        </ul>
        <DialogFooter>
          {message.linkedTaskId && (
            <Button variant="ghost" onClick={() => choose(null)}>
              Remove link
            </Button>
          )}
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** New DM / group or (for admins and leads) a new channel (spec §9.14). */
export function NewConversationDialog({ onClose }: { onClose: () => void }) {
  const viewer = useViewer();
  const lookup = useLookup();
  const projects = useProjects();
  const create = useCreateConversation();
  const router = useRouter();
  const allowChannel = viewer ? canCreateChannel(viewer.employee, viewer.can("comms.admin")) : false;
  const [mode, setMode] = React.useState<"people" | "channel">("people");
  const [selected, setSelected] = React.useState<string[]>([]);
  const [q, setQ] = React.useState("");
  const [name, setName] = React.useState("");
  const [topic, setTopic] = React.useState("");
  const [scope, setScope] = React.useState("");
  const [moderators, setModerators] = React.useState<string[]>([]);
  const me = viewer?.employee.empId;
  const people = lookup.employees.filter((e) => e.empId !== me && e.status !== "left" && (!q.trim() || `${e.name} ${e.empId} ${e.designation}`.toLowerCase().includes(q.trim().toLowerCase())));

  const toggle = (id: string) => setSelected((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));

  const applyScope = (value: string) => {
    setScope(value);
    if (value.startsWith("dep:")) {
      const dep = value.slice(4);
      setSelected(lookup.employees.filter((e) => e.departmentId === dep && e.empId !== me && e.status !== "left").map((e) => e.empId));
    }
  };

  const ok = mode === "people" ? selected.length > 0 : name.trim().length >= 2 && selected.length > 0;

  const submit = async () => {
    try {
      const id = await create.mutateAsync({
        kind: mode === "channel" ? "channel" : selected.length > 1 ? "group" : "dm",
        memberEmpIds: selected,
        name: mode === "channel" ? name : selected.length > 1 ? name || undefined : undefined,
        topic: topic || undefined,
        departmentId: scope.startsWith("dep:") ? scope.slice(4) : undefined,
        projectId: scope.startsWith("prj:") ? scope.slice(4) : undefined,
        moderatorEmpIds: moderators,
      });
      toast.success(mode === "channel" ? `#${name.trim().toLowerCase().replace(/\s+/g, "-")} created` : "Conversation ready");
      onClose();
      router.push(`/messages/${id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't create the conversation.");
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>New conversation</DialogTitle>
          <DialogDescription>Message one person, start a small group, or {allowChannel ? "create a channel." : "ask a lead to create a channel."}</DialogDescription>
        </DialogHeader>
        {allowChannel && (
          <SegmentedControl
            value={mode}
            onChange={(m) => {
              setMode(m);
              setSelected([]);
            }}
            ariaLabel="Conversation type"
            options={[
              { value: "people", label: <><MessageSquare /> Direct or group</> },
              { value: "channel", label: <><Hash /> Channel</> },
            ]}
          />
        )}
        {mode === "channel" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Channel name" htmlFor="ch-name" hint="Lowercase, no spaces: “design-review”.">
              <Input id="ch-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="design-review" />
            </Field>
            <Field label="Linked to" htmlFor="ch-scope" hint="Picking a department adds its members.">
              <NativeSelect id="ch-scope" value={scope} onChange={(e) => applyScope(e.target.value)}>
                <option value="">Nothing (open topic)</option>
                <optgroup label="Department">
                  {lookup.departments.map((d) => (
                    <option key={d.id} value={`dep:${d.id}`}>
                      {d.name}
                    </option>
                  ))}
                </optgroup>
                <optgroup label="Project">
                  {projects.data?.map((p) => (
                    <option key={p.id} value={`prj:${p.id}`}>
                      {p.name}
                    </option>
                  ))}
                </optgroup>
              </NativeSelect>
            </Field>
            <Field label="Topic (optional)" htmlFor="ch-topic" className="sm:col-span-2">
              <Input id="ch-topic" value={topic} onChange={(e) => setTopic(e.target.value)} placeholder="What is this channel for?" />
            </Field>
          </div>
        )}
        {mode === "people" && selected.length > 1 && (
          <Field label="Group name (optional)" htmlFor="grp-name">
            <Input id="grp-name" value={name} onChange={(e) => setName(e.target.value)} placeholder="Payslip layout review" />
          </Field>
        )}
        <div className="grid gap-2">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" className="pl-8" aria-label="Search people" />
          </div>
          <ul className="max-h-64 overflow-y-auto rounded-lg border border-border scrollbar-thin" aria-label="People">
            {people.map((e) => {
              const on = selected.includes(e.empId);
              return (
                <li key={e.empId} className="border-b border-border last:border-0">
                  <div className={cn("flex items-center gap-3 px-3 py-2 hover:bg-muted", on && "bg-accent/60")}>
                    <Checkbox checked={on} onCheckedChange={() => toggle(e.empId)} aria-label={`Add ${e.name}`} />
                    <button type="button" onClick={() => toggle(e.empId)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                      <Avatar name={e.name} hue={e.avatarHue} size={26} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[13px] font-medium">{e.name}</span>
                        <span className="block truncate text-[11.5px] text-muted-foreground">{e.designation}</span>
                      </span>
                    </button>
                    {mode === "channel" && on && (
                      <span className="flex items-center gap-1.5 text-[11.5px] text-muted-foreground">
                        <Checkbox
                          id={`mod-${e.empId}`}
                          checked={moderators.includes(e.empId)}
                          onCheckedChange={(c) => setModerators((m) => (c ? [...m, e.empId] : m.filter((x) => x !== e.empId)))}
                        />
                        <label htmlFor={`mod-${e.empId}`}>Moderator</label>
                      </span>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
          <p className="text-[12px] text-muted-foreground">
            {selected.length === 0 ? "Choose at least one person." : mode === "people" ? (selected.length === 1 ? "A direct message." : `A group of ${selected.length + 1}.`) : `${selected.length + 1} members including you (moderator).`}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={submit} disabled={!ok} loading={create.isPending}>
            {mode === "channel" ? "Create channel" : "Start conversation"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
