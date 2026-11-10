import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ApprovalRouteStep } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { HierarchyCache } from '../access/hierarchy.service';
import { PermissionService } from '../access/permission.service';
import { ScopeService } from '../access/scope.service';
import { type AwayPeriod, canAssignTask, isSelfApproval, resolveApprover } from '../access/rules/approval-routing';
import { PrismaService } from '../prisma/prisma.service';

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The shared approval and task-direction rules that other modules (leave, payroll, finance,
 * tasks...) call, so every module follows the same fixed business rules:
 *  - nobody approves their own request, expense or finance entry
 *  - approvals move up one reporting relationship at a time (to a stand-in during leave)
 *  - tasks move down the reporting line
 */
@Injectable()
export class ApprovalsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly hierarchy: HierarchyCache,
    private readonly permissions: PermissionService,
    private readonly scope: ScopeService,
  ) {}

  /** Who should approve the requester's item on `onDate`? Pass `afterSeatEmpId` to go one step further up. */
  async route(requesterEmpId: string, onDate: string = isoDay(new Date()), afterSeatEmpId?: string): Promise<ApprovalRouteStep> {
    const requester = await this.prisma.employee.findUnique({ where: { empId: requesterEmpId }, select: { id: true } });
    if (!requester) throw new NotFoundException('Employee not found');

    const chain = await this.hierarchy.getChain(requester.id);
    const afterSeat = afterSeatEmpId
      ? await this.prisma.employee.findUnique({ where: { empId: afterSeatEmpId }, select: { id: true } })
      : null;

    const periods = await this.prisma.standIn.findMany({
      where: {
        managerId: { in: chain },
        revokedAt: null,
        startsOn: { lte: new Date(`${onDate}T00:00:00.000Z`) },
        endsOn: { gte: new Date(`${onDate}T00:00:00.000Z`) },
      },
      select: { managerId: true, standInId: true, startsOn: true, endsOn: true },
    });
    const away: AwayPeriod[] = periods.map((p) => ({
      managerId: p.managerId,
      standInId: p.standInId,
      startsOn: isoDay(p.startsOn),
      endsOn: isoDay(p.endsOn),
    }));

    // A stand-in is only used while they are still active and still allowed to approve.
    const authorized = new Set<string>();
    for (const id of new Set(away.map((a) => a.standInId).filter((v): v is string => !!v))) {
      const person = await this.prisma.employee.findUnique({ where: { id }, select: { status: true } });
      if (person && person.status !== 'left' && (await this.permissions.canApprove(id))) authorized.add(id);
    }

    const inactive = new Set((await this.prisma.employee.findMany({ where: { id: { in: chain }, status: 'left' }, select: { id: true } })).map((p) => p.id));

    const result = resolveApprover({
      requesterId: requester.id,
      inactiveIds: inactive,
      chain,
      away,
      onDate,
      afterSeatId: afterSeat?.id ?? (afterSeatEmpId ? '__unknown__' : null),
      authorizedStandInIds: authorized,
    });

    const ids = [result.approverId, result.seatId, ...result.skipped.map((s) => s.seatId)].filter((v): v is string => !!v);
    const people = await this.prisma.employee.findMany({ where: { id: { in: ids } }, select: { id: true, empId: true } });
    const empIdOf = new Map(people.map((p) => [p.id, p.empId]));

    return {
      approver: result.approverId ? empIdOf.get(result.approverId)! : null,
      seat: result.seatId ? empIdOf.get(result.seatId)! : null,
      via: result.via,
      skipped: result.skipped.map((s) => ({ seat: empIdOf.get(s.seatId)!, reason: s.reason })),
    };
  }

  /** May `actor` approve the requester's item right now? (never their own, only the routed approver) */
  async canApprove(actor: Actor, requesterEmpId: string, onDate?: string, afterSeatEmpId?: string): Promise<{ allowed: boolean; reason?: string }> {
    if (isSelfApproval(actor.empId, requesterEmpId)) return { allowed: false, reason: 'self_approval' };
    const step = await this.route(requesterEmpId, onDate, afterSeatEmpId);
    if (step.approver !== actor.empId) return { allowed: false, reason: 'not_the_routed_approver' };
    return { allowed: true };
  }

  /** Throws unless `actor` is the routed approver. Other modules call this before approving anything. */
  async assertCanApprove(actor: Actor, requesterEmpId: string, onDate?: string, afterSeatEmpId?: string): Promise<void> {
    const result = await this.canApprove(actor, requesterEmpId, onDate, afterSeatEmpId);
    if (!result.allowed) throw new ForbiddenException(`You cannot approve this (${result.reason})`);
  }

  /** Tasks move down: may `actor` assign a task to this employee? */
  async canAssignTask(actor: Actor, assigneeEmpId: string): Promise<boolean> {
    const assignee = await this.prisma.employee.findUnique({ where: { empId: assigneeEmpId }, select: { id: true } });
    if (!assignee) throw new NotFoundException('Employee not found');
    const below = new Set(await this.hierarchy.getDownlineIds(actor.id));
    return canAssignTask(actor.id, assignee.id, below) && (await this.scope.canAccess(actor.id, assignee.id, 'below'));
  }
}
