/**
 * Module 14 · Internal communication and team collaboration (plan §19)
 * Owner: Developer B (cycle 5). Spec §9.14.
 * This file is the API contract for the module.
 */
import type { Attachment } from "@/types";

export type ConversationKind = "dm" | "group" | "channel";

export interface Conversation {
  id: string;
  kind: ConversationKind;
  /** Channels and groups have a name; DMs show the other person. */
  name?: string;
  topic?: string;
  scope?: { departmentId?: string; projectId?: string };
  memberEmpIds: string[];
  moderatorEmpIds: string[];
  createdBy: string;
  createdAt: string;
  pinnedMessageIds: string[];
  /** Per viewer, computed by the server. */
  unread: number;
  lastMessageAt: string;
  lastMessagePreview?: string;
}

export interface Reaction {
  emoji: string;
  empIds: string[];
}

export interface Message {
  id: string;
  conversationId: string;
  author: string;
  body: string;
  at: string;
  editedAt?: string;
  /** Deleted messages keep a stub and an audit record (plan §19). */
  deleted?: boolean;
  /** Reply in a thread: id of the parent message. */
  parentId?: string;
  replyCount: number;
  lastReplyAt?: string;
  reactions: Reaction[];
  mentions: string[];
  attachments: (Attachment & { scan: "clean" | "scanning" | "blocked" })[];
  /** DMs and groups: who has read it (excluding the author). */
  readBy: string[];
  linkedTaskId?: string;
  linkedTaskNumber?: string;
  linkedTaskTitle?: string;
}

export type PresenceState = "online" | "away" | "offline";

export interface Presence {
  empId: string;
  state: PresenceState;
  lastSeenAt: string;
}

export interface Announcement {
  id: string;
  title: string;
  body: string;
  author: string;
  audience: { all: boolean; departmentIds: string[] };
  pinned: boolean;
  requiresAck: boolean;
  ackEmpIds: string[];
  at: string;
}

export interface AnnouncementWithStats extends Announcement {
  audienceEmpIds: string[];
  acknowledgedByMe: boolean;
}

export type Rsvp = "yes" | "no" | "maybe" | "pending";

export interface Meeting {
  id: string;
  title: string;
  start: string;
  durationMin: number;
  location: string;
  organizer: string;
  participants: { empId: string; rsvp: Rsvp }[];
  agenda: string;
  notes?: string;
  notesUpdatedAt?: string;
  attachments: Attachment[];
  linkedTaskIds: string[];
  cancelled?: boolean;
}

export interface LinkedTaskRef {
  id: string;
  number: string;
  title: string;
  status: string;
}

export interface MeetingDetail {
  meeting: Meeting;
  linkedTasks: LinkedTaskRef[];
}

export interface NewConversationInput {
  kind: ConversationKind;
  memberEmpIds: string[];
  name?: string;
  topic?: string;
  departmentId?: string;
  projectId?: string;
  moderatorEmpIds?: string[];
}

export interface SendMessageInput {
  conversationId: string;
  body: string;
  parentId?: string;
  attachments?: { fileName: string; sizeBytes: number; mimeType: string }[];
}

export interface NewAnnouncementInput {
  title: string;
  body: string;
  audience: { all: boolean; departmentIds: string[] };
  pinned: boolean;
  requiresAck: boolean;
}

export interface NewMeetingInput {
  title: string;
  start: string;
  durationMin: number;
  location: string;
  participants: string[];
  agenda: string;
  attachments: { fileName: string; sizeBytes: number; mimeType: string }[];
  linkedTaskIds: string[];
}
