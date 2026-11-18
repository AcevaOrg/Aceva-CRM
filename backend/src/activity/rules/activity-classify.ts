/**
 * How a request, a logout or a device becomes an activity record (plan section 8). Pure functions: no Nest, no database.
 * The recorder never reads request bodies or query strings (they can hold passwords, codes or personal data): only the
 * method, the route, the route parameters and the outcome.
 */
import type { ActivityActionName, LogoutHow } from '@aceva/contracts';

/** Every API path starts with this (configureApp sets it). Routes are matched without it. */
export const API_PREFIX = '/api/v1';

export function withoutPrefix(path: string): string {
  return path.startsWith(API_PREFIX) ? path.slice(API_PREFIX.length) || '/' : path;
}

/**
 * Longest prefix wins. Used for API routes and for website pages (screens opened): the few page paths that differ from
 * the API paths are listed too. EVERY label here must also be in ACTIVITY_MODULES (packages/contracts/src/activity.ts):
 * the activity search "Module" filter is built from that list, and activity-access.test.ts fails when one is missing.
 */
const MODULE_BY_PREFIX: Array<[string, string]> = [
  ['/', 'Home'],
  ['/auth', 'Login'],
  ['/account', 'Login'],
  ['/people', 'People'],
  ['/employees', 'People'],
  ['/hire-requests', 'People'],
  ['/org', 'Org'],
  ['/access', 'Org'],
  ['/stand-ins', 'Org'],
  ['/approvals', 'Approvals'],
  ['/activity', 'Activity'],
  ['/sessions', 'Activity'],
  ['/accounts', 'Activity'],
  ['/tasks', 'Tasks'],
  ['/projects', 'Tasks'],
  ['/performance', 'Performance'],
  ['/scorecards', 'Performance'],
  ['/disputes', 'Performance'],
  ['/attendance', 'Attendance'],
  ['/leave', 'Leave'],
  ['/payroll', 'Payroll'],
  ['/payslips', 'Payroll'],
  ['/finance', 'Finance'],
  ['/finance/ledger', 'Ledger'],
  ['/finance/journal', 'Ledger'],
  ['/finance/entries', 'Ledger'],
  ['/finance/accounts', 'Ledger'],
  ['/finance/parties', 'Ledger'],
  ['/finance/banking', 'Banking'],
  ['/finance/bills', 'Bills and expenses'],
  ['/finance/close', 'Month close'],
  ['/finance/statements', 'Statements'],
  ['/finance/sheet', 'Spreadsheet'],
  ['/finance/insights', 'Insights'],
  ['/statements', 'Statements'],
  ['/billing', 'Billing'],
  ['/subscriptions', 'Subscriptions'],
  ['/settings', 'Settings'],
  ['/audit', 'Audit'],
  ['/messages', 'Messages'],
  ['/announcements', 'Announcements'],
  ['/meetings', 'Meetings'],
  ['/sales', 'Sales'],
  ['/integrations', 'Integrations'],
  ['/notifications', 'Notifications'],
];

/** Every module label a known page or route is recorded under (the tests check each one is in ACTIVITY_MODULES). */
export const MODULE_LABELS: readonly string[] = [...new Set(MODULE_BY_PREFIX.map(([, label]) => label))];

/** API areas whose data is finance data (kept 10 years; a refused request here counts as a "finance attempt"). */
const FINANCE_API_PREFIXES = ['/finance', '/payroll', '/payslips', '/statements', '/billing', '/subscriptions'];

const matches = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

function longest<T>(path: string, table: Array<[string, T]>): T | undefined {
  let best: [string, T] | undefined;
  for (const row of table) if (matches(path, row[0]) && (!best || row[0].length > best[0].length)) best = row;
  return best?.[1];
}

export function moduleOf(path: string): string {
  const found = longest(withoutPrefix(path), MODULE_BY_PREFIX);
  if (found) return found;
  const first = withoutPrefix(path).split('/').filter(Boolean)[0] ?? 'System';
  return first.charAt(0).toUpperCase() + first.slice(1).replace(/-/g, ' ');
}

export function isFinanceApi(path: string): boolean {
  const p = withoutPrefix(path);
  return FINANCE_API_PREFIXES.some((prefix) => matches(p, prefix));
}

/** The modules whose exports count as "finance data" or "employee data" for the large-export alert. */
const FINANCE_MODULES = new Set(['Finance', 'Ledger', 'Banking', 'Bills and expenses', 'Month close', 'Statements', 'Spreadsheet', 'Insights', 'Payroll', 'Billing', 'Subscriptions']);
const EMPLOYEE_DATA_MODULES = new Set(['People', 'Activity', 'Attendance', 'Leave', 'Performance', 'Audit']);

export function exportDataKind(module: string): 'finance' | 'employee' | null {
  if (FINANCE_MODULES.has(module)) return 'finance';
  if (EMPLOYEE_DATA_MODULES.has(module)) return 'employee';
  return null;
}

export function isFinanceModule(module: string): boolean {
  return FINANCE_MODULES.has(module);
}

// ---------------------------------------------------------------------------------------------------------- screens

/**
 * The finance screens of the website (frontend/src/lib/nav.ts) and the permissions that open them (any one of them).
 * When someone opens one of these pages without the permission, the screen event is recorded as a blocked attempt.
 */
const FINANCE_SCREENS: Array<[string, string[]]> = [
  ['/finance', ['finance.view']],
  ['/finance/ledger', ['finance.view']],
  ['/finance/accounts', ['finance.view']],
  ['/finance/parties', ['finance.view']],
  ['/finance/bills', ['finance.view']],
  ['/finance/banking', ['finance.view']],
  ['/finance/close', ['finance.close']],
  ['/finance/statements', ['statements.view']],
  ['/finance/sheet', ['sheet.view']],
  ['/finance/insights', ['insights.view']],
  ['/billing', ['billing.view']],
  ['/billing/subscriptions', ['subscriptions.view']],
  ['/payroll', ['payroll.view_own', 'payroll.view']],
];

/** For a website page: null if it is not a finance screen; otherwise whether these permissions open it. */
export function financeScreenAccess(pagePath: string, permissions: ReadonlySet<string>): { allowed: boolean } | null {
  const path = pagePath.split(/[?#]/)[0];
  const anyOf = longest(path, FINANCE_SCREENS);
  if (!anyOf) return null;
  return { allowed: anyOf.some((p) => permissions.has(p)) };
}

// ---------------------------------------------------------------------------------------------------------- requests

export interface RequestFacts {
  method: string;
  /** The route pattern, for example /api/v1/employees/:empId/basic (with or without the prefix). */
  route: string;
  /** The route parameters, for example { empId: 'ACV-0011' }. */
  params: Record<string, string>;
}

export interface Classified {
  action: ActivityActionName;
  module: string;
  target: string | null;
  description: string;
  financeLinked: boolean;
}

/** A readable sentence for the routes of Modules 1 to 4. `done` is for the timeline, `tried` for a refused attempt. */
interface RouteText {
  action: ActivityActionName;
  done: string;
  tried: string;
}

const ROUTES: Record<string, RouteText> = {
  // Module 1
  'POST /org/departments': { action: 'create', done: 'Created a department', tried: 'create a department' },
  'PATCH /org/departments/:code': { action: 'edit', done: 'Changed department :code', tried: 'change department :code' },
  'POST /org/departments/:code/deactivate': { action: 'edit', done: 'Deactivated department :code', tried: 'deactivate department :code' },
  'POST /org/offices': { action: 'create', done: 'Created an office', tried: 'create an office' },
  'PATCH /org/offices/:code': { action: 'edit', done: 'Changed office :code', tried: 'change office :code' },
  'POST /org/offices/:code/deactivate': { action: 'edit', done: 'Deactivated office :code', tried: 'deactivate office :code' },
  'PATCH /org/employees/:empId/level': { action: 'edit', done: 'Changed the level of :empId', tried: 'change the level of :empId' },
  'PATCH /org/employees/:empId/reporting-line': { action: 'edit', done: 'Changed the reporting line of :empId', tried: 'change the reporting line of :empId' },
  'POST /org/employees/:empId/duties': { action: 'assign', done: 'Gave :empId an extra duty', tried: 'give :empId an extra duty' },
  'DELETE /org/employees/:empId/duties/:dutyKey': { action: 'edit', done: 'Ended the :dutyKey duty of :empId', tried: 'end the :dutyKey duty of :empId' },
  'POST /stand-ins': { action: 'create', done: 'Named a stand-in for an away period', tried: 'name a stand-in' },
  'DELETE /stand-ins/:id': { action: 'edit', done: 'Ended an away period early', tried: 'end an away period' },
  // Module 2 administration (the person's own security events come through the auth.* events instead)
  'POST /auth/employees/:empId/unlock': { action: 'security', done: 'Unlocked the account of :empId', tried: 'unlock the account of :empId' },
  'POST /auth/employees/:empId/force-logout': { action: 'security', done: 'Signed :empId out on every device', tried: 'sign :empId out' },
  'POST /auth/employees/:empId/reset-2fa': { action: 'security', done: 'Reset the authenticator of :empId', tried: 'reset the authenticator of :empId' },
  'POST /auth/employees/:empId/temporary-password': { action: 'security', done: 'Set a temporary password for :empId', tried: 'set a temporary password for :empId' },
  // Module 3
  'POST /employees': { action: 'create', done: 'Added an employee (or started a hire)', tried: 'add an employee' },
  'POST /employees/:empId/resend-welcome': { action: 'edit', done: 'Sent the welcome email to :empId again', tried: 'resend the welcome email to :empId' },
  'POST /employees/:empId/offboard': { action: 'edit', done: 'Set the last working day of :empId', tried: 'set the last working day of :empId' },
  'DELETE /employees/:empId/offboard': { action: 'edit', done: 'Cancelled the leaving date of :empId', tried: 'cancel the leaving date of :empId' },
  'PATCH /employees/:empId/basic': { action: 'edit', done: 'Changed the basic details of :empId', tried: 'change the basic details of :empId' },
  'PATCH /employees/:empId/job': { action: 'edit', done: 'Changed the job details of :empId', tried: 'change the job details of :empId' },
  'PATCH /employees/:empId/personal': { action: 'edit', done: 'Changed the personal details of :empId', tried: 'change the personal details of :empId' },
  'PATCH /employees/:empId/pay': { action: 'edit', done: 'Changed the pay details of :empId', tried: 'change the pay details of :empId' },
  'POST /employees/:empId/reveal': { action: 'sensitive_view', done: 'Viewed a hidden detail of :empId', tried: 'view a hidden detail of :empId' },
  'POST /employees/:empId/documents': { action: 'upload', done: 'Uploaded a document to the profile of :empId', tried: 'upload a document for :empId' },
  'GET /employees/:empId/documents/:documentId/download': { action: 'download', done: 'Downloaded a document of :empId', tried: 'download a document of :empId' },
  'DELETE /employees/:empId/documents/:documentId': { action: 'delete', done: 'Archived a document of :empId', tried: 'archive a document of :empId' },
  'POST /employees/:empId/photo': { action: 'upload', done: 'Changed the photo of :empId', tried: 'change the photo of :empId' },
  'POST /hire-requests/:id/approve': { action: 'approve', done: 'Approved a hire request', tried: 'approve a hire request' },
  'POST /hire-requests/:id/reject': { action: 'reject', done: 'Rejected a hire request', tried: 'reject a hire request' },
  // Module 4
  'POST /activity/alerts/:id/check': { action: 'edit', done: 'Marked a security alert as checked', tried: 'check a security alert' },
  'POST /sessions/:id/force-logout': { action: 'security', done: 'Signed out a session', tried: 'sign out a session' },
  'POST /employees/:empId/lock': { action: 'security', done: 'Locked the account of :empId', tried: 'lock the account of :empId' },
  'POST /employees/:empId/unlock': { action: 'security', done: 'Unlocked the account of :empId', tried: 'unlock the account of :empId' },
};

/** For a route not in the table: the last path word decides (POST /tasks/:id/approve is an approval). */
const SUFFIX_ACTIONS: Record<string, ActivityActionName> = {
  approve: 'approve',
  reject: 'reject',
  submit: 'submit',
  assign: 'assign',
  reassign: 'assign',
  comment: 'comment',
  comments: 'comment',
  upload: 'upload',
  attachments: 'upload',
  documents: 'upload',
  photo: 'upload',
  export: 'export',
  print: 'print',
  download: 'download',
  'force-logout': 'security',
  lock: 'security',
  unlock: 'security',
};

const PAST: Partial<Record<ActivityActionName, string>> = {
  create: 'Created',
  edit: 'Changed',
  delete: 'Deleted',
  submit: 'Submitted',
  assign: 'Assigned',
  approve: 'Approved',
  reject: 'Rejected',
  comment: 'Commented on',
  upload: 'Uploaded to',
  download: 'Downloaded',
  export: 'Exported',
  print: 'Printed',
  sensitive_view: 'Viewed',
  security: 'Changed security settings of',
};

const INFINITIVE: Partial<Record<ActivityActionName, string>> = {
  create: 'create',
  edit: 'change',
  delete: 'delete',
  submit: 'submit',
  assign: 'assign',
  approve: 'approve',
  reject: 'reject',
  comment: 'comment on',
  upload: 'upload to',
  download: 'download',
  export: 'export',
  print: 'print',
  sensitive_view: 'view',
  security: 'change security settings of',
};

/** The thing a request is about, from its route parameters: an Emp-ID first, then a code, then an id. */
export function targetOf(params: Record<string, string>): string | null {
  return params.empId ?? params.code ?? params.id ?? params.documentId ?? null;
}

/** "Changed the level of :empId" with { empId: 'ACV-0011' } -> "Changed the level of ACV-0011". */
export function fill(text: string, params: Record<string, string>): string {
  return text.replace(/:([A-Za-z]+)/g, (whole, name: string) => params[name] ?? whole);
}

function routeKey(facts: RequestFacts): string {
  return `${facts.method.toUpperCase()} ${withoutPrefix(facts.route)}`;
}

function actionFor(facts: RequestFacts): ActivityActionName {
  const known = ROUTES[routeKey(facts)];
  if (known) return known.action;
  const method = facts.method.toUpperCase();
  if (method === 'DELETE') return 'delete';
  if (method === 'PATCH' || method === 'PUT') return 'edit';
  const last = withoutPrefix(facts.route).split('/').filter(Boolean).pop() ?? '';
  // A GET that is recorded hands data out: /export and /print are what they say, any other one is a download.
  if (method === 'GET') return last === 'export' || last === 'print' ? last : 'download';
  return SUFFIX_ACTIONS[last] ?? 'create';
}

/** A successful request that created, changed, approved or deleted something (or read something sensitive). */
export function classifyRequest(facts: RequestFacts, override: { action?: ActivityActionName; module?: string; description?: string } = {}): Classified {
  const known = ROUTES[routeKey(facts)];
  const action = override.action ?? actionFor(facts);
  const module = override.module ?? moduleOf(facts.route);
  const target = targetOf(facts.params);
  const description =
    override.description ??
    (known ? fill(known.done, facts.params) : `${PAST[action] ?? 'Changed'} ${target ?? 'a record'} in ${module}`);
  return { action, module, target, description, financeLinked: isFinanceApi(facts.route) || isFinanceModule(module) };
}

/** A request the person was not allowed to make (403, or a finance refusal shown as 404). */
export function classifyBlocked(facts: RequestFacts): Classified {
  const known = ROUTES[routeKey(facts)];
  const module = moduleOf(facts.route);
  const target = targetOf(facts.params);
  const method = facts.method.toUpperCase();
  let tried: string;
  if (known) tried = fill(known.tried, facts.params);
  else if (method === 'GET') tried = `open ${module}${target ? ` (${target})` : ''}`;
  else tried = `${INFINITIVE[actionFor(facts)] ?? 'change'} ${target ?? 'a record'} in ${module}`;
  return { action: 'blocked', module, target, description: `Tried to ${tried} (no permission)`, financeLinked: isFinanceApi(facts.route) || isFinanceModule(module) };
}

/**
 * Requests the recorder does NOT log as actions, because they are recorded another way:
 *  - the login itself, logout, two-step login, step-up, password change and reset, My devices: Module 2 sends the
 *    auth.login / auth.logout / auth.security events, which become activity records (one record each, not two);
 *  - the health check.
 * Administrator actions under /auth/employees/... ARE recorded (they are actions on someone else's account).
 */
export function isRecordedElsewhere(route: string): boolean {
  const path = withoutPrefix(route);
  if (matches(path, '/health')) return true;
  return matches(path, '/auth') && !matches(path, '/auth/employees');
}

const CHANGING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function changesData(method: string): boolean {
  return CHANGING_METHODS.has(method.toUpperCase());
}

// ---------------------------------------------------------------------------------------------------------- logouts

/** Module 2's end reasons in the words the screens use (plan: clicked logout, timed out, forced by admin, password changed). */
export function logoutHow(reason: string): LogoutHow {
  switch (reason) {
    case 'user':
    case 'user_other_device':
      return 'clicked';
    case 'idle_timeout':
    case 'max_duration':
      return 'timed_out';
    case 'password_changed':
      return 'password_changed';
    default:
      return 'forced'; // forced by an administrator, too many wrong codes ('too_many_wrong_codes'), or the last working day ended
  }
}

export function logoutDescription(reason: string): string {
  switch (reason) {
    case 'user':
      return 'Signed out';
    case 'user_other_device':
      return 'Signed out from another device';
    case 'idle_timeout':
      return 'Timed out after 30 minutes without activity (10 on a finance screen)';
    case 'max_duration':
      return 'Signed out at the 12-hour session limit';
    case 'password_changed':
      return 'Signed out because the password changed';
    case 'employee_left':
      return 'Signed out: access ended after the last working day';
    case 'too_many_wrong_codes':
      return 'Signed out after too many wrong codes';
    default:
      return 'Signed out by an administrator';
  }
}

export function loginFailedDescription(reason: string): string {
  switch (reason) {
    case 'invalid_credentials':
      return 'Wrong password';
    case 'locked':
      return 'Tried to sign in while the account is locked';
    case 'rate_limited':
      return 'Sign-in refused: too many attempts from this address';
    case 'two_factor_failed':
      return 'Wrong authenticator code or password confirmation';
    case 'disabled':
      return 'Sign-in refused: the login is disabled';
    default:
      return 'Sign-in failed';
  }
}

export function securityDescription(kind: string, byEmpId: string | null): string {
  const by = byEmpId ? ` by ${byEmpId}` : '';
  switch (kind) {
    case 'password_changed':
      return 'Changed their password';
    case 'password_reset':
      return 'Reset their password with an email link';
    case 'two_factor_enabled':
      return 'Turned on two-step login';
    case 'two_factor_disabled':
      return 'Turned off two-step login';
    case 'two_factor_reset':
      return `Authenticator reset${by}`;
    case 'account_locked':
      return byEmpId ? `Account locked${by}` : 'Account locked after 5 wrong passwords';
    case 'account_unlocked':
      return `Account unlocked${by}`;
    case 'temporary_password_set':
      return `Temporary password set${by}`;
    default:
      return 'Security change';
  }
}

// ---------------------------------------------------------------------------------------------------------- devices

export interface DeviceFacts {
  device: string | null;
  browser: string | null;
  os: string | null;
}

/** "Chrome 142 on Windows" (what the screens show). */
export function deviceLabel(d: DeviceFacts): string {
  const browser = d.browser && !d.browser.startsWith('Unknown') ? d.browser : null;
  const os = d.os && d.os !== 'Unknown' ? d.os : null;
  if (browser && os) return `${browser} on ${os}`;
  return d.device ?? 'Unknown device';
}

/** The same device again? Browser updates (Chrome 142 to 143) do not make a new device. */
export function deviceFingerprint(d: DeviceFacts): string {
  const family = (d.browser ?? '').replace(/\s+[\d.]+$/, '').trim();
  return [d.device ?? '', family, d.os ?? ''].join('|').toLowerCase();
}
