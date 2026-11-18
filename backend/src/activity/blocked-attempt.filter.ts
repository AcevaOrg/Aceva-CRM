import { ArgumentsHost, Catch, HttpException, Injectable, Logger } from '@nestjs/common';
import { BaseExceptionFilter } from '@nestjs/core';
import type { Request } from 'express';
import { Clock } from '../common/clock';
import { currentRequestContext } from '../common/request-context';
import { paramsOf, routeOf } from './action-recorder.interceptor';
import { ActivityRecorder } from './activity-recorder.service';
import { classifyBlocked, isRecordedElsewhere, withoutPrefix } from './rules/activity-classify';

/**
 * 403 answers that are NOT "you may not do this": an unfinished login, a missing confirm-again, a stale page (CSRF), a
 * request from another website, and the login screen's own refusals. They are not blocked attempts.
 */
const NOT_A_REFUSAL = new Set(['auth_incomplete', 'step_up_required', 'csrf_invalid', 'origin_not_allowed', 'too_many_wrong_codes', 'two_factor_required']);

/**
 * Records refused attempts (plan section 8 "Blocked attempts: trying to open a screen or record the person is not allowed
 * to see"). Global (APP_FILTER), because the AccessGuard refuses BEFORE interceptors run; services refuse with a 403 from
 * inside the handler; both arrive here. A finance module that answers "not found" instead of 403 (plan section 16) calls
 * noteActivity({ blocked: true }) before throwing, and the 404 is recorded as a blocked attempt too.
 *
 * After noting the attempt it hands the error to Nest's standard handling (BaseExceptionFilter), so every error answer
 * stays exactly as before.
 */
@Catch()
@Injectable()
export class BlockedAttemptFilter extends BaseExceptionFilter {
  private readonly log = new Logger('BlockedAttempts');

  constructor(
    private readonly recorder: ActivityRecorder,
    private readonly clock: Clock,
  ) {
    super();
  }

  override catch(exception: unknown, host: ArgumentsHost): void {
    if (host.getType() === 'http') {
      try {
        this.note(exception, host.switchToHttp().getRequest<Request>());
      } catch (error) {
        this.log.error(`Could not record a refused attempt: ${(error as Error).message}`);
      }
    }
    super.catch(exception, host);
  }

  private note(exception: unknown, request: Request): void {
    const actor = request.actor;
    if (!actor || !(exception instanceof HttpException)) return;
    const status = exception.getStatus();
    const flagged = currentRequestContext()?.activity?.blocked === true;
    const body = exception.getResponse();
    const code = typeof body === 'object' && body !== null ? (body as { code?: unknown }).code : undefined;
    const refused = (status === 403 && !(typeof code === 'string' && NOT_A_REFUSAL.has(code))) || (flagged && (status === 403 || status === 404));
    if (!refused) return;
    const route = routeOf(request);
    if (!route || isRecordedElsewhere(route)) return;
    const params = paramsOf(request);
    const classified = classifyBlocked({ method: request.method, route, params });
    this.recorder.record({
      employeeId: actor.id,
      empId: actor.empId,
      occurredAt: this.clock.now(),
      action: 'blocked',
      module: classified.module,
      description: classified.description,
      target: classified.target,
      sessionId: request.sessionId ?? null,
      ip: request.ip ?? null,
      requestId: request.requestId ?? null,
      financeLinked: classified.financeLinked,
      details: { route: `${request.method.toUpperCase()} ${withoutPrefix(route)}`, status, ...(typeof code === 'string' ? { code: code.slice(0, 60) } : {}) },
    });
  }
}
