import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateStandInRequest, RevokeStandInRequest, StandInView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { PermissionService } from '../access/permission.service';
import { ScopeService } from '../access/scope.service';
import { PrismaService } from '../prisma/prisma.service';

const isoDay = (d: Date): string => d.toISOString().slice(0, 10);
const toDate = (iso: string): Date => new Date(`${iso}T00:00:00.000Z`);

type Row = {
  id: string;
  startsOn: Date;
  endsOn: Date;
  reason: string | null;
  revokedAt: Date | null;
  manager: { empId: string };
  standIn: { empId: string } | null;
};

const view = (r: Row): StandInView => ({
  id: r.id,
  manager: r.manager.empId,
  standIn: r.standIn?.empId ?? null,
  startsOn: isoDay(r.startsOn),
  endsOn: isoDay(r.endsOn),
  reason: r.reason,
  revokedAt: r.revokedAt?.toISOString() ?? null,
});

const select = {
  id: true,
  startsOn: true,
  endsOn: true,
  reason: true,
  revokedAt: true,
  manager: { select: { empId: true } },
  standIn: { select: { empId: true } },
} as const;

@Injectable()
export class StandInsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly scope: ScopeService,
    private readonly audit: AuditService,
  ) {}

  /**
   * A manager names a stand-in (or nobody) for a set of dates. The stand-in must be authorized:
   * an active employee who may approve, at the manager's level or higher, and not the manager.
   */
  async create(actor: Actor, dto: CreateStandInRequest, client: RequestInfo): Promise<StandInView> {
    if (dto.endsOn < isoDay(new Date())) {
      throw new BadRequestException('The away period has already ended');
    }

    return this.prisma.$transaction(async (tx) => {
      let standInId: string | null = null;
      if (dto.standInEmpId) {
        const standIn = await tx.employee.findUnique({
          where: { empId: dto.standInEmpId },
          select: { id: true, empId: true, status: true, level: { select: { number: true } } },
        });
        if (!standIn) throw new NotFoundException(`Employee ${dto.standInEmpId} not found`);
        if (standIn.id === actor.id) throw new BadRequestException('You cannot be your own stand-in');
        if (standIn.status === 'left') throw new BadRequestException('The stand-in has left the company');
        if (standIn.level.number > actor.levelNumber) {
          throw new BadRequestException('A stand-in must be at your level or above');
        }
        if (!(await this.permissions.canApprove(standIn.id, tx))) {
          throw new BadRequestException(`${standIn.empId} is not authorized to approve, so cannot be a stand-in`);
        }
        standInId = standIn.id;
      }

      // Serialise per manager so two overlapping periods cannot be saved at the same moment.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'stand-in:' + actor.id}))`;
      const overlap = await tx.standIn.findFirst({
        where: { managerId: actor.id, revokedAt: null, startsOn: { lte: toDate(dto.endsOn) }, endsOn: { gte: toDate(dto.startsOn) } },
      });
      if (overlap) throw new ConflictException('You already have an away period that overlaps these dates');

      const created = await tx.standIn.create({
        data: {
          managerId: actor.id,
          standInId,
          startsOn: toDate(dto.startsOn),
          endsOn: toDate(dto.endsOn),
          reason: dto.reason ?? null,
          createdBy: actor.id,
        },
        select,
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: 'standin.created',
          targetType: 'stand_in',
          targetId: created.id,
          reason: dto.reason ?? null,
          details: { standIn: created.standIn?.empId ?? null, startsOn: dto.startsOn, endsOn: dto.endsOn },
          ...client,
        },
        tx,
      );
      return view(created);
    });
  }

  /** Away periods of people in my scope, plus the ones where I am the stand-in. */
  async list(actor: Actor): Promise<StandInView[]> {
    const rows = await this.prisma.standIn.findMany({
      where: { OR: [{ manager: this.scope.employeeWhere(actor.id) }, { standInId: actor.id }] },
      orderBy: [{ startsOn: 'desc' }],
      select,
    });
    return rows.map(view);
  }

  /** The manager can end their own period early; Owner or CEO can end the period of anyone below them. */
  async revoke(actor: Actor, id: string, dto: RevokeStandInRequest, client: RequestInfo): Promise<StandInView> {
    return this.prisma.$transaction(async (tx) => {
      const period = await tx.standIn.findUnique({ where: { id }, select: { ...select, managerId: true } });
      if (!period) throw new NotFoundException('Away period not found');

      const isOwnPeriod = period.managerId === actor.id;
      const canManageOthers =
        (await this.permissions.can(actor.id, 'org.manage', tx)) && (await this.scope.canAccess(actor.id, period.managerId, 'below'));
      if (!isOwnPeriod && !canManageOthers) {
        await this.audit.record({
          actorId: actor.id,
          action: 'access.denied',
          targetType: 'stand_in',
          targetId: id,
          outcome: 'denied',
          reason: 'out_of_scope',
          ...client,
        });
        throw new ForbiddenException('You do not have access to this');
      }
      if (period.revokedAt) throw new ConflictException('This away period was already ended');

      const updated = await tx.standIn.update({
        where: { id },
        data: { revokedAt: new Date(), updatedBy: actor.id },
        select,
      });
      await this.audit.record(
        { actorId: actor.id, action: 'standin.revoked', targetType: 'stand_in', targetId: id, reason: dto.reason, ...client },
        tx,
      );
      return view(updated);
    });
  }
}
