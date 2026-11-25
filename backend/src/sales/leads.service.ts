import { Injectable } from '@nestjs/common';
import {
  type CreateSalesLeadData,
  normalizeEmail,
  type Page,
  type ReassignSalesLeadRequest,
  type SalesDuplicateCheckRequest,
  type SalesDuplicateCheckView,
  type SalesLeadListQuery,
  type SalesLeadResult,
  type SalesLeadView,
  type SalesPersonRef,
  type UpdateSalesLeadData,
  SALES_DUPLICATE_CHECKS_PER_MINUTE,
  SALES_OPEN_STAGES,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { isUniqueViolation } from '../common/db-rules';
import { noteActivity } from '../common/request-context';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CompaniesService } from './companies.service';
import { DncService } from './dnc.service';
import { DuplicateCheckThrottle } from './duplicate-check-throttle';
import { type SalesAccess, SalesAccessService } from './sales-access.service';
import { conflict, forbidden, notFound, tooManyRequests } from './sales-errors';
import { leadInclude, leadStub, leadView, person, type LeadRow } from './sales-views';

/** Lead fields a plain edit may change, with how the audit log shows them (notes are personal text: only "changed"). */
const EDITABLE = ['fullName', 'jobTitle', 'email', 'phone', 'linkedinUrl', 'country', 'industry', 'notes', 'source'] as const;
type EditableField = (typeof EDITABLE)[number];

/**
 * Module 15.1 leads (plan section 20): one record per person, one owner each, no duplicates.
 *
 * The email is THE duplicate key: a lead that is not archived with the same (trimmed, lower-case) email is refused with
 * its owner, both by the check before saving and by the partial unique index sales_leads_email_active_key (so two people
 * saving the same email at the same moment get one lead and one "already exists, owned by ...").
 * The company's website domain identifies the company (CompaniesService): a lead at a company someone else already works
 * on is allowed, and the check shows who owns leads there (whether that should block is management decision D-8).
 */
@Injectable()
export class LeadsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: SalesAccessService,
    private readonly companies: CompaniesService,
    private readonly audit: AuditService,
    private readonly throttle: DuplicateCheckThrottle,
    private readonly dnc: DncService,
  ) {}

  // ------------------------------------------------------------------------------------------------------------ reads

  /** GET /sales/leads: the leads the caller may see in full (own; team; all), newest first. */
  async list(actor: Actor, q: SalesLeadListQuery): Promise<Page<SalesLeadView>> {
    const a = await this.access.of(actor);
    const filters: Prisma.SalesLeadWhereInput[] = [this.access.leadWhere(a)];
    if (q.status === 'active') filters.push({ archivedAt: null });
    if (q.status === 'archived') filters.push({ archivedAt: { not: null } });
    if (q.owner) filters.push({ owner: { empId: q.owner } });
    if (q.source) filters.push({ source: q.source });
    if (q.country) filters.push({ country: { equals: q.country, mode: 'insensitive' } });
    if (q.companyId) filters.push({ companyId: q.companyId });
    if (q.q) {
      filters.push({
        OR: [
          { fullName: { contains: q.q, mode: 'insensitive' } },
          { emailNormalized: { contains: q.q.toLowerCase() } },
          { jobTitle: { contains: q.q, mode: 'insensitive' } },
          { company: { name: { contains: q.q, mode: 'insensitive' } } },
        ],
      });
    }
    const where: Prisma.SalesLeadWhereInput = { AND: filters };
    const [total, rows] = await Promise.all([
      this.prisma.salesLead.count({ where }),
      this.prisma.salesLead.findMany({ where, include: leadInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { items: await this.views(a, rows), total, page: q.page, pageSize: q.pageSize };
  }

  /** GET /sales/leads/:id: in full when the caller may see it, otherwise only that it exists and who owns it. */
  async get(actor: Actor, id: string): Promise<SalesLeadResult> {
    const a = await this.access.of(actor);
    const row = await this.prisma.salesLead.findUnique({ where: { id }, include: leadInclude });
    if (!row) notFound('Lead not found');
    if (!(await this.access.seesFull(a, row.ownerId))) return leadStub(row);
    return (await this.views(a, [row]))[0];
  }

  /** POST /sales/leads/check-duplicate: does this email or company domain already exist, and who owns it. */
  async checkDuplicate(actor: Actor, dto: SalesDuplicateCheckRequest, client: RequestInfo): Promise<SalesDuplicateCheckView> {
    if (!this.throttle.allow(actor.id)) {
      await this.audit.record({ actorId: actor.id, action: 'sales.duplicate_check.limited', targetType: 'sales_lead', outcome: 'denied', reason: 'rate_limited', ...client });
      tooManyRequests(`At most ${SALES_DUPLICATE_CHECKS_PER_MINUTE} duplicate checks a minute. Wait a moment and try again`);
    }
    const a = await this.access.of(actor);
    let email: SalesDuplicateCheckView['email'] = null;
    if (dto.email) {
      const found = await this.byEmail(normalizeEmail(dto.email));
      if (found) email = { leadId: found.id, owner: person(found.owner), mine: found.ownerId === actor.id, canOpen: await this.access.seesFull(a, found.ownerId) };
    }
    const d = await this.companies.domainOf(dto.website);
    let company: SalesDuplicateCheckView['company'] = null;
    if (d.domain) {
      const c = await this.companies.findByDomain(d.domain);
      if (c) company = { companyId: c.id, name: c.name, leadOwners: await this.companies.leadOwners(c.id) };
    }
    noteActivity({ description: 'Checked a lead for duplicates', hideTarget: true, details: { emailMatch: !!email, companyMatch: !!company } });
    return { email, domain: d.domain, sharedDomain: d.shared, company };
  }

  // ----------------------------------------------------------------------------------------------------------- writes

  /** POST /sales/leads */
  async create(actor: Actor, dto: CreateSalesLeadData, client: RequestInfo): Promise<SalesLeadView> {
    const a = await this.access.of(actor);
    const owner = dto.ownerEmpId && dto.ownerEmpId !== actor.empId ? await this.access.assignableOwner(a, dto.ownerEmpId) : { id: actor.id, empId: actor.empId };
    const email = dto.email ?? null;
    const emailNormalized = email ? normalizeEmail(email) : null;
    if (emailNormalized) await this.refuseDuplicate(emailNormalized);
    let id: string;
    try {
      id = await this.prisma.$transaction(async (tx) => {
        // M15.4: never a lead for an email on the do-not-contact list (checked under the email's lock).
        if (emailNormalized) await this.dnc.guardEmail(tx, emailNormalized);
        const company = await this.companies.resolveForLead(tx, actor, { companyId: dto.companyId, company: dto.company }, client);
        const lead = await tx.salesLead.create({
          data: {
            fullName: dto.fullName,
            jobTitle: dto.jobTitle ?? null,
            companyId: company?.id ?? null,
            email,
            emailNormalized,
            phone: dto.phone ?? null,
            linkedinUrl: dto.linkedinUrl ?? null,
            country: dto.country ?? null,
            industry: dto.industry ?? null,
            source: dto.source,
            ownerId: owner.id,
            notes: dto.notes ?? null,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
          select: { id: true },
        });
        await this.audit.record(
          { actorId: actor.id, action: 'sales.lead.created', targetType: 'sales_lead', targetId: lead.id, details: { source: dto.source, owner: owner.empId, companyId: company?.id ?? null, newCompany: company?.created ?? false }, ...client },
          tx,
        );
        return lead.id;
      });
    } catch (error) {
      if (emailNormalized && isUniqueViolation(error)) await this.refuseDuplicate(emailNormalized);
      throw error;
    }
    noteActivity({ target: dto.fullName, description: `Added the lead ${dto.fullName}` });
    return this.viewOf(a, id);
  }

  /** PATCH /sales/leads/:id: the owner, or the sales manager for their team. The owner changes only by reassigning. */
  async update(actor: Actor, id: string, dto: UpdateSalesLeadData, client: RequestInfo): Promise<SalesLeadView> {
    const a = await this.access.of(actor);
    const row = await this.editable(a, id);
    const data: Prisma.SalesLeadUncheckedUpdateManyInput = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    for (const key of EDITABLE) {
      const value = dto[key as keyof typeof dto] as string | null | undefined;
      if (value === undefined || value === row[key as EditableField]) continue;
      before[key] = key === 'notes' ? (row.notes ? '[text]' : null) : row[key as EditableField];
      after[key] = key === 'notes' ? (value ? '[text]' : null) : value;
      (data as Record<string, unknown>)[key] = value;
    }
    let emailNormalized: string | null | undefined;
    if (dto.email !== undefined && dto.email !== row.email) {
      emailNormalized = dto.email ? normalizeEmail(dto.email) : null;
      data.emailNormalized = emailNormalized;
      if (emailNormalized && emailNormalized !== row.emailNormalized) await this.refuseDuplicate(emailNormalized, id);
    }
    const companyChange = dto.company !== undefined || (dto.companyId !== undefined && dto.companyId !== row.companyId);
    if (!Object.keys(data).length && !companyChange) return this.viewOf(a, id);
    try {
      await this.prisma.$transaction(async (tx) => {
        // M15.4: a lead's email cannot be changed to one on the do-not-contact list.
        if (emailNormalized && emailNormalized !== row.emailNormalized) await this.dnc.guardEmail(tx, emailNormalized);
        if (companyChange) {
          const company = await this.companies.resolveForLead(tx, actor, { companyId: dto.companyId, company: dto.company }, client);
          if ((company?.id ?? null) !== row.companyId) {
            before.companyId = row.companyId;
            after.companyId = company?.id ?? null;
            data.companyId = company?.id ?? null;
          }
        }
        if (!Object.keys(data).length) return;
        const { count } = await tx.salesLead.updateMany({ where: { id, version: dto.version, archivedAt: null }, data: { ...data, version: { increment: 1 }, updatedBy: actor.id } });
        if (!count) conflict('stale_version', 'This lead was changed by someone else. Reload it');
        await this.audit.record({ actorId: actor.id, action: 'sales.lead.updated', targetType: 'sales_lead', targetId: id, details: { before, after } as Prisma.InputJsonValue, ...client }, tx);
      });
    } catch (error) {
      if (emailNormalized && isUniqueViolation(error)) await this.refuseDuplicate(emailNormalized, id);
      throw error;
    }
    noteActivity({ target: row.fullName, description: `Changed the lead ${row.fullName}` });
    return this.viewOf(a, id);
  }

  /**
   * POST /sales/leads/:id/owner: the sales manager moves a lead to another salesperson in their team (plan section 20,
   * "moves leads between people"). Needs the version read, a reason, and is logged. Its open deals move with it.
   */
  async reassign(actor: Actor, id: string, dto: ReassignSalesLeadRequest, client: RequestInfo): Promise<SalesLeadView> {
    const a = await this.access.of(actor);
    if (!a.manage) forbidden('not_allowed', 'Only the sales manager moves leads between people');
    const row = await this.prisma.salesLead.findUnique({ where: { id }, include: leadInclude });
    if (!row) notFound('Lead not found');
    if (!(await this.access.canManage(a, row.ownerId))) forbidden('not_allowed', 'This lead belongs to someone outside your sales team');
    if (row.archivedAt) conflict('lead_archived', 'This lead is archived');
    const target = await this.access.assignableOwner(a, dto.toEmpId);
    if (target.id === row.ownerId) conflict('same_owner', `${target.empId} already owns this lead`);
    await this.prisma.$transaction(async (tx) => {
      const { count } = await tx.salesLead.updateMany({ where: { id, version: dto.version, ownerId: row.ownerId, archivedAt: null }, data: { ownerId: target.id, version: { increment: 1 }, updatedBy: actor.id } });
      if (!count) conflict('stale_version', 'This lead was changed by someone else. Reload it');
      // M15.2: the lead's OPEN deals move with it (Won and Lost deals keep their owner: they are final). Each one keeps a
      // history row; its version changes, so a screen that read it before must reload.
      const open = await tx.salesDeal.findMany({ where: { leadId: id, ownerId: row.ownerId, stage: { in: [...SALES_OPEN_STAGES] }, archivedAt: null }, select: { id: true, number: true, stage: true } });
      if (open.length) {
        // Only while each deal still has this owner and an open stage: one closed or moved meanwhile (Won and Lost keep their
        // owner) makes the counts differ, and the whole move is refused (rolled back) with a 409 instead of a database error.
        const moved = await tx.salesDeal.updateMany({
          where: { id: { in: open.map((d) => d.id) }, ownerId: row.ownerId, stage: { in: [...SALES_OPEN_STAGES] }, archivedAt: null },
          data: { ownerId: target.id, version: { increment: 1 }, updatedBy: actor.id },
        });
        if (moved.count !== open.length) conflict('deals_changed', 'A deal of this lead was changed at the same moment. Reload the lead and try again');
        await tx.salesDealHistory.createMany({ data: open.map((d) => ({ dealId: d.id, event: 'owner_changed' as const, fromStage: d.stage, toStage: d.stage, actorId: actor.id, reason: dto.reason, note: `${row.owner.empId} to ${target.empId}` })) });
      }
      await this.audit.record(
        { actorId: actor.id, action: 'sales.lead.reassigned', targetType: 'sales_lead', targetId: id, reason: dto.reason, details: { from: row.owner.empId, to: target.empId, deals: open.map((d) => d.number) }, ...client },
        tx,
      );
    });
    noteActivity({ target: row.fullName, description: `Moved the lead ${row.fullName} from ${row.owner.empId} to ${target.empId}` });
    return this.viewOf(a, id);
  }

  // ---------------------------------------------------------------------------------------------------------- helpers

  private byEmail(emailNormalized: string): Promise<LeadRow | null> {
    return this.prisma.salesLead.findFirst({ where: { emailNormalized, archivedAt: null }, include: leadInclude });
  }

  /** 409 duplicate_lead with the owner, when a lead (other than `exceptId`) that is not archived has this email. */
  private async refuseDuplicate(emailNormalized: string, exceptId?: string): Promise<void> {
    const found = await this.byEmail(emailNormalized);
    if (!found || found.id === exceptId) return;
    const owner: SalesPersonRef = person(found.owner);
    conflict('duplicate_lead', `This lead already exists. Owner: ${owner.name} (${owner.empId})`, { existing: { leadId: found.id, owner } });
  }

  /** The lead, when the caller may change it. */
  private async editable(a: SalesAccess, id: string): Promise<LeadRow> {
    const row = await this.prisma.salesLead.findUnique({ where: { id }, include: leadInclude });
    if (!row) notFound('Lead not found');
    if (!(await this.access.canEdit(a, row.ownerId))) forbidden('not_allowed', 'Only the owner or the sales manager changes this lead');
    if (row.archivedAt) conflict('lead_archived', 'This lead is archived');
    return row;
  }

  private async viewOf(a: SalesAccess, id: string): Promise<SalesLeadView> {
    const row = await this.prisma.salesLead.findUniqueOrThrow({ where: { id }, include: leadInclude });
    return (await this.views(a, [row]))[0];
  }

  /** Full views of rows the caller may see in full. */
  private async views(a: SalesAccess, rows: LeadRow[]): Promise<SalesLeadView[]> {
    const creatorIds = [...new Set(rows.map((r) => r.createdBy).filter((x): x is string => !!x))];
    const creators = new Map((await this.prisma.employee.findMany({ where: { id: { in: creatorIds } }, select: { id: true, empId: true, fullName: true } })).map((e) => [e.id, person(e)]));
    const managed = await this.access.manageableOwners(a, rows.map((r) => r.ownerId));
    const out: SalesLeadView[] = [];
    for (const r of rows) {
      const manage = managed.has(r.ownerId);
      const companyCanEdit = r.company ? a.manage || r.company.createdBy === a.actor.id || r.ownerId === a.actor.id : false;
      out.push(leadView(r, { createdBy: r.createdBy ? (creators.get(r.createdBy) ?? null) : null, canEdit: !r.archivedAt && (r.ownerId === a.actor.id || manage), canReassign: !r.archivedAt && manage, companyCanEdit }));
    }
    return out;
  }
}
