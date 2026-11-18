import { Injectable } from '@nestjs/common';
import type { ApprovalRouteStep } from '@aceva/contracts';
import type { Prisma } from '../generated/prisma/client';
import { HierarchyCache } from '../access/hierarchy.service';
import { ScopeService } from '../access/scope.service';
import { ApprovalsService } from '../approvals/approvals.service';
import { dbDate } from '../common/pakistan-time';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Who might have to decide someone's item. The decision itself is always checked against Module 1 routing
 * (ApprovalsService.route); this only narrows the lists: people below the caller, plus people below a manager the caller
 * stands in for today (a stand-in is not necessarily above the requester).
 */
@Injectable()
export class RoutingHelper {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly approvals: ApprovalsService,
    private readonly hierarchy: HierarchyCache,
  ) {}

  async standInFor(actorId: string, day: string): Promise<string[]> {
    const rows = await this.prisma.standIn.findMany({
      where: { standInId: actorId, revokedAt: null, startsOn: { lte: dbDate(day) }, endsOn: { gte: dbDate(day) } },
      select: { managerId: true },
    });
    return [...new Set(rows.map((r) => r.managerId))];
  }

  /** People whose requests the caller may see as a decider: below them, or below a manager they stand in for today. */
  async decidableWhere(actorId: string, day: string): Promise<Prisma.EmployeeWhereInput> {
    const managers = await this.standInFor(actorId, day);
    return {
      OR: [this.scope.employeeWhere(actorId, 'below'), ...managers.map((m) => this.scope.employeeWhere(m, 'below'))],
      NOT: { id: actorId },
    };
  }

  /** The person in the named Director role who has not left (the first by Emp-ID if there were ever two). */
  async director(): Promise<{ id: string; empId: string } | null> {
    return this.prisma.employee.findFirst({ where: { role: { key: 'director' }, status: { not: 'left' } }, orderBy: { empId: 'asc' }, select: { id: true, empId: true } });
  }

  /**
   * Who decides an attendance correction (decision D23) or a leave request (decision D24): the Director, for everyone the
   * Director is above, whatever their own manager. The step is still routed by Module 1 from the seat just below the
   * Director, so the Director's stand-in decides while the Director is away, and it moves further up (the CEO) when the
   * Director is away without one. The Director's own request, and anyone not below the Director (the CEO, the Owner), go
   * to their routed manager. With no active Director, every request goes to the routed manager.
   */
  async directorRoute(requesterEmpId: string, day: string): Promise<ApprovalRouteStep> {
    const director = await this.director();
    if (director && director.empId !== requesterEmpId) {
      const requester = await this.prisma.employee.findUnique({ where: { empId: requesterEmpId }, select: { id: true } });
      const chain = requester ? await this.hierarchy.getChain(requester.id) : [];
      const at = chain.indexOf(director.id);
      if (at > 0) {
        const belowDirector = await this.prisma.employee.findUniqueOrThrow({ where: { id: chain[at - 1] }, select: { empId: true } });
        return this.approvals.route(requesterEmpId, day, belowDirector.empId);
      }
    }
    return this.approvals.route(requesterEmpId, day);
  }
}
