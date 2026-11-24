import { Injectable, NotFoundException, type OnModuleInit } from '@nestjs/common';
import { type ApprovalItemView, type ApprovalTypeName, type DecideApprovalRequest, SALES_DEAL_SERVICE_LABEL } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import type { RequestInfo } from '../access/decorators';
import { ScopeService } from '../access/scope.service';
import { type ApprovalProvider, ApprovalsInbox } from '../approvals/approvals-inbox.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '../generated/prisma/client';
import { DealsService, DIRECTOR_LEVEL } from './deals.service';
import { SalesAccessService } from './sales-access.service';
import { badRequest } from './sales-errors';

/**
 * Module 15's items in the approvals inbox: Won requests ("won_deal") wait for the sales manager of the deal's owner
 * (the Director until there is one), never for the owner or the person who asked. A deal the Director owns waits for the
 * CEO / Founder / Owner instead (decision B1). The decision itself is the same as
 * on the deal page (DealsService.confirmWon / rejectWon), which checks every rule again.
 */
@Injectable()
export class SalesApprovalsProvider implements ApprovalProvider, OnModuleInit {
  readonly key = 'sales';
  readonly types: readonly ApprovalTypeName[] = ['won_deal'];

  constructor(
    private readonly inbox: ApprovalsInbox,
    private readonly prisma: PrismaService,
    private readonly access: SalesAccessService,
    private readonly scope: ScopeService,
    private readonly deals: DealsService,
  ) {}

  onModuleInit(): void {
    this.inbox.register(this);
  }

  async list(actor: Actor): Promise<ApprovalItemView[]> {
    const a = await this.access.of(actor);
    // The sales manager: their reporting line. The CEO / Founder / Owner (decision B1): deals the Director owns, only.
    const whose: Prisma.EmployeeWhereInput | null = a.manage ? this.scope.employeeWhere(actor.id) : a.confirmDirectorDeals ? { level: { number: DIRECTOR_LEVEL } } : null;
    if (!whose) return [];
    const rows = await this.prisma.salesDeal.findMany({
      where: {
        wonStatus: 'pending',
        archivedAt: null,
        owner: whose,
        ownerId: { not: actor.id },
        NOT: { wonRequestedById: actor.id },
      },
      include: { company: { select: { name: true } }, owner: { select: { empId: true, fullName: true } }, wonRequestedBy: { select: { empId: true, fullName: true } } },
      orderBy: { wonRequestedAt: 'asc' },
    });
    return rows.map((d) => ({
      id: `won_deal:${d.id}`,
      type: 'won_deal',
      refId: d.id,
      refNumber: d.number,
      title: `Won: ${d.company.name}`,
      subtitle: `${SALES_DEAL_SERVICE_LABEL[d.service]} · ${d.currency} ${d.value.toFixed(2)} · owner ${d.owner.fullName}`,
      requester: d.wonRequestedBy?.empId ?? d.owner.empId,
      createdAt: (d.wonRequestedAt ?? d.updatedAt).toISOString(),
      href: `/sales/deals/${d.id}`,
      approveLabel: 'Confirm Won',
      rejectLabel: 'Send back',
    }));
  }

  /** Won requests the actor made that wait for someone else. */
  routedUp(actor: Actor): Promise<number> {
    return this.prisma.salesDeal.count({ where: { wonStatus: 'pending', wonRequestedById: actor.id, archivedAt: null } });
  }

  async decide(actor: Actor, item: { type: ApprovalTypeName; refId: string }, decision: 'approve' | 'reject', input: DecideApprovalRequest, client: RequestInfo): Promise<void> {
    if (item.type !== 'won_deal') throw new NotFoundException({ statusCode: 404, code: 'not_found', message: 'Approval item not found' });
    // The inbox decides the request as it is now: the version is read here, and the deal service checks every rule again.
    const { version } = await this.deals.find(item.refId);
    if (decision === 'approve') {
      await this.deals.confirmWon(actor, item.refId, version, client);
      return;
    }
    if (!input.reason || input.reason.trim().length < 5) badRequest('reason_required', 'Please give a reason (at least 5 characters)');
    await this.deals.rejectWon(actor, item.refId, { reason: input.reason.trim(), version }, client);
  }
}
