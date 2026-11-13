import { CanActivate, ExecutionContext, ForbiddenException, Inject, Injectable, NotFoundException, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { CryptoService } from '../auth/crypto.service';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { IdentityProvider } from '../identity/identity.provider';
import { PrismaService } from '../prisma/prisma.service';
import type { Actor } from './access.types';
import { AuditService } from './audit.service';
import { ALLOW_INCOMPLETE, AUTHENTICATED_ONLY, FINANCE_SCREEN, IS_PUBLIC, REQUIRED_PERMISSIONS, SCOPE_RULE } from './decorators';
import { PermissionService } from './permission.service';
import { ScopeMode, ScopeService } from './scope.service';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * The server-side lock on EVERY route (plan section 5, "How it works"). For each request:
 *   0. a request that changes data must come from our own website (Origin check)
 *   1. identify the logged-in employee from the session      -> otherwise 401
 *   2. a finished login is required (password changed, 2FA done)  -> otherwise 403 auth_incomplete
 *   3. a change request must carry this session's CSRF token  -> otherwise 403
 *   4. check their role/duty has the permission               -> otherwise 403
 *   5. check the hierarchy scope (when the route names an employee) -> otherwise 403
 *   6. every rejection is written to the audit log
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
    private readonly crypto: CryptoService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    const request = context.switchToHttp().getRequest<Request>();
    const route = `${request.method} ${request.route?.path ?? request.path}`;
    const client = { ip: request.ip ?? null, userAgent: request.header('user-agent') ?? null };
    const isPublic = !!this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets);
    const changesData = !SAFE_METHODS.has(request.method);

    // 0. Origin check: browsers always say where a request came from. A different website cannot change data here.
    const origin = request.header('origin');
    if (changesData && origin && origin !== this.env.CORS_ORIGIN) {
      await this.audit.record({ actorId: null, action: 'access.denied', targetType: 'route', targetId: route, outcome: 'denied', reason: 'origin_not_allowed', ...client });
      throw new ForbiddenException({ statusCode: 403, code: 'origin_not_allowed', message: 'This request did not come from the Aceva website' });
    }
    if (isPublic) return true;

    // 1. Who is calling?
    const financeScreen = !!this.reflector.getAllAndOverride<boolean>(FINANCE_SCREEN, targets);
    const identity = await this.identity.resolve(request, { financeScreen });
    const actor = identity ? await this.loadActor(identity.empId) : null;
    if (!identity || !actor) {
      await this.audit.record({ actorId: null, action: 'access.denied', targetType: 'route', targetId: route, outcome: 'denied', reason: 'unauthenticated', ...client });
      throw new UnauthorizedException({ statusCode: 401, code: 'unauthenticated', message: 'Please log in' });
    }
    request.actor = actor;
    request.sessionId = identity.sessionId;

    const deny = async (reason: string, details: Record<string, string>, code = 'forbidden'): Promise<never> => {
      await this.audit.record({ actorId: actor.id, action: 'access.denied', targetType: 'route', targetId: route, outcome: 'denied', reason, details, ...client });
      // Plan section 16: for anyone without finance access, finance (and payroll) links return "not found", so the
      // screens do not even reveal that they exist. The refusal is still audited above.
      if (financeScreen && (reason === 'missing_permission' || reason === 'out_of_scope')) {
        throw new NotFoundException({ statusCode: 404, code: 'not_found', message: 'Not found' });
      }
      throw new ForbiddenException({ statusCode: 403, code, message: 'You do not have access to this' });
    };

    // 2. An unfinished login may only finish logging in.
    if (identity.stage !== 'ok' && !this.reflector.getAllAndOverride<boolean>(ALLOW_INCOMPLETE, targets)) {
      throw new ForbiddenException({ statusCode: 403, code: 'auth_incomplete', message: 'Finish logging in first', stage: identity.stage });
    }

    // 3. CSRF: the page must send the token it received at login. A forged request from another site cannot know it.
    if (changesData && identity.csrfHash) {
      const sent = request.header('x-csrf-token');
      if (!sent || !this.crypto.safeEqual(this.crypto.sha256(sent), identity.csrfHash)) {
        return deny('csrf_invalid', {}, 'csrf_invalid');
      }
    }

    // 4. Does their role / duty allow this action?
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

    // 5. Is the employee this request is about inside their reporting line?
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
