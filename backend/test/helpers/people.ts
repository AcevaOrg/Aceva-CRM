import type { PrismaClient } from '../../src/generated/prisma/client';
import { rebuildReportingClosure } from '../../prisma/seed-data';

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
 * Test-only people who are NOT in the demo seed: a CEO (Level 2, between the Owner and the Director) and an HR officer
 * (Level 4 with the HR duty, reporting to the Director). Created inside the test database so the Level 2 role and the
 * HR-specific permission rules stay covered. Safe to call more than once. Gives them a login (call seedDevPasswords after).
 */
export async function createFixtureStaff(prisma: PrismaClient): Promise<{ CEO: string; HR: string }> {
  const find = async (email: string) => prisma.employee.findUnique({ where: { officialEmail: email }, select: { empId: true } });
  let hr = await find('fixture.hr@acevatech.com');
  if (!hr) {
    const created = await createEmployee(prisma, { name: 'Test HR Officer', officialEmail: 'fixture.hr@acevatech.com', roleKey: 'level4_default', reportsToEmpId: 'ACV-0003' });
    const person = await prisma.employee.findUniqueOrThrow({ where: { empId: created.empId }, select: { id: true } });
    const department = await prisma.department.findUniqueOrThrow({ where: { code: 'dep-hr' }, select: { id: true } });
    const duty = await prisma.duty.findUniqueOrThrow({ where: { key: 'hr' }, select: { id: true } });
    await prisma.employee.update({ where: { id: person.id }, data: { designation: 'HR Officer', departmentId: department.id } });
    await prisma.employeeDuty.create({ data: { employeeId: person.id, dutyId: duty.id, reason: 'Test fixture' } });
    hr = { empId: created.empId };
  }
  let ceo = await find('fixture.ceo@acevatech.com');
  if (!ceo) {
    const created = await createEmployee(prisma, { name: 'Test CEO', officialEmail: 'fixture.ceo@acevatech.com', roleKey: 'ceo', reportsToEmpId: 'ACV-0001' });
    const person = await prisma.employee.findUniqueOrThrow({ where: { empId: created.empId }, select: { id: true } });
    await prisma.employee.update({ where: { id: person.id }, data: { designation: 'Chief Executive Officer' } });
    // The Director reports to the CEO again, so tests can use the full Owner > CEO > Director chain.
    await prisma.$transaction(async (tx) => {
      await tx.employee.update({ where: { empId: 'ACV-0003' }, data: { reportsToId: person.id } });
      await rebuildReportingClosure(tx);
    });
    ceo = { empId: created.empId };
  }
  return { CEO: ceo.empId, HR: hr.empId };
}
