"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Bookmark, Check, CheckCheck, Copy, Ellipsis, Link2, ListTodo, MessageSquareReply, Pencil, Pin, PinOff, ShieldX, SmilePlus, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Avatar } from "@/components/ui/misc";
import { Popover, PopoverContent, PopoverTrigger, Tip } from "@/components/ui/overlays";
import { CommsFile } from "./comms-file";
import { useLookup } from "@/hooks/use-directory";
import { ApiError } from "@/lib/api/mock";
import { useViewer } from "@/lib/auth/viewer";
import { formatDateTime, formatTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useQuery } from "@tanstack/react-query";
import { useEditMessage, useReact, useTogglePin, useToggleSave } from "../hooks";
import { liveCommsApi } from "../live-api";
import { QUICK_REACTIONS, splitMentions } from "../logic";
import type { ConversationKind, Message } from "../types";

export interface MessageActions {
  onReply?: (m: Message) => void;
  onDelete: (m: Message) => void;
  /** Absent when linking to tasks is not available. */
  onLinkTask?: (m: Message) => void;
  /** A moderator (or a comms admin in a channel) removes someone else's message, with a reason. Absent for everyone else. */
  onModeratorRemove?: (m: Message) => void;
  /** Archived conversation: it can be read (and saved, copied), nothing else. */
  readOnly?: boolean;
}

/**
 * Per-message status for the author, in DMs and groups (never in channels): sent, delivered (it reached their screen)
 * and read, with who for a group. `deliveredTo` is known live; the demo only knows who read it.
 */
function DeliveryStatus({ m, kind }: { m: Message; kind: ConversationKind }) {
  const lookup = useLookup();
  const nameOf = (id: string) => lookup.employee(id)?.name ?? id;
  const delivered = Array.from(new Set([...(m.deliveredTo ?? []), ...m.readBy]));
  const knowsDelivery = m.deliveredTo !== undefined;
  const label = m.readBy.length
    ? kind === "group"
      ? `Read by ${m.readBy.length}`
      : "Read"
    : !knowsDelivery || delivered.length
      ? kind === "group" && knowsDelivery
        ? `Delivered to ${delivered.length}`
        : "Delivered"
      : "Sent";
  const icon = m.readBy.length ? <CheckCheck className="size-3.5 text-info" /> : !knowsDelivery || delivered.length ? <CheckCheck className="size-3.5" /> : <Check className="size-3.5" />;
  const badge = (
    <span className="inline-flex items-center gap-1" aria-label={label}>
      {icon}
      {label}
    </span>
  );
  if (kind !== "group" || !knowsDelivery) return <span className="ml-auto text-[11px] text-muted-foreground">{badge}</span>;
  const waiting = delivered.filter((id) => !m.readBy.includes(id));
  return (
    <Popover>
      <PopoverTrigger asChild>
        <button className="ml-auto rounded px-1 text-[11px] text-muted-foreground hover:bg-muted" aria-label={`${label}. Show who`}>
          {badge}
        </button>
      </PopoverTrigger>
      <PopoverContent className="w-60 p-3 text-[12.5px]" align="end">
        <p className="mb-1 font-medium">Read by {m.readBy.length}</p>
        <ul className="mb-2 grid gap-0.5 text-muted-foreground">
          {m.readBy.length ? m.readBy.map((id) => <li key={id}>{nameOf(id)}</li>) : <li>Nobody yet</li>}
        </ul>
        <p className="mb-1 font-medium">Delivered, not read yet · {waiting.length}</p>
        <ul className="grid gap-0.5 text-muted-foreground">{waiting.length ? waiting.map((id) => <li key={id}>{nameOf(id)}</li>) : <li>Nobody</li>}</ul>
      </PopoverContent>
    </Popover>
  );
}

function TaskChip({ id, number, title }: { id: string; number?: string; title?: string }) {
  return (
    <Link href={`/tasks/${id}`} className="mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-md border border-zone-work/30 bg-zone-work/10 px-2 py-1 text-[12px] hover:bg-zone-work/15">
      <ListTodo className="size-3.5 shrink-0 text-zone-work" />
      <span className="font-mono">{number}</span>
      <span className="truncate">{title}</span>
    </Link>
  );
}

/** A linked task this view did not name: ask the server what this person may see (Module 5 decides). */
function HiddenLink({ messageId }: { messageId: string }) {
  const q = useQuery({ queryKey: ["comms", "link", messageId], queryFn: () => liveCommsApi.messageLink(messageId), staleTime: 0 });
  if (q.isPending) return null;
  if (q.data) return <TaskChip id={q.data.id} number={q.data.number} title={q.data.title} />;
  return (
    <span className="mt-1.5 inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-[12px] text-muted-foreground">
      <ListTodo className="size-3.5 shrink-0" /> Linked to a task you can&apos;t open
    </span>
  );
}

export function MessageBody({ body }: { body: string }) {
  const lookup = useLookup();
  const firstNames = new Set(lookup.employees.map((e) => e.name.split(" ")[0].toLowerCase()));
  return (
    <p className="whitespace-pre-wrap break-words text-[14px] leading-relaxed">
      {splitMentions(body).map((part, i) =>
        part.startsWith("@") && firstNames.has(part.slice(1).toLowerCase()) ? (
          <span key={i} className="rounded bg-primary/12 px-1 font-medium text-primary">
            {part}
          </span>
        ) : (
          <React.Fragment key={i}>{part}</React.Fragment>
        ),
      )}
    </p>
  );
}

export function MessageItem({
  m,
  kind,
  compact,
  pinned,
  saved,
  canPin,
  actions,
  inThread,
}: {
  m: Message;
  kind: ConversationKind;
  compact?: boolean;
  pinned: boolean;
  saved: boolean;
  canPin: boolean;
  actions: MessageActions;
  inThread?: boolean;
}) {
  const lookup = useLookup();
  const viewer = useViewer();
  const author = lookup.employee(m.author);
  const mine = m.author === viewer?.employee.empId;
  const react = useReact();
  const save = useToggleSave();
  const pin = useTogglePin();
  const edit = useEditMessage();
  const [editing, setEditing] = React.useState(false);
  const [draft, setDraft] = React.useState(m.body);
  const [pickerOpen, setPickerOpen] = React.useState(false);

  const run = async (p: Promise<unknown>, ok?: string) => {
    try {
      await p;
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Something went wrong.");
    }
  };

  if (m.deleted) {
    return (
      <div className={cn("flex gap-3 px-4 py-1.5", !compact && "mt-2")}>
        <span className="w-9 shrink-0" />
        <p className="text-[13px] italic text-muted-foreground">
          {m.removedByModerator ? "Removed by a moderator" : "Message deleted"} · <span className="not-italic">kept in the audit log</span>
        </p>
      </div>
    );
  }

  return (
    <div className={cn("group relative flex gap-3 px-4 py-1 transition-colors hover:bg-muted/50", !compact && "mt-2 pt-2", pinned && "bg-signal/[0.07]")}>
      <div className="w-9 shrink-0">
        {compact ? (
          <span className="invisible block pt-1 text-right text-[10.5px] text-muted-foreground tabular group-hover:visible">{formatTime(m.at)}</span>
        ) : (
          <Link href={`/people/${m.author}`} tabIndex={-1} aria-hidden>
            <Avatar name={author?.name ?? m.author} hue={author?.avatarHue} size={36} />
          </Link>
        )}
      </div>
      <div className="min-w-0 flex-1">
        {!compact && (
          <div className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-[13.5px] font-semibold">{author?.name ?? m.author}</span>
            <Tip content={formatDateTime(m.at)}>
              <span tabIndex={0} className="text-[11.5px] text-muted-foreground tabular outline-none">
                {formatTime(m.at)}
              </span>
            </Tip>
            {pinned && (
              <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-muted-foreground">
                <Pin className="size-3" /> Pinned
              </span>
            )}
          </div>
        )}
        {/* A follow-on message has no name line: its pin gets a line of its own, so it is never just a tint. */}
        {compact && pinned && (
          <span className="inline-flex items-center gap-0.5 text-[11px] font-medium text-muted-foreground">
            <Pin className="size-3" /> Pinned
          </span>
        )}

        {editing ? (
          <div className="mt-1 grid gap-2">
            <textarea
              autoFocus
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setEditing(false);
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  if (draft.trim()) run(edit.mutateAsync({ id: m.id, body: draft })).then(() => setEditing(false));
                }
              }}
              className="min-h-16 w-full resize-y rounded-lg border border-ring bg-background px-3 py-2 text-[14px] outline-none"
              aria-label="Edit message"
            />
            <div className="flex gap-2">
              <Button size="sm" onClick={() => draft.trim() && run(edit.mutateAsync({ id: m.id, body: draft })).then(() => setEditing(false))} loading={edit.isPending}>
                Save
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          m.body && (
            <div className="flex flex-wrap items-end gap-x-1.5">
              <MessageBody body={m.body} />
              {m.editedAt && (
                <Tip content={`Edited ${formatDateTime(m.editedAt)}`}>
                  <span tabIndex={0} className="text-[11px] text-muted-foreground outline-none">
                    (edited)
                  </span>
                </Tip>
              )}
            </div>
          )
        )}

        {m.attachments.length > 0 && (
          <div className="mt-1.5 grid max-w-sm gap-1.5">
            {m.attachments.map((a) => (
              <CommsFile key={a.id} file={a} />
            ))}
          </div>
        )}

        {m.linkedTaskId ? (
          <TaskChip id={m.linkedTaskId} number={m.linkedTaskNumber} title={m.linkedTaskTitle} />
        ) : (
          m.linkHidden && <HiddenLink messageId={m.id} />
        )}

        {(m.reactions.length > 0 || (!inThread && m.replyCount > 0) || (mine && kind !== "channel")) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {m.reactions.map((r) => {
              const mineR = r.empIds.includes(viewer?.employee.empId ?? "");
              const names = r.empIds.map((p) => lookup.employee(p)?.name.split(" ")[0] ?? p).join(", ");
              return (
                <Tip key={r.emoji} content={names}>
                  <button
                    onClick={() => !actions.readOnly && run(react.mutateAsync({ id: m.id, emoji: r.emoji }))}
                    disabled={actions.readOnly}
                    aria-pressed={mineR}
                    aria-label={`${r.emoji} ${r.empIds.length}, by ${names}`}
                    className={cn(
                      "inline-flex h-6 items-center gap-1 rounded-full border px-2 text-[12px] tabular transition",
                      mineR ? "border-primary/40 bg-primary/10" : "border-border bg-card hover:bg-muted",
                    )}
                  >
                    <span>{r.emoji}</span>
                    <span className="font-medium">{r.empIds.length}</span>
                  </button>
                </Tip>
              );
            })}
            {!inThread && m.replyCount > 0 && actions.onReply && (
              <button onClick={() => actions.onReply?.(m)} className="inline-flex h-6 items-center gap-1 rounded-full px-2 text-[12px] font-medium text-primary hover:bg-primary/10">
                <MessageSquareReply className="size-3.5" />
                {m.replyCount} {m.replyCount === 1 ? "reply" : "replies"}
              </button>
            )}
            {mine && kind !== "channel" && <DeliveryStatus m={m} kind={kind} />}
          </div>
        )}
      </div>

      {/* Hover toolbar (always reachable by keyboard; on phones only the menu shows). */}
      <div className="absolute -top-3 right-3 flex items-center gap-0.5 rounded-lg border border-border bg-popover p-0.5 opacity-0 shadow-strata transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-sm:opacity-100 max-sm:border-transparent max-sm:bg-transparent max-sm:shadow-none">
        {!actions.readOnly && (
        <Popover open={pickerOpen} onOpenChange={setPickerOpen}>
          <PopoverTrigger asChild>
            <Button size="icon-sm" variant="ghost" className="size-7 max-sm:hidden" aria-label="Add reaction">
              <SmilePlus />
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-auto p-1.5" align="end">
            <div className="flex gap-1">
              {QUICK_REACTIONS.map((e) => (
                <button
                  key={e}
                  onClick={() => {
                    setPickerOpen(false);
                    run(react.mutateAsync({ id: m.id, emoji: e }));
                  }}
                  className="grid size-8 place-content-center rounded-md text-lg transition hover:scale-110 hover:bg-muted"
                  aria-label={`React ${e}`}
                >
                  {e}
                </button>
              ))}
            </div>
          </PopoverContent>
        </Popover>
        )}
        {!inThread && actions.onReply && !actions.readOnly && (
          <Tip content="Reply in thread">
            <Button size="icon-sm" variant="ghost" className="size-7 max-sm:hidden" onClick={() => actions.onReply?.(m)} aria-label="Reply in thread">
              <MessageSquareReply />
            </Button>
          </Tip>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button size="icon-sm" variant="ghost" className="size-7" aria-label="More actions">
              <Ellipsis />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-52">
            {!actions.readOnly && (
            <div className="flex justify-between gap-0.5 px-1 py-1 sm:hidden">
              {QUICK_REACTIONS.slice(0, 5).map((e) => (
                <button key={e} onClick={() => run(react.mutateAsync({ id: m.id, emoji: e }))} className="grid size-8 place-content-center rounded-md text-lg hover:bg-muted" aria-label={`React ${e}`}>
                  {e}
                </button>
              ))}
            </div>
            )}
            {!inThread && actions.onReply && (
              <DropdownMenuItem onSelect={() => actions.onReply?.(m)}>
                <MessageSquareReply /> Reply in thread
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => run(save.mutateAsync(m.id), saved ? "Removed from saved" : "Saved for later")}>
              <Bookmark /> {saved ? "Remove from saved" : "Save for later"}
            </DropdownMenuItem>
            {canPin && !inThread && !actions.readOnly && (
              <DropdownMenuItem onSelect={() => run(pin.mutateAsync(m.id), pinned ? "Unpinned" : "Pinned to the conversation")}>
                {pinned ? <PinOff /> : <Pin />} {pinned ? "Unpin" : "Pin"}
              </DropdownMenuItem>
            )}
            {actions.onLinkTask && !actions.readOnly && (
              <DropdownMenuItem onSelect={() => actions.onLinkTask?.(m)}>
                <Link2 /> {m.linkedTaskId ? "Change linked task" : "Link to a task"}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem
              onSelect={() => {
                navigator.clipboard?.writeText(m.body).catch(() => undefined);
                toast("Text copied");
              }}
            >
              <Copy /> Copy text
            </DropdownMenuItem>
            {!mine && actions.onModeratorRemove && !actions.readOnly && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem destructive onSelect={() => actions.onModeratorRemove?.(m)}>
                  <ShieldX /> Remove message…
                </DropdownMenuItem>
              </>
            )}
            {mine && !actions.readOnly && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => {
                    setDraft(m.body);
                    setEditing(true);
                  }}
                >
                  <Pencil /> Edit
                </DropdownMenuItem>
                <DropdownMenuItem destructive onSelect={() => actions.onDelete(m)}>
                  <Trash2 /> Delete
                </DropdownMenuItem>
              </>
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  );
}
