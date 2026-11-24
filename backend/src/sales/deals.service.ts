import { Injectable } from '@nestjs/common';
import {
  type CreateSalesDealData,
  isOpenDealStage,
  type MoveSalesDealData,
  type Page,
  type RejectSalesWonRequest,
  SALES_DEAL_SERVICE_LABEL,
  SALES_DEAL_STAGES,
  SALES_OPEN_STAGES,
  SALES_SETTINGS,
  type SalesDealDetailView,
  type SalesDealHistoryView,
  type SalesDealListQuery,
  type SalesDealResult,
  type SalesDealStage,
  type SalesDealView,
  type SalesPipelineSummaryView,
  type SalesSettings,
  type UpdateSalesDealData,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { Clock } from '../common/clock';
import { dbDate, dayOf, pkDate } from '../common/pakistan-time';
import { noteActivity } from '../common/request-context';
import { OutboxService } from '../events/outbox.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ModuleSettingsService } from '../settings/module-settings.service';
import { type SalesAccess, SalesAccessService } from './sales-access.service';
import { badRequest, conflict, forbidden, notFound } from './sales-errors';
import { person } from './sales-views';

type Tx = Prisma.TransactionClient;

const personSelect = { select: { id: true, empId: true, fullName: true } } as const;
/** The Director is Level 2 (the level decides who confirms a deal they own, decision B1, as in decision D26). */
export const DIRECTOR_LEVEL = 2;
export const dealInclude = {
  lead: { select: { id: true, fullName: true, email: true, country: true, archivedAt: true } },
  company: { select: { id: true, name: true, partyId: true, country: true } },
  owner: { select: { id: true, empId: true, fullName: true, level: { select: { number: true } } } },
  wonRequestedBy: personSelect,
  wonConfirmedBy: personSelect,
} satisfies Prisma.SalesDealInclude;
export type DealRow = Prisma.SalesDealGetPayload<{ include: typeof dealInclude }>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLOSED: SalesDealStage[] = ['won', 'lost'];

/** The same calendar day `n` months later (the last day of a shorter month). */
export function addMonths(day: string, n: number): string {
  const [y, m, d] = day.split('-').map(Number);
  const target = new Date(Date.UTC(y, m - 1 + n, 1));
  const last = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, last));
  return target.toISOString().slice(0, 10);
}

/**
 * Module 15.2 deals and the pipeline (plan section 20).
 *
 *  - A deal belongs to one lead and that lead's company; its owner is the lead's owner. Only the owner or the sales manager
 *    (for their team) adds or changes it; others see that it exists and who owns it.
 *  - Eight stages. A deal moves between the open stages freely (plan section 20 does not order the moves); Won and Lost
 *    are final. Every open deal has a next step with a date.
 *  - Lost needs a reason from the list management keeps in Settings, and gets the date after which the lead may be
 *    contacted again (the number of months is also a setting). Until both are set, nothing can be marked Lost.
 *  - Won: the salesperson (or the sales manager) asks; the sales manager confirms or sends it back. Nobody confirms a deal
 *    they own or a request they made (also a database CHECK). A deal the Director owns is confirmed by the CEO / Founder /
 *    Owner, who confirms nothing else (decision B1; also a database trigger). Confirming sends sales.deal.won_confirmed in the same
 *    transaction: Module 13 makes exactly one draft invoice from it. Module 15 never writes invoices or ledger entries.
 *  - Every change names the version it read (stale_version), and every stage change and Won decision is kept in the
 *    insert-only deal history.
 */
@Injectable()
export class DealsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: SalesAccessService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly settings: ModuleSettingsService,
    private readonly clock: Clock,
  ) {}

  private today(): string {
    return pkDate(this.clock.now());
  }

  // ------------------------------------------------------------------------------------------------------------ reads

  /** GET /sales/deals: deals the caller may see in full, newest first. */
  async list(actor: Actor, q: SalesDealListQuery): Promise<Page<SalesDealView>> {
    const a = await this.access.of(actor);
    const filters: Prisma.SalesDealWhereInput[] = [this.dealWhere(a), { archivedAt: null }];
    if (q.owner) filters.push({ owner: { empId: q.owner } });
    if (q.stage) filters.push({ stage: q.stage });
    if (q.leadId) filters.push({ leadId: q.leadId });
    if (q.wonStatus) filters.push({ wonStatus: q.wonStatus });
    if (q.status === 'open') filters.push({ stage: { in: [...SALES_OPEN_STAGES] } });
    if (q.status === 'closed') filters.push({ stage: { in: CLOSED } });
    const where: Prisma.SalesDealWhereInput = { AND: filters };
    const [total, rows] = await Promise.all([
      this.prisma.salesDeal.count({ where }),
      this.prisma.salesDeal.findMany({ where, include: dealInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { items: await this.views(a, rows), total, page: q.page, pageSize: q.pageSize };
  }

  /** GET /sales/deals/:id (id or DL- number): in full with its history, or only that it exists and who owns it. */
  async get(actor: Actor, idOrNumber: string): Promise<SalesDealResult> {
    const a = await this.access.of(actor);
    const row = await this.find(idOrNumber);
    if (!(await this.access.seesFull(a, row.ownerId))) {
      return { restricted: true, id: row.id, number: row.number, companyName: row.company.name, owner: person(row.owner) };
    }
    return this.detail(a, row.id);
  }

  /** GET /sales/deals/summary: per stage, the count and the totals per currency (no conversion) of the deals the caller sees. */
  async summary(actor: Actor): Promise<SalesPipelineSummaryView> {
    const a = await this.access.of(actor);
    const where: Prisma.SalesDealWhereInput = { AND: [this.dealWhere(a), { archivedAt: null }] };
    const [groups, pendingWonCount] = await Promise.all([
      this.prisma.salesDeal.groupBy({ by: ['stage', 'currency'], where, _count: { _all: true }, _sum: { value: true } }),
      this.prisma.salesDeal.count({ where: { AND: [where, { wonStatus: 'pending' }] } }),
    ]);
    const stages = SALES_DEAL_STAGES.map((stage) => {
      const mine = groups.filter((g) => g.stage === stage);
      return {
        stage,
        count: mine.reduce((n, g) => n + g._count._all, 0),
        totals: mine.map((g) => ({ currency: g.currency, value: (g._sum.value ?? new Prisma.Decimal(0)).toFixed(2) })).sort((x, y) => x.currency.localeCompare(y.currency)),
      };
    });
    return { stages, pendingWonCount };
  }

  // ----------------------------------------------------------------------------------------------------------- writes

  /** POST /sales/deals: a deal for a lead the caller works on (the owner, or the sales manager for their team). */
  async create(actor: Actor, dto: CreateSalesDealData, client: RequestInfo): Promise<SalesDealDetailView> {
    const a = await this.access.of(actor);
    const lead = await this.prisma.salesLead.findUnique({ where: { id: dto.leadId }, select: { id: true, fullName: true, ownerId: true, companyId: true, archivedAt: true } });
    if (!lead) notFound('Lead not found');
    if (!(await this.access.canEdit(a, lead.ownerId))) forbidden('not_allowed', 'Only the owner of the lead or the sales manager adds a deal for it');
    if (lead.archivedAt) conflict('lead_archived', 'This lead is archived');
    if (!lead.companyId) badRequest('lead_needs_company', 'A deal is an opportunity with a company: add the company to the lead first');
    this.requireNextStepDate(dto.nextStepDate);
    const today = this.today();
    const waiting = await this.prisma.salesDeal.findFirst({ where: { leadId: lead.id, stage: 'lost', recontactAfter: { gt: dbDate(today) } }, orderBy: { recontactAfter: 'desc' }, select: { number: true, recontactAfter: true } });
    if (waiting) {
      const after = dayOf(waiting.recontactAfter!);
      conflict('recontact_later', `Deal ${waiting.number} was lost: this lead may be contacted again from ${after}`, { recontactAfter: after });
    }
    const id = await this.prisma.$transaction(async (tx) => {
      const deal = await tx.salesDeal.create({
        data: {
          leadId: lead.id,
          companyId: lead.companyId!,
          ownerId: lead.ownerId,
          service: dto.service,
          value: dto.value,
          currency: dto.currency,
          expectedClose: dbDate(dto.expectedClose),
          nextStep: dto.nextStep,
          nextStepDate: dbDate(dto.nextStepDate),
          createdBy: actor.id,
          updatedBy: actor.id,
        },
        select: { id: true, number: true },
      });
      await tx.salesDealHistory.create({ data: { dealId: deal.id, event: 'created', toStage: 'new', actorId: actor.id } });
      await this.audit.record(
        { actorId: actor.id, action: 'sales.deal.created', targetType: 'sales_deal', targetId: deal.number, details: { lead: lead.id, service: dto.service, value: dto.value, currency: dto.currency }, ...client },
        tx,
      );
      return deal.id;
    });
    const view = await this.detail(a, id);
    noteActivity({ target: view.number, description: `Added the deal ${view.number}` });
    return view;
  }

  /** PATCH /sales/deals/:id: an open deal that is not waiting for Won confirmation. */
  async update(actor: Actor, idOrNumber: string, dto: UpdateSalesDealData, client: RequestInfo): Promise<SalesDealDetailView> {
    const a = await this.access.of(actor);
    const row = await this.workable(a, idOrNumber);
    if (dto.nextStepDate !== undefined) this.requireNextStepDate(dto.nextStepDate);
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const data: Prisma.SalesDealUncheckedUpdateManyInput = {};
    const current: Record<string, string | null> = {
      service: row.service,
      value: row.value.toFixed(2),
      currency: row.currency,
      expectedClose: dayOf(row.expectedClose),
      nextStep: row.nextStep,
      nextStepDate: row.nextStepDate ? dayOf(row.nextStepDate) : null,
    };
    for (const key of Object.keys(current)) {
      const value = dto[key as keyof UpdateSalesDealData] as string | undefined;
      if (value === undefined || value === current[key] || (key === 'value' && Number(value) === Number(current.value))) continue;
      before[key] = current[key];
      after[key] = value;
      (data as Record<string, unknown>)[key] = key === 'expectedClose' || key === 'nextStepDate' ? dbDate(value) : value;
    }
    if (!Object.keys(data).length) return this.detail(a, row.id);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.salesDeal.updateMany({
        where: { id: row.id, version: dto.version, stage: { in: [...SALES_OPEN_STAGES] }, wonStatus: 'none' },
        data: { ...data, version: { increment: 1 }, updatedBy: actor.id },
      });
      if (!count) conflict('stale_version', 'This deal was changed by someone else. Reload it');
      await this.audit.record({ actorId: actor.id, action: 'sales.deal.updated', targetType: 'sales_deal', targetId: row.number, details: { before, after } as Prisma.InputJsonValue, ...client }, tx);
    });
    noteActivity({ target: row.number, description: `Changed the deal ${row.number}` });
    return this.detail(a, row.id);
  }

  /** POST /sales/deals/:id/move: to another open stage, or to Lost (with a reason from the settings). Never to Won. */
  async move(actor: Actor, idOrNumber: string, dto: MoveSalesDealData, client: RequestInfo): Promise<SalesDealDetailView> {
    const a = await this.access.of(actor);
    const row = await this.workable(a, idOrNumber);
    if (dto.toStage === row.stage) conflict('same_stage', 'The deal is already in this stage');
    if (dto.toStage === 'won') badRequest('use_won_request', 'Won is asked for and then confirmed by the sales manager');
    const data: Prisma.SalesDealUncheckedUpdateManyInput = { stage: dto.toStage, version: { increment: 1 }, updatedBy: actor.id };
    let reason: string | null = null;
    if (dto.toStage === 'lost') {
      const { lostReasons, recontactMonths } = await this.settings.value<SalesSettings>(SALES_SETTINGS);
      if (!lostReasons.length || recontactMonths === null) {
        conflict('sales_rules_missing', 'The lost reasons and the re-contact period are not set yet. The Director sets them in Settings > Sales');
      }
      reason = lostReasons.find((r) => r.toLowerCase() === dto.lostReason!.trim().toLowerCase()) ?? null;
      if (!reason) badRequest('unknown_lost_reason', `Choose one of the lost reasons: ${lostReasons.join(', ')}`);
      Object.assign(data, { lostReason: reason, lostNote: dto.note ?? null, recontactAfter: dbDate(addMonths(this.today(), recontactMonths)), closedAt: this.clock.now(), nextStep: null, nextStepDate: null });
    } else {
      const nextStep = dto.nextStep ?? row.nextStep;
      const nextStepDate = dto.nextStepDate ?? (row.nextStepDate ? dayOf(row.nextStepDate) : null);
      if (!nextStep || !nextStepDate) badRequest('next_step_required', 'Every open deal needs a next step with a date');
      if (dto.nextStepDate) this.requireNextStepDate(dto.nextStepDate);
      Object.assign(data, { nextStep, nextStepDate: dbDate(nextStepDate) });
    }
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.salesDeal.updateMany({ where: { id: row.id, version: dto.version, stage: row.stage, wonStatus: 'none' }, data });
      if (!count) conflict('stale_version', 'This deal was changed by someone else. Reload it');
      await tx.salesDealHistory.create({ data: { dealId: row.id, event: 'stage_changed', fromStage: row.stage, toStage: dto.toStage, actorId: actor.id, reason, note: dto.note ?? null } });
      await this.audit.record(
        { actorId: actor.id, action: 'sales.deal.moved', targetType: 'sales_deal', targetId: row.number, reason, details: { from: row.stage, to: dto.toStage }, ...client },
        tx,
      );
    });
    noteActivity({ target: row.number, description: `Moved the deal ${row.number} to ${dto.toStage.replace('_', ' ')}` });
    return this.detail(a, row.id);
  }

  /** POST /sales/deals/:id/request-won: the owner (or the sales manager) marks the deal Won; it waits for confirmation. */
  async requestWon(actor: Actor, idOrNumber: string, version: number, client: RequestInfo): Promise<SalesDealDetailView> {
    const a = await this.access.of(actor);
    const row = await this.workable(a, idOrNumber);
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.salesDeal.updateMany({
        where: { id: row.id, version, wonStatus: 'none', stage: { in: [...SALES_OPEN_STAGES] } },
        data: { wonStatus: 'pending', wonRequestedAt: now, wonRequestedById: actor.id, version: { increment: 1 }, updatedBy: actor.id },
      });
      if (!count) conflict('stale_version', 'This deal was changed by someone else. Reload it');
      await tx.salesDealHistory.create({ data: { dealId: row.id, event: 'won_requested', fromStage: row.stage, toStage: row.stage, actorId: actor.id } });
      await this.audit.record({ actorId: actor.id, action: 'sales.deal.won_requested', targetType: 'sales_deal', targetId: row.number, ...client }, tx);
    });
    noteActivity({ target: row.number, description: `Marked the deal ${row.number} as Won (waiting for confirmation)` });
    return this.detail(a, row.id);
  }

  /**
   * POST /sales/deals/:id/confirm-won: the sales manager confirms. In ONE transaction: the deal becomes Won, the history row
   * and the audit entry are written, and sales.deal.won_confirmed is put in the outbox for Module 13 (one draft invoice per
   * deal number there). Either all of it happens or none of it.
   */
  async confirmWon(actor: Actor, idOrNumber: string, version: number, client: RequestInfo): Promise<SalesDealDetailView> {
    const a = await this.access.of(actor);
    const row = await this.decidable(a, idOrNumber);
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.salesDeal.updateMany({
        where: { id: row.id, version, wonStatus: 'pending' },
        data: { stage: 'won', wonStatus: 'confirmed', wonConfirmedAt: now, wonConfirmedById: actor.id, closedAt: now, version: { increment: 1 }, updatedBy: actor.id },
      });
      if (!count) conflict('stale_version', 'This deal was changed by someone else. Reload it');
      await tx.salesDealHistory.create({ data: { dealId: row.id, event: 'won_confirmed', fromStage: row.stage, toStage: 'won', actorId: actor.id } });
      await this.audit.record({ actorId: actor.id, action: 'sales.deal.won_confirmed', targetType: 'sales_deal', targetId: row.number, details: { owner: row.owner.empId, value: row.value.toFixed(2), currency: row.currency }, ...client }, tx);
      await this.outbox.emit(
        {
          type: 'sales.deal.won_confirmed',
          actor: actor.empId,
          payload: {
            dealNumber: row.number,
            ownerEmpId: row.owner.empId,
            confirmedByEmpId: actor.empId,
            client: { partyId: row.company.partyId, name: row.company.name, email: row.lead.email, country: row.company.country ?? row.lead.country },
            service: SALES_DEAL_SERVICE_LABEL[row.service],
            value: row.value.toFixed(2),
            currency: row.currency,
          },
        },
        tx,
      );
    });
    noteActivity({ target: row.number, description: `Confirmed the deal ${row.number} as Won` });
    return this.detail(a, row.id);
  }

  /**
   * POST /sales/deals/:id/reject-won: the sales manager sends the Won request back with a reason; the deal stays open. The
   * person who asked may also take their own request back (that approves nothing); they may never confirm it.
   */
  async rejectWon(actor: Actor, idOrNumber: string, dto: RejectSalesWonRequest, client: RequestInfo): Promise<SalesDealDetailView> {
    const a = await this.access.of(actor);
    const pending = await this.find(idOrNumber);
    const row = pending.wonStatus === 'pending' && pending.wonRequestedById === actor.id ? pending : await this.decidable(a, idOrNumber);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.salesDeal.updateMany({
        where: { id: row.id, version: dto.version, wonStatus: 'pending' },
        data: { wonStatus: 'none', wonRequestedAt: null, wonRequestedById: null, version: { increment: 1 }, updatedBy: actor.id },
      });
      if (!count) conflict('stale_version', 'This deal was changed by someone else. Reload it');
      await tx.salesDealHistory.create({ data: { dealId: row.id, event: 'won_rejected', fromStage: row.stage, toStage: row.stage, actorId: actor.id, reason: dto.reason } });
      await this.audit.record({ actorId: actor.id, action: 'sales.deal.won_rejected', targetType: 'sales_deal', targetId: row.number, reason: dto.reason, ...client }, tx);
    });
    noteActivity({ target: row.number, description: `Sent back the Won request of ${row.number}` });
    return this.detail(a, row.id);
  }

  // ---------------------------------------------------------------------------------------------------------- helpers

  /** Deals the caller sees in full: the same rule as leads (own; reporting line with sales.team; all with sales.all). */
  dealWhere(a: SalesAccess): Prisma.SalesDealWhereInput {
    const leads = this.access.leadWhere(a);
    if (!Object.keys(leads).length) return {};
    return 'ownerId' in leads ? { ownerId: leads.ownerId as string } : { owner: leads.owner as Prisma.EmployeeWhereInput };
  }

  /**
   * Who may confirm or send back a pending Won request, never the owner or the person who asked:
   *  - the sales manager, for a deal of someone in their reporting line;
   *  - the CEO / Founder / Owner (decision B1), for a deal the Director owns, and only such a deal.
   */
  async canDecideWon(a: SalesAccess, row: { ownerId: string; wonStatus: string; wonRequestedById: string | null; owner: { level: { number: number } } }, managed?: Set<string>): Promise<boolean> {
    if (row.wonStatus !== 'pending') return false;
    if (row.ownerId === a.actor.id || row.wonRequestedById === a.actor.id) return false;
    if (a.confirmDirectorDeals && row.owner.level.number === DIRECTOR_LEVEL) return true;
    if (!a.manage) return false;
    return managed ? managed.has(row.ownerId) : this.access.canManage(a, row.ownerId);
  }

  async find(idOrNumber: string, db: Prisma.TransactionClient | PrismaService = this.prisma): Promise<DealRow> {
    const where: Prisma.SalesDealWhereUniqueInput = UUID.test(idOrNumber) ? { id: idOrNumber } : { number: idOrNumber };
    const row = await db.salesDeal.findUnique({ where, include: dealInclude });
    if (!row || row.archivedAt) notFound('Deal not found');
    return row;
  }

  /** The deal, when the caller may work on it now: owner or sales manager; open; not waiting for Won confirmation. */
  private async workable(a: SalesAccess, idOrNumber: string): Promise<DealRow> {
    const row = await this.find(idOrNumber);
    if (!(await this.access.canEdit(a, row.ownerId))) forbidden('not_allowed', 'Only the owner or the sales manager works on this deal');
    if (!isOpenDealStage(row.stage)) conflict('deal_closed', 'This deal is closed (Won and Lost are final). Add a new deal to work with the client again');
    if (row.wonStatus === 'pending') conflict('won_pending', 'This deal is waiting for the Won confirmation');
    return row;
  }

  /** The deal, when the caller may decide its pending Won request. */
  private async decidable(a: SalesAccess, idOrNumber: string): Promise<DealRow> {
    const row = await this.find(idOrNumber);
    if (row.ownerId === a.actor.id || row.wonRequestedById === a.actor.id) forbidden('self_approval', 'Nobody confirms their own deal or their own request');
    if (a.confirmDirectorDeals && !a.manage) {
      // The CEO / Founder / Owner (decision B1): a deal the Director owns, and nothing else.
      if (row.owner.level.number !== DIRECTOR_LEVEL) forbidden('owner_confirms_director_deals_only', 'The Owner confirms only Won deals the Director owns');
    } else {
      if (!a.manage) forbidden('not_allowed', 'Only the sales manager confirms Won deals');
      if (!(await this.access.canManage(a, row.ownerId))) forbidden('not_allowed', 'This deal belongs to someone outside your sales team');
    }
    if (row.wonStatus !== 'pending') conflict('not_pending', 'This deal is not waiting for the Won confirmation');
    return row;
  }

  private requireNextStepDate(day: string): void {
    if (day < this.today()) badRequest('next_step_in_past', 'The next step date cannot be in the past');
  }

  async detail(a: SalesAccess, id: string, db: Tx | PrismaService = this.prisma): Promise<SalesDealDetailView> {
    const row = await db.salesDeal.findUniqueOrThrow({ where: { id }, include: dealInclude });
    const [view] = await this.views(a, [row]);
    const history = await db.salesDealHistory.findMany({ where: { dealId: id }, include: { actor: { select: { empId: true, fullName: true } } }, orderBy: [{ at: 'asc' }, { id: 'asc' }] });
    // Module 13's record of the handover, read only (one row per deal number once its reader has handled the event).
    const handover = row.wonStatus === 'confirmed' ? await db.dealHandover.findUnique({ where: { dealNumber: row.number }, select: { status: true, invoiceId: true } }) : null;
    return {
      ...view,
      history: history.map(
        (h): SalesDealHistoryView => ({ event: h.event, fromStage: h.fromStage, toStage: h.toStage, by: h.actor ? person(h.actor) : null, at: h.at.toISOString(), reason: h.reason, note: h.note }),
      ),
      handover: handover ? { status: handover.status, invoiceId: handover.invoiceId } : null,
    };
  }

  async views(a: SalesAccess, rows: DealRow[]): Promise<SalesDealView[]> {
    const managed = await this.access.manageableOwners(a, rows.map((r) => r.ownerId));
    const out: SalesDealView[] = [];
    for (const r of rows) {
      const open = isOpenDealStage(r.stage) && r.wonStatus === 'none';
      out.push({
        restricted: false,
        id: r.id,
        number: r.number,
        leadId: r.lead.id,
        leadName: r.lead.fullName,
        company: { id: r.company.id, name: r.company.name, partyId: r.company.partyId },
        owner: person(r.owner),
        service: r.service,
        value: r.value.toFixed(2),
        currency: r.currency,
        expectedClose: dayOf(r.expectedClose),
        stage: r.stage,
        nextStep: r.nextStep,
        nextStepDate: r.nextStepDate ? dayOf(r.nextStepDate) : null,
        lostReason: r.lostReason,
        lostNote: r.lostNote,
        recontactAfter: r.recontactAfter ? dayOf(r.recontactAfter) : null,
        wonStatus: r.wonStatus,
        wonRequestedAt: r.wonRequestedAt?.toISOString() ?? null,
        wonRequestedBy: r.wonRequestedBy ? person(r.wonRequestedBy) : null,
        wonConfirmedAt: r.wonConfirmedAt?.toISOString() ?? null,
        wonConfirmedBy: r.wonConfirmedBy ? person(r.wonConfirmedBy) : null,
        closedAt: r.closedAt?.toISOString() ?? null,
        version: r.version,
        createdAt: r.createdAt.toISOString(),
        updatedAt: r.updatedAt.toISOString(),
        canEdit: open && (r.ownerId === a.actor.id || managed.has(r.ownerId)),
        canDecideWon: await this.canDecideWon(a, r, managed),
      });
    }
    return out;
  }
}
