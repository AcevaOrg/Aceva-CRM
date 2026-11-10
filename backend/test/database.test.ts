import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { DEMO_EMPLOYEES, DEPARTMENTS, DUTIES, LEVELS, OFFICES, PERMISSIONS, ROLES, seedDatabase } from '../prisma/seed-data';
import { createTestPrisma, inRolledBackTransaction } from './helpers/prisma';

let prisma: PrismaClient;
beforeAll(() => {
  prisma = createTestPrisma();
});
afterAll(async () => {
  await prisma.$disconnect();
});

/** Runs SQL inside a transaction that is always rolled back, and returns the error message (or null). */
async function sqlError(sql: string): Promise<string | null> {
  try {
    await inRolledBackTransaction(prisma, async (tx) => {
      await tx.$executeRawUnsafe(sql);
    });
    return null;
  } catch (error) {
    return String((error as Error).message);
  }
}

describe('seed data integrity', () => {
  it('has exactly the five hierarchy levels from the plan', async () => {
    const levels = await prisma.level.findMany({ orderBy: { number: 'asc' } });
    expect(levels.map((l) => [l.number, l.name])).toEqual(LEVELS.map((l) => [l.number, l.name]));
  });

  it('gives every level exactly one default role', async () => {
    for (const level of await prisma.level.findMany()) {
      const defaults = await prisma.role.count({ where: { levelId: level.id, isDefault: true } });
      expect(defaults, `level ${level.number}`).toBe(1);
    }
  });

  it('loads the permission catalogue, role permissions and duty permissions', async () => {
    expect(await prisma.permission.count()).toBe(PERMISSIONS.length);
    expect(await prisma.role.count()).toBe(ROLES.length);
    expect(await prisma.duty.count()).toBe(DUTIES.length);
    const permissionKeys = new Set((await prisma.permission.findMany()).map((p) => p.key));
    for (const key of ['task.assign', 'finance.view', 'payroll.approve']) {
      expect(permissionKeys.has(key)).toBe(true);
    }
    // Duty permissions are separate from role permissions.
    const finance = await prisma.duty.findUniqueOrThrow({
      where: { key: 'finance' },
      include: { dutyPermissions: { include: { permission: true } } },
    });
    expect(finance.dutyPermissions.map((p) => p.permission.key)).toContain('payroll.prepare');
    expect(finance.requiresTwoFactor).toBe(true);
  });

  it('loads departments and offices', async () => {
    expect(await prisma.department.count()).toBe(DEPARTMENTS.length);
    expect(await prisma.office.count()).toBe(OFFICES.length);
  });

  it('creates the demo people with the roster Emp-IDs (ACV-0005 stays unused)', async () => {
    const employees = await prisma.employee.findMany({ orderBy: { empId: 'asc' } });
    expect(employees).toHaveLength(DEMO_EMPLOYEES.length);
    expect(employees.map((e) => e.empId)).toEqual(
      DEMO_EMPLOYEES.map((e) => e.empId),
    );
  });

  it('has Owner, CEO, Director and CTO as four separate people at the plan levels', async () => {
    const byRole = async (key: string) =>
      prisma.employee.findFirstOrThrow({ where: { role: { key } }, include: { level: true, reportsTo: true } });
    const owner = await byRole('owner');
    const ceo = await byRole('ceo');
    const director = await byRole('director');
    const cto = await byRole('cto');
    expect([owner.level.number, ceo.level.number, director.level.number, cto.level.number]).toEqual([1, 2, 3, 3]);
    expect(owner.reportsToId).toBeNull();
    expect(ceo.reportsToId).toBe(owner.id);
    expect(director.reportsToId).toBe(ceo.id);
    expect(cto.reportsToId).toBe(director.id);
  });

  it('gives every employee except the Owner a reporting person', async () => {
    const without = await prisma.employee.findMany({ where: { reportsToId: null }, include: { role: true } });
    expect(without.map((e) => e.role.key)).toEqual(['owner']);
  });

  it('has one clearly labelled demo HR employee and a Finance-duty employee', async () => {
    const hr = await prisma.employee.findMany({ where: { fullName: { contains: 'DEMO HR' } } });
    expect(hr).toHaveLength(1);
    const holders = async (duty: string) =>
      (await prisma.employeeDuty.findMany({ where: { duty: { key: duty }, endedAt: null }, include: { employee: true } })).map(
        (d) => d.employee.fullName,
      );
    expect(await holders('hr')).toContain(hr[0].fullName);
    expect((await holders('finance')).length).toBe(1);
  });

  it('seeds no passwords or credentials', async () => {
    expect(await prisma.credential.count()).toBe(0);
    expect(await prisma.passwordHistory.count()).toBe(0);
  });

  it('is safe to run twice (no duplicates)', async () => {
    await seedDatabase(prisma);
    expect(await prisma.employee.count()).toBe(DEMO_EMPLOYEES.length);
    expect(await prisma.rolePermission.count()).toBe(ROLES.reduce((n, r) => n + new Set(r.permissions).size, 0));
  });
});

describe('reporting closure table', () => {
  it('has a depth-0 row for every employee', async () => {
    const selfRows = await prisma.reportingClosure.count({ where: { depth: 0 } });
    expect(selfRows).toBe(DEMO_EMPLOYEES.length);
  });

  it('matches the reports_to tree exactly', async () => {
    const rows = await prisma.$queryRaw<Array<{ missing: bigint; extra: bigint }>>`
      WITH RECURSIVE tree(a, d, depth) AS (
        SELECT id, id, 0 FROM employees
        UNION ALL
        SELECT t.a, e.id, t.depth + 1 FROM tree t JOIN employees e ON e.reports_to_id = t.d
      )
      SELECT
        (SELECT count(*) FROM tree t WHERE NOT EXISTS (
           SELECT 1 FROM reporting_closure c WHERE c.ancestor_id = t.a AND c.descendant_id = t.d AND c.depth = t.depth)) AS missing,
        (SELECT count(*) FROM reporting_closure c WHERE NOT EXISTS (
           SELECT 1 FROM tree t WHERE c.ancestor_id = t.a AND c.descendant_id = t.d AND c.depth = t.depth)) AS extra`;
    expect(Number(rows[0].missing)).toBe(0);
    expect(Number(rows[0].extra)).toBe(0);
  });

  it('answers "everyone below me" in one query: the CTO sees 5 people below and the Owner sees all', async () => {
    const below = async (roleKey: string) =>
      prisma.reportingClosure.count({ where: { ancestor: { role: { key: roleKey } }, depth: { gt: 0 } } });
    expect(await below('cto')).toBe(5);
    expect(await below('owner')).toBe(DEMO_EMPLOYEES.length - 1);
  });
});

describe('Emp-ID rules', () => {
  it('cannot be changed after creation', async () => {
    const message = await sqlError(`UPDATE employees SET emp_id = 'ACV-9999' WHERE emp_id = 'ACV-0001'`);
    expect(message).toMatch(/emp_id/i);
  });

  it('cannot be reused: employee records can never be deleted', async () => {
    const message = await sqlError(`DELETE FROM employees WHERE emp_id = 'ACV-0013'`);
    expect(message).toMatch(/never deleted/i);
  });

  it('stays unique and ordered when many employees are created at the same moment', async () => {
    const template = await prisma.employee.findFirstOrThrow({ where: { role: { key: 'employee' } } });
    const ids = await Promise.all(
      Array.from({ length: 15 }, (_, i) =>
        inRolledBackTransaction(prisma, async (tx) => {
          const created = await tx.employee.create({
            data: {
              fullName: `Concurrent ${i}`,
              designation: 'Test',
              departmentId: template.departmentId,
              officeId: template.officeId,
              levelId: template.levelId,
              roleId: template.roleId,
              reportsToId: template.reportsToId,
              joiningDate: new Date('2026-02-01'),
            },
          });
          return created.empId;
        }),
      ),
    );
    expect(new Set(ids).size).toBe(15);
    ids.forEach((id) => expect(id).toMatch(/^ACV-\d{4,}$/));
    // Every new ID is after the seeded ones.
    expect([...ids].sort()[0] > 'ACV-0015').toBe(true); // the sequence continues after the roster
  });

  it('never hands out an Emp-ID that the demo roster already uses', async () => {
    const [row] = await prisma.$queryRaw<Array<{ last_value: bigint }>>`SELECT last_value FROM emp_id_seq`;
    expect(Number(row.last_value)).toBeGreaterThanOrEqual(15);
  });

  it('is never reused even after a rolled-back creation (gaps are fine)', async () => {
    const template = await prisma.employee.findFirstOrThrow({ where: { role: { key: 'employee' } } });
    const make = () =>
      inRolledBackTransaction(prisma, (tx) =>
        tx.employee.create({
          data: {
            fullName: 'Gap test',
            designation: 'Test',
            departmentId: template.departmentId,
            officeId: template.officeId,
            levelId: template.levelId,
            roleId: template.roleId,
            joiningDate: new Date('2026-02-01'),
          },
        }),
      );
    const first = await make();
    const second = await make();
    expect(second.empId > first.empId).toBe(true);
  });
});

describe('database constraints', () => {
  it('rejects a level outside 1 to 5', async () => {
    expect(await sqlError(`INSERT INTO levels (number, name) VALUES (6, 'Sixth')`)).toMatch(/levels_number_range/);
  });

  it('rejects a second default role for the same level', async () => {
    const message = await sqlError(`
      INSERT INTO roles (key, name, level_id, is_default)
      SELECT 'second_default', 'Second', id, true FROM levels WHERE number = 5`);
    expect(message).toMatch(/roles_one_default_per_level/);
  });

  it('rejects an employee who reports to themselves', async () => {
    expect(await sqlError(`UPDATE employees SET reports_to_id = id WHERE emp_id = 'ACV-0013'`)).toMatch(
      /employees_not_own_manager/,
    );
  });

  it('rejects a duplicate active duty for the same employee', async () => {
    const message = await sqlError(`
      INSERT INTO employee_duties (employee_id, duty_id)
      SELECT employee_id, duty_id FROM employee_duties WHERE ended_at IS NULL LIMIT 1`);
    expect(message).toMatch(/employee_duties_one_active/);
  });

  it('rejects an invalid stand-in (self, or ending before it starts)', async () => {
    const self = await sqlError(`
      INSERT INTO stand_ins (manager_id, stand_in_id, starts_on, ends_on)
      SELECT id, id, '2026-12-01', '2026-12-05' FROM employees WHERE emp_id = 'ACV-0004'`);
    expect(self).toMatch(/stand_ins_not_self/);
    const dates = await sqlError(`
      INSERT INTO stand_ins (manager_id, stand_in_id, starts_on, ends_on)
      SELECT m.id, s.id, '2026-12-05', '2026-12-01' FROM employees m, employees s
      WHERE m.emp_id = 'ACV-0004' AND s.emp_id = 'ACV-0015'`);
    expect(dates).toMatch(/stand_ins_dates_ordered/);
  });

  it('stores money as NUMERIC(12,2) and rejects negative pay', async () => {
    const columns = await prisma.$queryRaw<Array<{ column_name: string; numeric_precision: number; numeric_scale: number }>>`
      SELECT column_name, numeric_precision, numeric_scale FROM information_schema.columns
      WHERE table_name = 'employee_pay' AND data_type = 'numeric'`;
    expect(columns.map((c) => [c.column_name, c.numeric_precision, c.numeric_scale]).sort()).toEqual([
      ['allowances', 12, 2],
      ['base_salary', 12, 2],
    ]);
    const message = await sqlError(`
      INSERT INTO employee_pay (employee_id, base_salary) SELECT id, -1 FROM employees WHERE emp_id = 'ACV-0013'`);
    expect(message).toMatch(/employee_pay_non_negative/);
  });

  it('uses UUID primary keys and UTC-safe timestamps on the main tables', async () => {
    const rows = await prisma.$queryRaw<Array<{ table_name: string; data_type: string }>>`
      SELECT table_name, data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name = 'id' AND table_name IN
        ('employees','roles','permissions','sessions','audit_log','outbox_events','stand_ins')`;
    expect(rows).toHaveLength(7);
    rows.forEach((r) => expect(r.data_type).toBe('uuid'));
    const timestamps = await prisma.$queryRaw<Array<{ data_type: string }>>`
      SELECT DISTINCT data_type FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('created_at', 'updated_at', 'occurred_at', 'changed_at')`;
    expect(timestamps.map((t) => t.data_type)).toEqual(['timestamp with time zone']);
  });

  it('stores a password only as a hash column (no plain password column anywhere)', async () => {
    const rows = await prisma.$queryRaw<Array<{ column_name: string }>>`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name ILIKE '%password%' ORDER BY column_name`;
    expect(rows.map((r) => r.column_name)).toEqual(['must_change_password', 'password_changed_at', 'password_hash', 'password_hash']);
  });
});

describe('insert-only history tables', () => {
  const tables: Array<[string, string]> = [
    ['audit_log', `INSERT INTO audit_log (action, target_type) VALUES ('test.action', 'test')`],
    [
      'profile_changes',
      `INSERT INTO profile_changes (employee_id, section, field, old_value, new_value, changed_by)
       SELECT id, 'basic', 'designation', 'a', 'b', id FROM employees WHERE emp_id = 'ACV-0001'`,
    ],
    [
      'employment_history',
      `INSERT INTO employment_history (employee_id, event_type, effective_on)
       SELECT id, 'joined', '2026-01-05' FROM employees WHERE emp_id = 'ACV-0001'`,
    ],
    [
      'password_history',
      `INSERT INTO password_history (employee_id, password_hash) SELECT id, 'hash' FROM employees WHERE emp_id = 'ACV-0001'`,
    ],
    ['login_attempts', `INSERT INTO login_attempts (emp_id_attempted, ip, success) VALUES ('ACV-0001', '127.0.0.1', false)`],
  ];

  for (const [table, insert] of tables) {
    it(`${table}: allows inserts but blocks update, delete and truncate`, async () => {
      await inRolledBackTransaction(prisma, async (tx) => {
        await tx.$executeRawUnsafe(insert); // adding rows works
      });
      for (const change of [`UPDATE ${table} SET id = id`, `DELETE FROM ${table}`, `TRUNCATE ${table}`]) {
        const message = await sqlError(`${insert}; ${change}`);
        expect(message, `${table}: ${change}`).toMatch(/insert-only/);
      }
    });
  }
});

describe('outbox and scheduled jobs', () => {
  it('stores an outbox event in the same transaction as a change', async () => {
    const count = await inRolledBackTransaction(prisma, async (tx) => {
      await tx.outboxEvent.create({
        data: { type: 'employee.offboarded', version: 1, actor: 'system', payload: { empId: 'ACV-0013' } },
      });
      return tx.outboxEvent.count();
    });
    expect(count).toBe(1);
    expect(await prisma.outboxEvent.count()).toBe(0); // rolled back
  });

  it('prevents duplicate scheduled jobs through dedupe_key', async () => {
    const message = await sqlError(`
      INSERT INTO scheduled_jobs (type, dedupe_key, payload, run_at) VALUES ('t', 'k1', '{}', now());
      INSERT INTO scheduled_jobs (type, dedupe_key, payload, run_at) VALUES ('t', 'k1', '{}', now())`);
    expect(message).toMatch(/dedupe_key|scheduled_jobs/);
  });
});
