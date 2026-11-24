import { Injectable } from '@nestjs/common';
import type { Actor } from '../access/access.types';
import { PermissionService } from '../access/permission.service';
import { ScopeService } from '../access/scope.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { badRequest, type Db, forbidden } from './sales-errors';

/** Every sales screen and route needs this (the Sales role, the Director, the sales-manager duty; the CEO / Owner views). */
export const SALES_OWN = 'sales.own';
/** The whole sales team in the caller's reporting line (sales manager; the Director; the CEO / Owner views). */
export const SALES_TEAM = 'sales.team';
/** Every sales record (the Director; the CEO / Owner views). */
export const SALES_ALL = 'sales.all';
/**
 * The sales MANAGER's actions: moving leads between people, giving a new lead to someone else, editing team members'
 * leads. Plan section 20 lists these with "sets targets" as the sales manager's work, and sales.targets is the key the
 * catalogue gives exactly the sales manager (the Director and the sales-manager duty) and not the CEO / Owner, who only
 * views (decisions D23-D25). No new permission key is added.
 */
export const SALES_MANAGE = 'sales.targets';

/** What the caller may do in Module 15, read from their role and duties for this request. */
export interface SalesAccess {
  actor: Actor;
  own: boolean;
  team: boolean;
  all: boolean;
  manage: boolean;
}

/**
 * Who sees what in Module 15 (plan section 20 "Who can do what" and section 16 "Confidential: the prospect list"):
 *  - a salesperson sees their OWN leads in full; someone else's lead only as "it exists, and who owns it";
 *  - sales.team sees the leads of everyone in their reporting line (themselves and below), sales.all every lead;
 *  - the sales manager (SALES_MANAGE) also changes team members' leads and moves leads between people, but only for
 *    people in their reporting line;
 *  - everyone without sales.own has no access at all (the routes refuse them).
 * The reporting line is THE data scope of the whole system (ScopeService, plan section 5), applied in the database query.
 */
@Injectable()
export class SalesAccessService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly scope: ScopeService,
  ) {}

  async of(actor: Actor, db: Db = this.prisma): Promise<SalesAccess> {
    const { permissions } = await this.permissions.getEffectiveAccess(actor.id, db);
    return {
      actor,
      own: permissions.has(SALES_OWN),
      team: permissions.has(SALES_TEAM),
      all: permissions.has(SALES_ALL),
      manage: permissions.has(SALES_MANAGE),
    };
  }

  /** The leads the caller may see in full, as a database filter. */
  leadWhere(a: SalesAccess): Prisma.SalesLeadWhereInput {
    if (a.all) return {};
    if (a.team) return { owner: this.scope.employeeWhere(a.actor.id) };
    return { ownerId: a.actor.id };
  }

  /** Whether the caller sees a lead of `ownerId` in full. */
  async seesFull(a: SalesAccess, ownerId: string): Promise<boolean> {
    if (a.all || ownerId === a.actor.id) return true;
    return a.team ? this.scope.canAccess(a.actor.id, ownerId) : false;
  }

  /** The owner edits their own lead; the sales manager edits the leads of people in their reporting line. */
  async canEdit(a: SalesAccess, ownerId: string): Promise<boolean> {
    if (ownerId === a.actor.id) return true;
    return this.canManage(a, ownerId);
  }

  /** The sales manager, for a lead owned by someone in their reporting line. */
  async canManage(a: SalesAccess, ownerId: string): Promise<boolean> {
    return a.manage ? this.scope.canAccess(a.actor.id, ownerId) : false;
  }

  /** Of these owners, the ones whose leads the caller manages (one query for a whole list). */
  async manageableOwners(a: SalesAccess, ownerIds: string[], db: Db = this.prisma): Promise<Set<string>> {
    if (!a.manage || !ownerIds.length) return new Set();
    const rows = await db.employee.findMany({ where: { id: { in: [...new Set(ownerIds)] }, ...this.scope.employeeWhere(a.actor.id) }, select: { id: true } });
    return new Set(rows.map((r) => r.id));
  }

  /**
   * The person who will own a lead the sales manager assigns: active (not leaving or left), holding sales.own, and in the
   * manager's reporting line. Returns their internal id.
   */
  async assignableOwner(a: SalesAccess, empId: string, db: Db = this.prisma): Promise<{ id: string; empId: string }> {
    if (!a.manage) forbidden('not_allowed', 'Only the sales manager gives leads to other people');
    const person = await db.employee.findUnique({ where: { empId }, select: { id: true, empId: true, status: true } });
    if (!person || !(await this.scope.canAccess(a.actor.id, person.id))) badRequest('unknown_owner', `${empId} is not in your sales team`);
    if (person.status !== 'active') badRequest('owner_not_active', `${empId} is not an active employee`);
    if (!(await this.permissions.can(person.id, SALES_OWN, db))) badRequest('owner_not_sales', `${empId} does not work on sales leads`);
    return { id: person.id, empId: person.empId };
  }
}
