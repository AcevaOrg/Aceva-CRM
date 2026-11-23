import { z } from 'zod';
import { empIdSchema } from './events';
import { decisionReasonSchema } from './shared';

/**
 * Module 14, part 1: conversations and messages (plan section 19).
 *
 * Direct messages (two people), groups, and department or project channels. Only members see a conversation: anyone else
 * gets "not found", including managers and administrators (plan: private conversations are not exposed to general
 * managers). Department channel members are the department's current employees and its head, plus people added by hand.
 *
 * Messages are plain text (at most 4,000 characters; never HTML: the screens show the text as text). Mentions are Emp-ID
 * tokens in the text, such as "@ACV-0006"; a mentioned person must be a member. Every message has a sequence number that
 * is unique in its conversation and has no gaps, so a screen can page through history and later catch up without missing
 * or repeating anything. A sender's clientKey makes a retried send safe.
 */

export const MESSAGE_MAX_LENGTH = 4000;
/** Authors may edit their own messages for 24 hours (deleting is allowed at any time). */
export const MESSAGE_EDIT_WINDOW_MS = 24 * 60 * 60 * 1000;
/** At most this many messages per person per minute (server-side limit). */
export const MESSAGE_RATE_LIMIT_PER_MINUTE = 30;
/** At most this many files on one message. */
export const COMMS_FILES_PER_MESSAGE = 5;
export const GROUP_MAX_MEMBERS = 50;

export const conversationKindSchema = z.enum(['dm', 'group', 'channel']);
export type ConversationKind = z.infer<typeof conversationKindSchema>;
export const channelScopeSchema = z.enum(['department', 'project']);
export type ChannelScope = z.infer<typeof channelScopeSchema>;
export const conversationRoleSchema = z.enum(['member', 'moderator']);
export type ConversationRole = z.infer<typeof conversationRoleSchema>;

/** "@ACV-0006" in a message mentions that person. */
export const MENTION_PATTERN = /@(ACV-\d{4,})(?!\d)/g;

/** The distinct Emp-IDs mentioned in a message text, in the order they first appear. */
export function mentionedEmpIds(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(MENTION_PATTERN)) seen.add(match[1]);
  return [...seen];
}

// Control characters other than tab and new line are refused (they have no place in plain text).
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

/** Plain text: Windows line endings become "\n"; not empty; at most 4,000 characters. */
export const messageBodySchema = z
  .string()
  .transform((v) => v.replace(/\r\n?/g, '\n'))
  .pipe(
    z
      .string()
      .max(MESSAGE_MAX_LENGTH, `A message can be at most ${MESSAGE_MAX_LENGTH} characters`)
      .refine((v) => v.trim().length > 0, 'A message cannot be empty')
      .refine((v) => !CONTROL_CHARACTERS.test(v), 'A message cannot contain control characters'),
  );

const name = z.string().trim().min(1, 'Required').max(80);
const topic = z.string().trim().max(300);
const empIdList = (max: number) =>
  z
    .array(empIdSchema)
    .max(max)
    .refine((v) => new Set(v).size === v.length, 'Each person only once');

/** A department, by its code (for example dep-eng), as everywhere else in the API. */
const departmentCode = z.string().trim().min(1).max(40);

export const createConversationSchema = z.discriminatedUnion('kind', [
  /** A DM with one colleague. Asking again returns the same conversation. */
  z.object({ kind: z.literal('dm'), empId: empIdSchema }),
  /** A group with chosen colleagues (the creator is added and becomes its moderator). */
  z.object({ kind: z.literal('group'), name: name.optional(), memberEmpIds: empIdList(GROUP_MAX_MEMBERS - 1).refine((v) => v.length >= 1, 'Choose at least one colleague') }),
  /**
   * A channel (comms.admin only). Department channel: its members follow the employee records. Project channel: a
   * free-text project name and code, members added by hand.
   */
  z
    .object({
      kind: z.literal('channel'),
      scope: channelScopeSchema,
      name,
      topic: topic.optional(),
      departmentId: departmentCode.optional(),
      projectName: z.string().trim().min(1).max(120).optional(),
      projectCode: z.string().trim().min(1).max(40).optional(),
      /** A Module 5 project (GET /projects): its name and code are used, and the channel is linked to it. */
      projectId: z.uuid().optional(),
      memberEmpIds: empIdList(500).default([]),
      moderatorEmpIds: empIdList(20).default([]),
    })
    .superRefine((v, ctx) => {
      if (v.scope === 'department') {
        if (!v.departmentId) ctx.addIssue({ code: 'custom', path: ['departmentId'], message: 'Choose the department' });
        if (v.projectName || v.projectCode || v.projectId) ctx.addIssue({ code: 'custom', path: ['projectName'], message: 'A department channel has no project' });
      } else {
        if (!v.projectName && !v.projectId) ctx.addIssue({ code: 'custom', path: ['projectName'], message: 'Choose the project or enter its name' });
        if (v.departmentId) ctx.addIssue({ code: 'custom', path: ['departmentId'], message: 'A project channel has no department' });
      }
    }),
]);
export type CreateConversationInput = z.infer<typeof createConversationSchema>;

export const updateConversationSchema = z
  .object({
    name: name.optional(),
    /** null clears the topic. */
    topic: topic.nullable().optional(),
    projectName: z.string().trim().min(1).max(120).optional(),
    projectCode: z.string().trim().min(1).max(40).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to change');
export type UpdateConversationInput = z.infer<typeof updateConversationSchema>;

export const addMembersSchema = z.object({ empIds: empIdList(50).refine((v) => v.length >= 1, 'Choose at least one person') });
export type AddMembersInput = z.infer<typeof addMembersSchema>;

export const archiveConversationSchema = z.object({ reason: decisionReasonSchema });

const cursorSchema = z.string().trim().min(1).max(200);
const limit = (max: number, fallback: number) => z.coerce.number().int().min(1).max(max).default(fallback);
const seqSchema = z.coerce.number().int().min(0).max(2_147_483_647);

export const conversationListQuerySchema = z.object({ cursor: cursorSchema.optional(), limit: limit(100, 50) });

/**
 * History, by sequence number. No cursor: the newest messages. before=N: the messages just before N (scrolling up).
 * after=N: the messages after N, oldest first (catching up). Deleted messages stay in the list as placeholders, so the
 * numbers have no holes.
 */
export const messageHistoryQuerySchema = z
  .object({ before: seqSchema.optional(), after: seqSchema.optional(), limit: limit(100, 50) })
  .refine((v) => v.before === undefined || v.after === undefined, 'Use before or after, not both');
export type MessageHistoryQuery = z.infer<typeof messageHistoryQuerySchema>;

export const threadQuerySchema = z.object({ after: seqSchema.optional(), limit: limit(100, 50) });

export const sendMessageSchema = z.object({
  /** Made by the sender's screen once per message; sending again with the same key never makes a second message. */
  clientKey: z.uuid(),
  body: messageBodySchema,
  /** A reply to a top-level message of the same conversation. */
  parentId: z.uuid().optional(),
  /** Files I uploaded to this conversation and have not attached yet (POST /comms/conversations/:id/files). */
  attachmentIds: z
    .array(z.uuid())
    .max(COMMS_FILES_PER_MESSAGE)
    .refine((v) => new Set(v).size === v.length, 'Each file only once')
    .optional(),
});
export type SendMessageInput = z.infer<typeof sendMessageSchema>;

export const editMessageSchema = z.object({ body: messageBodySchema });
export type EditMessageInput = z.infer<typeof editMessageSchema>;

/** A moderator removing someone else's message must say why (audited; the message text is never copied). */
export const removeMessageSchema = z.object({ reason: decisionReasonSchema });

/** One emoji (a short sequence of emoji characters, joiners and variation selectors). */
export const reactionEmojiSchema = z
  .string()
  .min(1)
  .max(16)
  .regex(/^(?:\p{Extended_Pictographic}|\p{Emoji_Component}|‍|️)+$/u, 'Choose an emoji')
  .refine((v) => /\p{Extended_Pictographic}|\p{Regional_Indicator}/u.test(v), 'Choose an emoji');

/** Up to which message number this person has received or read the conversation. */
export const markSeqSchema = z.object({ seq: z.number().int().min(0).max(2_147_483_647) });

export const messageSearchQuerySchema = z.object({
  q: z.string().trim().min(2, 'Type at least 2 characters').max(200),
  conversationId: z.uuid().optional(),
  cursor: cursorSchema.optional(),
  limit: limit(50, 20),
});
export type MessageSearchQuery = z.infer<typeof messageSearchQuerySchema>;

export const savedMessagesQuerySchema = z.object({ cursor: cursorSchema.optional(), limit: limit(100, 50) });

// ---------- Files (plan section 19: type and size limits, malware scanning, private storage, checked downloads) ----------

/** At most 10 MB per file, the same limit as task files. */
export const COMMS_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** Uploads per person (every accepted upload counts, also ones later blocked or never sent): `429 rate_limited`. */
export const COMMS_UPLOADS_PER_MINUTE = 10;
export const COMMS_UPLOADS_PER_HOUR = 60;
/** A file uploaded to a conversation but never sent is discarded (its bytes removed) after this many hours. */
export const COMMS_UNSENT_FILE_GRACE_HOURS = 24;
/** What the server accepts, recognised from the file's first bytes (never from its name): PDF, PNG, JPEG and Word (.docx). */
export const COMMS_FILE_TYPES = ['application/pdf', 'image/png', 'image/jpeg', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'] as const;

/**
 * A shared file. `scan`: "scanning" until ClamAV has checked it (it cannot be opened yet), "clean" (it can be downloaded
 * by the people who may see it), or "blocked" (malware was found; the file was removed and can never be opened).
 */
export interface CommsFileView {
  id: string;
  fileName: string;
  mimeType: string;
  sizeBytes: number;
  scan: 'scanning' | 'clean' | 'blocked';
  uploaderEmpId: string;
  uploadedAt: string;
  /** Uploaded but never sent within the grace period: its bytes were removed (it can no longer be sent or opened). */
  discarded: boolean;
}

// ---------- Responses ----------

export interface ConversationMemberView {
  empId: string;
  fullName: string;
  role: ConversationRole;
  /** added = a member row (added by hand or as the creator); department = a current employee or the head of the channel's department. */
  source: 'added' | 'department';
  /** False for someone who has left the company. */
  active: boolean;
}

export interface ConversationSummary {
  id: string;
  kind: ConversationKind;
  scope: ChannelScope | null;
  name: string | null;
  topic: string | null;
  /** Department channels: the department code and name. */
  departmentId: string | null;
  departmentName: string | null;
  projectName: string | null;
  projectCode: string | null;
  /** Project channels linked to a Module 5 project. */
  projectId: string | null;
  /** DMs: the other person. */
  dmWith: { empId: string; fullName: string } | null;
  archived: boolean;
  lastSeq: number;
  lastMessageAt: string | null;
  /** Messages by other people after this person's read position (deleted ones not counted). */
  unread: number;
  myRole: ConversationRole;
  lastMessage: { seq: number; authorEmpId: string; preview: string; deleted: boolean } | null;
}

export interface ConversationDetail extends ConversationSummary {
  members: ConversationMemberView[];
  /** This person's own position. */
  readState: { lastDeliveredSeq: number; lastReadSeq: number };
  /** DMs and groups only: every member's position (channels show only your own unread count). */
  receipts: Array<{ empId: string; lastDeliveredSeq: number; lastReadSeq: number }> | null;
  pinnedMessageIds: string[];
  can: { post: boolean; rename: boolean; manageMembers: boolean; manageModerators: boolean; archive: boolean; pin: boolean; removeMessages: boolean; leave: boolean };
}

export interface MessageReactionView {
  emoji: string;
  empIds: string[];
  count: number;
}

export interface MessageView {
  id: string;
  conversationId: string;
  seq: number;
  authorEmpId: string;
  parentId: string | null;
  /** Plain text. Empty for a deleted message (the placeholder). */
  body: string;
  createdAt: string;
  editedAt: string | null;
  deleted: boolean;
  /** Who deleted it: the author, or a moderator who removed it. */
  deletedAs: 'author' | 'moderator' | null;
  replyCount: number;
  lastReplyAt: string | null;
  reactions: MessageReactionView[];
  mentions: string[];
  pinned: boolean;
  savedByMe: boolean;
  /** DMs and groups only: which other members have received and read it (null in channels). */
  receipt: { deliveredTo: string[]; readBy: string[] } | null;
  /** Files shared with the message (none once it is deleted). */
  attachments: CommsFileView[];
  /**
   * The Module 5 task the message is linked to. null: no link. { task: null }: a task is linked but this viewer may not
   * see it (or the view was made for no one in particular: ask GET /comms/messages/:id/link), so nothing about it is told.
   */
  link: { task: LinkedTaskView | null } | null;
}

/** A Module 5 task as Module 14 shows it, only to people who may see that task. */
export interface LinkedTaskView {
  id: string;
  number: string;
  title: string;
  status: string;
}

/** Link a message (or a meeting) to a task, by its number (TSK-0001) or id. Never a personal to-do. */
export const linkTaskSchema = z.object({ task: z.string().trim().min(1).max(40) });

export interface MessagePage {
  items: MessageView[];
  /** There are older messages before the first one returned. */
  hasMoreBefore: boolean;
  /** There are newer messages after the last one returned. */
  hasMoreAfter: boolean;
  lastSeq: number;
}

export interface SendMessageResult {
  message: MessageView;
  /** False when this was a retry of a message already saved with the same clientKey. */
  created: boolean;
}

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

export interface MessageSearchHit {
  message: MessageView;
  conversation: { id: string; kind: ConversationKind; name: string | null; dmWith: { empId: string; fullName: string } | null };
}

export interface SavedMessageView {
  savedAt: string;
  message: MessageView;
  conversation: { id: string; kind: ConversationKind; name: string | null };
}

/** comms.admin: channel details for managing them (never their messages). */
export interface AdminChannelView {
  id: string;
  scope: ChannelScope;
  name: string;
  topic: string | null;
  departmentId: string | null;
  projectName: string | null;
  projectCode: string | null;
  archived: boolean;
  memberCount: number;
  moderatorEmpIds: string[];
}

// ---------- Announcements (plan section 19) ----------

/**
 * Who an announcement is for: everyone, or chosen departments (by code). The audience follows the CURRENT employee
 * records, like department channels: someone who joins one of those departments later sees it too.
 */
export const announcementAudienceSchema = z
  .object({
    all: z.boolean(),
    departmentIds: z
      .array(departmentCode)
      .max(20)
      .refine((v) => new Set(v).size === v.length, 'Each department only once')
      .default([]),
  })
  .refine((v) => v.all || v.departmentIds.length > 0, { path: ['departmentIds'], message: 'Choose at least one department, or send it to everyone' })
  .refine((v) => !v.all || v.departmentIds.length === 0, { path: ['departmentIds'], message: 'An announcement for everyone has no departments' });

/** announcements.publish: a new announcement. What was announced never changes afterwards; only its pin can. */
export const publishAnnouncementSchema = z.object({
  title: z.string().trim().min(4, 'A short, clear title').max(150),
  body: z.string().trim().min(10, 'Write at least a sentence').max(5000),
  audience: announcementAudienceSchema,
  pinned: z.boolean().default(false),
  requiresAck: z.boolean().default(false),
});
export type PublishAnnouncementInput = z.infer<typeof publishAnnouncementSchema>;

export const announcementListQuerySchema = z.object({ cursor: cursorSchema.optional(), limit: limit(100, 50) });

export interface AnnouncementView {
  id: string;
  title: string;
  body: string;
  authorEmpId: string;
  audience: { all: boolean; departmentIds: string[] };
  pinned: boolean;
  requiresAck: boolean;
  createdAt: string;
  /** The viewer is one of the people it is for (an author is not, unless the audience includes them). */
  inAudience: boolean;
  acknowledgedByMe: boolean;
  /**
   * Publishers only (the author and people with announcements.publish), for announcements that ask for
   * acknowledgement: everyone it is for now, and who of them has acknowledged. Null for everyone else.
   */
  progress: { audienceEmpIds: string[]; ackEmpIds: string[] } | null;
  can: { pin: boolean };
}

// ---------- Meetings (plan section 19) ----------

export const MEETING_MAX_PARTICIPANTS = 50;
export const meetingRsvpSchema = z.enum(['yes', 'no', 'maybe']);
export type MeetingRsvpAnswer = z.infer<typeof meetingRsvpSchema>;

const meetingTitle = z.string().trim().min(3, 'A short, clear title').max(150);
const meetingLocation = z.string().trim().min(2, 'Where, or which video link?').max(150);
const meetingAgenda = z.string().trim().max(5000);
const meetingDuration = z.number().int().min(5).max(480);

/** Anyone (comms.use) can organise a meeting with current colleagues. The organizer is not an invitee of their own meeting. */
export const createMeetingSchema = z.object({
  title: meetingTitle,
  startsAt: z.iso.datetime({ offset: true }),
  durationMin: meetingDuration,
  location: meetingLocation,
  agenda: meetingAgenda.default(''),
  participantEmpIds: empIdList(MEETING_MAX_PARTICIPANTS).refine((v) => v.length >= 1, 'Invite at least one person'),
});
export type CreateMeetingInput = z.infer<typeof createMeetingSchema>;

/** The organizer changes the meeting, or writes the notes (null clears them). */
export const updateMeetingSchema = z
  .object({
    title: meetingTitle.optional(),
    startsAt: z.iso.datetime({ offset: true }).optional(),
    durationMin: meetingDuration.optional(),
    location: meetingLocation.optional(),
    agenda: meetingAgenda.optional(),
    notes: z.string().max(20000).nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), 'Nothing to change');
export type UpdateMeetingInput = z.infer<typeof updateMeetingSchema>;

export const inviteToMeetingSchema = z.object({ empIds: empIdList(MEETING_MAX_PARTICIPANTS).refine((v) => v.length >= 1, 'Choose at least one person') });
export const meetingRsvpBodySchema = z.object({ rsvp: meetingRsvpSchema });
export const cancelMeetingSchema = z.object({ reason: decisionReasonSchema });
export const meetingListQuerySchema = z.object({
  /** From this moment (default: 30 days ago). */
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
});

export interface MeetingParticipantView {
  empId: string;
  fullName: string;
  rsvp: 'pending' | MeetingRsvpAnswer;
  respondedAt: string | null;
}

export interface MeetingView {
  id: string;
  title: string;
  startsAt: string;
  durationMin: number;
  location: string;
  agenda: string;
  notes: string | null;
  notesUpdatedAt: string | null;
  organizerEmpId: string;
  participants: MeetingParticipantView[];
  cancelled: boolean;
  cancelledAt: string | null;
  /** Files the organizer added (opened only once their malware check is clean). */
  attachments: CommsFileView[];
  /** Linked Module 5 tasks this viewer may see, and how many more are linked that they may not see. */
  linkedTasks: LinkedTaskView[];
  hiddenLinkedTasks: number;
  can: { edit: boolean; rsvp: boolean; cancel: boolean; invite: boolean; addFiles: boolean };
}

// ---------- Retention (plan section 19: "Define message and file retention periods with management before launch";
// "Admins can ... manage retention") ----------

/**
 * Module 14 settings (GET/PUT /settings/modules/comms, comms admins, "confirm again", audited with a reason). The periods
 * are management's decision: null means none has been set yet, and everything is kept. Automatic removal is not part of
 * this release (it waits for management's periods); the screens show the policy as set.
 */
export const commsSettingsSchema = z.object({
  messageRetentionDays: z.number().int().min(30).max(3650).nullable(),
  fileRetentionDays: z.number().int().min(30).max(3650).nullable(),
});
export type CommsSettings = z.infer<typeof commsSettingsSchema>;

/** GET /comms/policy: what everyone is told in conversation details. */
export interface CommsPolicyView {
  messageRetentionDays: number | null;
  fileRetentionDays: number | null;
  /** False in this release: nothing is removed automatically yet. */
  automaticRemoval: boolean;
}

// ---------- Security and audit events (plan section 19: "Admins can ... review security/audit events") ----------

export const commsAuditQuerySchema = z.object({
  /** One action (for example comms.file.blocked), or a group: messages, conversations, files, announcements, meetings, settings. */
  action: z.string().trim().min(1).max(80).optional(),
  outcome: z.enum(['success', 'denied']).optional(),
  from: z.iso.datetime({ offset: true }).optional(),
  to: z.iso.datetime({ offset: true }).optional(),
  cursor: cursorSchema.optional(),
  limit: limit(200, 50),
});
export type CommsAuditQuery = z.infer<typeof commsAuditQuerySchema>;

/**
 * comms.admin: one Module 14 audit record. Metadata only: ids, Emp-IDs, numbers, reasons typed for the audit and
 * scanner findings; never message text, file names, agendas or notes (those are never written to the audit log).
 */
export interface CommsAuditEventView {
  id: string;
  at: string;
  actorEmpId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  outcome: 'success' | 'denied';
  reason: string | null;
  details: Record<string, unknown> | null;
}
