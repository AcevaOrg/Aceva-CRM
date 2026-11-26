/**
 * Module 14 · Internal communication and team collaboration (plan §19)
 * Owner: Developer B (cycle 5). Spec §9.14.
 * This file is the API contract for the module.
 */
import type { Attachment } from "@/types";

export type ConversationKind = "dm" | "group" | "channel";

/** A shared file and its malware check: opened only once "clean"; "blocked" files can never be opened. */
export type CommsAttachment = Attachment & {
  scan: "clean" | "scanning" | "blocked";
  /** Live: uploaded but never sent within the grace period, so it was removed (it can no longer be sent or opened). */
  discarded?: boolean;
};

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
  /** Live (Module 14 API): the conversation's latest message number, and whether it is archived (read-only). */
  lastSeq?: number;
  archived?: boolean;
  /** Live: the viewer is not a member (a comms admin managing a channel): its messages are never shown. */
  managingOnly?: boolean;
  /** What the viewer may do here. Decided by the server (live) or the demo rules (mock); the server checks again. */
  can?: ConversationCan;
  /** How each member belongs: added by hand, or through the department (department members follow the employee records). */
  memberSources?: Record<string, "added" | "department">;
}

export interface ConversationCan {
  /** Rename and change the topic. */
  rename: boolean;
  manageMembers: boolean;
  /** The viewer can leave (only members added by hand; never a DM). */
  leave: boolean;
  /** Live only (the server's answer); the demo leaves these out. */
  post?: boolean;
  manageModerators?: boolean;
  archive?: boolean;
  /** Remove someone else's message, with a reason (moderators; comms admins in channels). */
  removeMessages?: boolean;
}

/** One search hit: the message and the conversation it is in (only conversations the viewer can see). */
export interface MessageSearchResult {
  message: Message;
  conversation: Pick<Conversation, "id" | "kind" | "name" | "memberEmpIds">;
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
  attachments: CommsAttachment[];
  /** DMs and groups: who has read it (excluding the author). */
  readBy: string[];
  /** Live, DMs and groups: who has received it on a screen (excluding the author; everyone who read it received it). */
  deliveredTo?: string[];
  /** Deleted by a moderator (with a reason, in the audit log) rather than by its author. */
  removedByModerator?: boolean;
  linkedTaskId?: string;
  linkedTaskNumber?: string;
  linkedTaskTitle?: string;
  /**
   * Live: a task is linked but this view does not say which (live updates are made for no one in particular, or the
   * viewer may not see that task). The screen asks the server what this person may see (GET /comms/messages/:id/link).
   */
  linkHidden?: boolean;
  /** Live (Module 14 API): the message's number in its conversation (no gaps), pinned, and saved by me. */
  seq?: number;
  pinned?: boolean;
  savedByMe?: boolean;
}

/** One open conversation as the screens hold it: the conversation and its loaded history (top-level messages). */
export interface MessagesData {
  conversation: Conversation;
  messages: Message[];
  canPin: boolean;
  /** Live: older messages exist before the loaded ones ("Load older messages"). */
  hasMoreBefore?: boolean;
  /** Live: the lowest message number loaded (replies included), where the next older page starts. */
  historyFrom?: number;
  /** Live: the person loaded older pages (a reload then keeps them). */
  olderLoaded?: boolean;
}

/**
 * Online or offline only (decision D8): no "away", no "last seen", nothing kept. Shown only to people who share a DM or a
 * group with the person, never in channels (D4), and never used as a score (plan section 19).
 */
export type PresenceState = "online" | "offline";

export interface Presence {
  empId: string;
  state: PresenceState;
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
  attachments: (Attachment & { scan?: CommsAttachment["scan"] })[];
  linkedTaskIds: string[];
  cancelled?: boolean;
  /** Live: the organizer may still add files (not cancelled). */
  canAddFiles?: boolean;
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
  /** Live: linked tasks this viewer may not see (Module 5's rule): counted, never named. */
  hiddenLinkedTasks?: number;
}

export interface NewConversationInput {
  kind: ConversationKind;
  memberEmpIds: string[];
  name?: string;
  topic?: string;
  departmentId?: string;
  projectId?: string;
  /** The project's name, for a project channel (the server stores the name and the code). */
  projectName?: string;
  moderatorEmpIds?: string[];
}

export interface SendMessageInput {
  conversationId: string;
  body: string;
  parentId?: string;
  attachments?: { fileName: string; sizeBytes: number; mimeType: string }[];
  /** Live: files already uploaded to this conversation (and checked), attached when the message is sent. */
  attachmentIds?: string[];
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
