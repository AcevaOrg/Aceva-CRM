import { SetMetadata } from '@nestjs/common';
import type { ActivityActionName } from '@aceva/contracts';
import type { Request } from 'express';
import type { SensitiveCategory } from './rules/alert-rules';

/*
 * Decorators for the Module 4 action recorder (backend/src/activity/action-recorder.interceptor.ts).
 *
 * The recorder needs NO decorator for ordinary work: every request that creates, changes, approves or deletes something
 * (POST, PUT, PATCH, DELETE) and every GET whose path ends in /download, /export or /print is recorded automatically,
 * and every refused attempt (403) too. Use a decorator only to:
 *   - mark a READ of sensitive data (salary, payslip, bank details, CNIC, finance statements):   @SensitiveView(...)
 *   - name the action or the words better than the route does:                                  @RecordActivity(...)
 *   - keep a route out of the recorder because it records itself (heartbeats, screens):          @NotRecorded()
 * A service can also add words at run time with noteActivity() from common/request-context.ts.
 */

export const SENSITIVE_VIEW = 'activity:sensitive-view';
export const RECORD_ACTIVITY = 'activity:record';
export const NOT_RECORDED = 'activity:not-recorded';

export interface SensitiveViewOptions {
  /**
   * What kind of data was seen. salary, bank and payslip views count towards the "many salary records opened in a short
   * time" alert. A function receives the (already validated) request, for a route that reveals different things.
   */
  category: SensitiveCategory | ((request: Request) => SensitiveCategory);
  /** The timeline sentence; route parameters like :empId are filled in. Default: "Viewed ... of :empId". */
  describe?: string | ((request: Request) => string);
}

/**
 * The handler shows sensitive data: the recorder logs every successful call as a "sensitive view", even a GET, even
 * when nothing changed (plan section 8: "Opening someone's salary, payslip, bank details or a finance statement").
 */
export const SensitiveView = (options: SensitiveViewOptions) => SetMetadata(SENSITIVE_VIEW, options);

export interface RecordActivityOptions {
  /** Overrides the action worked out from the method and the path. */
  action?: ActivityActionName;
  /** Overrides the module worked out from the path (use the names the screens use). */
  module?: string;
  /** The timeline sentence; route parameters like :id are filled in. */
  describe?: string;
}

/** Records this handler (also a GET) and, optionally, names its action, module and words. */
export const RecordActivity = (options: RecordActivityOptions = {}) => SetMetadata(RECORD_ACTIVITY, options);

/** The recorder skips this handler (it writes its own records, like the heartbeat and screen signals). Use sparingly. */
export const NotRecorded = () => SetMetadata(NOT_RECORDED, true);
