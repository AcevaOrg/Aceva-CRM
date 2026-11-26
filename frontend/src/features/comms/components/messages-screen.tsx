"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Archive, ArrowLeft, Bookmark, History, Info, MessagesSquare, Pin, SearchX, Settings2, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Tip } from "@/components/ui/overlays";
import { Sheet, SheetContent, SheetTitle } from "@/components/ui/sheet";
import { PageHeader } from "@/components/layout/page-header";
import { RequireAccess } from "@/components/shared/can";
import { useReason } from "@/components/shared/dialogs";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { ApiError } from "@/lib/api/mock";
import { useUrlState } from "@/hooks/use-url-state";
import { useViewer } from "@/lib/auth/viewer";
import { formatDateTime } from "@/lib/dates";
import { isLive } from "@/lib/api/http";
import { cn } from "@/lib/utils";
import { useLoadOlder, useMarkConversationRead, useMessages, useRemoveAsModerator, useSavedMessages } from "../hooks";
import { groupByDay, isContinuation } from "../logic";
import { whenPersonIsHere } from "../realtime";
import type { Conversation, Message } from "../types";
import { ConversationAvatar, dmOther, useConversationTitle, useMediaQuery, usePresenceOf } from "./bits";
import { Composer } from "./composer";
import { ConversationList } from "./conversation-list";
import { DeleteMessageDialog, LinkTaskDialog, NewConversationDialog } from "./dialogs";
import { MessageBody, MessageItem, type MessageActions } from "./message-item";
import { SearchView } from "./search-view";
import { DetailsPanel, ThreadPanel } from "./side-panels";

type Panel = { kind: "details" } | { kind: "thread"; id: string } | null;

/** Module 14 live: the real API (linking messages to Module 5 tasks included). */
const LIVE_API = isLive("m14");

/** comms.admin (live): the channel overview, where channels are managed without reading their messages. */
function ManageChannelsLink() {
  const viewer = useViewer();
  if (!LIVE_API || !viewer?.can("comms.admin")) return null;
  return (
    <Button size="sm" variant="outline" asChild>
      <Link href="/messages/channels">
        <Settings2 /> Manage channels
      </Link>
    </Button>
  );
}

export function MessagesScreen({ conversationId }: { conversationId?: string }) {
  const [newParam, setNewParam] = useUrlState<string>("new", "");
  // The saved and search views belong to the conversation that was open when they were chosen, so opening another
  // conversation closes them.
  const [side, setSide] = React.useState<{ view: "saved" | "search"; for: string } | null>(null);
  const open = (view: "saved" | "search") => setSide({ view, for: conversationId ?? "" });
  const saved = side?.view === "saved" && side.for === (conversationId ?? "");
  const searching = side?.view === "search" && side.for === (conversationId ?? "");
  const setSaved = (on: boolean) => (on ? open("saved") : setSide(null));
  const showCenter = !!conversationId || saved || searching;

  return (
    <RequireAccess permission="comms.use">
      <PageHeader title="Messages" description="Direct messages, groups and team channels. Only people in a conversation can read it." className="mb-4 pb-4" actions={<ManageChannelsLink />} />
      <div className="-mb-10 flex h-[calc(100dvh-13.5rem)] min-h-[480px] overflow-hidden rounded-xl border border-border bg-card shadow-strata">
        <aside className={cn("w-full min-w-0 md:w-72 md:shrink-0 md:border-r md:border-border", showCenter && "max-md:hidden")}>
          <ConversationList
            activeId={conversationId}
            savedActive={saved}
            searchActive={searching}
            onNew={() => setNewParam("1")}
            onSaved={() => setSaved(true)}
            onSearch={() => open("search")}
          />
        </aside>
        {saved ? (
          <SavedView onBack={() => setSaved(false)} />
        ) : searching ? (
          <SearchView onBack={() => setSide(null)} />
        ) : conversationId ? (
          <ConversationView key={conversationId} id={conversationId} />
        ) : (
          <section className="hidden flex-1 md:flex">
            <EmptyState
              className="m-6 flex-1 border-0"
              icon={<MessagesSquare />}
              title="Pick a conversation"
              description="Or start a new one. Channels follow your department and projects."
              action={<Button onClick={() => setNewParam("1")}>New message</Button>}
            />
          </section>
        )}
      </div>
      {newParam && <NewConversationDialog onClose={() => setNewParam("")} />}
    </RequireAccess>
  );
}

function ConversationView({ id }: { id: string }) {
  const q = useMessages(id);
  const savedQ = useSavedMessages();
  const markRead = useMarkConversationRead();
  const loadOlder = useLoadOlder(id);
  const moderate = useRemoveAsModerator();
  const askReason = useReason();
  const title = useConversationTitle();
  const lookup = useLookup();
  const viewer = useViewer();
  const presenceOf = usePresenceOf();
  const wide = useMediaQuery("(min-width: 1280px)");
  const [panel, setPanel] = React.useState<Panel>(null);
  const [deleting, setDeleting] = React.useState<Message | null>(null);
  const [linking, setLinking] = React.useState<Message | null>(null);
  const [flash, setFlash] = React.useState<string | null>(null);
  const scroller = React.useRef<HTMLDivElement>(null);
  const count = q.data?.messages.length ?? 0;
  const lastAuthor = q.data?.messages[count - 1]?.author;
  // The newest message: older history loaded above it must not move the screen to the bottom.
  const lastId = q.data?.messages[count - 1]?.id;

  // Mark as read when opened and whenever new messages arrive, but only while the person is actually here: a message
  // landing on an unattended screen is not read (and marking it would count as activity, keeping an idle session alive).
  const { mutate: mark } = markRead;
  const loaded = !!q.data;
  React.useEffect(() => {
    if (!loaded) return;
    return whenPersonIsHere(() => mark(id));
  }, [id, count, loaded, mark]);

  // Stick to the bottom on open and when new messages arrive (if already near the bottom, or it's mine).
  // Opened from a search result (?m=<message>): show that message once it is on the screen.
  const [focusMessage] = useUrlState<string>("m", "");
  const focused = React.useRef<string | null>(null);
  React.useEffect(() => {
    if (!focusMessage || !q.data || focused.current === focusMessage) return;
    const el = document.getElementById(`msg-${focusMessage}`);
    if (!el) return;
    let t: ReturnType<typeof setTimeout> | undefined;
    const frame = requestAnimationFrame(() => {
      focused.current = focusMessage;
      el.scrollIntoView({ block: "center" });
      setFlash(focusMessage);
      t = setTimeout(() => setFlash(null), 1600);
    });
    return () => {
      cancelAnimationFrame(frame);
      if (t) clearTimeout(t);
    };
  }, [focusMessage, q.data]);

  const firstScroll = React.useRef(true);
  const seenLast = React.useRef<string | undefined>(undefined);
  React.useEffect(() => {
    const el = scroller.current;
    if (!el || !count) return;
    if (!firstScroll.current && lastId === seenLast.current) return; // only older messages were added
    seenLast.current = lastId;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 160;
    if (firstScroll.current || nearBottom || lastAuthor === viewer?.employee.empId) {
      el.scrollTo({ top: el.scrollHeight, behavior: firstScroll.current ? "auto" : "smooth" });
      firstScroll.current = false;
    }
  }, [lastId, count, lastAuthor, viewer]);

  if (q.isPending)
    return (
      <section className="flex flex-1 flex-col">
        <ListSkeleton rows={6} className="p-6" />
      </section>
    );
  if (q.isError)
    return (
      <section className="flex flex-1 flex-col p-6">
        <BackLink />
        {q.error instanceof ApiError && q.error.status === 404 ? (
          // Not a member: behave as if the conversation doesn't exist.
          <EmptyState className="flex-1 border-0" icon={<SearchX />} title="Conversation not found" description="It doesn't exist, or you're not a member of it." />
        ) : (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        )}
      </section>
    );

  const { conversation: c, messages, canPin, hasMoreBefore } = q.data;
  const archived = !!c.archived;
  const savedIds = new Set((savedQ.data ?? []).map((s) => s.message.id));
  const name = title(c);
  const other = lookup.employee(dmOther(c, viewer?.employee.empId));
  const otherDisabled = c.kind === "dm" && other?.status === "left";
  const p = presenceOf(other?.empId);
  const subtitle =
    c.kind === "dm"
      ? otherDisabled
        ? "Account disabled"
        : p?.state === "online"
          ? `Online · ${other?.designation ?? ""}`
          : other?.designation
      : `${archived ? "Archived · read only · " : ""}${c.memberEmpIds.length} members${c.topic ? ` · ${c.topic}` : ""}`;

  const removeAsModerator = async (m: Message) => {
    const reason = await askReason({
      title: "Remove this message?",
      description: "Everyone here will see “Removed by a moderator”. Your reason is kept in the audit log; the message text is never copied there.",
      confirmLabel: "Remove",
      destructive: true,
      placeholder: "Why it is removed (at least 5 characters)",
    });
    if (!reason) return;
    try {
      await moderate.mutateAsync({ id: m.id, reason });
      toast.success("Message removed");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't remove it.");
    }
  };

  const actions: MessageActions = {
    onReply: (m) => setPanel({ kind: "thread", id: m.id }),
    onDelete: setDeleting,
    onLinkTask: c.can?.post === false ? undefined : setLinking,
    onModeratorRemove: c.can?.removeMessages ? removeAsModerator : undefined,
    readOnly: archived,
  };

  const jump = (msgId: string) => {
    document.getElementById(`msg-${msgId}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    setFlash(msgId);
    setTimeout(() => setFlash(null), 1600);
    if (!wide) setPanel(null);
  };

  const panelBody =
    panel?.kind === "thread" ? (
      <ThreadPanel parentId={panel.id} conversation={c} title={name} savedIds={savedIds} canPin={canPin && !archived} actions={actions} onClose={() => setPanel(null)} />
    ) : panel?.kind === "details" ? (
      <DetailsPanel conversation={c} messages={messages} title={name} onClose={() => setPanel(null)} onJump={jump} />
    ) : null;

  if (c.managingOnly) {
    return (
      <>
        <section className="flex min-w-0 flex-1 flex-col" aria-label={name}>
          <header className="flex items-center gap-3 border-b border-border px-3 py-2.5 sm:px-4">
            <ConversationAvatar c={c} size={34} />
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-[15px] font-semibold">{name}</h2>
              <p className="truncate text-[12px] text-muted-foreground">{subtitle}</p>
            </div>
          </header>
          <EmptyState
            className="m-6 flex-1 border-0"
            icon={<ShieldCheck />}
            title="You manage this channel"
            description="You are not a member, so its messages stay private to you. You can change its name, topic, members and moderators, or archive it."
            action={<Button onClick={() => setPanel({ kind: "details" })}>Open details</Button>}
          />
        </section>
        {panelBody && wide && <aside className="flex w-80 shrink-0 flex-col border-l border-border">{panelBody}</aside>}
        {panelBody && !wide && (
          <Sheet open onOpenChange={(o) => !o && setPanel(null)}>
            <SheetContent size="md" hideClose className="p-0">
              <SheetTitle className="sr-only">Details</SheetTitle>
              {panelBody}
            </SheetContent>
          </Sheet>
        )}
      </>
    );
  }

  const older = async () => {
    const el = scroller.current;
    const before = el ? el.scrollHeight - el.scrollTop : 0;
    try {
      await loadOlder.mutateAsync();
      // Keep the same messages in view after the older ones are added above them.
      requestAnimationFrame(() => {
        if (el) el.scrollTop = el.scrollHeight - before;
      });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't load older messages.");
    }
  };

  return (
    <>
      <section className="flex min-w-0 flex-1 flex-col" aria-label={name}>
        <header className="flex items-center gap-3 border-b border-border px-3 py-2.5 sm:px-4">
          <Button size="icon-sm" variant="ghost" asChild className="md:hidden">
            <Link href="/messages" aria-label="Back to conversations">
              <ArrowLeft />
            </Link>
          </Button>
          <ConversationAvatar c={c} size={34} />
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-[15px] font-semibold">{name}</h2>
            <p className="truncate text-[12px] text-muted-foreground">{subtitle}</p>
          </div>
          {c.pinnedMessageIds.length > 0 && (
            <Tip content="Pinned messages">
              <Button size="sm" variant="ghost" onClick={() => setPanel({ kind: "details" })} className="hidden sm:inline-flex">
                <Pin /> {c.pinnedMessageIds.length}
              </Button>
            </Tip>
          )}
          <Tip content="Details, members and files">
            <Button size="icon-sm" variant={panel?.kind === "details" ? "secondary" : "ghost"} onClick={() => setPanel(panel?.kind === "details" ? null : { kind: "details" })} aria-label="Conversation details">
              <Info />
            </Button>
          </Tip>
        </header>

        <div ref={scroller} className="min-h-0 flex-1 overflow-y-auto pb-4 scrollbar-thin" role="log" aria-live="polite" aria-label={`Messages in ${name}`}>
          {hasMoreBefore && (
            <div className="flex justify-center pt-3">
              <Button size="sm" variant="outline" onClick={older} loading={loadOlder.isPending}>
                <History /> Load older messages
              </Button>
            </div>
          )}
          {messages.length === 0 && !hasMoreBefore ? (
            <EmptyState className="m-6 border-0" icon={<MessagesSquare />} title="No messages yet" description={c.kind === "dm" ? `Say hello to ${name}.` : "Start the conversation."} />
          ) : (
            groupByDay(messages).map((g) => (
              <div key={g.day}>
                <div className="pointer-events-none sticky top-0 z-[1] flex justify-center py-2">
                  <span className="rounded-full border border-border bg-card px-3 py-0.5 text-[11.5px] font-medium text-muted-foreground shadow-strata">{g.label}</span>
                </div>
                {g.items.map((m, i) => (
                  <div key={m.id} id={`msg-${m.id}`} className={cn("transition-colors duration-700", flash === m.id && "bg-signal/25")}>
                    <MessageItem
                      m={m}
                      kind={c.kind}
                      compact={isContinuation(g.items[i - 1], m)}
                      pinned={m.pinned ?? c.pinnedMessageIds.includes(m.id)}
                      saved={m.savedByMe ?? savedIds.has(m.id)}
                      canPin={canPin}
                      actions={actions}
                    />
                  </div>
                ))}
              </div>
            ))
          )}
        </div>

        {archived ? (
          <p className="flex items-center gap-2 border-t border-border bg-muted px-4 py-3 text-[13px] text-muted-foreground">
            <Archive className="size-4 shrink-0" /> This conversation is archived. Its history can be read; nothing can be sent or changed.
          </p>
        ) : (
          <Composer
            conversationId={c.id}
            memberEmpIds={c.memberEmpIds}
            placeholder={c.kind === "channel" ? `Message ${name}` : `Message ${c.kind === "dm" ? name.split(" ")[0] : name}`}
            disabled={otherDisabled}
            disabledReason="This person's account is disabled, so messages can't be delivered. The history stays."
          />
        )}
      </section>

      {panelBody && wide && <aside className="flex w-80 shrink-0 flex-col border-l border-border">{panelBody}</aside>}
      {panelBody && !wide && (
        <Sheet open onOpenChange={(o) => !o && setPanel(null)}>
          <SheetContent size="md" hideClose className="p-0">
            <SheetTitle className="sr-only">{panel?.kind === "thread" ? "Thread" : "Details"}</SheetTitle>
            {panelBody}
          </SheetContent>
        </Sheet>
      )}
      {deleting && <DeleteMessageDialog message={deleting} onClose={() => setDeleting(null)} />}
      {linking && <LinkTaskDialog message={linking} onClose={() => setLinking(null)} />}
    </>
  );
}

function BackLink() {
  return (
    <Link href="/messages" className="mb-3 inline-flex items-center gap-1 text-[13px] text-muted-foreground hover:text-foreground md:hidden">
      <ArrowLeft className="size-4" /> Conversations
    </Link>
  );
}

function SavedView({ onBack }: { onBack: () => void }) {
  const q = useSavedMessages();
  const title = useConversationTitle();
  const lookup = useLookup();
  return (
    <section className="flex min-w-0 flex-1 flex-col" aria-label="Saved messages">
      <header className="flex items-center gap-3 border-b border-border px-3 py-2.5 sm:px-4">
        <Button size="icon-sm" variant="ghost" className="md:hidden" onClick={onBack} aria-label="Back to conversations">
          <ArrowLeft />
        </Button>
        <span className="grid size-[34px] place-content-center rounded-lg bg-muted text-muted-foreground">
          <Bookmark className="size-4" />
        </span>
        <div>
          <h2 className="text-[15px] font-semibold">Saved messages</h2>
          <p className="text-[12px] text-muted-foreground">Only you can see what you saved.</p>
        </div>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto p-4 scrollbar-thin">
        {q.isPending ? (
          <ListSkeleton rows={4} />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : q.data.length === 0 ? (
          <EmptyState icon={<Bookmark />} title="Nothing saved yet" description="Use “Save for later” in a message's menu." />
        ) : (
          <ul className="grid gap-2">
            {q.data.map(({ message: m, conversation }) => {
              const a = lookup.employee(m.author);
              return (
                <li key={m.id}>
                  <Link href={`/messages/${conversation.id}`} className="block rounded-xl border border-border p-3 transition hover:bg-muted">
                    <p className="mb-1 flex flex-wrap items-center gap-x-2 text-[12px] text-muted-foreground">
                      <span className="font-medium text-foreground">{a?.name}</span> in {title(conversation as Conversation)} · {formatDateTime(m.at)}
                    </p>
                    <div className="line-clamp-3">
                      <MessageBody body={m.body || "Shared a file"} />
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </section>
  );
}
