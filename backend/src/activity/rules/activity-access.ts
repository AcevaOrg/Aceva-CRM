/**
 * Who sees and does what in Module 4 (plan section 8 "Who can see tracking data", spec section 9.4), adapted to the final
 * company structure. Pure functions: no Nest, no database. The screens use the same rules
 * (frontend/src/features/activity/logic.ts); the server is the real lock. Data scope (self, or the people below the
 * caller in the reporting line) is applied in the database by ScopeService on top of these rules.
 *
 *   Everyone (activity.view_own)       their own login history, devices and activity ("My activity")
 *   activity.view_team or view_all     daily summaries and the day summary of people below them (Reports, Timeline)
 *   activity.view_all                  also who is online now and the full timeline of people below them
 *   activity.view_all AND audit.view   activity search (the Director and the CEO / Founder / Owner)
 *   activity.security                  every security alert (the Director, the CTO, the CEO / Founder / Owner)
 *   session.force_logout (+ auth.unlock_account for locks)   the controls, for people below: the Director and the CTO.
 *                                      The CEO / Founder / Owner has none of them: he sees everything and acts on nothing.
 */

export interface ActivityAccess {
  online: boolean;
  timeline: boolean;
  /** The full timeline (screens and actions) of someone else, not only their day summary. */
  fullTimeline: boolean;
  search: boolean;
  reports: boolean;
  alerts: boolean;
  /** Force sign-out of a session (someone below). */
  forceLogout: boolean;
  /** Lock and unlock accounts from the activity screens (someone below). */
  lockAccounts: boolean;
}

export function activityAccess(permissions: ReadonlySet<string>): ActivityAccess {
  const has = (p: string) => permissions.has(p);
  const manager = has('activity.view_all') || has('activity.view_team');
  return {
    online: has('activity.view_all'),
    timeline: manager,
    fullTimeline: has('activity.view_all'),
    search: has('activity.view_all') && has('audit.view'),
    reports: manager,
    alerts: has('activity.security'),
    forceLogout: has('session.force_logout'),
    lockAccounts: has('session.force_logout') && has('auth.unlock_account'),
  };
}

/** What the caller gets for one person's day. */
export type TimelineView = 'full' | 'summary' | 'refused';

/**
 * One person's timeline: always your own; for someone else you need the timeline right AND the person must be below you
 * in your reporting line. Without activity.view_all you see their day summary but not the screens and actions.
 */
export function timelineView(access: ActivityAccess, isSelf: boolean, targetIsBelow: boolean): TimelineView {
  if (isSelf) return 'full';
  if (!access.timeline || !targetIsBelow) return 'refused';
  return access.fullTimeline ? 'full' : 'summary';
}

/**
 * Which recorded events count as "actions" in the daily summary: things the person did (created, changed, approved,
 * deleted, viewed something sensitive, exported...). Logins, logouts, screens opened, refused attempts and the security
 * events Module 2 reports about an account are not actions. An administrator's own security action (unlocking someone,
 * forcing a sign-out) was made through a request, so it carries a request id and counts.
 */
const ACTION_KINDS = new Set([
  'create', 'edit', 'delete', 'submit', 'assign', 'approve', 'reject', 'comment', 'upload', 'download', 'export', 'print', 'sensitive_view',
]);

export function countsAsAction(event: { action: string; requestId: string | null; source?: string }): boolean {
  if (event.source && event.source !== 'aceva') return false; // sales-tool work counts are reported separately (Module 16)
  if (ACTION_KINDS.has(event.action)) return true;
  return event.action === 'security' && event.requestId !== null;
}

/**
 * "Tasks touched" until Module 5 registers its own source (ActivitySummaryHooks.useTasksTouched): the number of
 * different tasks the person acted on that day, from their recorded actions in the Tasks module. 0 while Module 5 does
 * not exist (there are no such actions).
 */
export function tasksTouchedFromEvents(events: Array<{ action: string; module: string; target: string | null; requestId: string | null }>): number {
  const tasks = new Set<string>();
  for (const e of events) if (e.module === 'Tasks' && e.target && countsAsAction(e)) tasks.add(e.target);
  return tasks.size;
}

/**
 * The words a screen signal is recorded with. A normal screen keeps the browser's own label (it is the person's own
 * screen). A REFUSED finance screen is worded from the server's label of the page (its module), never from the browser:
 * those words go into the finance-attempts alert and its email to the Director and the CTO, and a page must not be able
 * to put its own text there.
 */
export function screenWords(facts: { label: string; module: string; refused: boolean }): { target: string; description: string } {
  if (facts.refused) return { target: facts.module, description: `Tried to open ${facts.module} (no permission)` };
  return { target: facts.label, description: `Opened ${facts.label}` };
}

/**
 * A light per-session or per-person limit for the signals the browser sends (heartbeats, screens, export records), so a
 * broken or hostile page cannot flood the tracking tables. Not a security boundary: each server copy keeps its own
 * counts in memory.
 */
export class SignalThrottle {
  private readonly hits = new Map<string, number[]>();

  /** At most `max` signals per `windowMs` for one key. */
  constructor(
    private readonly max: number,
    private readonly windowMs: number,
  ) {}

  /** True when this signal may be recorded (and counts it). */
  allow(key: string, nowMs: number): boolean {
    const recent = (this.hits.get(key) ?? []).filter((t) => nowMs - t < this.windowMs);
    const ok = recent.length < this.max;
    if (ok) recent.push(nowMs);
    this.hits.set(key, recent);
    if (this.hits.size > 10_000) this.prune(nowMs);
    return ok;
  }

  private prune(nowMs: number): void {
    for (const [key, times] of this.hits) if (times.every((t) => nowMs - t >= this.windowMs)) this.hits.delete(key);
  }
}

/**
 * A limit per session AND per person, for a signal that creates permanent records and mail (an export record). The
 * person's limit stops a flood spread over many sessions: signing in again does not give a new allowance.
 */
export class PersonSignalThrottle {
  private readonly sessions: SignalThrottle;
  private readonly people: SignalThrottle;

  constructor(perSession: number, perPerson: number, windowMs: number) {
    this.sessions = new SignalThrottle(perSession, windowMs);
    this.people = new SignalThrottle(perPerson, windowMs);
  }

  /** True when this signal may be recorded. A signal refused by the session limit does not use up the person's allowance. */
  allow(personId: string, sessionId: string | null, nowMs: number): boolean {
    if (sessionId && !this.sessions.allow(sessionId, nowMs)) return false;
    return this.people.allow(personId, nowMs);
  }
}
