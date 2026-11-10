import type { PrismaClient } from '../../src/generated/prisma/client';

/**
 * Creates a new employee for a test (employees are never deleted, so test files that do this reset the
 * database afterwards). Also adds the reporting-tree rows the scope rules rely on.
 */
export async function createEmployee(
  prisma: PrismaClient,
  options: { name: string; officialEmail?: string | null; roleKey?: string; reportsToEmpId?: string },
): Promise<{ id: string; empId: string }> {
  const roleKey = options.roleKey ?? 'employee';
  const role = await prisma.role.findUniqueOrThrow({ where: { key: roleKey }, select: { id: true, levelId: true } });
  const manager = await prisma.employee.findUniqueOrThrow({
    where: { empId: options.reportsToEmpId ?? 'ACV-0004' },
    select: { id: true, departmentId: true, officeId: true },
  });
  const created = await prisma.employee.create({
    data: {
      fullName: options.name,
      designation: 'Test person',
      departmentId: manager.departmentId,
      officeId: manager.officeId,
      levelId: role.levelId,
      roleId: role.id,
      reportsToId: manager.id,
      joiningDate: new Date('2026-02-01'),
      officialEmail: options.officialEmail === undefined ? null : options.officialEmail,
    },
    select: { id: true, empId: true },
  });
  await prisma.$executeRaw`
    INSERT INTO reporting_closure (ancestor_id, descendant_id, depth)
    SELECT ancestor_id, ${created.id}::uuid, depth + 1 FROM reporting_closure WHERE descendant_id = ${manager.id}::uuid
    UNION ALL SELECT ${created.id}::uuid, ${created.id}::uuid, 0`;
  return created;
}
