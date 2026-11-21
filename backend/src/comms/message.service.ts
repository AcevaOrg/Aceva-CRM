import { createHash } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, HttpException, Injectable } from '@nestjs/common';
import {
  MESSAGE_EDIT_WINDOW_MS,
  MESSAGE_RATE_LIMIT_PER_MINUTE,
  mentionedEmpIds,
  type CursorPage,
  type MessageHistoryQuery,
  type MessagePage,
  type MessageSearchHit,
  type MessageSearchQuery,
  type MessageView,
  type SavedMessageView,
  type SendMessageInput,
  type SendMessageResult,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { Clock } from '../common/clock';
import { OutboxService } from '../events/outbox.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CommsAccessService, conversationInclude, notFound, type ConversationRow, type MemberAccess } from './comms-access.service';
import { CommsDbError, commsDb } from './comms-errors';
import { decodeCursor, encodeCursor } from './cursor';
import { MessageViewBuilder, messageSelect, type MessageRow } from './message-views';
import { CommsRealtimePublisher } from './realtime/comms-realtime.publisher';

type Tx = Prisma.TransactionClient;

/** What a retry key stands for: the conversation, the text and the reply target exactly as first sent. */
export function requestHashOf(conversationId: string, body: string, parentId: string | null): string {
  return createHash('sha256').update(JSON.stringify([conversationId, body, parentId])).digest('hex');
}

const archived = (): never => {
  throw new ConflictException({ statusCode: 409, code: 'conversation_archived', message: 'This conversation is archived: it can be read but not changed' });
};
const deletedMessage = (): never => {
  throw new ConflictException({ statusCode: 409, code: 'message_deleted', message: 'This message was deleted' });
};

/**
 * Messages (Module 14, part 1). Every operation first checks that the caller is a member of the message's conversation,
 * otherwise "not found". Message text is only ever written to messages.body and message_revisions.body: never to the audit
 * log (which gets ids, sequence numbers and Emp-IDs), the outbox or the application log.
 */
@Injectable()
export class MessageService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CommsAccessService,
    private readonly views: MessageViewBuilder,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly realtime: CommsRealtimePublisher,
  ) {}

  // ---------- Sending ----------

  async send(actor: Actor, conversationId: string, input: SendMessageInput): Promise<SendMessageResult> {
    const access = await this.access.memberAccess(actor, conversationId);
    const c = access.conversation;
    const parentId = input.parentId ?? null;
    const requestHash = requestHashOf(c.id, input.body, parentId);

    // A retry of a message already saved: the same message again (or a conflict when the key was reused for something else).
    const previous = await this.byClientKey(actor.id, input.clientKey);
    if (previous) return this.replay(actor.id, previous, requestHash, c);

    if (c.archivedAt) archived();
    await this.checkRate(actor);
    if (parentId) {
      // Only a message inside the sender's history can be answered.
      const parent = await commsDb(() => this.prisma.message.findFirst({ where: { id: parentId, conversationId: c.id, seq: { gt: access.fromSeq } }, select: { parentId: true, deletedAt: true } }));
      if (!parent || parent.parentId || parent.deletedAt) {
        throw new BadRequestException({ statusCode: 400, code: 'invalid_reply_target', message: 'You can reply only to a message at the top of this conversation' });
      }
    }
    const mentioned = await this.validateMentions(c, input.body);
    const now = this.clock.now();

    try {
      const message = await commsDb(() =>
        this.prisma.$transaction(async (tx) => {
          // The next number, under this conversation's row lock: concurrent sends wait here and get consecutive numbers;
          // if anything below fails, the whole transaction (and so this increment) is rolled back, leaving no gap.
          const [allocated] = await tx.$queryRaw<Array<{ last_seq: number }>>`
            UPDATE "conversations" SET "last_seq" = "last_seq" + 1, "last_message_at" = ${now}, "updated_at" = ${now}
            WHERE "id" = ${c.id}::uuid AND "archived_at" IS NULL
            RETURNING "last_seq"`;
          if (!allocated) archived();
          const created = await tx.message.create({
            data: { conversationId: c.id, seq: allocated.last_seq, authorId: actor.id, parentId, body: input.body, clientKey: input.clientKey, requestHash, createdAt: now },
            select: { id: true, seq: true },
          });
          if (mentioned.length) {
            await tx.messageMention.createMany({ data: mentioned.map((m) => ({ messageId: created.id, employeeId: m.id, createdAt: now })) });
          }
          await this.advance(tx, c.id, actor.id, created.seq, now);
          const eventId = await this.outbox.emit(
            {
              type: 'comms.message.created',
              actor: actor.empId,
              payload: { conversationId: c.id, conversationKind: c.kind, messageId: created.id, seq: created.seq, authorEmpId: actor.empId, parentMessageId: parentId, mentionedEmpIds: mentioned.map((m) => m.empId) },
            },
            tx,
          );
          await this.emitMentions(tx, actor, c.id, created.id, mentioned);
          return { ...created, eventId };
        }),
      );
      // Saved and committed first; only then told to the live sockets (Module 14, part 2).
      await this.realtime.messageCreated(c.id, message.id, message.eventId);
      return { message: await this.view(actor.id, message.id, c), created: true };
    } catch (error) {
      // Two sends with the same retry key at the same moment: the second one finds the first one's message.
      if (error instanceof CommsDbError && error.unique) {
        const again = await this.byClientKey(actor.id, input.clientKey);
        if (again) return this.replay(actor.id, again, requestHash, c);
      }
      throw error;
    }
  }

  private byClientKey(authorId: string, clientKey: string) {
    return commsDb(() => this.prisma.message.findUnique({ where: { authorId_clientKey: { authorId, clientKey } }, select: { id: true, conversationId: true, requestHash: true } }));
  }

  private async replay(viewerId: string, previous: { id: string; conversationId: string; requestHash: string }, requestHash: string, c: ConversationRow): Promise<SendMessageResult> {
    if (previous.requestHash !== requestHash || previous.conversationId !== c.id) {
      throw new ConflictException({ statusCode: 409, code: 'client_key_reused', message: 'This retry key was already used for a different message' });
    }
    return { message: await this.view(viewerId, previous.id, c), created: false };
  }

  /** At most MESSAGE_RATE_LIMIT_PER_MINUTE messages per person in any minute. */
  private async checkRate(actor: Actor): Promise<void> {
    const now = this.clock.now().getTime();
    const recent = await commsDb(() => this.prisma.message.findMany({ where: { authorId: actor.id, createdAt: { gt: new Date(now - 60_000) } }, orderBy: { createdAt: 'asc' }, select: { createdAt: true } }));
    if (recent.length >= MESSAGE_RATE_LIMIT_PER_MINUTE) {
      const retryAfterSec = Math.max(1, Math.ceil((recent[recent.length - MESSAGE_RATE_LIMIT_PER_MINUTE].createdAt.getTime() + 60_000 - now) / 1000));
      throw new HttpException({ statusCode: 429, code: 'rate_limited', message: 'You are sending messages too quickly. Please wait a moment.', retryAfterSec }, 429);
    }
  }

  /** Mentions are "@ACV-0006" tokens; each must be a current member of the conversation. */
  private async validateMentions(c: ConversationRow, body: string): Promise<Array<{ id: string; empId: string }>> {
    const empIds = mentionedEmpIds(body);
    if (!empIds.length) return [];
    const members = new Map((await this.access.effectiveMembers(c)).filter((m) => m.active).map((m) => [m.empId, m.employeeId]));
    const missing = empIds.filter((e) => !members.has(e));
    if (missing.length) {
      throw new BadRequestException({ statusCode: 400, code: 'mention_not_member', message: 'You can mention only members of this conversation', empIds: missing });
    }
    return empIds.map((empId) => ({ id: members.get(empId)!, empId }));
  }

  private async emitMentions(tx: Tx, actor: Actor, conversationId: string, messageId: string, people: Array<{ empId: string }>): Promise<void> {
    for (const p of people) {
      if (p.empId === actor.empId) continue;
      await this.outbox.emit({ type: 'comms.mention', actor: actor.empId, payload: { conversationId, messageId, mentionedEmpId: p.empId, byEmpId: actor.empId } }, tx);
    }
  }

  /** The author has received and read their own message. */
  private advance(tx: Tx, conversationId: string, employeeId: string, seq: number, now: Date) {
    return tx.$executeRaw`
      INSERT INTO "conversation_reads" ("conversation_id", "employee_id", "last_delivered_seq", "last_read_seq", "updated_at")
      VALUES (${conversationId}::uuid, ${employeeId}::uuid, ${seq}, ${seq}, ${now})
      ON CONFLICT ("conversation_id", "employee_id") DO UPDATE SET
        "last_read_seq" = GREATEST("conversation_reads"."last_read_seq", EXCLUDED."last_read_seq"),
        "last_delivered_seq" = GREATEST("conversation_reads"."last_delivered_seq", EXCLUDED."last_delivered_seq"),
        "updated_at" = EXCLUDED."updated_at"`;
  }

  // ---------- Reading ----------

  /**
   * History by sequence number (see messageHistoryQuerySchema). Deleted messages stay as placeholders, so no number is
   * skipped. Only messages after the caller's history start (fromSeq) exist for them.
   */
  async history(actor: Actor, conversationId: string, q: MessageHistoryQuery): Promise<MessagePage> {
    const { conversation: c, fromSeq } = await this.access.memberAccess(actor, conversationId);
    let items: MessageRow[];
    let hasMoreBefore: boolean;
    let hasMoreAfter: boolean;
    if (q.after !== undefined) {
      const after = q.after;
      const rows = await commsDb(() => this.prisma.message.findMany({ where: { conversationId: c.id, seq: { gt: Math.max(after, fromSeq) } }, orderBy: { seq: 'asc' }, take: q.limit + 1, select: messageSelect }));
      items = rows.slice(0, q.limit);
      hasMoreAfter = rows.length > q.limit;
      hasMoreBefore = Math.min(after, c.lastSeq) > fromSeq;
    } else {
      const rows = await commsDb(() =>
        this.prisma.message.findMany({ where: { conversationId: c.id, seq: { gt: fromSeq, ...(q.before !== undefined ? { lt: q.before } : {}) } }, orderBy: { seq: 'desc' }, take: q.limit + 1, select: messageSelect }),
      );
      items = rows.slice(0, q.limit).reverse();
      hasMoreBefore = rows.length > q.limit;
      hasMoreAfter = q.before !== undefined && q.before <= c.lastSeq;
    }
    return { items: await this.views.build(actor.id, items, [c]), hasMoreBefore, hasMoreAfter, lastSeq: c.lastSeq };
  }

  /** A top-level message and its replies (oldest first), paged by sequence number. */
  async thread(actor: Actor, messageId: string, q: { after?: number; limit: number }): Promise<{ parent: MessageView; items: MessageView[]; hasMoreAfter: boolean }> {
    const { message, access } = await this.messageAccess(actor, messageId);
    if (message.parentId) throw new BadRequestException({ statusCode: 400, code: 'not_a_thread', message: 'Open the thread from its first message' });
    const rows = await commsDb(() =>
      this.prisma.message.findMany({ where: { parentId: message.id, seq: { gt: Math.max(q.after ?? 0, access.fromSeq) } }, orderBy: { seq: 'asc' }, take: q.limit + 1, select: messageSelect }),
    );
    const [parent, ...items] = await this.views.build(actor.id, [message, ...rows.slice(0, q.limit)], [access.conversation]);
    return { parent, items, hasMoreAfter: rows.length > q.limit };
  }

  async pins(actor: Actor, conversationId: string): Promise<MessageView[]> {
    const { conversation: c, fromSeq } = await this.access.memberAccess(actor, conversationId);
    const pins = await commsDb(() =>
      this.prisma.pinnedMessage.findMany({ where: { conversationId: c.id, message: { seq: { gt: fromSeq } } }, orderBy: { pinnedAt: 'desc' }, select: { message: { select: messageSelect } } }),
    );
    return this.views.build(actor.id, pins.map((p) => p.message), [c]);
  }

  /** Search the text of messages in conversations the caller can see now (never anything else). Newest first. */
  async search(actor: Actor, q: MessageSearchQuery): Promise<CursorPage<MessageSearchHit>> {
    if (q.conversationId) await this.access.memberAccess(actor, q.conversationId);
    const ctx = await this.access.actorContext(actor);
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await commsDb(() =>
      this.prisma.$queryRaw<Array<{ id: string; created_at: Date }>>`
        SELECT m."id", m."created_at"
        FROM "messages" m JOIN "conversations" c ON c."id" = m."conversation_id"
        WHERE m."deleted_at" IS NULL
          AND to_tsvector('simple', m."body") @@ websearch_to_tsquery('simple', ${q.q})
          AND ${this.access.visibleSql(actor.id, ctx.departmentId)}
          AND m."seq" > ${this.access.historyFromSql(actor.id, ctx.departmentId)}
          ${q.conversationId ? Prisma.sql`AND m."conversation_id" = ${q.conversationId}::uuid` : Prisma.empty}
          ${after ? Prisma.sql`AND (m."created_at", m."id") < (${after.at}::timestamptz, ${after.id}::uuid)` : Prisma.empty}
        ORDER BY m."created_at" DESC, m."id" DESC
        LIMIT ${q.limit + 1}`,
    );
    const page = rows.slice(0, q.limit);
    const views = await this.viewsWithConversations(actor.id, page.map((r) => r.id));
    const last = rows.length > q.limit ? page[page.length - 1] : null;
    return { items: views.map(({ message, conversation }) => ({ message, conversation })), nextCursor: last ? encodeCursor(last.created_at, last.id) : null };
  }

  /** The caller's saved messages, from conversations they can still see. */
  async saved(actor: Actor, q: { cursor?: string; limit: number }): Promise<CursorPage<SavedMessageView>> {
    const ctx = await this.access.actorContext(actor);
    const after = q.cursor ? decodeCursor(q.cursor) : null;
    const rows = await commsDb(() =>
      this.prisma.$queryRaw<Array<{ message_id: string; saved_at: Date }>>`
        SELECT s."message_id", s."saved_at"
        FROM "saved_messages" s JOIN "messages" m ON m."id" = s."message_id" JOIN "conversations" c ON c."id" = m."conversation_id"
        WHERE s."employee_id" = ${actor.id}::uuid
          AND ${this.access.visibleSql(actor.id, ctx.departmentId)}
          AND m."seq" > ${this.access.historyFromSql(actor.id, ctx.departmentId)}
          ${after ? Prisma.sql`AND (s."saved_at", s."message_id") < (${after.at}::timestamptz, ${after.id}::uuid)` : Prisma.empty}
        ORDER BY s."saved_at" DESC, s."message_id" DESC
        LIMIT ${q.limit + 1}`,
    );
    const page = rows.slice(0, q.limit);
    const views = await this.viewsWithConversations(actor.id, page.map((r) => r.message_id));
    const savedAt = new Map(page.map((r) => [r.message_id, r.saved_at]));
    const last = rows.length > q.limit ? page[page.length - 1] : null;
    return {
      items: views.map(({ message, conversation }) => ({ savedAt: savedAt.get(message.id)!.toISOString(), message, conversation: { id: conversation.id, kind: conversation.kind, name: conversation.name } })),
      nextCursor: last ? encodeCursor(last.saved_at, last.message_id) : null,
    };
  }

  private async viewsWithConversations(viewerId: string, messageIds: string[]) {
    if (!messageIds.length) return [];
    const rows = await commsDb(() => this.prisma.message.findMany({ where: { id: { in: messageIds } }, select: messageSelect }));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const ordered = messageIds.map((id) => byId.get(id)!).filter(Boolean);
    const conversations = await commsDb(() => this.prisma.conversation.findMany({ where: { id: { in: [...new Set(ordered.map((m) => m.conversationId))] } }, include: conversationInclude }));
    const dmPeople = await commsDb(() =>
      this.prisma.conversationMember.findMany({
        where: { conversationId: { in: conversations.filter((c) => c.kind === 'dm').map((c) => c.id) }, employeeId: { not: viewerId } },
        select: { conversationId: true, employee: { select: { empId: true, fullName: true } } },
      }),
    );
    const views = await this.views.build(viewerId, ordered, conversations);
    const conv = new Map(conversations.map((c) => [c.id, c]));
    return views.map((message) => {
      const c = conv.get(message.conversationId)!;
      return { message, conversation: { id: c.id, kind: c.kind, name: c.name, dmWith: dmPeople.find((p) => p.conversationId === c.id)?.employee ?? null } };
    });
  }

  // ---------- Changing ----------

  /** The author edits their own message within 24 hours. The older text is kept (never shown). */
  async edit(actor: Actor, messageId: string, body: string, client: RequestInfo): Promise<MessageView> {
    const { message, access } = await this.messageAccess(actor, messageId);
    const c = access.conversation;
    const current = await this.authorRow(message.id);
    if (current.authorId !== actor.id) throw new ForbiddenException({ statusCode: 403, code: 'not_author', message: 'Only the author can edit a message' });
    if (current.deletedAt) deletedMessage();
    if (c.archivedAt) archived();
    const now = this.clock.now();
    if (now.getTime() - current.createdAt.getTime() > MESSAGE_EDIT_WINDOW_MS) {
      throw new ConflictException({ statusCode: 409, code: 'edit_window_closed', message: 'A message can be edited for 24 hours after it was sent' });
    }
    if (current.body === body) return this.view(actor.id, message.id, c);
    const mentioned = await this.validateMentions(c, body);
    const eventId = await commsDb(() =>
      this.prisma.$transaction(async (tx) => {
        const locked = await this.lock(tx, message.id);
        if (locked.deleted_at) deletedMessage();
        const next = locked.revision + 1;
        await tx.messageRevision.create({ data: { messageId: message.id, revision: next, kind: 'edited', body: locked.body, changedById: actor.id, createdAt: now } });
        await tx.message.update({ where: { id: message.id }, data: { body, editedAt: now, revision: next } });
        const before = await tx.messageMention.findMany({ where: { messageId: message.id }, select: { employeeId: true } });
        const keep = new Set(mentioned.map((m) => m.id));
        const had = new Set(before.map((b) => b.employeeId));
        await tx.messageMention.deleteMany({ where: { messageId: message.id, employeeId: { notIn: [...keep] } } });
        const added = mentioned.filter((m) => !had.has(m.id));
        if (added.length) await tx.messageMention.createMany({ data: added.map((m) => ({ messageId: message.id, employeeId: m.id, createdAt: now })) });
        await this.emitMentions(tx, actor, c.id, message.id, added);
        await this.audit.record({ actorId: actor.id, action: 'comms.message.edited', targetType: 'message', targetId: message.id, details: { conversationId: c.id, seq: message.seq, revision: next }, ...client }, tx);
        return this.changed(tx, actor, c.id, message.id, 'edited');
      }),
    );
    await this.realtime.messageUpdated(c.id, message.id, eventId);
    return this.view(actor.id, message.id, c);
  }

  /** The author deletes their own message (at any time). A placeholder stays; the text is kept as an older version. */
  async deleteOwn(actor: Actor, messageId: string, client: RequestInfo): Promise<MessageView> {
    const { message, access } = await this.messageAccess(actor, messageId);
    const current = await this.authorRow(message.id);
    if (current.authorId !== actor.id) throw new ForbiddenException({ statusCode: 403, code: 'not_author', message: 'Only the author can delete a message; a moderator can remove it' });
    await this.takeDown(actor, message, access.conversation, 'deleted', null, client);
    return this.view(actor.id, message.id, access.conversation);
  }

  /** A moderator (or, in a channel, a comms admin who is a member) removes a message, with a reason. Audited. */
  async remove(actor: Actor, messageId: string, reason: string, client: RequestInfo): Promise<MessageView> {
    const { message, access } = await this.messageAccess(actor, messageId);
    if (!this.access.capabilities(access).removeMessages) throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message: 'Only a moderator can remove messages here' });
    await this.takeDown(actor, message, access.conversation, 'removed', reason, client);
    return this.view(actor.id, message.id, access.conversation);
  }

  private async takeDown(actor: Actor, message: MessageRow, c: ConversationRow, kind: 'deleted' | 'removed', reason: string | null, client: RequestInfo): Promise<void> {
    const now = this.clock.now();
    const eventId = await commsDb(() =>
      this.prisma.$transaction(async (tx) => {
        const locked = await this.lock(tx, message.id);
        if (locked.deleted_at) return null; // already deleted: nothing more to do
        const next = locked.revision + 1;
        await tx.messageRevision.create({ data: { messageId: message.id, revision: next, kind, body: locked.body, changedById: actor.id, createdAt: now } });
        await tx.message.update({ where: { id: message.id }, data: { body: '', deletedAt: now, deletedById: actor.id, deletedAs: kind, revision: next } });
        await tx.pinnedMessage.deleteMany({ where: { messageId: message.id } });
        await this.audit.record(
          {
            actorId: actor.id,
            action: kind === 'removed' ? 'comms.message.removed' : 'comms.message.deleted',
            targetType: 'message',
            targetId: message.id,
            reason,
            details: { conversationId: c.id, conversationKind: c.kind, seq: message.seq, authorEmpId: message.author.empId, revision: next },
            ...client,
          },
          tx,
        );
        return this.changed(tx, actor, c.id, message.id, kind);
      }),
    );
    if (eventId) await this.realtime.messageUpdated(c.id, message.id, eventId);
  }

  /**
   * Records that a message changed (ids only), in the same transaction as the change. The live update is sent after the
   * commit; if it is lost, the outbox safety net re-sends it (Module 14, part 2). Returns the event id.
   */
  private changed(tx: Tx, actor: Actor, conversationId: string, messageId: string, change: 'edited' | 'deleted' | 'removed' | 'reaction' | 'pinned' | 'unpinned'): Promise<string> {
    return this.outbox.emit({ type: 'comms.message.changed', actor: actor.empId, payload: { conversationId, messageId, change } }, tx);
  }

  private async lock(tx: Tx, messageId: string) {
    const [row] = await tx.$queryRaw<Array<{ revision: number; deleted_at: Date | null; body: string }>>`
      SELECT "revision", "deleted_at", "body" FROM "messages" WHERE "id" = ${messageId}::uuid FOR UPDATE`;
    return row;
  }

  private authorRow(messageId: string) {
    return commsDb(() => this.prisma.message.findUniqueOrThrow({ where: { id: messageId }, select: { authorId: true, body: true, createdAt: true, deletedAt: true } }));
  }

  async react(actor: Actor, messageId: string, emoji: string, on: boolean): Promise<MessageView> {
    const { message, access } = await this.messageAccess(actor, messageId);
    const c = access.conversation;
    if (on) {
      if (message.deletedAt) deletedMessage();
      if (c.archivedAt) archived();
    }
    const eventId = await commsDb(() =>
      this.prisma.$transaction(async (tx) => {
        const changed = on
          ? await tx.messageReaction.createMany({ data: [{ messageId: message.id, employeeId: actor.id, emoji, createdAt: this.clock.now() }], skipDuplicates: true })
          : await tx.messageReaction.deleteMany({ where: { messageId: message.id, employeeId: actor.id, emoji } });
        return changed.count ? this.changed(tx, actor, c.id, message.id, 'reaction') : null;
      }),
    );
    if (eventId) await this.realtime.messageUpdated(c.id, message.id, eventId);
    return this.view(actor.id, message.id, c);
  }

  async pin(actor: Actor, messageId: string, on: boolean, client: RequestInfo): Promise<MessageView> {
    const { message, access } = await this.messageAccess(actor, messageId);
    const c = access.conversation;
    if (c.archivedAt) archived();
    if (!this.access.capabilities(access).pin) throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message: 'Only a moderator can pin messages in a channel' });
    if (on && message.deletedAt) deletedMessage();
    const eventId = await commsDb(() =>
      this.prisma.$transaction(async (tx) => {
        const changed = on
          ? await tx.pinnedMessage.createMany({ data: [{ messageId: message.id, conversationId: c.id, pinnedById: actor.id, pinnedAt: this.clock.now() }], skipDuplicates: true })
          : await tx.pinnedMessage.deleteMany({ where: { messageId: message.id } });
        if (changed.count) {
          await this.audit.record({ actorId: actor.id, action: on ? 'comms.message.pinned' : 'comms.message.unpinned', targetType: 'message', targetId: message.id, details: { conversationId: c.id, seq: message.seq }, ...client }, tx);
          return this.changed(tx, actor, c.id, message.id, on ? 'pinned' : 'unpinned');
        }
        return null;
      }),
    );
    if (eventId) await this.realtime.messageUpdated(c.id, message.id, eventId);
    return this.view(actor.id, message.id, c);
  }

  async save(actor: Actor, messageId: string, on: boolean): Promise<MessageView> {
    const { message, access } = await this.messageAccess(actor, messageId);
    if (on) {
      if (message.deletedAt) deletedMessage();
      await commsDb(() => this.prisma.savedMessage.createMany({ data: [{ employeeId: actor.id, messageId: message.id, savedAt: this.clock.now() }], skipDuplicates: true }));
    } else {
      await commsDb(() => this.prisma.savedMessage.deleteMany({ where: { employeeId: actor.id, messageId: message.id } }));
    }
    return this.view(actor.id, message.id, access.conversation);
  }

  // ---------- Helpers ----------

  /** The message and the caller's membership of its conversation; "not found" for anyone who is not a member. */
  private async messageAccess(actor: Actor, messageId: string): Promise<{ message: MessageRow; access: MemberAccess }> {
    const message = await commsDb(() => this.prisma.message.findUnique({ where: { id: messageId }, select: messageSelect }));
    if (!message) notFound();
    const access = await this.access.memberAccess(actor, message.conversationId);
    // A message from before the caller became a member does not exist for them.
    if (message.seq <= access.fromSeq) notFound();
    return { message, access };
  }

  private async view(viewerId: string, messageId: string, c: ConversationRow): Promise<MessageView> {
    const row = await commsDb(() => this.prisma.message.findUniqueOrThrow({ where: { id: messageId }, select: messageSelect }));
    const [view] = await this.views.build(viewerId, [row], [c]);
    return view;
  }
}
