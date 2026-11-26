import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { OutboxEvent } from '@aceva/contracts';
import { OutboxConsumerRunner } from '../events/outbox-consumer-runner.service';
import { Prisma } from '../generated/prisma/client';
import { NotificationService } from '../notifications/notification.service';
import { AnnouncementService } from './announcement.service';
import { CommsAccessService } from './comms-access.service';

/** The reader's name in outbox_consumers. Never rename it (a new name would start reading from "now" again). */
export const COMMS_NOTIFICATIONS_CONSUMER = 'comms-notifications';

type Tx = Prisma.TransactionClient;
interface Conversation {
  id: string;
  kind: 'dm' | 'group' | 'channel';
  name: string | null;
}
interface Recipient {
  id: string;
  empId: string;
  departmentId: string;
}

/**
 * Module 14 notifications through the shared Module 12 core (plan section 19: "Notifications for new messages, mentions,
 * replies and announcements, with user controls for non-essential notifications"). None of these types is essential, so
 * each person can turn their emails off in the notification settings.
 *
 * PRIVACY: a notification never contains message text: only who wrote, and where. The link opens the conversation, where
 * the server checks access again.
 *
 * Who is told, and when:
 *  - a meeting invitation or cancellation: the people invited (never the organizer), with the time only;
 *  - an announcement (`comms.announcement.published`): everyone it is for, except its author;
 *  - a mention (`comms.mention`, sent for new mentions when a message is sent or edited): the person mentioned;
 *  - a reply (`comms.message.created` with a parent): the author of the message answered;
 *  - a new message in a DM or a group: every other member, ONE notification per conversation until they read it
 *    (dedupe key: the conversation and their read position), so a busy chat never floods anyone. Channels notify only
 *    mentions and replies.
 * Nobody is told about their own message, about a message they have already read (they saw it live), about a message that
 * was deleted in the meantime, or about a message outside what they may read now (no longer a member, or sent before
 * their history starts).
 */
@Injectable()
export class CommsNotificationsConsumer implements OnModuleInit {
  constructor(
    private readonly runner: OutboxConsumerRunner,
    private readonly notifications: NotificationService,
    private readonly access: CommsAccessService,
    private readonly announcements: AnnouncementService,
  ) {}

  onModuleInit(): void {
    this.runner.register({
      name: COMMS_NOTIFICATIONS_CONSUMER,
      types: ['comms.message.created', 'comms.mention', 'comms.announcement.published', 'comms.meeting.invited', 'comms.meeting.cancelled'],
      handle: (event, tx) => this.handle(event, tx),
    });
  }

  async handle(event: OutboxEvent, tx: Tx): Promise<void> {
    if (event.type === 'comms.meeting.invited' || event.type === 'comms.meeting.cancelled') {
      // Meetings are private: the notification names the organizer and the time, never the title, agenda or notes.
      const p = event.payload;
      const m = await tx.meeting.findUnique({
        where: { id: p.meetingId },
        select: { startsAt: true, organizer: { select: { fullName: true, empId: true } }, participants: { select: { employee: { select: { id: true, empId: true } } } } },
      });
      if (!m) return;
      const when = MEETING_TIME.format(m.startsAt);
      const invited = event.type === 'comms.meeting.invited' ? new Set(event.payload.empIds) : null;
      for (const { employee } of m.participants) {
        if (employee.empId === p.byEmpId || (invited && !invited.has(employee.empId))) continue;
        await this.notifications.create(tx, {
          recipientId: employee.id,
          type: invited ? 'meeting_invited' : 'meeting_cancelled',
          title: invited ? `${m.organizer.fullName} invited you to a meeting on ${when}` : `The meeting on ${when} was cancelled by ${m.organizer.fullName}`,
          body: null,
          link: `/meetings/${p.meetingId}`,
          dedupeKey: `comms:meeting:${p.meetingId}:${invited ? 'invited' : 'cancelled'}`,
          sourceEventId: event.id,
        });
      }
      return;
    }
    if (event.type === 'comms.announcement.published') {
      // Everyone it is for now (never its author). The title is what was announced to all of them; the text stays on the screen.
      const p = event.payload;
      const a = await tx.announcement.findUnique({ where: { id: p.announcementId }, select: { title: true, requiresAck: true } });
      if (!a) return;
      for (const to of await this.announcements.audienceOf(tx, p.announcementId)) {
        await this.notifications.create(tx, {
          recipientId: to.id,
          type: 'announcement',
          title: a.requiresAck ? `Please read and acknowledge: ${a.title}` : `New announcement: ${a.title}`,
          body: null,
          link: '/announcements',
          dedupeKey: `comms:announcement:${p.announcementId}`,
          sourceEventId: event.id,
        });
      }
      return;
    }
    if (event.type === 'comms.mention') {
      const p = event.payload;
      const ctx = await this.context(tx, p.conversationId, p.messageId);
      if (!ctx) return;
      const to = await this.recipient(tx, p.mentionedEmpId);
      if (!to || to.empId === p.byEmpId) return;
      if (!(await this.mayRead(tx, to, ctx.conversation.id, ctx.seq))) return;
      await this.notifications.create(tx, {
        recipientId: to.id,
        type: 'message_mention',
        title: `${ctx.authorName} mentioned you in ${where(ctx.conversation)}`,
        body: null,
        link: `/messages/${ctx.conversation.id}?m=${p.messageId}`,
        dedupeKey: `comms:${p.messageId}:mention`,
        sourceEventId: event.id,
      });
      return;
    }
    if (event.type !== 'comms.message.created') return;
    const p = event.payload;
    const ctx = await this.context(tx, p.conversationId, p.messageId);
    if (!ctx) return;
    // People told about this message already (or about to be, by its mention events).
    const handled = new Set<string>([p.authorEmpId, ...p.mentionedEmpIds]);

    if (p.parentMessageId) {
      const parent = await tx.message.findUnique({ where: { id: p.parentMessageId }, select: { author: { select: { empId: true } } } });
      const parentAuthor = parent?.author.empId;
      if (parentAuthor && !handled.has(parentAuthor)) {
        handled.add(parentAuthor);
        const to = await this.recipient(tx, parentAuthor);
        if (to && (await this.mayRead(tx, to, ctx.conversation.id, ctx.seq))) {
          await this.notifications.create(tx, {
            recipientId: to.id,
            type: 'message_reply',
            title: `${ctx.authorName} replied to your message in ${where(ctx.conversation)}`,
            body: null,
            link: `/messages/${ctx.conversation.id}?m=${p.parentMessageId}`,
            dedupeKey: `comms:${p.messageId}:reply`,
            sourceEventId: event.id,
          });
        }
      }
    }

    if (ctx.conversation.kind === 'channel') return;
    const members = await tx.$queryRaw<Array<{ id: string; emp_id: string; last_read_seq: number | null }>>`
      SELECT e."id", e."emp_id", r."last_read_seq"
      FROM "conversation_members" cm
      JOIN "employees" e ON e."id" = cm."employee_id"
      LEFT JOIN "conversation_reads" r ON r."conversation_id" = cm."conversation_id" AND r."employee_id" = cm."employee_id"
      WHERE cm."conversation_id" = ${ctx.conversation.id}::uuid AND cm."left_at" IS NULL AND cm."joined_seq" < ${ctx.seq}
        AND e."status" <> 'left'`;
    for (const m of members) {
      if (handled.has(m.emp_id)) continue;
      const readUpTo = m.last_read_seq ?? 0;
      if (readUpTo >= ctx.seq) continue; // already read (seen live)
      await this.notifications.create(tx, {
        recipientId: m.id,
        type: 'message_new',
        title: ctx.conversation.kind === 'dm' ? `New message from ${ctx.authorName}` : `New messages in ${where(ctx.conversation)}`,
        body: null,
        link: `/messages/${ctx.conversation.id}`,
        // One per conversation until it is read: the key changes only when the read position moves.
        dedupeKey: `comms:${ctx.conversation.id}:unread-after:${readUpTo}`,
        sourceEventId: event.id,
      });
    }
  }

  /** The message (still there, not deleted) with its conversation and author name; null when there is nothing to tell. */
  private async context(tx: Tx, conversationId: string, messageId: string): Promise<{ conversation: Conversation; seq: number; authorName: string } | null> {
    const m = await tx.message.findFirst({
      where: { id: messageId, conversationId },
      select: { seq: true, deletedAt: true, author: { select: { fullName: true } }, conversation: { select: { id: true, kind: true, name: true, archivedAt: true } } },
    });
    if (!m || m.deletedAt) return null;
    return { conversation: { id: m.conversation.id, kind: m.conversation.kind, name: m.conversation.name }, seq: m.seq, authorName: m.author.fullName };
  }

  private async recipient(tx: Tx, empId: string): Promise<Recipient | null> {
    return tx.employee.findFirst({ where: { empId, status: { not: 'left' } }, select: { id: true, empId: true, departmentId: true } });
  }

  /**
   * The same rule as every read (CommsAccessService): the person sees the conversation now, the message comes after the
   * start of their history, and they have not read it yet.
   */
  private async mayRead(tx: Tx, to: Recipient, conversationId: string, seq: number): Promise<boolean> {
    const rows = await tx.$queryRaw<Array<{ ok: boolean }>>`
      SELECT (${this.access.visibleSql(to.id, to.departmentId)} AND ${this.access.historyFromSql(to.id, to.departmentId)} < ${seq}
        AND COALESCE((SELECT r."last_read_seq" FROM "conversation_reads" r WHERE r."conversation_id" = c."id" AND r."employee_id" = ${to.id}::uuid), 0) < ${seq}) AS ok
      FROM "conversations" c WHERE c."id" = ${conversationId}::uuid`;
    return rows[0]?.ok === true;
  }
}

/** "25 Nov, 11:00" in Pakistan time. */
const MEETING_TIME = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });

/** "#design-review", "Launch group" (a group), "a direct message". */
function where(c: Conversation): string {
  if (c.kind === 'channel') return `#${c.name ?? 'channel'}`;
  if (c.kind === 'group') return c.name ?? 'a group';
  return 'a direct message';
}
