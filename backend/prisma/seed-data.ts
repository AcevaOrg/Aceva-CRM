import type { PrismaClient } from '../src/generated/prisma/client';

/**
 * Development and test seed data. Safe to run more than once (it only adds what is missing).
 *
 * The company structure follows the DEVELOPMENT PLAN (section 5), not the frontend mocks:
 *   Level 1 Owner | Level 2 CEO | Level 3 Director and CTO | Level 4 Heads and Leads | Level 5 Employees
 *
 * All people below are fictional demo data. No passwords are created (login is built in M2).
 */

export const LEVELS = [
  { number: 1, name: 'Owner' },
  { number: 2, name: 'CEO' },
  { number: 3, name: 'Director and CTO' },
  { number: 4, name: 'Department Head and Team Lead' },
  { number: 5, name: 'Employee' },
] as const;

export const PERMISSIONS: Array<{ key: string; module: string; description: string }> = [
  { key: 'org.view', module: 'hierarchy', description: 'View the organisation chart' },
  { key: 'org.manage', module: 'hierarchy', description: 'Change employee levels and reporting lines (Owner or CEO)' },
  { key: 'duty.assign', module: 'hierarchy', description: 'Give or remove an additional duty (Finance, HR)' },
  { key: 'standin.manage', module: 'hierarchy', description: 'Name a stand-in for approvals during leave' },
  { key: 'approval.approve', module: 'hierarchy', description: 'Approve requests from people below' },
  { key: 'task.assign', module: 'tasks', description: 'Assign tasks to people below' },
  { key: 'task.view', module: 'tasks', description: 'View tasks in scope' },
  { key: 'employee.directory.view', module: 'employees', description: 'View the staff directory (basic information)' },
  { key: 'employee.create', module: 'employees', description: 'Create an employee profile (joining workflow)' },
  { key: 'employee.job.manage', module: 'employees', description: 'Change job-related fields' },
  { key: 'employee.personal.view', module: 'employees', description: 'View personal information' },
  { key: 'employee.pay.view', module: 'employees', description: 'View pay information' },
  { key: 'employee.pay.manage', module: 'employees', description: 'Change pay-related fields (Director only)' },
  { key: 'employee.documents.view', module: 'employees', description: 'View employee documents' },
  { key: 'employee.documents.manage', module: 'employees', description: 'Upload employee documents' },
  { key: 'employee.offboard', module: 'employees', description: 'Set the last working day (leaving workflow)' },
  { key: 'auth.account.unlock', module: 'auth', description: 'Unlock a locked account' },
  { key: 'auth.session.force_logout', module: 'auth', description: 'Force an employee to log out on every device' },
  { key: 'auth.password.set_temporary', module: 'auth', description: 'Set a temporary password' },
  { key: 'finance.view', module: 'finance', description: 'View finance data' },
  { key: 'finance.prepare', module: 'finance', description: 'Prepare finance entries' },
  { key: 'finance.approve', module: 'finance', description: 'Approve finance entries' },
  { key: 'payroll.view', module: 'payroll', description: 'View payroll' },
  { key: 'payroll.prepare', module: 'payroll', description: 'Prepare payroll runs' },
  { key: 'payroll.approve', module: 'payroll', description: 'Approve payroll runs' },
  { key: 'audit.view', module: 'audit', description: 'View the audit log' },
  { key: 'settings.manage', module: 'settings', description: 'Change system settings' },
];

const VIEW_ALL = [
  'org.view',
  'employee.directory.view',
  'employee.personal.view',
  'employee.pay.view',
  'employee.documents.view',
  'finance.view',
  'payroll.view',
  'audit.view',
  'task.view',
];

const LEVEL3_COMMON = ['employee.directory.view', 'org.view', 'task.assign', 'task.view', 'approval.approve', 'standin.manage'];

/** Default role of each level, plus the named Director and CTO roles (both Level 3). */
export const ROLES: Array<{
  key: string;
  name: string;
  level: number;
  isDefault: boolean;
  permissions: string[];
}> = [
  { key: 'owner', name: 'Owner', level: 1, isDefault: true, permissions: [...VIEW_ALL, 'org.manage'] },
  {
    key: 'ceo',
    name: 'CEO',
    level: 2,
    isDefault: true,
    permissions: [
      ...VIEW_ALL,
      'org.manage',
      'approval.approve',
      'standin.manage',
      'auth.account.unlock',
      'auth.session.force_logout',
    ],
  },
  { key: 'level3_default', name: 'Director / CTO (default)', level: 3, isDefault: true, permissions: LEVEL3_COMMON },
  {
    key: 'director',
    name: 'Director',
    level: 3,
    isDefault: false,
    permissions: [
      ...LEVEL3_COMMON,
      'duty.assign',
      'employee.create',
      'employee.job.manage',
      'employee.personal.view',
      'employee.pay.view',
      'employee.pay.manage',
      'employee.documents.view',
      'employee.documents.manage',
      'employee.offboard',
      'auth.account.unlock',
      'auth.session.force_logout',
      'auth.password.set_temporary',
      'finance.view',
      'finance.approve',
      'payroll.view',
      'payroll.approve',
      'audit.view',
      'settings.manage',
    ],
  },
  { key: 'cto', name: 'CTO', level: 3, isDefault: false, permissions: LEVEL3_COMMON },
  {
    key: 'level4_default',
    name: 'Department Head / Team Lead (default)',
    level: 4,
    isDefault: true,
    permissions: ['employee.directory.view', 'org.view', 'task.assign', 'task.view', 'approval.approve', 'standin.manage'],
  },
  { key: 'employee', name: 'Employee (default)', level: 5, isDefault: true, permissions: ['employee.directory.view', 'org.view', 'task.view'] },
];

/**
 * The only allowed same-level reporting lines (plan: the CTO reports to the Director, both Level 3).
 * Everything else must report to a strictly higher level.
 */
export const SAME_LEVEL_RULES: Array<{ manager: string; employee: string; reason: string }> = [
  { manager: 'director', employee: 'cto', reason: 'The CTO (Level 3) reports to the Director (Level 3), as documented in the company structure.' },
];

/** Extra duties. Their permissions are kept apart from role permissions. */
export const DUTIES: Array<{
  key: string;
  name: string;
  requiresTwoFactor: boolean;
  permissions: string[];
}> = [
  {
    key: 'finance',
    name: 'Finance duty',
    requiresTwoFactor: true,
    permissions: ['finance.view', 'finance.prepare', 'payroll.view', 'payroll.prepare', 'employee.pay.view'],
  },
  {
    key: 'hr',
    name: 'HR duty',
    requiresTwoFactor: false,
    permissions: [
      'employee.create',
      'employee.job.manage',
      'employee.personal.view',
      'employee.documents.view',
      'employee.documents.manage',
      'employee.offboard',
      'auth.account.unlock',
      'auth.password.set_temporary',
    ],
  },
];

/** Department and office codes match the ids the frontend already uses (dep-eng, off-khi ...). */
export const DEPARTMENTS = [
  { code: 'dep-mgmt', name: 'Management' },
  { code: 'dep-eng', name: 'Software Development' },
  { code: 'dep-sales', name: 'Sales' },
  { code: 'dep-fin', name: 'Finance' },
  { code: 'dep-hr', name: 'Human Resources' },
];

export const OFFICES = [
  { code: 'off-dadu', name: 'Dadu HQ', city: 'Dadu' },
  { code: 'off-khi', name: 'Karachi Studio', city: 'Karachi' },
  { code: 'off-remote', name: 'Remote', city: 'Remote' },
];

type DemoEmployee = {
  /** The Emp-ID this demo person gets. Same numbers as the frontend demo roster. */
  empId: string;
  /** Used only to wire up "reports to". */
  slug: string;
  name: string;
  /** Used to build the demo email address, for example "hamza" gives hamza@acevatech.com. */
  email: string;
  designation: string;
  department: string;
  office: string;
  level: number;
  role: string;
  reportsTo: string | null;
  duties?: string[];
  type?: 'full_time' | 'part_time' | 'intern';
  weeklyHours?: number;
};

/**
 * The demo company, following the DEVELOPMENT PLAN's five levels:
 *   Level 1 Owner > Level 2 CEO > Level 3 Director > Level 3 CTO (same-level line, explicitly configured),
 *   Level 4 heads and leads (Sales, Finance, HR) report to the Director, Level 5 developers report to the CTO.
 * Emp-IDs match the frontend's demo roster (ACV-0005 stays unused, like a person who left); the CEO is ACV-0002
 * and the clearly labelled demo HR officer is ACV-0015.
 */
export const DEMO_EMPLOYEES: DemoEmployee[] = [
  { empId: 'ACV-0001', slug: 'owner', name: 'Hamza Qureshi', email: 'hamza', designation: 'Owner and Founder', department: 'dep-mgmt', office: 'off-dadu', level: 1, role: 'owner', reportsTo: null },
  { empId: 'ACV-0002', slug: 'ceo', name: 'Ayesha Siddiqui', email: 'ayesha', designation: 'Chief Executive Officer', department: 'dep-mgmt', office: 'off-dadu', level: 2, role: 'ceo', reportsTo: 'owner' },
  { empId: 'ACV-0003', slug: 'director', name: 'Bilal Ahmed', email: 'bilal', designation: 'Director', department: 'dep-mgmt', office: 'off-dadu', level: 3, role: 'director', reportsTo: 'ceo', duties: ['hr'] },
  { empId: 'ACV-0004', slug: 'cto', name: 'Omar Farooq', email: 'omar', designation: 'Chief Technology Officer', department: 'dep-eng', office: 'off-dadu', level: 3, role: 'cto', reportsTo: 'director' },
  { empId: 'ACV-0006', slug: 'dev1', name: 'Fahad Khan', email: 'fahad', designation: 'Senior Backend Developer', department: 'dep-eng', office: 'off-khi', level: 5, role: 'employee', reportsTo: 'cto' },
  { empId: 'ACV-0007', slug: 'dev2', name: 'Mariam Shah', email: 'mariam', designation: 'Software Developer', department: 'dep-eng', office: 'off-khi', level: 5, role: 'employee', reportsTo: 'cto' },
  { empId: 'ACV-0008', slug: 'dev3', name: 'Ali Raza', email: 'ali', designation: 'Backend Developer', department: 'dep-eng', office: 'off-remote', level: 5, role: 'employee', reportsTo: 'cto' },
  { empId: 'ACV-0009', slug: 'sales1', name: 'Hira Baig', email: 'hira', designation: 'Sales Executive', department: 'dep-sales', office: 'off-khi', level: 4, role: 'level4_default', reportsTo: 'director' },
  { empId: 'ACV-0010', slug: 'finance', name: 'Sana Malik', email: 'sana', designation: 'Finance Officer', department: 'dep-fin', office: 'off-dadu', level: 4, role: 'level4_default', reportsTo: 'director', duties: ['finance'] },
  { empId: 'ACV-0011', slug: 'sqa1', name: 'Danish Iqbal', email: 'danish', designation: 'SQA Engineer', department: 'dep-eng', office: 'off-khi', level: 5, role: 'employee', reportsTo: 'cto' },
  { empId: 'ACV-0012', slug: 'sales2', name: 'Kamran Javed', email: 'kamran', designation: 'Sales Executive', department: 'dep-sales', office: 'off-remote', level: 4, role: 'level4_default', reportsTo: 'director' },
  { empId: 'ACV-0013', slug: 'sqa2', name: 'Nida Aslam', email: 'nida', designation: 'SQA Intern', department: 'dep-eng', office: 'off-dadu', level: 5, role: 'employee', reportsTo: 'cto', type: 'intern', weeklyHours: 20 },
  { empId: 'ACV-0014', slug: 'sales3', name: 'Saad Mirza', email: 'saad', designation: 'Senior Sales Executive', department: 'dep-sales', office: 'off-khi', level: 4, role: 'level4_default', reportsTo: 'director' },
  { empId: 'ACV-0015', slug: 'hr', name: 'Rabia Anwar (DEMO HR)', email: 'rabia', designation: 'HR Officer', department: 'dep-hr', office: 'off-dadu', level: 4, role: 'level4_default', reportsTo: 'director', duties: ['hr'] },
];

export function demoEmail(person: { email: string }): string {
  return `${person.email}@acevatech.com`;
}

type Tx = Parameters<Parameters<PrismaClient['$transaction']>[0]>[0];

/** Rebuilds the whole reporting closure table from employees.reports_to_id. */
export async function rebuildReportingClosure(tx: Tx): Promise<void> {
  await tx.$executeRaw`DELETE FROM reporting_closure`;
  await tx.$executeRaw`
    WITH RECURSIVE tree(ancestor_id, descendant_id, depth) AS (
      SELECT id, id, 0 FROM employees
      UNION ALL
      SELECT t.ancestor_id, e.id, t.depth + 1
      FROM tree t JOIN employees e ON e.reports_to_id = t.descendant_id
      WHERE t.depth < 20
    )
    INSERT INTO reporting_closure (ancestor_id, descendant_id, depth)
    SELECT ancestor_id, descendant_id, depth FROM tree`;
}

export async function seedDatabase(prisma: PrismaClient): Promise<void> {
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Refusing to seed demo data in production.');
  }

  await prisma.$transaction(
    async (tx) => {
      // Levels
      for (const l of LEVELS) {
        await tx.level.upsert({ where: { number: l.number }, update: { name: l.name }, create: l });
      }
      const levels = new Map((await tx.level.findMany()).map((l) => [l.number, l.id]));

      // Permission catalogue
      for (const p of PERMISSIONS) {
        await tx.permission.upsert({ where: { key: p.key }, update: { description: p.description }, create: p });
      }
      const permissions = new Map((await tx.permission.findMany()).map((p) => [p.key, p.id]));
      const permId = (key: string): string => {
        const id = permissions.get(key);
        if (!id) throw new Error(`Unknown permission in seed: ${key}`);
        return id;
      };

      // Roles and role permissions
      for (const r of ROLES) {
        const role = await tx.role.upsert({
          where: { key: r.key },
          update: { name: r.name, isDefault: r.isDefault },
          create: { key: r.key, name: r.name, isDefault: r.isDefault, levelId: levels.get(r.level)! },
        });
        await tx.rolePermission.createMany({
          data: r.permissions.map((k) => ({ roleId: role.id, permissionId: permId(k) })),
          skipDuplicates: true,
        });
      }

      // Allowed same-level reporting lines
      const roleIds = new Map((await tx.role.findMany()).map((r) => [r.key, r.id]));
      for (const rule of SAME_LEVEL_RULES) {
        await tx.sameLevelReportingRule.upsert({
          where: { managerRoleId_employeeRoleId: { managerRoleId: roleIds.get(rule.manager)!, employeeRoleId: roleIds.get(rule.employee)! } },
          update: {},
          create: { managerRoleId: roleIds.get(rule.manager)!, employeeRoleId: roleIds.get(rule.employee)!, reason: rule.reason },
        });
      }

      // Duties and duty permissions
      for (const d of DUTIES) {
        const duty = await tx.duty.upsert({
          where: { key: d.key },
          update: { name: d.name, requiresTwoFactor: d.requiresTwoFactor },
          create: { key: d.key, name: d.name, requiresTwoFactor: d.requiresTwoFactor },
        });
        await tx.dutyPermission.createMany({
          data: d.permissions.map((k) => ({ dutyId: duty.id, permissionId: permId(k) })),
          skipDuplicates: true,
        });
      }

      // Departments and offices
      for (const d of DEPARTMENTS) {
        await tx.department.upsert({ where: { code: d.code }, update: {}, create: d });
      }
      for (const o of OFFICES) {
        await tx.office.upsert({ where: { code: o.code }, update: {}, create: o });
      }
      const departments = new Map((await tx.department.findMany()).map((d) => [d.code, d.id]));
      const offices = new Map((await tx.office.findMany()).map((o) => [o.code, o.id]));
      const roles = new Map((await tx.role.findMany()).map((r) => [r.key, r.id]));
      const dutyIds = new Map((await tx.duty.findMany()).map((d) => [d.key, d.id]));

      // Employees (the Emp-ID is generated by the database)
      const bySlug = new Map<string, string>();
      for (const e of DEMO_EMPLOYEES) {
        const email = demoEmail(e);
        let employee = await tx.employee.findUnique({ where: { officialEmail: email } });
        if (!employee) {
          employee = await tx.employee.create({
            data: {
              empId: e.empId,
              fullName: e.name,
              designation: e.designation,
              departmentId: departments.get(e.department)!,
              officeId: offices.get(e.office ?? 'HO')!,
              officialEmail: email,
              levelId: levels.get(e.level)!,
              roleId: roles.get(e.role)!,
              reportsToId: e.reportsTo ? bySlug.get(e.reportsTo)! : null,
              joiningDate: new Date('2026-01-05'),
              employmentType: e.type ?? 'full_time',
              weeklyCapacityHours: e.weeklyHours ?? 40,
            },
          });
          await tx.employmentHistory.create({
            data: { employeeId: employee.id, eventType: 'joined', effectiveOn: new Date('2026-01-05'), reason: 'Demo seed data' },
          });
          for (const duty of e.duties ?? []) {
            await tx.employeeDuty.create({
              data: { employeeId: employee.id, dutyId: dutyIds.get(duty)!, reason: 'Demo seed data' },
            });
          }
        }
        bySlug.set(e.slug, employee.id);
      }

      // The demo roster uses explicit Emp-IDs up to ACV-0015; the sequence must never hand those out again.
      await tx.$executeRaw`SELECT setval('emp_id_seq', GREATEST((SELECT last_value FROM emp_id_seq), 15))`;

      await rebuildReportingClosure(tx);
    },
    { timeout: 60000 },
  );
}
