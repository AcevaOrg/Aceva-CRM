import { Injectable } from '@nestjs/common';
import type { DecideSalesWonExceptionRequest, SalesDealDetailView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import type { RequestInfo } from '../access/decorators';
import { ScopeService } from '../access/scope.service';
import { StepUpService } from '../auth/step-up.service';
import { noteActivity } from '../common/request-context';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DealsService } from './deals.service';
import { SalesAccessService } from './sales-access.service';
import { conflict, forbidden } from './sales-errors';
import { checkWonException, SELF, WON_EXCEPTION_BASIS } from './won-exception-rules';

/**
 * POST /sales/deals/:id/won-exception (approved M15.5 follow-up): the holder of sales.won_decide_exception (the Owner role
 * only) confirms or sends back a pending Won request that is stranded because the person who asked has left and nobody
 * else can decide it. A reason (5 to 500 characters) and step-up re-authentication (as for the Owner's payroll approval,
 * D26) are required. In ONE transaction under the deal's row lock, every condition is checked again, the insert-only
 * record (sales_won_exceptions: decision, reason, the original requester, request time, owner at the request, current
 * owner, what was checked) is written, and then exactly the normal confirmation (Won, history, audit, the
 * sales.deal.won_confirmed event for Module 13) or the normal sending back runs. The database lets a Level 1 confirmer
 * confirm such a deal only with that record written in the same transaction. The usual confirm-won, reject-won and B1
 * routes are unchanged; nothing is decided automatically.
 */
@Injectable()
export class WonExceptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: SalesAccessService,
    private readonly deals: DealsService,
    private readonly scope: ScopeService,
    private readonly stepUp: StepUpService,
  ) {}

  async decide(actor: Actor, idOrNumber: string, dto: DecideSalesWonExceptionRequest, sessionId: string | null, client: RequestInfo): Promise<SalesDealDetailView> {
    const a = await this.access.of(actor);
    if (!a.decideWonException) forbidden('not_allowed', 'Only the CEO / Owner makes the exceptional Won decision');
    const row = await this.deals.find(idOrNumber);
    if (row.ownerId === actor.id || row.wonRequestedById === actor.id) forbidden('self_approval', 'Nobody decides their own deal or their own request');
    await this.stepUp.require(actor, sessionId, 'sales_won_exception', { type: 'sales_deal', id: row.number }, client);

    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM sales_deals WHERE id = ${row.id}::uuid FOR UPDATE`;
      const fresh = await this.deals.find(row.id, tx);
      if (fresh.version !== dto.version) conflict('stale_version', 'This deal was changed by someone else. Reload it');
      const check = await checkWonException(tx, this.scope, fresh, actor.id);
      if (check.why === SELF) forbidden('self_approval', 'Nobody decides their own deal or their own request');
      if (!check.ok) conflict('exception_not_applicable', `The exceptional decision does not apply: ${check.why}`);
      await tx.salesWonException.create({
        data: {
          dealId: fresh.id,
          decision: dto.decision,
          reason: dto.reason,
          basis: WON_EXCEPTION_BASIS,
          decidedById: actor.id,
          requesterId: check.requester!.id,
          requestedAt: fresh.wonRequestedAt!,
          ownerAtRequestId: check.ownerAtRequest!.id,
          currentOwnerId: fresh.ownerId,
          details: { moves: check.moves, confirmersChecked: check.confirmersChecked, ownerAtRequest: check.ownerAtRequest!.empId, requester: check.requester!.empId, version: dto.version } as Prisma.InputJsonValue,
        },
      });
      const note = `Exceptional decision: ${check.requester!.empId} (who asked) has left and no sales manager could decide`;
      if (dto.decision === 'confirm') await this.deals.applyConfirm(tx, fresh, actor, dto.version, client, { reason: dto.reason, note });
      else await this.deals.applyReject(tx, fresh, actor, dto.reason, dto.version, client, { note });
    });
    noteActivity({ target: row.number, description: dto.decision === 'confirm' ? `Confirmed the deal ${row.number} as Won (exceptional decision)` : `Sent back the Won request of ${row.number} (exceptional decision)` });
    return this.deals.detail(a, row.id);
  }
}
