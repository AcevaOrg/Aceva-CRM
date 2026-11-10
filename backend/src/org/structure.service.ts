import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateDepartmentRequest, CreateOfficeRequest, UpdateDepartmentRequest, UpdateOfficeRequest } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const slug = (name: string): string =>
  name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);

/**
 * Departments and offices (plan section 5), changed by the Owner or CEO only.
 * Each department has an explicit head (`head_employee_id`) chosen by them; heads are never worked out from
 * reporting lines. "Removing" a department or office archives it (nothing is deleted). Every change is audited.
 */
@Injectable()
export class StructureService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- departments

  async createDepartment(actor: Actor, dto: CreateDepartmentRequest, client: RequestInfo) {
    return this.prisma.$transaction(async (tx) => {
      const code = `dep-${slug(dto.name)}`;
      if (await tx.department.findFirst({ where: { OR: [{ code }, { name: { equals: dto.name, mode: 'insensitive' } }] } })) {
        throw new ConflictException({ statusCode: 409, code: 'department_exists', message: 'A department with this name already exists' });
      }
      const head = dto.headEmpId ? await this.requireHead(tx, dto.headEmpId) : null;
      const created = await tx.department.create({
        data: { code, name: dto.name, headEmployeeId: head?.id ?? null, createdBy: actor.id },
      });
      await this.audit.record(
        { actorId: actor.id, action: 'org.department.created', targetType: 'department', targetId: code, reason: dto.reason, details: { name: dto.name, head: head?.empId ?? null }, ...client },
        tx,
      );
      return { id: created.code, name: created.name, headEmpId: head?.empId ?? null };
    });
  }

  async updateDepartment(actor: Actor, code: string, dto: UpdateDepartmentRequest, client: RequestInfo) {
    return this.prisma.$transaction(async (tx) => {
      const department = await tx.department.findFirst({ where: { code, archivedAt: null }, include: { head: { select: { empId: true } } } });
      if (!department) throw new NotFoundException('Department not found');

      const data: Prisma.DepartmentUncheckedUpdateInput = { updatedBy: actor.id };
      const before: Record<string, string | null> = {};
      const after: Record<string, string | null> = {};

      if (dto.name !== undefined && dto.name !== department.name) {
        if (await tx.department.findFirst({ where: { id: { not: department.id }, name: { equals: dto.name, mode: 'insensitive' } } })) {
          throw new ConflictException({ statusCode: 409, code: 'department_exists', message: 'A department with this name already exists' });
        }
        data.name = dto.name;
        before.name = department.name;
        after.name = dto.name;
      }
      if (dto.headEmpId !== undefined && (dto.headEmpId ?? null) !== (department.head?.empId ?? null)) {
        const head = dto.headEmpId ? await this.requireHead(tx, dto.headEmpId) : null;
        data.headEmployeeId = head?.id ?? null;
        before.head = department.head?.empId ?? null;
        after.head = head?.empId ?? null;
      }
      if (Object.keys(after).length === 0) throw new BadRequestException('Nothing to change');

      await tx.department.update({ where: { id: department.id }, data });
      await this.audit.record(
        {
          actorId: actor.id,
          // A head change is audited as its own action so it can be found easily.
          action: 'head' in after ? 'org.department.head_changed' : 'org.department.updated',
          targetType: 'department',
          targetId: code,
          reason: dto.reason,
          details: { before, after },
          ...client,
        },
        tx,
      );
      return { id: code, name: dto.name ?? department.name, headEmpId: 'head' in after ? after.head : (department.head?.empId ?? null) };
    });
  }

  async deactivateDepartment(actor: Actor, code: string, reason: string, client: RequestInfo) {
    return this.prisma.$transaction(async (tx) => {
      const department = await tx.department.findFirst({ where: { code, archivedAt: null } });
      if (!department) throw new NotFoundException('Department not found');
      const staff = await tx.employee.count({ where: { departmentId: department.id, status: { not: 'left' } } });
      if (staff > 0) {
        throw new ConflictException({ statusCode: 409, code: 'department_in_use', message: `${staff} people still work in this department. Move them first.` });
      }
      await tx.department.update({ where: { id: department.id }, data: { archivedAt: new Date(), updatedBy: actor.id } });
      await this.audit.record({ actorId: actor.id, action: 'org.department.deactivated', targetType: 'department', targetId: code, reason, ...client }, tx);
      return { id: code, deactivated: true };
    });
  }

  // ---------------------------------------------------------------- offices

  async createOffice(actor: Actor, dto: CreateOfficeRequest, client: RequestInfo) {
    return this.prisma.$transaction(async (tx) => {
      const code = `off-${slug(dto.name)}`;
      if (await tx.office.findFirst({ where: { OR: [{ code }, { name: { equals: dto.name, mode: 'insensitive' } }] } })) {
        throw new ConflictException({ statusCode: 409, code: 'office_exists', message: 'An office with this name already exists' });
      }
      const created = await tx.office.create({ data: { code, name: dto.name, city: dto.city ?? null, createdBy: actor.id } });
      await this.audit.record(
        { actorId: actor.id, action: 'org.office.created', targetType: 'office', targetId: code, reason: dto.reason, details: { name: dto.name, city: dto.city ?? null }, ...client },
        tx,
      );
      return { id: created.code, name: created.name, city: created.city ?? '' };
    });
  }

  async updateOffice(actor: Actor, code: string, dto: UpdateOfficeRequest, client: RequestInfo) {
    return this.prisma.$transaction(async (tx) => {
      const office = await tx.office.findFirst({ where: { code, archivedAt: null } });
      if (!office) throw new NotFoundException('Office not found');
      if (dto.name && dto.name !== office.name && (await tx.office.findFirst({ where: { id: { not: office.id }, name: { equals: dto.name, mode: 'insensitive' } } }))) {
        throw new ConflictException({ statusCode: 409, code: 'office_exists', message: 'An office with this name already exists' });
      }
      const updated = await tx.office.update({ where: { id: office.id }, data: { name: dto.name ?? office.name, city: dto.city ?? office.city, updatedBy: actor.id } });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'org.office.updated',
          targetType: 'office',
          targetId: code,
          reason: dto.reason,
          details: { before: { name: office.name, city: office.city }, after: { name: updated.name, city: updated.city } },
          ...client,
        },
        tx,
      );
      return { id: code, name: updated.name, city: updated.city ?? '' };
    });
  }

  async deactivateOffice(actor: Actor, code: string, reason: string, client: RequestInfo) {
    return this.prisma.$transaction(async (tx) => {
      const office = await tx.office.findFirst({ where: { code, archivedAt: null } });
      if (!office) throw new NotFoundException('Office not found');
      const staff = await tx.employee.count({ where: { officeId: office.id, status: { not: 'left' } } });
      if (staff > 0) throw new ConflictException({ statusCode: 409, code: 'office_in_use', message: `${staff} people still work in this office. Move them first.` });
      await tx.office.update({ where: { id: office.id }, data: { archivedAt: new Date(), updatedBy: actor.id } });
      await this.audit.record({ actorId: actor.id, action: 'org.office.deactivated', targetType: 'office', targetId: code, reason, ...client }, tx);
      return { id: code, deactivated: true };
    });
  }

  /** A department head must be a real employee who is still with the company. */
  private async requireHead(tx: Prisma.TransactionClient, empId: string) {
    const head = await tx.employee.findUnique({ where: { empId }, select: { id: true, empId: true, status: true } });
    if (!head) throw new NotFoundException(`Employee ${empId} not found`);
    if (head.status === 'left') throw new BadRequestException({ statusCode: 400, code: 'head_left', message: `${empId} has left the company, so cannot be a department head` });
    return head;
  }
}
