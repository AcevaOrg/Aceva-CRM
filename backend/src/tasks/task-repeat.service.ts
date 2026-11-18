import { Inject, Injectable, Logger, OnApplicationBootstrap, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { AuditService } from '../access/audit.service';
import { PermissionService } from '../access/permission.service';
import { ScopeService } from '../access/scope.service';
import { pakistanDay } from '../activity/rules/activity-time';
import { Clock } from '../common/clock';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { OutboxService } from '../events/outbox.service';
import { JobRunner } from '../jobs/job-runner.service';
import { PrismaService } from '../prisma/prisma.service';
import { repeatJobKey, repeatKeyPrefix } from './rules/auto-reminders';
import { dueOccurrences, nextOccurrence, occurrenceWindow, occurrenceRunAt, type RepeatRule } from './rules/task-repeat';
import { TASK_REMINDER_JOB, TASK_REPEAT_JOB } from './rules/task-reminders';
import { addTaskHistory, createdPayload, nextTaskNumber, TASK_INCLUDE, type Db } from './task-data';

/** What a repeat job carries. */
export interface RepeatJobPayload {
  ruleId: string;
}

/** On start-up and every hour the server makes sure every active series has its job (catches up after downtime). */
const ENSURE_EVERY_MS = 3_600_000;
/** At most this many tasks are made in one run after downtime (the newest ones). */
const CATCH_UP_LIMIT = 3;
/** A reminder or repeat job that finished is kept this long (for the support log), then removed. */
const KEEP_FINISHED_JOBS_DAYS = 14;

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

interface RuleDates {
  every: 'week' | 'month';
  on: number;
  until: Date | null;
  lastOccurrenceOn: Date | null;
  createdAt: Date;
}

const toRule = (r: RuleDates): RepeatRule => ({ every: r.every, on: r.on, until: r.until ? dayOf(r.until) : null });
/** The day the series stands at: the last day a task was made for (the creation day when the core never set it). */
const lastDayOf = (r: RuleDates): string => (r.lastOccurrenceOn ? dayOf(r.lastOccurrenceOn) : pakistanDay(r.createdAt));

/**
 * Repeating tasks (plan section 9: "a weekly report every Monday") through the job runner. The date maths is pure
 * (rules/task-repeat.ts). A task_repeat_rules row holds the template, the day it stands at (lastOccurrenceOn), the stop
 * date (until) and active. One job per series and occurrence day (key repeatJobKey: the job runner marks a job finished when
 * its handler returns, so a handler cannot re-arm its own row) runs at 00:05 Pakistan time on that day, makes the task and
 * arms the next one. A series ends at its stop date, when someone stops it (active = false), or when the person doing it
 * or the person who set it up has left, or when the person who set it up can no longer assign it (he lost task.assign, or
 * the person doing it is no longer in his reporting line). Each task of a series carries repeat_rule_id and occurrence_on, unique together, so
 * a retried job can never make the same day twice.
 */
@Injectable()
export class TaskRepeat implements OnModuleInit, OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger('TaskRepeat');
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobRunner,
    private readonly outbox: OutboxService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
    private readonly permissions: PermissionService,
    private readonly scope: ScopeService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  onModuleInit(): void {
    this.jobs.register(TASK_REPEAT_JOB, (payload) => this.handle(payload as unknown as RepeatJobPayload));
  }

  /**
   * Catches up after downtime: arms every active series that has no pending job, now and then every hour. Does nothing
   * when background work is switched off (OUTBOX_DISPATCH_INTERVAL_MS=0, as the tests do). Never throws.
   */
  onApplicationBootstrap(): void {
    if (this.env.OUTBOX_DISPATCH_INTERVAL_MS <= 0) return;
    const ensure = () => this.ensureArmed().catch((error) => this.logger.error(`Could not arm the repeating tasks: ${(error as Error).message}`));
    void ensure();
    this.timer = setInterval(() => void ensure(), ENSURE_EVERY_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  /**
   * Arms the job of one series for its next occurrence (re-arms the same day's job), or removes its pending job when the
   * series is inactive or finished. Returns true when a job is armed.
   */
  async arm(ruleId: string): Promise<boolean> {
    const rule = await this.prisma.taskRepeatRule.findUnique({ where: { id: ruleId }, select: { id: true, every: true, on: true, until: true, active: true, lastOccurrenceOn: true, createdAt: true } });
    if (!rule) return false;
    const next = rule.active ? nextOccurrence(toRule(rule), lastDayOf(rule)) : null;
    if (!next) {
      await this.prisma.scheduledJob.deleteMany({ where: { dedupeKey: { startsWith: repeatKeyPrefix(ruleId) }, status: 'pending' } });
      return false;
    }
    const key = repeatJobKey(ruleId, next);
    const payload: RepeatJobPayload = { ruleId };
    await this.jobs.schedule(TASK_REPEAT_JOB, key, occurrenceRunAt(next), payload as unknown as Record<string, unknown>, null);
    await this.prisma.scheduledJob.deleteMany({ where: { dedupeKey: { startsWith: repeatKeyPrefix(ruleId), not: key }, status: 'pending' } });
    return true;
  }

  /**
   * Arms every active series that has no pending job. Returns how many it armed. Also removes the reminder and repeat jobs
   * that finished more than two weeks ago: every overdue task adds one job a day and a finished job is never read again.
   */
  async ensureArmed(): Promise<number> {
    const before = new Date(this.clock.now().getTime() - KEEP_FINISHED_JOBS_DAYS * 86_400_000);
    await this.prisma.scheduledJob.deleteMany({ where: { type: { in: [TASK_REMINDER_JOB, TASK_REPEAT_JOB] }, status: 'succeeded', completedAt: { lt: before } } });
    const rules = await this.prisma.taskRepeatRule.findMany({ where: { active: true }, select: { id: true } });
    if (!rules.length) return 0;
    const pending = await this.prisma.scheduledJob.findMany({ where: { type: TASK_REPEAT_JOB, status: 'pending' }, select: { payload: true } });
    const armed = new Set(pending.map((j) => String((j.payload as { ruleId?: string } | null)?.ruleId)));
    let count = 0;
    for (const { id } of rules) if (!armed.has(id) && (await this.arm(id))) count++;
    return count;
  }

  /**
   * The job handler. Makes the tasks that are due (the newest three at most after downtime), one transaction per day, then
   * arms the next occurrence. Before it makes anything it checks the series again (whyStopped): a series that no longer
   * follows the assigning rules makes no more tasks and is stopped.
   */
  async handle(payload: RepeatJobPayload): Promise<void> {
    const rule = await this.prisma.taskRepeatRule.findUnique({ where: { id: payload.ruleId } });
    if (!rule || !rule.active) return;
    const reason = await this.whyStopped(rule);
    if (reason) {
      this.logger.warn(`Repeating task "${rule.title}" (${rule.id}) is stopped: ${reason}`);
      await this.prisma.$transaction((tx) => this.stopSeries(tx, rule.id, `The series was stopped because ${reason}`, null));
      await this.arm(rule.id);
      return;
    }
    const today = pakistanDay(this.clock.now());
    for (const day of dueOccurrences(toRule(rule), lastDayOf(rule), today, CATCH_UP_LIMIT)) await this.makeTask(rule.id, day);
    await this.arm(rule.id);
  }

  /**
   * Why this series may not make another task, or null when it may. The rules that were checked when the series was set up
   * hold on every run, because the organisation can change in between: the person doing it left, the person who set it up
   * left or lost task.assign (his role changed), or the person doing it is no longer below him (a new reporting line).
   * Otherwise the old assigner would keep assigning to someone outside his line, or nobody could hold or cancel the tasks.
   */
  private async whyStopped(rule: { assigneeId: string; assignedById: string }): Promise<string | null> {
    const people = await this.prisma.employee.findMany({ where: { id: { in: [rule.assigneeId, rule.assignedById] } }, select: { id: true, status: true } });
    const left = (id: string): boolean => people.find((e) => e.id === id)?.status === 'left';
    if (left(rule.assigneeId)) return 'the person doing it left';
    if (left(rule.assignedById)) return 'the person who set it up left';
    if (!(await this.permissions.can(rule.assignedById, 'task.assign'))) return 'the person who set it up can no longer assign tasks';
    if (!(await this.scope.canAccess(rule.assignedById, rule.assigneeId, 'below'))) return 'the person doing it is no longer in the reporting line of the person who set it up';
    return null;
  }

  /**
   * Ends a series: active = false, stopped_at, and a "repeat_stopped" line in the history of its latest task. Safe to call
   * twice (the second call changes nothing). `stoppedBy` is an internal employee id, or null for the system.
   */
  async stopSeries(tx: Db, ruleId: string, reason: string, stoppedBy: string | null): Promise<boolean> {
    const { count } = await tx.taskRepeatRule.updateMany({ where: { id: ruleId, active: true }, data: { active: false, stoppedAt: this.clock.now(), stoppedBy, updatedBy: stoppedBy } });
    if (!count) return false;
    const latest = await tx.task.findFirst({ where: { repeatRuleId: ruleId }, orderBy: { occurrenceOn: 'desc' }, select: { id: true, number: true, status: true } });
    if (latest) {
      await addTaskHistory(tx, { taskId: latest.id, kind: 'repeat_stopped', from: latest.status, to: latest.status, byId: stoppedBy, reason, details: { repeatRuleId: ruleId }, at: this.clock.now() });
    }
    await this.audit.record({ actorId: stoppedBy, action: 'task.repeat.stopped', targetType: 'task', targetId: latest?.number ?? ruleId, reason, details: { repeatRuleId: ruleId } }, tx);
    return true;
  }

  /** Makes the task of one occurrence day, advances the series and writes the created event, all in one transaction. */
  private async makeTask(ruleId: string, day: string): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT 1 FROM task_repeat_rules WHERE id = ${ruleId}::uuid FOR UPDATE`;
      const rule = await tx.taskRepeatRule.findUnique({ where: { id: ruleId } });
      if (!rule || !rule.active) return;
      if (rule.lastOccurrenceOn && dayOf(rule.lastOccurrenceOn) >= day) return; // another run already made it
      const occurrenceOn = new Date(`${day}T00:00:00.000Z`);

      const exists = await tx.task.findFirst({ where: { repeatRuleId: ruleId, occurrenceOn }, select: { id: true } });
      if (!exists) {
        const size = rule.personal ? null : await tx.taskSizeSetting.findUnique({ where: { size: rule.size }, select: { points: true } });
        const { start, deadline } = occurrenceWindow(day, { startTime: rule.startTime, durationMinutes: rule.durationMinutes });
        const texts = (Array.isArray(rule.checklist) ? rule.checklist : []).filter((t): t is string => typeof t === 'string' && t.trim().length > 0);
        const created = await tx.task.create({
          data: {
            number: await nextTaskNumber(tx, rule.personal),
            title: rule.title,
            description: rule.description,
            assigneeId: rule.assigneeId,
            assignedById: rule.assignedById,
            projectId: rule.projectId,
            priority: rule.priority,
            size: rule.size,
            points: size?.points ?? 0,
            estimatedHours: rule.estimatedHours,
            startDate: start,
            deadline,
            originalDeadline: deadline,
            personal: rule.personal,
            repeatRuleId: rule.id,
            occurrenceOn,
            checklist: { create: texts.map((text, position) => ({ text, position })) },
          },
          select: { id: true, number: true },
        });
        await addTaskHistory(tx, { taskId: created.id, kind: 'created', from: null, to: 'assigned', byId: null, details: { repeatRuleId: rule.id, occurrenceOn: day }, at: this.clock.now() });
        await this.audit.record({ actorId: null, action: 'task.created', targetType: 'task', targetId: created.number, details: { repeatRuleId: rule.id, occurrenceOn: day } }, tx);
        const row = await tx.task.findUniqueOrThrow({ where: { id: created.id }, include: TASK_INCLUDE });
        await this.outbox.emit({ type: 'task.created', actor: 'system', payload: createdPayload(row) }, tx);
      }
      await tx.taskRepeatRule.update({ where: { id: ruleId }, data: { lastOccurrenceOn: occurrenceOn } });
    });
  }
}
