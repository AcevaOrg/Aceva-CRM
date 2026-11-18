import { BadRequestException, Injectable } from '@nestjs/common';
import {
  ESSENTIAL_NOTIFICATION_TYPES,
  isEssentialNotificationType,
  notificationTypeSchema,
  type MarkNotificationsRead,
  type NotificationPrefs,
  type NotificationType,
  type NotificationView,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { Clock } from '../common/clock';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface NewNotification {
  recipientId: string;
  type: NotificationType;
  title: string;
  body?: string | null;
  /** An app path, for example /approvals. */
  link?: string | null;
  /** Unique per recipient: the same key never creates a second notification (or a second email). */
  dedupeKey: string;
  sourceEventId?: string | null;
}

const LIST_LIMIT = 100;

/**
 * The notification core (minimal Module 12, Cycle 3 foundation). `create` is called inside a module's transaction
 * (usually an outbox reader): the notification and its email delivery row are written together, at most once per
 * recipient and dedupe key. The email itself is sent later by NotificationDeliveryService.
 * Approvals and security alerts (ESSENTIAL_NOTIFICATION_TYPES) are always emailed, whatever the person's choices.
 */
@Injectable()
export class NotificationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly audit: AuditService,
  ) {}

  /** Returns false when it already existed (a retry) or the recipient has left. */
  async create(tx: Prisma.TransactionClient, n: NewNotification): Promise<boolean> {
    const recipient = await tx.employee.findUnique({ where: { id: n.recipientId }, select: { status: true } });
    if (!recipient || recipient.status === 'left') return false;
    const essential = isEssentialNotificationType(n.type);
    const now = this.clock.now();
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO notifications (recipient_id, type, title, body, link, essential, dedupe_key, source_event_id, created_at)
      VALUES (${n.recipientId}::uuid, ${n.type}, ${n.title}, ${n.body ?? null}, ${n.link ?? null}, ${essential}, ${n.dedupeKey}, ${n.sourceEventId ?? null}::uuid, ${now})
      ON CONFLICT (recipient_id, dedupe_key) DO NOTHING
      RETURNING id`;
    const id = rows[0]?.id;
    if (!id) return false;
    const prefs = essential ? null : await tx.notificationPreference.findUnique({ where: { employeeId: n.recipientId }, select: { emailOff: true } });
    const turnedOff = !essential && !!prefs?.emailOff.includes(n.type);
    await tx.notificationDelivery.create({
      data: { notificationId: id, channel: 'email', status: turnedOff ? 'skipped' : 'pending', note: turnedOff ? 'turned_off' : null, nextAttemptAt: now },
    });
    return true;
  }

  /** GET /notifications: the caller's own, newest first. */
  async list(actor: Actor, unreadOnly: boolean): Promise<NotificationView[]> {
    const rows = await this.prisma.notification.findMany({
      where: { recipientId: actor.id, ...(unreadOnly ? { readAt: null } : {}) },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: LIST_LIMIT,
    });
    return rows.map((r) => ({
      id: r.id,
      empId: actor.empId,
      type: notificationTypeSchema.parse(r.type),
      title: r.title,
      body: r.body,
      link: r.link,
      at: r.createdAt.toISOString(),
      read: r.readAt !== null,
      essential: r.essential,
    }));
  }

  /** POST /notifications/read: only the caller's own; other people's ids are simply not matched. */
  async markRead(actor: Actor, dto: MarkNotificationsRead): Promise<{ updated: number }> {
    const { count } = await this.prisma.notification.updateMany({
      where: { recipientId: actor.id, readAt: null, ...(dto.ids ? { id: { in: dto.ids } } : {}) },
      data: { readAt: this.clock.now() },
    });
    return { updated: count };
  }

  /** GET /notifications/prefs */
  async prefs(actor: Actor): Promise<NotificationPrefs> {
    const row = await this.prisma.notificationPreference.findUnique({ where: { employeeId: actor.id } });
    const email: NotificationPrefs['email'] = {};
    for (const t of row?.emailOff ?? []) {
      const parsed = notificationTypeSchema.safeParse(t);
      if (parsed.success) email[parsed.data] = false;
    }
    return { email, dailySummary: row?.dailySummary ?? true };
  }

  /** PATCH /notifications/prefs. Essential types cannot be turned off (refused here and by the database). */
  async savePrefs(actor: Actor, dto: NotificationPrefs, client: RequestInfo): Promise<NotificationPrefs> {
    const off = (Object.entries(dto.email) as Array<[NotificationType, boolean | undefined]>).filter(([, on]) => on === false).map(([t]) => t);
    const essential = off.filter((t) => isEssentialNotificationType(t));
    if (essential.length) {
      throw new BadRequestException({
        statusCode: 400,
        code: 'essential_notification',
        message: 'Approvals and security alerts are always emailed and cannot be turned off',
        types: essential,
        essentialTypes: ESSENTIAL_NOTIFICATION_TYPES,
      });
    }
    const emailOff = [...new Set(off)].sort();
    await this.prisma.$transaction(async (tx) => {
      await tx.notificationPreference.upsert({
        where: { employeeId: actor.id },
        create: { employeeId: actor.id, emailOff, dailySummary: dto.dailySummary },
        update: { emailOff, dailySummary: dto.dailySummary },
      });
      await this.audit.record({ actorId: actor.id, action: 'notifications.prefs.changed', targetType: 'employee', targetId: actor.empId, details: { emailOff, dailySummary: dto.dailySummary }, ...client }, tx);
    });
    return this.prefs(actor);
  }
}
