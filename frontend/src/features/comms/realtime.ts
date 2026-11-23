"use client";
/**
 * Module 14 live delivery in the browser (decisions D1 to D8).
 *
 * One WebSocket per tab to the API server (/socket.io, WebSocket only). The HttpOnly session cookie signs it in; the
 * socket never makes the session last longer. REST still makes every change; the socket only says what was saved:
 *  - new messages are added to the open screens and acknowledged (that records "delivered"; no REST call);
 *  - edits, deletions, reactions and pins replace the message (an older edit never overwrites a newer one);
 *  - every message has a number with no gaps: a jump means something was missed, so the screen catches up from the
 *    REST history (`?after=N`, a passive read). After every (re)connection, and when the server says the relay was
 *    interrupted, every open conversation catches up the same way. The database is always the truth;
 *  - a copy of a message already shown (same number) is dropped;
 *  - online/offline of the people I share a DM or group with; nothing about presence is stored;
 *  - when the session ends anywhere (logout, timeout, another device, an admin), the server closes the socket at once
 *    and this tab goes to the login screen.
 */
import type { QueryClient } from "@tanstack/react-query";
import { io, type Socket } from "socket.io-client";
import {
  REALTIME_PATH,
  type ClientToServerEvents,
  type ConversationChangedEvent,
  type MessageCreatedEvent,
  type MessageUpdatedEvent,
  type ReceiptEvent,
  type ServerToClientEvents,
  type SyncReply,
} from "@aceva/contracts";
import { apiOrigin } from "@/lib/api/http";
import { useSession } from "@/lib/auth/session";
import { liveCommsApi, messagesAfter, toMessage } from "./live-api";
import { knownSeq, noteSeq, presenceStore, resetLiveStore } from "./live-store";
import type { Conversation, Message, MessagesData } from "./types";

/**
 * A reload of an open conversation from the database. When the person had scrolled up and loaded older history, the
 * reload starts from there, so those messages stay on the screen (current, not as they were before the break).
 */
function reloadKeepingHistory(qc: QueryClient, id: string): Promise<MessagesData> {
  const data = qc.getQueryData<MessagesData>(keys.messages(id));
  const loadedOlder = data?.historyFrom !== undefined && data.olderLoaded;
  return liveCommsApi.messages(id, loadedOlder ? { seq: data.historyFrom!, hasMoreBefore: !!data.hasMoreBefore } : undefined);
}
type ThreadData = { parent: Message; replies: Message[] };
type CommsSocket = Socket<ServerToClientEvents, ClientToServerEvents>;

/** The same query keys as hooks.ts (kept here to avoid an import cycle). */
const keys = {
  conversations: (empId: string | null) => ["comms", "conversations", empId] as const,
  messages: (id: string) => ["comms", "messages", id] as const,
  thread: (id: string) => ["comms", "thread", id] as const,
  saved: (empId: string | null) => ["comms", "saved", empId] as const,
};

/** Refusals after which reconnecting is pointless until the person logs in again. */
const FINAL = new Set(["unauthenticated", "auth_incomplete", "forbidden", "origin_not_allowed"]);

const bySeq = (a: Message, b: Message) => (a.seq ?? 0) - (b.seq ?? 0) || a.at.localeCompare(b.at);

class CommsRealtime {
  private socket: CommsSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | null = null;
  private attempt = 0;
  private listTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private connectedBefore = false;
  /**
   * Conversations this person can no longer see (removed, left, moved out of the department). A reload that started
   * before the removal must not put one back on the screen; they are forgotten again when access returns.
   */
  private readonly lost = new Set<string>();
  private catchingUp = new Map<string, Promise<void>>();

  constructor(
    private readonly qc: QueryClient,
    private readonly empId: string,
  ) {}

  start(): void {
    this.stopped = false;
    const socket: CommsSocket = io(apiOrigin(), {
      path: REALTIME_PATH,
      transports: ["websocket"],
      withCredentials: true,
      // Transport drops (server restart, network) reconnect by themselves, spread out so a restart is not a stampede.
      reconnection: true,
      reconnectionDelay: 1_000,
      reconnectionDelayMax: 30_000,
      randomizationFactor: 0.5,
    });
    this.socket = socket;

    socket.on("connect", () => {
      this.attempt = 0;
      void this.resync();
    });
    socket.on("connect_error", (error: Error & { data?: { code?: string } }) => {
      const code = error.data?.code;
      if (!code) return; // a transport error: the manager retries by itself
      // A refusal by the server: the client does not retry on its own.
      // The session is gone (ended elsewhere while this tab was reconnecting): leave, exactly like a REST 401 would.
      if (code === "unauthenticated") return this.sessionEnded();
      if (FINAL.has(code)) return;
      this.scheduleRetry();
    });
    socket.on("presence.snapshot", (e) => presenceStore.replace(e.online));
    socket.on("presence", (e) => presenceStore.set(e.empId, e.online));
    socket.on("message.created", (e, ack) => {
      this.onCreated(e);
      ack({ ok: true }); // shown on this screen: "delivered"
    });
    socket.on("message.updated", (e) => this.onUpdated(e));
    socket.on("receipt.updated", (e) => this.onReceipt(e));
    socket.on("conversation.changed", (e) => this.onConversationChanged(e));
    socket.on("conversation.removed", (e) => this.onConversationRemoved(e.conversationId));
    socket.on("sync.required", () => void this.resync());
    socket.on("session.ended", () => this.sessionEnded());
    socket.on("closing", (e) => this.onClosing(e.reason));
    socket.on("disconnect", () => presenceStore.clear());
  }

  stop(): void {
    this.stopped = true;
    if (this.retry) clearTimeout(this.retry);
    if (this.listTimer) clearTimeout(this.listTimer);
    this.socket?.removeAllListeners();
    this.socket?.disconnect();
    this.socket = null;
    resetLiveStore();
  }

  private scheduleRetry(): void {
    if (this.stopped || this.retry) return;
    const base = Math.min(30_000, 1_000 * 2 ** Math.min(this.attempt++, 5));
    const delay = base / 2 + Math.random() * base; // jitter
    this.retry = setTimeout(() => {
      this.retry = null;
      if (!this.stopped) this.socket?.connect();
    }, delay);
  }

  private sessionEnded(): void {
    this.stop();
    useSession.getState().signOutLocal();
    window.location.assign("/login?expired=1");
  }

  // ---------------- catching up ----------------

  /**
   * After a (re)connection or a relay interruption. The first connection only catches up on new messages. After a
   * break, anything may have been missed (new messages, but also edits, deletions, reactions and pins), so everything
   * this tab shows is reloaded from the database (passive reads): the open conversations, threads and saved messages.
   */
  private async resync(): Promise<void> {
    const socket = this.socket;
    if (!socket) return;
    const afterBreak = this.connectedBefore;
    this.connectedBefore = true;
    try {
      const reply = (await socket.timeout(10_000).emitWithAck("sync")) as SyncReply | { error: string };
      if ("error" in reply) return;
      if (afterBreak) await this.reloadShown();
      else
        for (const c of reply.conversations) {
          const known = knownSeq.get(c.id);
          if (known !== undefined && c.lastSeq > known && this.qc.getQueryData(keys.messages(c.id))) void this.catchUp(c.id);
        }
    } catch {
      // no answer: the next connection tries again
    }
    this.refreshList();
  }

  /** Reloads every conversation, thread and saved list this tab holds, from the database (the truth). */
  private async reloadShown(): Promise<void> {
    const cache = this.qc.getQueryCache();
    const jobs: Array<Promise<unknown>> = [];
    for (const q of cache.findAll({ queryKey: ["comms", "messages"] })) {
      const id = q.queryKey[2] as string;
      if (!id || !q.state.data) continue;
      if (this.lost.has(id)) continue;
      jobs.push(
        reloadKeepingHistory(this.qc, id).then(
          (fresh) => {
            if (!this.lost.has(id)) this.qc.setQueryData(keys.messages(id), fresh);
          },
          () => this.onConversationRemoved(id),
        ),
      );
    }
    for (const q of cache.findAll({ queryKey: ["comms", "thread"] })) {
      const id = q.queryKey[2] as string;
      if (!id || !q.state.data) continue;
      jobs.push(liveCommsApi.thread(id).then((fresh) => this.qc.setQueryData(keys.thread(id), fresh), () => this.qc.removeQueries({ queryKey: keys.thread(id) })));
    }
    if (this.qc.getQueryData(keys.saved(this.empId))) {
      jobs.push(liveCommsApi.saved().then((fresh) => this.qc.setQueryData(keys.saved(this.empId), fresh), () => undefined));
    }
    await Promise.all(jobs);
  }

  /** Loads everything after the last known number (passive reads) and merges it in, without duplicates. */
  private catchUp(conversationId: string): Promise<void> {
    const running = this.catchingUp.get(conversationId);
    if (running) return running;
    const from = knownSeq.get(conversationId) ?? 0;
    const job = messagesAfter(conversationId, from)
      .then((views) => {
        if (this.lost.has(conversationId)) return;
        for (const v of views) this.merge(toMessage(v));
      })
      .catch(() => undefined)
      .finally(() => this.catchingUp.delete(conversationId));
    this.catchingUp.set(conversationId, job);
    return job;
  }

  /** The conversation list (unread counts, previews) is refreshed with a passive read, at most every half second. */
  private refreshList(): void {
    if (this.listTimer) return;
    this.listTimer = setTimeout(async () => {
      this.listTimer = null;
      try {
        this.qc.setQueryData(keys.conversations(this.empId), await liveCommsApi.conversations());
      } catch {
        // the screen keeps what it has
      }
    }, 500);
  }

  // ---------------- applying events ----------------

  private onCreated(e: MessageCreatedEvent): void {
    const known = knownSeq.get(e.conversationId);
    const message = toMessage(e.message);
    this.merge(message);
    // A gap in the numbers: something was missed (a lost broadcast). Catch up from the database.
    if (known !== undefined && e.seq > known + 1 && this.qc.getQueryData(keys.messages(e.conversationId))) void this.catchUp(e.conversationId);
    else noteSeq(e.conversationId, e.seq);
    this.refreshList();
  }

  private onUpdated(e: MessageUpdatedEvent): void {
    this.merge(toMessage(e.message, e.revision), true);
    this.refreshList();
  }

  /** Adds a new message, or replaces the one with the same id (a duplicate is the same message: nothing changes). */
  private merge(m: Message, updateOnly = false): void {
    if (this.lost.has(m.conversationId)) return; // no longer this person's conversation
    // Live updates never name a linked task (they are made for no one in particular): the screen asks again.
    if (m.linkHidden) void this.qc.invalidateQueries({ queryKey: ["comms", "link", m.id] });
    // Pinned or unpinned (a deleted message is also unpinned): the conversation's pin list, which the header's pin count
    // and the details panel show, follows at once.
    if (m.pinned !== undefined) {
      this.qc.setQueryData<MessagesData>(keys.messages(m.conversationId), (data) => {
        if (!data) return data;
        const has = data.conversation.pinnedMessageIds.includes(m.id);
        if (has === m.pinned) return data;
        const pinnedMessageIds = m.pinned ? [...data.conversation.pinnedMessageIds, m.id] : data.conversation.pinnedMessageIds.filter((x) => x !== m.id);
        return { ...data, conversation: { ...data.conversation, pinnedMessageIds } };
      });
    }
    if (!m.parentId) {
      this.qc.setQueryData<MessagesData>(keys.messages(m.conversationId), (data) => {
        if (!data) return data;
        const at = data.messages.findIndex((x) => x.id === m.id);
        if (at >= 0) {
          const messages = [...data.messages];
          messages[at] = { ...m, savedByMe: m.savedByMe ?? messages[at].savedByMe };
          return { ...data, messages };
        }
        if (updateOnly) return data;
        return { ...data, messages: [...data.messages, m].sort(bySeq) };
      });
    } else {
      this.qc.setQueryData<ThreadData>(keys.thread(m.parentId), (data) => {
        if (!data) return data;
        const at = data.replies.findIndex((x) => x.id === m.id);
        if (at >= 0) {
          const replies = [...data.replies];
          replies[at] = m;
          return { ...data, replies };
        }
        if (updateOnly) return data;
        return { ...data, replies: [...data.replies, m].sort(bySeq) };
      });
      // The parent's reply count arrives as an update of the parent (the server sends one with every reply).
    }
    // The thread's first message is the same message as in the list.
    if (!m.parentId) this.qc.setQueryData<ThreadData>(keys.thread(m.id), (data) => (data ? { ...data, parent: m } : data));
    this.qc.setQueryData<Array<{ message: Message; conversation: Conversation }>>(keys.saved(this.empId), (list) =>
      list ? list.map((s) => (s.message.id === m.id ? { ...s, message: { ...m, savedByMe: true } } : s)) : list,
    );
  }

  private onReceipt(e: ReceiptEvent): void {
    if (e.empId === this.empId) {
      this.refreshList(); // my own unread count
      return;
    }
    this.qc.setQueryData<MessagesData>(keys.messages(e.conversationId), (data) => {
      if (!data || data.conversation.kind === "channel") return data;
      return {
        ...data,
        // Per message: received (delivered) and read, each moving forward only.
        messages: data.messages.map((m) => {
          if (m.author === e.empId) return m;
          const seq = m.seq ?? Infinity;
          const read = seq <= e.lastReadSeq && !m.readBy.includes(e.empId);
          const delivered = seq <= Math.max(e.lastDeliveredSeq, e.lastReadSeq) && !(m.deliveredTo ?? []).includes(e.empId);
          if (!read && !delivered) return m;
          return { ...m, readBy: read ? [...m.readBy, e.empId] : m.readBy, deliveredTo: delivered ? [...(m.deliveredTo ?? []), e.empId] : m.deliveredTo };
        }),
      };
    });
  }

  private async onConversationChanged(e: ConversationChangedEvent): Promise<void> {
    const id = e.conversationId;
    this.refreshList();
    if (this.lost.delete(id)) {
      // Access came back (added again, moved back into the department): an open screen shows it again.
      void this.qc.resetQueries({ queryKey: keys.messages(id) });
      return;
    }
    if (!this.qc.getQueryData(keys.messages(id))) return;
    try {
      const fresh = await reloadKeepingHistory(this.qc, id);
      // Removed while this was loading: do not put it back on the screen.
      if (!this.lost.has(id)) this.qc.setQueryData<MessagesData>(keys.messages(id), fresh);
    } catch {
      // gone: the "removed" event follows
    }
  }

  /**
   * This person can no longer see the conversation. An open screen must not keep showing it: the query is reset, so the
   * screen asks the server again and shows its answer ("not found"). Threads and saved messages follow.
   */
  private onConversationRemoved(conversationId: string): void {
    this.lost.add(conversationId);
    knownSeq.delete(conversationId);
    void this.qc.resetQueries({ queryKey: keys.messages(conversationId) });
    void this.qc.resetQueries({ queryKey: ["comms", "thread"] });
    void this.qc.invalidateQueries({ queryKey: keys.saved(this.empId) });
    this.refreshList();
  }

  /** The server closed the connection. Losing the permission to use messaging: every messaging screen asks the server again. */
  private onClosing(reason: string): void {
    if (reason === "forbidden") {
      this.stop();
      void this.qc.resetQueries({ queryKey: ["comms"] });
      return;
    }
    // Too many events or an unknown event: connect again after a pause (the server does not reconnect for us).
    this.scheduleRetry();
  }
}

let current: CommsRealtime | null = null;

/** Opens this tab's live connection for the signed-in person (one at a time). Returns the function that closes it. */
export function startCommsRealtime(qc: QueryClient, empId: string): () => void {
  current?.stop();
  const rt = new CommsRealtime(qc, empId);
  current = rt;
  rt.start();
  return () => {
    rt.stop();
    if (current === rt) current = null;
  };
}

// ---------------- reading only while someone is there ----------------

let lastInput = typeof window === "undefined" ? 0 : Date.now();
let listening = false;
const waiting = new Set<() => void>();

function installInputListener() {
  if (listening || typeof window === "undefined") return;
  listening = true;
  const mark = () => {
    lastInput = Date.now();
    const run = [...waiting];
    waiting.clear();
    run.forEach((fn) => fn());
  };
  for (const e of ["pointerdown", "keydown", "wheel", "touchstart", "focus"] as const) window.addEventListener(e, mark, { passive: true });
}

/**
 * Runs `fn` now if the person is here (the tab is visible and they used it in the last minute), otherwise at their next
 * input. Used for "mark as read": a message that arrives on an unattended screen is not read, and marking it would count
 * as activity and keep an idle session alive. Returns a cancel function.
 */
export function whenPersonIsHere(fn: () => void): () => void {
  installInputListener();
  const here = typeof document !== "undefined" && document.visibilityState === "visible" && Date.now() - lastInput < 60_000;
  if (here) {
    fn();
    return () => undefined;
  }
  waiting.add(fn);
  return () => waiting.delete(fn);
}
