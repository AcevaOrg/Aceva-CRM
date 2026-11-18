import { Injectable, NotFoundException } from '@nestjs/common';
import type { ConversationDetail, ConversationRole } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { PermissionService } from '../access/permission.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { commsDb } from './comms-errors';

type Db = PrismaService | Prisma.TransactionClient;

export const COMMS_ADMIN = 'comms.admin';

export const conversationInclude = { department: { select: { code: true, name: true, headEmployeeId: true } } } satisfies Prisma.ConversationInclude;
export type ConversationRow = Prisma.ConversationGetPayload<{ include: typeof conversationInclude }>;

/** The caller's place in a conversation. */
export interface MemberAccess {
  conversation: ConversationRow;
  /** False only for a comms admin managing a channel they are not a member of (they never see its messages). */
  member: boolean;
  role: ConversationRole;
  source: 'added' | 'department' | null;
  isAdmin: boolean;
  /**
   * The caller sees only messages with a higher number than this: their history starts when they became a member (added
   * by hand: conversation_members.joined_seq; through the department: department_channel_access.from_seq, 0 when they
   * were in the department before the channel existed). A member both ways keeps the earlier start.
   */
  fromSeq: number;
}

/** No history limit (used inside LEAST() for "not a member this way"). */
const NO_ACCESS = 2_147_483_647;

export interface EffectiveMember {
  employeeId: string;
  empId: string;
  fullName: string;
  role: ConversationRole;
  source: 'added' | 'department';
  active: boolean;
  /** This member sees only messages after this number (see MemberAccess.fromSeq). */
  fromSeq: number;
}

/** The same answer for "does not exist" and "not yours", so nobody can find out which conversations exist. */
export function notFound(): never {
  throw new NotFoundException({ statusCode: 404, code: 'not_found', message: 'Not found' });
}

/**
 * Who may see and do what in Module 14. Membership is ALWAYS read from the database at the moment of the request: the
 * member rows (people added by hand) plus, for a department channel, the department's current employees and its head as
 * the employee records say now. So moving someone to another department, or removing a member, takes effect at once.
 */
@Injectable()
export class CommsAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
  ) {}

  /** The caller's current department and whether they are a comms admin (read fresh for every request). */
  async actorContext(actor: Actor, db: Db = this.prisma): Promise<{ departmentId: string; isAdmin: boolean }> {
    return commsDb(async () => {
      const [employee, access] = await Promise.all([
        db.employee.findUniqueOrThrow({ where: { id: actor.id }, select: { departmentId: true } }),
        this.permissions.getEffectiveAccess(actor.id, db),
      ]);
      return { departmentId: employee.departmentId, isAdmin: access.permissions.has(COMMS_ADMIN) };
    });
  }

  /**
   * The caller must be a member of the conversation, otherwise 404 (never 403: a DM, group or channel the caller cannot
   * see must look exactly like one that does not exist). Used by EVERY read and write on a conversation or message.
   */
  async memberAccess(actor: Actor, conversationId: string, db: Db = this.prisma): Promise<MemberAccess> {
    const access = await this.resolve(actor, conversationId, db);
    if (!access?.member) notFound();
    return access;
  }

  /**
   * Like memberAccess, but a comms admin may also manage a channel they are not a member of (members, moderators, name,
   * archive), without seeing its messages. DMs and groups are never open to anyone outside them.
   */
  async manageAccess(actor: Actor, conversationId: string, db: Db = this.prisma): Promise<MemberAccess> {
    const access = await this.resolve(actor, conversationId, db);
    if (!access) notFound();
    if (access.member) return access;
    if (access.conversation.kind === 'channel' && access.isAdmin) return access;
    notFound();
  }

  private async resolve(actor: Actor, conversationId: string, db: Db): Promise<MemberAccess | null> {
    return commsDb(async () => {
      const [conversation, ctx, row, joined] = await Promise.all([
        db.conversation.findUnique({ where: { id: conversationId }, include: conversationInclude }),
        this.actorContext(actor, db),
        db.conversationMember.findUnique({ where: { conversationId_employeeId: { conversationId, employeeId: actor.id } }, select: { role: true, leftAt: true, joinedSeq: true } }),
        db.departmentChannelAccess.findUnique({ where: { conversationId_employeeId: { conversationId, employeeId: actor.id } }, select: { fromSeq: true } }),
      ]);
      if (!conversation) return null;
      const added = row && !row.leftAt ? row : null;
      const viaDepartment = this.inDepartment(conversation, actor.id, ctx.departmentId);
      const fromSeq = Math.min(added ? added.joinedSeq : NO_ACCESS, viaDepartment ? (joined?.fromSeq ?? 0) : NO_ACCESS);
      if (added) return { conversation, member: true, role: added.role, source: 'added', isAdmin: ctx.isAdmin, fromSeq };
      if (viaDepartment) return { conversation, member: true, role: 'member', source: 'department', isAdmin: ctx.isAdmin, fromSeq };
      return { conversation, member: false, role: 'member', source: null, isAdmin: ctx.isAdmin, fromSeq: conversation.lastSeq };
    });
  }

  private inDepartment(conversation: ConversationRow, employeeId: string, departmentId: string): boolean {
    if (conversation.channelScope !== 'department' || !conversation.departmentId) return false;
    return conversation.departmentId === departmentId || conversation.department?.headEmployeeId === employeeId;
  }

  /** Everyone who is a member right now: member rows, then (department channels) the department's current people and head. */
  async effectiveMembers(conversation: ConversationRow, db: Db = this.prisma): Promise<EffectiveMember[]> {
    return commsDb(async () => {
      const rows = await db.conversationMember.findMany({
        where: { conversationId: conversation.id, leftAt: null },
        select: { role: true, joinedSeq: true, employee: { select: { id: true, empId: true, fullName: true, status: true } } },
      });
      const members = new Map<string, EffectiveMember>();
      for (const r of rows) {
        members.set(r.employee.id, { employeeId: r.employee.id, empId: r.employee.empId, fullName: r.employee.fullName, role: r.role, source: 'added', active: r.employee.status !== 'left', fromSeq: r.joinedSeq });
      }
      if (conversation.channelScope === 'department' && conversation.departmentId) {
        const or: Prisma.EmployeeWhereInput[] = [{ departmentId: conversation.departmentId }];
        if (conversation.department?.headEmployeeId) or.push({ id: conversation.department.headEmployeeId });
        const [people, joined] = await Promise.all([
          db.employee.findMany({ where: { status: { not: 'left' }, OR: or }, select: { id: true, empId: true, fullName: true } }),
          db.departmentChannelAccess.findMany({ where: { conversationId: conversation.id }, select: { employeeId: true, fromSeq: true } }),
        ]);
        const joinedAt = new Map(joined.map((j) => [j.employeeId, j.fromSeq]));
        for (const p of people) {
          const viaDepartment = joinedAt.get(p.id) ?? 0;
          const added = members.get(p.id);
          if (added) added.fromSeq = Math.min(added.fromSeq, viaDepartment);
          else members.set(p.id, { employeeId: p.id, empId: p.empId, fullName: p.fullName, role: 'member', source: 'department', active: true, fromSeq: viaDepartment });
        }
      }
      return [...members.values()].sort((a, b) => a.empId.localeCompare(b.empId));
    });
  }

  /** What the caller may do here (the screens use it to show buttons; the services check the same rules). */
  capabilities(access: MemberAccess): ConversationDetail['can'] {
    const { conversation: c, member, role, source, isAdmin } = access;
    const open = !c.archivedAt;
    const moderator = member && role === 'moderator';
    const channelAdmin = c.kind === 'channel' && isAdmin;
    switch (c.kind) {
      case 'dm':
        return { post: open && member, rename: false, manageMembers: false, manageModerators: false, archive: false, pin: open && member, removeMessages: false, leave: false };
      case 'group':
        return { post: open && member, rename: open && moderator, manageMembers: open && moderator, manageModerators: open && moderator, archive: open && moderator, pin: open && member, removeMessages: moderator, leave: member && source === 'added' };
      case 'channel':
        return {
          post: open && member,
          rename: open && (moderator || channelAdmin),
          manageMembers: open && (moderator || channelAdmin),
          manageModerators: open && channelAdmin,
          archive: open && channelAdmin,
          pin: open && member && (moderator || channelAdmin),
          removeMessages: member && (moderator || channelAdmin),
          leave: member && source === 'added',
        };
    }
  }

  /**
   * SQL value: for conversation `c` (already known to be visible), the message number after which this employee's
   * history starts (MemberAccess.fromSeq, worked out in the database). Lists, search and saved messages compare m.seq to it.
   */
  historyFromSql(employeeId: string, departmentId: string): Prisma.Sql {
    return Prisma.sql`LEAST(
      COALESCE((SELECT cm."joined_seq" FROM "conversation_members" cm WHERE cm."conversation_id" = c."id" AND cm."employee_id" = ${employeeId}::uuid AND cm."left_at" IS NULL), ${NO_ACCESS}),
      CASE WHEN c."channel_scope" = 'department' AND (
        c."department_id" = ${departmentId}::uuid
        OR EXISTS (SELECT 1 FROM "departments" d WHERE d."id" = c."department_id" AND d."head_employee_id" = ${employeeId}::uuid)
      ) THEN COALESCE((SELECT a."from_seq" FROM "department_channel_access" a WHERE a."conversation_id" = c."id" AND a."employee_id" = ${employeeId}::uuid), 0)
      ELSE ${NO_ACCESS} END
    )`;
  }

  /**
   * SQL condition: conversation `c` is visible to this employee (a current member row, or a department channel of their
   * current department or of a department they head). Used by lists and search so they can never return anything else.
   */
  visibleSql(employeeId: string, departmentId: string): Prisma.Sql {
    return Prisma.sql`(
      EXISTS (SELECT 1 FROM "conversation_members" cm WHERE cm."conversation_id" = c."id" AND cm."employee_id" = ${employeeId}::uuid AND cm."left_at" IS NULL)
      OR (c."channel_scope" = 'department' AND (
        c."department_id" = ${departmentId}::uuid
        OR EXISTS (SELECT 1 FROM "departments" d WHERE d."id" = c."department_id" AND d."head_employee_id" = ${employeeId}::uuid)
      ))
    )`;
  }
}
