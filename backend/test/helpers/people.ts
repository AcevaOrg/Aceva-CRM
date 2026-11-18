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

/**
 * A test-only person who is NOT in the demo seed: an HR officer (Level 4 with the HR duty, reporting to the Director),
 * so the HR-duty permission rules are covered separately from the Director (who holds the HR duty in the demo seed).
 * The HR officer has the default Level 4 role (sales, the role a Level 4 hire outside Finance gets); the HR permissions
 * come from the duty. There is no test-only CEO any more: the final structure has no separate CEO role.
 * Created inside the test database only. Safe to call more than once. Gives them a login (call seedDevPasswords after).
 */
export async function createFixtureStaff(prisma: PrismaClient): Promise<{ HR: string }> {
  const find = async (email: string) => prisma.employee.findUnique({ where: { officialEmail: email }, select: { empId: true } });
  let hr = await find('fixture.hr@acevatech.com');
  if (!hr) {
    const created = await createEmployee(prisma, { name: 'Test HR Officer', officialEmail: 'fixture.hr@acevatech.com', roleKey: 'sales', reportsToEmpId: 'ACV-0003' });
    const person = await prisma.employee.findUniqueOrThrow({ where: { empId: created.empId }, select: { id: true } });
    const department = await prisma.department.findUniqueOrThrow({ where: { code: 'dep-hr' }, select: { id: true } });
    const duty = await prisma.duty.findUniqueOrThrow({ where: { key: 'hr' }, select: { id: true } });
    await prisma.employee.update({ where: { id: person.id }, data: { designation: 'HR Officer', departmentId: department.id } });
    await prisma.employeeDuty.create({ data: { employeeId: person.id, dutyId: duty.id, reason: 'Test fixture' } });
    hr = { empId: created.empId };
  }
  return { HR: hr.empId };
}
