import { Injectable } from '@nestjs/common';
import type { Prisma } from '../generated/prisma/client';
import { ScopeService } from '../access/scope.service';
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
}
