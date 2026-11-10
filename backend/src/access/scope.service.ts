import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type ScopeMode = 'self_or_below' | 'below';

/**
 * THE hierarchy data-scope rule (plan section 5):
 *   you see your own data and the data of everyone below you in your reporting line,
 *   and never anyone above or beside you.
 *
 * It is applied INSIDE the database query (through the reporting closure table), for list
 * requests and for single-record requests alike. The frontend is never trusted for this.
 *
 * Every module must filter its data through this service, for example:
 *     prisma.employee.findMany({ where: scope.employeeWhere(actorId) })
 *     prisma.task.findMany({ where: { assignee: scope.employeeWhere(actorId) } })
 */
@Injectable()
export class ScopeService {
  constructor(private readonly prisma: PrismaService) {}

  /** A Prisma "where" fragment that matches only employees the actor may see. */
  employeeWhere(actorId: string, mode: ScopeMode = 'self_or_below'): Prisma.EmployeeWhereInput {
    return {
      ancestors: {
        some: {
          ancestorId: actorId,
          ...(mode === 'below' ? { depth: { gt: 0 } } : {}),
        },
      },
    };
  }

  /** Single-record check, evaluated by the same database rule as the list filter. */
  async canAccess(actorId: string, targetId: string, mode: ScopeMode = 'self_or_below'): Promise<boolean> {
    const count = await this.prisma.employee.count({
      where: { id: targetId, ...this.employeeWhere(actorId, mode) },
    });
    return count > 0;
  }
}
