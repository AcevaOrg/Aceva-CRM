import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AccessMe } from '@aceva/contracts';
import type { Actor } from './access.types';
import { Authenticated, CurrentActor, RequirePermission } from './decorators';
import { PermissionService } from './permission.service';
import { PrismaService } from '../prisma/prisma.service';

@ApiTags('access')
@Controller('access')
export class AccessController {
  constructor(
    private readonly permissions: PermissionService,
    private readonly prisma: PrismaService,
  ) {}

  @Get('me')
  @Authenticated()
  @ApiOperation({ summary: 'Who am I, and what am I allowed to do? (role permissions plus duty permissions)' })
  async me(@CurrentActor() actor: Actor): Promise<AccessMe> {
    const access = await this.permissions.getEffectiveAccess(actor.id);
    return {
      empId: actor.empId,
      name: actor.fullName,
      level: actor.levelNumber,
      roleKey: actor.roleKey,
      duties: access.duties,
      permissions: [...access.permissions].sort(),
      twoFactorRequired: access.twoFactorRequired,
    };
  }

  @Get('roles')
  @RequirePermission('org.view')
  @ApiOperation({ summary: 'All roles with their level and permissions' })
  async roles() {
    const roles = await this.prisma.role.findMany({
      orderBy: [{ level: { number: 'asc' } }, { key: 'asc' }],
      select: {
        key: true,
        name: true,
        isDefault: true,
        level: { select: { number: true } },
        rolePermissions: { select: { permission: { select: { key: true } } } },
      },
    });
    return roles.map((r) => ({
      key: r.key,
      name: r.name,
      level: r.level.number,
      isDefault: r.isDefault,
      permissions: r.rolePermissions.map((p) => p.permission.key).sort(),
    }));
  }

  @Get('duties')
  @RequirePermission('org.view')
  @ApiOperation({ summary: 'All extra duties (Finance, HR) with their permissions' })
  async duties() {
    const duties = await this.prisma.duty.findMany({
      orderBy: { key: 'asc' },
      select: { key: true, name: true, requiresTwoFactor: true, dutyPermissions: { select: { permission: { select: { key: true } } } } },
    });
    return duties.map((d) => ({
      key: d.key,
      name: d.name,
      requiresTwoFactor: d.requiresTwoFactor,
      permissions: d.dutyPermissions.map((p) => p.permission.key).sort(),
    }));
  }

  @Get('permissions')
  @RequirePermission('org.view')
  @ApiOperation({ summary: 'The permission catalogue' })
  permissionCatalogue() {
    return this.prisma.permission.findMany({ orderBy: { key: 'asc' }, select: { key: true, module: true, description: true } });
  }
}
