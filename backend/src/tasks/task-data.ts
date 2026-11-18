/**
 * Shared task data helpers, used by the core and the automation code alike: the Prisma "include" that loads a task with
 * everything its screens show, the mappers from database rows to the contract shapes (packages/contracts/src/tasks.ts),
 * task numbers, the history writer and the event payload builders.
 */
import type { AttachmentView, ExtensionView, HolidayView, OutboxEvent, ProjectView, SizeRuleChangeView, SizeRuleView, StatusChangeView, TaskCommentView, TaskStatusName, TaskView } from '@aceva/contracts';
import { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { formatTaskNumber } from './rules/task-format';
import { isOverdue } from './rules/task-status';

export type Db = PrismaService | Prisma.TransactionClient;

/** A Prisma Decimal (hours) as a plain number. */
export const num = (value: Prisma.Decimal | number | string): number => Number(value);
const iso = (d: Date): string => d.toISOString();
const day = (d: Date): string => d.toISOString().slice(0, 10);

// ---------------------------------------------------------------------------------------------------------- the task

/** Everything a task screen needs, in one query. Attachments are the task's own files (comment files load with the comment). */
export const TASK_INCLUDE = {
  assignee: { select: { empId: true } },
  assignedBy: { select: { empId: true } },
  checklist: { orderBy: { position: 'asc' } },
  attachments: { where: { archivedAt: null, commentId: null }, orderBy: { createdAt: 'asc' }, include: { uploadedBy: { select: { empId: true } } } },
  repeatRule: true,
  /** The latest review only: the rating and comment shown on the task. */
  reviews: { orderBy: { createdAt: 'desc' }, take: 1 },
} satisfies Prisma.TaskInclude;

export type TaskRow = Prisma.TaskGetPayload<{ include: typeof TASK_INCLUDE }>;

type AttachmentRow = Prisma.TaskAttachmentGetPayload<{ include: { uploadedBy: { select: { empId: true } } } }>;

export function toAttachmentView(a: AttachmentRow): AttachmentView {
  return { id: a.id, fileName: a.originalFilename, sizeBytes: a.sizeBytes, mimeType: a.mimeType, uploadedAt: iso(a.createdAt), uploadedBy: a.uploadedBy.empId };
}

/** The contract view of a task. `now` makes the overdue flag (never stored). */
export function toTaskView(row: TaskRow, now: Date): TaskView {
  const latest = row.reviews[0];
  const rule = row.repeatRule;
  return {
    id: row.id,
    number: row.number,
    title: row.title,
    description: row.description,
    assignee: row.assignee.empId,
    assignedBy: row.assignedBy.empId,
    projectId: row.projectId ?? undefined,
    goalId: row.goalId ?? undefined,
    priority: row.priority,
    size: row.size,
    points: row.points,
    estimatedHours: num(row.estimatedHours),
    startDate: iso(row.startDate),
    deadline: iso(row.deadline),
    originalDeadline: iso(row.originalDeadline),
    status: row.status,
    isOverdue: isOverdue({ status: row.status, deadline: row.deadline }, now),
    checklist: row.checklist.map((c) => ({ id: c.id, text: c.text, done: c.done })),
    attachments: row.attachments.map(toAttachmentView),
    repeat: rule ? { every: rule.every, on: rule.on, until: rule.until ? day(rule.until) : undefined, active: rule.active } : undefined,
    personal: row.personal,
    rating: row.status === 'approved' && latest?.decision === 'approved' && latest.rating ? (latest.rating as 1 | 2 | 3 | 4 | 5) : undefined,
    reviewComment: latest ? (latest.decision === 'approved' ? (latest.comment ?? undefined) : (latest.reason ?? undefined)) : undefined,
    submittedAt: row.submittedAt ? iso(row.submittedAt) : undefined,
    extensionsCount: row.extensionsCount,
    reworkCount: row.reworkCount,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

// ---------------------------------------------------------------------------------------------- comments, extensions, history

export const COMMENT_INCLUDE = {
  author: { select: { empId: true } },
  mentions: { select: { employee: { select: { empId: true } } } },
  attachments: { where: { archivedAt: null }, orderBy: { createdAt: 'asc' }, include: { uploadedBy: { select: { empId: true } } } },
} satisfies Prisma.TaskCommentInclude;
export type CommentRow = Prisma.TaskCommentGetPayload<{ include: typeof COMMENT_INCLUDE }>;

export function toCommentView(c: CommentRow): TaskCommentView {
  return { id: c.id, taskId: c.taskId, author: c.author.empId, body: c.body, mentions: c.mentions.map((m) => m.employee.empId), attachments: c.attachments.map(toAttachmentView), at: iso(c.createdAt) };
}

export const EXTENSION_INCLUDE = {
  requestedBy: { select: { empId: true } },
  decidedBy: { select: { empId: true } },
} satisfies Prisma.TaskExtensionInclude;
export type ExtensionRow = Prisma.TaskExtensionGetPayload<{ include: typeof EXTENSION_INCLUDE }>;

export function toExtensionView(e: ExtensionRow): ExtensionView {
  return {
    id: e.id,
    taskId: e.taskId,
    requestedBy: e.requestedBy.empId,
    currentDeadline: iso(e.currentDeadline),
    requestedDeadline: iso(e.requestedDeadline),
    reason: e.reason,
    status: e.status,
    late: e.late,
    decidedBy: e.decidedBy?.empId,
    decidedAt: e.decidedAt ? iso(e.decidedAt) : undefined,
    decisionReason: e.decisionReason ?? undefined,
    at: iso(e.createdAt),
  };
}

export const HISTORY_INCLUDE = { by: { select: { empId: true } } } satisfies Prisma.TaskHistoryInclude;
export type HistoryRow = Prisma.TaskHistoryGetPayload<{ include: typeof HISTORY_INCLUDE }>;

export function toHistoryView(h: HistoryRow): StatusChangeView {
  return {
    id: h.id,
    taskId: h.taskId,
    kind: h.kind,
    from: h.fromStatus,
    to: h.toStatus,
    by: h.by?.empId ?? 'system',
    at: iso(h.at),
    reason: h.reason ?? undefined,
    details: (h.details as Record<string, unknown> | null) ?? undefined,
  };
}

// ---------------------------------------------------------------------------------------------- settings and reference data

type SizeSettingRow = Prisma.TaskSizeSettingGetPayload<object>;

export function toSizeRuleView(r: SizeSettingRow): SizeRuleView {
  return { size: r.size, meaning: r.meaning, hours: num(r.hours), hoursLabel: r.hoursLabel, points: r.points, days: r.days };
}

export function toSizeRuleChangeView(c: Prisma.TaskSizeSettingChangeGetPayload<object>, changedByEmpId: string): SizeRuleChangeView {
  return { id: c.id, size: c.size, before: c.before as SizeRuleChangeView['before'], after: c.after as SizeRuleChangeView['after'], reason: c.reason, changedBy: changedByEmpId, changedAt: iso(c.changedAt) };
}

export const toProjectView = (p: Prisma.ProjectGetPayload<object>): ProjectView => ({ id: p.id, name: p.name, client: p.client ?? undefined });
export const toHolidayView = (h: Prisma.HolidayGetPayload<object>): HolidayView => ({ id: h.id, date: day(h.date), name: h.name });

// ---------------------------------------------------------------------------------------------------------- numbers and history

/** The next task number from its sequence: TSK-0001 for work, TODO-0001 for a personal to-do. Call inside the creating transaction. */
export async function nextTaskNumber(db: Db, personal: boolean): Promise<string> {
  const rows = personal
    ? await db.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('todo_number_seq')::bigint AS n`
    : await db.$queryRaw<Array<{ n: bigint }>>`SELECT nextval('task_number_seq')::bigint AS n`;
  return formatTaskNumber(rows[0].n, personal);
}

export interface HistoryEntry {
  taskId: string;
  kind: Prisma.TaskHistoryUncheckedCreateInput['kind'];
  /** The status before and after. For anything that is not a status change, pass the current status as both. */
  from: TaskStatusName | null;
  to: TaskStatusName;
  /** Internal employee id, or null for the system. */
  byId: string | null;
  reason?: string | null;
  details?: Prisma.InputJsonValue;
  at?: Date;
}

/** Adds one line to the insert-only history of a task. Call inside the transaction that made the change. */
export async function addTaskHistory(db: Db, e: HistoryEntry): Promise<void> {
  await db.taskHistory.create({
    data: { taskId: e.taskId, kind: e.kind ?? 'status', fromStatus: e.from, toStatus: e.to, byId: e.byId, reason: e.reason ?? null, details: e.details, at: e.at },
  });
}

// ---------------------------------------------------------------------------------------------------------- event payloads

type Payload<T extends OutboxEvent['type']> = Extract<OutboxEvent, { type: T }>['payload'];

/** Who and what every task event says about the task. */
export const taskRefOf = (row: TaskRow): { taskId: string; number: string } => ({ taskId: row.id, number: row.number });

export function createdPayload(row: TaskRow): Payload<'task.created'> {
  return {
    ...taskRefOf(row),
    assignee: row.assignee.empId,
    assignedBy: row.assignedBy.empId,
    personal: row.personal,
    size: row.size,
    points: row.points,
    estimatedHours: num(row.estimatedHours),
    startDate: iso(row.startDate),
    deadline: iso(row.deadline),
    repeatRuleId: row.repeatRuleId,
  };
}

export function statusChangedPayload(row: TaskRow, from: TaskStatusName, to: TaskStatusName, reason: string | null): Payload<'task.status_changed'> {
  return { ...taskRefOf(row), assignee: row.assignee.empId, assignedBy: row.assignedBy.empId, personal: row.personal, from, to, reason };
}
