import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { SALES_OPEN_STAGES } from '@aceva/contracts';
import { Clock } from '../common/clock';
import { addDays, dbDate, pkDate, pkInstant } from '../common/pakistan-time';
import { ENV } from '../config/config.module';
import { backgroundWorkersOn, type Env } from '../config/env';
import { JobRunner } from '../jobs/job-runner.service';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../prisma/prisma.service';

export const SALES_FOLLOW_UPS_JOB = 'sales.follow_ups.daily';
/** The daily reminder runs at 09:00 Pakistan time (approved CTO decision for M15.3). */
const RUN_MINUTE = 9 * 60;

/**
 * "My follow-ups today" (plan section 20; notification event "sales follow-up due", plan section 17). Every day at 09:00
 * Pakistan time, the owner of each open deal whose next step is due that day gets one `sales_follow_up` notification
 * (not a deal waiting for its Won confirmation: its follow-up cannot be completed until the request is decided)
 * (in the app, and by email unless they switched non-essential emails off; Module 12 delivers it and retries).
 *
 * Runs on the shared job runner, once per Pakistan day (key sales.follow_ups.daily:<day>); each run schedules the next day.
 * Running a day twice changes nothing: each notification has the dedupe key sales_follow_up:<deal>:<day>, so one follow-up
 * is announced once. A missed follow-up is not announced again: it turns red on the screens and the sales manager sees it
 * in the team's follow-ups.
 */
@Injectable()
export class FollowUpRemindersService implements OnModuleInit {
  private readonly logger = new Logger('SalesFollowUps');

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifications: NotificationService,
    private readonly jobs: JobRunner,
    private readonly clock: Clock,
    @Inject(ENV) private readonly env: Env,
  ) {
    this.jobs.register(SALES_FOLLOW_UPS_JOB, async (payload) => {
      const day = String(payload.day);
      await this.run(day);
      await this.scheduleFor(addDays(day, 1));
    });
  }

  async onModuleInit(): Promise<void> {
    if (!backgroundWorkersOn(this.env)) return; // tests run the day themselves
    // Today's run (at 09:00, or now if the server starts later); an existing one, even finished, is left alone.
    await this.scheduleFor(pkDate(this.clock.now()), true).catch((e) => this.logger.error(`Could not schedule the follow-up reminders: ${(e as Error).message}`));
  }

  private async scheduleFor(day: string, keepExisting = false): Promise<void> {
    const runAt = pkInstant(day, RUN_MINUTE);
    const dedupeKey = `${SALES_FOLLOW_UPS_JOB}:${day}`;
    if (keepExisting) {
      await this.prisma.scheduledJob.createMany({ data: [{ type: SALES_FOLLOW_UPS_JOB, dedupeKey, runAt, payload: { day } }], skipDuplicates: true });
      return;
    }
    if (await this.prisma.scheduledJob.findUnique({ where: { dedupeKey }, select: { id: true } })) return;
    await this.jobs.schedule(SALES_FOLLOW_UPS_JOB, dedupeKey, runAt, { day }, null);
  }

  /** The reminders of one Pakistan day ("2026-12-08"). Returns how many new notifications were made. */
  async run(day: string): Promise<number> {
    const due = await this.prisma.salesDeal.findMany({
      // Not a deal waiting for its Won confirmation: its follow-up cannot be completed (409 won_pending) until it is decided.
      where: { stage: { in: [...SALES_OPEN_STAGES] }, wonStatus: 'none', archivedAt: null, nextStepDate: dbDate(day), owner: { status: 'active' } },
      select: { id: true, number: true, ownerId: true, nextStep: true, company: { select: { name: true } } },
      orderBy: { number: 'asc' },
    });
    let made = 0;
    for (const d of due) {
      const created = await this.prisma.$transaction((tx) =>
        this.notifications.create(tx, {
          recipientId: d.ownerId,
          type: 'sales_follow_up',
          title: `Follow-up due today: ${d.company.name}`,
          body: `${d.number}: ${d.nextStep ?? 'next step'}`,
          link: `/sales/deals/${d.id}`,
          dedupeKey: `sales_follow_up:${d.id}:${day}`,
        }),
      );
      if (created) made++;
    }
    if (due.length) this.logger.log(`${day}: ${made} follow-up reminder(s) (${due.length} due)`);
    return made;
  }
}
