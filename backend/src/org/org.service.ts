import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  AssignDutyRequest,
  ChangeLevelRequest,
  ChangeReportingLineRequest,
  EndDutyRequest,
  OrgNode,
  TeamMember,
} from '@aceva/contracts';
import { AuditService } from '../access/audit.service';
import type { Actor } from '../access/access.types';
import type { RequestInfo } from '../access/decorators';
import { HierarchyService } from '../access/hierarchy.service';
import { checkLevelRules, checkReportingLine, type RulePerson } from '../access/rules/reporting-rules';
import { ScopeService } from '../access/scope.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const personSelect = {
  id: true,
  empId: true,
  status: true,
  reportsToId: true,
  roleId: true,
  level: { select: { id: true, number: true } },
  role: { select: { id: true, key: true } },
} satisfies Prisma.EmployeeSelect;

type PersonRow = Prisma.EmployeeGetPayload<{ select: typeof personSelect }>;

const toRulePerson = (p: PersonRow): RulePerson => ({
  id: p.id,
  empId: p.empId,
  levelNumber: p.level.number,
  roleId: p.roleId,
  status: p.status,
});

@Injectable()
export class OrgService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly hierarchy: HierarchyService,
    private readonly audit: AuditService,
  ) {}

  // ---------------------------------------------------------------- reading

  /** The whole organisation chart as a tree (directory-level information only). */
  async tree(): Promise<OrgNode[]> {
    const rows = await this.prisma.employee.findMany({
      orderBy: { empId: 'asc' },
      select: {
        empId: true,
        fullName: true,
        designation: true,
        status: true,
        level: { select: { number: true } },
        role: { select: { key: true } },
        department: { select: { name: true } },
        office: { select: { name: true } },
        reportsTo: { select: { empId: true } },
        duties: { where: { endedAt: null }, select: { duty: { select: { key: true } } } },
      },
    });

    const nodes = new Map<string, OrgNode>();
    for (const r of rows) {
      nodes.set(r.empId, {
        empId: r.empId,
        name: r.fullName,
        designation: r.designation,
        level: r.level.number,
        roleKey: r.role.key,
        department: r.department.name,
        office: r.office.name,
        status: r.status,
        reportsTo: r.reportsTo?.empId ?? null,
        duties: r.duties.map((d) => d.duty.key).sort(),
        children: [],
      });
    }
    const roots: OrgNode[] = [];
    for (const node of nodes.values()) {
      const parent = node.reportsTo ? nodes.get(node.reportsTo) : undefined;
      (parent ? parent.children : roots).push(node);
    }
    return roots;
  }

  /** The caller's own record and everyone below them. The scope filter runs in the database. */
  async team(actor: Actor): Promise<TeamMember[]> {
    const rows = await this.prisma.employee.findMany({
      where: this.scope.employeeWhere(actor.id),
      orderBy: { empId: 'asc' },
      select: {
        empId: true,
        fullName: true,
        designation: true,
        level: { select: { number: true } },
        department: { select: { name: true } },
        reportsTo: { select: { empId: true } },
        ancestors: { where: { ancestorId: actor.id }, select: { depth: true } },
      },
    });
    return rows.map((r) => this.toTeamMember(r));
  }

  /** One person in the caller's scope (the guard has already checked the scope). */
  async teamMember(actor: Actor, empId: string): Promise<TeamMember> {
    const row = await this.prisma.employee.findFirst({
      where: { empId, ...this.scope.employeeWhere(actor.id) },
      select: {
        empId: true,
        fullName: true,
        designation: true,
        level: { select: { number: true } },
        department: { select: { name: true } },
        reportsTo: { select: { empId: true } },
        ancestors: { where: { ancestorId: actor.id }, select: { depth: true } },
      },
    });
    if (!row) throw new NotFoundException('Employee not found');
    return this.toTeamMember(row);
  }

  private toTeamMember(r: {
    empId: string;
    fullName: string;
    designation: string;
    level: { number: number };
    department: { name: string };
    reportsTo: { empId: string } | null;
    ancestors: Array<{ depth: number }>;
  }): TeamMember {
    return {
      empId: r.empId,
      name: r.fullName,
      designation: r.designation,
      level: r.level.number,
      department: r.department.name,
      reportsTo: r.reportsTo?.empId ?? null,
      depth: r.ancestors[0]?.depth ?? 0,
    };
  }

  // ---------------------------------------------------------------- changing levels and lines

  /** Owner or CEO changes someone's level (and role). Everything is validated before saving. */
  async changeLevel(actor: Actor, targetEmpId: string, dto: ChangeLevelRequest, client: RequestInfo) {
    return this.prisma.$transaction(async (tx) => {
      await this.hierarchy.lock(tx);
      const target = await this.requirePerson(tx, targetEmpId);

      // Privilege-escalation guard: nobody can hand out a level at or above their own.
      if (dto.level <= actor.levelNumber) {
        await this.denyInTx(actor, client, 'level_not_assignable', targetEmpId, { requestedLevel: String(dto.level) });
        throw new ForbiddenException(`You cannot assign Level ${dto.level}`);
      }

      const role = dto.roleKey
        ? await tx.role.findUnique({ where: { key: dto.roleKey }, select: { id: true, key: true, level: { select: { number: true } } } })
        : await tx.role.findFirst({ where: { isDefault: true, level: { number: dto.level } }, select: { id: true, key: true, level: { select: { number: true } } } });
      if (!role) throw new BadRequestException('Unknown role');
      if (role.level.number !== dto.level) {
        throw new BadRequestException(`Role "${role.key}" belongs to Level ${role.level.number}, not Level ${dto.level}`);
      }
      if (role.id === target.roleId && dto.level === target.level.number) {
        throw new BadRequestException('Nothing to change: the employee already has this level and role');
      }

      // The new level must keep every reporting line valid: the person's own manager, and each direct report.
      const updated: RulePerson = { ...toRulePerson(target), levelNumber: dto.level, roleId: role.id };
      const rules = await tx.sameLevelReportingRule.findMany({ select: { managerRoleId: true, employeeRoleId: true } });
      const problems = [];
      if (target.reportsToId) {
        const manager = await this.requirePersonById(tx, target.reportsToId);
        problems.push(...checkLevelRules(updated, toRulePerson(manager), rules));
      }
      const reports = await tx.employee.findMany({ where: { reportsToId: target.id }, select: personSelect });
      for (const report of reports) {
        problems.push(...checkLevelRules(toRulePerson(report), updated, rules));
      }
      if (problems.length) {
        throw new BadRequestException({ message: 'This level change would break the reporting lines', violations: problems });
      }

      const newLevel = await tx.level.findUniqueOrThrow({ where: { number: dto.level }, select: { id: true } });
      await tx.employee.update({
        where: { id: target.id },
        data: { levelId: newLevel.id, roleId: role.id, updatedBy: actor.id },
      });

      const before = { level: target.level.number, role: target.role.key };
      const after = { level: dto.level, role: role.key };
      await tx.employmentHistory.create({
        data: {
          employeeId: target.id,
          eventType: 'level_changed',
          effectiveOn: new Date(),
          details: { before, after },
          reason: dto.reason,
          createdBy: actor.id,
        },
      });
      await tx.profileChange.createMany({
        data: [
          { employeeId: target.id, section: 'job', field: 'level', oldValue: String(before.level), newValue: String(after.level), reason: dto.reason, changedBy: actor.id },
          { employeeId: target.id, section: 'job', field: 'role', oldValue: before.role, newValue: after.role, reason: dto.reason, changedBy: actor.id },
        ],
      });
      await this.audit.record(
        { actorId: actor.id, action: 'org.level.changed', targetType: 'employee', targetId: target.empId, reason: dto.reason, details: { before, after }, ...client },
        tx,
      );
      return { empId: target.empId, level: dto.level, roleKey: role.key };
    });
  }

  /** Owner or CEO moves someone under a different reporting person. */
  async changeReportingLine(actor: Actor, targetEmpId: string, dto: ChangeReportingLineRequest, client: RequestInfo) {
    return this.prisma.$transaction(async (tx) => {
      await this.hierarchy.lock(tx);
      const target = await this.requirePerson(tx, targetEmpId);
      const manager = await tx.employee.findUnique({ where: { empId: dto.reportsToEmpId }, select: personSelect });
      if (!manager) throw new NotFoundException(`Employee ${dto.reportsToEmpId} not found`);

      // The new manager must be inside the caller's own reporting line (or be the caller).
      if (!(await this.scope.canAccess(actor.id, manager.id))) {
        await this.denyInTx(actor, client, 'out_of_scope', targetEmpId, { newManager: manager.empId });
        throw new ForbiddenException('You do not have access to this');
      }
      if (manager.id === target.reportsToId) {
        throw new BadRequestException('Nothing to change: the employee already reports to this person');
      }

      const downline = new Set(await this.hierarchy.downline(tx, target.id));
      const rules = await tx.sameLevelReportingRule.findMany({ select: { managerRoleId: true, employeeRoleId: true } });
      const problems = checkReportingLine(toRulePerson(target), toRulePerson(manager), rules, downline);
      if (problems.length) {
        throw new BadRequestException({ message: 'This reporting line is not allowed', violations: problems });
      }

      const previous = target.reportsToId ? await this.requirePersonById(tx, target.reportsToId) : null;
      await this.hierarchy.moveUnder(tx, target.id, manager.id);
      await tx.employee.update({ where: { id: target.id }, data: { updatedBy: actor.id } });

      const before = { reportsTo: previous?.empId ?? null };
      const after = { reportsTo: manager.empId };
      await tx.employmentHistory.create({
        data: { employeeId: target.id, eventType: 'reporting_line_changed', effectiveOn: new Date(), details: { before, after }, reason: dto.reason, createdBy: actor.id },
      });
      await tx.profileChange.create({
        data: { employeeId: target.id, section: 'job', field: 'reportsTo', oldValue: before.reportsTo, newValue: after.reportsTo, reason: dto.reason, changedBy: actor.id },
      });
      await this.audit.record(
        { actorId: actor.id, action: 'org.reporting_line.changed', targetType: 'employee', targetId: target.empId, reason: dto.reason, details: { before, after }, ...client },
        tx,
      );
      return { empId: target.empId, reportsTo: manager.empId };
    });
  }

  // ---------------------------------------------------------------- duties

  /** The Director gives someone an extra duty (for example Finance duty). */
  async assignDuty(actor: Actor, targetEmpId: string, dto: AssignDutyRequest, client: RequestInfo) {
    return this.prisma.$transaction(async (tx) => {
      const target = await this.requirePerson(tx, targetEmpId);
      const duty = await tx.duty.findUnique({ where: { key: dto.dutyKey } });
      if (!duty) throw new NotFoundException(`Unknown duty "${dto.dutyKey}"`);
      if (target.status === 'left') throw new BadRequestException('This employee has left the company');
      const existing = await tx.employeeDuty.findFirst({ where: { employeeId: target.id, dutyId: duty.id, endedAt: null } });
      if (existing) throw new ConflictException('The employee already holds this duty');

      await tx.employeeDuty.create({
        data: { employeeId: target.id, dutyId: duty.id, reason: dto.reason, createdBy: actor.id },
      });
      await this.audit.record(
        { actorId: actor.id, action: 'duty.assigned', targetType: 'employee', targetId: target.empId, reason: dto.reason, details: { duty: duty.key }, ...client },
        tx,
      );
      return { empId: target.empId, duty: duty.key };
    });
  }

  async endDuty(actor: Actor, targetEmpId: string, dutyKey: string, dto: EndDutyRequest, client: RequestInfo) {
    return this.prisma.$transaction(async (tx) => {
      const target = await this.requirePerson(tx, targetEmpId);
      const active = await tx.employeeDuty.findFirst({
        where: { employeeId: target.id, endedAt: null, duty: { key: dutyKey } },
      });
      if (!active) throw new NotFoundException('The employee does not hold this duty');
      await tx.employeeDuty.update({ where: { id: active.id }, data: { endedAt: new Date(), updatedBy: actor.id } });
      await this.audit.record(
        { actorId: actor.id, action: 'duty.ended', targetType: 'employee', targetId: target.empId, reason: dto.reason, details: { duty: dutyKey }, ...client },
        tx,
      );
      return { empId: target.empId, duty: dutyKey, ended: true };
    });
  }

  // ---------------------------------------------------------------- helpers

  private async requirePerson(tx: Prisma.TransactionClient, empId: string): Promise<PersonRow> {
    const person = await tx.employee.findUnique({ where: { empId }, select: personSelect });
    if (!person) throw new NotFoundException('Employee not found');
    return person;
  }

  private async requirePersonById(tx: Prisma.TransactionClient, id: string): Promise<PersonRow> {
    return tx.employee.findUniqueOrThrow({ where: { id }, select: personSelect });
  }

  /** Denials found inside a transaction are written outside it, so they survive the rollback. */
  private async denyInTx(actor: Actor, client: RequestInfo, reason: string, targetEmpId: string, details: Record<string, string>) {
    await this.audit.record({
      actorId: actor.id,
      action: 'access.denied',
      targetType: 'employee',
      targetId: targetEmpId,
      outcome: 'denied',
      reason,
      details,
      ...client,
    });
  }
}
