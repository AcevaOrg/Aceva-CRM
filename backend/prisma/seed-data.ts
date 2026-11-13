import type { PrismaClient } from '../src/generated/prisma/client';
import { DUTY_SEEDS, PERMISSION_KEYS, ROLE_SEEDS } from './permission-catalogue';
import { seedCycle3Defaults } from './seed-cycle3';

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

export const PERMISSIONS: Array<{ key: string; module: string; description: string }> = PERMISSION_KEYS.map((key) => {
  const [module, action] = key.split('.');
  const words = action.replace(/_/g, ' ');
  return { key, module, description: `${module}: ${words}` };
});

export const ROLES = ROLE_SEEDS;
export const DUTIES = DUTY_SEEDS;

/**
 * The only allowed same-level reporting lines (plan: the CTO reports to the Director, both Level 3).
 * Everything else must report to a strictly higher level.
 */
export const SAME_LEVEL_RULES: Array<{ manager: string; employee: string; reason: string }> = [
  { manager: 'director', employee: 'cto', reason: 'The CTO (Level 3) reports to the Director (Level 3), as documented in the company structure.' },
];

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
 * The demo company, following the DEVELOPMENT PLAN's five levels:
 *   Level 1 Owner > Level 3 Director > Level 3 CTO (same-level line, explicitly configured),
 *   Level 4 heads and leads (Sales, Finance) report to the Director, Level 5 developers report to the CTO.
 * Level 2 (CEO) is an official level and role, but the demo company has no CEO yet, so the Director reports to the Owner.
 * The demo HR work is done by the Director, who holds the HR duty. Emp-IDs match the frontend's demo roster; ACV-0002, ACV-0005
 * and ACV-0015 are not used (Emp-IDs are never renumbered or reused).
 */
export const DEMO_EMPLOYEES: DemoEmployee[] = [
  { empId: 'ACV-0001', slug: 'owner', name: 'Hamza Qureshi', email: 'hamza', designation: 'Owner and Founder', department: 'dep-mgmt', office: 'off-dadu', level: 1, role: 'owner', reportsTo: null },
  { empId: 'ACV-0003', slug: 'director', name: 'Bilal Ahmed', email: 'bilal', designation: 'Director', department: 'dep-mgmt', office: 'off-dadu', level: 3, role: 'director', reportsTo: 'owner', duties: ['hr'] },
  { empId: 'ACV-0004', slug: 'cto', name: 'Omar Farooq', email: 'omar', designation: 'Chief Technology Officer', department: 'dep-eng', office: 'off-dadu', level: 3, role: 'cto', reportsTo: 'director' },
  { empId: 'ACV-0006', slug: 'dev1', name: 'Fahad Khan', email: 'fahad', designation: 'Senior Backend Developer', department: 'dep-eng', office: 'off-khi', level: 5, role: 'employee', reportsTo: 'cto' },
  { empId: 'ACV-0007', slug: 'dev2', name: 'Mariam Shah', email: 'mariam', designation: 'Software Developer', department: 'dep-eng', office: 'off-khi', level: 5, role: 'employee', reportsTo: 'cto' },
  { empId: 'ACV-0008', slug: 'dev3', name: 'Ali Raza', email: 'ali', designation: 'Backend Developer', department: 'dep-eng', office: 'off-remote', level: 5, role: 'employee', reportsTo: 'cto' },
  { empId: 'ACV-0009', slug: 'sales1', name: 'Hira Baig', email: 'hira', designation: 'Sales Executive', department: 'dep-sales', office: 'off-khi', level: 4, role: 'sales', reportsTo: 'director' },
  { empId: 'ACV-0010', slug: 'finance', name: 'Sana Malik', email: 'sana', designation: 'Finance Officer', department: 'dep-fin', office: 'off-dadu', level: 4, role: 'level4_default', reportsTo: 'director', duties: ['finance'] },
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

      // Modules 7, 8, 9: development defaults (not company policy; see seed-cycle3.ts).
      await seedCycle3Defaults(tx);

      await rebuildReportingClosure(tx);
    },
    { timeout: 60000 },
  );
}
