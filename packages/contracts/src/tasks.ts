import { z } from 'zod';
import { empIdSchema, TASK_SIZES, TASK_STATUSES } from './events';

// ---------------------------------------------------------------------------
// Module 5: task management, size and deadline (plan section 9, spec section 9.5)
// The response shapes are exactly frontend/src/features/tasks/types.ts (plus the few optional fields marked "new").
// ---------------------------------------------------------------------------

export const taskSizeSchema = z.enum(TASK_SIZES);
export type TaskSizeName = z.infer<typeof taskSizeSchema>;

export const taskStatusSchema = z.enum(TASK_STATUSES);
export type TaskStatusName = z.infer<typeof taskStatusSchema>;

export const TASK_PRIORITIES = ['low', 'medium', 'high', 'urgent'] as const;
export const taskPrioritySchema = z.enum(TASK_PRIORITIES);
export type TaskPriorityName = z.infer<typeof taskPrioritySchema>;

/** What one line of a task's history is (task_history.kind). */
export const TASK_HISTORY_KINDS = [
  'created',
  'status',
  'deadline_changed',
  'extension_requested',
  'extension_approved',
  'extension_rejected',
  'reassigned',
  'transferred',
  'edited',
  'repeat_stopped',
] as const;
export type TaskHistoryKindName = (typeof TASK_HISTORY_KINDS)[number];

/**
 * The status buttons: POST /tasks/:id/{action}. `done` and `reopen` are only for a personal to-do (done = approved with
 * no review and no rating, reopen = back to assigned). `review` is the reviewer picking a submitted task up (submitted
 * to under_review).
 */
export const TASK_ACTIONS = ['start', 'submit', 'review', 'approve', 'rework', 'hold', 'cancel', 'resume', 'done', 'reopen'] as const;
export const taskActionSchema = z.enum(TASK_ACTIONS);
export type TaskActionName = z.infer<typeof taskActionSchema>;

const isoDate = z.iso.date();
/**
 * The earliest and the latest moment a task date may have (the years 2020 to 2100). A date outside that is a typing slip, never a
 * plan, and a far-off one used to be counted day by day on the server.
 */
export const TASK_DATE_MIN = '2020-01-01T00:00:00.000Z';
export const TASK_DATE_MAX = '2100-12-31T23:59:59.999Z';
const isoDateTime = z.iso.datetime().refine((value) => {
  const at = Date.parse(value);
  return at >= Date.parse(TASK_DATE_MIN) && at <= Date.parse(TASK_DATE_MAX);
}, 'Choose a date between 2020 and 2100');
/** Query strings arrive as text; an empty filter means no filter. */
const optionalFilter = <T extends z.ZodType>(schema: T) => z.preprocess((v) => (v === '' || v === null ? undefined : v), schema.optional());
/** How long a task that is approved or cancelled stays in the default list (GET /tasks): 90 days after it was closed. */
export const TASK_LIST_CLOSED_DAYS = 90;
const reasonText = (min: number) => z.string().trim().min(min, `Please give a reason (at least ${min} characters)`).max(500);

// ---------- shared pieces ----------

/** Weekly: on = 1 (Monday) to 7 (Sunday). Monthly: on = day of the month 1 to 28. `until` = last day (Pakistan time); no stop date = until stopped. */
export const repeatRuleSchema = z
  .object({
    every: z.enum(['week', 'month']),
    on: z.number().int().min(1).max(28),
    until: isoDate.optional(),
  })
  .refine((r) => r.every === 'month' || r.on <= 7, { path: ['on'], message: 'A weekly task repeats on a weekday, 1 (Monday) to 7 (Sunday)' });
export type RepeatRuleInput = z.infer<typeof repeatRuleSchema>;

// ---------- requests ----------

/**
 * GET /tasks?scope=mine|team|all&assignee=&status=&priority=&size=&projectId=&dueFrom=&dueTo=&includePersonal=&open=&closed=
 * `open=true` leaves out approved and cancelled tasks (a count of open work needs nothing else). Approved and cancelled tasks
 * older than TASK_LIST_CLOSED_DAYS days are left out of the list unless `closed=all` asks for them (the default is `recent`).
 */
export const taskListQuerySchema = z.object({
  scope: z.enum(['mine', 'team', 'all']).default('mine'),
  assignee: optionalFilter(empIdSchema),
  status: optionalFilter(taskStatusSchema),
  priority: optionalFilter(taskPrioritySchema),
  size: optionalFilter(taskSizeSchema),
  projectId: optionalFilter(z.uuid()),
  /** Deadline range, Pakistan days, both included. */
  dueFrom: optionalFilter(isoDate),
  dueTo: optionalFilter(isoDate),
  /** Only the viewer's OWN personal to-dos are ever included, and only when asked. */
  includePersonal: optionalFilter(z.enum(['true', 'false']).transform((v) => v === 'true')),
  open: optionalFilter(z.enum(['true', 'false']).transform((v) => v === 'true')),
  closed: optionalFilter(z.enum(['recent', 'all'])),
});
export type TaskListQuery = z.infer<typeof taskListQuerySchema>;

/**
 * POST /tasks. `assignee` is an Emp-ID below the caller (or empty for a personal to-do). When the server finds soft
 * warnings (a deadline shorter than the size normally needs, an overloaded week) and `confirmWarnings` is not true, it
 * answers 409 { code: "confirmation_required", warnings } and creates nothing; the screen asks and sends it again with
 * `confirmWarnings: true`. Hard errors (deadline in the past, XL, someone not below you) are always refused.
 */
export const createTaskRequestSchema = z
  .object({
    title: z.string().trim().min(2, 'Give the task a title').max(200),
    description: z.string().trim().max(10_000).default(''),
    assignee: z.union([empIdSchema, z.literal('')]).optional(),
    projectId: z.uuid().optional(),
    goalId: z.string().trim().min(1).max(80).optional(),
    priority: taskPrioritySchema.default('medium'),
    size: taskSizeSchema,
    estimatedHours: z.number().min(0.5, 'At least 0.5 hours').max(200),
    startDate: isoDateTime,
    deadline: isoDateTime,
    checklist: z.array(z.string().trim().min(1).max(300)).max(50).default([]),
    repeat: repeatRuleSchema.optional(),
    personal: z.boolean().optional(),
    confirmWarnings: z.boolean().optional(),
  })
  .strict()
  .superRefine((v, ctx) => {
    if (!v.personal && !v.assignee) ctx.addIssue({ code: 'custom', path: ['assignee'], message: 'Choose who will do this' });
    if (v.personal && v.assignee) ctx.addIssue({ code: 'custom', path: ['assignee'], message: 'A personal to-do belongs to you' });
    if (new Date(v.deadline).getTime() < new Date(v.startDate).getTime()) ctx.addIssue({ code: 'custom', path: ['deadline'], message: 'The deadline cannot be before the start date' });
    if (v.personal && v.repeat) ctx.addIssue({ code: 'custom', path: ['repeat'], message: 'Personal to-dos do not repeat' });
  });
export type CreateTaskRequest = z.infer<typeof createTaskRequestSchema>;

/**
 * PATCH /tasks/:id: the assigner (task.assign) edits a task that is still open. A new `deadline` on a work task needs a
 * `reason` (the server answers 400 reason_required; the owner of a personal to-do needs none) and is saved as a manager
 * change (the original deadline is kept). A new `assignee` hands the task to someone else below
 * the assigner. The size and its points never change after creation.
 */
export const updateTaskRequestSchema = z
  .object({
    title: z.string().trim().min(2).max(200).optional(),
    description: z.string().trim().max(10_000).optional(),
    priority: taskPrioritySchema.optional(),
    projectId: z.uuid().nullable().optional(),
    goalId: z.string().trim().min(1).max(80).nullable().optional(),
    estimatedHours: z.number().min(0.5).max(200).optional(),
    assignee: empIdSchema.optional(),
    deadline: isoDateTime.optional(),
    reason: reasonText(3).optional(),
    confirmWarnings: z.boolean().optional(),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'reason' && k !== 'confirmWarnings'), { message: 'Nothing to change' });
export type UpdateTaskRequest = z.infer<typeof updateTaskRequestSchema>;

/** An action without details (start, submit, review, done, reopen): an empty body is fine. */
export const emptyActionRequestSchema = z.object({}).strict().default({});
/** POST /tasks/:id/approve: a rating from 1 to 5 is required, a comment is optional. */
export const approveTaskRequestSchema = z.object({ rating: z.number().int().min(1, 'Choose a rating from 1 to 5').max(5), comment: z.string().trim().max(1000).optional() }).strict();
export type ApproveTaskRequest = z.infer<typeof approveTaskRequestSchema>;
/** POST /tasks/:id/{rework|hold|cancel}: a reason is required. */
export const reasonActionRequestSchema = z.object({ reason: reasonText(3) }).strict();
export type ReasonActionRequest = z.infer<typeof reasonActionRequestSchema>;
/** POST /tasks/:id/resume (put back to In progress): a reason is optional. */
export const resumeTaskRequestSchema = z.object({ reason: reasonText(3).optional() }).strict().default({});
export type ResumeTaskRequest = z.infer<typeof resumeTaskRequestSchema>;

/** POST /tasks/:id/checklist */
export const addChecklistItemRequestSchema = z.object({ text: z.string().trim().min(1).max(300) }).strict();
export type AddChecklistItemRequest = z.infer<typeof addChecklistItemRequestSchema>;

/** POST /tasks/:id/comments (also multipart: the same `body` field plus an optional `file`). Mentions are written @Firstname or @ACV-0007. */
export const addCommentRequestSchema = z.object({ body: z.string().trim().min(1, 'Write a comment').max(5000) }).strict();
export type AddCommentRequest = z.infer<typeof addCommentRequestSchema>;

/** POST /tasks/:id/extensions: before the deadline is on time; after it the request counts as late. */
export const requestExtensionRequestSchema = z.object({ requestedDeadline: isoDateTime, reason: reasonText(3) }).strict();
export type RequestExtensionRequest = z.infer<typeof requestExtensionRequestSchema>;

/** POST /extensions/:id/approve (reason optional) and /extensions/:id/reject (reason required). */
export const approveExtensionRequestSchema = z.object({ reason: reasonText(3).optional() }).strict().default({});
export const rejectExtensionRequestSchema = z.object({ reason: reasonText(3) }).strict();
export type ApproveExtensionRequest = z.infer<typeof approveExtensionRequestSchema>;
export type RejectExtensionRequest = z.infer<typeof rejectExtensionRequestSchema>;

/** POST /tasks/:id/repeat/stop: ends the repeating series the task belongs to (tasks already made stay). */
export const stopRepeatRequestSchema = z.object({ reason: reasonText(3).optional() }).strict().default({});
export type StopRepeatRequest = z.infer<typeof stopRepeatRequestSchema>;

/** GET /holidays?year=2026 (default: this year) */
export const holidaysQuerySchema = z.object({ year: optionalFilter(z.coerce.number().int().min(2020).max(2100)) });
export type HolidaysQuery = z.infer<typeof holidaysQuerySchema>;

/**
 * PATCH /settings/task-sizes/:size (the Director, settings.manage). XL stays "must be split": its days stay empty and it
 * can never be assigned. Old tasks keep the points and hours they were created with. A reason is required; the change is
 * kept in the history (GET /settings/task-sizes/changes).
 */
export const updateSizeRuleRequestSchema = z
  .object({
    meaning: z.string().trim().min(2).max(120).optional(),
    hours: z.number().min(0.5).max(500).optional(),
    hoursLabel: z.string().trim().min(1).max(60).optional(),
    points: z.number().int().min(0).max(100).optional(),
    days: z.number().int().min(0).max(60).optional(),
    reason: reasonText(5),
  })
  .strict()
  .refine((v) => Object.keys(v).some((k) => k !== 'reason'), { message: 'Nothing to change' });
export type UpdateSizeRuleRequest = z.infer<typeof updateSizeRuleRequestSchema>;

// ---------- responses ----------

export interface AttachmentView {
  id: string;
  fileName: string;
  sizeBytes: number;
  mimeType: string;
  uploadedAt: string;
  /** Emp-ID. */
  uploadedBy: string;
}

export interface ChecklistItemView {
  id: string;
  text: string;
  done: boolean;
}

export interface RepeatRuleView {
  every: 'week' | 'month';
  on: number;
  /** New: the stop date, if any. */
  until?: string;
  /** New: false once the series was stopped. */
  active?: boolean;
}

export interface TaskView {
  id: string;
  number: string;
  title: string;
  description: string;
  /** Emp-ID of the person doing it. */
  assignee: string;
  /** Emp-ID of the person who assigned it. */
  assignedBy: string;
  projectId?: string;
  goalId?: string;
  priority: TaskPriorityName;
  size: TaskSizeName;
  points: number;
  estimatedHours: number;
  startDate: string;
  deadline: string;
  originalDeadline: string;
  status: TaskStatusName;
  /** Computed from the deadline and the status; never stored. */
  isOverdue: boolean;
  checklist: ChecklistItemView[];
  attachments: AttachmentView[];
  repeat?: RepeatRuleView;
  /** A personal to-do: not scored, not visible to managers. */
  personal: boolean;
  /** The rating of the latest review, only while the task is approved. */
  rating?: 1 | 2 | 3 | 4 | 5;
  /** The latest review's comment (approved) or reason (rework). */
  reviewComment?: string;
  submittedAt?: string;
  extensionsCount: number;
  /** New. */
  reworkCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface TaskCommentView {
  id: string;
  taskId: string;
  /** Emp-ID. */
  author: string;
  body: string;
  /** Emp-IDs. */
  mentions: string[];
  attachments: AttachmentView[];
  at: string;
}

export interface ExtensionView {
  id: string;
  taskId: string;
  requestedBy: string;
  currentDeadline: string;
  requestedDeadline: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected';
  late: boolean;
  decidedBy?: string;
  decidedAt?: string;
  /** New: why it was rejected. */
  decisionReason?: string;
  at: string;
}

/** One line of the task history. `by` is an Emp-ID, or "system" (repeating series, leaver hand-over, jobs). */
export interface StatusChangeView {
  id: string;
  taskId: string;
  /** New: what the line is. Everything except "status" is shown with from = to = the status at that moment. */
  kind: TaskHistoryKindName;
  from: TaskStatusName | null;
  to: TaskStatusName;
  by: string;
  at: string;
  reason?: string;
  /** New: small extras, for example { fromDeadline, toDeadline } or { fromEmpId, toEmpId }. */
  details?: Record<string, unknown>;
}

export interface TaskDetailResponse {
  task: TaskView;
  comments: TaskCommentView[];
  extensions: ExtensionView[];
  history: StatusChangeView[];
  /** New: who reviews this task now (the assigner, a stand-in, or the next level up); null for a personal to-do. */
  reviewer: string | null;
  /**
   * New: who acts as the assigner now (holds, cancels, edits, moves the deadline): the person who assigned it while he is here
   * and can assign, otherwise the first person up the line who can; null for a personal to-do.
   */
  actingAssigner: string | null;
}

export interface SizeRuleView {
  size: TaskSizeName;
  meaning: string;
  hours: number;
  hoursLabel: string;
  points: number;
  /** Suggested working days; null = must be split. */
  days: number | null;
}

export interface SizeRuleChangeView {
  id: string;
  size: TaskSizeName;
  before: Omit<SizeRuleView, 'size'>;
  after: Omit<SizeRuleView, 'size'>;
  reason: string;
  /** Emp-ID. */
  changedBy: string;
  changedAt: string;
}

export interface ProjectView {
  id: string;
  name: string;
  client?: string;
}

export interface HolidayView {
  id: string;
  /** YYYY-MM-DD. */
  date: string;
  name: string;
}

export interface WorkloadRowView {
  empId: string;
  openHours: number;
  capacity: number;
  openTasks: number;
}

/** A soft warning the person must confirm before the task is created (see createTaskRequestSchema). */
export const TASK_WARNING_CODES = ['deadline_too_short', 'overloaded'] as const;
export type TaskWarningCode = (typeof TASK_WARNING_CODES)[number];

export interface TaskWarning {
  code: TaskWarningCode;
  /** The sentence to show, for example "An M task usually needs 3 working days; you set 1. Continue?" */
  message: string;
  /** deadline_too_short: { size, neededDays, givenDays }. overloaded: { empId, openHours, addedHours, capacity }. */
  details: Record<string, string | number>;
}

/** The body of the 409 answer to POST /tasks (or PATCH /tasks/:id with a deadline) that needs a confirmation. */
export interface ConfirmationRequiredBody {
  statusCode: 409;
  code: 'confirmation_required';
  message: string;
  warnings: TaskWarning[];
}
