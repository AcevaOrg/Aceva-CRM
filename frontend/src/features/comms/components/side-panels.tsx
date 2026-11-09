"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Archive, ListTodo, Pin, Shield, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/misc";
import { FileCard } from "@/components/shared/timeline";
import { ErrorState, ListSkeleton } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { formatDate, formatRelative } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useThread } from "../hooks";
import { RETENTION_TEXT } from "../logic";
import type { Conversation, Message } from "../types";
import { PresenceDot, usePresenceOf } from "./bits";
import { Composer } from "./composer";
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
            <MessageItem m={q.data.parent} kind={conversation.kind} pinned={conversation.pinnedMessageIds.includes(q.data.parent.id)} saved={savedIds.has(q.data.parent.id)} canPin={false} actions={actions} inThread />
            <div className="mx-4 my-2 flex items-center gap-2 text-[11.5px] text-muted-foreground">
              <span className="h-px flex-1 bg-border" />
              {q.data.replies.length} {q.data.replies.length === 1 ? "reply" : "replies"}
              <span className="h-px flex-1 bg-border" />
            </div>
            {q.data.replies.map((r) => (
              <MessageItem key={r.id} m={r} kind={conversation.kind} pinned={false} saved={savedIds.has(r.id)} canPin={canPin} actions={actions} inThread />
            ))}
          </>
        )}
      </div>
      <Composer conversationId={conversation.id} memberEmpIds={conversation.memberEmpIds} parentId={parentId} placeholder="Reply in thread…" compact autoFocus />
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
  const pinned = messages.filter((m) => conversation.pinnedMessageIds.includes(m.id) && !m.deleted);
  const files = messages.flatMap((m) => m.attachments.map((a) => ({ ...a, at: m.at })));
  const tasks = Array.from(new Map(messages.filter((m) => m.linkedTaskId).map((m) => [m.linkedTaskId!, m])).values());
  const dept = lookup.department(conversation.scope?.departmentId);
  const members = [...conversation.memberEmpIds].sort((a, b) => (lookup.employee(a)?.name ?? a).localeCompare(lookup.employee(b)?.name ?? b));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PanelHeader title={conversation.kind === "dm" ? "About this chat" : "Details"} subtitle={title} onClose={onClose} />
      <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin">
        {conversation.topic && <p className="mb-3 text-[13px]">{conversation.topic}</p>}
        <div className="mb-4 flex flex-wrap gap-1.5">
          <Badge tone="outline">{conversation.kind === "channel" ? "Channel" : conversation.kind === "group" ? "Group" : "Direct message"}</Badge>
          {dept && <Badge tone="work">{dept.name}</Badge>}
          {conversation.scope?.projectId && <Badge tone="info">Project channel</Badge>}
          <Badge tone="outline">Created {formatDate(conversation.createdAt)}</Badge>
        </div>

        <Section title={`Members · ${members.length}`}>
          <ul className="grid gap-1">
            {members.map((id) => {
              const e = lookup.employee(id);
              const p = presenceOf(id);
              const left = e?.status === "left";
              return (
                <li key={id}>
                  <Link href={`/people/${id}`} className="flex items-center gap-2.5 rounded-lg px-1.5 py-1 hover:bg-muted">
                    <span className="relative">
                      <Avatar name={e?.name ?? id} hue={e?.avatarHue} size={26} className={cn(left && "grayscale opacity-60")} />
                      {!left && <PresenceDot state={p?.state} className="absolute -bottom-0.5 -right-0.5 size-2" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px]">{e?.name ?? id}</span>
                      <span className="block truncate text-[11px] text-muted-foreground">
                        {left ? "Account disabled" : p?.state === "online" ? "Online" : p ? `Last seen ${formatRelative(p.lastSeenAt)}` : e?.designation}
                      </span>
                    </span>
                    {conversation.moderatorEmpIds.includes(id) && (
                      <Badge tone="outline" className="text-[10.5px]">
                        <Shield /> Moderator
                      </Badge>
                    )}
                  </Link>
                </li>
              );
            })}
          </ul>
        </Section>

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
                <FileCard key={f.id} file={f} onOpen={() => toast("Opening a private link (demo)")} />
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

        <p className="mt-2 flex gap-2 rounded-lg bg-muted px-3 py-2.5 text-[12px] text-muted-foreground">
          <Archive className="mt-0.5 size-3.5 shrink-0" />
          {RETENTION_TEXT} Private conversations are not visible to managers unless policy allows it.
        </p>
      </div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="mb-5">
      <h3 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</h3>
      {children}
    </section>
  );
}
