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
      memberEmpIds: empIdList(500).default([]),
      moderatorEmpIds: empIdList(20).default([]),
    })
    .superRefine((v, ctx) => {
      if (v.scope === 'department') {
        if (!v.departmentId) ctx.addIssue({ code: 'custom', path: ['departmentId'], message: 'Choose the department' });
        if (v.projectName || v.projectCode) ctx.addIssue({ code: 'custom', path: ['projectName'], message: 'A department channel has no project' });
      } else {
        if (!v.projectName) ctx.addIssue({ code: 'custom', path: ['projectName'], message: 'Enter the project name' });
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
}

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
