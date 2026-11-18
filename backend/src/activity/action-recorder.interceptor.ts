import { CallHandler, ExecutionContext, Injectable, Logger, NestInterceptor } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import type { Request } from 'express';
import { Observable, tap } from 'rxjs';
import { Clock } from '../common/clock';
import { currentRequestContext, type RequestContext } from '../common/request-context';
import { NOT_RECORDED, RECORD_ACTIVITY, SENSITIVE_VIEW, type RecordActivityOptions, type SensitiveViewOptions } from './activity.decorators';
import { ActivityRecorder } from './activity-recorder.service';
import { changesData, classifyRequest, fill, isRecordedElsewhere, withoutPrefix } from './rules/activity-classify';
import type { SensitiveCategory } from './rules/alert-rules';

/** The route pattern Express matched, for example /api/v1/employees/:empId/basic (null when no route matched). */
export function routeOf(request: Request): string | null {
  const path = (request.route as { path?: unknown } | undefined)?.path;
  return typeof path === 'string' ? path : null;
}

/** Route parameters as plain strings (never the body or the query string). */
export function paramsOf(request: Request): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries((request.params ?? {}) as Record<string, unknown>)) {
    if (typeof value === 'string') out[key] = value.slice(0, 120);
  }
  return out;
}

/** GETs that hand data out of the system are recorded like changes: /download, /export, /print. */
export function readsOut(method: string, route: string): boolean {
  const last = withoutPrefix(route).split('/').filter(Boolean).pop();
  return method.toUpperCase() === 'GET' && (last === 'download' || last === 'export' || last === 'print');
}

const FINANCE_CATEGORIES = new Set<SensitiveCategory>(['salary', 'bank', 'payslip', 'finance_statement']);
const CATEGORY_WORDS: Record<SensitiveCategory, string> = {
  salary: 'the salary',
  bank: 'the bank details',
  payslip: 'a payslip',
  personal: 'personal details',
  finance_statement: 'a finance statement',
};

interface Plan {
  route: string;
  sensitive?: SensitiveViewOptions;
  record?: RecordActivityOptions;
}

/**
 * The Module 4 action recorder (plan section 8: "a recorder on the server logs every request that creates, changes,
 * approves or deletes something, plus every sensitive view. Developers do not have to remember to log").
 *
 * Global (APP_INTERCEPTOR). After a request SUCCEEDS it records, for the logged-in person:
 *   - every POST, PUT, PATCH and DELETE;
 *   - every GET ending in /download, /export or /print;
 *   - every handler marked @SensitiveView (salary, payslip, bank details, finance statements) or @RecordActivity.
 * It never reads request bodies or query strings: only the method, the route pattern, the route parameters and what a
 * service said with noteActivity(). Refused attempts are recorded by BlockedAttemptFilter (the AccessGuard refuses
 * before interceptors run). Logins, logouts and the person's own security changes come from the Module 2 events instead
 * (isRecordedElsewhere). The record goes to ActivityRecorder's buffer: the request does not wait for the database.
 */
@Injectable()
export class ActionRecorderInterceptor implements NestInterceptor {
  private readonly logger = new Logger('ActionRecorder');

  constructor(
    private readonly reflector: Reflector,
    private readonly recorder: ActivityRecorder,
    private readonly clock: Clock,
  ) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (context.getType() !== 'http') return next.handle();
    const request = context.switchToHttp().getRequest<Request>();
    const plan = this.plan(request, context);
    if (!plan) return next.handle();
    const requestContext = currentRequestContext();
    return next.handle().pipe(
      tap({
        next: () => {
          try {
            this.recordSuccess(request, plan, requestContext);
          } catch (error) {
            // Never fail a request that succeeded because its activity record could not be prepared.
            this.logger.error(`Could not record ${request.method} ${plan.route}: ${(error as Error).message}`);
          }
        },
      }),
    );
  }

  private plan(request: Request, context: ExecutionContext): Plan | null {
    if (!request.actor) return null; // public routes: the login itself is recorded from the Module 2 event
    const route = routeOf(request);
    if (!route || isRecordedElsewhere(route)) return null;
    const targets = [context.getHandler(), context.getClass()];
    if (this.reflector.getAllAndOverride<boolean>(NOT_RECORDED, targets)) return null;
    const sensitive = this.reflector.getAllAndOverride<SensitiveViewOptions | undefined>(SENSITIVE_VIEW, targets);
    const record = this.reflector.getAllAndOverride<RecordActivityOptions | undefined>(RECORD_ACTIVITY, targets);
    if (!sensitive && !record && !changesData(request.method) && !readsOut(request.method, route)) return null;
    return { route, sensitive, record };
  }

  private recordSuccess(request: Request, plan: Plan, context: RequestContext | null): void {
    const actor = request.actor!;
    const params = paramsOf(request);
    const note = context?.activity;
    let category: SensitiveCategory | null = null;
    let override: { action?: RecordActivityOptions['action']; module?: string; description?: string } = {};

    if (plan.sensitive) {
      category = typeof plan.sensitive.category === 'function' ? plan.sensitive.category(request) : plan.sensitive.category;
      const words =
        typeof plan.sensitive.describe === 'function'
          ? plan.sensitive.describe(request)
          : (plan.sensitive.describe ?? `Viewed ${CATEGORY_WORDS[category] ?? 'sensitive data'}${params.empId ? ' of :empId' : ''}`);
      override = { action: 'sensitive_view', description: fill(words, params) };
    } else if (plan.record) {
      override = { action: plan.record.action, module: plan.record.module, description: plan.record.describe ? fill(plan.record.describe, params) : undefined };
    }
    if (note?.description) override.description = note.description;

    const classified = classifyRequest({ method: request.method, route: plan.route, params }, override);
    this.recorder.record({
      employeeId: actor.id,
      empId: actor.empId,
      occurredAt: this.clock.now(),
      action: classified.action,
      module: classified.module,
      description: classified.description,
      target: note?.target ?? classified.target,
      sessionId: request.sessionId ?? null,
      ip: request.ip ?? null,
      requestId: request.requestId ?? null,
      financeLinked: classified.financeLinked || (category !== null && FINANCE_CATEGORIES.has(category)),
      details: {
        route: `${request.method.toUpperCase()} ${withoutPrefix(plan.route)}`,
        ...(category ? { category } : {}),
        ...(note?.details ?? {}),
      },
    });
  }
}
