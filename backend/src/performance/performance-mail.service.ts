import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OutboxEvent } from '@aceva/contracts';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { Mailer } from '../mail/mailer';
import { PrismaService } from '../prisma/prisma.service';
import { PerformanceDirectory } from './performance-directory.service';
import { disputeDecidedMail, disputeRaisedMail, draftsWaitingMail, releasedMail, type MailText } from './rules/auto-mail';
import { groupByReviewer } from './rules/auto-monthly';
import { monthLabel } from './rules/perf-month';

type Of<T extends OutboxEvent['type']> = Extract<OutboxEvent, { type: T }>;

interface Person {
  empId: string;
  fullName: string;
  /** Null when the person has no official address: they are skipped, not an error. */
  email: string | null;
  left: boolean;
}

interface Outgoing {
  to: Person;
  mail: MailText;
}

/**
 * The Module 6 mails, through the existing Mailer (Mailpit in development). Short plain-text mails with an HTML twin, never a
 * secret or a pay figure, and never the score itself. Addresses and names are looked up from the Emp-IDs in the event
 * (employees.official_email); a person without an address, or who has left, is skipped (not an error). A mail that cannot be
 * sent makes the handler throw once every other recipient was tried, so the outbox dispatcher retries later (a retry can send a
 * mail twice: accepted). The words are in rules/auto-mail.ts; the link is `${APP_URL}/performance/scorecards/<scorecard id>`.
 *
 * Who is mailed: the reviewer once per month when drafts are waiting (draftsWaiting, called by the monthly job); the employee when
 * their scorecard is released (also the Director's automatic release) and when a dispute of theirs is decided; the decider when a
 * rating is disputed.
 */
@Injectable()
export class PerformanceMail {
  private readonly logger = new Logger('PerformanceMail');

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: Mailer,
    private readonly directory: PerformanceDirectory,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /**
   * After the monthly run: ONE mail to each reviewer who has draft scorecards of `month` waiting ("You have 5 draft scorecards
   * for October 2026 to review and release", linking to the Approvals inbox, where each draft is released). The count comes from
   * the database: the drafts of the month whose reviewer NOW (directory.reviewerOf) is that person. Nothing for a reviewer with
   * no drafts, and nothing for a person who has no reviewer (the Director's scorecard is released at once, nobody reviews it).
   * `options.reviewers` (Emp-IDs) limits the mail to those reviewers: the monthly job passes the ones who got new drafts in
   * this run, so a re-run of the job never mails the same people again. Returns how many mails were sent. Throws after trying
   * everyone when a mail could not be sent.
   */
  async draftsWaiting(month: string, options: { reviewers?: ReadonlySet<string> } = {}): Promise<number> {
    const drafts = await this.prisma.scorecard.findMany({ where: { month, status: 'draft' }, select: { employee: { select: { empId: true } } } });
    if (!drafts.length) return 0;
    const everybody = await this.directory.people();
    const reviewerByEmployee = new Map<string, string | null>();
    for (const d of drafts) reviewerByEmployee.set(d.employee.empId, (await this.directory.reviewerOf(d.employee.empId, everybody))?.empId ?? null);
    const digests = groupByReviewer(
      drafts.map((d) => ({ empId: d.employee.empId })),
      (empId) => reviewerByEmployee.get(empId) ?? null,
      options.reviewers,
    );
    if (!digests.length) return 0;
    const people = await this.people(digests.map((d) => d.reviewer));
    const label = monthLabel(month);
    const link = `${this.env.APP_URL}/approvals`;
    const out: Outgoing[] = [];
    for (const digest of digests) {
      const to = people.get(digest.reviewer);
      if (to) out.push({ to, mail: draftsWaitingMail({ name: to.fullName, month: label, count: digest.count, link }) });
    }
    return this.deliver(out);
  }

  /**
   * 'scorecard.released': mail the EMPLOYEE (event.payload.empId): "Your October 2026 scorecard is ready" with the link; it says who
   * released it (the Director's automatic release: "Your scorecard was released"), and that they can acknowledge it, add a comment
   * and dispute a task rating. Never the score in the mail text (the screen shows it).
   */
  async released(event: Of<'scorecard.released'>): Promise<void> {
    const p = event.payload;
    const people = await this.people([p.empId, ...(p.releasedBy ? [p.releasedBy] : [])]);
    const to = people.get(p.empId);
    if (!to) return;
    const by = p.releasedBy ? (people.get(p.releasedBy)?.fullName ?? p.releasedBy) : null;
    await this.deliver([{ to, mail: releasedMail({ name: to.fullName, month: monthLabel(p.month), releasedBy: by, link: this.link(p.scorecardId) }) }]);
  }

  /** 'scorecard.dispute_raised': mail the DECIDER (event.payload.decider): "<name> disputes the rating of <task number>", with the reason and the link to the scorecard. */
  async disputeRaised(event: Of<'scorecard.dispute_raised'>): Promise<void> {
    const p = event.payload;
    const people = await this.people([p.decider, p.empId]);
    const to = people.get(p.decider);
    if (!to) return;
    const dispute = await this.prisma.ratingDispute.findUnique({ where: { id: p.disputeId }, select: { reason: true } });
    const employee = people.get(p.empId)?.fullName ?? p.empId;
    await this.deliver([
      { to, mail: disputeRaisedMail({ name: to.fullName, employee, number: p.taskNumber, month: monthLabel(p.month), rating: p.ratingAtRaise, reason: dispute?.reason ?? null, link: this.link(p.scorecardId) }) },
    ]);
  }

  /** 'scorecard.dispute_decided': mail the EMPLOYEE (event.payload.empId): rating kept, or changed from X to Y and the scorecard was recomputed; with the decider's note and the link. */
  async disputeDecided(event: Of<'scorecard.dispute_decided'>): Promise<void> {
    const p = event.payload;
    const people = await this.people([p.empId, p.decidedBy]);
    const to = people.get(p.empId);
    if (!to) return;
    const dispute = await this.prisma.ratingDispute.findUnique({ where: { id: p.disputeId }, select: { decision: true } });
    const decidedBy = people.get(p.decidedBy)?.fullName ?? p.decidedBy;
    await this.deliver([
      {
        to,
        mail: disputeDecidedMail({
          name: to.fullName,
          decidedBy,
          number: p.taskNumber,
          month: monthLabel(p.month),
          decision: p.decision,
          ratingBefore: p.ratingBefore,
          ratingAfter: p.ratingAfter,
          note: dispute?.decision ?? null,
          link: this.link(p.scorecardId),
        }),
      },
    ]);
  }

  // ------------------------------------------------------------------------------------------------------- helpers

  private link(scorecardId: string): string {
    return `${this.env.APP_URL}/performance/scorecards/${scorecardId}`;
  }

  /** Names and addresses of people by Emp-ID. Unknown Emp-IDs are not in the map; people who left or have no address are filtered at sending. */
  private async people(empIds: string[]): Promise<Map<string, Person>> {
    const rows = await this.prisma.employee.findMany({ where: { empId: { in: [...new Set(empIds)] } }, select: { empId: true, fullName: true, officialEmail: true, status: true } });
    return new Map(rows.map((r) => [r.empId, { empId: r.empId, fullName: r.fullName, email: r.officialEmail, left: r.status === 'left' }]));
  }

  /** Sends every mail it can; people without an address or who left are skipped; throws after the last one if any failed. Returns how many were sent. */
  private async deliver(out: Outgoing[]): Promise<number> {
    const failures: string[] = [];
    let sent = 0;
    for (const { to, mail } of out) {
      if (to.left || !to.email) {
        this.logger.debug(`No mail to ${to.empId}: ${to.left ? 'has left' : 'no official address'}`);
        continue;
      }
      try {
        await this.mailer.send({ to: to.email, subject: mail.subject, text: mail.text, html: mail.html });
        sent++;
      } catch (error) {
        failures.push(`${to.empId}: ${(error as Error).message}`);
      }
    }
    if (failures.length) throw new Error(`Performance mail not sent (${failures.join('; ')})`);
    return sent;
  }
}
