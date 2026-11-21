import { BadRequestException, ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import {
  GROUP_MAX_MEMBERS,
  type AddMembersInput,
  type AdminChannelView,
  type ConversationDetail,
  type ConversationRole,
  type ConversationSummary,
  type CreateConversationInput,
  type CursorPage,
  type UpdateConversationInput,
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
import { CommsRealtimePublisher } from './realtime/comms-realtime.publisher';

type Tx = Prisma.TransactionClient;

const archivedConversation = (): never => {
  throw new ConflictException({ statusCode: 409, code: 'conversation_archived', message: 'This conversation is archived: it can be read but not changed' });
};

const forbidden = (message = 'You cannot do this in this conversation'): never => {
  throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message });
};

/** Conversations, their members and moderators, and each person's read position (Module 14, part 1). */
@Injectable()
export class ConversationService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CommsAccessService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly realtime: CommsRealtimePublisher,
  ) {}

  // ---------- Reading ----------

  /** The caller's conversations, most recently active first. */
  async list(actor: Actor, query: { cursor?: string; limit: number }): Promise<CursorPage<ConversationSummary>> {
    const ctx = await this.access.actorContext(actor);
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await commsDb(() =>
      this.prisma.$queryRaw<Array<{ id: string; activity: Date }>>`
        SELECT c."id", COALESCE(c."last_message_at", c."created_at") AS activity
        FROM "conversations" c
        WHERE ${this.access.visibleSql(actor.id, ctx.departmentId)}
        ${after ? Prisma.sql`AND (COALESCE(c."last_message_at", c."created_at"), c."id") < (${after.at}::timestamptz, ${after.id}::uuid)` : Prisma.empty}
        ORDER BY activity DESC, c."id" DESC
        LIMIT ${query.limit + 1}`,
    );
    const page = rows.slice(0, query.limit);
    const conversations = await commsDb(() => this.prisma.conversation.findMany({ where: { id: { in: page.map((r) => r.id) } }, include: conversationInclude }));
    const byId = new Map(conversations.map((c) => [c.id, c]));
    const roles = await commsDb(() => this.prisma.conversationMember.findMany({ where: { employeeId: actor.id, leftAt: null, conversationId: { in: page.map((r) => r.id) } }, select: { conversationId: true, role: true } }));
    const roleOf = new Map(roles.map((r) => [r.conversationId, r.role]));
    const summaries = await this.summaries(actor.id, ctx.departmentId, page.map((r) => byId.get(r.id)!), (c) => roleOf.get(c.id) ?? 'member');
    const last = rows.length > query.limit ? page[page.length - 1] : null;
    return { items: summaries, nextCursor: last ? encodeCursor(last.activity, last.id) : null };
  }

  async detail(actor: Actor, conversationId: string): Promise<ConversationDetail> {
    return this.detailFor(actor, await this.access.manageAccess(actor, conversationId));
  }

  private async detailFor(actor: Actor, access: MemberAccess): Promise<ConversationDetail> {
    const c = access.conversation;
    const ctx = await this.access.actorContext(actor);
    const [summary] = await this.summaries(actor.id, ctx.departmentId, [c], () => access.role, access.member);
    const members = await this.access.effectiveMembers(c);
    const read = await commsDb(() => this.prisma.conversationRead.findUnique({ where: { conversationId_employeeId: { conversationId: c.id, employeeId: actor.id } } }));
    let receipts: ConversationDetail['receipts'] = null;
    if (c.kind !== 'channel' && access.member) {
      const reads = await commsDb(() => this.prisma.conversationRead.findMany({ where: { conversationId: c.id } }));
      const byId = new Map(reads.map((r) => [r.employeeId, r]));
      receipts = members.filter((m) => m.active).map((m) => ({ empId: m.empId, lastDeliveredSeq: byId.get(m.employeeId)?.lastDeliveredSeq ?? 0, lastReadSeq: byId.get(m.employeeId)?.lastReadSeq ?? 0 }));
    }
    const pins = access.member
      ? await commsDb(() => this.prisma.pinnedMessage.findMany({ where: { conversationId: c.id, message: { seq: { gt: access.fromSeq } } }, orderBy: { pinnedAt: 'desc' }, select: { messageId: true } }))
      : [];
    return {
      ...summary,
      members: members.map((m) => ({ empId: m.empId, fullName: m.fullName, role: m.role, source: m.source, active: m.active })),
      readState: { lastDeliveredSeq: read?.lastDeliveredSeq ?? 0, lastReadSeq: read?.lastReadSeq ?? 0 },
      receipts,
      pinnedMessageIds: pins.map((p) => p.messageId),
      can: this.access.capabilities(access),
    };
  }

  /**
   * Summaries for the given conversations. Message-derived fields are left out for a viewer who is not a member, and only
   * count messages inside the viewer's history (after the message number at which they became a member).
   */
  private async summaries(viewerId: string, departmentId: string, conversations: ConversationRow[], roleOf: (c: ConversationRow) => ConversationRole, member = true): Promise<ConversationSummary[]> {
    if (!conversations.length) return [];
    const ids = conversations.map((c) => c.id);
    return commsDb(async () => {
      const [unread, dmPeople, lastMessages] = await Promise.all([
        member
          ? this.prisma.$queryRaw<Array<{ id: string; unread: number; from_seq: number }>>`
              SELECT h."id", h."from_seq", (
                SELECT count(*)::int FROM "messages" m
                WHERE m."conversation_id" = h."id" AND m."deleted_at" IS NULL AND m."author_id" <> ${viewerId}::uuid
                  AND m."seq" > GREATEST(h."from_seq", COALESCE((SELECT r."last_read_seq" FROM "conversation_reads" r WHERE r."conversation_id" = h."id" AND r."employee_id" = ${viewerId}::uuid), 0))
              ) AS unread
              FROM (
                SELECT c."id", ${this.access.historyFromSql(viewerId, departmentId)} AS from_seq
                FROM "conversations" c WHERE c."id" IN (${Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`))})
              ) h`
          : Promise.resolve([]),
        this.prisma.conversationMember.findMany({
          where: { conversationId: { in: conversations.filter((c) => c.kind === 'dm').map((c) => c.id) }, employeeId: { not: viewerId } },
          select: { conversationId: true, employee: { select: { empId: true, fullName: true } } },
        }),
        member
          ? this.prisma.message.findMany({
              where: { OR: conversations.filter((c) => c.lastSeq > 0).map((c) => ({ conversationId: c.id, seq: c.lastSeq })) },
              select: { conversationId: true, seq: true, body: true, deletedAt: true, author: { select: { empId: true } } },
            })
          : Promise.resolve([]),
      ]);
      const unreadOf = new Map(unread.map((u) => [u.id, u.unread]));
      const fromSeqOf = new Map(unread.map((u) => [u.id, u.from_seq]));
      const dmOf = new Map(dmPeople.map((p) => [p.conversationId, p.employee]));
      const lastOf = new Map(lastMessages.map((m) => [m.conversationId, m]));
      return conversations.map((c): ConversationSummary => {
        const candidate = lastOf.get(c.id);
        // The last message is shown only when it is inside the viewer's history.
        const last = candidate && candidate.seq > (fromSeqOf.get(c.id) ?? c.lastSeq) ? candidate : null;
        return {
          id: c.id,
          kind: c.kind,
          scope: c.channelScope,
          name: c.name,
          topic: c.topic,
          departmentId: c.department?.code ?? null,
          departmentName: c.department?.name ?? null,
          projectName: c.projectName,
          projectCode: c.projectCode,
          dmWith: dmOf.get(c.id) ?? null,
          archived: !!c.archivedAt,
          lastSeq: member ? c.lastSeq : 0,
          lastMessageAt: member ? (c.lastMessageAt?.toISOString() ?? null) : null,
          unread: unreadOf.get(c.id) ?? 0,
          myRole: roleOf(c),
          lastMessage: last ? { seq: last.seq, authorEmpId: last.author.empId, preview: last.deletedAt ? '' : last.body.slice(0, 140), deleted: !!last.deletedAt } : null,
        };
      });
    });
  }

  /** comms.admin: every channel with its members and moderators (never its messages). */
  async adminChannels(query: { cursor?: string; limit: number }): Promise<CursorPage<AdminChannelView>> {
    const after = query.cursor ? decodeCursor(query.cursor) : null;
    const rows = await commsDb(() =>
      this.prisma.conversation.findMany({
        where: { kind: 'channel', ...(after ? { OR: [{ createdAt: { lt: after.at } }, { createdAt: after.at, id: { lt: after.id } }] } : {}) },
        include: conversationInclude,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: query.limit + 1,
      }),
    );
    const page = rows.slice(0, query.limit);
    const items: AdminChannelView[] = [];
    for (const c of page) {
      const members = await this.access.effectiveMembers(c);
      items.push({
        id: c.id,
        scope: c.channelScope!,
        name: c.name!,
        topic: c.topic,
        departmentId: c.department?.code ?? null,
        projectName: c.projectName,
        projectCode: c.projectCode,
        archived: !!c.archivedAt,
        memberCount: members.filter((m) => m.active).length,
        moderatorEmpIds: members.filter((m) => m.role === 'moderator').map((m) => m.empId),
      });
    }
    const last = rows.length > query.limit ? page[page.length - 1] : null;
    return { items, nextCursor: last ? encodeCursor(last.createdAt, last.id) : null };
  }

  // ---------- Creating ----------

  async create(actor: Actor, input: CreateConversationInput, client: RequestInfo): Promise<{ conversation: ConversationDetail; created: boolean }> {
    const now = this.clock.now();
    const record = (tx: Tx, c: { id: string }, details: Prisma.InputJsonValue) =>
      this.audit.record({ actorId: actor.id, action: 'comms.conversation.created', targetType: 'conversation', targetId: c.id, details, ...client }, tx);

    if (input.kind === 'dm') {
      if (input.empId === actor.empId) throw new BadRequestException({ statusCode: 400, code: 'cannot_message_self', message: 'Choose a colleague' });
      const [other] = await this.activePeople([input.empId]);
      const dmKey = [actor.id, other.id].sort().join(':');
      const existing = await commsDb(() => this.prisma.conversation.findUnique({ where: { dmKey }, select: { id: true } }));
      if (existing) return { conversation: await this.detail(actor, existing.id), created: false };
      try {
        const id = await commsDb(() =>
          this.prisma.$transaction(async (tx) => {
            const c = await tx.conversation.create({ data: { kind: 'dm', dmKey, createdById: actor.id, createdAt: now, updatedAt: now }, select: { id: true } });
            await tx.conversationMember.createMany({ data: [actor.id, other.id].map((employeeId) => ({ conversationId: c.id, employeeId, addedById: actor.id, joinedAt: now, updatedAt: now })) });
            await record(tx, c, { kind: 'dm', withEmpId: other.empId });
            return c.id;
          }),
        );
        await this.realtime.conversationChanged(id);
        return { conversation: await this.detail(actor, id), created: true };
      } catch (error) {
        // Two "start a DM" requests at the same moment: the second one gets the first one's conversation.
        if (!(error instanceof CommsDbError && error.unique)) throw error;
        const again = await commsDb(() => this.prisma.conversation.findUnique({ where: { dmKey }, select: { id: true } }));
        if (!again) throw error;
        return { conversation: await this.detail(actor, again.id), created: false };
      }
    }

    if (input.kind === 'group') {
      const people = await this.activePeople(input.memberEmpIds.filter((e) => e !== actor.empId));
      if (!people.length) throw new BadRequestException({ statusCode: 400, code: 'invalid_members', message: 'Choose at least one colleague' });
      if (people.length + 1 > GROUP_MAX_MEMBERS) throw new BadRequestException({ statusCode: 400, code: 'too_many_members', message: `A group can have at most ${GROUP_MAX_MEMBERS} people` });
      const id = await commsDb(() =>
        this.prisma.$transaction(async (tx) => {
          const c = await tx.conversation.create({ data: { kind: 'group', name: input.name ?? null, createdById: actor.id, createdAt: now, updatedAt: now }, select: { id: true } });
          await tx.conversationMember.createMany({
            data: [
              { conversationId: c.id, employeeId: actor.id, role: 'moderator' as const, addedById: actor.id, joinedAt: now, updatedAt: now },
              ...people.map((p) => ({ conversationId: c.id, employeeId: p.id, role: 'member' as const, addedById: actor.id, joinedAt: now, updatedAt: now })),
            ],
          });
          await record(tx, c, { kind: 'group', memberCount: people.length + 1 });
          return c.id;
        }),
      );
      await this.realtime.conversationChanged(id);
      return { conversation: await this.detail(actor, id), created: true };
    }

    // Channels: comms admins only (plan: "Admins can create channels, set moderators").
    const ctx = await this.access.actorContext(actor);
    if (!ctx.isAdmin) forbidden('Only communication admins can create channels');
    let departmentId: string | null = null;
    if (input.scope === 'department') {
      const department = await commsDb(() => this.prisma.department.findFirst({ where: { code: input.departmentId!, archivedAt: null }, select: { id: true } }));
      if (!department) throw new BadRequestException({ statusCode: 400, code: 'unknown_department', message: 'That department does not exist or is deactivated' });
      departmentId = department.id;
    }
    const moderators = await this.activePeople(input.moderatorEmpIds.filter((e) => e !== actor.empId));
    const members = await this.activePeople(input.memberEmpIds.filter((e) => e !== actor.empId && !input.moderatorEmpIds.includes(e)));
    const id = await commsDb(() =>
      this.prisma.$transaction(async (tx) => {
        const c = await tx.conversation.create({
          data: {
            kind: 'channel',
            channelScope: input.scope,
            name: input.name,
            topic: input.topic || null,
            departmentId,
            projectName: input.scope === 'project' ? input.projectName! : null,
            projectCode: input.scope === 'project' ? (input.projectCode ?? null) : null,
            createdById: actor.id,
            createdAt: now,
            updatedAt: now,
          },
          select: { id: true },
        });
        await tx.conversationMember.createMany({
          data: [
            { conversationId: c.id, employeeId: actor.id, role: 'moderator' as const, addedById: actor.id, joinedAt: now, updatedAt: now },
            ...moderators.map((p) => ({ conversationId: c.id, employeeId: p.id, role: 'moderator' as const, addedById: actor.id, joinedAt: now, updatedAt: now })),
            ...members.map((p) => ({ conversationId: c.id, employeeId: p.id, role: 'member' as const, addedById: actor.id, joinedAt: now, updatedAt: now })),
          ],
        });
        await record(tx, c, { kind: 'channel', scope: input.scope, name: input.name, departmentId: input.departmentId ?? null, projectCode: input.projectCode ?? null, moderators: [actor.empId, ...moderators.map((m) => m.empId)], addedMembers: members.length });
        return c.id;
      }),
    );
    await this.realtime.conversationChanged(id);
    return { conversation: await this.detail(actor, id), created: true };
  }

  /** Employees by Emp-ID who have not left the company; anyone unknown or gone is refused. */
  private async activePeople(empIds: string[]): Promise<Array<{ id: string; empId: string }>> {
    if (!empIds.length) return [];
    const found = await commsDb(() => this.prisma.employee.findMany({ where: { empId: { in: empIds }, status: { not: 'left' } }, select: { id: true, empId: true } }));
    const missing = empIds.filter((e) => !found.some((f) => f.empId === e));
    if (missing.length) {
      throw new BadRequestException({ statusCode: 400, code: 'unknown_or_inactive_employee', message: 'Some of these people are not current employees', empIds: missing });
    }
    return empIds.map((e) => found.find((f) => f.empId === e)!);
  }

  // ---------- Managing ----------

  async update(actor: Actor, conversationId: string, input: UpdateConversationInput, client: RequestInfo): Promise<ConversationDetail> {
    const access = await this.access.manageAccess(actor, conversationId);
    const c = access.conversation;
    if (c.kind === 'dm') throw new ConflictException({ statusCode: 409, code: 'not_for_dm', message: 'A direct message has no name or topic' });
    if (c.archivedAt) archivedConversation();
    if (!this.access.capabilities(access).rename) forbidden();
    if ((input.projectName !== undefined || input.projectCode !== undefined) && c.channelScope !== 'project') {
      throw new BadRequestException({ statusCode: 400, code: 'not_a_project_channel', message: 'Only a project channel has a project name and code' });
    }
    const data: Prisma.ConversationUpdateInput = { updatedAt: this.clock.now() };
    if (input.name !== undefined) data.name = input.name;
    if (input.topic !== undefined) data.topic = input.topic || null;
    if (input.projectName !== undefined) data.projectName = input.projectName;
    if (input.projectCode !== undefined) data.projectCode = input.projectCode;
    await commsDb(() =>
      this.prisma.$transaction(async (tx) => {
        await tx.conversation.update({ where: { id: c.id }, data });
        await this.audit.record({ actorId: actor.id, action: 'comms.conversation.updated', targetType: 'conversation', targetId: c.id, details: { changed: Object.keys(input).filter((k) => input[k as keyof UpdateConversationInput] !== undefined) }, ...client }, tx);
      }),
    );
    await this.realtime.conversationChanged(c.id);
    return this.detail(actor, c.id);
  }

  async addMembers(actor: Actor, conversationId: string, input: AddMembersInput, client: RequestInfo): Promise<ConversationDetail> {
    const access = await this.access.manageAccess(actor, conversationId);
    const c = access.conversation;
    if (c.kind === 'dm') throw new ConflictException({ statusCode: 409, code: 'not_for_dm', message: 'A direct message is always between the same two people' });
    if (c.archivedAt) archivedConversation();
    if (!this.access.capabilities(access).manageMembers) forbidden();
    const people = await this.activePeople(input.empIds);
    const current = await this.access.effectiveMembers(c);
    const currentIds = new Set(current.map((m) => m.employeeId));
    const adding = people.filter((p) => !currentIds.has(p.id));
    if (c.kind === 'group' && current.filter((m) => m.active).length + adding.length > GROUP_MAX_MEMBERS) {
      throw new BadRequestException({ statusCode: 400, code: 'too_many_members', message: `A group can have at most ${GROUP_MAX_MEMBERS} people` });
    }
    if (adding.length) {
      const now = this.clock.now();
      await commsDb(() =>
        this.prisma.$transaction(async (tx) => {
          const joinedSeq = await this.lockedLastSeq(tx, c.id);
          for (const p of adding) {
            await tx.conversationMember.upsert({
              where: { conversationId_employeeId: { conversationId: c.id, employeeId: p.id } },
              create: { conversationId: c.id, employeeId: p.id, role: 'member', addedById: actor.id, joinedSeq, joinedAt: now, updatedAt: now },
              update: { role: 'member', addedById: actor.id, joinedSeq, joinedAt: now, leftAt: null, removedById: null, updatedAt: now },
            });
          }
          await this.audit.record({ actorId: actor.id, action: 'comms.member.added', targetType: 'conversation', targetId: c.id, details: { empIds: adding.map((p) => p.empId) }, ...client }, tx);
        }),
      );
      await this.realtime.conversationChanged(c.id);
    }
    return this.detail(actor, c.id);
  }

  /** Remove a member (moderators; admins for channels), or leave (the caller's own Emp-ID). */
  async removeMember(actor: Actor, conversationId: string, empId: string, client: RequestInfo): Promise<{ removed: boolean }> {
    const leaving = empId === actor.empId;
    const access = leaving ? await this.access.memberAccess(actor, conversationId) : await this.access.manageAccess(actor, conversationId);
    const c = access.conversation;
    if (c.kind === 'dm') throw new ConflictException({ statusCode: 409, code: 'not_for_dm', message: 'A direct message is always between the same two people' });
    if (!leaving && !this.access.capabilities(access).manageMembers) forbidden();
    const target = await commsDb(() => this.prisma.employee.findUnique({ where: { empId }, select: { id: true, empId: true } }));
    if (!target) notFound();
    const row = await commsDb(() => this.prisma.conversationMember.findUnique({ where: { conversationId_employeeId: { conversationId: c.id, employeeId: target.id } } }));
    if (!row || row.leftAt) {
      if (c.channelScope === 'department' && (await this.stillInDepartment(c, target.id))) {
        throw new ConflictException({ statusCode: 409, code: 'department_member', message: 'Members of a department channel follow the employee records: they stay while they are in the department' });
      }
      throw new BadRequestException({ statusCode: 400, code: 'not_a_member', message: 'This person is not a member' });
    }
    // In a channel, only a comms admin removes a moderator.
    if (!leaving && c.kind === 'channel' && row.role === 'moderator' && !access.isAdmin) forbidden('Only communication admins can remove a moderator');
    const now = this.clock.now();
    // Someone removed from a department channel who is still in that department keeps access through the department.
    const stillMember = c.channelScope === 'department' && (await this.stillInDepartment(c, target.id));
    await commsDb(() =>
      this.prisma.$transaction(async (tx) => {
        await tx.conversationMember.update({ where: { id: row.id }, data: { leftAt: now, removedById: actor.id, role: 'member', updatedAt: now } });
        await this.audit.record({ actorId: actor.id, action: leaving ? 'comms.member.left' : 'comms.member.removed', targetType: 'conversation', targetId: c.id, details: { empId: target.empId, wasModerator: row.role === 'moderator' }, ...client }, tx);
        if (!stillMember) {
          await this.outbox.emit({ type: 'comms.member.removed', actor: actor.empId, payload: { conversationId: c.id, empId: target.empId, byEmpId: actor.empId, reason: leaving ? 'left' : 'removed' } }, tx);
        }
      }),
    );
    // Live sockets: every server re-checks this conversation's recipients; the removed person's sockets leave its room.
    await this.realtime.conversationChanged(c.id);
    return { removed: true };
  }

  private async stillInDepartment(c: ConversationRow, employeeId: string): Promise<boolean> {
    if (!c.departmentId) return false;
    if (c.department?.headEmployeeId === employeeId) return true;
    const e = await commsDb(() => this.prisma.employee.findUnique({ where: { id: employeeId }, select: { departmentId: true, status: true } }));
    return !!e && e.status !== 'left' && e.departmentId === c.departmentId;
  }

  async setModerator(actor: Actor, conversationId: string, empId: string, moderator: boolean, client: RequestInfo): Promise<ConversationDetail> {
    const access = await this.access.manageAccess(actor, conversationId);
    const c = access.conversation;
    if (c.kind === 'dm') throw new ConflictException({ statusCode: 409, code: 'not_for_dm', message: 'A direct message has no moderators' });
    if (c.archivedAt) archivedConversation();
    if (!this.access.capabilities(access).manageModerators) forbidden();
    const [person] = await this.activePeople([empId]);
    const row = await commsDb(() => this.prisma.conversationMember.findUnique({ where: { conversationId_employeeId: { conversationId: c.id, employeeId: person.id } } }));
    const active = row && !row.leftAt;
    const now = this.clock.now();
    if (moderator) {
      if (!active && c.kind === 'group') throw new BadRequestException({ statusCode: 400, code: 'not_a_member', message: 'Add this person to the group first' });
      if (active && row.role === 'moderator') return this.detail(actor, c.id);
    } else if (!active || row.role !== 'moderator') {
      return this.detail(actor, c.id);
    }
    await commsDb(() =>
      this.prisma.$transaction(async (tx) => {
        const joinedSeq = await this.lockedLastSeq(tx, c.id);
        await tx.conversationMember.upsert({
          where: { conversationId_employeeId: { conversationId: c.id, employeeId: person.id } },
          // A channel moderator who was not a member yet becomes one, with history from now on.
          create: { conversationId: c.id, employeeId: person.id, role: 'moderator', addedById: actor.id, joinedSeq, joinedAt: now, updatedAt: now },
          update: active ? { role: moderator ? 'moderator' : 'member', updatedAt: now } : { role: 'moderator', addedById: actor.id, joinedSeq, joinedAt: now, leftAt: null, removedById: null, updatedAt: now },
        });
        await this.audit.record({ actorId: actor.id, action: moderator ? 'comms.moderator.added' : 'comms.moderator.removed', targetType: 'conversation', targetId: c.id, details: { empId: person.empId }, ...client }, tx);
      }),
    );
    await this.realtime.conversationChanged(c.id);
    return this.detail(actor, c.id);
  }

  async archive(actor: Actor, conversationId: string, reason: string, client: RequestInfo): Promise<ConversationDetail> {
    const access = await this.access.manageAccess(actor, conversationId);
    const c = access.conversation;
    if (c.kind === 'dm') throw new ConflictException({ statusCode: 409, code: 'not_for_dm', message: 'A direct message cannot be archived' });
    if (c.archivedAt) return this.detail(actor, c.id);
    if (!this.access.capabilities(access).archive) forbidden();
    const now = this.clock.now();
    await commsDb(() =>
      this.prisma.$transaction(async (tx) => {
        await tx.conversation.update({ where: { id: c.id }, data: { archivedAt: now, archivedById: actor.id, updatedAt: now } });
        await this.audit.record({ actorId: actor.id, action: 'comms.conversation.archived', targetType: 'conversation', targetId: c.id, reason, details: { kind: c.kind }, ...client }, tx);
      }),
    );
    await this.realtime.conversationChanged(c.id);
    return this.detail(actor, c.id);
  }

  /**
   * The conversation's last message number, read under its row lock: a send in progress finishes first, so a person
   * added now sees exactly the messages numbered after this one.
   */
  private async lockedLastSeq(tx: Tx, conversationId: string): Promise<number> {
    const [row] = await tx.$queryRaw<Array<{ last_seq: number }>>`SELECT "last_seq" FROM "conversations" WHERE "id" = ${conversationId}::uuid FOR UPDATE`;
    return row.last_seq;
  }

  // ---------- Read positions ----------

  /** Up to which message the caller has received (delivered) or read. Positions only move forward. */
  async mark(actor: Actor, conversationId: string, seq: number, what: 'read' | 'delivered'): Promise<{ lastDeliveredSeq: number; lastReadSeq: number; unread: number }> {
    const { conversation: c } = await this.access.memberAccess(actor, conversationId);
    const upTo = Math.min(seq, c.lastSeq);
    const now = this.clock.now();
    await commsDb(() =>
      what === 'read'
        ? this.prisma.$executeRaw`
            INSERT INTO "conversation_reads" ("conversation_id", "employee_id", "last_delivered_seq", "last_read_seq", "updated_at")
            VALUES (${c.id}::uuid, ${actor.id}::uuid, ${upTo}, ${upTo}, ${now})
            ON CONFLICT ("conversation_id", "employee_id") DO UPDATE SET
              "last_read_seq" = GREATEST("conversation_reads"."last_read_seq", EXCLUDED."last_read_seq"),
              "last_delivered_seq" = GREATEST("conversation_reads"."last_delivered_seq", EXCLUDED."last_delivered_seq"),
              "updated_at" = EXCLUDED."updated_at"`
        : this.prisma.$executeRaw`
            INSERT INTO "conversation_reads" ("conversation_id", "employee_id", "last_delivered_seq", "last_read_seq", "updated_at")
            VALUES (${c.id}::uuid, ${actor.id}::uuid, ${upTo}, 0, ${now})
            ON CONFLICT ("conversation_id", "employee_id") DO UPDATE SET
              "last_delivered_seq" = GREATEST("conversation_reads"."last_delivered_seq", EXCLUDED."last_delivered_seq"),
              "updated_at" = EXCLUDED."updated_at"`,
    );
    await this.realtime.receipt(c.id, actor.id);
    const ctx = await this.access.actorContext(actor);
    const [summary] = await this.summaries(actor.id, ctx.departmentId, [c], () => 'member');
    const read = await commsDb(() => this.prisma.conversationRead.findUniqueOrThrow({ where: { conversationId_employeeId: { conversationId: c.id, employeeId: actor.id } } }));
    return { lastDeliveredSeq: read.lastDeliveredSeq, lastReadSeq: read.lastReadSeq, unread: summary.unread };
  }
}
