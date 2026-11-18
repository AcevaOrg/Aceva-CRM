import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

/**
 * One id per HTTP request, available anywhere the request's code runs (services, the audit log, the activity recorder)
 * without passing it around. The audit log stores it in audit_log.request_id and the activity recorder in
 * activity_events.request_id, so activity search can show the old and new values a request wrote to the audit log.
 * The id is also sent back in the X-Request-Id response header (handy when someone reports a problem).
 */
export interface RequestContext {
  requestId: string;
  /** What a service told the activity recorder about this request (see noteActivity). */
  activity?: ActivityNote;
}

/**
 * Extra words for the activity record of the current request (Module 4). The recorder writes one record for every
 * request that changes something, by itself; a service only calls noteActivity() when it can say it better, for example
 * `noteActivity({ target: 'TSK-0142', description: 'Approved task TSK-0142' })`. Never put secrets or pay figures here.
 */
export interface ActivityNote {
  /** What it was about, as people see it (an Emp-ID, TSK-0142, PR-2026-11). */
  target?: string;
  /** The sentence for the timeline, for example "Approved leave request #58". */
  description?: string;
  /**
   * Record no target at all, even when the route has an id (the recorder would otherwise take the id from the URL). For a
   * private item, such as a personal to-do, whose id must not appear on anyone's timeline.
   */
  hideTarget?: boolean;
  /** Small structured extras (numbers, codes). Never secrets, never request bodies. */
  details?: Record<string, string | number | boolean | null>;
  /**
   * The request was refused for lack of permission even though the answer is not a 403 (finance answers "not found"
   * instead, plan section 16). The recorder then records a blocked attempt.
   */
  blocked?: boolean;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** The current request's id, or null outside a request (scheduled jobs, the outbox dispatcher). */
export function currentRequestId(): string | null {
  return storage.getStore()?.requestId ?? null;
}

/** The current request's context, or null outside a request. */
export function currentRequestContext(): RequestContext | null {
  return storage.getStore() ?? null;
}

/** Adds to the activity note of the current request (no effect outside a request). */
export function noteActivity(note: ActivityNote): void {
  const store = storage.getStore();
  if (!store) return;
  store.activity = { ...store.activity, ...note, details: { ...store.activity?.details, ...note.details } };
}

/** Express middleware, installed first by configureApp. Never trusts an id sent by the client. */
export function requestContextMiddleware(request: Request, response: Response, next: NextFunction): void {
  const context: RequestContext = { requestId: randomUUID() };
  request.requestId = context.requestId;
  response.setHeader('X-Request-Id', context.requestId);
  storage.run(context, () => next());
}

declare module 'express-serve-static-core' {
  interface Request {
    /** Set by requestContextMiddleware for every request. */
    requestId?: string;
  }
}
