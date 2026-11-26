import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { BillingSettings } from '@aceva/contracts';
import { Clock } from '../common/clock';
import { dec, money, ZERO } from '../common/money';
import { dayOf } from '../common/pakistan-time';
import { ENV } from '../config/config.module';
import { backgroundWorkersOn, type Env } from '../config/env';
import { LedgerQueryService } from '../finance/ledger-query.service';
import { Mailer } from '../mail/mailer';
import { PrismaService } from '../prisma/prisma.service';
import { daysDiff } from './billing-dates';
import { BillingService, renderInvoiceHtml } from './billing.service';

export const MAX_CUSTOMER_EMAIL_ATTEMPTS = 5;
/** Still "sending" after this long: interrupted, outcome unknown, never sent again automatically (it may have gone out). */
export const CUSTOMER_SENDING_STALE_MS = 10 * 60_000;
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000];
/** A reminder email not sent within this many days of being queued is dropped rather than sent late. */
const REMINDER_STALE_DAYS = 2;

export interface CustomerEmailRunResult {
  sent: number;
  retrying: number;
  failed: number;
  skipped: number;
  /** Waiting because customer emails are switched off (kept, sent once they are switched on, unless stale). */
  held: number;
}

interface Claimed {
  id: string;
  attempts: number;
}

/**
 * Sends emails to clients: the invoice when it is issued, and reminders (Module 13). The same safety as the notification
 * emails: each row is claimed with FOR UPDATE SKIP LOCKED, a sent row is never sent again, an interrupted send becomes
 * "unknown" instead of being retried, and failures retry with a growing delay. Right before sending it checks again that
 * the invoice is still issued and, for a reminder, still unpaid: a paid or cancelled invoice never gets a reminder.
 * The sending address and the company details come from the billing settings; nothing is sent until they are set.
 */
@Injectable()
export class CustomerEmailService {
  private readonly logger = new Logger('CustomerEmails');
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly ledger: LedgerQueryService,
    private readonly mailer: Mailer,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Interval(15_000)
  async scheduledTick(): Promise<void> {
    if (!backgroundWorkersOn(this.env) || this.ticking) return;
    this.ticking = true;
    try {
      await this.drain();
    } catch (e) {
      this.logger.error(`Customer email tick failed: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  async drain(): Promise<CustomerEmailRunResult> {
    const result: CustomerEmailRunResult = { sent: 0, retrying: 0, failed: 0, skipped: 0, held: 0 };
    const now = this.clock.now();
    await this.prisma.billingCustomerEmail.updateMany({
      where: { status: 'sending', updatedAt: { lt: new Date(now.getTime() - CUSTOMER_SENDING_STALE_MS) } },
      data: { status: 'unknown', note: 'interrupted while sending; not sent again automatically' },
    });
    const s = await this.billing.settingsValue();
    if (!s.customerEmails.enabled || !s.customerEmails.fromAddress) {
      result.held = await this.prisma.billingCustomerEmail.count({ where: { status: 'pending' } });
      return result;
    }
    for (;;) {
      const claimed = await this.claim();
      if (!claimed) return result;
      result[await this.deliver(claimed, s)]++;
    }
  }

  private async claim(): Promise<Claimed | null> {
    const now = this.clock.now();
    const rows = await this.prisma.$queryRaw<Claimed[]>`
      UPDATE billing_customer_emails SET status = 'sending', attempts = attempts + 1, updated_at = ${now}
      WHERE id = (
        SELECT id FROM billing_customer_emails
        WHERE status = 'pending' AND next_attempt_at <= ${now}
        ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, attempts`;
    return rows[0] ?? null;
  }

  private async deliver(c: Claimed, s: BillingSettings): Promise<'sent' | 'retrying' | 'failed' | 'skipped'> {
    const row = await this.prisma.billingCustomerEmail.findUniqueOrThrow({ where: { id: c.id }, include: { invoice: { select: { id: true, status: true, total: true, journalEntryId: true } } } });
    const skip = async (note: string) => {
      await this.prisma.billingCustomerEmail.update({ where: { id: c.id }, data: { status: 'skipped', note } });
      if (row.kind === 'reminder') await this.prisma.invoiceReminder.updateMany({ where: { customerEmailId: c.id }, data: { status: 'skipped', reason: note } });
      return 'skipped' as const;
    };
    if (row.invoice.status !== 'issued') return skip(row.invoice.status === 'cancelled' ? 'Invoice cancelled' : 'The invoice is not issued');
    // Checked again right before sending: nothing goes to the client unless the invoice's ledger entry is approved.
    const entry = row.invoice.journalEntryId ? await this.prisma.journalEntry.findUnique({ where: { id: row.invoice.journalEntryId }, select: { status: true } }) : null;
    if (entry?.status !== 'posted') return skip('The ledger entry of the invoice is not approved');
    if (row.kind === 'reminder') {
      const t = (await this.ledger.allocationTotals('invoice', [row.invoiceId])).get(row.invoiceId) ?? { paid: ZERO, committed: ZERO };
      if (t.paid.gte(row.invoice.total)) return skip('Already paid');
      if (t.committed.gte(row.invoice.total)) return skip('A payment is recorded and waits for approval');
      if (daysDiff(dayOf(row.createdAt), dayOf(this.clock.now())) > REMINDER_STALE_DAYS) return skip('Too late: the reminder was not sent in time');
    }
    const detail = await this.billing.invoiceDetail(row.invoiceId);
    const message = row.kind === 'invoice' ? this.invoiceMessage(detail, s) : this.reminderMessage(detail, s, row.reminderOffset ?? 0);
    try {
      await this.mailer.send({ to: row.toAddress, from: s.customerEmails.fromAddress!, replyTo: s.customerEmails.replyTo ?? undefined, ...message });
      const now = this.clock.now();
      await this.prisma.billingCustomerEmail.update({ where: { id: c.id }, data: { status: 'sent', sentAt: now, note: null, lastError: null } });
      if (row.kind === 'invoice') await this.prisma.invoice.updateMany({ where: { id: row.invoiceId, emailedAt: null }, data: { emailedAt: now } });
      return 'sent';
    } catch (error) {
      const final = c.attempts >= MAX_CUSTOMER_EMAIL_ATTEMPTS;
      await this.prisma.billingCustomerEmail.update({
        where: { id: c.id },
        data: {
          status: final ? 'failed' : 'pending',
          lastError: `${(error as Error).name}: ${(error as Error).message}`.slice(0, 200),
          nextAttemptAt: final ? undefined : new Date(this.clock.now().getTime() + BACKOFF_MS[Math.min(c.attempts - 1, BACKOFF_MS.length - 1)]),
        },
      });
      return final ? 'failed' : 'retrying';
    }
  }

  private signature(s: BillingSettings): string[] {
    const c = s.company;
    return ['', c.legalName ?? '', ...[c.address, c.email, c.phone].filter((x): x is string => !!x)];
  }

  private invoiceMessage(d: Awaited<ReturnType<BillingService['invoiceDetail']>>, s: BillingSettings) {
    const inv = d.invoice;
    const lines = [
      `Dear ${d.customer.contactName || d.customer.name},`,
      '',
      `Please find invoice ${inv.number} from ${s.company.legalName}.`,
      '',
      `Amount: ${inv.currency} ${inv.total}`,
      `Issue date: ${inv.issueDate}`,
      `Due date: ${inv.dueDate}`,
      ...inv.lines.map((l) => `- ${l.description}: ${inv.currency} ${l.amount}`),
    ];
    if (s.company.paymentDetails) lines.push('', 'How to pay:', s.company.paymentDetails);
    lines.push(...this.signature(s));
    return { subject: `Invoice ${inv.number} from ${s.company.legalName}`, text: lines.join('\n'), html: renderInvoiceHtml(inv, d.customer, s) };
  }

  private reminderMessage(d: Awaited<ReturnType<BillingService['invoiceDetail']>>, s: BillingSettings, offset: number) {
    const inv = d.invoice;
    const balance = `${inv.currency} ${money(dec(inv.balance))}`;
    const when = offset < 0 ? `is due on ${inv.dueDate}` : offset === 0 ? 'is due today' : `was due on ${inv.dueDate}`;
    const lines = [`Dear ${d.customer.contactName || d.customer.name},`, '', `This is a reminder that invoice ${inv.number} ${when}. The amount still open is ${balance}.`];
    if (s.company.paymentDetails) lines.push('', 'How to pay:', s.company.paymentDetails);
    lines.push('', 'If you have already paid, thank you, and please ignore this message.', ...this.signature(s));
    return { subject: `Reminder: invoice ${inv.number} ${offset > 0 ? 'is overdue' : 'is due'}`, text: lines.join('\n') };
  }
}
