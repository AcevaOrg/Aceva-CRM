import { Injectable, NotFoundException } from '@nestjs/common';
import type { ExtensionView, RequestExtensionRequest, TaskActionName, TaskView, TaskWarning } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { HierarchyCache } from '../access/hierarchy.service';
import { PermissionService } from '../access/permission.service';
import { ScopeService } from '../access/scope.service';
import { pakistanDay } from '../activity/rules/activity-time';
import { ApprovalsService } from '../approvals/approvals.service';
import { Clock } from '../common/clock';
import { noteActivity } from '../common/request-context';
import { OutboxService } from '../events/outbox.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { canRequestExtensionIn, checkDeadlineChange, checkExtension, isOnTime } from './rules/task-deadlines';
import { type ActionContext, allowedActions, evaluateAction, isOpen } from './rules/task-status';
import { conflict, confirmationRequired, firstIssue, invalid, isUniqueViolation, loadTask, loadVisibleTask, lockTask, noteTaskActivity, notAllowed, toWarning } from './task-access';
import { addTaskHistory, EXTENSION_INCLUDE, statusChangedPayload, taskRefOf, toExtensionView, toTaskView, type TaskRow } from './task-data';
import { TaskSettingsService } from './task-settings.service';

/** What the person sent with a status action. */
export interface ActionBody {
  reason?: string;
  rating?: number;
  comment?: string;
}

const iso = (d: Date): string => d.toISOString();
const words = (status: string): string => status.replace('_', ' ');

/** The sentence for the activity timeline of each action. */
const VERB: Record<TaskActionName, string> = {
  start: 'Started',
  submit: 'Submitted',
  review: 'Started reviewing',
  approve: 'Approved',
  rework: 'Sent back for rework',
  hold: 'Put on hold',
  cancel: 'Cancelled',
  resume: 'Resumed',
  done: 'Marked done',
  reopen: 'Reopened',
};

/** What the assigner rule needs to know about a task. */
interface ActingTask {
  personal: boolean;
  assigneeId: string;
  assignedById: string;
  assignee: { empId: string };
}

const REVIEW_ACTIONS: readonly TaskActionName[] = ['review', 'approve', 'rework'];
const ASSIGNER_ACTIONS: readonly TaskActionName[] = ['hold', 'cancel', 'resume'];

/**
 * Everything that moves a task along: the status actions with review records, extension requests and decisions, manager
 * deadline changes, and who the reviewer is. The pure rules are in rules/task-status.ts and rules/task-deadlines.ts.
 * Every state change runs in ONE database transaction that (1) locks and re-reads the task, (2) updates the task row,
 * (3) adds a task_history line, (4) writes the task_reviews / task_extensions row when there is one, (5) writes the audit
 * entry and (6) emits the outbox event(s). Nothing is sent from here: reminders, mails and hand-overs are the consumers of
 * those events. A personal to-do is private to its owner: it gets history lines but no audit entry and no event.
 *
 * The M4 action recorder logs every request by itself; noteActivity() only names the task.
 */
@Injectable()
export class TaskWorkflowService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly approvals: ApprovalsService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly settings: TaskSettingsService,
    private readonly scope: ScopeService,
    private readonly hierarchy: HierarchyCache,
  ) {}

  // ------------------------------------------------------------------------------------------------ the reviewer

  /**
   * Who reviews this task now (an Emp-ID), or null for a personal to-do (no review) or when nobody can. The reviewer is the
   * assigner; if the assigner is away with a stand-in today, the stand-in; if the assigner is away with none, has left, or
   * would be the assignee, the next level up (ApprovalsService.route walks the assignee's reporting chain and starts at the
   * assigner's seat). Whoever is found must hold task.review, otherwise the search goes one seat further up. Nobody
   * reviews their own task. The CEO / Founder / Owner is never a reviewer (he does not hold task.review).
   */
  async reviewerOf(taskId: string): Promise<string | null> {
    const task = await this.prisma.task.findUnique({
      where: { id: taskId },
      select: { personal: true, assigneeId: true, assignedById: true, assignee: { select: { empId: true } } },
    });
    if (!task || task.personal) return null;
    return this.reviewerFor(task);
  }

  /**
   * Who would review a task that `assignedById` gives to `assignee` once nobody is away, without the task having to exist
   * (the leaver hand-over asks this before it moves a task to its new owner). Null when nobody ever could.
   *
   * It deliberately ignores today's away periods. A hand-over is permanent and an absence is not: with the Director away
   * and the new owner (the CTO) as his stand-in, the live route skips the stand-in because he would review his own task,
   * and the Owner never reviews work, so today nobody can. The Director reviews it when he is back, so the answer here must
   * stay "somebody". It walks the new owner's reporting line from the assigner's own seat upward and answers the first person
   * who has not left and holds task.review, with the seat rules of the live route: a person who left is passed over, and the
   * CEO / Founder / Owner only reviews for the people who report to him directly.
   */
  async standingReviewerIfDoneBy(assignee: { id: string }, assignedById: string): Promise<string | null> {
    const chain = await this.hierarchy.getChain(assignee.id);
    // The live route starts at the assigner's own seat when he is in the line, and at the nearest manager when he is not.
    const first = Math.max(chain.indexOf(assignedById), 0);
    const seats = await this.prisma.employee.findMany({ where: { id: { in: chain.slice(first) } }, select: { id: true, empId: true, status: true, level: { select: { number: true } } } });
    for (let at = first; at < chain.length; at++) {
      const seat = seats.find((s) => s.id === chain[at]);
      if (!seat || seat.status === 'left') continue;
      if (at > 0 && seat.level.number === 1) continue; // the Owner reviews only for his direct reports
      if (await this.permissions.can(seat.id, 'task.review')) return seat.empId;
    }
    return null;
  }

  /**
   * The search behind reviewerOf: starts at the assigner's own seat in the assignee's reporting chain and goes up until it
   * finds somebody who holds `permission` (task.review for the reviewer, task.assign for the person who stands in for an
   * assigner who can no longer act).
   */
  private async reviewerFor(task: { assigneeId: string; assignedById: string; assignee: { empId: string } }, permission: 'task.review' | 'task.assign' = 'task.review'): Promise<string | null> {
    const today = pakistanDay(this.clock.now());
    const chain = await this.hierarchy.getChain(task.assigneeId);
    const at = chain.indexOf(task.assignedById);
    let afterSeat: string | undefined;
    if (at > 0) {
      // Start at the assigner's own seat: pass the person directly below him in the assignee's chain.
      afterSeat = (await this.prisma.employee.findUnique({ where: { id: chain[at - 1] }, select: { empId: true } }))?.empId;
    }
    for (let guard = 0; guard <= chain.length; guard++) {
      const step = await this.approvals.route(task.assignee.empId, today, afterSeat);
      if (!step.approver) return null;
      const person = await this.prisma.employee.findUnique({ where: { empId: step.approver }, select: { id: true } });
      if (person && (await this.permissions.can(person.id, permission))) return step.approver;
      if (!step.seat) return null;
      afterSeat = step.seat;
    }
    return null;
  }

  /**
   * May this person act as the ASSIGNER of the task: hold, resume, cancel, edit and reassign it, move its deadline, add steps
   * and files, stop its repeat. The person who assigned it, while he still can (he is here and holds task.assign). When he
   * left, or can no longer assign, the next person up the line who holds task.assign stands in for him (the same search as
   * the reviewer), so the work is never stuck. Never the person doing the task, never for a personal to-do.
   */
  async canActAsAssigner(actor: { id: string; empId: string }, task: ActingTask): Promise<boolean> {
    if (task.personal || task.assigneeId === actor.id) return false;
    if (!(await this.permissions.can(actor.id, 'task.assign'))) return false;
    return (await this.actingAssignerOf(task)) === actor.empId;
  }

  /**
   * Who acts as the assigner of this task right now (an Emp-ID): the person who assigned it while he is here and holds
   * task.assign, otherwise the first person up the line who does. Null for a personal to-do, or when nobody can.
   */
  async actingAssignerOf(task: ActingTask): Promise<string | null> {
    if (task.personal) return null;
    const assigner = await this.prisma.employee.findUnique({ where: { id: task.assignedById }, select: { empId: true, status: true } });
    if (assigner && assigner.status !== 'left' && (await this.permissions.can(task.assignedById, 'task.assign'))) return assigner.empId;
    return this.reviewerFor(task, 'task.assign');
  }

  // ------------------------------------------------------------------------------------------------ status actions

  /**
   * POST /tasks/:id/{start|submit|review|approve|rework|hold|cancel|resume|done|reopen}.
   * The person must see the task (404 otherwise). The rule in rules/task-status.ts says who may do what: an action that
   * is not possible in the task's status for anybody is a 409 `invalid_state`; one that is possible, but not for this
   * person, is a 403 `not_allowed`; a missing reason or rating is a 400. `done` / `reopen` are only for a personal to-do.
   */
  async perform(actor: Actor, idOrNumber: string, action: TaskActionName, body: ActionBody, client: RequestInfo): Promise<TaskView> {
    const task = await loadVisibleTask(this.prisma, this.scope, actor, idOrNumber);
    const roles = await this.rolesFor(actor, task, action);
    const input = { reason: body.reason, rating: body.rating };
    this.evaluate(action, { ...roles, status: task.status }, input, task.startedAt); // fail early, before the lock
    const now = this.clock.now();

    const view = await this.prisma.$transaction(async (tx) => {
      await lockTask(tx, task.id);
      const fresh = await loadTask(tx, task.id);
      // The task may have moved on while this request waited (two people clicking at the same moment).
      const result = this.evaluate(action, { ...roles, status: fresh.status }, input, fresh.startedAt);
      const e = result.effects;

      const data: Prisma.TaskUncheckedUpdateInput = { status: result.to, updatedBy: actor.id };
      if (e.setStartedAt) data.startedAt = now;
      if (e.setSubmittedAt) data.submittedAt = now;
      if (e.incrementRework) data.reworkCount = { increment: 1 };
      if (e.setClosedAt) data.closedAt = now;
      else if (e.clearClosedAt) data.closedAt = null;
      await tx.task.update({ where: { id: task.id }, data });

      const approved = action === 'approve';
      const reason = ((approved ? body.comment : body.reason) ?? '').trim() || null;
      if (e.writesReview) {
        await tx.taskReview.create({
          data: {
            taskId: task.id,
            reviewerId: actor.id,
            decision: approved ? 'approved' : 'rework',
            rating: approved ? (body.rating as number) : null,
            comment: approved ? reason : null,
            reason: approved ? null : reason,
            submittedAt: fresh.submittedAt,
            deadlineAtReview: fresh.deadline,
            createdAt: now,
          },
        });
      }
      await addTaskHistory(tx, { taskId: task.id, kind: 'status', from: result.from, to: result.to, byId: actor.id, reason, details: approved ? { rating: body.rating as number } : undefined, at: now });

      const updated = await loadTask(tx, task.id);
      if (!updated.personal) {
        await this.audit.record(
          { actorId: actor.id, action: `task.${action}`, targetType: 'task', targetId: updated.number, reason, details: { from: result.from, to: result.to, ...(approved ? { rating: body.rating as number } : {}) }, ...client },
          tx,
        );
        await this.outbox.emit({ type: 'task.status_changed', actor: actor.empId, payload: statusChangedPayload(updated, result.from, result.to, reason) }, tx);
        if (approved) {
          await this.outbox.emit(
            {
              type: 'task.approved',
              actor: actor.empId,
              payload: {
                ...taskRefOf(updated),
                assignee: updated.assignee.empId,
                reviewer: actor.empId,
                rating: body.rating as number,
                size: updated.size,
                points: updated.points,
                estimatedHours: Number(updated.estimatedHours),
                deadline: iso(updated.deadline),
                originalDeadline: iso(updated.originalDeadline),
                startedAt: updated.startedAt ? iso(updated.startedAt) : null,
                submittedAt: updated.submittedAt ? iso(updated.submittedAt) : null,
                onTime: isOnTime(updated.submittedAt ?? now, updated.deadline),
                extensionsCount: updated.extensionsCount,
                reworkCount: updated.reworkCount,
              },
            },
            tx,
          );
        } else if (action === 'rework') {
          await this.outbox.emit(
            { type: 'task.reworked', actor: actor.empId, payload: { ...taskRefOf(updated), assignee: updated.assignee.empId, reviewer: actor.empId, reason: reason as string, reworkCount: updated.reworkCount } },
            tx,
          );
        }
      }
      return toTaskView(updated, now);
    });

    noteTaskActivity(view, `${VERB[action]} task ${view.number}`, `${VERB[action]} a personal to-do`);
    return view;
  }

  /** The three parts the person plays on this task (only worked out for the actions that need them). */
  private async rolesFor(actor: Actor, task: TaskRow, action: TaskActionName): Promise<Omit<ActionContext, 'status'>> {
    const isAssignee = task.assigneeId === actor.id;
    let isAssigner = false;
    let isReviewer = false;
    if (!task.personal) {
      if (ASSIGNER_ACTIONS.includes(action)) isAssigner = await this.canActAsAssigner(actor, task);
      if (REVIEW_ACTIONS.includes(action)) isReviewer = (await this.reviewerFor(task)) === actor.empId && (await this.permissions.can(actor.id, 'task.review'));
    }
    return { personal: task.personal, isAssignee, isAssigner, isReviewer };
  }

  /** The rule's answer as the right HTTP error (see perform). */
  private evaluate(action: TaskActionName, ctx: ActionContext, input: { reason?: string; rating?: number }, startedAt: Date | null) {
    const result = evaluateAction(action, ctx, input, startedAt);
    if (result.ok) return result;
    if (result.code !== 'not_allowed') throw invalid(result.code, result.message);
    // Is it possible in this status for ANYONE? Then it is a refusal for this person; if not, the status is in the way.
    const asDoer = allowedActions({ ...ctx, isAssignee: true, isAssigner: false, isReviewer: false });
    const asManager = allowedActions({ ...ctx, isAssignee: false, isAssigner: true, isReviewer: true });
    if (!asDoer.includes(action) && !asManager.includes(action)) throw conflict('invalid_state', result.message);
    if (ctx.isAssignee && REVIEW_ACTIONS.includes(action)) throw notAllowed('Nobody reviews their own task.');
    if (ctx.isAssignee && ASSIGNER_ACTIONS.includes(action)) throw notAllowed('Nobody puts their own task on hold or cancels it.');
    if (REVIEW_ACTIONS.includes(action)) throw notAllowed('Only the reviewer of this task can do this.');
    if (ASSIGNER_ACTIONS.includes(action)) throw notAllowed('Only the person who assigned this task can do this.');
    throw notAllowed('Only the person doing this task can do this.');
  }

  // ------------------------------------------------------------------------------------------------ deadline changes

  /**
   * The checks for a manager moving a deadline (called before the change, also by TasksService.update): only the assigner
   * (task.assign; when he left, whoever stands in for him, see canActAsAssigner), the task still open, never a personal to-do, a reason, a real change in the future. Returns the soft
   * warnings (a deadline shorter than the size usually needs) that need a confirmation.
   */
  async prepareDeadlineChange(actor: Actor, task: TaskRow, deadline: Date, reason: string | undefined): Promise<TaskWarning[]> {
    if (task.personal) throw notAllowed('A personal to-do has no manager: change its deadline directly.');
    if (!(await this.canActAsAssigner(actor, task))) throw notAllowed('Only the person who assigned the task can change its deadline.');
    if (!isOpen(task.status)) throw conflict('task_closed', `This task is ${words(task.status)}; its deadline can no longer change.`);
    const errors = checkDeadlineChange({ current: task.deadline, next: deadline, now: this.clock.now(), reason });
    if (errors.length > 0) throw firstIssue(errors);
    const check = await this.settings.deadlineCheck({ start: task.startDate, deadline, size: task.size });
    if (check.errors.length > 0) throw firstIssue(check.errors);
    return check.warnings.map(toWarning);
  }

  /**
   * Writes a manager's deadline change inside the caller's transaction (the task row must be locked and `task` freshly read):
   * the new deadline (originalDeadline is never touched), the history line with both dates and the reason, the audit entry
   * and the event task.deadline_changed. `at` is the time of the history line (the caller passes a later millisecond when it
   * wrote other lines in the same request, so the history keeps the order they were made in).
   */
  async applyDeadlineChange(tx: Prisma.TransactionClient, actor: Actor, task: TaskRow, deadline: Date, reason: string, client: RequestInfo, at: Date = this.clock.now()): Promise<void> {
    await tx.task.update({ where: { id: task.id }, data: { deadline, updatedBy: actor.id } });
    await addTaskHistory(tx, { taskId: task.id, kind: 'deadline_changed', from: task.status, to: task.status, byId: actor.id, reason, details: { fromDeadline: iso(task.deadline), toDeadline: iso(deadline) }, at });
    await this.audit.record(
      { actorId: actor.id, action: 'task.deadline.changed', targetType: 'task', targetId: task.number, reason, details: { before: { deadline: iso(task.deadline) }, after: { deadline: iso(deadline) } }, ...client },
      tx,
    );
    await this.outbox.emit(
      {
        type: 'task.deadline_changed',
        actor: actor.empId,
        payload: { ...taskRefOf(task), assignee: task.assignee.empId, assignedBy: task.assignedBy.empId, from: iso(task.deadline), to: iso(deadline), kind: 'manager_change', reason },
      },
      tx,
    );
  }

  /**
   * PATCH /tasks/:id with only a new deadline. The assigner only (task.assign), the task still open, a personal to-do never.
   * Reason required. A deadline shorter than the size usually needs is a soft warning like on create (409
   * confirmation_required unless confirmWarnings).
   */
  async changeDeadline(actor: Actor, idOrNumber: string, deadline: Date, reason: string, confirmWarnings: boolean, client: RequestInfo): Promise<TaskView> {
    const task = await loadVisibleTask(this.prisma, this.scope, actor, idOrNumber);
    const warnings = await this.prepareDeadlineChange(actor, task, deadline, reason);
    if (warnings.length > 0 && !confirmWarnings) throw confirmationRequired(warnings);
    const now = this.clock.now();
    const view = await this.prisma.$transaction(async (tx) => {
      await lockTask(tx, task.id);
      const fresh = await loadTask(tx, task.id);
      if (!isOpen(fresh.status)) throw conflict('task_closed', `This task is ${words(fresh.status)}; its deadline can no longer change.`);
      if (fresh.deadline.getTime() !== task.deadline.getTime()) throw conflict('deadline_changed', 'The deadline was changed in the meantime. Reload the task and try again.');
      await this.applyDeadlineChange(tx, actor, fresh, deadline, reason, client);
      return toTaskView(await loadTask(tx, task.id), now);
    });
    noteActivity({ target: view.number, description: `Changed the deadline of task ${view.number}` });
    return view;
  }

  // ------------------------------------------------------------------------------------------------ extensions

  /**
   * POST /tasks/:id/extensions. The assignee only, a work task only, in a status where an extension makes sense, no other
   * pending request (409 `extension_pending`). The new deadline must be later than the current one. A request made after
   * the deadline still goes through, marked `late`.
   */
  async requestExtension(actor: Actor, idOrNumber: string, body: RequestExtensionRequest, client: RequestInfo): Promise<ExtensionView> {
    const task = await loadVisibleTask(this.prisma, this.scope, actor, idOrNumber);
    if (task.personal) throw invalid('not_for_personal', 'A personal to-do has nobody to ask: change its deadline yourself.');
    if (task.assigneeId !== actor.id) throw notAllowed('Only the person doing the task can ask for more time.');
    if (!canRequestExtensionIn(task.status)) throw conflict('invalid_state', `You cannot ask for more time on a task that is ${words(task.status)}.`);
    const requested = new Date(body.requestedDeadline);
    const now = this.clock.now();
    const { errors, late } = checkExtension({ currentDeadline: task.deadline, requestedDeadline: requested, now });
    if (errors.length > 0) throw firstIssue(errors);

    try {
      const view = await this.prisma.$transaction(async (tx) => {
        await lockTask(tx, task.id);
        const fresh = await loadTask(tx, task.id);
        if (!canRequestExtensionIn(fresh.status)) throw conflict('invalid_state', `You cannot ask for more time on a task that is ${words(fresh.status)}.`);
        if (fresh.deadline.getTime() !== task.deadline.getTime()) throw conflict('deadline_changed', 'The deadline was changed in the meantime. Reload the task and try again.');
        if (await tx.taskExtension.findFirst({ where: { taskId: task.id, status: 'pending' }, select: { id: true } })) {
          throw conflict('extension_pending', 'There is already a request for more time waiting for an answer.');
        }
        const row = await tx.taskExtension.create({
          data: { taskId: task.id, requestedById: actor.id, currentDeadline: fresh.deadline, requestedDeadline: requested, reason: body.reason, late, createdAt: now },
          include: EXTENSION_INCLUDE,
        });
        await addTaskHistory(tx, {
          taskId: task.id,
          kind: 'extension_requested',
          from: fresh.status,
          to: fresh.status,
          byId: actor.id,
          reason: body.reason,
          details: { extensionId: row.id, fromDeadline: iso(fresh.deadline), toDeadline: iso(requested), late },
          at: now,
        });
        await this.audit.record(
          { actorId: actor.id, action: 'task.extension.requested', targetType: 'task', targetId: fresh.number, reason: body.reason, details: { extensionId: row.id, from: iso(fresh.deadline), to: iso(requested), late }, ...client },
          tx,
        );
        await this.outbox.emit(
          {
            type: 'task.extension_requested',
            actor: actor.empId,
            payload: { ...taskRefOf(fresh), extensionId: row.id, assignee: fresh.assignee.empId, assignedBy: fresh.assignedBy.empId, currentDeadline: iso(fresh.deadline), requestedDeadline: iso(requested), late },
          },
          tx,
        );
        return toExtensionView(row);
      });
      noteActivity({ target: task.number, description: `Asked for more time on task ${task.number}` });
      return view;
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('extension_pending', 'There is already a request for more time waiting for an answer.');
      throw error;
    }
  }

  /**
   * POST /extensions/:id/{approve|reject}. Only the person who may decide it: the person who assigned the task, or whoever
   * `reviewerOf` says (their stand-in, or the next level up), holding task.assign; never the person who asked. The request
   * must still be pending (409 `already_decided`). Reject needs a reason. Approving saves the new deadline and counts the
   * extension; the original deadline stays. The status of the task does not change.
   */
  async decideExtension(actor: Actor, extensionId: string, decision: 'approve' | 'reject', reason: string | undefined, client: RequestInfo): Promise<ExtensionView> {
    const found = await this.prisma.taskExtension.findUnique({ where: { id: extensionId }, select: { taskId: true, requestedById: true } });
    if (!found) throw new NotFoundException({ statusCode: 404, code: 'not_found', message: 'Extension request not found' });
    const task = await loadVisibleTask(this.prisma, this.scope, actor, found.taskId); // 404 for people who cannot see the task
    if (found.requestedById === actor.id) throw notAllowed('Nobody decides their own request.');
    if ((await this.reviewerFor(task)) !== actor.empId || !(await this.permissions.can(actor.id, 'task.assign'))) {
      throw notAllowed('Only the person who assigned this task (or their stand-in) can decide this.');
    }
    const why = (reason ?? '').trim();
    if (decision === 'reject' && why.length < 3) throw invalid('reason_required', 'A reason is required to turn a request down.');
    const now = this.clock.now();
    const approved = decision === 'approve';

    const view = await this.prisma.$transaction(async (tx) => {
      await lockTask(tx, task.id);
      const fresh = await loadTask(tx, task.id);
      const ext = await tx.taskExtension.findUniqueOrThrow({ where: { id: extensionId }, include: EXTENSION_INCLUDE });
      if (ext.status !== 'pending') throw conflict('already_decided', 'This request has already been answered.');
      if (!canRequestExtensionIn(fresh.status)) throw conflict('invalid_state', `This task is ${words(fresh.status)}; the request no longer applies.`);
      if (approved && ext.requestedDeadline.getTime() <= Math.max(fresh.deadline.getTime(), now.getTime())) {
        throw conflict('extension_outdated', 'The deadline has already moved past this request. Turn it down and ask again.');
      }

      const decided = await tx.taskExtension.update({
        where: { id: extensionId },
        data: { status: approved ? 'approved' : 'rejected', decidedById: actor.id, decidedAt: now, decisionReason: why || null },
        include: EXTENSION_INCLUDE,
      });
      if (approved) await tx.task.update({ where: { id: task.id }, data: { deadline: ext.requestedDeadline, extensionsCount: { increment: 1 }, updatedBy: actor.id } });
      await addTaskHistory(tx, {
        taskId: task.id,
        kind: approved ? 'extension_approved' : 'extension_rejected',
        from: fresh.status,
        to: fresh.status,
        byId: actor.id,
        reason: why || null,
        details: { extensionId, fromDeadline: iso(fresh.deadline), toDeadline: iso(ext.requestedDeadline), late: ext.late },
        at: now,
      });
      await this.audit.record(
        {
          actorId: actor.id,
          action: approved ? 'task.extension.approved' : 'task.extension.rejected',
          targetType: 'task',
          targetId: fresh.number,
          reason: why || null,
          details: { extensionId, from: iso(fresh.deadline), requested: iso(ext.requestedDeadline), late: ext.late },
          ...client,
        },
        tx,
      );
      await this.outbox.emit(
        {
          type: 'task.extension_decided',
          actor: actor.empId,
          payload: {
            ...taskRefOf(fresh),
            extensionId,
            requestedBy: ext.requestedBy.empId,
            decidedBy: actor.empId,
            decision: approved ? 'approved' : 'rejected',
            newDeadline: approved ? iso(ext.requestedDeadline) : null,
            late: ext.late,
          },
        },
        tx,
      );
      if (approved) {
        await this.outbox.emit(
          {
            type: 'task.deadline_changed',
            actor: actor.empId,
            payload: { ...taskRefOf(fresh), assignee: fresh.assignee.empId, assignedBy: fresh.assignedBy.empId, from: iso(fresh.deadline), to: iso(ext.requestedDeadline), kind: 'extension_approved', reason: why || null },
          },
          tx,
        );
      }
      return toExtensionView(decided);
    });
    noteActivity({ target: task.number, description: `${approved ? 'Approved' : 'Turned down'} more time on task ${task.number}` });
    return view;
  }
}
