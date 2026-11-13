/**
 * Permission catalogue, role permissions and duty permissions.
 *
 * Generated once from the frontend permission matrix (frontend/src/lib/auth/permissions.ts, spec section 8) so the
 * server and the screens speak the same permission names, plus two keys that Module 1 adds itself:
 *   approval.approve   may approve requests of people below, and may be a stand-in
 *   duty.assign        may give or end extra duties such as Finance or HR (Director)
 *   auth.set_temporary_password  Director and HR set a temporary password when someone has no official email
 *   auth.reset_two_factor        reset a lost authenticator (Owner, CEO, Director, HR duty), with limits
 * (Finance duty also sees pay information: plan section 7)
 * Roles belong to levels (plan section 5). Finance and HR are DUTIES, not roles. Duty permissions are kept
 * separate from role permissions. To add a permission for a future module, add a row to this catalogue
 * (and to the roles or duties that should have it); no authorization code changes.
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
  'finance.entry_approve', 'finance.close', 'finance.reopen', 'finance.export', 'statements.view',
  'statements.export', 'sheet.view', 'sheet.import', 'insights.view', 'audit.view', 'settings.view',
  'settings.manage', 'backup.view', 'billing.view', 'billing.manage', 'subscriptions.view',
  'subscriptions.manage', 'comms.use', 'comms.admin', 'announcements.publish', 'sales.own',
  'sales.team', 'sales.all', 'sales.targets', 'sales.commission_view', 'sales.commission_approve',
  'sales.export', 'integrations.view', 'integrations.manage', 'approval.approve', 'duty.assign',
  'auth.set_temporary_password', 'auth.reset_two_factor', 'finance.close_approve',
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

const OWNER: string[] = [
  'org.view', 'people.view_directory', 'activity.view_own', 'task.view_own', 'performance.view_own',
  'attendance.self', 'leave.request', 'payroll.view_own', 'comms.use', 'people.view_job',
  'people.view_personal', 'people.view_pay', 'activity.view_team', 'activity.view_all',
  'activity.security', 'task.view_team', 'performance.view_team', 'performance.view_all',
  'attendance.view_team', 'payroll.view', 'payroll.export', 'finance.view', 'finance.export',
  'statements.view', 'statements.export', 'sheet.view', 'insights.view', 'audit.view',
  'settings.view', 'backup.view', 'billing.view', 'subscriptions.view', 'sales.own', 'sales.team',
  'sales.all', 'sales.commission_view', 'sales.export', 'integrations.view', 'announcements.publish',
  'org.manage',
  'auth.reset_two_factor',
  // Plan sections 11 and 13: approvals move up to the Owner; above PKR 500,000, capital and loans; reopening a month.
  'leave.approve', 'attendance.approve_correction', 'finance.entry_approve', 'finance.reopen',
];

const CEO: string[] = [
  'org.view', 'people.view_directory', 'activity.view_own', 'task.view_own', 'performance.view_own',
  'attendance.self', 'leave.request', 'payroll.view_own', 'comms.use', 'people.view_job',
  'people.view_personal', 'people.view_pay', 'activity.view_team', 'activity.view_all',
  'activity.security', 'task.view_team', 'performance.view_team', 'performance.view_all',
  'attendance.view_team', 'payroll.view', 'payroll.export', 'finance.view', 'finance.export',
  'statements.view', 'statements.export', 'sheet.view', 'insights.view', 'audit.view',
  'settings.view', 'backup.view', 'billing.view', 'subscriptions.view', 'sales.own', 'sales.team',
  'sales.all', 'sales.commission_view', 'sales.export', 'integrations.view', 'announcements.publish',
  'org.manage', 'standin.manage', 'auth.unlock_account', 'session.force_logout', 'leave.approve',
  'attendance.approve_correction', 'approval.approve',
  'auth.reset_two_factor',
  // Plan sections 12, 13: the CEO approves payroll and the month close, approves entries up to their limit, reopens months.
  'payroll.approve', 'finance.entry_approve', 'finance.close_approve', 'finance.reopen',
];

const LEVEL3_DEFAULT: string[] = [
  'org.view', 'people.view_directory', 'activity.view_own', 'task.view_own', 'performance.view_own',
  'attendance.self', 'leave.request', 'payroll.view_own', 'comms.use', 'people.view_job',
  'standin.manage', 'activity.view_team', 'activity.view_all', 'task.assign', 'task.review',
  'task.view_team', 'performance.view_team', 'performance.view_all', 'attendance.view_team',
  'attendance.approve_correction', 'leave.approve', 'auth.unlock_account', 'session.force_logout',
  'comms.admin', 'announcements.publish', 'activity.security', 'settings.view', 'backup.view',
  'integrations.view', 'integrations.manage', 'approval.approve',
];

const DIRECTOR: string[] = [
  'org.view', 'people.view_directory', 'activity.view_own', 'task.view_own', 'performance.view_own',
  'attendance.self', 'leave.request', 'payroll.view_own', 'comms.use', 'people.view_job',
  'standin.manage', 'activity.view_team', 'activity.view_all', 'task.assign', 'task.review',
  'task.view_team', 'performance.view_team', 'performance.view_all', 'attendance.view_team',
  'attendance.approve_correction', 'leave.approve', 'auth.unlock_account', 'session.force_logout',
  'comms.admin', 'announcements.publish', 'roles.manage', 'people.view_personal', 'people.view_pay',
  'people.manage', 'people.manage_pay', 'activity.security', 'performance.weights', 'payroll.view',
  'payroll.review', 'payroll.export', 'finance.view', 'finance.entry_approve',
  'finance.export', 'statements.view', 'statements.export',
  'sheet.view', 'insights.view', 'audit.view', 'settings.view', 'settings.manage', 'backup.view',
  'billing.view', 'subscriptions.view', 'subscriptions.manage', 'sales.own', 'sales.team',
  'sales.all', 'sales.targets', 'sales.commission_view', 'sales.commission_approve', 'sales.export',
  'integrations.view', 'integrations.manage', 'approval.approve', 'duty.assign',
  'auth.set_temporary_password',
  'auth.reset_two_factor',
];

const CTO: string[] = [
  'org.view', 'people.view_directory', 'activity.view_own', 'task.view_own', 'performance.view_own',
  'attendance.self', 'leave.request', 'payroll.view_own', 'comms.use', 'people.view_job',
  'standin.manage', 'activity.view_team', 'activity.view_all', 'task.assign', 'task.review',
  'task.view_team', 'performance.view_team', 'performance.view_all', 'attendance.view_team',
  'attendance.approve_correction', 'leave.approve', 'auth.unlock_account', 'session.force_logout',
  'comms.admin', 'announcements.publish', 'activity.security', 'settings.view', 'backup.view',
  'integrations.view', 'integrations.manage', 'approval.approve',
];

const LEVEL4_DEFAULT: string[] = [
  'org.view', 'people.view_directory', 'activity.view_own', 'task.view_own', 'performance.view_own',
  'attendance.self', 'leave.request', 'payroll.view_own', 'comms.use', 'standin.manage',
  'task.assign', 'task.review', 'task.view_team', 'approval.approve',
  // Plan section 11: leave goes to the team lead first; corrections go to the manager; team attendance is Internal.
  'leave.approve', 'attendance.approve_correction', 'attendance.view_team',
];

const SALES: string[] = [
  'org.view', 'people.view_directory', 'activity.view_own', 'task.view_own', 'performance.view_own',
  'attendance.self', 'leave.request', 'payroll.view_own', 'comms.use', 'sales.own',
];

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

/** Default role of each level, plus the named Director, CTO and Sales roles. */
export const ROLE_SEEDS: RoleSeed[] = [
  { key: 'owner', name: 'Owner', level: 1, isDefault: true, permissions: OWNER },
  { key: 'ceo', name: 'CEO', level: 2, isDefault: true, permissions: CEO },
  { key: 'level3_default', name: 'Director / CTO (default)', level: 3, isDefault: true, permissions: LEVEL3_DEFAULT },
  { key: 'director', name: 'Director', level: 3, isDefault: false, permissions: DIRECTOR },
  { key: 'cto', name: 'CTO', level: 3, isDefault: false, permissions: CTO },
  { key: 'level4_default', name: 'Department Head / Team Lead (default)', level: 4, isDefault: true, permissions: LEVEL4_DEFAULT },
  { key: 'sales', name: 'Sales', level: 4, isDefault: false, permissions: SALES },
  { key: 'employee', name: 'Employee (default)', level: 5, isDefault: true, permissions: EMPLOYEE },
];

/** Extra duties. 2FA is mandatory for anyone holding a duty that requires it (Finance). */
export const DUTY_SEEDS: DutySeed[] = [
  { key: 'finance', name: 'Finance duty', requiresTwoFactor: true, permissions: DUTY_FINANCE },
  { key: 'hr', name: 'HR duty', requiresTwoFactor: false, permissions: DUTY_HR },
  { key: 'sales_manager', name: 'Sales manager duty', requiresTwoFactor: false, permissions: DUTY_SALES_MANAGER },
];
