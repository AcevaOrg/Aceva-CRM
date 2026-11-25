import { Injectable } from '@nestjs/common';
import {
  type LogSalesActivityData,
  SALES_ACTIVITY_MOVES_FROM,
  SALES_ACTIVITY_STAGE,
  SALES_DNC_BLOCKED_KINDS,
  SALES_DEAL_STAGES,
  type SalesActivityResult,
  type SalesActivitySource,
  type SalesActivityView,
  type SalesDealStage,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { Clock } from '../common/clock';
import { noteActivity } from '../common/request-context';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { type SalesAccess, SalesAccessService } from './sales-access.service';
import { badRequest, conflict, forbidden, notFound } from './sales-errors';
import { person } from './sales-views';

type Tx = Prisma.TransactionClient;

/** How long ahead of the server's clock an activity's time may be (a phone's clock running a little fast). */
const FUTURE_SLACK_MS = 5 * 60_000;

const activityInclude = { actor: { select: { empId: true, fullName: true } }, deal: { select: { number: true } } } satisfies Prisma.SalesActivityInclude;
type ActivityRow = Prisma.SalesActivityGetPayload<{ include: typeof activityInclude }>;

const LABEL: Record<string, string> = {
  call: 'a call',
  email_sent: 'an email sent',
  reply: 'a reply',
  meeting: 'a meeting',
  linkedin: 'a LinkedIn message',
  whatsapp: 'a WhatsApp message',
  fiverr: 'a Fiverr inquiry',
  proposal: 'a proposal',
  note: 'a note',
  follow_up: 'a follow-up',
};

export function activityView(r: ActivityRow): SalesActivityView {
  return {
    id: r.id,
    leadId: r.leadId,
    dealId: r.dealId,
    dealNumber: r.deal?.number ?? null,
    kind: r.kind,
    source: r.source as SalesActivitySource,
    at: r.occurredAt.toISOString(),
    summary: r.summary,
    meetingAt: r.meetingAt?.toISOString() ?? null,
    proposalUrl: r.proposalUrl,
    actor: r.actor ? person(r.actor) : null,
    externalId: r.externalId,
    createdAt: r.createdAt.toISOString(),
  };
}

/** The stage a logged activity moves an open deal to (plan section 20, "The deal moves here when"), or null. */
export function stageFor(dto: Pick<LogSalesActivityData, 'kind' | 'meetingAt' | 'proposalUrl'>): SalesDealStage | null {
  if (dto.kind === 'meeting') return dto.meetingAt ? 'meeting_booked' : null;
  if (dto.kind === 'proposal') return dto.proposalUrl ? 'proposal_sent' : null;
  return SALES_ACTIVITY_STAGE[dto.kind] ?? null;
}
const order = (s: SalesDealStage) => SALES_DEAL_STAGES.indexOf(s);

/**
 * Module 15.3 activity timeline (plan section 20): every contact on a lead (and a deal), in time order, with who did it,
 * when and where it came from (typed in by hand here; Module 16 adds tool entries later). Insert-only.
 *
 * Who logs: the lead's owner, or the sales manager for their team. Who reads: whoever sees the lead (or the deal) in full;
 * someone who only sees "it exists, owned by" gets nothing from the timeline.
 *
 * A logged contact moves the deal FORWARD (never backwards; never a Won or Lost deal or one waiting for its Won
 * confirmation): a call, an email, a LinkedIn, WhatsApp or Fiverr message to Contacted, a reply to Replied, a meeting with
 * its date to Meeting booked, a linked proposal to Proposal sent. The deal row is locked first, so a stage change made at
 * the same moment is never overwritten: whatever happened first wins, and the activity is kept either way (the answer
 * says why the stage did not move).
 * Module 4 records the request itself (module Sales, action create) by its interceptor, only when it succeeded, so the two
 * records never disagree. The tool actions of Module 4 (email_sent, reply, call ...) are left to Module 16.
 */
@Injectable()
export class ActivitiesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: SalesAccessService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  // ------------------------------------------------------------------------------------------------------------ reads

  /** GET /sales/leads/:id/activities: the lead's whole timeline (its deals' entries too), newest first. */
  async forLead(actor: Actor, leadId: string): Promise<SalesActivityView[]> {
    const a = await this.access.of(actor);
    const lead = await this.prisma.salesLead.findUnique({ where: { id: leadId }, select: { ownerId: true } });
    if (!lead) notFound('Lead not found');
    if (!(await this.access.seesFull(a, lead.ownerId))) forbidden('not_allowed', "This lead belongs to someone else: its timeline is not shown");
    const rows = await this.prisma.salesActivity.findMany({ where: { leadId }, include: activityInclude, orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }] });
    return rows.map(activityView);
  }

  /**
   * GET /sales/deals/:id/activities: the deal's entries and the lead's entries that are about no deal, newest first. The
   * lead's general entries only for who sees the lead in full: a Won or Lost deal keeps its owner when the lead moves to
   * another salesperson, and the former owner does not see what the new owner logs on the lead.
   */
  async forDeal(actor: Actor, dealId: string): Promise<SalesActivityView[]> {
    const a = await this.access.of(actor);
    const deal = await this.prisma.salesDeal.findUnique({ where: { id: dealId }, select: { ownerId: true, leadId: true, archivedAt: true, lead: { select: { ownerId: true } } } });
    if (!deal || deal.archivedAt) notFound('Deal not found');
    if (!(await this.access.seesFull(a, deal.ownerId))) forbidden('not_allowed', 'This deal belongs to someone else: its timeline is not shown');
    const seesLead = deal.lead.ownerId === deal.ownerId || (await this.access.seesFull(a, deal.lead.ownerId));
    const rows = await this.prisma.salesActivity.findMany({
      where: { OR: [{ dealId }, ...(seesLead ? [{ leadId: deal.leadId, dealId: null }] : [])] },
      include: activityInclude,
      orderBy: [{ occurredAt: 'desc' }, { createdAt: 'desc' }],
    });
    return rows.map(activityView);
  }

  // ----------------------------------------------------------------------------------------------------------- writes

  /** POST /sales/leads/:id/activities (dealId null) and POST /sales/deals/:id/activities. */
  async log(actor: Actor, target: { leadId?: string; dealId?: string }, dto: LogSalesActivityData, client: RequestInfo): Promise<SalesActivityResult> {
    const a = await this.access.of(actor);
    const deal = target.dealId ? await this.prisma.salesDeal.findUnique({ where: { id: target.dealId }, select: { id: true, number: true, leadId: true, archivedAt: true } }) : null;
    if (target.dealId && (!deal || deal.archivedAt)) notFound('Deal not found');
    const leadId = deal?.leadId ?? target.leadId!;
    const lead = await this.prisma.salesLead.findUnique({ where: { id: leadId }, select: { id: true, fullName: true, ownerId: true, archivedAt: true, dncAt: true } });
    if (!lead) notFound('Lead not found');
    await this.requireWorker(a, lead.ownerId);
    if (lead.archivedAt) conflict('lead_archived', 'This lead is archived');
    const outgoing = (SALES_DNC_BLOCKED_KINDS as readonly string[]).includes(dto.kind);
    if (outgoing && lead.dncAt) refuseDnc();

    const now = this.clock.now();
    const at = dto.at ? new Date(dto.at) : now;
    if (at.getTime() > now.getTime() + FUTURE_SLACK_MS) badRequest('activity_in_future', 'An activity cannot be in the future');
    const target_stage = deal ? stageFor(dto) : null;

    const result = await this.prisma.$transaction(async (tx) => {
      // M15.4: outgoing contact waits for (or sees) a do-not-contact request saved on the lead at the same moment.
      if (outgoing) {
        const dnc = await tx.$queryRaw<Array<{ dnc_at: Date | null }>>`SELECT dnc_at FROM sales_leads WHERE id = ${leadId}::uuid FOR SHARE`;
        if (dnc[0]?.dnc_at) refuseDnc();
      }
      // Lock the deal first: a stage change made at the same moment waits for us (or we see its result).
      const locked = deal ? await this.lockDeal(tx, deal.id) : null;
      const row = await tx.salesActivity.create({
        data: {
          leadId,
          dealId: deal?.id ?? null,
          actorId: actor.id,
          kind: dto.kind,
          source: 'manual',
          occurredAt: at,
          summary: dto.summary,
          meetingAt: dto.meetingAt ? new Date(dto.meetingAt) : null,
          proposalUrl: dto.proposalUrl ?? null,
        },
        include: activityInclude,
      });
      await this.touchLead(tx, leadId, dto.kind, at);
      const moved = locked ? await this.moveForward(tx, actor, locked, target_stage, dto.kind, dto.proposalUrl ?? null, client) : { stageChange: null, stageNotChanged: null };
      return { activity: activityView(row), ...moved };
    });
    noteActivity({ target: deal?.number ?? lead.fullName, description: `Logged ${LABEL[dto.kind]} on ${deal?.number ?? `the lead ${lead.fullName}`}` });
    return result;
  }

  // ---------------------------------------------------------------------------------------------------------- helpers

  /** The lead's owner or the sales manager for their team logs contacts; the CEO / Owner only reads. */
  async requireWorker(a: SalesAccess, ownerId: string): Promise<void> {
    if (!(await this.access.canEdit(a, ownerId))) forbidden('not_allowed', 'Only the owner of the lead or the sales manager logs its activities');
  }

  /**
   * "When the lead was last contacted" moves forward with every logged contact (a note is not a contact). It never moves
   * back: an activity logged late for an older day keeps the newer date. What counts for the 12-month archive is M15.5.
   */
  async touchLead(tx: Tx, leadId: string, kind: string, at: Date): Promise<void> {
    if (kind === 'note') return;
    await tx.salesLead.updateMany({ where: { id: leadId, lastActivityAt: { lt: at } }, data: { lastActivityAt: at } });
  }

  private async lockDeal(tx: Tx, id: string) {
    const rows = await tx.$queryRaw<Array<{ id: string; number: string; stage: SalesDealStage; won_status: string; version: number }>>`
      SELECT id, number, stage::text AS stage, won_status::text AS won_status, version FROM sales_deals WHERE id = ${id}::uuid FOR UPDATE`;
    return rows[0] ?? null;
  }

  /** The forward-only move a logged activity brings, on the locked deal. */
  private async moveForward(
    tx: Tx,
    actor: Actor,
    deal: { id: string; number: string; stage: SalesDealStage; won_status: string; version: number },
    to: SalesDealStage | null,
    kind: LogSalesActivityData['kind'],
    proposalUrl: string | null,
    client: RequestInfo,
  ): Promise<Pick<SalesActivityResult, 'stageChange' | 'stageNotChanged'>> {
    if (!to) return { stageChange: null, stageNotChanged: null };
    if (deal.stage === 'won' || deal.stage === 'lost') return { stageChange: null, stageNotChanged: 'deal_closed' };
    if (deal.won_status === 'pending') return { stageChange: null, stageNotChanged: 'won_pending' };
    const forward = order(to) > order(deal.stage);
    // A reply moves Contacted to Replied only: on a New deal it is kept, and the stage waits for the first contact.
    const from = SALES_ACTIVITY_MOVES_FROM[kind];
    if (forward && from && !from.includes(deal.stage)) return { stageChange: null, stageNotChanged: 'needs_contacted' };
    const data: Prisma.SalesDealUncheckedUpdateManyInput = { version: { increment: 1 }, updatedBy: actor.id };
    if (proposalUrl) data.proposalUrl = proposalUrl;
    if (forward) data.stage = to;
    if (!forward && !proposalUrl) return { stageChange: null, stageNotChanged: 'not_forward' };
    const { count } = await tx.salesDeal.updateMany({ where: { id: deal.id, version: deal.version, wonStatus: 'none' }, data });
    if (!count) throw new Error('A locked deal changed under its lock');
    if (!forward) return { stageChange: null, stageNotChanged: 'not_forward' };
    await tx.salesDealHistory.create({ data: { dealId: deal.id, event: 'stage_changed', fromStage: deal.stage, toStage: to, actorId: actor.id, note: 'Moved by a logged activity' } });
    await this.audit.record({ actorId: actor.id, action: 'sales.deal.moved', targetType: 'sales_deal', targetId: deal.number, details: { from: deal.stage, to, by: 'activity' }, ...client }, tx);
    return { stageChange: { from: deal.stage, to }, stageNotChanged: null };
  }
}

/** M15.4 (approved decision 1): no outgoing contact on a do-not-contact lead; replies and notes are still logged. */
function refuseDnc(): never {
  conflict('do_not_contact', 'This lead asked not to be contacted. Outgoing contact cannot be logged; a reply or a note can');
}
