"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Archive, ListTodo, LogOut, Pencil, Pin, Shield, ShieldOff, ShieldPlus, UserMinus, UserPlus, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { useReason } from "@/components/shared/dialogs";
import { CommsFile } from "./comms-file";
import { ErrorState, ListSkeleton } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { ApiError } from "@/lib/api/mock";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { isLive } from "@/lib/api/http";
import { useArchiveConversation, useCommsPolicy, usePins, useRenameConversation, useSetModerator, useSetTopic, useThread } from "../hooks";
import { RETENTION_TEXT, retentionNotice } from "../logic";
import type { Conversation, Message } from "../types";
import { PresenceDot, usePresenceOf } from "./bits";
import { Composer } from "./composer";
import { AddMembersDialog, RemoveMemberDialog } from "./member-dialogs";
import { MessageBody, MessageItem, type MessageActions } from "./message-item";

function PanelHeader({ title, subtitle, onClose }: { title: string; subtitle?: string; onClose: () => void }) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-border px-4 py-3">
      <div className="min-w-0">
        <p className="truncate text-[14px] font-semibold">{title}</p>
        {subtitle && <p className="truncate text-[12px] text-muted-foreground">{subtitle}</p>}
      </div>
      <Button size="icon-sm" variant="ghost" onClick={onClose} aria-label="Close panel">
        <X />
      </Button>
    </div>
  );
}

export function ThreadPanel({
  parentId,
  conversation,
  title,
  savedIds,
  canPin,
  actions,
  onClose,
}: {
  parentId: string;
  conversation: Conversation;
  title: string;
  savedIds: Set<string>;
  canPin: boolean;
  actions: MessageActions;
  onClose: () => void;
}) {
  const q = useThread(parentId);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader title="Thread" subtitle={title} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto pb-3 scrollbar-thin">
        {q.isPending ? (
          <ListSkeleton rows={3} className="p-4" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} className="m-4" />
        ) : (
          <>
            <MessageItem m={q.data.parent} kind={conversation.kind} pinned={q.data.parent.pinned ?? conversation.pinnedMessageIds.includes(q.data.parent.id)} saved={q.data.parent.savedByMe ?? savedIds.has(q.data.parent.id)} canPin={false} actions={actions} inThread />
            <div className="mx-4 my-2 flex items-center gap-2 text-[11.5px] text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              {q.data.replies.length} {q.data.replies.length === 1 ? "reply" : "replies"}
              <span className="h-px flex-1 bg-border" />
            </div>
            {q.data.replies.map((r) => (
              <MessageItem key={r.id} m={r} kind={conversation.kind} pinned={false} saved={r.savedByMe ?? savedIds.has(r.id)} canPin={canPin} actions={actions} inThread />
            ))}
          </>
        )}
      </div>
      {conversation.archived ? (
        <p className="border-t border-border bg-muted px-4 py-3 text-[12.5px] text-muted-foreground">Archived: replies are closed.</p>
      ) : (
        <Composer conversationId={conversation.id} memberEmpIds={conversation.memberEmpIds} parentId={parentId} placeholder="Reply in thread…" compact autoFocus />
      )}
    </div>
  );
}

export function DetailsPanel({
  conversation,
  messages,
  title,
  onClose,
  onJump,
}: {
  conversation: Conversation;
  messages: Message[];
  title: string;
  onClose: () => void;
  onJump: (id: string) => void;
}) {
  const lookup = useLookup();
  const presenceOf = usePresenceOf();
  const me = useViewer()?.employee.empId;
  const can = conversation.can;
  const rename = useRenameConversation();
  const [renaming, setRenaming] = React.useState(false);
  const [draftName, setDraftName] = React.useState(conversation.name ?? "");
  const [adding, setAdding] = React.useState(false);
  const [removing, setRemoving] = React.useState<string | null>(null);
  const setTopic = useSetTopic();
  const [editingTopic, setEditingTopic] = React.useState(false);
  const [draftTopic, setDraftTopic] = React.useState(conversation.topic ?? "");
  const setModerator = useSetModerator();
  const archive = useArchiveConversation();
  const askReason = useReason();
  const policy = useCommsPolicy();
  // Live: the server's pin list (pinned messages older than the loaded history are included). Not for someone who only
  // manages a channel: they never read its messages.
  const livePins = usePins(conversation.id, isLive("m14") && !conversation.managingOnly, conversation.pinnedMessageIds);
  const saveTopic = async (topic: string | null) => {
    try {
      await setTopic.mutateAsync({ id: conversation.id, topic });
      toast.success(topic ? "Topic saved" : "Topic cleared");
      setEditingTopic(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't change the topic.");
    }
  };
  const toggleModerator = async (empId: string, moderator: boolean) => {
    try {
      await setModerator.mutateAsync({ id: conversation.id, empId, moderator });
      toast.success(moderator ? "Now a moderator" : "No longer a moderator");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't change the moderators.");
    }
  };
  const archiveIt = async () => {
    const reason = await askReason({
      title: `Archive ${conversation.kind === "channel" ? "this channel" : "this group"}?`,
      description: "Members can still read its history, but nobody can send, react, pin or change anything. This cannot be undone here. Your reason is kept in the audit log.",
      confirmLabel: "Archive",
      destructive: true,
      placeholder: "Why it is archived (at least 5 characters)",
    });
    if (!reason) return;
    try {
      await archive.mutateAsync({ id: conversation.id, reason });
      toast.success("Archived");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't archive it.");
    }
  };
  // Only people added by hand can be removed; department members follow the employee records.
  const removable = (id: string) => !!can?.manageMembers && conversation.kind !== "dm" && id !== me && (conversation.memberSources?.[id] ?? "added") === "added";
  const saveName = async () => {
    try {
      await rename.mutateAsync({ id: conversation.id, name: draftName });
      toast.success("Renamed");
      setRenaming(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't rename it.");
    }
  };
  const pinned = (livePins.data ?? messages.filter((m) => conversation.pinnedMessageIds.includes(m.id))).filter((m) => !m.deleted);
  const files = messages.flatMap((m) => m.attachments.map((a) => ({ ...a, at: m.at })));
  const tasks = Array.from(new Map(messages.filter((m) => m.linkedTaskId).map((m) => [m.linkedTaskId!, m])).values());
  const dept = lookup.department(conversation.scope?.departmentId);
  const members = [...conversation.memberEmpIds].sort((a, b) => (lookup.employee(a)?.name ?? a).localeCompare(lookup.employee(b)?.name ?? b));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader title={conversation.kind === "dm" ? "About this chat" : "Details"} subtitle={title} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin">
        {can?.rename && conversation.kind !== "dm" && (
          <div className="mb-3">
            {renaming ? (
              <form
                className="flex items-center gap-2"
                onSubmit={(e) => {
                  e.preventDefault();
                  if (draftName.trim()) void saveName();
                }}
              >
                <Input autoFocus value={draftName} onChange={(e) => setDraftName(e.target.value)} maxLength={80} aria-label="Conversation name" className="h-8 text-[13px]" />
                <Button size="sm" type="submit" disabled={!draftName.trim()} loading={rename.isPending}>
                  Save
                </Button>
                <Button size="sm" type="button" variant="ghost" onClick={() => setRenaming(false)}>
                  Cancel
                </Button>
              </form>
            ) : (
              <Button
                size="sm"
                variant="outline"
                onClick={() => {
                  setDraftName(conversation.name ?? "");
                  setRenaming(true);
                }}
              >
                <Pencil /> Rename
              </Button>
            )}
          </div>
        )}
        {editingTopic ? (
          <form
            className="mb-3 grid gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              void saveTopic(draftTopic.trim() || null);
            }}
          >
            <Input autoFocus value={draftTopic} onChange={(e) => setDraftTopic(e.target.value)} maxLength={300} aria-label="Topic" placeholder="What is this conversation for?" className="h-8 text-[13px]" />
            <div className="flex gap-2">
              <Button size="sm" type="submit" loading={setTopic.isPending}>
                Save topic
              </Button>
              {conversation.topic && (
                <Button size="sm" type="button" variant="ghost" onClick={() => void saveTopic(null)}>
                  Clear
                </Button>
              )}
              <Button size="sm" type="button" variant="ghost" onClick={() => setEditingTopic(false)}>
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="mb-3 flex items-start gap-2">
            {conversation.topic ? <p className="flex-1 text-[13px]">{conversation.topic}</p> : can?.rename && conversation.kind !== "dm" ? <p className="flex-1 text-[12.5px] text-muted-foreground">No topic yet.</p> : null}
            {can?.rename && conversation.kind !== "dm" && (
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-2 text-[12px]"
                onClick={() => {
                  setDraftTopic(conversation.topic ?? "");
                  setEditingTopic(true);
                }}
              >
                <Pencil /> {conversation.topic ? "Edit topic" : "Add a topic"}
              </Button>
            )}
          </div>
        )}
        <div className="mb-4 flex flex-wrap gap-1.5">
          <Badge tone="outline">{conversation.kind === "channel" ? "Channel" : conversation.kind === "group" ? "Group" : "Direct message"}</Badge>
          {dept && <Badge tone="work">{dept.name}</Badge>}
          {conversation.scope?.projectId && <Badge tone="info">Project channel</Badge>}
          {conversation.archived && (
            <Badge tone="outline">
              <Archive /> Archived
            </Badge>
          )}
          <Badge tone="outline">Created {formatDate(conversation.createdAt)}</Badge>
        </div>

        <Section
          title={`Members · ${members.length}`}
          action={
            can?.manageMembers && conversation.kind !== "dm" ? (
              <Button size="sm" variant="ghost" className="h-6 px-2 text-[12px]" onClick={() => setAdding(true)}>
                <UserPlus /> Add people
              </Button>
            ) : undefined
          }
        >
          <ul className="grid gap-1">
            {members.map((id) => {
              const e = lookup.employee(id);
              const p = presenceOf(id);
              const left = e?.status === "left";
              return (
                <li key={id} className="flex items-center gap-1">
                  <Link href={`/people/${id}`} className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg px-1.5 py-1 hover:bg-muted">
                    <span className="relative">
                      <Avatar name={e?.name ?? id} hue={e?.avatarHue} size={26} className={cn(left && "grayscale opacity-60")} />
                      {!left && <PresenceDot state={p?.state} className="absolute -bottom-0.5 -right-0.5 size-2" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]">{e?.name ?? id}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {left ? "Account disabled" : p?.state === "online" ? "Online" : e?.designation}
                      </span>
                    </span>
                    {conversation.moderatorEmpIds.includes(id) && (
                      <Badge tone="outline" className="text-[10.5px]">
                        <Shield /> Moderator
                      </Badge>
                    )}
                  </Link>
                  {can?.manageModerators && !left && conversation.kind !== "dm" && id !== me && (
                    <Button
                      size="icon-sm"
                      variant="ghost"
                      className="size-7 shrink-0 text-muted-foreground"
                      onClick={() => void toggleModerator(id, !conversation.moderatorEmpIds.includes(id))}
                      aria-label={conversation.moderatorEmpIds.includes(id) ? `Stop ${e?.name ?? id} being a moderator` : `Make ${e?.name ?? id} a moderator`}
                      title={conversation.moderatorEmpIds.includes(id) ? "Stop being a moderator" : "Make moderator"}
                    >
                      {conversation.moderatorEmpIds.includes(id) ? <ShieldOff /> : <ShieldPlus />}
                    </Button>
                  )}
                  {removable(id) && (
                    <Button size="icon-sm" variant="ghost" className="size-7 shrink-0 text-muted-foreground" onClick={() => setRemoving(id)} aria-label={`Remove ${e?.name ?? id}`}>
                      <UserMinus />
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        </Section>

        {/* Someone who only manages a channel never sees its messages, pins or files. */}
        {!conversation.managingOnly && (
        <>
        <Section title={`Pinned · ${pinned.length}`}>
          {pinned.length ? (
            <ul className="grid gap-2">
              {pinned.map((m) => (
                <li key={m.id}>
                  <button onClick={() => onJump(m.id)} className="w-full rounded-lg border border-border bg-card p-2.5 text-left hover:bg-muted">
                    <p className="mb-1 flex items-center gap-1 text-[11.5px] text-muted-foreground">
                      <Pin className="size-3" /> {lookup.employee(m.author)?.name} · {formatDate(m.at)}
                    </p>
                    <div className="line-clamp-3 text-[12.5px]">
                      <MessageBody body={m.body || "Shared a file"} />
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">Nothing pinned yet. Pin a message from its menu.</p>
          )}
        </Section>

        <Section title={`Files · ${files.length}`}>
          {files.length ? (
            <div className="grid gap-1.5">
              {files.map((f) => (
                <CommsFile key={f.id} file={f} />
              ))}
            </div>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">No files shared yet.</p>
          )}
        </Section>

        <Section title={`Linked tasks · ${tasks.length}`}>
          {tasks.length ? (
            <ul className="grid gap-1.5">
              {tasks.map((m) => (
                <li key={m.linkedTaskId}>
                  <Link href={`/tasks/${m.linkedTaskId}`} className="flex items-center gap-2 rounded-lg border border-border px-2.5 py-2 text-[12.5px] hover:bg-muted">
                    <ListTodo className="size-4 shrink-0 text-zone-work" />
                    <span className="font-mono text-[11.5px]">{m.linkedTaskNumber}</span>
                    <span className="truncate">{m.linkedTaskTitle}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-[12.5px] text-muted-foreground">No tasks linked yet.</p>
          )}
        </Section>
        </>
        )}

        <div className="mb-4 flex flex-wrap gap-2">
          {can?.leave && me && (
            <Button size="sm" variant="outline" onClick={() => setRemoving(me)}>
              <LogOut /> Leave conversation
            </Button>
          )}
          {can?.archive && !conversation.archived && (
            <Button size="sm" variant="outline" onClick={() => void archiveIt()} loading={archive.isPending}>
              <Archive /> Archive
            </Button>
          )}
        </div>

        <p className="mt-2 flex gap-2 rounded-lg bg-muted px-3 py-2.5 text-[12px] text-muted-foreground">
          <Archive className="mt-0.5 size-3.5 shrink-0" />
          {isLive("m14") ? (policy.data ? retentionNotice(policy.data) : "") : RETENTION_TEXT} Private conversations are not visible to managers unless policy allows it.
        </p>
      </div>
      {adding && <AddMembersDialog conversation={conversation} onClose={() => setAdding(false)} />}
      {removing && <RemoveMemberDialog conversation={conversation} empId={removing} leaving={removing === me} onClose={() => setRemoving(null)} />}
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <div className="mb-2 flex items-center justify-between gap-2">
        <h3 className="text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</h3>
        {action}
      </div>
      {children}
    </section>
  );
}
