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
  AdminChannelView, AnnouncementView, CommsAuditEventView, CommsFileView, CommsPolicyView, CommsSettings, ModuleSettingsView, ConversationDetail, MeetingView, ConversationSummary, CursorPage, LiveMessageView, MessagePage, MessageSearchHit, MessageView, SavedMessageView, SendMessageResult,
} from "@aceva/contracts";
import { ApiError } from "@/lib/api/mock";
import { http } from "@/lib/api/http";
import { useSession } from "@/lib/auth/session";
import { findEmployee } from "@/lib/directory";
import { conversationIndex, knownSeq, membersOf, messageIndex, names, noteSeq, presenceStore, rememberMessage } from "./live-store";
import type {
  AnnouncementWithStats, CommsAttachment, Conversation, Meeting, MeetingDetail, Message, MessageSearchResult, MessagesData, NewAnnouncementInput, NewConversationInput, NewMeetingInput,
  Presence, Rsvp, SendMessageInput,
} from "./types";

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
    attachments: (v.attachments ?? []).map(toAttachment),
    linkedTaskId: v.link?.task?.id,
    linkedTaskNumber: v.link?.task?.number,
    linkedTaskTitle: v.link?.task?.title,
    linkHidden: v.link ? !v.link.task : undefined,
    readBy: v.receipt?.readBy ?? [],
    deliveredTo: v.receipt?.deliveredTo ?? [],
    removedByModerator: v.deletedAs === "moderator" || undefined,
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
    scope: s.departmentId ? { departmentId: s.departmentId } : s.projectId || s.projectCode || s.projectName ? { projectId: s.projectId ?? s.projectCode ?? s.projectName ?? undefined } : undefined,
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
    can: detail
      ? {
          rename: detail.can.rename,
          manageMembers: detail.can.manageMembers,
          leave: detail.can.leave,
          post: detail.can.post,
          manageModerators: detail.can.manageModerators,
          archive: detail.can.archive,
          removeMessages: detail.can.removeMessages,
        }
      : undefined,
    managingOnly: detail ? s.kind === "channel" && !detail.members.some((m) => m.empId === me() && m.active) : undefined,
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

/**
 * The server's announcement as the screens use it. Publishers get the whole audience and who acknowledged; everyone else
 * only learns about themselves (the server sends nothing more), so the lists hold at most their own Emp-ID.
 */
const announcementPins = new Map<string, boolean>();
function toAnnouncement(v: AnnouncementView): AnnouncementWithStats {
  announcementPins.set(v.id, v.pinned);
  const mine = me();
  return {
    id: v.id,
    title: v.title,
    body: v.body,
    author: v.authorEmpId,
    audience: v.audience,
    pinned: v.pinned,
    requiresAck: v.requiresAck,
    at: v.createdAt,
    ackEmpIds: v.progress?.ackEmpIds ?? (v.acknowledgedByMe ? [mine] : []),
    audienceEmpIds: v.progress?.audienceEmpIds ?? (v.inAudience ? [mine] : []),
    acknowledgedByMe: v.acknowledgedByMe,
  };
}

/** A shared file as the screens use it. */
export function toAttachment(f: CommsFileView): CommsAttachment {
  return { id: f.id, fileName: f.fileName, sizeBytes: f.sizeBytes, mimeType: f.mimeType, uploadedAt: f.uploadedAt, uploadedBy: f.uploaderEmpId, scan: f.scan, discarded: f.discarded || undefined };
}

/** Saves a downloaded file (the bytes came through the API, which checked access first). */
function saveBlob(blob: Blob, fileName: string) {
  const href = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = href;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(href), 10_000);
}

/** The server's meeting as the screens use it. */
function toMeeting(v: MeetingView): Meeting {
  v.participants.forEach((p) => names.set(p.empId, p.fullName));
  return {
    id: v.id,
    title: v.title,
    start: v.startsAt,
    durationMin: v.durationMin,
    location: v.location,
    organizer: v.organizerEmpId,
    participants: v.participants.map((p) => ({ empId: p.empId, rsvp: p.rsvp })),
    agenda: v.agenda,
    notes: v.notes ?? undefined,
    notesUpdatedAt: v.notesUpdatedAt ?? undefined,
    attachments: v.attachments.map(toAttachment),
    linkedTaskIds: v.linkedTasks.map((t) => t.id),
    cancelled: v.cancelled || undefined,
    canAddFiles: v.can.addFiles,
  };
}

export const liveCommsApi = {
  /** GET /comms/conversations */
  conversations: async (): Promise<Conversation[]> => (await allConversations()).map((s) => toConversation(s)),

  /**
   * GET /comms/conversations/:id and its newest messages (top level; replies come from the thread). `keepFrom`: the
   * screen had already loaded older history down to that message number, so a reload brings back everything from there
   * (a reconnect never makes the older messages the person scrolled to disappear).
   */
  messages: async (id: string, keepFrom?: { seq: number; hasMoreBefore: boolean }): Promise<MessagesData> => {
    const detail = await http.getPassive<ConversationDetail>(`${API}/conversations/${id}`);
    const conversation = toConversation(detail, detail);
    // A comms admin managing a channel they are not in: its messages are never read.
    if (conversation.managingOnly) return { conversation, messages: [], canPin: false, hasMoreBefore: false, historyFrom: 0 };
    if (keepFrom) {
      const items = await messagesAfter(id, keepFrom.seq - 1);
      return { conversation, messages: items.filter((m) => !m.parentId).map((m) => toMessage(m)), canPin: detail.can.pin, hasMoreBefore: keepFrom.hasMoreBefore, historyFrom: keepFrom.seq };
    }
    const page = await http.getPassive<MessagePage>(`${API}/conversations/${id}/messages`, { limit: HISTORY_PAGE });
    knownSeq.set(id, Math.max(knownSeq.get(id) ?? 0, page.lastSeq));
    return {
      conversation,
      messages: page.items.filter((m) => !m.parentId).map((m) => toMessage(m)),
      canPin: detail.can.pin,
      hasMoreBefore: page.hasMoreBefore,
      historyFrom: page.items[0]?.seq ?? page.lastSeq + 1,
    };
  },

  /** GET /comms/conversations/:id/messages?before=N: the page of history just before message number N (scrolling up). */
  older: async (id: string, before: number): Promise<{ messages: Message[]; hasMoreBefore: boolean; historyFrom: number }> => {
    const page = await http.getPassive<MessagePage>(`${API}/conversations/${id}/messages`, { before, limit: HISTORY_PAGE });
    return { messages: page.items.filter((m) => !m.parentId).map((m) => toMessage(m)), hasMoreBefore: page.hasMoreBefore, historyFrom: page.items[0]?.seq ?? before };
  },

  /** GET /comms/conversations/:id/pins: every pinned message, also those older than the loaded history. */
  pins: async (id: string): Promise<Message[]> => {
    return (await http.getPassive<MessageView[]>(`${API}/conversations/${id}/pins`)).map((m) => toMessage(m));
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
    const res = await http.post<SendMessageResult>(`${API}/conversations/${input.conversationId}/messages`, {
      clientKey: uuid(),
      body: wireBody(input.body, input.conversationId),
      ...(input.parentId ? { parentId: input.parentId } : {}),
      ...(input.attachmentIds?.length ? { attachmentIds: input.attachmentIds } : {}),
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

  /** POST /comms/messages/:id/remove { reason }: a moderator removes someone else's message (audited; the text is never copied) */
  removeAsModerator: async (id: string, reason: string): Promise<void> => {
    toMessage(await http.post<MessageView>(`${API}/messages/${id}/remove`, { reason }));
  },

  /** PUT or DELETE /comms/messages/:id/pin (toggle) */
  togglePin: async (id: string): Promise<void> => {
    const pinned = current(id).pinned;
    toMessage(pinned ? await http.delete<MessageView>(`${API}/messages/${id}/pin`) : await http.put<MessageView>(`${API}/messages/${id}/pin`));
  },

  /** PUT /comms/messages/:id/task { task } (a Module 5 task I may see), or DELETE to remove the link */
  linkTask: async (id: string, taskId: string | null): Promise<void> => {
    toMessage(taskId ? await http.put<MessageView>(`${API}/messages/${id}/task`, { task: taskId }) : await http.delete<MessageView>(`${API}/messages/${id}/task`));
  },

  /** GET /comms/messages/:id/link: the linked task as I may see it ({ task: null }: one I may not open) */
  messageLink: async (id: string): Promise<{ id: string; number: string; title: string } | null> => {
    const res = await http.getPassive<{ task: { id: string; number: string; title: string } | null } | null>(`${API}/messages/${id}/link`);
    return res?.task ?? null;
  },

  /** POST /comms/conversations — returns the conversation id */
  create: async (input: NewConversationInput): Promise<string> => {
    let body: Record<string, unknown>;
    if (input.kind === "channel") {
      const name = (input.name ?? "").trim().toLowerCase().replace(/\s+/g, "-");
      const common = { kind: "channel", name, ...(input.topic ? { topic: input.topic } : {}), moderatorEmpIds: input.moderatorEmpIds ?? [] };
      if (input.departmentId) body = { ...common, scope: "department", departmentId: input.departmentId, memberEmpIds: [] };
      // A Module 5 project (from GET /projects): the server takes its name and code and links the channel to it.
      else if (input.projectId) body = { ...common, scope: "project", projectId: input.projectId, memberEmpIds: input.memberEmpIds };
      // Plan section 19: channels belong to a department or a project (there are no free-standing channels).
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

  /** PATCH /comms/conversations/:id { topic }: null clears it (the same people who may rename) */
  setTopic: async (id: string, topic: string | null): Promise<void> => {
    await http.patch(`${API}/conversations/${id}`, { topic: topic && topic.trim() ? topic.trim() : null });
  },

  /** PUT or DELETE /comms/conversations/:id/moderators/:empId (channels: comms admins; groups: their moderators) */
  setModerator: async (id: string, empId: string, moderator: boolean): Promise<void> => {
    const path = `${API}/conversations/${id}/moderators/${empId}`;
    await (moderator ? http.put(path) : http.delete(path));
  },

  /** POST /comms/conversations/:id/archive { reason }: read-only from then on (channels: comms admins; groups: moderators) */
  archive: async (id: string, reason: string): Promise<void> => {
    await http.post(`${API}/conversations/${id}/archive`, { reason });
  },

  /** GET /comms/admin/audit (comms.admin): Module 14 security and audit events, newest first (metadata only) */
  auditEvents: async (filter: { action?: string; outcome?: "success" | "denied"; cursor?: string }): Promise<CursorPage<CommsAuditEventView>> =>
    http.getPassive<CursorPage<CommsAuditEventView>>(`${API}/admin/audit`, { limit: 50, action: filter.action || undefined, outcome: filter.outcome, cursor: filter.cursor }),

  /** GET /comms/admin/channels (comms.admin): every channel with its members and moderators, never its messages */
  adminChannels: async (): Promise<AdminChannelView[]> => {
    const out: AdminChannelView[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 20; i++) {
      const page: CursorPage<AdminChannelView> = await http.getPassive(`${API}/admin/channels`, { limit: 100, cursor: cursor ?? undefined });
      out.push(...page.items);
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return out;
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

  /** GET /comms/announcements: the ones for me (all of them for oversight), pinned first */
  announcements: async (): Promise<AnnouncementWithStats[]> => {
    const out: AnnouncementWithStats[] = [];
    let cursor: string | null = null;
    for (let i = 0; i < 10; i++) {
      const page: CursorPage<AnnouncementView> = await http.getPassive(`${API}/announcements`, { limit: 100, cursor: cursor ?? undefined });
      out.push(...page.items.map(toAnnouncement));
      cursor = page.nextCursor;
      if (!cursor) break;
    }
    return out;
  },

  /** POST /comms/announcements/:id/ack ("I've read this") */
  acknowledge: async (id: string): Promise<void> => {
    toAnnouncement(await http.post<AnnouncementView>(`${API}/announcements/${id}/ack`));
  },

  /** POST /comms/announcements (announcements.publish) */
  publish: async (input: NewAnnouncementInput): Promise<AnnouncementWithStats> =>
    toAnnouncement(
      await http.post<AnnouncementView>(`${API}/announcements`, {
        title: input.title,
        body: input.body,
        audience: input.audience.all ? { all: true, departmentIds: [] } : { all: false, departmentIds: input.audience.departmentIds },
        pinned: input.pinned,
        requiresAck: input.requiresAck,
      }),
    ),

  /** PUT or DELETE /comms/announcements/:id/pin (toggle; announcements.publish) */
  togglePinAnnouncement: async (id: string): Promise<void> => {
    const path = `${API}/announcements/${id}/pin`;
    toAnnouncement(announcementPins.get(id) ? await http.delete<AnnouncementView>(path) : await http.put<AnnouncementView>(path));
  },

  /** GET /comms/meetings: mine (organised or invited), from 30 days ago, soonest first */
  meetings: async (): Promise<Meeting[]> => (await http.getPassive<MeetingView[]>(`${API}/meetings`)).map(toMeeting),

  /** GET /comms/meetings/:id (only for the organizer and the people invited) */
  meeting: async (id: string): Promise<MeetingDetail> => {
    const v = await http.getPassive<MeetingView>(`${API}/meetings/${id}`);
    return { meeting: toMeeting(v), linkedTasks: v.linkedTasks.map((t) => ({ id: t.id, number: t.number, title: t.title, status: t.status })), hiddenLinkedTasks: v.hiddenLinkedTasks };
  },

  /** POST /comms/meetings/:id/tasks { task } (the organizer; a task they may see, never a personal to-do) */
  linkMeetingTask: async (meetingId: string, taskId: string): Promise<void> => {
    await http.post(`${API}/meetings/${meetingId}/tasks`, { task: taskId });
  },

  /** DELETE /comms/meetings/:id/tasks/:taskId */
  unlinkMeetingTask: async (meetingId: string, taskId: string): Promise<void> => {
    await http.delete(`${API}/meetings/${meetingId}/tasks/${taskId}`);
  },

  /** POST /comms/meetings */
  createMeeting: async (input: NewMeetingInput): Promise<Meeting> => {
    if (input.attachments.length) throw new ApiError("validation", "Add files after the meeting is created.");
    const created = await http.post<MeetingView>(`${API}/meetings`, {
      title: input.title,
      startsAt: input.start,
      durationMin: input.durationMin,
      location: input.location,
      agenda: input.agenda,
      participantEmpIds: input.participants,
    });
    // The tasks chosen in the form are linked right after (each one the organizer may see; the server checks).
    let latest = created;
    for (const taskId of input.linkedTaskIds) latest = await http.post<MeetingView>(`${API}/meetings/${created.id}/tasks`, { task: taskId });
    return toMeeting(latest);
  },

  /** PUT /comms/meetings/:id/rsvp { rsvp } */
  rsvp: async (id: string, rsvp: Rsvp): Promise<void> => {
    if (rsvp === "pending") return;
    await http.put(`${API}/meetings/${id}/rsvp`, { rsvp });
  },

  /** PATCH /comms/meetings/:id { notes } (the organizer) */
  saveNotes: async (id: string, notes: string): Promise<void> => {
    await http.patch(`${API}/meetings/${id}`, { notes: notes.trim() ? notes : null });
  },

  /** POST /comms/meetings/:id/cancel { reason } (the organizer) */
  cancelMeeting: async (id: string, reason: string): Promise<void> => {
    await http.post(`${API}/meetings/${id}/cancel`, { reason });
  },

  /** POST /comms/conversations/:id/files: uploaded and checked for malware at once (or "scanning" while the scanner is busy) */
  uploadFile: async (conversationId: string, file: File): Promise<CommsAttachment> => {
    const form = new FormData();
    form.append("file", file);
    return toAttachment(await http.upload<CommsFileView>(`${API}/conversations/${conversationId}/files`, form));
  },

  /** POST /comms/meetings/:id/files (the organizer) */
  uploadMeetingFile: async (meetingId: string, file: File): Promise<CommsAttachment> => {
    const form = new FormData();
    form.append("file", file);
    return toAttachment(await http.upload<CommsFileView>(`${API}/meetings/${meetingId}/files`, form));
  },

  /** GET /comms/files/:id: where its malware check is */
  fileStatus: async (id: string): Promise<CommsAttachment> => toAttachment(await http.getPassive<CommsFileView>(`${API}/files/${id}`)),

  /** GET /comms/files/:id/download: checked by the server every time; only clean files */
  downloadFile: async (id: string, fileName: string): Promise<void> => {
    saveBlob(await http.blob(`${API}/files/${id}/download`), fileName);
  },

  /** GET /comms/policy: the retention policy everyone is told */
  policy: async (): Promise<CommsPolicyView> => http.getPassive<CommsPolicyView>(`${API}/policy`),

  /** GET /settings/modules/comms (comms admins) */
  retentionSettings: async (): Promise<{ value: CommsSettings; version: number; updatedAt: string | null; updatedByEmpId: string | null }> => {
    const s = await http.get<ModuleSettingsView>("/settings/modules/comms");
    return { value: s.value as unknown as CommsSettings, version: s.version, updatedAt: s.updatedAt, updatedByEmpId: s.updatedByEmpId };
  },

  /** PUT /settings/modules/comms (comms admins, after "confirm again"; the reason is audited) */
  saveRetention: async (value: CommsSettings, version: number, reason: string): Promise<void> => {
    await http.put("/settings/modules/comms", { value, version, reason });
  },

  /** Online / offline of the people I share a DM or group with, as the live connection reports it (never polled). */
  presence: async (): Promise<Presence[]> => presenceStore.online().map((empId) => ({ empId, state: "online" as const })),
};
