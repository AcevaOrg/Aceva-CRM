import { createParamDecorator, ExecutionContext, SetMetadata } from '@nestjs/common';
import type { Request } from 'express';
import type { Actor, ScopeTarget } from './access.types';
import type { ScopeMode } from './scope.service';

export const IS_PUBLIC = 'access:public';
export const AUTHENTICATED_ONLY = 'access:authenticated';
export const REQUIRED_PERMISSIONS = 'access:permissions';
export const SCOPE_RULE = 'access:scope';

/** No login needed (for example the health check). Use very sparingly. */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Any logged-in employee may call this route; the data returned must still be scoped. */
export const Authenticated = () => SetMetadata(AUTHENTICATED_ONLY, true);

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
