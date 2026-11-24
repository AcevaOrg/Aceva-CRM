/**
 * Permission catalogue, role permissions and duty permissions.
 *
 * Generated once from the frontend permission matrix (frontend/src/lib/auth/permissions.ts, spec section 8) so the
 * server and the screens speak the same permission names, plus four keys that Module 1 and 2 add themselves:
 *   approval.approve   may approve requests of people below, and may be a stand-in
 *   duty.assign        may give or end extra duties such as Finance or HR (Director)
 *   auth.set_temporary_password  Director and HR set a temporary password when someone has no official email
 *   auth.reset_two_factor        reset a lost authenticator (Director, HR duty; the CEO / Founder / Owner for the Director only)
 * (Finance duty also sees pay information: plan section 7)
 * Roles belong to levels (plan section 5). Finance and HR are DUTIES, not roles. Duty permissions are kept
 * separate from role permissions. To add a permission for a future module, add a row to this catalogue
 * (and to the roles or duties that should have it); no authorization code changes.
 *
 * The company structure (final):
 *   L1 CEO / Founder / Owner   ACV-0001, sees everything, approves nothing (except the Director's own leave and corrections)
 *   L2 Director                ACV-0003, reports to L1. The only approver and the org administrator. HR and sales-manager duty.
 *   L3 CTO                     ACV-0004, reports to the Director (strictly below; no same-level line)
 *   L4 Sales and Finance       report to the Director (the finance person holds the Finance duty)
 *   L5 Developer / SQA         report to the CTO
 */

export const PERMISSION_KEYS: string[] = [
  'org.view', 'org.manage', 'roles.manage', 'standin.manage', 'people.view_directory',
  'people.view_job', 'people.view_personal', 'people.view_pay', 'people.manage', 'people.manage_pay',
  'auth.unlock_account', 'session.force_logout', 'activity.view_own', 'activity.view_team',
  'activity.view_all', 'activity.security', 'task.view_own', 'task.assign', 'task.review',
  'task.view_team', 'performance.view_own', 'performance.view_team', 'performance.view_all',
  'performance.weights', 'attendance.self', 'attendance.view_team', 'attendance.approve_correction',
  'leave.request', 'leave.approve', 'payroll.view_own', 'payroll.view', 'payroll.prepare',
  'payroll.review', 'payroll.approve', 'payroll.export', 'finance.view', 'finance.entry_create',
  'finance.entry_approve', 'finance.close', 'finance.close_approve', 'finance.reopen', 'finance.authority_manage', 'finance.export', 'statements.view', 'people.approve_hire',
  'statements.export', 'sheet.view', 'sheet.import', 'insights.view', 'audit.view', 'settings.view',
  'settings.manage', 'backup.view', 'billing.view', 'billing.manage', 'subscriptions.view',
  'subscriptions.manage', 'comms.use', 'comms.admin', 'announcements.publish', 'sales.own',
  'sales.team', 'sales.all', 'sales.targets', 'sales.commission_view', 'sales.commission_approve',
  'sales.export', 'integrations.view', 'integrations.manage', 'approval.approve', 'duty.assign',
  'auth.set_temporary_password', 'auth.reset_two_factor',
  // M15.2, decision B1: confirm a Won deal the Director owns, and only such a deal (the Director cannot confirm their own)
  'sales.won_confirm_director',
];

export interface RoleSeed {
  key: string;
  name: string;
  level: number;
  isDefault: boolean;
  permissions: string[];
}

export interface DutySeed {
  key: string;
  name: string;
  requiresTwoFactor: boolean;
  permissions: string[];
}

/**
 * Level 1, the CEO / Founder / Owner (one person). He SEES everything: every view and export, all activity, the audit
 * log, finance, payroll, sales and the settings. He approves, prepares, assigns and manages nothing: no org.manage, no
 * hiring, no settings changes, no payroll, finance or commission approvals.
 * The one exception: nobody approves their own request and only the Director reports to him, so the Director's OWN
 * leave and attendance corrections come to him (leave.approve, attendance.approve_correction, approval.approve). The
 * approval routing lets a Level 1 seat approve only for the people who report to it directly, so nothing else reaches him.
 * For the same reason he may unlock or reset the authenticator of his direct report (the Director) only; AuthService
 * enforces that limit.
 * Also for that reason (decision B1, Module 15.2) he confirms a Won deal the Director owns, and only such a deal:
 * DealsService and a database trigger refuse every other deal.
 */
const OWNER: string[] = [
  'org.view', 'people.view_directory', 'activity.view_own', 'task.view_own', 'performance.view_own',
  'attendance.self', 'leave.request', 'payroll.view_own', 'comms.use', 'people.view_job',
  'people.view_personal', 'people.view_pay', 'activity.view_team', 'activity.view_all',
  'activity.security', 'task.view_team', 'performance.view_team', 'performance.view_all',
  'attendance.view_team', 'payroll.view', 'payroll.export', 'finance.view', 'finance.export',
  'statements.view', 'statements.export', 'sheet.view', 'insights.view', 'audit.view',
  'settings.view', 'backup.view', 'billing.view', 'subscriptions.view', 'sales.own', 'sales.team',
  'sales.all', 'sales.commission_view', 'sales.export', 'integrations.view', 'announcements.publish',
  // only for the Director's own items (see above): leave, attendance corrections, journal entries and hire requests
  'leave.approve', 'attendance.approve_correction', 'approval.approve', 'finance.entry_approve', 'people.approve_hire',
  // a payroll run the Director prepared (the service checks it; the Director never approves their own)
  'payroll.approve',
  // only for his direct report, the Director (see above)
  'auth.unlock_account', 'auth.reset_two_factor',
  // M15.2, decision B1: a Won deal the Director owns (the service and a database trigger allow nothing else)
  'sales.won_confirm_director',
];

/**
 * Level 2, the Director (one person, reports to the CEO / Founder / Owner). The ONLY approver for the company and the
 * org administrator: levels, reporting lines, departments and offices (org.manage), hiring and hire authorization,
 * roles and duties, pay, payroll, finance, commission and the last step of leave. Also holds the HR and sales-manager
 * duties. Prepares no finance items, so there is always a second person (maker-checker).
 */
const DIRECTOR: string[] = [
  'org.view', 'people.view_directory', 'activity.view_own', 'task.view_own', 'performance.view_own',
  'attendance.self', 'leave.request', 'payroll.view_own', 'comms.use', 'people.view_job',
  'standin.manage', 'activity.view_team', 'activity.view_all', 'task.assign', 'task.review',
  'task.view_team', 'performance.view_team', 'performance.view_all', 'attendance.view_team',
  'attendance.approve_correction', 'leave.approve', 'auth.unlock_account', 'session.force_logout',
  'comms.admin', 'announcements.publish', 'roles.manage', 'people.view_personal', 'people.view_pay',
  'people.manage', 'people.manage_pay', 'activity.security', 'performance.weights', 'payroll.view',
  // Decision D25: the Director approves everything below the Owner in one step (Finance prepares): payroll, the month
  // close, reopening a month, journal entries of any amount (confirm again above 50,000), hire requests.
  'payroll.approve', 'finance.entry_approve', 'finance.close_approve', 'finance.reopen', 'people.approve_hire',
  'payroll.export', 'finance.view', 'finance.export', 'statements.view', 'statements.export',
  'sheet.view', 'insights.view', 'audit.view', 'settings.view', 'settings.manage', 'backup.view',
  'billing.view', 'subscriptions.view', 'subscriptions.manage', 'sales.own', 'sales.team',
  'sales.all', 'sales.targets', 'sales.commission_view', 'sales.commission_approve', 'sales.export',
  'integrations.view', 'integrations.manage', 'approval.approve', 'duty.assign',
  'auth.set_temporary_password',
  'auth.reset_two_factor',
  'org.manage',
  // Decision D22: only the Director changes approval limits and finance settings (with "confirm again"); the Owner only views.
  'finance.authority_manage',
];

/** Level 3, the CTO (reports to the Director): runs development, security events, backups and integrations. */
const CTO: string[] = [
  'org.view', 'people.view_directory', 'activity.view_own', 'task.view_own', 'performance.view_own',
  'attendance.self', 'leave.request', 'payroll.view_own', 'comms.use', 'people.view_job',
  'standin.manage', 'activity.view_team', 'activity.view_all', 'task.assign', 'task.review',
  'task.view_team', 'performance.view_team', 'performance.view_all', 'attendance.view_team',
  'attendance.approve_correction', 'leave.approve', 'auth.unlock_account', 'session.force_logout',
  'comms.admin', 'announcements.publish', 'activity.security', 'settings.view', 'backup.view',
  'integrations.view', 'integrations.manage', 'approval.approve',
];

/** Level 4, Sales (report to the Director): own leads, deals, follow-ups and daily report. Manages nobody. */
const SALES: string[] = [
  'org.view', 'people.view_directory', 'activity.view_own', 'task.view_own', 'performance.view_own',
  'attendance.self', 'leave.request', 'payroll.view_own', 'comms.use', 'sales.own',
];

/**
 * Everyone's own work. Used by Level 5 (Developer / SQA, report to the CTO) and by the Level 4 finance role:
 * what makes someone the finance person is the Finance DUTY, not the role.
 */
const EMPLOYEE: string[] = [
  'org.view', 'people.view_directory', 'activity.view_own', 'task.view_own', 'performance.view_own',
  'attendance.self', 'leave.request', 'payroll.view_own', 'comms.use',
];

const DUTY_FINANCE: string[] = [
  'finance.view', 'finance.entry_create', 'finance.close', 'payroll.view', 'payroll.prepare',
  'statements.view', 'sheet.view', 'sheet.import', 'insights.view', 'billing.view', 'billing.manage',
  'subscriptions.view', 'sales.commission_view',
  'people.view_pay',
];

const DUTY_HR: string[] = [
  'people.view_job', 'people.view_personal', 'people.manage', 'auth.unlock_account',
  'auth.set_temporary_password',
  'auth.reset_two_factor',
];

const DUTY_SALES_MANAGER: string[] = [
  'sales.own', 'sales.team', 'sales.targets', 'sales.export',
];

/**
 * One default role per level:
 *   L1 owner (CEO / Founder / Owner) | L2 director | L3 cto | L4 sales | L5 employee (Developer / SQA)
 * plus the Level 4 finance role (not the default; the finance permissions come from the Finance duty).
 * The key "owner" is kept; only its display name changed. There is no separate CEO role and no
 * "Department Head / Team Lead" role any more.
 */
export const ROLE_SEEDS: RoleSeed[] = [
  { key: 'owner', name: 'CEO / Founder / Owner', level: 1, isDefault: true, permissions: OWNER },
  { key: 'director', name: 'Director', level: 2, isDefault: true, permissions: DIRECTOR },
  { key: 'cto', name: 'CTO', level: 3, isDefault: true, permissions: CTO },
  { key: 'sales', name: 'Sales', level: 4, isDefault: true, permissions: SALES },
  { key: 'finance', name: 'Finance', level: 4, isDefault: false, permissions: EMPLOYEE },
  { key: 'employee', name: 'Developer / SQA', level: 5, isDefault: true, permissions: EMPLOYEE },
];

/** Extra duties. 2FA is mandatory for anyone holding a duty that requires it (Finance). */
export const DUTY_SEEDS: DutySeed[] = [
  { key: 'finance', name: 'Finance duty', requiresTwoFactor: true, permissions: DUTY_FINANCE },
  { key: 'hr', name: 'HR duty', requiresTwoFactor: false, permissions: DUTY_HR },
  { key: 'sales_manager', name: 'Sales manager duty', requiresTwoFactor: false, permissions: DUTY_SALES_MANAGER },
];
