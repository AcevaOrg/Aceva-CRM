import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { AnnouncementView, CursorPage, PublishAnnouncementInput } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { PermissionService } from '../access/permission.service';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { Clock } from '../common/clock';
import { OutboxService } from '../events/outbox.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { commsDb } from './comms-errors';

export const ANNOUNCEMENTS_PUBLISH = 'announcements.publish';

/**
 * Oversight (the same rule as the screens' seesAllAnnouncements): the CEO / Founder / Owner (level 1) and the Director
 * (level 2) see every announcement, including team-only ones. Everyone else sees the ones for them and their own.
 */
const OVERSIGHT_MAX_LEVEL = 2;

const notFound = (): never => {
  throw new NotFoundException({ statusCode: 404, code: 'not_found', message: 'Announcement not found' });
};

const include = { author: { select: { empId: true } }, departments: { select: { department: { select: { id: true, code: true } } } } } as const;
type Row = Prisma.AnnouncementGetPayload<{ include: typeof include }>;

/**
 * Module 14 announcements (plan section 19: "Announcements for company-wide or selected teams; important announcements
 * can be pinned and require acknowledgement"). Publishing and pinning need announcements.publish; each is audited. Who an
 * announcement is for follows the current employee records. Publishers see who has acknowledged and who has not; other
 * people only see their own acknowledgement.
 */
@Injectable()
export class AnnouncementService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  async list(actor: Actor, q: { cursor?: string; limit: number }): Promise<CursorPage<AnnouncementView>> {
    const me = await this.viewer(actor);
    const offset = q.cursor && /^\d{1,6}$/.test(q.cursor) ? Number(q.cursor) : 0;
    const rows = await commsDb(() =>
      this.prisma.announcement.findMany({
        where: this.visibleWhere(me),
        orderBy: [{ pinned: 'desc' }, { pinnedAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        skip: offset,
        take: q.limit + 1,
        include,
      }),
    );
    const page = rows.slice(0, q.limit);
    return { items: await this.views(me, page), nextCursor: rows.length > q.limit ? String(offset + q.limit) : null };
  }

  async detail(actor: Actor, id: string): Promise<AnnouncementView> {
    const me = await this.viewer(actor);
    const row = await this.visible(me, id);
    return (await this.views(me, [row]))[0];
  }

  async publish(actor: Actor, input: PublishAnnouncementInput, client: RequestInfo): Promise<AnnouncementView> {
    const me = await this.viewer(actor);
    if (!me.canPublish) throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message: 'Only people who may publish announcements can do this' });
    const departments = input.audience.all
      ? []
      : await commsDb(() => this.prisma.department.findMany({ where: { code: { in: input.audience.departmentIds }, archivedAt: null }, select: { id: true, code: true } }));
    const unknown = input.audience.departmentIds.filter((c) => !departments.some((d) => d.code === c));
    if (unknown.length) throw new BadRequestException({ statusCode: 400, code: 'unknown_department', message: 'A department does not exist or is deactivated', departmentIds: unknown });
    const now = this.clock.now();
    const id = await commsDb(() =>
      this.prisma.$transaction(async (tx) => {
        const a = await tx.announcement.create({
          data: {
            title: input.title,
            body: input.body,
            authorId: actor.id,
            audienceAll: input.audience.all,
            requiresAck: input.requiresAck,
            pinned: input.pinned,
            pinnedAt: input.pinned ? now : null,
            pinnedById: input.pinned ? actor.id : null,
            createdAt: now,
            updatedAt: now,
          },
          select: { id: true },
        });
        if (departments.length) await tx.announcementDepartment.createMany({ data: departments.map((d) => ({ announcementId: a.id, departmentId: d.id })) });
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'comms.announcement.published',
            targetType: 'announcement',
            targetId: a.id,
            details: { title: input.title, audience: input.audience.all ? 'all' : departments.map((d) => d.code), pinned: input.pinned, requiresAck: input.requiresAck },
            ...client,
          },
          tx,
        );
        await this.outbox.emit({ type: 'comms.announcement.published', actor: actor.empId, payload: { announcementId: a.id, byEmpId: actor.empId, requiresAck: input.requiresAck } }, tx);
        return a.id;
      }),
    );
    return this.detail(actor, id);
  }

  async setPinned(actor: Actor, id: string, pinned: boolean, client: RequestInfo): Promise<AnnouncementView> {
    const me = await this.viewer(actor);
    const row = await this.visible(me, id);
    if (!me.canPublish) throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message: 'Only people who may publish announcements can pin them' });
    if (row.pinned !== pinned) {
      const now = this.clock.now();
      await commsDb(() =>
        this.prisma.$transaction(async (tx) => {
          await tx.announcement.update({ where: { id: row.id }, data: { pinned, pinnedAt: pinned ? now : null, pinnedById: pinned ? actor.id : null, updatedAt: now } });
          await this.audit.record({ actorId: actor.id, action: pinned ? 'comms.announcement.pinned' : 'comms.announcement.unpinned', targetType: 'announcement', targetId: row.id, ...client }, tx);
        }),
      );
    }
    return this.detail(actor, id);
  }

  /** "I've read this": once per person, only by someone it is for, only when it asks for it. Asking twice changes nothing. */
  async acknowledge(actor: Actor, id: string): Promise<AnnouncementView> {
    const me = await this.viewer(actor);
    const row = await this.visible(me, id);
    if (!row.requiresAck) throw new BadRequestException({ statusCode: 400, code: 'no_ack_needed', message: 'This announcement does not ask for acknowledgement' });
    if (!this.inAudience(me, row)) throw new ForbiddenException({ statusCode: 403, code: 'not_in_audience', message: 'This announcement is not addressed to you' });
    await commsDb(() =>
      this.prisma.$executeRaw`
        INSERT INTO "announcement_acks" ("announcement_id", "employee_id", "acked_at") VALUES (${row.id}::uuid, ${actor.id}::uuid, ${this.clock.now()})
        ON CONFLICT ("announcement_id", "employee_id") DO NOTHING`,
    );
    return this.detail(actor, id);
  }

  /** The people an announcement is for right now (active employees; never its author). Used by the notification reader too. */
  async audienceOf(db: Prisma.TransactionClient | PrismaService, announcementId: string): Promise<Array<{ id: string; empId: string }>> {
    const a = await db.announcement.findUnique({ where: { id: announcementId }, select: { authorId: true, audienceAll: true, departments: { select: { departmentId: true } } } });
    if (!a) return [];
    return db.employee.findMany({
      where: { status: { not: 'left' }, id: { not: a.authorId }, ...(a.audienceAll ? {} : { departmentId: { in: a.departments.map((d) => d.departmentId) } }) },
      select: { id: true, empId: true },
      orderBy: { empId: 'asc' },
    });
  }

  // ---------- helpers ----------

  private async viewer(actor: Actor) {
    const [employee, access] = await Promise.all([
      commsDb(() => this.prisma.employee.findUniqueOrThrow({ where: { id: actor.id }, select: { departmentId: true } })),
      this.permissions.getEffectiveAccess(actor.id),
    ]);
    return { actor, departmentId: employee.departmentId, canPublish: access.permissions.has(ANNOUNCEMENTS_PUBLISH), oversight: actor.levelNumber <= OVERSIGHT_MAX_LEVEL };
  }

  private visibleWhere(me: { actor: Actor; departmentId: string; oversight: boolean }): Prisma.AnnouncementWhereInput {
    if (me.oversight) return {};
    return { OR: [{ audienceAll: true }, { departments: { some: { departmentId: me.departmentId } } }, { authorId: me.actor.id }] };
  }

  private async visible(me: { actor: Actor; departmentId: string; oversight: boolean }, id: string): Promise<Row> {
    if (!/^[0-9a-f-]{36}$/i.test(id)) notFound();
    const row = await commsDb(() => this.prisma.announcement.findFirst({ where: { AND: [{ id }, this.visibleWhere(me)] }, include }));
    if (!row) notFound();
    return row!;
  }

  private inAudience(me: { actor: Actor; departmentId: string }, row: Row): boolean {
    if (row.authorId === me.actor.id) return false;
    return row.audienceAll || row.departments.some((d) => d.department.id === me.departmentId);
  }

  private async views(me: { actor: Actor; departmentId: string; canPublish: boolean }, rows: Row[]): Promise<AnnouncementView[]> {
    if (!rows.length) return [];
    const mine = await commsDb(() => this.prisma.announcementAck.findMany({ where: { employeeId: me.actor.id, announcementId: { in: rows.map((r) => r.id) } }, select: { announcementId: true } }));
    const acked = new Set(mine.map((a) => a.announcementId));
    const out: AnnouncementView[] = [];
    for (const r of rows) {
      const publisher = me.canPublish || r.authorId === me.actor.id;
      let progress: AnnouncementView['progress'] = null;
      if (publisher && r.requiresAck) {
        const audience = await commsDb(() => this.audienceOf(this.prisma, r.id));
        const acks = await commsDb(() => this.prisma.announcementAck.findMany({ where: { announcementId: r.id }, select: { employee: { select: { empId: true } } } }));
        const inAudience = new Set(audience.map((p) => p.empId));
        progress = { audienceEmpIds: audience.map((p) => p.empId), ackEmpIds: acks.map((a) => a.employee.empId).filter((e) => inAudience.has(e)).sort() };
      }
      out.push({
        id: r.id,
        title: r.title,
        body: r.body,
        authorEmpId: r.author.empId,
        audience: { all: r.audienceAll, departmentIds: r.departments.map((d) => d.department.code).sort() },
        pinned: r.pinned,
        requiresAck: r.requiresAck,
        createdAt: r.createdAt.toISOString(),
        inAudience: this.inAudience(me, r),
        acknowledgedByMe: acked.has(r.id),
        progress,
        can: { pin: me.canPublish },
      });
    }
    return out;
  }
}
