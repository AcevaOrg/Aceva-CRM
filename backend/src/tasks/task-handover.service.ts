import { Injectable, Logger } from '@nestjs/common';
import { AuditService } from '../access/audit.service';
import { ScopeService } from '../access/scope.service';
import { Clock } from '../common/clock';
import { OutboxService } from '../events/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { HANDOVER_MOVED_REASON, handoverOutcome, pickHandoverTarget, seriesHandoverOutcome, type HandoverFit, type HandoverTarget } from './rules/auto-handover';
import type { HandoverMailTask } from './rules/auto-mail';
import { OPEN_STATUSES } from './rules/task-status';
import { addTaskHistory, statusChangedPayload, TASK_INCLUDE } from './task-data';
import { TaskMail } from './task-mail.service';
import { managersAbove, TaskReminders } from './task-reminders.service';
import { TaskRepeat } from './task-repeat.service';
import { TaskWorkflowService } from './task-workflow.service';

export interface HandoverCounts {
  /** Open work tasks that now belong to the manager. */
  moved: number;
  /** Open work tasks closed because the manager could not take them (he assigned them himself, is not below the assigner, or is view-only). */
  cancelled: number;
  /** Repeating series that now belong to the manager. */
  repeatRules: number;
  /** Repeating series that stopped because the manager could not take them. */
  repeatRulesStopped: number;
}

interface Person {
  id: string;
  empId: string;
  status: string;
  roleKey: string;
}

const ZERO: HandoverCounts = { moved: 0, cancelled: 0, repeatRules: 0, repeatRulesStopped: 0 };

/** What happened to one task, for the mail to the new owner. */
interface HandedTask extends HandoverMailTask {
  /** Emp-ID of the person who assigned it. */
  assignedBy: string;
}
type HandOneResult = { result: 'moved' | 'cancelled' | 'kept'; task: HandedTask } | null;

/**
 * Leaver hand-over (plan section 7: "open tasks move to the manager"). Module 3's OffboardingService writes the outbox
 * event task.transfer.requested { fromEmpId, toEmpId, reason: "employee_left" } when the last working day is processed; the
 * "tasks.handover" consumer calls transfer() for it.
 */
@Injectable()
export class TaskHandover {
  private readonly logger = new Logger('TaskHandover');

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly reminders: TaskReminders,
    private readonly repeat: TaskRepeat,
    private readonly clock: Clock,
    private readonly scope: ScopeService,
    private readonly workflow: TaskWorkflowService,
    private readonly mail: TaskMail,
  ) {}

  /**
   * Moves the leaver's OPEN work tasks (everything but approved and cancelled; personal to-dos stay with their owner) and
   * active repeating series to the manager. Idempotent: a task is only touched while it still belongs to the leaver, in
   * the same conditional update that moves it, so the same event delivered twice moves nothing twice and writes no second
   * history line, event or audit entry. Per task, in one transaction: the owner changes, a history line (kind
   * "transferred", reason "Employee left", details { fromEmpId, toEmpId }) and the event task.transferred. A task the
   * manager could not take is closed with a history line and the event task.status_changed (see rules/auto-handover.ts: he
   * assigned it himself, he is not below the person who assigned it, or nobody could ever review it for him; somebody who is
   * only away today still counts as a reviewer); finished work
   * waiting for its reviewer is left as it is. A pending extension request is left as it is; it can no longer be decided
   * once the task is closed (M5 decision 8, open question 2). One audit entry "task.handover" (actor null) with the counts. When something changed, the new owner gets
   * one mail listing it, and so does anybody else whose assigned task was closed (a mail that fails is only logged).
   */
  async transfer(fromEmpId: string, toEmpId: string, eventId: string): Promise<HandoverCounts> {
    const from = await this.person(fromEmpId);
    const named = await this.person(toEmpId);
    if (!from || !named) {
      this.logger.warn(`Hand-over ${fromEmpId} -> ${toEmpId}: an employee does not exist, nothing was moved`);
      return { ...ZERO };
    }
    const target = await this.takeOver(named);
    if (!target || target.id === from.id) {
      this.logger.warn(`Hand-over ${fromEmpId} -> ${toEmpId}: nobody above is available to take over, nothing was moved`);
      return { ...ZERO };
    }

    const counts: HandoverCounts = { ...ZERO };
    const changed: string[] = [];
    const moved: HandedTask[] = [];
    const closed: HandedTask[] = [];
    const kept: HandedTask[] = [];
    const fits = new Map<string, HandoverFit>();
    const fitOf = async (assignedById: string): Promise<HandoverFit> => {
      if (!fits.has(assignedById)) fits.set(assignedById, await this.fitFor(assignedById, target));
      return fits.get(assignedById) as HandoverFit;
    };

    const open = await this.prisma.task.findMany({
      where: { assigneeId: from.id, personal: false, status: { in: [...OPEN_STATUSES] } },
      select: { id: true, assignedById: true },
      orderBy: { createdAt: 'asc' },
    });
    for (const { id, assignedById } of open) {
      const done = await this.handOne(id, from, target, await fitOf(assignedById));
      if (!done) continue;
      if (done.result === 'moved') {
        counts.moved++;
        moved.push(done.task);
        changed.push(id);
      } else if (done.result === 'cancelled') {
        counts.cancelled++;
        closed.push(done.task);
        changed.push(id);
      } else {
        kept.push(done.task);
      }
    }

    const rules = await this.prisma.taskRepeatRule.findMany({ where: { assigneeId: from.id, active: true, personal: false }, select: { id: true, assignedById: true } });
    for (const rule of rules) {
      const result = await this.handSeries(rule, from, target, await fitOf(rule.assignedById));
      if (result === 'moved') counts.repeatRules++;
      if (result === 'stopped') counts.repeatRulesStopped++;
      await this.repeat.arm(rule.id).catch((error) => this.logger.warn(`Could not re-arm series ${rule.id}: ${(error as Error).message}`));
    }

    // The reminders follow the task (they find the new owner when they run); closed tasks lose theirs. Also done by the
    // reminder consumer from the events above, so a failure here is only logged.
    for (const id of changed) await this.reminders.sync(id).catch((error) => this.logger.warn(`Could not re-arm the reminders of ${id}: ${(error as Error).message}`));

    if (counts.moved + counts.cancelled + counts.repeatRules + counts.repeatRulesStopped > 0) {
      await this.audit.record({
        actorId: null,
        action: 'task.handover',
        targetType: 'employee',
        targetId: fromEmpId,
        reason: 'employee_left',
        details: { toEmpId: target.empId, eventId, ...counts },
      });
      // Only when something changed in this run, so the same event delivered twice mails once.
      await this.mail
        .handover({ leaver: from.empId, newOwner: target.empId, moved, closed, kept, seriesMoved: counts.repeatRules, seriesStopped: counts.repeatRulesStopped })
        .catch((error) => this.logger.warn(`Could not mail the hand-over of ${from.empId}: ${(error as Error).message}`));
    }
    return counts;
  }

  private async person(empId: string): Promise<Person | null> {
    const row = await this.prisma.employee.findUnique({ where: { empId }, select: { id: true, empId: true, status: true, role: { select: { key: true } } } });
    return row ? { id: row.id, empId: row.empId, status: row.status, roleKey: row.role.key } : null;
  }

  /** The manager named in the event, or the nearest manager above them who has not left (the event can be old). */
  private async takeOver(named: Person): Promise<Person | null> {
    if (named.status !== 'left') return named;
    return pickHandoverTarget(named, await managersAbove(this.prisma, named.id));
  }

  /**
   * What the server knows about the new owner and the person who assigned the work, for rules/auto-handover.ts: is the new
   * owner strictly below the assigner, and could anybody ever review the work for him. The second question is only about
   * the lasting seats (the assigner, or whoever is above him when he left or can no longer review), never about who is away
   * today: a hand-over cannot be undone and an absence ends, so an absent assigner must not close the work.
   */
  private async fitFor(assignedById: string, target: Person): Promise<HandoverFit> {
    const belowAssigner = assignedById !== target.id && (await this.scope.canAccess(assignedById, target.id, 'below'));
    const hasReviewer = belowAssigner ? (await this.workflow.standingReviewerIfDoneBy(target, assignedById)) !== null : true;
    return { belowAssigner, hasReviewer };
  }

  private async handOne(taskId: string, from: Person, target: HandoverTarget & Person, fit: HandoverFit): Promise<HandOneResult> {
    return this.prisma.$transaction(async (tx): Promise<HandOneResult> => {
      const row = await tx.task.findUnique({ where: { id: taskId }, include: TASK_INCLUDE });
      if (!row || row.assigneeId !== from.id || row.personal || !OPEN_STATUSES.includes(row.status)) return null;
      const decision = handoverOutcome({ assignedById: row.assignedById, status: row.status }, target, fit);
      const task: HandedTask = { number: row.number, title: row.title, assignedBy: row.assignedBy.empId };
      if (decision.outcome === 'keep') return { result: 'kept', task };
      const details = { fromEmpId: from.empId, toEmpId: target.empId };

      if (decision.outcome === 'move') {
        const { count } = await tx.task.updateMany({ where: { id: taskId, assigneeId: from.id, status: row.status }, data: { assigneeId: target.id, updatedBy: null } });
        if (!count) return null;
        await addTaskHistory(tx, { taskId, kind: 'transferred', from: row.status, to: row.status, byId: null, reason: HANDOVER_MOVED_REASON, details, at: this.clock.now() });
        await this.outbox.emit({ type: 'task.transferred', actor: 'system', payload: { taskId, number: row.number, fromEmpId: from.empId, toEmpId: target.empId, reason: 'employee_left' } }, tx);
        return { result: 'moved', task };
      }

      const { count } = await tx.task.updateMany({ where: { id: taskId, assigneeId: from.id, status: row.status }, data: { status: 'cancelled', closedAt: this.clock.now(), updatedBy: null } });
      if (!count) return null;
      await addTaskHistory(tx, { taskId, kind: 'status', from: row.status, to: 'cancelled', byId: null, reason: decision.reason, details, at: this.clock.now() });
      const fresh = await tx.task.findUniqueOrThrow({ where: { id: taskId }, include: TASK_INCLUDE });
      await this.outbox.emit({ type: 'task.status_changed', actor: 'system', payload: statusChangedPayload(fresh, row.status, 'cancelled', decision.reason) }, tx);
      return { result: 'cancelled', task: { ...task, reason: decision.reason } };
    });
  }

  private async handSeries(rule: { id: string; assignedById: string }, from: Person, target: HandoverTarget & Person, fit: HandoverFit): Promise<'moved' | 'stopped' | null> {
    return this.prisma.$transaction(async (tx) => {
      if (seriesHandoverOutcome(rule, target, fit) === 'stop') {
        const stopped = await this.repeat.stopSeries(tx, rule.id, `The series was stopped because ${from.empId} left and ${target.empId} cannot take it`, null);
        return stopped ? 'stopped' : null;
      }
      const { count } = await tx.taskRepeatRule.updateMany({ where: { id: rule.id, assigneeId: from.id, active: true }, data: { assigneeId: target.id, updatedBy: null } });
      return count ? 'moved' : null;
    });
  }
}
