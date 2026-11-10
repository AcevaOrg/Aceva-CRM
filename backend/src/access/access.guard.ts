import { CanActivate, ExecutionContext, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { IdentityProvider } from '../identity/identity.provider';
import { PrismaService } from '../prisma/prisma.service';
import type { Actor } from './access.types';
import { AuditService } from './audit.service';
import { AUTHENTICATED_ONLY, IS_PUBLIC, REQUIRED_PERMISSIONS, SCOPE_RULE } from './decorators';
import { PermissionService } from './permission.service';
import { ScopeMode, ScopeService } from './scope.service';

/**
 * The server-side lock on EVERY route (plan section 5, "How it works"). For each request:
 *   1. identify the logged-in employee            -> otherwise 401
 *   2. check their role/duty has the permission   -> otherwise 403
 *   3. check the hierarchy scope (when the route names an employee) -> otherwise 403
 *   4. every rejection is written to the audit log
 *
 * Fail-closed: a route with no access rule at all is refused, so a forgotten decorator can
 * never expose data. (Buttons hidden in the frontend are a convenience, never the protection.)
 */
@Injectable()
export class AccessGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly identity: IdentityProvider,
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets)) return true;

    const request = context.switchToHttp().getRequest<Request>();
    const route = `${request.method} ${request.route?.path ?? request.path}`;
    const client = { ip: request.ip ?? null, userAgent: request.header('user-agent') ?? null };

    // 1. Who is calling?
    const empId = await this.identity.resolveEmpId(request);
    const actor = empId ? await this.loadActor(empId) : null;
    if (!actor) {
      await this.audit.record({
        actorId: null,
        action: 'access.denied',
        targetType: 'route',
        targetId: route,
        outcome: 'denied',
        reason: 'unauthenticated',
        ...client,
      });
      throw new UnauthorizedException('Please log in');
    }
    request.actor = actor;

    const deny = async (reason: string, details: Record<string, string>): Promise<never> => {
      await this.audit.record({
        actorId: actor.id,
        action: 'access.denied',
        targetType: 'route',
        targetId: route,
        outcome: 'denied',
        reason,
        details,
        ...client,
      });
      throw new ForbiddenException('You do not have access to this');
    };

    // 2. Does their role / duty allow this action?
    const required = this.reflector.getAllAndOverride<string[] | undefined>(REQUIRED_PERMISSIONS, targets);
    const authenticatedOnly = this.reflector.getAllAndOverride<boolean>(AUTHENTICATED_ONLY, targets);
    if (!required && !authenticatedOnly) {
      return deny('route_has_no_access_rule', {});
    }
    if (required?.length) {
      const access = await this.permissions.getEffectiveAccess(actor.id);
      const missing = required.filter((p) => !access.permissions.has(p));
      if (missing.length) {
        return deny('missing_permission', { missing: missing.join(',') });
      }
    }

    // 3. Is the employee this request is about inside their reporting line?
    const rule = this.reflector.getAllAndOverride<{ param: string; mode: ScopeMode } | undefined>(SCOPE_RULE, targets);
    if (rule) {
      const targetEmpId = String(request.params[rule.param] ?? '');
      const target = await this.prisma.employee.findUnique({
        where: { empId: targetEmpId },
        select: { id: true, empId: true },
      });
      if (!target) throw new NotFoundException('Employee not found');
      if (!(await this.scope.canAccess(actor.id, target.id, rule.mode))) {
        return deny('out_of_scope', { target: target.empId });
      }
      request.scopeTarget = target;
    }
    return true;
  }

  private async loadActor(empId: string): Promise<Actor | null> {
    const employee = await this.prisma.employee.findUnique({
      where: { empId },
      select: { id: true, empId: true, fullName: true, status: true, level: { select: { number: true } }, role: { select: { key: true } } },
    });
    if (!employee || employee.status === 'left') return null; // people who have left cannot act
    return {
      id: employee.id,
      empId: employee.empId,
      fullName: employee.fullName,
      levelNumber: employee.level.number,
      roleKey: employee.role.key,
    };
  }
}
