import { Injectable, Logger, OnModuleInit } from '@nestjs/common';
import { pakistanDay, dayWindow } from '../activity/rules/activity-time';
import { Clock } from '../common/clock';
import { OutboxService } from '../events/outbox.service';
import { JobRunner } from '../jobs/job-runner.service';
import { PrismaService } from '../prisma/prisma.service';
import { isTooLate, reminderJobKey, reminderKindPrefix, resolveReminderRecipients } from './rules/auto-reminders';
import { REMINDER_KINDS, reminderSchedule, stillApplies, taskReminderKeyPrefix, TASK_REMINDER_JOB, type ReminderKind } from './rules/task-reminders';
import type { Db } from './task-data';

/** What a reminder job carries (scheduled_jobs.payload). The deadline it was armed for is checked again when it runs. */
export interface ReminderJobPayload {
  taskId: string;
  kind: ReminderKind;
  /** ISO time of the task's deadline when the job was armed. */
  deadline: string;
  /** ISO time the reminder was planned for (a job that runs far later than this is dropped, see rules/auto-reminders.ts). */
  at?: string;
}

/** A person above someone in the reporting line. */
export interface ManagerRef {
  id: string;
  empId: string;
  status: string;
  roleKey: string;
}

/** The managers above a person, nearest first (at most `hops` of them). Used by the mails and the hand-over as well. */
export async function managersAbove(db: Db, employeeId: string, hops = 10): Promise<ManagerRef[]> {
  const out: ManagerRef[] = [];
  let current = await db.employee.findUnique({ where: { id: employeeId }, select: { reportsToId: true } });
  for (let i = 0; i < hops && current?.reportsToId; i++) {
    const manager = await db.employee.findUnique({ where: { id: current.reportsToId }, select: { id: true, empId: true, status: true, reportsToId: true, role: { select: { key: true } } } });
    if (!manager) break;
    out.push({ id: manager.id, empId: manager.empId, status: manager.status, roleKey: manager.role.key });
    current = manager;
  }
  return out;
}

/** The nearest manager above a person who has not left, or null. */
export async function nearestActiveManager(db: Db, employeeId: string): Promise<ManagerRef | null> {
  return (await managersAbove(db, employeeId)).find((m) => m.status !== 'left') ?? null;
}

/**
 * Task reminders through the job runner (plan section 9): half the time passed and not started; 24 hours before the
 * deadline; at the deadline; then a daily overdue notice to the person doing the task, the person who assigned it and the
 * person's manager. The timing and applicability rules are pure (rules/task-reminders.ts, rules/auto-reminders.ts).
 *
 * One job per task and kind (dedupe key reminderJobKey; the daily overdue notice is one job per day because the job runner
 * marks a job finished when its handler returns, which would wipe a handler's re-arm of its own row). The jobs follow the
 * task: sync() re-arms them from the task's CURRENT state whenever it is created, changes status or gets a new deadline,
 * and deletes the pending ones when the task is put on hold, handed in, approved, cancelled or is a personal to-do. The
 * handler checks again when it runs (stillApplies), so a job that slipped through never sends a wrong mail.
 *
 * It does not send mail: a due reminder is written as the outbox event task.reminder.due (once per task, kind and
 * Pakistan day) and TaskMail mails it through the "tasks.mail" consumer.
 */
@Injectable()
export class TaskReminders implements OnModuleInit {
  private readonly logger = new Logger('TaskReminders');

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobRunner,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.jobs.register(TASK_REMINDER_JOB, (payload) => this.handle(payload as unknown as ReminderJobPayload));
  }

  /**
   * Makes the armed reminders of ONE task match its current state. Idempotent: calling it twice changes nothing. Reminders
   * whose time has passed are not back-filled; kinds that do not apply any more lose their pending jobs.
   */
  async sync(taskId: string): Promise<void> {
    const task = await this.prisma.task.findUnique({ where: { id: taskId }, select: { status: true, personal: true, startDate: true, deadline: true, startedAt: true } });
    if (!task) return;
    const schedule = reminderSchedule(task, this.clock.now());
    const wanted = new Set(schedule.map((s) => s.kind));

    for (const { kind, at } of schedule) {
      const key = reminderJobKey(taskId, kind, at);
      const payload: ReminderJobPayload = { taskId, kind, deadline: task.deadline.toISOString(), at: at.toISOString() };
      await this.jobs.schedule(TASK_REMINDER_JOB, key, at, payload as unknown as Record<string, unknown>, null);
      // An overdue notice of another day (an old deadline) is stale now.
      if (kind === 'overdue') await this.prisma.scheduledJob.deleteMany({ where: { dedupeKey: { startsWith: reminderKindPrefix(taskId, kind), not: key }, status: 'pending' } });
    }
    for (const kind of REMINDER_KINDS) {
      if (!wanted.has(kind)) await this.prisma.scheduledJob.deleteMany({ where: { dedupeKey: { startsWith: reminderKindPrefix(taskId, kind) }, status: 'pending' } });
    }
  }

  /** Deletes every pending reminder job of the task (the task is closed). */
  async cancelAll(taskId: string): Promise<void> {
    await this.prisma.scheduledJob.deleteMany({ where: { dedupeKey: { startsWith: taskReminderKeyPrefix(taskId) }, status: 'pending' } });
  }

  /**
   * The job handler. A reminder that no longer applies (status changed, deadline moved) or that runs far too late (the
   * server was down) sends nothing. The daily overdue notice then arms the next day's, so it continues until the task is
   * handed in, approved, cancelled or put on hold (sync() removes it then). Throwing makes the job runner retry.
   */
  async handle(payload: ReminderJobPayload): Promise<void> {
    const task = await this.prisma.task.findUnique({
      where: { id: payload.taskId },
      select: {
        id: true,
        number: true,
        status: true,
        personal: true,
        startDate: true,
        deadline: true,
        startedAt: true,
        assigneeId: true,
        assignee: { select: { empId: true, status: true } },
        assignedBy: { select: { empId: true, status: true } },
      },
    });
    if (!task) return;
    const now = this.clock.now();
    const planned = payload.at ? new Date(payload.at) : null;
    if (stillApplies(payload.kind, task, new Date(payload.deadline), now)) {
      if (planned && isTooLate(payload.kind, planned, now)) {
        this.logger.warn(`Reminder ${payload.kind} for ${task.number} was due at ${payload.at} and is dropped (it ran too late)`);
      } else {
        await this.emitDue(task, payload.kind, now);
      }
    }
    if (payload.kind === 'overdue') await this.sync(task.id);
  }

  /** Writes task.reminder.due once per task, kind and Pakistan day (a retried job, or a deadline moved within the day, never writes a second). */
  private async emitDue(
    task: { id: string; number: string; deadline: Date; assigneeId: string; assignee: { empId: string; status: string }; assignedBy: { empId: string; status: string } },
    kind: ReminderKind,
    now: Date,
  ): Promise<void> {
    const manager = kind === 'overdue' ? await nearestActiveManager(this.prisma, task.assigneeId) : null;
    const recipients = resolveReminderRecipients(
      kind,
      { empId: task.assignee.empId, left: task.assignee.status === 'left' },
      { empId: task.assignedBy.empId, left: task.assignedBy.status === 'left' },
      manager ? { empId: manager.empId, left: false } : null,
    );
    if (!recipients.length) return;
    const day = pakistanDay(now);
    const lock = `${TASK_REMINDER_JOB}:${task.id}:${kind}:${day}`;
    const since = dayWindow(day).start;
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lock}::text))`;
      const already = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT id::text AS id FROM outbox_events
        WHERE type = 'task.reminder.due' AND occurred_at >= ${since}::timestamptz
          AND payload->>'taskId' = ${task.id} AND payload->>'kind' = ${kind} AND payload->>'day' = ${day}
        LIMIT 1`;
      if (already.length) return;
      await this.outbox.emit(
        { type: 'task.reminder.due', actor: 'system', payload: { taskId: task.id, number: task.number, kind, recipients, deadline: task.deadline.toISOString(), day } },
        tx,
      );
    });
  }
}
