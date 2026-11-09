"use client";
import * as React from "react";
import Link from "next/link";
import { Bookmark, Plus, Search } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/overlays";
import { ErrorState, ListSkeleton } from "@/components/shared/states";
import { formatRelative, formatTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { isToday } from "date-fns";
import { useConversations } from "../hooks";
import type { Conversation } from "../types";
import { ConversationAvatar, useConversationTitle } from "./bits";

function when(iso: string) {
  return isToday(new Date(iso)) ? formatTime(iso) : formatRelative(iso).replace(" ago", "");
}

export function ConversationList({
  activeId,
  savedActive,
  onNew,
  onSaved,
}: {
  activeId?: string;
  savedActive: boolean;
  onNew: () => void;
  onSaved: () => void;
}) {
  const q = useConversations();
  const title = useConversationTitle();
  const [search, setSearch] = React.useState("");
  const needle = search.trim().toLowerCase();
  const list = (q.data ?? []).filter((c) => !needle || title(c).toLowerCase().includes(needle) || (c.topic ?? "").toLowerCase().includes(needle));
  const channels = list.filter((c) => c.kind === "channel").sort((a, b) => (a.name ?? "").localeCompare(b.name ?? ""));
  const direct = list.filter((c) => c.kind !== "channel");

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-center gap-2 border-b border-border p-3">
        <div className="relative flex-1">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a conversation" className="h-8 pl-8 text-[13px]" aria-label="Find a conversation" />
        </div>
        <Tip content="New message or channel">
          <Button size="icon-sm" variant="outline" onClick={onNew} aria-label="New message or channel">
            <Plus />
          </Button>
        </Tip>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-2 scrollbar-thin">
        <button
          onClick={onSaved}
          className={cn("mb-1 flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-[13px] font-medium transition hover:bg-muted", savedActive && "bg-accent")}
        >
          <span className="grid size-8 place-content-center rounded-lg bg-muted text-muted-foreground">
            <Bookmark className="size-4" />
          </span>
          Saved messages
        </button>
        {q.isPending ? (
          <ListSkeleton rows={6} className="mt-2" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : (
          <>
            <Section title="Channels" items={channels} activeId={activeId} title_={title} />
            <Section title="Direct messages" items={direct} activeId={activeId} title_={title} />
            {!list.length && <p className="px-3 py-6 text-center text-[13px] text-muted-foreground">No conversations match “{search}”.</p>}
          </>
        )}
      </div>
    </div>
  );
}

function Section({ title, items, activeId, title_ }: { title: string; items: Conversation[]; activeId?: string; title_: (c: Conversation) => string }) {
  if (!items.length) return null;
  return (
    <div className="mt-3">
      <p className="mb-1 px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</p>
      <ul className="grid gap-0.5">
        {items.map((c) => {
          const active = c.id === activeId;
          return (
            <li key={c.id}>
              <Link
                href={`/messages/${c.id}`}
                aria-current={active ? "page" : undefined}
                className={cn("flex items-center gap-2.5 rounded-lg px-2.5 py-2 transition hover:bg-muted", active && "bg-accent hover:bg-accent")}
              >
                <ConversationAvatar c={c} />
                <span className="grid min-w-0 flex-1">
                  <span className="flex min-w-0 items-center justify-between gap-2">
                    <span className={cn("truncate text-[13px]", c.unread ? "font-semibold" : "font-medium")}>{title_(c)}</span>
                    <span className="shrink-0 text-[11px] text-muted-foreground tabular">{when(c.lastMessageAt)}</span>
                  </span>
                  <span className="flex min-w-0 items-center justify-between gap-2">
                    <span className={cn("truncate text-[12px]", c.unread ? "text-foreground" : "text-muted-foreground")}>{c.lastMessagePreview ?? c.topic ?? "No messages yet"}</span>
                    {c.unread > 0 && (
                      <span className="grid h-[18px] min-w-[18px] shrink-0 place-content-center rounded-full bg-primary px-1 text-[10.5px] font-bold text-primary-foreground tabular" aria-label={`${c.unread} unread`}>
                        {c.unread}
                      </span>
                    )}
                  </span>
                </span>
              </Link>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
