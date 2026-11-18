import { Injectable } from '@nestjs/common';
import type { CreateTaxSlabSetRequest, TaxSlabSetView, TaxSlabsResponse } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { PermissionService } from '../access/permission.service';
import { Clock } from '../common/clock';
import { dec, money } from '../common/money';
import { dayOf, dbDate, lastDayOfMonth, pkDate } from '../common/pakistan-time';
import { PrismaService } from '../prisma/prisma.service';
import { badRequest, forbidden, peopleByIds, type Db } from './payroll-common';
import { slabsProblem, type TaxSlabRow } from './payroll-calc';

const setInclude = { slabs: { orderBy: { fromAmount: 'asc' as const } } };

export interface SlabSetInForce {
  id: string;
  label: string;
  slabs: TaxSlabRow[];
}

/**
 * Yearly income tax slabs (plan section 12: "using the tax slabs saved in settings; the accountant updates the slabs").
 * Every change is a NEW version with the day it takes effect; old versions are kept so each run shows the version it used.
 * No slabs are seeded: until someone enters them, payroll refuses to calculate (409 tax_slabs_missing).
 */
@Injectable()
export class TaxSlabsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  async list(actor: Actor): Promise<TaxSlabsResponse> {
    const access = await this.permissions.getEffectiveAccess(actor.id);
    if (!access.permissions.has('payroll.view') && !access.permissions.has('settings.view')) {
      forbidden('forbidden', 'You do not have access to this');
    }
    const sets = await this.prisma.taxSlabSet.findMany({ orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }], include: setInclude });
    const people = await peopleByIds(this.prisma, sets.map((s) => s.createdBy));
    const versions = sets.map((s): TaxSlabSetView => ({
      id: s.id,
      label: s.label,
      effectiveFrom: dayOf(s.effectiveFrom),
      createdAt: s.createdAt.toISOString(),
      createdBy: s.createdBy ? (people.get(s.createdBy)?.empId ?? null) : null,
      slabs: s.slabs.map((x) => ({ from: money(x.fromAmount), to: x.toAmount === null ? null : money(x.toAmount), fixed: money(x.fixedAmount), rate: dec(x.rate).toFixed(4) })),
    }));
    const today = pkDate(this.clock.now());
    return { current: versions.find((v) => v.effectiveFrom <= today) ?? null, versions };
  }

  async create(actor: Actor, dto: CreateTaxSlabSetRequest, client: RequestInfo): Promise<TaxSlabsResponse> {
    const rows: TaxSlabRow[] = dto.slabs.map((s) => ({ from: s.from, to: s.to, fixed: s.fixed, rate: s.rate }));
    const problem = slabsProblem(rows);
    if (problem) badRequest('invalid_slabs', problem);
    const created = await this.prisma.$transaction(async (tx) => {
      const set = await tx.taxSlabSet.create({ data: { effectiveFrom: dbDate(dto.effectiveFrom), label: dto.label, createdBy: actor.id } });
      await tx.taxSlab.createMany({
        data: dto.slabs.map((s) => ({ setId: set.id, fromAmount: s.from, toAmount: s.to, fixedAmount: s.fixed, rate: s.rate })),
      });
      await this.audit.record(
        { actorId: actor.id, action: 'payroll.tax_slabs.created', targetType: 'tax_slab_set', targetId: set.id, details: { label: dto.label, effectiveFrom: dto.effectiveFrom, slabCount: dto.slabs.length }, ...client },
        tx,
      );
      return set;
    });
    void created;
    return this.list(actor);
  }

  /**
   * The version in force for a month: the latest one taking effect on or before the month's last day (a version entered
   * again for the same day replaces the earlier one). Null when none exists.
   */
  async inForce(month: string, db: Db = this.prisma): Promise<SlabSetInForce | null> {
    const set = await db.taxSlabSet.findFirst({
      where: { effectiveFrom: { lte: dbDate(lastDayOfMonth(month)) } },
      orderBy: [{ effectiveFrom: 'desc' }, { createdAt: 'desc' }],
      include: setInclude,
    });
    if (!set || !set.slabs.length) return null;
    return { id: set.id, label: set.label, slabs: set.slabs.map((s) => ({ from: s.fromAmount, to: s.toAmount, fixed: s.fixedAmount, rate: s.rate })) };
  }
}
