"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Bookmark, Check, CheckCheck, Copy, Ellipsis, Link2, ListTodo, MessageSquareReply, Pencil, Pin, PinOff, SmilePlus, Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Avatar } from "@/components/ui/misc";
import { Popover, PopoverContent, PopoverTrigger, Tip } from "@/components/ui/overlays";
import { FileCard } from "@/components/shared/timeline";
import { useLookup } from "@/hooks/use-directory";
import { ApiError } from "@/lib/api/mock";
import { useViewer } from "@/lib/auth/viewer";
import { formatDateTime, formatTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useEditMessage, useReact, useTogglePin, useToggleSave } from "../hooks";
import { QUICK_REACTIONS, splitMentions } from "../logic";
import type { ConversationKind, Message } from "../types";

export interface MessageActions {
  onReply?: (m: Message) => void;
  onDelete: (m: Message) => void;
  onLinkTask: (m: Message) => void;
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
          Message deleted · <span className="not-italic">kept in the audit log</span>
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
              <FileCard key={a.id} file={a} onOpen={() => toast("Opening a private link (demo)", { description: "Links expire in minutes and every download is permission-checked." })} />
            ))}
          </div>
        )}

        {m.linkedTaskId && (
          <Link href={`/tasks/${m.linkedTaskId}`} className="mt-1.5 inline-flex max-w-full items-center gap-1.5 rounded-md border border-zone-work/30 bg-zone-work/10 px-2 py-1 text-[12px] hover:bg-zone-work/15">
            <ListTodo className="size-3.5 shrink-0 text-zone-work" />
            <span className="font-mono">{m.linkedTaskNumber}</span>
            <span className="truncate">{m.linkedTaskTitle}</span>
          </Link>
        )}

        {(m.reactions.length > 0 || (!inThread && m.replyCount > 0) || (mine && kind !== "channel")) && (
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            {m.reactions.map((r) => {
              const mineR = r.empIds.includes(viewer?.employee.empId ?? "");
              const names = r.empIds.map((p) => lookup.employee(p)?.name.split(" ")[0] ?? p).join(", ");
              return (
                <Tip key={r.emoji} content={names}>
                  <button
                    onClick={() => run(react.mutateAsync({ id: m.id, emoji: r.emoji }))}
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
            {mine && kind !== "channel" && (
              <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-muted-foreground" aria-label={m.readBy.length ? "Read" : "Delivered"}>
                {m.readBy.length ? <CheckCheck className="size-3.5 text-info" /> : <Check className="size-3.5" />}
                {m.readBy.length ? (kind === "group" ? `Read by ${m.readBy.length}` : "Read") : "Delivered"}
              </span>
            )}
          </div>
        )}
      </div>

      {/* Hover toolbar (always reachable by keyboard; on phones only the menu shows). */}
      <div className="absolute -top-3 right-3 flex items-center gap-0.5 rounded-lg border border-border bg-popover p-0.5 opacity-0 shadow-strata transition-opacity focus-within:opacity-100 group-hover:opacity-100 max-sm:opacity-100 max-sm:border-transparent max-sm:bg-transparent max-sm:shadow-none">
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
        {!inThread && actions.onReply && (
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
            <div className="flex justify-between gap-0.5 px-1 py-1 sm:hidden">
              {QUICK_REACTIONS.slice(0, 5).map((e) => (
                <button key={e} onClick={() => run(react.mutateAsync({ id: m.id, emoji: e }))} className="grid size-8 place-content-center rounded-md text-lg hover:bg-muted" aria-label={`React ${e}`}>
                  {e}
                </button>
              ))}
            </div>
            {!inThread && actions.onReply && (
              <DropdownMenuItem onSelect={() => actions.onReply?.(m)}>
                <MessageSquareReply /> Reply in thread
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => run(save.mutateAsync(m.id), saved ? "Removed from saved" : "Saved for later")}>
              <Bookmark /> {saved ? "Remove from saved" : "Save for later"}
            </DropdownMenuItem>
            {canPin && !inThread && (
              <DropdownMenuItem onSelect={() => run(pin.mutateAsync(m.id), pinned ? "Unpinned" : "Pinned to the conversation")}>
                {pinned ? <PinOff /> : <Pin />} {pinned ? "Unpin" : "Pin"}
              </DropdownMenuItem>
            )}
            <DropdownMenuItem onSelect={() => actions.onLinkTask(m)}>
              <Link2 /> {m.linkedTaskId ? "Change linked task" : "Link to a task"}
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() => {
                navigator.clipboard?.writeText(m.body).catch(() => undefined);
                toast("Text copied");
              }}
            >
              <Copy /> Copy text
            </DropdownMenuItem>
            {mine && (
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
