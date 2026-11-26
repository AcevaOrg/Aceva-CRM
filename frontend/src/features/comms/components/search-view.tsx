"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowLeft, SearchX, TextSearch } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { formatDateTime } from "@/lib/dates";
import { useMessageSearch } from "../hooks";
import type { Conversation } from "../types";
import { useConversationTitle } from "./bits";
import { MessageBody } from "./message-item";

/**
 * Message search (Module 14). The server searches only the conversations the person can see now, and only messages
 * from where their history there starts: what they could not read in the conversation, they cannot find here either.
 */
export function SearchView({ onBack }: { onBack: () => void }) {
  const [text, setText] = React.useState("");
  const [term, setTerm] = React.useState("");
  React.useEffect(() => {
    const t = setTimeout(() => setTerm(text), 300);
    return () => clearTimeout(t);
  }, [text]);
  const q = useMessageSearch(term);
  const title = useConversationTitle();
  const lookup = useLookup();
  const short = term.trim().length < 2;

  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Search messages">
      <header className="flex items-center gap-3 border-b border-border px-3 py-2.5 sm:px-4">
        <Button size="icon-sm" variant="ghost" className="md:hidden" onClick={onBack} aria-label="Back to conversations">
          <ArrowLeft />
        </Button>
        <span className="grid size-[34px] place-content-center rounded-lg bg-muted text-muted-foreground">
          <TextSearch className="size-4" />
        </span>
        <div className="min-w-0 flex-1">
          <h2 className="text-[15px] font-semibold">Search messages</h2>
          <p className="text-[12px] text-muted-foreground">Only conversations you are in, and only messages from when you joined.</p>
        </div>
      </header>
      <div className="border-b border-border p-3">
        <Input autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="Words in a message" aria-label="Search messages text" className="h-9" />
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin">
        {short ? (
          <p className="text-[13px] text-muted-foreground">Type at least two characters.</p>
        ) : q.isPending ? (
          <ListSkeleton rows={4} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.data.length === 0 ? (
          <EmptyState icon={<SearchX />} title="No messages found" description="Nothing matches in the conversations you can see." />
        ) : (
          <ul className="grid gap-2" aria-label="Search results">
            {q.data.map(({ message: m, conversation }) => (
              <li key={m.id}>
                <Link href={`/messages/${conversation.id}?m=${m.id}`} className="block rounded-xl border border-border p-3 transition hover:bg-muted">
                  <p className="mb-1 flex flex-wrap items-center gap-x-2 text-[12px] text-muted-foreground">
                    <span className="font-medium text-foreground">{lookup.employee(m.author)?.name ?? m.author}</span> in {title(conversation as Conversation)} ·{" "}
                    {formatDateTime(m.at)}
                  </p>
                  <div className="line-clamp-3">
                    <MessageBody body={m.body} />
                  </div>
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  );
}
