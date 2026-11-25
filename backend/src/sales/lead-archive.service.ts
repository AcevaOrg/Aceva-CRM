import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { SALES_ARCHIVE_CLEARED_FIELDS, SALES_OPEN_STAGES, SALES_SETTINGS, type SalesSettings } from '@aceva/contracts';
import { AuditService } from '../access/audit.service';
import { Clock } from '../common/clock';
import { addDays, pkDate, pkInstant } from '../common/pakistan-time';
import { ENV } from '../config/config.module';
import { backgroundWorkersOn, type Env } from '../config/env';
import { JobRunner } from '../jobs/job-runner.service';
import { PrismaService } from '../prisma/prisma.service';
import { ModuleSettingsService } from '../settings/module-settings.service';
import { addMonths } from './deals.service';
import { DncService } from './dnc.service';
import { SalesOffboardingService } from './sales-offboarding.service';

export const SALES_NIGHTLY_JOB = 'sales.nightly';
/** The nightly sales job runs at 02:00 Pakistan time (approved technical default for M15.5). */
const RUN_MINUTE = 2 * 60;
const PAGE = 500;

/** Why an inactive lead was left alone (counted in the run's result and log). */
export type ArchiveSkip = 'open_deal' | 'won_client' | 'client_company' | 'dnc_unprotected' | 'changed';

export interface ArchiveResult {
  cutoff: string;
  archived: number;
  skipped: Partial<Record<ArchiveSkip, number>>;
}

/**
 * Module 15.5: archiving inactive leads (plan section 20: "Leads with no activity for 12 months are archived and their
 * contact details removed. The period is a setting."). Approved decision 9:
 *  - "no activity" = the lead's last activity (last_activity_at: when it was added, and every logged contact since; a note
 *    is not a contact, M15.3) is before the start (Pakistan time) of the day `archiveMonths` months ago (setting, 12);
 *  - archiving sets archived_at and clears email, phone and LinkedIn; the name, company, source, owner, notes, the
 *    timeline (insert-only) and the audit trail stay. An archive record keeps the reason, the period, the last activity,
 *    the details removed and the job run (sales_lead_archives, insert-only);
 *  - never archived: a lead with an open deal (a deal waiting for its Won confirmation is open), a lead with a Won deal,
 *    or a lead at a client company (a Won deal at the company, or the company already a client in Module 13);
 *  - a do-not-contact lead is archived too; the list keeps its keyed hash, so the email stays blocked after it is
 *    removed. A do-not-contact lead whose current email is not on the list is left alone (and logged) rather than lose
 *    its protection;
 *  - an archived lead cannot be edited, contacted, given a deal or moved; its email no longer counts as a duplicate, so
 *    the person can be added again as a new lead, unless the email is on the do-not-contact list.
 *
 * Each lead is archived in its own transaction under its row lock, with every condition checked again there, so a contact
 * or a deal logged at the same moment wins and the lead stays. Running the night again changes nothing.
 * The same nightly job (02:00 Pakistan time) first runs the leaver check of SalesOffboardingService.
 */
@Injectable()
export class LeadArchiveService implements OnModuleInit {
  private readonly logger = new Logger('SalesNightly');

  constructor(
    private readonly prisma: PrismaService,
    private readonly settings: ModuleSettingsService,
    private readonly offboarding: SalesOffboardingService,
    private readonly dnc: DncService,
    private readonly audit: AuditService,
    private readonly jobs: JobRunner,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.jobs.register(SALES_NIGHTLY_JOB, async (payload) => {
      const day = String(payload.day);
      await this.runNight(day);
      await this.scheduleFor(addDays(day, 1));
    });
  }

  async onModuleInit(): Promise<void> {
    if (!backgroundWorkersOn(this.env)) return; // tests run the night themselves
    await this.scheduleFor(pkDate(this.clock.now()), true).catch((e) => this.logger.error(`Could not schedule the nightly sales job: ${(e as Error).message}`));
  }

  private async scheduleFor(day: string, keepExisting = false): Promise<void> {
    const runAt = pkInstant(day, RUN_MINUTE);
    const dedupeKey = `${SALES_NIGHTLY_JOB}:${day}`;
    if (keepExisting) {
      await this.prisma.scheduledJob.createMany({ data: [{ type: SALES_NIGHTLY_JOB, dedupeKey, runAt, payload: { day } }], skipDuplicates: true });
      return;
    }
    if (await this.prisma.scheduledJob.findUnique({ where: { dedupeKey }, select: { id: true } })) return;
    await this.jobs.schedule(SALES_NIGHTLY_JOB, dedupeKey, runAt, { day }, null);
  }

  /** One night: leavers first (their leads must not be archived under someone who left), then archiving. */
  async runNight(day: string): Promise<{ leavers: { checked: number; moved: number }; archive: ArchiveResult }> {
    const job = `${SALES_NIGHTLY_JOB}:${day}`;
    const leavers = await this.offboarding.sweep(job);
    const archive = await this.archiveInactive(job);
    this.logger.log(`${day}: ${leavers.moved}/${leavers.checked} leaver(s) handled; ${archive.archived} lead(s) archived (no activity before ${archive.cutoff}) ${JSON.stringify(archive.skipped)}`);
    return { leavers, archive };
  }

  /** Archives every lead without activity since the cut-off. */
  async archiveInactive(job: string): Promise<ArchiveResult> {
    const { archiveMonths } = await this.settings.value<SalesSettings>(SALES_SETTINGS);
    const cutoffDay = addMonths(pkDate(this.clock.now()), -archiveMonths);
    const cutoff = pkInstant(cutoffDay);
    const result: ArchiveResult = { cutoff: cutoffDay, archived: 0, skipped: {} };
    let after = '00000000-0000-0000-0000-000000000000';
    for (;;) {
      // Candidates (checked again, under lock, one by one): inactive, no open or Won deal, not at a client company.
      const page = await this.prisma.salesLead.findMany({
        where: {
          id: { gt: after },
          archivedAt: null,
          lastActivityAt: { lt: cutoff },
          deals: { none: { stage: { in: [...SALES_OPEN_STAGES, 'won'] } } },
          OR: [{ companyId: null }, { company: { partyId: null, deals: { none: { stage: 'won' } } } }],
        },
        select: { id: true },
        orderBy: { id: 'asc' },
        take: PAGE,
      });
      for (const { id } of page) {
        const outcome = await this.archiveOne(id, cutoff, archiveMonths, job).catch((error) => {
          this.logger.error(`Lead ${id} was not archived: ${(error as Error).message}`);
          return 'changed' as const;
        });
        if (outcome === 'archived') result.archived++;
        else result.skipped[outcome] = (result.skipped[outcome] ?? 0) + 1;
      }
      if (page.length < PAGE) break;
      after = page[page.length - 1].id;
    }
    return result;
  }

  private async archiveOne(id: string, cutoff: Date, months: number, job: string): Promise<'archived' | ArchiveSkip> {
    return this.prisma.$transaction(async (tx) => {
      // The lead's row lock: a contact logged, a deal added or the lead changed at the same moment waits, or wins.
      const rows = await tx.$queryRaw<Array<{ archived_at: Date | null; last_activity_at: Date; email_normalized: string | null; phone: string | null; linkedin_url: string | null; email: string | null; dnc_at: Date | null; company_id: string | null }>>`
        SELECT archived_at, last_activity_at, email, email_normalized, phone, linkedin_url, dnc_at, company_id FROM sales_leads WHERE id = ${id}::uuid FOR UPDATE`;
      const l = rows[0];
      if (!l || l.archived_at || l.last_activity_at.getTime() >= cutoff.getTime()) return 'changed';
      if (await tx.salesDeal.count({ where: { leadId: id, stage: { in: [...SALES_OPEN_STAGES] } } })) return 'open_deal';
      if (await tx.salesDeal.count({ where: { leadId: id, stage: 'won' } })) return 'won_client';
      if (l.company_id) {
        const c = await tx.salesCompany.findUnique({ where: { id: l.company_id }, select: { partyId: true, _count: { select: { deals: { where: { stage: 'won' } } } } } });
        if (c && (c.partyId || c._count.deals > 0)) return 'client_company';
      }
      // A do-not-contact lead keeps its protection through the list's hash: never remove an email the list cannot match.
      if (l.dnc_at && l.email_normalized && !(await this.dnc.listed(tx, [l.email_normalized])).size) {
        this.logger.warn(`Do-not-contact lead ${id} kept: its email is not on the list, so removing it would lose the protection`);
        return 'dnc_unprotected';
      }
      const cleared = SALES_ARCHIVE_CLEARED_FIELDS.filter((f) => (f === 'email' ? l.email : f === 'phone' ? l.phone : l.linkedin_url) !== null);
      const now = this.clock.now();
      await tx.salesLead.update({ where: { id }, data: { archivedAt: now, email: null, emailNormalized: null, phone: null, linkedinUrl: null, version: { increment: 1 }, updatedBy: null } });
      await tx.salesLeadArchive.create({ data: { leadId: id, archivedAt: now, reason: 'inactive', inactiveMonths: months, lastActivityAt: l.last_activity_at, clearedFields: [...cleared], archivedBy: null, job } });
      await this.audit.record(
        { actorId: null, action: 'sales.lead.archived', targetType: 'sales_lead', targetId: id, reason: 'inactive', details: { inactiveMonths: months, lastActivityAt: l.last_activity_at.toISOString(), cleared, doNotContact: l.dnc_at !== null, job } },
        tx,
      );
      return 'archived';
    });
  }
}
