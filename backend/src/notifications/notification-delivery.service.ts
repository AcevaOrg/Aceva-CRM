import { Inject, Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import type { NotificationSettings } from '@aceva/contracts';
import { Clock } from '../common/clock';
import { ENV } from '../config/config.module';
import { backgroundWorkersOn, type Env } from '../config/env';
import { Mailer } from '../mail/mailer';
import { PrismaService } from '../prisma/prisma.service';
import { ModuleSettingsService } from '../settings/module-settings.service';

/** Email attempts before a delivery is marked failed. */
export const MAX_EMAIL_ATTEMPTS = 5;
/** A delivery still "sending" after this long was interrupted: its outcome is unknown and it is not sent again. */
export const SENDING_STALE_MS = 10 * 60_000;
const BACKOFF_MS = [60_000, 5 * 60_000, 30 * 60_000, 2 * 3600_000];

export interface DeliveryRunResult {
  sent: number;
  retrying: number;
  failed: number;
  skipped: number;
  /** Emails waiting because notification emails are switched off company-wide (they are kept, not dropped). */
  held: number;
}

interface Claimed {
  id: string;
  notification_id: string;
  attempts: number;
}

/**
 * Sends the notification emails (Cycle 3 foundation). Each delivery row is claimed with FOR UPDATE SKIP LOCKED, so two
 * servers never send the same one. Exactly one email per notification: the row is unique per notification and channel,
 * a sent row is never sent again, and a send that was interrupted half-way (status "sending" for too long) becomes
 * "unknown" instead of being retried, because the email may already have gone out. A delivery that failed with an
 * error is retried with a growing delay, MAX_EMAIL_ATTEMPTS times. The email body never contains secrets, and it is
 * never written to the log.
 */
@Injectable()
export class NotificationDeliveryService {
  private readonly logger = new Logger('NotificationEmails');
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly clock: Clock,
    private readonly mailer: Mailer,
    private readonly settings: ModuleSettingsService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Interval(15_000)
  async scheduledTick(): Promise<void> {
    if (!backgroundWorkersOn(this.env)) return; // tests drive drain() themselves
    if (this.ticking) return;
    this.ticking = true;
    try {
      await this.drain();
    } catch (e) {
      this.logger.error(`Notification email tick failed: ${(e as Error).message}`);
    } finally {
      this.ticking = false;
    }
  }

  async drain(): Promise<DeliveryRunResult> {
    const result: DeliveryRunResult = { sent: 0, retrying: 0, failed: 0, skipped: 0, held: 0 };
    const now = this.clock.now();
    await this.prisma.notificationDelivery.updateMany({
      where: { status: 'sending', claimedAt: { lt: new Date(now.getTime() - SENDING_STALE_MS) } },
      data: { status: 'unknown', note: 'interrupted while sending; not sent again automatically' },
    });
    const { emailEnabled } = await this.settings.value<NotificationSettings>('notifications');
    if (!emailEnabled) {
      result.held = await this.prisma.notificationDelivery.count({ where: { status: 'pending' } });
      return result;
    }
    for (;;) {
      const claimed = await this.claim();
      if (!claimed) return result;
      result[await this.deliver(claimed)]++;
    }
  }

  private async claim(): Promise<Claimed | null> {
    const now = this.clock.now();
    const rows = await this.prisma.$queryRaw<Claimed[]>`
      UPDATE notification_deliveries SET status = 'sending', claimed_at = ${now}, attempts = attempts + 1, updated_at = ${now}
      WHERE id = (
        SELECT id FROM notification_deliveries
        WHERE status = 'pending' AND channel = 'email' AND next_attempt_at <= ${now}
        ORDER BY next_attempt_at, id LIMIT 1 FOR UPDATE SKIP LOCKED)
      RETURNING id, notification_id, attempts`;
    return rows[0] ?? null;
  }

  private async deliver(d: Claimed): Promise<'sent' | 'retrying' | 'failed' | 'skipped'> {
    const n = await this.prisma.notification.findUniqueOrThrow({
      where: { id: d.notification_id },
      include: { recipient: { select: { officialEmail: true, status: true, fullName: true } } },
    });
    const skip = async (note: string) => {
      await this.prisma.notificationDelivery.update({ where: { id: d.id }, data: { status: 'skipped', note, claimedAt: null } });
      return 'skipped' as const;
    };
    if (n.recipient.status === 'left') return skip('recipient_left');
    const to = n.recipient.officialEmail;
    if (!to) return skip('no_email');
    try {
      await this.mailer.send({ to, subject: `[Aceva] ${n.title}`, text: this.text(n.recipient.fullName, n.title, n.body, n.link, n.essential) });
      await this.prisma.notificationDelivery.update({ where: { id: d.id }, data: { status: 'sent', sentAt: this.clock.now(), toAddress: to, note: null } });
      return 'sent';
    } catch (error) {
      const final = d.attempts >= MAX_EMAIL_ATTEMPTS;
      const note = `${(error as Error).name}: ${(error as Error).message}`.slice(0, 200);
      await this.prisma.notificationDelivery.update({
        where: { id: d.id },
        data: {
          status: final ? 'failed' : 'pending',
          note,
          claimedAt: null,
          nextAttemptAt: final ? undefined : new Date(this.clock.now().getTime() + BACKOFF_MS[Math.min(d.attempts - 1, BACKOFF_MS.length - 1)]),
        },
      });
      return final ? 'failed' : 'retrying';
    }
  }

  private text(name: string, title: string, body: string | null, link: string | null, essential: boolean): string {
    const lines = [`Hello ${name},`, '', title];
    if (body) lines.push('', body);
    if (link) lines.push('', `Open it in Aceva: ${this.env.APP_URL.replace(/\/$/, '')}${link}`);
    lines.push(
      '',
      essential
        ? 'This is an approval or security notice. These emails cannot be turned off.'
        : 'You can turn off emails like this one in Aceva: Notifications, then Preferences.',
    );
    return lines.join('\n');
  }
}
