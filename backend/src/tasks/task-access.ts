/**
 * Helpers shared by the Module 5 core services (tasks, workflow, comments, settings, approvals): who may see a task,
 * loading a task the actor may see, the standard error answers, and a few small queries. Plain functions, no Nest.
 *
 * Visibility (plan section 9): a personal to-do is seen by its owner alone; a work task by the person doing it, the
 * person who assigned it and everyone above the assignee in the reporting line (the CEO / Founder / Owner's line is the
 * whole company, so he sees every work task, read only). The rule is applied INSIDE the database query (ScopeService),
 * for lists and for single tasks alike. rules/task-people.ts canSeeTask is the same rule written for unit tests.
 */
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import type { TaskCommentView, TaskWarning, TaskWarningCode } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import type { ScopeService } from '../access/scope.service';
import { noteActivity } from '../common/request-context';
import type { Prisma } from '../generated/prisma/client';
import type { TaskIssue } from './rules/task-deadlines';
import { parseTaskNumber } from './rules/task-format';
import { COMMENT_INCLUDE, type Db, TASK_INCLUDE, toCommentView, type TaskRow } from './task-data';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---------------------------------------------------------------------------------------------------------- errors

/** 404 for a task that does not exist or that the person may not see (never revealed which). */
export const taskNotFound = (): NotFoundException => new NotFoundException({ statusCode: 404, code: 'not_found', message: 'Task not found' });
/** 403 for a person who may see the task but may not do this to it (or may not assign at all). */
export const notAllowed = (message = 'You are not allowed to do this.'): ForbiddenException => new ForbiddenException({ statusCode: 403, code: 'not_allowed', message });
/** 403 for "you may not assign that" and other permission refusals. */
export const forbidden = (message: string): ForbiddenException => new ForbiddenException({ statusCode: 403, code: 'forbidden', message });
/** 400 for broken input and rule errors; `code` is the rule's code. */
export const invalid = (code: string, message: string): BadRequestException => new BadRequestException({ statusCode: 400, code, message });
/** 409 for state conflicts. */
export const conflict = (code: string, message: string): ConflictException => new ConflictException({ statusCode: 409, code, message });

/** The first rule error as a 400 answer. */
export const firstIssue = (issues: readonly TaskIssue[]): BadRequestException => invalid(issues[0].code, issues[0].message);

/** A rule warning in the contract shape. */
export const toWarning = (issue: TaskIssue): TaskWarning => ({ code: issue.code as TaskWarningCode, message: issue.message, details: issue.details ?? {} });

/** The 409 answer for soft warnings the person must confirm (body: ConfirmationRequiredBody in the contracts). */
export function confirmationRequired(warnings: readonly TaskWarning[]): ConflictException {
  return new ConflictException({ statusCode: 409, code: 'confirmation_required', message: warnings.map((w) => w.message).join(' '), warnings });
}

// ---------------------------------------------------------------------------------------------------------- visibility

/**
 * The tasks `actor` may see, as a Prisma filter. A personal to-do: its owner. A work task: the assignee, the assigner, and
 * everyone above the assignee (the assignee's ancestors in the closure table, the assignee himself included).
 */
export function visibleTaskWhere(actor: Actor, scope: ScopeService): Prisma.TaskWhereInput {
  return {
    OR: [
      { personal: true, assigneeId: actor.id },
      { personal: false, OR: [{ assignedById: actor.id }, { assignee: scope.employeeWhere(actor.id, 'self_or_below') }] },
    ],
  };
}

/** Where-clause that finds a task by its UUID or by its number (TSK-0001 / TODO-0001); null when it is neither. */
export function taskKeyWhere(idOrNumber: string): Prisma.TaskWhereInput | null {
  if (UUID.test(idOrNumber)) return { id: idOrNumber.toLowerCase() };
  const number = idOrNumber.trim().toUpperCase();
  return parseTaskNumber(number) ? { number } : null;
}

/** The task if the actor may see it, else 404. */
export async function loadVisibleTask(db: Db, scope: ScopeService, actor: Actor, idOrNumber: string): Promise<TaskRow> {
  const key = taskKeyWhere(idOrNumber);
  if (!key) throw taskNotFound();
  const row = await db.task.findFirst({ where: { AND: [key, visibleTaskWhere(actor, scope)] }, include: TASK_INCLUDE });
  if (!row) throw taskNotFound();
  return row;
}

/** A task by its id with everything the screens need (inside a transaction, after it was locked). */
export const loadTask = (db: Db, id: string): Promise<TaskRow> => db.task.findUniqueOrThrow({ where: { id }, include: TASK_INCLUDE });

/** Locks the task row until the end of the transaction, so two people acting on it at the same moment are served one after the other. */
export async function lockTask(tx: Prisma.TransactionClient, taskId: string): Promise<void> {
  await tx.$queryRaw`SELECT id FROM tasks WHERE id = ${taskId}::uuid FOR UPDATE`;
}

/** The comments of a task, oldest first, as the screens show them. */
export async function commentViews(db: Db, taskId: string): Promise<TaskCommentView[]> {
  const rows = await db.taskComment.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' }, include: COMMENT_INCLUDE });
  return rows.map(toCommentView);
}

// ---------------------------------------------------------------------------------------------------------- activity timeline

/**
 * Words for the M4 activity timeline. A work task is named by its number. A personal to-do is private: the timeline says
 * only that something happened, never which to-do (no title, no number and no id: `hideTarget` stops the recorder from
 * taking the id out of the URL).
 */
export function noteTaskActivity(task: { personal: boolean; number: string }, description: string, personalDescription: string): void {
  if (task.personal) noteActivity({ description: personalDescription, hideTarget: true });
  else noteActivity({ target: task.number, description });
}

// ---------------------------------------------------------------------------------------------------------- small helpers

/** A date-only database value for a Pakistan day ("2026-11-19"). */
export const dateOnly = (day: string): Date => new Date(`${day}T00:00:00.000Z`);

/** "19 Nov 2026" in Pakistan time, for the approvals inbox subtitles. */
const PK_DAY = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Karachi', day: 'numeric', month: 'short', year: 'numeric' });
export const formatPkDay = (at: Date): string => PK_DAY.format(at);

/** Cuts long text for audit details (never the whole description of a task). */
export const clip = (text: string, max = 300): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** True when the error is the database refusing a duplicate (unique index). */
export function isUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; message?: string } | null;
  return e?.code === 'P2002' || /duplicate key|unique constraint/i.test(e?.message ?? '');
}
