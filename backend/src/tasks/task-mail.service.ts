import { Inject, Injectable, Logger } from '@nestjs/common';
import type { OutboxEvent } from '@aceva/contracts';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { Mailer } from '../mail/mailer';
import { PrismaService } from '../prisma/prisma.service';
import {
  assignedMail,
  extensionDecidedMail,
  extensionRequestedMail,
  handoverClosedMail,
  handoverMail,
  mentionMail,
  reminderMail,
  reviewWaitingMail,
  statusMail,
  type HandoverMailTask,
  type MailText,
} from './rules/auto-mail';
import { nearestActiveManager } from './task-reminders.service';

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
 * The task mails, through the existing Mailer (Mailpit in development). Short plain-text mails with an HTML twin, never a
 * secret or a pay figure. Addresses and names are looked up from the Emp-IDs in the event (employees.official_email); a
 * person without an address, or who left, is skipped. A mail that cannot be sent makes the handler throw once every other
 * recipient was tried, so the outbox dispatcher retries later (a retry can send a mail twice: accepted). The words are in
 * rules/auto-mail.ts; the link is `${APP_URL}/tasks/<task id>`.
 */
@Injectable()
export class TaskMail {
  private readonly logger = new Logger('TaskMail');

  constructor(
    private readonly prisma: PrismaService,
    private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  /** "<assigner> assigned you <number> <title>, size, deadline". Not for personal to-dos, and not to the person who made it. */
  async assigned(event: Of<'task.created'>): Promise<void> {
    const p = event.payload;
    if (p.personal || p.assignee === p.assignedBy || p.assignee === event.actor) return;
    const task = await this.task(p.taskId);
    if (!task) return;
    const people = await this.people([p.assignee, p.assignedBy]);
    const to = people.get(p.assignee);
    if (!to) return;
    const assigner = people.get(p.assignedBy)?.fullName ?? p.assignedBy;
    await this.deliver([
      { to, mail: assignedMail({ name: to.fullName, assigner, number: task.number, title: task.title, size: task.size, priority: task.priority, deadline: task.deadline, repeating: p.repeatRuleId !== null, link: this.link(p.taskId) }) },
    ]);
  }

  /**
   * A reminder (event.payload.kind): half time and not started / due in 24 hours / due now / overdue (daily). One mail per
   * recipient in event.payload.recipients; the manager's copy of an overdue notice names the person who is late.
   */
  async reminder(event: Of<'task.reminder.due'>): Promise<void> {
    const p = event.payload;
    const task = await this.task(p.taskId);
    if (!task) return;
    const people = await this.people([...p.recipients, task.assignee.empId]);
    const assigneeName = people.get(task.assignee.empId)?.fullName ?? task.assignee.empId;
    const out: Outgoing[] = [];
    for (const empId of p.recipients) {
      const to = people.get(empId);
      if (!to) continue;
      out.push({ to, mail: reminderMail({ kind: p.kind, name: to.fullName, assigneeName, forAssignee: empId === task.assignee.empId, number: task.number, title: task.title, deadline: new Date(p.deadline), link: this.link(p.taskId) }) });
    }
    await this.deliver(out);
  }

  /** "<author> mentioned you on <number>": one mail per mentioned person (not the author), with the comment text (first 300 characters). */
  async mentions(event: Of<'task.comment_added'>): Promise<void> {
    const p = event.payload;
    if (!p.mentions.length) return;
    const comment = await this.prisma.taskComment.findUnique({ where: { id: p.commentId }, select: { body: true, author: { select: { empId: true, fullName: true } } } });
    const task = await this.task(p.taskId);
    if (!comment || !task) return;
    const people = await this.people(p.mentions);
    const out: Outgoing[] = [];
    for (const empId of p.mentions) {
      const to = people.get(empId);
      if (!to || empId === comment.author.empId) continue;
      out.push({ to, mail: mentionMail({ name: to.fullName, author: comment.author.fullName, number: task.number, title: task.title, comment: comment.body, link: this.link(p.taskId) }) });
    }
    await this.deliver(out);
  }

  /**
   * Status mails worth sending: handed in -> the reviewer (the assigner; a stand-in sees it in the approvals inbox, and
   * when the assigner left, the assignee's nearest manager); approved (with the rating), sent to rework, put on hold or
   * cancelled -> the person doing the task. Never to the person who did it themselves, never for a personal to-do.
   */
  async statusChanged(event: Of<'task.status_changed'>): Promise<void> {
    const p = event.payload;
    if (p.personal) return;
    const task = await this.task(p.taskId);
    if (!task) return;
    const people = await this.people([p.assignee, p.assignedBy, ...(event.actor === 'system' ? [] : [event.actor])]);
    const by = event.actor === 'system' ? 'The system' : (people.get(event.actor)?.fullName ?? event.actor);
    const link = this.link(p.taskId);

    if (p.to === 'submitted') {
      let reviewer = people.get(p.assignedBy);
      if (!reviewer || reviewer.left) {
        const manager = await nearestActiveManager(this.prisma, task.assigneeId);
        reviewer = manager ? (await this.people([manager.empId])).get(manager.empId) : undefined;
      }
      const assignee = people.get(p.assignee)?.fullName ?? p.assignee;
      if (reviewer && reviewer.empId !== event.actor) await this.deliver([{ to: reviewer, mail: reviewWaitingMail({ name: reviewer.fullName, assignee, number: task.number, title: task.title, link }) }]);
      return;
    }

    if (p.to !== 'approved' && p.to !== 'rework' && p.to !== 'on_hold' && p.to !== 'cancelled') return;
    const to = people.get(p.assignee);
    if (!to || to.empId === event.actor) return;
    let rating: number | null = null;
    let reason = p.reason;
    if (p.to === 'approved') {
      const review = await this.prisma.taskReview.findFirst({ where: { taskId: p.taskId, decision: 'approved' }, orderBy: { createdAt: 'desc' }, select: { rating: true, comment: true } });
      rating = review?.rating ?? null;
      reason = review?.comment ?? p.reason;
    } else if (p.to === 'rework' && !reason) {
      const review = await this.prisma.taskReview.findFirst({ where: { taskId: p.taskId, decision: 'rework' }, orderBy: { createdAt: 'desc' }, select: { reason: true } });
      reason = review?.reason ?? null;
    }
    await this.deliver([{ to, mail: statusMail({ name: to.fullName, by, number: task.number, title: task.title, to: p.to, rating, reason, link }) }]);
  }

  /** Extension requested -> the assigner; extension decided -> the person who asked (with the new deadline or the reason). */
  async extension(event: Of<'task.extension_requested'> | Of<'task.extension_decided'>): Promise<void> {
    const p = event.payload;
    const task = await this.task(p.taskId);
    const extension = await this.prisma.taskExtension.findUnique({ where: { id: p.extensionId }, select: { reason: true, decisionReason: true } });
    if (!task || !extension) return;
    const link = this.link(p.taskId);

    if (event.type === 'task.extension_requested') {
      const q = event.payload;
      const people = await this.people([q.assignee, q.assignedBy]);
      const to = people.get(q.assignedBy);
      if (!to) return;
      const requester = people.get(q.assignee)?.fullName ?? q.assignee;
      await this.deliver([
        { to, mail: extensionRequestedMail({ name: to.fullName, requester, number: task.number, title: task.title, currentDeadline: new Date(q.currentDeadline), requestedDeadline: new Date(q.requestedDeadline), reason: extension.reason, late: q.late, link }) },
      ]);
      return;
    }

    const d = event.payload;
    const people = await this.people([d.requestedBy, d.decidedBy]);
    const to = people.get(d.requestedBy);
    if (!to) return;
    const decider = people.get(d.decidedBy)?.fullName ?? d.decidedBy;
    await this.deliver([
      { to, mail: extensionDecidedMail({ name: to.fullName, decider, number: task.number, title: task.title, approved: d.decision === 'approved', newDeadline: d.newDeadline ? new Date(d.newDeadline) : null, reason: extension.decisionReason, link }) },
    ]);
  }

  /**
   * After a leaver's work was handed over: one mail to the person who took over (what moved, what was closed and why, what
   * stays until it is reviewed, the repeating tasks), and one to every other person who assigned a task that was closed.
   */
  async handover(i: { leaver: string; newOwner: string; moved: HandoverMailTask[]; closed: Array<HandoverMailTask & { assignedBy: string }>; kept: HandoverMailTask[]; seriesMoved: number; seriesStopped: number }): Promise<void> {
    const others = [...new Set(i.closed.map((c) => c.assignedBy).filter((empId) => empId !== i.newOwner))];
    const people = await this.people([i.leaver, i.newOwner, ...others]);
    const leaver = people.get(i.leaver)?.fullName ?? i.leaver;
    const owner = people.get(i.newOwner);
    const link = `${this.env.APP_URL}/tasks`;
    const out: Outgoing[] = [];
    if (owner) out.push({ to: owner, mail: handoverMail({ name: owner.fullName, leaver, moved: i.moved, closed: i.closed, kept: i.kept, seriesMoved: i.seriesMoved, seriesStopped: i.seriesStopped, link }) });
    for (const empId of others) {
      const to = people.get(empId);
      if (to) out.push({ to, mail: handoverClosedMail({ name: to.fullName, leaver, newOwner: owner?.fullName ?? i.newOwner, closed: i.closed.filter((c) => c.assignedBy === empId), link }) });
    }
    await this.deliver(out);
  }

  // ------------------------------------------------------------------------------------------------------- helpers

  private link(taskId: string): string {
    return `${this.env.APP_URL}/tasks/${taskId}`;
  }

  private task(taskId: string) {
    return this.prisma.task.findUnique({
      where: { id: taskId },
      select: { number: true, title: true, size: true, priority: true, deadline: true, assigneeId: true, assignee: { select: { empId: true } } },
    });
  }

  /** Names and addresses of people by Emp-ID. Unknown Emp-IDs are not in the map; people who left or have no address are filtered at sending. */
  private async people(empIds: string[]): Promise<Map<string, Person>> {
    const rows = await this.prisma.employee.findMany({ where: { empId: { in: [...new Set(empIds)] } }, select: { empId: true, fullName: true, officialEmail: true, status: true } });
    return new Map(rows.map((r) => [r.empId, { empId: r.empId, fullName: r.fullName, email: r.officialEmail, left: r.status === 'left' }]));
  }

  /** Sends every mail it can; people without an address or who left are skipped; throws after the last one if any failed. */
  private async deliver(out: Outgoing[]): Promise<void> {
    const failures: string[] = [];
    for (const { to, mail } of out) {
      if (to.left || !to.email) {
        this.logger.debug(`No mail to ${to.empId}: ${to.left ? 'has left' : 'no official address'}`);
        continue;
      }
      try {
        await this.mailer.send({ to: to.email, subject: mail.subject, text: mail.text, html: mail.html });
      } catch (error) {
        failures.push(`${to.empId}: ${(error as Error).message}`);
      }
    }
    if (failures.length) throw new Error(`Task mail not sent (${failures.join('; ')})`);
  }
}
