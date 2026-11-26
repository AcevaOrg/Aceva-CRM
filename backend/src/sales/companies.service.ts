import { Injectable } from '@nestjs/common';
import {
  type CreateSalesCompanyData,
  type Page,
  SALES_SETTINGS,
  type SalesCompanyDetailView,
  type SalesCompanyInput,
  type SalesCompanyListQuery,
  type SalesCompanyView,
  type SalesSettings,
  type UpdateSalesCompanyData,
  websiteDomain,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { isUniqueViolation } from '../common/db-rules';
import { noteActivity } from '../common/request-context';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ModuleSettingsService } from '../settings/module-settings.service';
import { type SalesAccess, SalesAccessService } from './sales-access.service';
import { conflict, type Db, forbidden, notFound } from './sales-errors';
import { companyView, leadInclude, leadView, person, type CompanyRow } from './sales-views';

type Tx = Prisma.TransactionClient;

/** A website and the domain the duplicate check uses for it. */
export interface CompanyDomain {
  website: string | null;
  /** Null: no website, or the website's domain is a shared one (settings). */
  domain: string | null;
  /** The website is on a shared domain: kept, but says nothing about which company it is. */
  shared: boolean;
}

/**
 * Module 15.1 companies (plan section 20): one record per company. The company's website domain identifies it: a new
 * company whose domain already belongs to a company that is not archived IS that company (the partial unique index
 * sales_companies_domain_active_key makes a second copy impossible, even when two people save at the same moment).
 * Without a website there is nothing to compare, so a company is never merged by its name (no rule says how).
 */
@Injectable()
export class CompaniesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: SalesAccessService,
    private readonly audit: AuditService,
    private readonly settings: ModuleSettingsService,
  ) {}

  /** The domain used for the duplicate check of a website, with the shared domains of the settings left out. */
  async domainOf(website: string | null | undefined, db: Db = this.prisma): Promise<CompanyDomain> {
    const site = website?.trim() || null;
    if (!site) return { website: null, domain: null, shared: false };
    const domain = websiteDomain(site);
    if (!domain) return { website: site, domain: null, shared: false };
    const { sharedWebsiteDomains } = await this.settings.value<SalesSettings>(SALES_SETTINGS, db);
    if (sharedWebsiteDomains.includes(domain)) return { website: site, domain: null, shared: true };
    return { website: site, domain, shared: false };
  }

  /** The company that is not archived and has this domain. */
  findByDomain(domain: string, db: Db = this.prisma): Promise<CompanyRow | null> {
    return db.salesCompany.findFirst({ where: { domain, archivedAt: null } });
  }

  /** May the caller change this company: the sales manager, whoever added it, or the owner of one of its leads. */
  async canEdit(a: SalesAccess, c: { id: string; createdBy: string | null }, db: Db = this.prisma): Promise<boolean> {
    if (a.manage || c.createdBy === a.actor.id) return true;
    return (await db.salesLead.count({ where: { companyId: c.id, ownerId: a.actor.id, archivedAt: null } })) > 0;
  }

  /**
   * The company for a new or changed lead, inside the lead's transaction: an existing one (companyId), or the one a new
   * company's domain belongs to, or a new company. INSERT ... ON CONFLICT DO NOTHING keeps the transaction usable when
   * someone else creates the same domain at the same moment; that company is then used.
   */
  async resolveForLead(tx: Tx, actor: Actor, input: { companyId?: string | null; company?: SalesCompanyInput }, client: RequestInfo): Promise<{ id: string; created: boolean } | null> {
    if (input.companyId) {
      const c = await tx.salesCompany.findUnique({ where: { id: input.companyId }, select: { id: true, archivedAt: true } });
      if (!c || c.archivedAt) notFound('Company not found');
      return { id: c.id, created: false };
    }
    if (!input.company) return null;
    const d = await this.domainOf(input.company.website, tx);
    if (d.domain) {
      const existing = await this.findByDomain(d.domain, tx);
      if (existing) return { id: existing.id, created: false };
    }
    const id = await this.insert(tx, actor, input.company, d);
    if (id) {
      await this.audit.record({ actorId: actor.id, action: 'sales.company.created', targetType: 'sales_company', targetId: id, details: { name: input.company.name, domain: d.domain }, ...client }, tx);
      return { id, created: true };
    }
    // Someone else created a company with this domain in the meantime: it is the same company.
    const raced = await this.findByDomain(d.domain!, tx);
    if (!raced) throw new Error('Company domain conflict without a company');
    return { id: raced.id, created: false };
  }

  /** Inserts a company; null when its domain already belongs to a company that is not archived. */
  private async insert(tx: Tx, actor: Actor, input: SalesCompanyInput, d: CompanyDomain): Promise<string | null> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO sales_companies (name, website, domain, country, industry, created_by, updated_by)
      VALUES (${input.name}, ${d.website}, ${d.domain}, ${input.country ?? null}, ${input.industry ?? null}, ${actor.id}::uuid, ${actor.id}::uuid)
      ON CONFLICT (domain) WHERE archived_at IS NULL AND domain IS NOT NULL DO NOTHING
      RETURNING id`;
    return rows[0]?.id ?? null;
  }

  // ---------------------------------------------------------------------------------------------------------- routes

  /** GET /sales/companies: companies that are not archived (name, website, country, industry: no prospect details). */
  async list(actor: Actor, q: SalesCompanyListQuery): Promise<Page<SalesCompanyView>> {
    const a = await this.access.of(actor);
    const where: Prisma.SalesCompanyWhereInput = {
      archivedAt: null,
      ...(q.q ? { OR: [{ name: { contains: q.q, mode: 'insensitive' } }, { domain: { contains: q.q.toLowerCase() } }] } : {}),
    };
    const [total, rows] = await Promise.all([
      this.prisma.salesCompany.count({ where }),
      this.prisma.salesCompany.findMany({ where, orderBy: [{ name: 'asc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    const mine = new Set(
      (await this.prisma.salesLead.findMany({ where: { companyId: { in: rows.map((r) => r.id) }, ownerId: actor.id, archivedAt: null }, select: { companyId: true }, distinct: ['companyId'] })).map((r) => r.companyId),
    );
    return { items: rows.map((c) => companyView(c, a.manage || c.createdBy === actor.id || mine.has(c.id))), total, page: q.page, pageSize: q.pageSize };
  }

  /** GET /sales/companies/:id: the company, the leads there the caller may see in full, and how many others there are. */
  async get(actor: Actor, id: string): Promise<SalesCompanyDetailView> {
    const a = await this.access.of(actor);
    const c = await this.prisma.salesCompany.findUnique({ where: { id } });
    if (!c) notFound('Company not found');
    const visible = { AND: [{ companyId: id, archivedAt: null }, this.access.leadWhere(a)] };
    const [leads, all] = await Promise.all([
      this.prisma.salesLead.findMany({ where: visible, include: leadInclude, orderBy: [{ fullName: 'asc' }, { id: 'asc' }] }),
      this.prisma.salesLead.count({ where: { companyId: id, archivedAt: null } }),
    ]);
    const canEdit = await this.canEdit(a, c);
    const managed = await this.access.manageableOwners(a, leads.map((l) => l.ownerId));
    const views = [];
    for (const l of leads) {
      const manage = managed.has(l.ownerId);
      views.push(leadView(l, { createdBy: null, canEdit: l.ownerId === actor.id || manage, canReassign: manage, companyCanEdit: canEdit }));
    }
    return { ...companyView(c, canEdit), leads: views, otherLeads: all - leads.length };
  }

  /** POST /sales/companies. A company whose domain already exists is refused with the existing one. */
  async create(actor: Actor, dto: CreateSalesCompanyData, client: RequestInfo): Promise<SalesCompanyView> {
    const d = await this.domainOf(dto.website);
    if (d.domain) {
      const existing = await this.findByDomain(d.domain);
      if (existing) this.duplicate(existing);
    }
    const id = await this.prisma.$transaction(async (tx) => {
      const created = await this.insert(tx, actor, dto, d);
      if (!created) return null;
      await this.audit.record({ actorId: actor.id, action: 'sales.company.created', targetType: 'sales_company', targetId: created, details: { name: dto.name, domain: d.domain }, ...client }, tx);
      return created;
    });
    if (!id) this.duplicate((await this.findByDomain(d.domain!))!);
    noteActivity({ target: dto.name, description: `Added the company ${dto.name}` });
    const row = await this.prisma.salesCompany.findUniqueOrThrow({ where: { id } });
    return companyView(row, true);
  }

  /** PATCH /sales/companies/:id (name the version you read). */
  async update(actor: Actor, id: string, dto: UpdateSalesCompanyData, client: RequestInfo): Promise<SalesCompanyView> {
    const a = await this.access.of(actor);
    const c = await this.prisma.salesCompany.findUnique({ where: { id } });
    if (!c) notFound('Company not found');
    if (c.archivedAt) conflict('company_archived', 'This company is archived');
    if (!(await this.canEdit(a, c))) forbidden('not_allowed', 'Only the sales manager, whoever added the company, or the owner of one of its leads changes it');
    const data: Prisma.SalesCompanyUpdateManyMutationInput = {};
    const before: Record<string, unknown> = {};
    const after: Record<string, unknown> = {};
    const set = (key: 'name' | 'country' | 'industry', value: string | null | undefined) => {
      if (value === undefined || value === c[key]) return;
      before[key] = c[key];
      after[key] = value;
      (data as Record<string, unknown>)[key] = value;
    };
    set('name', dto.name);
    set('country', dto.country);
    set('industry', dto.industry);
    if (dto.website !== undefined && dto.website !== c.website) {
      const d = await this.domainOf(dto.website);
      before.website = c.website;
      after.website = d.website;
      data.website = d.website;
      if (d.domain !== c.domain) {
        if (d.domain) {
          const other = await this.findByDomain(d.domain);
          if (other && other.id !== id) this.duplicate(other);
        }
        before.domain = c.domain;
        after.domain = d.domain;
        data.domain = d.domain;
      }
    }
    if (!Object.keys(data).length) return companyView(c, true);
    try {
      await this.prisma.$transaction(async (tx) => {
        const { count } = await tx.salesCompany.updateMany({ where: { id, version: dto.version }, data: { ...data, version: { increment: 1 }, updatedBy: actor.id } });
        if (!count) conflict('stale_version', 'This company was changed by someone else. Reload it');
        await this.audit.record({ actorId: actor.id, action: 'sales.company.updated', targetType: 'sales_company', targetId: id, details: { before, after } as Prisma.InputJsonValue, ...client }, tx);
      });
    } catch (error) {
      if (isUniqueViolation(error) && data.domain) this.duplicate((await this.findByDomain(data.domain as string))!);
      throw error;
    }
    noteActivity({ target: c.name, description: `Changed the company ${c.name}` });
    return companyView(await this.prisma.salesCompany.findUniqueOrThrow({ where: { id } }), true);
  }

  private duplicate(existing: { id: string; name: string }): never {
    conflict('duplicate_company', `This company already exists: ${existing.name}`, { existing: { companyId: existing.id, name: existing.name } });
  }

  /** Who owns leads (that are not archived) at a company: shown with a domain match instead of the leads themselves. */
  async leadOwners(companyId: string, db: Db = this.prisma) {
    const rows = await db.salesLead.findMany({ where: { companyId, archivedAt: null }, select: { owner: { select: { empId: true, fullName: true } } }, distinct: ['ownerId'], orderBy: { ownerId: 'asc' } });
    return rows.map((r) => person(r.owner)).sort((x, y) => x.empId.localeCompare(y.empId));
  }
}
