import type { PrismaClient } from '../src/generated/prisma/client';
import { DUTY_SEEDS, PERMISSION_KEYS, ROLE_SEEDS } from './permission-catalogue';

/**
 * Development and test seed data. Safe to run more than once (it only adds what is missing).
 *
 * The company structure is the one the owner of the company decided (final):
 *   Level 1 CEO / Founder / Owner | Level 2 Director | Level 3 CTO | Level 4 Sales and Finance | Level 5 Developer / SQA
 *
 * All people below are fictional demo data. No passwords are created (login is built in M2).
 */

export const LEVELS = [
  { number: 1, name: 'CEO / Founder / Owner' },
  { number: 2, name: 'Director' },
  { number: 3, name: 'CTO' },
  { number: 4, name: 'Sales and Finance' },
  { number: 5, name: 'Developer / SQA' },
] as const;

export const PERMISSIONS: Array<{ key: string; module: string; description: string }> = PERMISSION_KEYS.map((key) => {
  const [module, action] = key.split('.');
  const words = action.replace(/_/g, ' ');
  return { key, module, description: `${module}: ${words}` };
});

export const ROLES = ROLE_SEEDS;
export const DUTIES = DUTY_SEEDS;

/**
 * Allowed same-level reporting lines. NONE are configured: in the final structure everybody reports to someone at a
 * strictly higher level (the CTO, Level 3, reports to the Director, Level 2). The rule table stays, so a pair can be
 * added here later if the company ever needs one; the seed keeps the table equal to this list.
 */
export const SAME_LEVEL_RULES: Array<{ manager: string; employee: string; reason: string }> = [];

/** Department and office codes match the ids the frontend already uses (dep-eng, off-khi ...). */
export const DEPARTMENTS = [
  { code: 'dep-mgmt', name: 'Management', head: 'ACV-0001' },
  { code: 'dep-eng', name: 'Software Development', head: 'ACV-0004' },
  { code: 'dep-sales', name: 'Sales', head: 'ACV-0003' },
  { code: 'dep-fin', name: 'Finance', head: 'ACV-0003' },
  { code: 'dep-hr', name: 'Human Resources', head: 'ACV-0003' },
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
 * The demo company, in the final structure:
 *   Level 1 CEO / Founder / Owner > Level 2 Director > Level 3 CTO > Level 5 Developer / SQA,
 *   Level 4 Sales and the Finance person report to the Director.
 * The Director also holds the HR and sales-manager duties (there is no separate HR person). Emp-IDs match the frontend's
 * demo roster; ACV-0002, ACV-0005 and ACV-0015 are not used (Emp-IDs are never renumbered or reused).
 */
export const DEMO_EMPLOYEES: DemoEmployee[] = [
  { empId: 'ACV-0001', slug: 'owner', name: 'Hamza Qureshi', email: 'hamza', designation: 'CEO, Founder and Owner', department: 'dep-mgmt', office: 'off-dadu', level: 1, role: 'owner', reportsTo: null },
  { empId: 'ACV-0003', slug: 'director', name: 'Bilal Ahmed', email: 'bilal', designation: 'Director', department: 'dep-mgmt', office: 'off-dadu', level: 2, role: 'director', reportsTo: 'owner', duties: ['hr', 'sales_manager'] },
  { empId: 'ACV-0004', slug: 'cto', name: 'Omar Farooq', email: 'omar', designation: 'Chief Technology Officer', department: 'dep-eng', office: 'off-dadu', level: 3, role: 'cto', reportsTo: 'director' },
  { empId: 'ACV-0006', slug: 'dev1', name: 'Fahad Khan', email: 'fahad', designation: 'Senior Backend Developer', department: 'dep-eng', office: 'off-khi', level: 5, role: 'employee', reportsTo: 'cto' },
  { empId: 'ACV-0007', slug: 'dev2', name: 'Mariam Shah', email: 'mariam', designation: 'Software Developer', department: 'dep-eng', office: 'off-khi', level: 5, role: 'employee', reportsTo: 'cto' },
  { empId: 'ACV-0008', slug: 'dev3', name: 'Ali Raza', email: 'ali', designation: 'Backend Developer', department: 'dep-eng', office: 'off-remote', level: 5, role: 'employee', reportsTo: 'cto' },
  { empId: 'ACV-0009', slug: 'sales1', name: 'Hira Baig', email: 'hira', designation: 'Sales Executive', department: 'dep-sales', office: 'off-khi', level: 4, role: 'sales', reportsTo: 'director' },
  { empId: 'ACV-0010', slug: 'finance', name: 'Sana Malik', email: 'sana', designation: 'Finance Officer', department: 'dep-fin', office: 'off-dadu', level: 4, role: 'finance', reportsTo: 'director', duties: ['finance'] },
  { empId: 'ACV-0011', slug: 'sqa1', name: 'Danish Iqbal', email: 'danish', designation: 'SQA Engineer', department: 'dep-eng', office: 'off-khi', level: 5, role: 'employee', reportsTo: 'cto' },
  { empId: 'ACV-0012', slug: 'sales2', name: 'Kamran Javed', email: 'kamran', designation: 'Sales Executive', department: 'dep-sales', office: 'off-remote', level: 4, role: 'sales', reportsTo: 'director' },
  { empId: 'ACV-0013', slug: 'sqa2', name: 'Nida Aslam', email: 'nida', designation: 'SQA Intern', department: 'dep-eng', office: 'off-dadu', level: 5, role: 'employee', reportsTo: 'cto', type: 'intern', weeklyHours: 20 },
  { empId: 'ACV-0014', slug: 'sales3', name: 'Saad Mirza', email: 'saad', designation: 'Senior Sales Executive', department: 'dep-sales', office: 'off-khi', level: 4, role: 'sales', reportsTo: 'director' },
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

/**
 * A local database created before the final company structure still has people on a removed role (ceo, level3_default,
 * level4_default) or on a role whose level moved (the Director was Level 3). The seed never moves people by itself:
 * it stops and asks for a rebuild instead (nothing is changed, the transaction is rolled back).
 */
async function refuseOldStructure(tx: Tx): Promise<void> {
  const levelOfRole = new Map(ROLES.map((r) => [r.key, r.level]));
  const people = await tx.employee.findMany({ select: { empId: true, level: { select: { number: true } }, role: { select: { key: true } } } });
  const stale = people.filter((p) => levelOfRole.get(p.role.key) !== p.level.number);
  if (stale.length) {
    const list = stale.map((p) => `${p.empId} (role ${p.role.key}, Level ${p.level.number})`).join(', ');
    throw new Error(
      `This database still has the old company structure: ${list}. Rebuild it with "npm run db:reset -w backend", ` +
        'then run "npm run db:seed" (see docs/SETUP.md).',
    );
  }
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

      // Roles and role permissions. The catalogue is the source of truth, so an older database is brought in line too:
      // each role gets its level, name and default flag, and EXACTLY the listed permissions.
      await refuseOldStructure(tx);
      // Every level has exactly one default role (a unique index), and the default of a level can move: clear them first.
      await tx.role.updateMany({ where: { isDefault: true }, data: { isDefault: false } });
      for (const r of ROLES) {
        const role = await tx.role.upsert({
          where: { key: r.key },
          update: { name: r.name, isDefault: r.isDefault, levelId: levels.get(r.level)! },
          create: { key: r.key, name: r.name, isDefault: r.isDefault, levelId: levels.get(r.level)! },
        });
        const wanted = r.permissions.map(permId);
        await tx.rolePermission.deleteMany({ where: { roleId: role.id, permissionId: { notIn: wanted } } });
        await tx.rolePermission.createMany({
          data: wanted.map((permissionId) => ({ roleId: role.id, permissionId })),
          skipDuplicates: true,
        });
      }

      // Roles that are no longer part of the structure (the old ceo, level3_default and level4_default) are removed.
      // Nobody holds them any more (refuseOldStructure checked that).
      const removed = (await tx.role.findMany({ where: { key: { notIn: ROLES.map((r) => r.key) } }, select: { id: true } })).map((r) => r.id);
      if (removed.length) {
        await tx.sameLevelReportingRule.deleteMany({ where: { OR: [{ managerRoleId: { in: removed } }, { employeeRoleId: { in: removed } }] } });
        await tx.rolePermission.deleteMany({ where: { roleId: { in: removed } } });
        await tx.role.deleteMany({ where: { id: { in: removed } } });
      }

      // Allowed same-level reporting lines: exactly the configured ones (none today).
      const roleIds = new Map((await tx.role.findMany()).map((r) => [r.key, r.id]));
      const configured = SAME_LEVEL_RULES.map((rule) => ({ managerRoleId: roleIds.get(rule.manager)!, employeeRoleId: roleIds.get(rule.employee)!, reason: rule.reason }));
      for (const existing of await tx.sameLevelReportingRule.findMany()) {
        const keep = configured.some((c) => c.managerRoleId === existing.managerRoleId && c.employeeRoleId === existing.employeeRoleId);
        if (!keep) await tx.sameLevelReportingRule.delete({ where: { id: existing.id } });
      }
      for (const rule of configured) {
        await tx.sameLevelReportingRule.upsert({
          where: { managerRoleId_employeeRoleId: { managerRoleId: rule.managerRoleId, employeeRoleId: rule.employeeRoleId } },
          update: {},
          create: rule,
        });
      }

      // Duties and duty permissions
      for (const d of DUTIES) {
        const duty = await tx.duty.upsert({
          where: { key: d.key },
          update: { name: d.name, requiresTwoFactor: d.requiresTwoFactor },
          create: { key: d.key, name: d.name, requiresTwoFactor: d.requiresTwoFactor },
        });
        const wanted = d.permissions.map(permId);
        await tx.dutyPermission.deleteMany({ where: { dutyId: duty.id, permissionId: { notIn: wanted } } });
        await tx.dutyPermission.createMany({
          data: wanted.map((permissionId) => ({ dutyId: duty.id, permissionId })),
          skipDuplicates: true,
        });
      }

      // Departments and offices
      for (const d of DEPARTMENTS) {
        await tx.department.upsert({ where: { code: d.code }, update: {}, create: { code: d.code, name: d.name } });
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

      // Department heads are set explicitly (only where none is set yet), never worked out from reporting lines.
      for (const d of DEPARTMENTS) {
        const head = await tx.employee.findUnique({ where: { empId: d.head }, select: { id: true } });
        if (head) await tx.department.updateMany({ where: { code: d.code, headEmployeeId: null }, data: { headEmployeeId: head.id } });
      }

      // The demo roster uses explicit Emp-IDs up to ACV-0014; the sequence must never hand those out again.
      await tx.$executeRaw`SELECT setval('emp_id_seq', GREATEST((SELECT last_value FROM emp_id_seq), 14))`;

      await rebuildReportingClosure(tx);
    },
    { timeout: 60000 },
  );
}
