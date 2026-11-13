import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { Actor, ScopeTarget } from './access.types';
import type { ScopeMode } from './scope.service';

export const IS_PUBLIC = 'access:public';
export const AUTHENTICATED_ONLY = 'access:authenticated';
export const REQUIRED_PERMISSIONS = 'access:permissions';
export const SCOPE_RULE = 'access:scope';
export const ALLOW_INCOMPLETE = 'access:allow-incomplete';
export const FINANCE_SCREEN = 'access:finance-screen';

/** No login needed (for example the health check, or the login itself). Use very sparingly. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Any logged-in employee may call this route; the data returned must still be scoped. */
export const Authenticated = () => SetMetadata(AUTHENTICATED_ONLY, true);

/**
 * The route may also be used while a login is unfinished (temporary password not yet changed, 2FA code not yet
 * entered). Only the routes that finish a login or end a session use this.
 */
export const AllowIncomplete = () => SetMetadata(ALLOW_INCOMPLETE, true);

/** A finance screen: the session is ended after 10 minutes without activity here (30 minutes elsewhere). */
/// Also (plan section 16): when the permission or scope check refuses a finance route, the answer is 404, not 403.
export const FinanceScreen = () => SetMetadata(FINANCE_SCREEN, true);

/** The caller's role or duties must include ALL of these permissions. */
export const RequirePermission = (...permissions: string[]) => SetMetadata(REQUIRED_PERMISSIONS, permissions);

/**
 * The route is about one employee (named by an Emp-ID in the URL). The guard checks the caller
 * may reach that employee through the reporting line: 'self_or_below' (own record or anyone
 * below) or 'below' (only people below, not themselves).
 */
export const Scope = (param: string, mode: ScopeMode = 'self_or_below') =>
  SetMetadata(SCOPE_RULE, { param, mode });

export const CurrentActor = createParamDecorator((_data: unknown, ctx: ExecutionContext): Actor => {
  const request = ctx.switchToHttp().getRequest<Request>();
  if (!request.actor) throw new Error('CurrentActor used on a route without authentication');
  return request.actor;
});

export const CurrentSessionId = createParamDecorator((_data: unknown, ctx: ExecutionContext): string | null => {
  return ctx.switchToHttp().getRequest<Request>().sessionId ?? null;
});

export const ScopedTarget = createParamDecorator((_data: unknown, ctx: ExecutionContext): ScopeTarget => {
  const request = ctx.switchToHttp().getRequest<Request>();
  if (!request.scopeTarget) throw new Error('ScopedTarget used on a route without @Scope');
  return request.scopeTarget;
});

/** Client details for audit records. */
export interface RequestInfo {
  ip: string | null;
  userAgent: string | null;
}

export const ClientInfo = createParamDecorator((_data: unknown, ctx: ExecutionContext): RequestInfo => {
  const request = ctx.switchToHttp().getRequest<Request>();
  return { ip: request.ip ?? null, userAgent: request.header('user-agent') ?? null };
});
