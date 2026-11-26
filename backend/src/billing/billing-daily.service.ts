import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Clock } from '../common/clock';
import { withDbRules } from '../common/db-rules';
import { dec, money, ZERO } from '../common/money';
import { addDays, dayOf, dbDate, pkDate, pkInstant } from '../common/pakistan-time';
import { ENV } from '../config/config.module';
import { backgroundWorkersOn, type Env } from '../config/env';
import { OutboxService } from '../events/outbox.service';
import type { Prisma } from '../generated/prisma/client';
import { LedgerQueryService } from '../finance/ledger-query.service';
import { JobRunner } from '../jobs/job-runner.service';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { daysDiff } from './billing-dates';
import { BillingService } from './billing.service';
import { SubscriptionsService } from './subscriptions.service';

export const BILLING_DAILY_JOB = 'billing.daily';
/** The daily billing run starts at 09:00 Pakistan time. */
const RUN_MINUTE = 9 * 60;
/** A reminder is still sent this many days after its day (the server was down); older ones are skipped, never sent late. */
const LATE_GRACE_DAYS = 2;

export interface DailyRunResult {
  recurringDrafts: number;
  remindersSent: number;
  remindersSkipped: number;
  overdueEvents: number;
  renewalAlerts: number;
}

/**
 * The daily billing run (plan section 18: "a scheduled job checks upcoming invoice due dates and subscription renewals
 * each day ... and records each alert"). Every step can run twice without doing anything twice: drafts are unique per
 * rule and period, reminders per invoice, day and audience, the overdue event per invoice, renewal alerts per
 * subscription and renewal date, and notifications and emails per dedupe key.
 */
@Injectable()
export class BillingDailyService implements OnModuleInit {
  private readonly logger = new Logger('BillingDaily');

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly subscriptions: SubscriptionsService,
    private readonly ledger: LedgerQueryService,
    private readonly notifications: NotificationService,
    private readonly outbox: OutboxService,
    private readonly jobs: JobRunner,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.jobs.register(BILLING_DAILY_JOB, async (payload) => {
      const day = String(payload.day);
      await this.run(day);
      await this.scheduleFor(addDays(day, 1));
    });
  }

  async onModuleInit(): Promise<void> {
    if (!backgroundWorkersOn(this.env)) return; // tests run the day themselves
    // Today's run (at 09:00, or now if the server starts later); an existing one, even finished, is left alone.
    await this.scheduleFor(pkDate(this.clock.now()), true).catch((e) => this.logger.error(`Could not schedule the billing run: ${(e as Error).message}`));
  }

  private async scheduleFor(day: string, keepExisting = false): Promise<void> {
    const runAt = pkInstant(day, RUN_MINUTE);
    const dedupeKey = `${BILLING_DAILY_JOB}:${day}`;
    if (keepExisting) {
      await this.prisma.scheduledJob.createMany({ data: [{ type: BILLING_DAILY_JOB, dedupeKey, runAt, payload: { day } }], skipDuplicates: true });
      return;
    }
    if (await this.prisma.scheduledJob.findUnique({ where: { dedupeKey }, select: { id: true } })) return;
    await this.jobs.schedule(BILLING_DAILY_JOB, dedupeKey, runAt, { day }, null);
  }

  async run(day: string): Promise<DailyRunResult> {
    const recurringDrafts = await this.billing.generateRecurring(day);
    const { sent, skipped } = await this.runReminders(day);
    const overdueEvents = await this.runOverdue(day);
    const renewalAlerts = await this.subscriptions.runRenewalAlerts(day);
    return { recurringDrafts, remindersSent: sent, remindersSkipped: skipped, overdueEvents, renewalAlerts };
  }

  /**
   * Reminders whose day has come. Never for a paid or cancelled invoice, nor one whose payment is recorded and waits for
   * approval. When several reminders of an invoice are due at once (missed days), only the latest one is sent.
   */
  async runReminders(day: string): Promise<{ sent: number; skipped: number }> {
    const due = await this.prisma.invoiceReminder.findMany({ where: { status: 'scheduled', scheduledFor: { lte: dbDate(day) } }, orderBy: [{ invoiceId: 'asc' }, { offsetDays: 'asc' }] });
    const groups = new Map<string, typeof due>();
    for (const r of due) {
      const key = `${r.invoiceId}:${r.audience}`;
      groups.set(key, [...(groups.get(key) ?? []), r]);
    }
    let sent = 0;
    let skipped = 0;
    for (const list of groups.values()) {
      const latest = list[list.length - 1];
      for (const r of list.slice(0, -1)) {
        await this.prisma.invoiceReminder.updateMany({ where: { id: r.id, status: 'scheduled' }, data: { status: 'skipped', reason: 'A later reminder replaced it' } });
        skipped++;
      }
      const outcome = await withDbRules(() => this.prisma.$transaction((tx) => this.sendReminder(tx, latest.id, day)));
      if (outcome === 'sent') sent++;
      else if (outcome === 'skipped') skipped++;
    }
    return { sent, skipped };
  }

  private async sendReminder(tx: Prisma.TransactionClient, reminderId: string, day: string): Promise<'sent' | 'skipped' | 'none'> {
    await tx.$queryRaw`SELECT id FROM invoice_reminders WHERE id = ${reminderId}::uuid FOR UPDATE`;
    const r = await tx.invoiceReminder.findUniqueOrThrow({ where: { id: reminderId }, include: { invoice: { include: { party: { select: { name: true, email: true } } } } } });
    if (r.status !== 'scheduled') return 'none';
    const inv = r.invoice;
    const skip = async (reason: string) => {
      await tx.invoiceReminder.update({ where: { id: r.id }, data: { status: 'skipped', reason } });
      return 'skipped' as const;
    };
    if (inv.status === 'cancelled') return skip('Invoice cancelled');
    if (inv.status !== 'issued') return skip('The invoice is not issued');
    const entry = inv.journalEntryId ? await tx.journalEntry.findUnique({ where: { id: inv.journalEntryId }, select: { status: true } }) : null;
    if (!entry || entry.status === 'rejected') return skip('The ledger entry of the invoice was rejected');
    const totals = (await this.ledger.allocationTotals('invoice', [inv.id], tx)).get(inv.id) ?? { paid: ZERO, committed: ZERO };
    const total = dec(inv.total);
    if (totals.paid.gte(total)) return skip('Already paid');
    if (totals.committed.gte(total)) return skip('A payment is recorded and waits for approval');
    const late = daysDiff(dayOf(r.scheduledFor), day);
    if (late > LATE_GRACE_DAYS) return skip(`Missed: the reminder day was ${late} days ago`);

    const due = dayOf(inv.dueDate);
    const balance = `${inv.currency} ${money(total.minus(totals.paid))}`;
    if (r.audience === 'staff') {
      const to = inv.assignedToId ?? inv.issuedBy ?? inv.createdBy;
      if (!to) return skip('Nobody is assigned to this invoice');
      const overdue = r.offsetDays > 0;
      const created = await this.notifications.create(tx, {
        recipientId: to,
        type: overdue ? 'invoice_overdue' : 'invoice_due',
        title: overdue ? `Invoice ${inv.number} is ${r.offsetDays} days overdue` : r.offsetDays === 0 ? `Invoice ${inv.number} is due today` : `Invoice ${inv.number} is due in ${-r.offsetDays} days`,
        body: `${inv.party.name}: ${balance} still open (due ${due}).`,
        link: `/billing/invoices/${inv.id}`,
        dedupeKey: `reminder:${r.id}`,
      });
      const n = await tx.notification.findUnique({ where: { recipientId_dedupeKey: { recipientId: to, dedupeKey: `reminder:${r.id}` } }, select: { id: true } });
      if (!created && !n) return skip('The assigned person has left');
      await tx.invoiceReminder.update({ where: { id: r.id }, data: { status: 'sent', sentAt: this.clock.now(), notificationId: n?.id ?? null } });
      return 'sent';
    }
    // The client hears nothing about an invoice whose ledger entry is not approved yet (review decision 1).
    if (entry.status !== 'posted') return skip('The ledger entry of the invoice is not approved yet');
    const s = await this.billing.settingsValue(tx);
    if (!s.customerEmails.enabled || !s.customerEmails.fromAddress) return skip('Customer emails are switched off in the billing settings');
    if (!inv.party.email) return skip('The client has no email address');
    const email = await tx.billingCustomerEmail.upsert({
      where: { dedupeKey: `reminder:${r.id}` },
      create: { invoiceId: inv.id, kind: 'reminder', reminderOffset: r.offsetDays, toAddress: inv.party.email, dedupeKey: `reminder:${r.id}`, nextAttemptAt: this.clock.now() },
      update: {},
    });
    await tx.invoiceReminder.update({ where: { id: r.id }, data: { status: 'sent', sentAt: this.clock.now(), customerEmailId: email.id } });
    return 'sent';
  }

  /** The "invoice overdue" event, once per invoice, the first day an issued invoice is past its due date and still open. */
  async runOverdue(day: string): Promise<number> {
    const candidates = await this.prisma.invoice.findMany({ where: { status: 'issued', overdueEventAt: null, dueDate: { lt: dbDate(day) }, journalEntryId: { not: null } }, select: { id: true } });
    let count = 0;
    for (const { id } of candidates) {
      const done = await this.prisma.$transaction(async (tx) => {
        const inv = await tx.invoice.findUniqueOrThrow({ where: { id } });
        const entry = await tx.journalEntry.findUnique({ where: { id: inv.journalEntryId! }, select: { status: true } });
        if (!entry || entry.status === 'rejected') return false;
        const paid = (await this.ledger.allocationTotals('invoice', [id], tx)).get(id)?.paid ?? ZERO;
        if (paid.gte(inv.total)) return false;
        const { count: claimed } = await tx.invoice.updateMany({ where: { id, overdueEventAt: null }, data: { overdueEventAt: this.clock.now() } });
        if (!claimed) return false;
        await this.outbox.emit({ type: 'billing.invoice.overdue', actor: 'system', payload: { invoiceNumber: inv.number, dueDate: dayOf(inv.dueDate), daysOverdue: daysDiff(dayOf(inv.dueDate), day) } }, tx);
        return true;
      });
      if (done) count++;
    }
    return count;
  }
}
