/**
 * Module 14 service functions. Mock today; each JSDoc names the real endpoint (spec §7.3).
 * People only see conversations they belong to (plan §19).
 */
import { tasksTable } from "@/features/tasks/api";
import { ApiError, mock, notFound } from "@/lib/api/mock";
import { getViewer } from "@/lib/auth/viewer";
import { employeesTable, findEmployee } from "@/lib/directory";
import { uid } from "@/lib/utils";
import { table } from "@/mocks/db";
import {
  seedAnnouncements, seedConversations, seedMeetings, seedMessages, seedPresence, seedReads, type ConversationRecord, type MessageRecord,
} from "@/mocks/seed/comms";
import { parseMentions } from "./logic";
import type {
  Announcement, AnnouncementWithStats, Conversation, LinkedTaskRef, Meeting, MeetingDetail, Message, NewAnnouncementInput,
  NewConversationInput, NewMeetingInput, Presence, Rsvp, SendMessageInput,
} from "./types";

const convs = () => table<ConversationRecord>("comms.conversations", seedConversations);
const msgs = () => table<MessageRecord>("comms.messages", seedMessages);
const reads = () => table<{ conversationId: string; empId: string; at: string }>("comms.reads", () => seedReads(convs()));
const presenceTable = () => table<Presence>("comms.presence", seedPresence);
const savedTable = () => table<{ empId: string; messageId: string }>("comms.saved", () => [{ empId: "ACV-0007", messageId: "m_eng_1" }, { empId: "ACV-0006", messageId: "m_gl_1" }]);
const announcementsTable = () => table<Announcement>("comms.announcements", seedAnnouncements);
const meetingsTable = () => table<Meeting>("comms.meetings", seedMeetings);

const me = () => getViewer().employee.empId;
const isActive = (empId: string) => findEmployee(empId)?.status !== "left";

function lastRead(convId: string, empId: string) {
  return reads().find((r) => r.conversationId === convId && r.empId === empId)?.at ?? "1970-01-01T00:00:00.000Z";
}

function setRead(convId: string, empId: string) {
  const r = reads().find((x) => x.conversationId === convId && x.empId === empId);
  const now = new Date().toISOString();
  if (r) r.at = now;
  else reads().push({ conversationId: convId, empId, at: now });
}

function memberConv(id: string) {
  const c = convs().find((x) => x.id === id);
  // Not a member → behave as if it doesn't exist.
  if (!c || !c.memberEmpIds.includes(me())) notFound("Conversation");
  return c;
}

function taskRef(taskId?: string) {
  const t = taskId ? tasksTable().find((x) => x.id === taskId) : undefined;
  return t ? { linkedTaskNumber: t.number, linkedTaskTitle: t.title } : {};
}

function toMessage(m: MessageRecord, conv: ConversationRecord): Message {
  const replies = msgs().filter((r) => r.parentId === m.id);
  const readBy = conv.kind === "channel" ? [] : conv.memberEmpIds.filter((p) => p !== m.author && lastRead(conv.id, p) >= m.at);
  return { ...m, ...taskRef(m.linkedTaskId), replyCount: replies.length, lastReplyAt: replies[replies.length - 1]?.at, readBy };
}

function toConversation(c: ConversationRecord, viewer: string): Conversation {
  const list = msgs().filter((m) => m.conversationId === c.id && !m.parentId);
  const last = list[list.length - 1];
  const seen = lastRead(c.id, viewer);
  const unread = msgs().filter((m) => m.conversationId === c.id && m.author !== viewer && m.at > seen && !m.deleted).length;
  return {
    ...c,
    unread,
    lastMessageAt: last?.at ?? c.createdAt,
    lastMessagePreview: last ? (last.deleted ? "Message deleted" : `${findEmployee(last.author)?.name.split(" ")[0] ?? ""}: ${last.body || (last.attachments.length ? "Shared a file" : "")}`) : undefined,
  };
}

/* Scripted replies so DMs feel alive in the demo (mock only). */
const REPLIES = ["Thanks, got it 👍", "Sounds good. I'll take a look in a few minutes.", "Sure, let's do that.", "Noted, thank you!"];
const replied = new Set<string>();

function scheduleReply(conv: ConversationRecord, from: string) {
  if (conv.kind !== "dm" || replied.has(conv.id)) return;
  const other = conv.memberEmpIds.find((p) => p !== from);
  const online = presenceTable().find((p) => p.empId === other)?.state === "online";
  if (!other || !online || !isActive(other)) return;
  replied.add(conv.id);
  setTimeout(() => {
    msgs().push({ id: uid("msg"), conversationId: conv.id, author: other, body: REPLIES[conv.id.length % REPLIES.length], at: new Date().toISOString(), reactions: [], mentions: [], attachments: [] });
    setRead(conv.id, other);
  }, 3500);
}

function canPin(c: ConversationRecord) {
  const v = getViewer();
  return c.kind !== "channel" || c.moderatorEmpIds.includes(v.employee.empId) || v.employee.level <= 4 || v.can("comms.admin");
}

export const commsApi = {
  /** GET /conversations */
  conversations: () =>
    mock(() => {
      const viewer = me();
      return convs()
        .filter((c) => c.memberEmpIds.includes(viewer))
        .map((c) => toConversation(c, viewer))
        .sort((a, b) => b.lastMessageAt.localeCompare(a.lastMessageAt));
    }, { delay: 120 }),

  /** GET /conversations/:id/messages (top level; replies come from the thread endpoint) */
  messages: (id: string) =>
    mock(() => {
      const c = memberConv(id);
      const list = msgs()
        .filter((m) => m.conversationId === id && !m.parentId)
        .sort((a, b) => a.at.localeCompare(b.at))
        .map((m) => toMessage(m, c));
      return { conversation: toConversation(c, me()), messages: list, canPin: canPin(c) };
    }, { delay: 120 }),

  /** GET /messages/:id/thread */
  thread: (messageId: string) =>
    mock(() => {
      const parent = msgs().find((m) => m.id === messageId);
      if (!parent) notFound("Message");
      const c = memberConv(parent.conversationId);
      return {
        parent: toMessage(parent, c),
        replies: msgs()
          .filter((m) => m.parentId === messageId)
          .sort((a, b) => a.at.localeCompare(b.at))
          .map((m) => toMessage(m, c)),
      };
    }, { delay: 100 }),

  /** POST /conversations/:id/read */
  markRead: (id: string) => mock(() => setRead(id, me()), { delay: 40 }),

  /** POST /conversations/:id/messages */
  send: (input: SendMessageInput) =>
    mock(() => {
      const c = memberConv(input.conversationId);
      const author = me();
      if (!input.body.trim() && !input.attachments?.length) throw new ApiError("validation", "Write a message or attach a file.");
      const dmOther = c.kind === "dm" ? c.memberEmpIds.find((p) => p !== author) : undefined;
      if (dmOther && !isActive(dmOther)) throw new ApiError("forbidden", "This account is disabled. Messages can't be delivered.", 403);
      const m: MessageRecord = {
        id: uid("msg"),
        conversationId: c.id,
        author,
        body: input.body.trim(),
        at: new Date().toISOString(),
        parentId: input.parentId,
        reactions: [],
        mentions: parseMentions(input.body, employeesTable().filter((e) => c.memberEmpIds.includes(e.empId))),
        attachments: (input.attachments ?? []).map((a) => ({ ...a, id: uid("att"), uploadedAt: new Date().toISOString(), uploadedBy: author, scan: "clean" as const })),
      };
      msgs().push(m);
      setRead(c.id, author);
      scheduleReply(c, author);
      return toMessage(m, c);
    }, { delay: 150 }),

  /** PATCH /messages/:id (own only) */
  edit: (id: string, body: string) =>
    mock(() => {
      const m = msgs().find((x) => x.id === id);
      if (!m) notFound("Message");
      if (m.author !== me()) throw new ApiError("forbidden", "You can only edit your own messages.", 403);
      m.body = body.trim();
      m.editedAt = new Date().toISOString();
    }),

  /** DELETE /messages/:id (own only; a stub and an audit record stay) */
  remove: (id: string) =>
    mock(() => {
      const m = msgs().find((x) => x.id === id);
      if (!m) notFound("Message");
      if (m.author !== me()) throw new ApiError("forbidden", "You can only delete your own messages.", 403);
      m.deleted = true;
      m.body = "";
      m.attachments = [];
      m.reactions = [];
    }),

  /** POST /messages/:id/reactions { emoji } (toggle) */
  react: (id: string, emoji: string) =>
    mock(() => {
      const m = msgs().find((x) => x.id === id);
      if (!m) notFound("Message");
      const viewer = me();
      const r = m.reactions.find((x) => x.emoji === emoji);
      if (!r) m.reactions.push({ emoji, empIds: [viewer] });
      else if (r.empIds.includes(viewer)) {
        r.empIds = r.empIds.filter((p) => p !== viewer);
        if (!r.empIds.length) m.reactions = m.reactions.filter((x) => x !== r);
      } else r.empIds.push(viewer);
    }, { delay: 60 }),

  /** POST /messages/:id/save (toggle) */
  toggleSave: (id: string) =>
    mock(() => {
      const list = savedTable();
      const i = list.findIndex((s) => s.empId === me() && s.messageId === id);
      if (i >= 0) list.splice(i, 1);
      else list.push({ empId: me(), messageId: id });
      return i < 0;
    }, { delay: 60 }),

  /** GET /messages/saved */
  saved: () =>
    mock(() => {
      const viewer = me();
      const ids = savedTable().filter((s) => s.empId === viewer).map((s) => s.messageId);
      return msgs()
        .filter((m) => ids.includes(m.id))
        .map((m) => {
          const c = convs().find((x) => x.id === m.conversationId)!;
          return c.memberEmpIds.includes(viewer) ? { message: toMessage(m, c), conversation: toConversation(c, viewer) } : null;
        })
        .filter((x): x is NonNullable<typeof x> => !!x)
        .sort((a, b) => b.message.at.localeCompare(a.message.at));
    }),

  /** POST /messages/:id/pin (toggle) */
  togglePin: (id: string) =>
    mock(() => {
      const m = msgs().find((x) => x.id === id);
      if (!m) notFound("Message");
      const c = memberConv(m.conversationId);
      if (!canPin(c)) throw new ApiError("forbidden", "Only channel moderators and leads can pin in channels.", 403);
      c.pinnedMessageIds = c.pinnedMessageIds.includes(id) ? c.pinnedMessageIds.filter((x) => x !== id) : [...c.pinnedMessageIds, id];
    }, { delay: 60 }),

  /** PATCH /messages/:id { linkedTaskId } */
  linkTask: (id: string, taskId: string | null) =>
    mock(() => {
      const m = msgs().find((x) => x.id === id);
      if (!m) notFound("Message");
      m.linkedTaskId = taskId ?? undefined;
    }),

  /** POST /conversations */
  create: (input: NewConversationInput) =>
    mock(() => {
      const v = getViewer();
      const viewer = v.employee.empId;
      const members = Array.from(new Set([viewer, ...input.memberEmpIds])).filter(isActive);
      if (input.kind === "channel") {
        if (!(v.can("comms.admin") || v.employee.level <= 4)) throw new ApiError("forbidden", "Only admins and leads can create channels.", 403);
        if (!input.name?.trim()) throw new ApiError("validation", "Give the channel a name.");
      }
      if (members.length < 2) throw new ApiError("validation", "Choose at least one other person.");
      const kind = input.kind === "channel" ? "channel" : members.length === 2 ? "dm" : "group";
      if (kind === "dm") {
        const existing = convs().find((c) => c.kind === "dm" && c.memberEmpIds.length === 2 && members.every((p) => c.memberEmpIds.includes(p)));
        if (existing) return existing.id;
      }
      const c: ConversationRecord = {
        id: uid(kind === "channel" ? "ch" : kind),
        kind,
        name: kind === "dm" ? undefined : input.name?.trim().toLowerCase().replace(/\s+/g, kind === "channel" ? "-" : " ") || members.map((p) => findEmployee(p)?.name.split(" ")[0]).join(", "),
        topic: input.topic?.trim() || undefined,
        scope: input.departmentId || input.projectId ? { departmentId: input.departmentId || undefined, projectId: input.projectId || undefined } : undefined,
        memberEmpIds: members,
        moderatorEmpIds: kind === "channel" ? Array.from(new Set([viewer, ...(input.moderatorEmpIds ?? [])])) : [],
        createdBy: viewer,
        createdAt: new Date().toISOString(),
        pinnedMessageIds: [],
      };
      convs().push(c);
      members.forEach((p) => reads().push({ conversationId: c.id, empId: p, at: new Date().toISOString() }));
      return c.id;
    }),

  /** GET /presence (shown according to company policy; never used as a score) */
  presence: () =>
    mock(() => {
      const viewer = me();
      return presenceTable().map((p) => (p.empId === viewer ? { ...p, state: "online" as const, lastSeenAt: new Date().toISOString() } : p));
    }, { delay: 60 }),

  /* ---------------- Announcements ---------------- */

  /** GET /announcements */
  announcements: () =>
    mock<AnnouncementWithStats[]>(() => {
      const v = getViewer();
      const viewer = v.employee.empId;
      const active = employeesTable().filter((e) => e.status !== "left");
      return announcementsTable()
        .map((a) => {
          const audienceEmpIds = active.filter((e) => a.audience.all || a.audience.departmentIds.includes(e.departmentId)).map((e) => e.empId);
          return { ...a, audienceEmpIds, acknowledgedByMe: a.ackEmpIds.includes(viewer) };
        })
        .filter((a) => a.audienceEmpIds.includes(viewer) || a.author === viewer || v.can("announcements.publish"))
        .sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.at.localeCompare(a.at));
    }),

  /** POST /announcements/:id/ack */
  acknowledge: (id: string) =>
    mock(() => {
      const a = announcementsTable().find((x) => x.id === id);
      if (!a) notFound("Announcement");
      if (!a.ackEmpIds.includes(me())) a.ackEmpIds.push(me());
    }),

  /** POST /announcements */
  publish: (input: NewAnnouncementInput) =>
    mock(() => {
      if (!getViewer().can("announcements.publish")) throw new ApiError("forbidden", "You can't publish announcements.", 403);
      if (!input.audience.all && !input.audience.departmentIds.length) throw new ApiError("validation", "Choose who should see it.");
      const a: Announcement = { ...input, id: uid("an"), author: me(), ackEmpIds: [], at: new Date().toISOString() };
      announcementsTable().unshift(a);
      return a;
    }),

  /** PATCH /announcements/:id { pinned } */
  togglePinAnnouncement: (id: string) =>
    mock(() => {
      const a = announcementsTable().find((x) => x.id === id);
      if (!a) notFound("Announcement");
      if (!getViewer().can("announcements.publish")) throw new ApiError("forbidden", "Only publishers can pin announcements.", 403);
      a.pinned = !a.pinned;
    }),

  /* ---------------- Meetings ---------------- */

  /** GET /meetings */
  meetings: () =>
    mock(() => {
      const viewer = me();
      return meetingsTable()
        .filter((m) => m.organizer === viewer || m.participants.some((p) => p.empId === viewer))
        .sort((a, b) => a.start.localeCompare(b.start));
    }),

  /** GET /meetings/:id */
  meeting: (id: string) =>
    mock<MeetingDetail>(() => {
      const viewer = me();
      const m = meetingsTable().find((x) => x.id === id);
      if (!m || !(m.organizer === viewer || m.participants.some((p) => p.empId === viewer))) notFound("Meeting");
      const linkedTasks: LinkedTaskRef[] = m.linkedTaskIds
        .map((tid) => tasksTable().find((t) => t.id === tid))
        .filter((t): t is NonNullable<typeof t> => !!t)
        .map((t) => ({ id: t.id, number: t.number, title: t.title, status: t.status }));
      return { meeting: m, linkedTasks };
    }),

  /** POST /meetings */
  createMeeting: (input: NewMeetingInput) =>
    mock(() => {
      const viewer = me();
      if (new Date(input.start).getTime() < Date.now() - 60_000) throw new ApiError("validation", "Pick a time in the future.");
      const m: Meeting = {
        id: uid("mtg"),
        title: input.title,
        start: input.start,
        durationMin: input.durationMin,
        location: input.location,
        organizer: viewer,
        participants: input.participants.filter((p) => p !== viewer).map((empId) => ({ empId, rsvp: "pending" as Rsvp })),
        agenda: input.agenda,
        attachments: input.attachments.map((a) => ({ ...a, id: uid("ma"), uploadedAt: new Date().toISOString(), uploadedBy: viewer })),
        linkedTaskIds: input.linkedTaskIds,
      };
      meetingsTable().push(m);
      return m;
    }),

  /** POST /meetings/:id/rsvp { rsvp } */
  rsvp: (id: string, rsvp: Rsvp) =>
    mock(() => {
      const p = meetingsTable().find((x) => x.id === id)?.participants.find((x) => x.empId === me());
      if (!p) notFound("Meeting");
      p.rsvp = rsvp;
    }, { delay: 80 }),

  /** PATCH /meetings/:id { notes } (organizer only) */
  saveNotes: (id: string, notes: string) =>
    mock(() => {
      const m = meetingsTable().find((x) => x.id === id);
      if (!m) notFound("Meeting");
      if (m.organizer !== me()) throw new ApiError("forbidden", "Only the organizer edits the notes.", 403);
      m.notes = notes;
      m.notesUpdatedAt = new Date().toISOString();
    }),

  /** POST /meetings/:id/cancel { reason } (organizer only) */
  cancelMeeting: (id: string) =>
    mock(() => {
      const m = meetingsTable().find((x) => x.id === id);
      if (!m) notFound("Meeting");
      if (m.organizer !== me()) throw new ApiError("forbidden", "Only the organizer can cancel.", 403);
      m.cancelled = true;
    }),
};
