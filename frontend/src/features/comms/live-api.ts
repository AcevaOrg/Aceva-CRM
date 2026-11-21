/**
 * Module 14 against the REAL API (NEXT_PUBLIC_LIVE_MODULES contains m14): conversations and messages. Same function
 * names and result shapes as the mock in api.ts, so the screens keep working. The server decides everything: who may
 * see a conversation (anyone else gets "not found"), where each person's history starts, and what they may do there.
 *
 * Every read here is PASSIVE (http.getPassive): the session is checked but the read does not count as activity, so a
 * screen updating itself never keeps an idle session alive. Real activity is reported by the heartbeat. Changes
 * (send, edit, react...) are made by the person, so they count as usual.
 */
import type {
  ConversationDetail, ConversationSummary, CursorPage, LiveMessageView, MessagePage, MessageSearchHit, MessageView, SavedMessageView, SendMessageResult,
} from "@aceva/contracts";
import { ApiError } from "@/lib/api/mock";
import { http } from "@/lib/api/http";
import { useSession } from "@/lib/auth/session";
import { findEmployee } from "@/lib/directory";
import { conversationIndex, knownSeq, membersOf, messageIndex, names, noteSeq, presenceStore, rememberMessage } from "./live-store";
import type { Conversation, Message, MessageSearchResult, NewConversationInput, Presence, SendMessageInput } from "./types";

const API = "/comms";
const HISTORY_PAGE = 100;
const me = () => useSession.getState().empId ?? "";
const uuid = () => (typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now().toString(16)}-0000-4000-8000-${Math.random().toString(16).slice(2, 14).padEnd(12, "0")}`);
const EPOCH = "1970-01-01T00:00:00.000Z";

function nameOf(empId: string): string {
  return names.get(empId) ?? findEmployee(empId)?.name ?? empId;
}
const firstName = (empId: string) => nameOf(empId).split(" ")[0];

// ---------------- mentions: the server uses "@ACV-0006", the screens show "@Mariam" ----------------

/** "@ACV-0006" → "@Mariam" for display. */
export function displayBody(body: string): string {
  return body.replace(/@(ACV-\d{4,})(?!\d)/g, (token, empId: string) => (nameOf(empId) !== empId ? `@${firstName(empId)}` : token));
}

/** "@Mariam" → "@ACV-0006" when exactly one member of the conversation has that first name. */
export function wireBody(body: string, conversationId: string): string {
  const members = membersOf.get(conversationId) ?? [];
  return body.replace(/@([A-Za-z]+)\b/g, (token, word: string) => {
    const matches = members.filter((e) => firstName(e).toLowerCase() === word.toLowerCase());
    return matches.length === 1 ? `@${matches[0]}` : token;
  });
}

// ---------------- mapping ----------------

export function toMessage(v: MessageView | LiveMessageView, revision?: number): Message {
  rememberMessage(v, revision);
  const known = messageIndex.get(v.id);
  return {
    id: v.id,
    conversationId: v.conversationId,
    author: v.authorEmpId,
    body: displayBody(v.body),
    at: v.createdAt,
    editedAt: v.editedAt ?? undefined,
    deleted: v.deleted || undefined,
    parentId: v.parentId ?? undefined,
    replyCount: v.replyCount,
    lastReplyAt: v.lastReplyAt ?? undefined,
    reactions: v.reactions.map((r) => ({ emoji: r.emoji, empIds: r.empIds })),
    mentions: v.mentions,
    attachments: [],
    readBy: v.receipt?.readBy ?? [],
    seq: v.seq,
    pinned: v.pinned,
    savedByMe: "savedByMe" in v ? v.savedByMe : known?.savedByMe,
  };
}

export function toConversation(s: ConversationSummary, detail?: ConversationDetail): Conversation {
  conversationIndex.set(s.id, s);
  if (s.dmWith) names.set(s.dmWith.empId, s.dmWith.fullName);
  const members = detail ? detail.members.filter((m) => m.active).map((m) => m.empId) : s.dmWith ? [me(), s.dmWith.empId] : (membersOf.get(s.id) ?? []);
  if (detail) {
    detail.members.forEach((m) => names.set(m.empId, m.fullName));
    membersOf.set(s.id, members);
  }
  const last = s.lastMessage;
  return {
    id: s.id,
    kind: s.kind,
    name: s.name ?? undefined,
    topic: s.topic ?? undefined,
    scope: s.departmentId ? { departmentId: s.departmentId } : s.projectCode || s.projectName ? { projectId: s.projectCode ?? s.projectName ?? undefined } : undefined,
    memberEmpIds: members,
    moderatorEmpIds: detail ? detail.members.filter((m) => m.role === "moderator").map((m) => m.empId) : [],
    createdBy: "",
    createdAt: s.lastMessageAt ?? EPOCH,
    pinnedMessageIds: detail?.pinnedMessageIds ?? [],
    unread: s.unread,
    lastMessageAt: s.lastMessageAt ?? EPOCH,
    lastMessagePreview: last ? (last.deleted ? "Message deleted" : `${firstName(last.authorEmpId)}: ${displayBody(last.preview)}`) : undefined,
    lastSeq: s.lastSeq,
    archived: s.archived,
    can: detail ? { rename: detail.can.rename, manageMembers: detail.can.manageMembers, leave: detail.can.leave } : undefined,
    memberSources: detail ? Object.fromEntries(detail.members.filter((m) => m.active).map((m) => [m.empId, m.source])) : undefined,
  };
}

async function allConversations(): Promise<ConversationSummary[]> {
  const out: ConversationSummary[] = [];
  let cursor: string | null = null;
  for (let i = 0; i < 20; i++) {
    const page: CursorPage<ConversationSummary> = await http.getPassive(`${API}/conversations`, { limit: 100, cursor: cursor ?? undefined });
    out.push(...page.items);
    cursor = page.nextCursor;
    if (!cursor) break;
  }
  return out;
}

/** Everything after `after` in one conversation, oldest first (catching up after a reconnect or a gap). */
export async function messagesAfter(conversationId: string, after: number): Promise<MessageView[]> {
  const out: MessageView[] = [];
  let from = after;
  for (let i = 0; i < 50; i++) {
    const page: MessagePage = await http.getPassive(`${API}/conversations/${conversationId}/messages`, { after: from, limit: HISTORY_PAGE });
    out.push(...page.items);
    if (page.items.length) from = page.items[page.items.length - 1].seq;
    noteSeq(conversationId, Math.max(from, after));
    if (!page.hasMoreAfter) break;
  }
  return out;
}

function current(id: string) {
  const m = messageIndex.get(id);
  if (!m) throw new ApiError("not_found", "This message is no longer here. Refresh the conversation.", 404);
  return m;
}

export const liveCommsApi = {
  /** GET /comms/conversations */
  conversations: async (): Promise<Conversation[]> => (await allConversations()).map((s) => toConversation(s)),

  /** GET /comms/conversations/:id and its newest messages (top level; replies come from the thread) */
  messages: async (id: string): Promise<{ conversation: Conversation; messages: Message[]; canPin: boolean }> => {
    const [detail, page] = await Promise.all([
      http.getPassive<ConversationDetail>(`${API}/conversations/${id}`),
      http.getPassive<MessagePage>(`${API}/conversations/${id}/messages`, { limit: HISTORY_PAGE }),
    ]);
    knownSeq.set(id, Math.max(knownSeq.get(id) ?? 0, page.lastSeq));
    return {
      conversation: toConversation(detail, detail),
      messages: page.items.filter((m) => !m.parentId).map((m) => toMessage(m)),
      canPin: detail.can.pin,
    };
  },

  /** GET /comms/messages/:id/thread */
  thread: async (messageId: string): Promise<{ parent: Message; replies: Message[] }> => {
    const res = await http.getPassive<{ parent: MessageView; items: MessageView[] }>(`${API}/messages/${messageId}/thread`, { limit: 100 });
    return { parent: toMessage(res.parent), replies: res.items.map((m) => toMessage(m)) };
  },

  /** POST /comms/conversations/:id/read — up to the newest message this screen has */
  markRead: async (id: string): Promise<void> => {
    const seq = knownSeq.get(id);
    if (!seq) return;
    await http.post(`${API}/conversations/${id}/read`, { seq });
  },

  /** POST /comms/conversations/:id/messages (a retry key makes a resend safe) */
  send: async (input: SendMessageInput): Promise<Message> => {
    if (input.attachments?.length) throw new ApiError("validation", "Sharing files in messages is not available yet.");
    const res = await http.post<SendMessageResult>(`${API}/conversations/${input.conversationId}/messages`, {
      clientKey: uuid(),
      body: wireBody(input.body, input.conversationId),
      ...(input.parentId ? { parentId: input.parentId } : {}),
    });
    return toMessage(res.message);
  },

  /** PATCH /comms/messages/:id (own, within 24 hours) */
  edit: async (id: string, body: string): Promise<void> => {
    const res = await http.patch<MessageView>(`${API}/messages/${id}`, { body: wireBody(body, current(id).conversationId) });
    toMessage(res);
  },

  /** DELETE /comms/messages/:id (own; a placeholder stays) */
  remove: async (id: string): Promise<void> => {
    toMessage(await http.delete<MessageView>(`${API}/messages/${id}`));
  },

  /** PUT or DELETE /comms/messages/:id/reactions/:emoji (toggle) */
  react: async (id: string, emoji: string): Promise<void> => {
    const mine = current(id).reactions.find((r) => r.emoji === emoji)?.empIds.includes(me());
    const path = `${API}/messages/${id}/reactions/${encodeURIComponent(emoji)}`;
    toMessage(mine ? await http.delete<MessageView>(path) : await http.put<MessageView>(path));
  },

  /** PUT or DELETE /comms/messages/:id/save (toggle). Returns true when saved. */
  toggleSave: async (id: string): Promise<boolean> => {
    const saved = !!current(id).savedByMe;
    const res = saved ? await http.delete<MessageView>(`${API}/messages/${id}/save`) : await http.put<MessageView>(`${API}/messages/${id}/save`);
    toMessage(res);
    return res.savedByMe;
  },

  /** GET /comms/saved */
  saved: async (): Promise<Array<{ message: Message; conversation: Conversation }>> => {
    const page = await http.getPassive<CursorPage<SavedMessageView>>(`${API}/saved`, { limit: 100 });
    return page.items.map((s) => {
      const known = conversationIndex.get(s.conversation.id);
      const conversation: Conversation = known
        ? toConversation(known)
        : { id: s.conversation.id, kind: s.conversation.kind, name: s.conversation.name ?? undefined, memberEmpIds: [], moderatorEmpIds: [], createdBy: "", createdAt: EPOCH, pinnedMessageIds: [], unread: 0, lastMessageAt: EPOCH };
      return { message: toMessage(s.message), conversation };
    });
  },

  /** PUT or DELETE /comms/messages/:id/pin (toggle) */
  togglePin: async (id: string): Promise<void> => {
    const pinned = current(id).pinned;
    toMessage(pinned ? await http.delete<MessageView>(`${API}/messages/${id}/pin`) : await http.put<MessageView>(`${API}/messages/${id}/pin`));
  },

  /** Linking a message to a task comes with Module 5 (tasks). */
  linkTask: async (): Promise<void> => {
    throw new ApiError("not_available", "Linking messages to tasks is not available yet.", 501);
  },

  /** POST /comms/conversations — returns the conversation id */
  create: async (input: NewConversationInput): Promise<string> => {
    let body: Record<string, unknown>;
    if (input.kind === "channel") {
      const name = (input.name ?? "").trim().toLowerCase().replace(/\s+/g, "-");
      const common = { kind: "channel", name, ...(input.topic ? { topic: input.topic } : {}), moderatorEmpIds: input.moderatorEmpIds ?? [] };
      if (input.departmentId) body = { ...common, scope: "department", departmentId: input.departmentId, memberEmpIds: [] };
      else if (input.projectId) body = { ...common, scope: "project", projectName: input.projectName ?? input.projectId, projectCode: input.projectId.slice(0, 40), memberEmpIds: input.memberEmpIds };
      else throw new ApiError("validation", "Link the channel to a department or a project.");
    } else if (input.memberEmpIds.length === 1) {
      body = { kind: "dm", empId: input.memberEmpIds[0] };
    } else {
      body = { kind: "group", memberEmpIds: input.memberEmpIds, ...(input.name ? { name: input.name } : {}) };
    }
    const res = await http.post<{ conversation: ConversationDetail }>(`${API}/conversations`, body);
    toConversation(res.conversation, res.conversation);
    return res.conversation.id;
  },

  /** PATCH /comms/conversations/:id { name } — groups: their moderators; channels: moderators and comms admins */
  rename: async (id: string, name: string): Promise<void> => {
    await http.patch(`${API}/conversations/${id}`, { name: name.trim() });
  },

  /** POST /comms/conversations/:id/members { empIds } — history for them starts now (the server records where) */
  addMembers: async (id: string, empIds: string[]): Promise<void> => {
    await http.post(`${API}/conversations/${id}/members`, { empIds });
  },

  /** DELETE /comms/conversations/:id/members/:empId — remove someone, or leave with my own Emp-ID */
  removeMember: async (id: string, empId: string): Promise<void> => {
    await http.delete(`${API}/conversations/${id}/members/${empId}`);
  },

  /** GET /comms/search?q — message text, only in conversations I can see now and only from where my history starts */
  search: async (q: string): Promise<MessageSearchResult[]> => {
    const page = await http.getPassive<CursorPage<MessageSearchHit>>(`${API}/search`, { q, limit: 50 });
    return page.items.map((hit) => {
      if (hit.conversation.dmWith) names.set(hit.conversation.dmWith.empId, hit.conversation.dmWith.fullName);
      return {
        message: toMessage(hit.message),
        conversation: {
          id: hit.conversation.id,
          kind: hit.conversation.kind,
          name: hit.conversation.name ?? undefined,
          memberEmpIds: hit.conversation.dmWith ? [me(), hit.conversation.dmWith.empId] : (membersOf.get(hit.conversation.id) ?? []),
        },
      };
    });
  },

  /** Online / offline of the people I share a DM or group with, as the live connection reports it (never polled). */
  presence: async (): Promise<Presence[]> => presenceStore.online().map((empId) => ({ empId, state: "online" as const })),
};
