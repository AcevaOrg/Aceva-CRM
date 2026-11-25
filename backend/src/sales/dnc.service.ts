import { createHmac } from 'node:crypto';
import { Inject, Injectable, Logger } from '@nestjs/common';
import {
  type AddSalesDncEmailRequest,
  maskEmail,
  type MarkSalesLeadDncRequest,
  normalizeEmail,
  type Page,
  type SalesDncEntryView,
  type SalesDncListQuery,
  type SalesDncSource,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { Clock } from '../common/clock';
import { noteActivity } from '../common/request-context';
import { ENV } from '../config/config.module';
import { type Env, parseDncPreviousKeys } from '../config/env';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SalesAccessService } from './sales-access.service';
import { conflict, type Db, forbidden, notFound, serviceUnavailable } from './sales-errors';
import { person } from './sales-views';

type Tx = Prisma.TransactionClient;

/**
 * Module 15.4, the do-not-contact list (plan section 20: "An unsubscribe or 'do not contact' request is saved on the lead,
 * and the system blocks that email from every future sequence"). Approved M15.4 decisions 1-4:
 *  - the list keeps a keyed hash (HMAC-SHA256 of the normalised email, with its own secret SALES_DNC_HMAC_KEY) and a
 *    masked form ("a***@domain.com"); never the email. Entries are never changed or removed (database triggers);
 *  - the lead's owner or the sales manager marks a lead (POST /sales/leads/:id/do-not-contact); only the sales manager
 *    adds an email that has no lead (POST /sales/do-not-contact); sales.team / sales.all see the list;
 *  - a listed email cannot be added, imported or set as a lead's email (LeadsService, LeadImportService call guardEmail);
 *    outgoing contact cannot be logged on a marked lead (ActivitiesService). Email only.
 *
 * Fail-safe: without the key nothing that needs the list is done (503 dnc_unavailable); an entry made with a key that is
 * no longer configured stops everything too (503 dnc_key_missing) instead of quietly not matching. Every check runs under
 * a per-email transaction lock, so a lead and a list entry for the same email are never saved at the same moment.
 *
 * Key rotation: entries keep the id of the key that hashed them and the email is not stored, so an old key must stay
 * configured (SALES_DNC_HMAC_PREVIOUS_KEYS) for as long as its entries exist; the list matches against every known key.
 */
@Injectable()
export class DncService {
  private readonly logger = new Logger('SalesDnc');
  private readonly current: { id: string; key: Buffer } | null;
  private readonly keys: Map<string, Buffer>;

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: SalesAccessService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    @Inject(ENV) env: Env,
  ) {
    this.keys = parseDncPreviousKeys(env.SALES_DNC_HMAC_PREVIOUS_KEYS);
    this.current = env.SALES_DNC_HMAC_KEY ? { id: env.SALES_DNC_HMAC_KEY_ID, key: Buffer.from(env.SALES_DNC_HMAC_KEY, 'base64') } : null;
    if (this.current) this.keys.set(this.current.id, this.current.key);
    else this.logger.warn('SALES_DNC_HMAC_KEY is not set: adding or importing leads with an email, and the do-not-contact list, are refused');
  }

  // ---------------------------------------------------------------------------------------------------------- checks

  /**
   * For a lead about to be saved with this email (inside its transaction): takes the email's lock and refuses (409
   * do_not_contact) when the email is on the list.
   */
  async guardEmail(tx: Tx, emailNormalized: string): Promise<void> {
    await this.lockEmails(tx, [emailNormalized]);
    if ((await this.listed(tx, [emailNormalized])).size) {
      conflict('do_not_contact', 'This email is on the do-not-contact list, so it cannot be added as a lead');
    }
  }

  /** Transaction locks on these emails, always taken in the same order (no deadlock between two imports). */
  async lockEmails(tx: Tx, emailsNormalized: string[]): Promise<void> {
    const keys = [...new Set(emailsNormalized)].sort().map((e) => `sales_email:${e}`);
    for (let i = 0; i < keys.length; i += 1000) {
      const chunk = keys.slice(i, i + 1000);
      await tx.$queryRaw`SELECT count(*)::int AS n FROM (SELECT pg_advisory_xact_lock(hashtextextended(k, 0)) FROM (SELECT k FROM unnest(${chunk}::text[]) AS k ORDER BY k) ordered) locked`;
    }
  }

  /** Of these normalised emails, the ones on the list. Refuses (503) when the list cannot be checked. */
  async listed(db: Db, emailsNormalized: string[]): Promise<Set<string>> {
    const emails = [...new Set(emailsNormalized)];
    this.requireKey();
    if (!emails.length) return new Set();
    const used = await db.$queryRaw<Array<{ key_id: string }>>`SELECT DISTINCT key_id FROM sales_dnc_entries WHERE key_id IS NOT NULL`;
    const missing = used.map((r) => r.key_id).filter((id) => !this.keys.has(id));
    if (missing.length) {
      this.logger.error(`Do-not-contact entries use key id(s) that are not configured: ${missing.join(', ')}`);
      serviceUnavailable('dnc_key_missing', 'The do-not-contact list cannot be checked (a key it needs is missing). Nothing was saved. Tell the CTO');
    }
    const found = new Set<string>();
    for (const { key_id: keyId } of used) {
      const key = this.keys.get(keyId)!;
      const byHash = new Map(emails.map((e) => [this.hash(key, e), e]));
      const hashes = [...byHash.keys()];
      for (let i = 0; i < hashes.length; i += 1000) {
        const rows = await db.salesDncEntry.findMany({ where: { keyId, emailHmac: { in: hashes.slice(i, i + 1000) } }, select: { emailHmac: true } });
        for (const r of rows) found.add(byHash.get(r.emailHmac!)!);
      }
    }
    return found;
  }

  // ---------------------------------------------------------------------------------------------------------- writes

  /** POST /sales/leads/:id/do-not-contact: the lead's owner, or the sales manager for their team. */
  async markLead(actor: Actor, leadId: string, dto: MarkSalesLeadDncRequest, client: RequestInfo): Promise<void> {
    const a = await this.access.of(actor);
    const lead = await this.prisma.salesLead.findUnique({ where: { id: leadId }, select: { id: true, fullName: true, ownerId: true, emailNormalized: true, archivedAt: true, dncAt: true } });
    if (!lead) notFound('Lead not found');
    if (!(await this.access.canEdit(a, lead.ownerId))) forbidden('not_allowed', 'Only the owner of the lead or the sales manager marks it do not contact');
    if (lead.archivedAt) conflict('lead_archived', 'This lead is archived');
    if (lead.dncAt) conflict('already_dnc', 'This lead is already marked do not contact');
    const email = lead.emailNormalized;
    const key = email ? this.requireKey() : null;
    const now = this.clock.now();
    await this.prisma.$transaction(async (tx) => {
      let listedBefore = false;
      if (email && key) {
        await this.lockEmails(tx, [email]);
        listedBefore = (await this.listed(tx, [email])).size > 0;
      }
      // One entry per email: an email already on the list (added without a lead) only marks the lead.
      if (!listedBefore) {
        await tx.salesDncEntry.create({
          data: {
            emailHmac: email && key ? this.hash(key.key, email) : null,
            keyId: email && key ? key.id : null,
            maskedEmail: email ? maskEmail(email) : null,
            leadId: lead.id,
            reason: dto.reason,
            source: 'manual',
            createdBy: actor.id,
          },
        });
      }
      const { count } = await tx.salesLead.updateMany({ where: { id: lead.id, dncAt: null, archivedAt: null }, data: { dncAt: now, version: { increment: 1 }, updatedBy: actor.id } });
      if (!count) conflict('already_dnc', 'This lead was changed at the same moment. Reload it');
      await this.audit.record(
        { actorId: actor.id, action: 'sales.lead.do_not_contact', targetType: 'sales_lead', targetId: lead.id, reason: dto.reason, details: { email: email ? maskEmail(email) : null, alreadyListed: listedBefore }, ...client },
        tx,
      );
    });
    noteActivity({ target: lead.fullName, description: `Marked the lead ${lead.fullName} do not contact` });
  }

  /** POST /sales/do-not-contact: an email that has no lead (or whose lead someone else works on). The sales manager only. */
  async addEmail(actor: Actor, dto: AddSalesDncEmailRequest, client: RequestInfo): Promise<SalesDncEntryView> {
    const a = await this.access.of(actor);
    if (!a.manage) forbidden('not_allowed', 'Only the sales manager adds an email to the do-not-contact list');
    const email = normalizeEmail(dto.email);
    const key = this.requireKey();
    const now = this.clock.now();
    const id = await this.prisma.$transaction(async (tx) => {
      await this.lockEmails(tx, [email]);
      if ((await this.listed(tx, [email])).size) conflict('already_listed', 'This email is already on the do-not-contact list');
      // A lead with this email (the active one first) is marked too: the request applies whoever owns it.
      const leads = await tx.salesLead.findMany({ where: { emailNormalized: email }, select: { id: true, archivedAt: true }, orderBy: { createdAt: 'desc' } });
      const linked = leads.find((l) => !l.archivedAt) ?? leads[0] ?? null;
      const entry = await tx.salesDncEntry.create({
        data: { emailHmac: this.hash(key.key, email), keyId: key.id, maskedEmail: maskEmail(email), leadId: linked?.id ?? null, reason: dto.reason, source: 'manual', createdBy: actor.id },
        select: { id: true },
      });
      const marked = leads.length
        ? await tx.salesLead.updateMany({ where: { id: { in: leads.map((l) => l.id) }, dncAt: null }, data: { dncAt: now, version: { increment: 1 }, updatedBy: actor.id } })
        : { count: 0 };
      await this.audit.record(
        { actorId: actor.id, action: 'sales.dnc.added', targetType: 'sales_dnc_entry', targetId: entry.id, reason: dto.reason, details: { email: maskEmail(email), leadsMarked: marked.count }, ...client },
        tx,
      );
      return entry.id;
    });
    noteActivity({ target: maskEmail(email), description: `Added ${maskEmail(email)} to the do-not-contact list` });
    const row = await this.prisma.salesDncEntry.findUniqueOrThrow({ where: { id }, include: entryInclude });
    return (await this.views(a, [row]))[0];
  }

  /**
   * M15.5: a do-not-contact lead whose email changes keeps its protection: the new email is hashed onto the list too (inside
   * the caller's transaction, under the email's lock), so archiving can never remove an email the list cannot match.
   */
  async protectLeadEmail(tx: Tx, actorId: string, leadId: string, emailNormalized: string): Promise<void> {
    const key = this.requireKey();
    await this.lockEmails(tx, [emailNormalized]);
    if ((await this.listed(tx, [emailNormalized])).size) return;
    await tx.salesDncEntry.create({
      data: { emailHmac: this.hash(key.key, emailNormalized), keyId: key.id, maskedEmail: maskEmail(emailNormalized), leadId, reason: 'New email of a do-not-contact lead', source: 'manual', createdBy: actorId },
    });
  }

  // ----------------------------------------------------------------------------------------------------------- reads

  /** GET /sales/do-not-contact: sales.team or sales.all (the sales manager; the CEO / Owner views). Newest first. */
  async list(actor: Actor, q: SalesDncListQuery): Promise<Page<SalesDncEntryView>> {
    const a = await this.access.of(actor);
    if (!a.team && !a.all) forbidden('not_allowed', 'Only the sales manager sees the do-not-contact list');
    const [total, rows] = await Promise.all([
      this.prisma.salesDncEntry.count(),
      this.prisma.salesDncEntry.findMany({ include: entryInclude, orderBy: [{ createdAt: 'desc' }, { id: 'asc' }], skip: (q.page - 1) * q.pageSize, take: q.pageSize }),
    ]);
    return { items: await this.views(a, rows), total, page: q.page, pageSize: q.pageSize };
  }

  // --------------------------------------------------------------------------------------------------------- helpers

  /** Whether the list can be checked (the key is configured). */
  get available(): boolean {
    return this.current !== null;
  }

  private requireKey(): { id: string; key: Buffer } {
    if (!this.current) serviceUnavailable('dnc_unavailable', 'The do-not-contact list cannot be checked (its key is not configured), so nothing was saved. Tell the CTO');
    return this.current;
  }

  private hash(key: Buffer, emailNormalized: string): string {
    return createHmac('sha256', key).update(emailNormalized, 'utf8').digest('hex');
  }

  private async views(a: Awaited<ReturnType<SalesAccessService['of']>>, rows: EntryRow[]): Promise<SalesDncEntryView[]> {
    const out: SalesDncEntryView[] = [];
    for (const r of rows) {
      const showLead = r.lead ? await this.access.seesFull(a, r.lead.ownerId) : false;
      out.push({
        id: r.id,
        maskedEmail: r.maskedEmail,
        lead: showLead && r.lead ? { id: r.lead.id, fullName: r.lead.fullName } : null,
        reason: r.reason,
        source: r.source as SalesDncSource,
        addedBy: r.creator ? person(r.creator) : null,
        addedAt: r.createdAt.toISOString(),
      });
    }
    return out;
  }
}

const entryInclude = {
  lead: { select: { id: true, fullName: true, ownerId: true } },
  creator: { select: { empId: true, fullName: true } },
} satisfies Prisma.SalesDncEntryInclude;
type EntryRow = Prisma.SalesDncEntryGetPayload<{ include: typeof entryInclude }>;
