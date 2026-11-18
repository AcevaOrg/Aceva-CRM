import { Injectable, NotFoundException } from '@nestjs/common';
import { TASK_LIST_CLOSED_DAYS } from '@aceva/contracts';
import type { AddChecklistItemRequest, ChecklistItemView, CreateTaskRequest, StopRepeatRequest, TaskDetailResponse, TaskListQuery, TaskView, TaskWarning, UpdateTaskRequest, WorkloadRowView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { PermissionService } from '../access/permission.service';
import { ScopeService } from '../access/scope.service';
import { dayWindow, pakistanDay } from '../activity/rules/activity-time';
import { Clock } from '../common/clock';
import { noteActivity } from '../common/request-context';
import { OutboxService } from '../events/outbox.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { repeatKeyPrefix } from './rules/auto-reminders';
import { occurrenceDayOf, templateTiming } from './rules/task-repeat';
import { isOpen, OPEN_STATUSES } from './rules/task-status';
import { openHours, openTaskCount, workloadAfter, workloadWarning } from './rules/task-workload';
import {
  clip,
  commentViews,
  conflict,
  confirmationRequired,
  dateOnly,
  firstIssue,
  forbidden,
  invalid,
  loadTask,
  loadVisibleTask,
  lockTask,
  noteTaskActivity,
  notAllowed,
  toWarning,
  visibleTaskWhere,
} from './task-access';
import {
  addTaskHistory,
  createdPayload,
  EXTENSION_INCLUDE,
  HISTORY_INCLUDE,
  nextTaskNumber,
  num,
  TASK_INCLUDE,
  toExtensionView,
  toHistoryView,
  toTaskView,
  type TaskRow,
} from './task-data';
import { TaskSettingsService } from './task-settings.service';
import { TaskWorkflowService } from './task-workflow.service';

const words = (status: string): string => status.replace('_', ' ');
const iso = (d: Date): string => d.toISOString();
/** The statuses in which a task may be handed to someone else (not while it waits for its reviewer). */
const REASSIGNABLE: readonly string[] = ['assigned', 'in_progress', 'rework', 'on_hold'];

interface Person {
  id: string;
  empId: string;
  fullName: string;
  weeklyCapacityHours: number;
}

/**
 * Tasks: who sees what, creating (with assigning), editing, the checklist, the team workload and stopping a repeating
 * series. The pure rules are in rules/ (task-deadlines, task-workload, task-people, task-sizes, task-format). Every change
 * runs in one transaction with its task_history line, audit entry and outbox event (see TaskWorkflowService for the same
 * pattern). A personal to-do is private to its owner: it gets history lines but no audit entry and no event, and the
 * activity timeline never names it.
 *
 * VISIBILITY (task-access.ts visibleTaskWhere, written as a Prisma filter through ScopeService):
 *  - a personal to-do: its owner only (never a manager, never the CEO / Founder / Owner);
 *  - a work task: the assignee, the assigner, and everyone above the assignee in the reporting line (the CEO / Founder /
 *    Owner's line is the whole company: he sees every work task, read only).
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly settings: TaskSettingsService,
    private readonly workflow: TaskWorkflowService,
  ) {}

  /**
   * The task if the actor may see it, else 404 (never 403: do not reveal that a task exists). `idOrNumber` is the UUID or
   * the number (TSK-0001). Used by every task endpoint and by TaskCommentsService.
   */
  requireVisible(actor: Actor, idOrNumber: string): Promise<TaskRow> {
    return loadVisibleTask(this.prisma, this.scope, actor, idOrNumber);
  }

  // ------------------------------------------------------------------------------------------------ reading

  /**
   * GET /tasks?scope=mine|team|all&assignee&status&priority&size&projectId&dueFrom&dueTo&includePersonal.
   *  - mine: tasks where the actor is the assignee (their own personal to-dos only with includePersonal=true);
   *  - team: work tasks whose assignee is BELOW the actor (needs task.view_team, else 403);
   *  - all: everything visible (own + team; for the CEO / Founder / Owner, every work task).
   * Personal to-dos of OTHER people never appear. Sorted by deadline. The due range is Pakistan days, both included.
   * `open=true` leaves out approved and cancelled tasks. So the answer does not grow for ever, approved and cancelled tasks
   * that were closed more than TASK_LIST_CLOSED_DAYS (90) days ago are left out unless `closed=all` asks for them; open
   * tasks are always all there.
   */
  async list(actor: Actor, query: TaskListQuery): Promise<TaskView[]> {
    const and: Prisma.TaskWhereInput[] = [visibleTaskWhere(actor, this.scope)];
    const includePersonal = query.includePersonal === true;
    if (query.scope === 'mine') {
      and.push({ assigneeId: actor.id });
      if (!includePersonal) and.push({ personal: false });
    } else if (query.scope === 'team') {
      if (!(await this.permissions.can(actor.id, 'task.view_team'))) throw forbidden('You cannot see the tasks of your team.');
      and.push({ personal: false, assignee: this.scope.employeeWhere(actor.id, 'below') });
    } else if (!includePersonal) {
      and.push({ personal: false });
    }
    if (query.assignee) and.push({ assignee: { empId: query.assignee } });
    if (query.status) and.push({ status: query.status });
    if (query.priority) and.push({ priority: query.priority });
    if (query.size) and.push({ size: query.size });
    if (query.open === true) and.push({ status: { in: [...OPEN_STATUSES] } });
    if (query.closed !== 'all') {
      const since = new Date(this.clock.now().getTime() - TASK_LIST_CLOSED_DAYS * 86_400_000);
      and.push({ OR: [{ status: { in: [...OPEN_STATUSES] } }, { closedAt: null }, { closedAt: { gte: since } }] });
    }
    if (query.projectId) and.push({ projectId: query.projectId });
    if (query.dueFrom || query.dueTo) {
      and.push({ deadline: { ...(query.dueFrom ? { gte: dayWindow(query.dueFrom).start } : {}), ...(query.dueTo ? { lt: dayWindow(query.dueTo).end } : {}) } });
    }
    const rows = await this.prisma.task.findMany({ where: { AND: and }, include: TASK_INCLUDE, orderBy: [{ deadline: 'asc' }, { number: 'asc' }] });
    const now = this.clock.now();
    return rows.map((r) => toTaskView(r, now));
  }

  /** GET /tasks/:id (UUID or number): the task, its comments, extension requests and history (oldest first), who reviews it now and who acts as its assigner now. 404 when not visible. */
  async get(actor: Actor, idOrNumber: string): Promise<TaskDetailResponse> {
    const row = await this.requireVisible(actor, idOrNumber);
    const [comments, extensions, history, reviewer, actingAssigner] = await Promise.all([
      commentViews(this.prisma, row.id),
      this.prisma.taskExtension.findMany({ where: { taskId: row.id }, orderBy: { createdAt: 'asc' }, include: EXTENSION_INCLUDE }),
      this.prisma.taskHistory.findMany({ where: { taskId: row.id }, orderBy: [{ at: 'asc' }, { id: 'asc' }], include: HISTORY_INCLUDE }),
      this.workflow.reviewerOf(row.id),
      this.workflow.actingAssignerOf(row),
    ]);
    return { task: toTaskView(row, this.clock.now()), comments, extensions: extensions.map(toExtensionView), history: history.map(toHistoryView), reviewer, actingAssigner };
  }

  /**
   * GET /tasks/workload: one row per ACTIVE person below the actor (status is not "left"; needs task.view_team):
   * { empId, openHours, capacity (weekly), openTasks }. People with no tasks are included with 0. Sorted by Emp-ID.
   */
  async workload(actor: Actor): Promise<WorkloadRowView[]> {
    const people = await this.prisma.employee.findMany({
      where: { ...this.scope.employeeWhere(actor.id, 'below'), status: { not: 'left' } },
      select: { id: true, empId: true, weeklyCapacityHours: true },
      orderBy: { empId: 'asc' },
    });
    const open = await this.prisma.task.findMany({
      where: { assigneeId: { in: people.map((p) => p.id) }, personal: false, status: { in: [...OPEN_STATUSES] } },
      select: { assigneeId: true, status: true, personal: true, estimatedHours: true },
    });
    return people.map((p) => {
      const mine = open.filter((t) => t.assigneeId === p.id).map((t) => ({ status: t.status, personal: t.personal, estimatedHours: num(t.estimatedHours) }));
      return { empId: p.empId, openHours: openHours(mine), capacity: p.weeklyCapacityHours, openTasks: openTaskCount(mine) };
    });
  }

  // ------------------------------------------------------------------------------------------------ creating

  /**
   * POST /tasks. ONE owner, a size and a deadline.
   *  Personal to-do (body.personal): assignee = assignedBy = the actor, points 0, no review, never repeats, only the date
   *    checks. Anyone may create one.
   *  Work task: needs task.assign; the assignee must be BELOW the actor (the CEO / Founder / Owner assigns nothing, nobody
   *    assigns to themselves or to someone who left) else 403. Points come from the size table at this moment and are
   *    frozen; XL is refused. Hard errors answer 400. Soft warnings (deadline_too_short, overloaded) answer 409
   *    confirmation_required unless body.confirmWarnings is true.
   */
  async create(actor: Actor, body: CreateTaskRequest, client: RequestInfo): Promise<TaskView> {
    const personal = body.personal === true;
    const start = new Date(body.startDate);
    const deadline = new Date(body.deadline);
    const now = this.clock.now();

    let assignee: Person;
    if (personal) {
      assignee = { id: actor.id, empId: actor.empId, fullName: actor.fullName, weeklyCapacityHours: 0 };
    } else {
      if (!(await this.permissions.can(actor.id, 'task.assign'))) throw forbidden('You can only assign tasks to people below you.');
      const found = await this.prisma.employee.findUnique({ where: { empId: body.assignee as string }, select: { id: true, empId: true, fullName: true, status: true, weeklyCapacityHours: true } });
      if (!found) throw new NotFoundException({ statusCode: 404, code: 'not_found', message: 'Employee not found' });
      if (!(await this.scope.canAccess(actor.id, found.id, 'below'))) throw forbidden('You can only assign tasks to people below you.');
      if (found.status === 'left') throw invalid('assignee_left', 'This person has left the company.');
      assignee = found;
    }
    if (body.projectId) await this.requireProject(body.projectId);

    const check = await this.settings.deadlineCheck({ start, deadline, size: body.size, personal });
    if (check.errors.length > 0) throw firstIssue(check.errors);
    const rule = check.rule;
    if (body.repeat?.until && body.repeat.until < pakistanDay(start)) throw invalid('repeat_until_before_start', 'The repeat must end on or after the first day.');

    const warnings: TaskWarning[] = check.warnings.map(toWarning);
    if (!personal) {
      const overload = await this.overloadWarning(assignee, body.estimatedHours);
      if (overload) warnings.push(overload);
    }
    if (warnings.length > 0 && body.confirmWarnings !== true) throw confirmationRequired(warnings);

    const row = await this.prisma.$transaction(async (tx) => {
      const number = await nextTaskNumber(tx, personal);
      let repeatRuleId: string | null = null;
      let occurrenceOn: Date | null = null;
      if (body.repeat) {
        const timing = templateTiming(start, deadline);
        const day = occurrenceDayOf(start);
        // The series stands at the later of the first task's day and today: a first task that starts in the past does not
        // make the job catch up on days that are already over (it would make tasks that start overdue).
        const today = pakistanDay(now);
        const standsAt = day > today ? day : today;
        const series = await tx.taskRepeatRule.create({
          data: {
            every: body.repeat.every,
            on: body.repeat.on,
            until: body.repeat.until ? dateOnly(body.repeat.until) : null,
            lastOccurrenceOn: dateOnly(standsAt),
            title: body.title,
            description: body.description,
            assigneeId: assignee.id,
            assignedById: actor.id,
            projectId: body.projectId ?? null,
            priority: body.priority,
            size: body.size,
            estimatedHours: body.estimatedHours,
            startTime: timing.startTime,
            durationMinutes: timing.durationMinutes,
            checklist: body.checklist,
            personal: false,
            createdBy: actor.id,
            updatedBy: actor.id,
          },
        });
        repeatRuleId = series.id;
        occurrenceOn = dateOnly(day);
      }
      const created = await tx.task.create({
        data: {
          number,
          title: body.title,
          description: body.description,
          assigneeId: assignee.id,
          assignedById: actor.id,
          projectId: body.projectId ?? null,
          goalId: body.goalId ?? null,
          priority: body.priority,
          size: body.size,
          // Frozen now: a later change of the size table never rewrites this task.
          points: personal ? 0 : rule.points,
          estimatedHours: body.estimatedHours,
          startDate: start,
          deadline,
          originalDeadline: deadline,
          status: 'assigned',
          personal,
          repeatRuleId,
          occurrenceOn,
          createdBy: actor.id,
          updatedBy: actor.id,
          checklist: { create: body.checklist.map((text, position) => ({ text, position, createdBy: actor.id })) },
        },
        include: TASK_INCLUDE,
      });
      await addTaskHistory(tx, { taskId: created.id, kind: 'created', from: null, to: 'assigned', byId: actor.id, at: now });
      if (!personal) {
        await this.audit.record(
          {
            actorId: actor.id,
            action: 'task.created',
            targetType: 'task',
            targetId: created.number,
            details: {
              title: clip(created.title, 120),
              assignee: assignee.empId,
              size: created.size,
              points: created.points,
              estimatedHours: num(created.estimatedHours),
              startDate: iso(created.startDate),
              deadline: iso(created.deadline),
              repeats: !!repeatRuleId,
              confirmedWarnings: warnings.map((w) => w.code),
            },
            ...client,
          },
          tx,
        );
        await this.outbox.emit({ type: 'task.created', actor: actor.empId, payload: createdPayload(created) }, tx);
      }
      return created;
    });

    noteTaskActivity(row, `Assigned task ${row.number} to ${assignee.empId}`, 'Added a personal to-do');
    return toTaskView(row, now);
  }

  // ------------------------------------------------------------------------------------------------ editing

  /**
   * PATCH /tasks/:id. The assigner (task.assign; when he left, whoever stands in for him, see canActAsAssigner) edits an OPEN work task: title, description, priority, project, goal,
   * estimated hours, a new assignee (only someone BELOW the assigner, with the same overload warning as on create) and a new
   * deadline (a reason is required; the first deadline is kept). The size and its points never change. A personal to-do can
   * only be edited by its owner (title, description, priority, deadline).
   */
  async update(actor: Actor, idOrNumber: string, body: UpdateTaskRequest, client: RequestInfo): Promise<TaskView> {
    const task = await this.requireVisible(actor, idOrNumber);
    if (!isOpen(task.status)) throw conflict('task_closed', `This task is ${words(task.status)} and can no longer be edited.`);
    if (task.personal) return this.updatePersonal(actor, task, body);
    if (!(await this.workflow.canActAsAssigner(actor, task))) throw notAllowed('Only the person who assigned the task can edit it.');
    const now = this.clock.now();

    const data: Prisma.TaskUncheckedUpdateInput = {};
    const before: Record<string, string | number | null> = {};
    const after: Record<string, string | number | null> = {};
    const note = (field: string, from: string | number | null, to: string | number | null) => {
      before[field] = typeof from === 'string' ? clip(from) : from;
      after[field] = typeof to === 'string' ? clip(to) : to;
    };
    if (body.title !== undefined && body.title !== task.title) {
      data.title = body.title;
      note('title', task.title, body.title);
    }
    if (body.description !== undefined && body.description !== task.description) {
      data.description = body.description;
      note('description', task.description, body.description);
    }
    if (body.priority !== undefined && body.priority !== task.priority) {
      data.priority = body.priority;
      note('priority', task.priority, body.priority);
    }
    if (body.estimatedHours !== undefined && body.estimatedHours !== num(task.estimatedHours)) {
      data.estimatedHours = body.estimatedHours;
      note('estimatedHours', num(task.estimatedHours), body.estimatedHours);
    }
    if (body.projectId !== undefined && body.projectId !== task.projectId) {
      if (body.projectId) await this.requireProject(body.projectId);
      data.projectId = body.projectId;
      note('projectId', task.projectId, body.projectId);
    }
    if (body.goalId !== undefined && body.goalId !== task.goalId) {
      data.goalId = body.goalId;
      note('goalId', task.goalId, body.goalId);
    }
    const fields = Object.keys(data);

    const warnings: TaskWarning[] = [];
    let newAssignee: Person | null = null;
    if (body.assignee !== undefined && body.assignee !== task.assignee.empId) {
      if (!REASSIGNABLE.includes(task.status)) throw conflict('invalid_state', 'A task that is waiting for its review cannot be handed to someone else.');
      const found = await this.prisma.employee.findUnique({ where: { empId: body.assignee }, select: { id: true, empId: true, fullName: true, status: true, weeklyCapacityHours: true } });
      if (!found) throw new NotFoundException({ statusCode: 404, code: 'not_found', message: 'Employee not found' });
      if (!(await this.scope.canAccess(actor.id, found.id, 'below'))) throw forbidden('You can only assign tasks to people below you.');
      if (found.status === 'left') throw invalid('assignee_left', 'This person has left the company.');
      newAssignee = found;
      const overload = await this.overloadWarning(found, body.estimatedHours ?? num(task.estimatedHours));
      if (overload) warnings.push(overload);
    }

    let newDeadline: Date | null = null;
    if (body.deadline !== undefined) {
      newDeadline = new Date(body.deadline);
      warnings.push(...(await this.workflow.prepareDeadlineChange(actor, task, newDeadline, body.reason)));
    }
    if (warnings.length > 0 && body.confirmWarnings !== true) throw confirmationRequired(warnings);
    if (fields.length === 0 && !newAssignee && !newDeadline) return toTaskView(task, now);

    const view = await this.prisma.$transaction(async (tx) => {
      await lockTask(tx, task.id);
      const fresh = await loadTask(tx, task.id);
      if (!isOpen(fresh.status)) throw conflict('task_closed', `This task is ${words(fresh.status)} and can no longer be edited.`);
      if (newAssignee && !REASSIGNABLE.includes(fresh.status)) throw conflict('invalid_state', 'A task that is waiting for its review cannot be handed to someone else.');
      if (newDeadline && fresh.deadline.getTime() !== task.deadline.getTime()) throw conflict('deadline_changed', 'The deadline was changed in the meantime. Reload the task and try again.');
      if (newAssignee) {
        data.assigneeId = newAssignee.id;
        note('assignee', task.assignee.empId, newAssignee.empId);
      }
      if (Object.keys(data).length > 0) await tx.task.update({ where: { id: task.id }, data: { ...data, updatedBy: actor.id } });

      // One line each, a millisecond apart, so the history keeps the order they were made in.
      let at = now.getTime();
      if (fields.length > 0) {
        await addTaskHistory(tx, { taskId: task.id, kind: 'edited', from: fresh.status, to: fresh.status, byId: actor.id, details: { fields }, at: new Date(at++) });
      }
      if (newAssignee) {
        await addTaskHistory(tx, {
          taskId: task.id,
          kind: 'reassigned',
          from: fresh.status,
          to: fresh.status,
          byId: actor.id,
          reason: body.reason ?? null,
          details: { fromEmpId: task.assignee.empId, toEmpId: newAssignee.empId },
          at: new Date(at++),
        });
      }
      if (Object.keys(after).length > 0) {
        await this.audit.record({ actorId: actor.id, action: 'task.updated', targetType: 'task', targetId: task.number, reason: body.reason ?? null, details: { before, after }, ...client }, tx);
      }
      if (newDeadline) await this.workflow.applyDeadlineChange(tx, actor, await loadTask(tx, task.id), newDeadline, body.reason as string, client, new Date(at));
      return toTaskView(await loadTask(tx, task.id), now);
    });
    noteActivity({ target: view.number, description: `Edited task ${view.number}` });
    return view;
  }

  /** A personal to-do: its owner changes the title, description, priority or deadline (no reason, no approval, nothing audited). */
  private async updatePersonal(actor: Actor, task: TaskRow, body: UpdateTaskRequest): Promise<TaskView> {
    if (body.assignee !== undefined || body.projectId !== undefined || body.goalId !== undefined || body.estimatedHours !== undefined) {
      throw invalid('personal_fields', 'A personal to-do only has a title, a description, a priority and a deadline to change.');
    }
    const now = this.clock.now();
    const data: Prisma.TaskUncheckedUpdateInput = {};
    const fields: string[] = [];
    if (body.title !== undefined && body.title !== task.title) {
      data.title = body.title;
      fields.push('title');
    }
    if (body.description !== undefined && body.description !== task.description) {
      data.description = body.description;
      fields.push('description');
    }
    if (body.priority !== undefined && body.priority !== task.priority) {
      data.priority = body.priority;
      fields.push('priority');
    }
    let newDeadline: Date | null = null;
    if (body.deadline !== undefined && new Date(body.deadline).getTime() !== task.deadline.getTime()) {
      newDeadline = new Date(body.deadline);
      const check = await this.settings.deadlineCheck({ start: task.startDate, deadline: newDeadline, size: task.size, personal: true });
      if (check.errors.length > 0) throw firstIssue(check.errors);
      data.deadline = newDeadline;
    }
    if (Object.keys(data).length === 0) return toTaskView(task, now);

    const view = await this.prisma.$transaction(async (tx) => {
      await lockTask(tx, task.id);
      const fresh = await loadTask(tx, task.id);
      if (!isOpen(fresh.status)) throw conflict('task_closed', `This to-do is ${words(fresh.status)} and can no longer be edited.`);
      await tx.task.update({ where: { id: task.id }, data: { ...data, updatedBy: actor.id } });
      let at = now.getTime();
      if (fields.length > 0) await addTaskHistory(tx, { taskId: task.id, kind: 'edited', from: fresh.status, to: fresh.status, byId: actor.id, details: { fields }, at: new Date(at++) });
      if (newDeadline) {
        await addTaskHistory(tx, {
          taskId: task.id,
          kind: 'deadline_changed',
          from: fresh.status,
          to: fresh.status,
          byId: actor.id,
          details: { fromDeadline: iso(fresh.deadline), toDeadline: iso(newDeadline) },
          at: new Date(at++),
        });
      }
      return toTaskView(await loadTask(tx, task.id), now);
    });
    noteActivity({ description: 'Edited a personal to-do', hideTarget: true });
    return view;
  }

  // ------------------------------------------------------------------------------------------------ checklist

  /**
   * PATCH /tasks/:id/checklist/:itemId: ticks or unticks one step. The person doing the task only, while the task is
   * open (not approved or cancelled). Sets doneAt / doneBy. Small change: no audit entry (the activity recorder logs it).
   */
  async toggleChecklistItem(actor: Actor, idOrNumber: string, itemId: string, _client: RequestInfo): Promise<ChecklistItemView> {
    const task = await this.requireVisible(actor, idOrNumber);
    if (task.assigneeId !== actor.id) throw notAllowed('Only the person doing the task can tick its steps.');
    if (!isOpen(task.status)) throw conflict('task_closed', `This task is ${words(task.status)}; its checklist can no longer change.`);
    const item = await this.prisma.taskChecklistItem.findFirst({ where: { id: itemId, taskId: task.id } });
    if (!item) throw new NotFoundException({ statusCode: 404, code: 'not_found', message: 'Checklist step not found' });
    const done = !item.done;
    const saved = await this.prisma.taskChecklistItem.update({
      where: { id: item.id },
      data: { done, doneAt: done ? this.clock.now() : null, doneBy: done ? actor.id : null, updatedBy: actor.id },
    });
    this.noteChecklist(task, `${done ? 'Ticked' : 'Unticked'} a step on task ${task.number}`);
    return { id: saved.id, text: saved.text, done: saved.done };
  }

  /** POST /tasks/:id/checklist: adds a step at the end (position = last + 1). The assigner or the person doing the task, task open. */
  async addChecklistItem(actor: Actor, idOrNumber: string, body: AddChecklistItemRequest, _client: RequestInfo): Promise<ChecklistItemView> {
    const task = await this.requireVisible(actor, idOrNumber);
    const isAssigner = await this.workflow.canActAsAssigner(actor, task);
    if (task.assigneeId !== actor.id && !isAssigner) throw notAllowed('Only the person doing the task or the person who assigned it can add steps.');
    if (!isOpen(task.status)) throw conflict('task_closed', `This task is ${words(task.status)}; its checklist can no longer change.`);
    const saved = await this.prisma.$transaction(async (tx) => {
      await lockTask(tx, task.id); // two people adding a step at once must not take the same position
      const last = await tx.taskChecklistItem.aggregate({ where: { taskId: task.id }, _max: { position: true } });
      return tx.taskChecklistItem.create({ data: { taskId: task.id, text: body.text, position: (last._max.position ?? -1) + 1, createdBy: actor.id } });
    });
    this.noteChecklist(task, `Added a step to task ${task.number}`);
    return { id: saved.id, text: saved.text, done: saved.done };
  }

  private noteChecklist(task: TaskRow, description: string): void {
    noteTaskActivity(task, description, 'Changed a personal to-do');
  }

  // ------------------------------------------------------------------------------------------------ repeating series

  /**
   * POST /tasks/:id/repeat/stop: ends the repeating series the task belongs to (active = false, stoppedAt, stoppedBy). The
   * assigner only. 409 when the task is not part of a series or the series is already stopped. Tasks already made stay.
   * The job that makes the next task sees active = false and does not re-arm; a waiting job is cancelled here too.
   */
  async stopRepeat(actor: Actor, idOrNumber: string, body: StopRepeatRequest, client: RequestInfo): Promise<TaskView> {
    const task = await this.requireVisible(actor, idOrNumber);
    if (!(await this.workflow.canActAsAssigner(actor, task))) throw notAllowed('Only the person who assigned the task can stop its repeat.');
    if (!task.repeatRuleId) throw conflict('not_repeating', 'This task does not repeat.');
    const ruleId = task.repeatRuleId;
    const now = this.clock.now();

    const view = await this.prisma.$transaction(async (tx) => {
      await lockTask(tx, task.id);
      const stopped = await tx.taskRepeatRule.updateMany({ where: { id: ruleId, active: true }, data: { active: false, stoppedAt: now, stoppedBy: actor.id, updatedBy: actor.id } });
      if (stopped.count === 0) throw conflict('already_stopped', 'This repeat has already been stopped.');
      // The series has one job per occurrence day (key task.repeat:<rule>:<day>): drop the waiting one by its prefix.
      await tx.scheduledJob.deleteMany({ where: { dedupeKey: { startsWith: repeatKeyPrefix(ruleId) }, status: { in: ['pending', 'failed'] } } });
      const fresh = await loadTask(tx, task.id);
      await addTaskHistory(tx, { taskId: task.id, kind: 'repeat_stopped', from: fresh.status, to: fresh.status, byId: actor.id, reason: body.reason ?? null, at: now });
      await this.audit.record({ actorId: actor.id, action: 'task.repeat.stopped', targetType: 'task', targetId: fresh.number, reason: body.reason ?? null, details: { repeatRuleId: ruleId }, ...client }, tx);
      return toTaskView(fresh, now);
    });
    noteActivity({ target: view.number, description: `Stopped the repeat of task ${view.number}` });
    return view;
  }

  // ------------------------------------------------------------------------------------------------ helpers

  private async requireProject(projectId: string): Promise<void> {
    const found = await this.prisma.project.findFirst({ where: { id: projectId, archivedAt: null }, select: { id: true } });
    if (!found) throw invalid('project_not_found', 'That project does not exist.');
  }

  /** "This puts Ali Raza at 46 h of 40 h this week." when the person's open work plus the new hours go over their weekly capacity. */
  private async overloadWarning(person: Person, addedHours: number): Promise<TaskWarning | null> {
    const open = await this.prisma.task.findMany({
      where: { assigneeId: person.id, personal: false, status: { in: [...OPEN_STATUSES] } },
      select: { status: true, personal: true, estimatedHours: true },
    });
    const check = workloadAfter({
      openHours: openHours(open.map((t) => ({ status: t.status, personal: t.personal, estimatedHours: num(t.estimatedHours) }))),
      addedHours,
      capacity: person.weeklyCapacityHours,
    });
    const issue = workloadWarning(person.fullName, person.empId, check);
    return issue ? toWarning(issue) : null;
  }
}
