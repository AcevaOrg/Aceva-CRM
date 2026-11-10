import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Db = PrismaService | Prisma.TransactionClient;

export interface EffectiveAccess {
  permissions: Set<string>;
  duties: string[];
  twoFactorRequired: boolean;
}

/**
 * What a person may do = the permissions of their ROLE plus the permissions of any ACTIVE DUTY
 * (for example Finance duty). Roles and duties are stored separately.
 * Always read from the database, so a change to a role or duty takes effect on the next request.
 */
@Injectable()
export class PermissionService {
  constructor(private readonly prisma: PrismaService) {}

  async getEffectiveAccess(employeeId: string, db: Db = this.prisma): Promise<EffectiveAccess> {
    const employee = await db.employee.findUniqueOrThrow({
      where: { id: employeeId },
      select: {
        level: { select: { number: true } },
        role: { select: { rolePermissions: { select: { permission: { select: { key: true } } } } } },
        duties: {
          where: { endedAt: null },
          select: {
            duty: {
              select: {
                key: true,
                requiresTwoFactor: true,
                dutyPermissions: { select: { permission: { select: { key: true } } } },
              },
            },
          },
        },
      },
    });

    const permissions = new Set<string>(employee.role.rolePermissions.map((rp) => rp.permission.key));
    const duties: string[] = [];
    let dutyNeeds2fa = false;
    for (const { duty } of employee.duties) {
      duties.push(duty.key);
      dutyNeeds2fa ||= duty.requiresTwoFactor;
      duty.dutyPermissions.forEach((dp) => permissions.add(dp.permission.key));
    }

    return {
      permissions,
      duties: duties.sort(),
      // Plan section 6: 2FA is mandatory for levels 1 to 3 and for anyone with Finance duty.
      twoFactorRequired: employee.level.number <= 3 || dutyNeeds2fa,
    };
  }

  async can(employeeId: string, permission: string, db: Db = this.prisma): Promise<boolean> {
    return (await this.getEffectiveAccess(employeeId, db)).permissions.has(permission);
  }

  /** People who are currently allowed to approve (used to validate stand-ins). */
  async canApprove(employeeId: string, db: Db = this.prisma): Promise<boolean> {
    return this.can(employeeId, 'approval.approve', db);
  }
}
