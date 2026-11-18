import { Injectable } from '@nestjs/common';
import type { MessageView } from '@aceva/contracts';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CommsAccessService, type ConversationRow } from './comms-access.service';
import { commsDb } from './comms-errors';

type Db = PrismaService | Prisma.TransactionClient;

export const messageSelect = {
  id: true,
  conversationId: true,
  seq: true,
  parentId: true,
  body: true,
  createdAt: true,
  editedAt: true,
  deletedAt: true,
  deletedAs: true,
  author: { select: { empId: true } },
} satisfies Prisma.MessageSelect;
export type MessageRow = Prisma.MessageGetPayload<{ select: typeof messageSelect }>;

/** Builds what the screens see for a list of messages: reactions, mentions, reply counts, pins, saves and receipts. */
@Injectable()
export class MessageViewBuilder {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CommsAccessService,
  ) {}

  /** `conversations` must hold every conversation the messages belong to (for receipts). */
  async build(viewerId: string, messages: MessageRow[], conversations: ConversationRow[], db: Db = this.prisma): Promise<MessageView[]> {
    if (!messages.length) return [];
    return commsDb(async () => {
      const ids = messages.map((m) => m.id);
      const [reactions, mentions, replies, pins, saves] = await Promise.all([
        db.messageReaction.findMany({ where: { messageId: { in: ids } }, select: { messageId: true, emoji: true, createdAt: true, employee: { select: { empId: true } } }, orderBy: { createdAt: 'asc' } }),
        db.messageMention.findMany({ where: { messageId: { in: ids } }, select: { messageId: true, employee: { select: { empId: true } } } }),
        db.message.groupBy({ by: ['parentId'], where: { parentId: { in: ids }, deletedAt: null }, _count: { _all: true }, _max: { createdAt: true } }),
        db.pinnedMessage.findMany({ where: { messageId: { in: ids } }, select: { messageId: true } }),
        db.savedMessage.findMany({ where: { employeeId: viewerId, messageId: { in: ids } }, select: { messageId: true } }),
      ]);

      // Receipts: DMs and groups only (channels show nobody's read position but your own).
      const receipts = new Map<string, Array<{ empId: string; fromSeq: number; delivered: number; read: number }>>();
      for (const c of conversations) {
        if (c.kind === 'channel' || receipts.has(c.id)) continue;
        const members = (await this.access.effectiveMembers(c, db)).filter((m) => m.active);
        const reads = await db.conversationRead.findMany({ where: { conversationId: c.id, employeeId: { in: members.map((m) => m.employeeId) } } });
        const byId = new Map(reads.map((r) => [r.employeeId, r]));
        receipts.set(
          c.id,
          members.map((m) => ({ empId: m.empId, fromSeq: m.fromSeq, delivered: byId.get(m.employeeId)?.lastDeliveredSeq ?? 0, read: byId.get(m.employeeId)?.lastReadSeq ?? 0 })),
        );
      }

      const pinned = new Set(pins.map((p) => p.messageId));
      const saved = new Set(saves.map((s) => s.messageId));
      const replyStats = new Map(replies.map((r) => [r.parentId!, { count: r._count._all, last: r._max.createdAt }]));

      return messages.map((m): MessageView => {
        const deleted = !!m.deletedAt;
        const grouped = new Map<string, string[]>();
        if (!deleted) {
          for (const r of reactions) {
            if (r.messageId !== m.id) continue;
            (grouped.get(r.emoji) ?? grouped.set(r.emoji, []).get(r.emoji)!).push(r.employee.empId);
          }
        }
        const people = receipts.get(m.conversationId);
        // Someone who joined after this message never received or read it.
        const others = people?.filter((p) => p.empId !== m.author.empId && p.fromSeq < m.seq);
        const stats = replyStats.get(m.id);
        return {
          id: m.id,
          conversationId: m.conversationId,
          seq: m.seq,
          authorEmpId: m.author.empId,
          parentId: m.parentId,
          body: deleted ? '' : m.body,
          createdAt: m.createdAt.toISOString(),
          editedAt: m.editedAt?.toISOString() ?? null,
          deleted,
          deletedAs: m.deletedAs === 'removed' ? 'moderator' : m.deletedAs === 'deleted' ? 'author' : null,
          replyCount: stats?.count ?? 0,
          lastReplyAt: stats?.last?.toISOString() ?? null,
          reactions: [...grouped].map(([emoji, empIds]) => ({ emoji, empIds, count: empIds.length })),
          mentions: deleted ? [] : mentions.filter((x) => x.messageId === m.id).map((x) => x.employee.empId).sort(),
          pinned: pinned.has(m.id),
          savedByMe: saved.has(m.id),
          receipt: others ? { deliveredTo: others.filter((p) => p.delivered >= m.seq).map((p) => p.empId), readBy: others.filter((p) => p.read >= m.seq).map((p) => p.empId) } : null,
        };
      });
    });
  }
}
