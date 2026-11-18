/**
 * Module 5 service functions. Each one talks to the real API when Module 5 is live (NEXT_PUBLIC_LIVE_MODULES contains
 * m5, or NEXT_PUBLIC_API_MODE=live) and to the in-browser mock otherwise; each JSDoc names the real endpoint (spec §7.3).
 * Other modules may read tasksTable() in mock mode (e.g. Performance, People offboarding).
 * Live, the server decides everything (who may assign, review or decide, the status machine, the size table, the working
 * days); the checks in the mock branches only mirror it so the demo behaves the same.
 */
import type {
  AttachmentView, ExtensionView, HolidayView, ProjectView, SizeRuleView, StatusChangeView, TaskCommentView, TaskDetailResponse, TaskView, WorkloadRowView,
} from "@aceva/contracts";
import { http, isLive } from "@/lib/api/http";
import { ApiError, mock, notFound } from "@/lib/api/mock";
import { descendantsOf, scopeOf } from "@/lib/auth/scope";
import { getViewer } from "@/lib/auth/viewer";
import { employeesTable } from "@/lib/directory";
import { uid } from "@/lib/utils";
import { nextNumber, table } from "@/mocks/db";
import { HOLIDAYS } from "@/mocks/seed/calendar";
import { PROJECTS, seedComments, seedExtensions, seedPersonalTodos, seedStatusHistory, seedTasks } from "@/mocks/seed/tasks";
import type { Attachment } from "@/types";
import { actionFor, computeOverdue, isOpen, openHours, SIZE_RULES, sizeRule, STATUS_LABEL } from "./logic";
import type { ExtensionRequest, NewTaskInput, Project, SizeRule, StatusChange, Task, TaskComment, TaskListParams, TaskStatus, WorkloadRow } from "./types";

/** Is Module 5 talking to the real server? (NEXT_PUBLIC_LIVE_MODULES contains m5, or NEXT_PUBLIC_API_MODE=live) */
const live = () => isLive("m5");

export const tasksTable = () => table<Task>("tasks.tasks", () => [...seedTasks(), ...seedPersonalTodos()]);
const commentsTable = () => table<TaskComment>("tasks.comments", seedComments);
export const extensionsTable = () => table<ExtensionRequest>("tasks.extensions", seedExtensions);
const historyTable = () => table<StatusChange>("tasks.history", () => seedStatusHistory(tasksTable()));

const fresh = (t: Task): Task => ({ ...t, isOverdue: computeOverdue(t) });

function canSee(t: Task, me: string) {
  if (t.personal) return t.assignee === me;
  return t.assignee === me || t.assignedBy === me || scopeOf(me).has(t.assignee);
}

function log(taskId: string, from: TaskStatus | null, to: TaskStatus, by: string, reason?: string) {
  historyTable().push({ id: uid("sh"), taskId, from, to, by, at: new Date().toISOString(), reason });
}

export interface TaskDetail {
  task: Task;
  comments: TaskComment[];
  extensions: ExtensionRequest[];
  history: StatusChange[];
  /** Emp-ID of the person who reviews this task now (the assigner, a stand-in, or the next level up); null for a personal to-do. */
  reviewer: string | null;
  /**
   * Emp-ID of who may hold, cancel, edit, move the deadline, add steps or attach files as the assigner right now: the
   * assigner while he is here and holds task.assign, otherwise the first person up the line who does; null for a personal to-do.
   */
  actingAssigner: string | null;
}

/** What the screens may tell the transition about the task, to save a request (otherwise it is read from the server first). */
export interface TransitionOptions {
  reason?: string;
  rating?: number;
  comment?: string;
  from?: TaskStatus;
  personal?: boolean;
}

/** The functions every screen uses; the mock and the live versions below both have exactly this shape. */
export interface TasksApi {
  list(params: TaskListParams): Promise<Task[]>;
  get(id: string): Promise<TaskDetail>;
  create(input: NewTaskInput): Promise<Task>;
  transition(id: string, to: TaskStatus, opts?: TransitionOptions): Promise<void>;
  changeDeadline(id: string, deadline: string, reason: string, confirmWarnings?: boolean): Promise<void>;
  toggleChecklist(id: string, itemId: string): Promise<void>;
  comment(id: string, body: string, file?: File): Promise<TaskComment>;
  requestExtension(id: string, requestedDeadline: string, reason: string): Promise<void>;
  decideExtension(extId: string, approve: boolean, reason?: string): Promise<void>;
  workload(): Promise<WorkloadRow[]>;
  attach(id: string, file: File): Promise<Attachment>;
  downloadAttachment(taskId: string, file: Pick<Attachment, "id" | "fileName">): Promise<boolean>;
  stopRepeat(id: string, reason?: string): Promise<void>;
  projects(): Promise<Project[]>;
  sizeRules(): Promise<SizeRule[]>;
  holidays(): Promise<Array<{ date: string; name: string }>>;
}

const mockTasksApi: TasksApi = {
  /** GET /tasks?scope=mine|team|all&assignee= */
  list: (params: TaskListParams) =>
    mock(() => {
      const me = getViewer().employee.empId;
      const team = new Set(descendantsOf(me));
      return tasksTable()
        .filter((t) => canSee(t, me))
        .filter((t) => {
          if (params.scope === "mine") return t.assignee === me && (params.includePersonal || !t.personal);
          if (params.scope === "team") return !t.personal && team.has(t.assignee);
          return params.includePersonal || !t.personal;
        })
        .filter((t) => !params.assignee || t.assignee === params.assignee)
        .filter((t) => !params.open || isOpen(t.status))
        .map(fresh);
    }),

  /** GET /tasks/:id (+ comments, extensions, history) */
  get: (id: string) =>
    mock<TaskDetail>(() => {
      const me = getViewer().employee.empId;
      const task = tasksTable().find((t) => t.id === id || t.number === id);
      if (!task || !canSee(task, me)) notFound("Task");
      return {
        task: fresh(task),
        comments: commentsTable().filter((c) => c.taskId === task.id),
        extensions: extensionsTable().filter((e) => e.taskId === task.id),
        history: historyTable().filter((h) => h.taskId === task.id).sort((a, b) => a.at.localeCompare(b.at)),
        reviewer: task.personal ? null : task.assignedBy,
        actingAssigner: task.personal ? null : task.assignedBy,
      };
    }),

  /** POST /tasks */
  create: (input: NewTaskInput) =>
    mock(() => {
      const me = getViewer().employee.empId;
      if (!input.personal && !descendantsOf(me).includes(input.assignee)) throw new ApiError("forbidden", "You can only assign tasks to people below you.", 403);
      if (input.size === "XL" && !input.personal) throw new ApiError("validation", "XL tasks must be split before they are assigned.");
      if (new Date(input.deadline).getTime() < Date.now()) throw new ApiError("validation", "A deadline can't be in the past.");
      const n = nextNumber("task", 150);
      const now = new Date().toISOString();
      const task: Task = {
        id: uid("tsk"),
        number: input.personal ? `TODO-${n}` : `TSK-${String(n).padStart(4, "0")}`,
        title: input.title,
        description: input.description,
        assignee: input.personal ? me : input.assignee,
        assignedBy: me,
        projectId: input.projectId || undefined,
        priority: input.priority,
        size: input.size,
        points: input.personal ? 0 : sizeRule(input.size).points,
        estimatedHours: input.estimatedHours,
        startDate: input.startDate,
        deadline: input.deadline,
        originalDeadline: input.deadline,
        status: "assigned",
        isOverdue: false,
        checklist: input.checklist.filter(Boolean).map((text) => ({ id: uid("chk"), text, done: false })),
        attachments: [],
        repeat: input.repeat,
        personal: !!input.personal,
        extensionsCount: 0,
        createdAt: now,
        updatedAt: now,
      };
      tasksTable().unshift(task);
      log(task.id, null, "assigned", me);
      return task;
    }),

  /** POST /tasks/:id/{start|submit|review|approve|rework|hold|cancel|resume|done|reopen} (the action follows from the current status and `to`) */
  transition: (id: string, to: TaskStatus, opts: TransitionOptions = {}) =>
    mock(() => {
      const me = getViewer().employee.empId;
      const t = tasksTable().find((x) => x.id === id);
      if (!t) notFound("Task");
      if (to === "approved" && !opts.rating) throw new ApiError("validation", "A rating from 1 to 5 is required.");
      if (["rework", "on_hold", "cancelled"].includes(to) && !opts.reason) throw new ApiError("validation", "A reason is required.");
      const from = t.status;
      t.status = to;
      t.updatedAt = new Date().toISOString();
      if (to === "submitted") t.submittedAt = t.updatedAt;
      if (to === "approved") {
        t.rating = opts.rating as Task["rating"];
        t.reviewComment = opts.comment;
      }
      if (to === "rework") t.reviewComment = opts.reason;
      log(t.id, from, to, me, opts.reason ?? opts.comment);
    }),

  /** PATCH /tasks/:id { deadline, reason } (manager change, reason required; live: confirmWarnings after a too-short warning) */
  changeDeadline: (id: string, deadline: string, reason: string) =>
    mock(() => {
      const t = tasksTable().find((x) => x.id === id);
      if (!t) notFound("Task");
      t.deadline = deadline;
      t.updatedAt = new Date().toISOString();
      log(t.id, t.status, t.status, getViewer().employee.empId, `Deadline changed: ${reason}`);
    }),

  /** PATCH /tasks/:id/checklist/:itemId */
  toggleChecklist: (id: string, itemId: string) =>
    mock(() => {
      const item = tasksTable().find((x) => x.id === id)?.checklist.find((c) => c.id === itemId);
      if (item) item.done = !item.done;
    }, { delay: 60 }),

  /** POST /tasks/:id/comments (JSON { body }, or multipart body + file) */
  comment: (id: string, body: string, file?: File) =>
    mock(() => {
      const me = getViewer().employee.empId;
      const mentions = employeesTable()
        .filter((e) => body.includes(`@${e.name.split(" ")[0]}`))
        .map((e) => e.empId);
      const c: TaskComment = { id: uid("cm"), taskId: id, author: me, body, mentions, attachments: file ? [mockAttachment(file, me)] : [], at: new Date().toISOString() };
      commentsTable().push(c);
      return c;
    }),

  /** POST /tasks/:id/extensions */
  requestExtension: (id: string, requestedDeadline: string, reason: string) =>
    mock(() => {
      const me = getViewer().employee.empId;
      const t = tasksTable().find((x) => x.id === id);
      if (!t) notFound("Task");
      extensionsTable().push({
        id: uid("ext"),
        taskId: id,
        requestedBy: me,
        currentDeadline: t.deadline,
        requestedDeadline,
        reason,
        status: "pending",
        late: new Date(t.deadline).getTime() < Date.now(),
        at: new Date().toISOString(),
      });
    }),

  /** POST /extensions/:id/{approve|reject} */
  decideExtension: (extId: string, approve: boolean, reason?: string) =>
    mock(() => {
      const me = getViewer().employee.empId;
      const ext = extensionsTable().find((e) => e.id === extId);
      if (!ext) notFound("Extension request");
      ext.status = approve ? "approved" : "rejected";
      ext.decidedBy = me;
      ext.decidedAt = new Date().toISOString();
      const t = tasksTable().find((x) => x.id === ext.taskId);
      if (t && approve) {
        t.deadline = ext.requestedDeadline;
        t.extensionsCount += 1;
      }
      if (t) log(t.id, t.status, t.status, me, approve ? "Extension approved: new deadline saved" : `Extension rejected: ${reason ?? ""}`);
    }),

  /** GET /tasks/workload?scope=team */
  workload: () =>
    mock<WorkloadRow[]>(() => {
      const me = getViewer().employee.empId;
      const team = descendantsOf(me);
      const all = tasksTable();
      return employeesTable()
        .filter((e) => team.includes(e.empId) && e.status !== "left")
        .map((e) => ({
          empId: e.empId,
          openHours: openHours(all, e.empId),
          capacity: e.weeklyCapacityHours,
          openTasks: all.filter((t) => t.assignee === e.empId && !t.personal && isOpen(t.status)).length,
        }));
    }),

  /** POST /tasks/:id/attachments (multipart file; PDF, PNG, JPEG or .docx, 10 MB; stored privately) */
  attach: (id: string, file: File) =>
    mock(() => {
      const t = tasksTable().find((x) => x.id === id);
      if (!t) notFound("Task");
      const a = mockAttachment(file, getViewer().employee.empId);
      t.attachments.push(a);
      return a;
    }),

  /** GET /tasks/:id/attachments/:attachmentId/download (permission-checked and logged). Resolves false when nothing was saved (demo). */
  downloadAttachment: () => mock(() => false, { delay: 60 }),

  /** POST /tasks/:id/repeat/stop { reason? }: ends the repeating series (tasks already made stay) */
  stopRepeat: (id: string, reason?: string) =>
    mock(() => {
      const t = tasksTable().find((x) => x.id === id);
      if (!t?.repeat) notFound("Repeating task");
      t.repeat = { ...t.repeat, active: false };
      log(t.id, t.status, t.status, getViewer().employee.empId, reason ? `Repeat stopped: ${reason}` : "Repeat stopped");
    }),

  /** GET /projects */
  projects: () => mock(() => PROJECTS, { delay: 60 }),
  /** GET /settings/task-sizes */
  sizeRules: () => mock(() => SIZE_RULES, { delay: 60 }),
  /** GET /holidays */
  holidays: () => mock(() => HOLIDAYS, { delay: 60 }),
};

function mockAttachment(file: File, by: string): Attachment {
  return { id: uid("att"), fileName: file.name, sizeBytes: file.size, mimeType: file.type || "application/octet-stream", uploadedAt: new Date().toISOString(), uploadedBy: by };
}

/** The warning sentences of a 409 "confirmation_required" answer (the screen asks the person, then sends the request again with confirmWarnings), or null for any other error. */
export function confirmationWarnings(err: unknown): string[] | null {
  if (!(err instanceof ApiError) || err.code !== "confirmation_required") return null;
  const lines = err.details?.warnings;
  return lines?.length ? lines : [err.message];
}

/* ---------------- Live: the server's shapes mapped exactly to types.ts ---------------- */

const mapAttachment = (a: AttachmentView): Attachment => ({
  id: a.id,
  fileName: a.fileName,
  sizeBytes: a.sizeBytes,
  mimeType: a.mimeType,
  uploadedAt: a.uploadedAt,
  uploadedBy: a.uploadedBy,
});

const mapTask = (t: TaskView): Task => ({
  id: t.id,
  number: t.number,
  title: t.title,
  description: t.description ?? "",
  assignee: t.assignee,
  assignedBy: t.assignedBy,
  projectId: t.projectId ?? undefined,
  goalId: t.goalId ?? undefined,
  priority: t.priority,
  size: t.size,
  points: t.points,
  estimatedHours: t.estimatedHours,
  startDate: t.startDate,
  deadline: t.deadline,
  originalDeadline: t.originalDeadline,
  status: t.status,
  isOverdue: t.isOverdue,
  checklist: t.checklist.map((c) => ({ id: c.id, text: c.text, done: c.done })),
  attachments: t.attachments.map(mapAttachment),
  repeat: t.repeat ? { every: t.repeat.every, on: t.repeat.on, until: t.repeat.until ?? undefined, active: t.repeat.active ?? undefined } : undefined,
  personal: t.personal,
  rating: t.rating ?? undefined,
  reviewComment: t.reviewComment ?? undefined,
  submittedAt: t.submittedAt ?? undefined,
  extensionsCount: t.extensionsCount,
  reworkCount: t.reworkCount ?? undefined,
  createdAt: t.createdAt,
  updatedAt: t.updatedAt,
});

const mapComment = (c: TaskCommentView): TaskComment => ({
  id: c.id,
  taskId: c.taskId,
  author: c.author,
  body: c.body,
  mentions: c.mentions,
  attachments: c.attachments.map(mapAttachment),
  at: c.at,
});

const mapExtension = (e: ExtensionView): ExtensionRequest => ({
  id: e.id,
  taskId: e.taskId,
  requestedBy: e.requestedBy,
  currentDeadline: e.currentDeadline,
  requestedDeadline: e.requestedDeadline,
  reason: e.reason,
  status: e.status,
  late: e.late,
  decidedBy: e.decidedBy ?? undefined,
  decidedAt: e.decidedAt ?? undefined,
  decisionReason: e.decisionReason ?? undefined,
  at: e.at,
});

const mapHistory = (h: StatusChangeView): StatusChange => ({
  id: h.id,
  taskId: h.taskId,
  from: h.from ?? null,
  to: h.to,
  by: h.by,
  at: h.at,
  reason: h.reason ?? undefined,
  kind: h.kind,
  details: h.details ?? undefined,
});

const mapDetail = (d: TaskDetailResponse): TaskDetail => ({
  task: mapTask(d.task),
  comments: d.comments.map(mapComment),
  extensions: d.extensions.map(mapExtension),
  history: d.history.map(mapHistory),
  reviewer: d.reviewer ?? null,
  actingAssigner: d.actingAssigner ?? null,
});

const mapSizeRule = (r: SizeRuleView): SizeRule => ({ size: r.size, meaning: r.meaning, hours: r.hours, hoursLabel: r.hoursLabel, points: r.points, days: r.days ?? null });

const enc = encodeURIComponent;

/** The request body of one status action (the server needs a rating to approve and a reason to send back, hold or cancel). */
function actionBody(action: string, opts: TransitionOptions, personal: boolean): Record<string, unknown> {
  switch (action) {
    case "approve":
      if (!opts.rating) throw new ApiError("validation", "A rating from 1 to 5 is required.");
      return { rating: opts.rating, ...(opts.comment?.trim() ? { comment: opts.comment.trim() } : {}) };
    case "rework":
    case "hold":
      if (!opts.reason?.trim()) throw new ApiError("validation", "A reason is required.");
      return { reason: opts.reason.trim() };
    case "cancel":
      // A personal to-do needs no real reason, but the route still asks for three characters.
      if (!opts.reason?.trim() && !personal) throw new ApiError("validation", "A reason is required.");
      return { reason: opts.reason?.trim() || "No longer needed" };
    case "resume":
      return opts.reason?.trim() ? { reason: opts.reason.trim() } : {};
    default:
      return {};
  }
}

/** This year and the next one, so a deadline near the year end still skips the holidays of January. */
const holidayYears = () => {
  const y = new Date().getFullYear();
  return [y, y + 1];
};

/**
 * Module 5 against the REAL API. Same names and result shapes as the mock above, so the screens do not change. The
 * server applies every rule: assigning only down the hierarchy and only by task.assign holders, the reviewer being the
 * assigner (or a stand-in) and never the assignee, the status machine, extensions before the deadline, the size table,
 * working days with holidays. Soft warnings come back as 409 confirmation_required (see confirmationWarnings).
 */
const liveTasksApi: TasksApi = {
  /** GET /tasks?scope=mine|team|all&assignee=&includePersonal=&open=&closed=recent|all (default: closed tasks of the last 90 days) */
  list: async (params) =>
    (
      await http.get<TaskView[]>("/tasks", {
        scope: params.scope,
        assignee: params.assignee || undefined,
        includePersonal: params.includePersonal ? true : undefined,
        open: params.open ? true : undefined,
        closed: params.closed,
      })
    ).map(mapTask),

  /** GET /tasks/:id: the task with its comments, extension requests, history and reviewer */
  get: async (id) => mapDetail(await http.get<TaskDetailResponse>(`/tasks/${enc(id)}`)),

  /** POST /tasks (409 confirmation_required until confirmWarnings is true) */
  create: async (input) =>
    mapTask(
      await http.post<TaskView>("/tasks", {
        title: input.title,
        description: input.description,
        ...(input.personal ? { personal: true } : { assignee: input.assignee }),
        ...(input.projectId ? { projectId: input.projectId } : {}),
        priority: input.priority,
        size: input.size,
        estimatedHours: input.estimatedHours,
        startDate: input.startDate,
        deadline: input.deadline,
        checklist: input.checklist,
        ...(input.repeat ? { repeat: { every: input.repeat.every, on: input.repeat.on, ...(input.repeat.until ? { until: input.repeat.until } : {}) } } : {}),
        ...(input.confirmWarnings ? { confirmWarnings: true } : {}),
      }),
    ),

  /** POST /tasks/:id/{start|submit|review|approve|rework|hold|cancel|resume|done|reopen}, chosen from the current status and `to` */
  transition: async (id, to, opts = {}) => {
    const current = opts.from !== undefined && opts.personal !== undefined ? { status: opts.from, personal: opts.personal } : (await http.get<TaskDetailResponse>(`/tasks/${enc(id)}`)).task;
    const action = actionFor(current.status, to, current.personal);
    if (!action) throw new ApiError("not_allowed", `A task that is ${STATUS_LABEL[current.status].toLowerCase()} can't be moved to ${STATUS_LABEL[to].toLowerCase()}.`, 400);
    await http.post<TaskView>(`/tasks/${enc(id)}/${action}`, actionBody(action, opts, current.personal));
  },

  /** PATCH /tasks/:id { deadline, reason }: a manager change (the original deadline is kept); 409 confirmation_required for a too-short new deadline */
  changeDeadline: async (id, deadline, reason, confirmWarnings) => {
    await http.patch<TaskView>(`/tasks/${enc(id)}`, { deadline, reason, ...(confirmWarnings ? { confirmWarnings: true } : {}) });
  },

  /** PATCH /tasks/:id/checklist/:itemId */
  toggleChecklist: async (id, itemId) => {
    await http.patch(`/tasks/${enc(id)}/checklist/${enc(itemId)}`);
  },

  /** POST /tasks/:id/comments (JSON { body }, or multipart body + file); @Firstname and @ACV-0007 mention people */
  comment: async (id, body, file) => {
    if (!file) return mapComment(await http.post<TaskCommentView>(`/tasks/${enc(id)}/comments`, { body }));
    const form = new FormData();
    form.set("body", body);
    form.set("file", file, file.name);
    return mapComment(await http.upload<TaskCommentView>(`/tasks/${enc(id)}/comments`, form));
  },

  /** POST /tasks/:id/extensions { requestedDeadline, reason }: after the deadline the request counts as late */
  requestExtension: async (id, requestedDeadline, reason) => {
    await http.post<ExtensionView>(`/tasks/${enc(id)}/extensions`, { requestedDeadline, reason });
  },

  /** POST /extensions/:id/approve | /reject { reason } (the assigner decides) */
  decideExtension: async (extId, approve, reason) => {
    if (!approve && !reason?.trim()) throw new ApiError("validation", "A reason is required to reject.");
    await http.post<ExtensionView>(`/extensions/${enc(extId)}/${approve ? "approve" : "reject"}`, reason?.trim() ? { reason: reason.trim() } : {});
  },

  /** GET /tasks/workload: open hours against weekly capacity for each person below me */
  workload: async () => (await http.get<WorkloadRowView[]>("/tasks/workload")).map((r) => ({ empId: r.empId, openHours: r.openHours, capacity: r.capacity, openTasks: r.openTasks })),

  /** POST /tasks/:id/attachments (multipart file) */
  attach: async (id, file) => {
    const form = new FormData();
    form.set("file", file, file.name);
    return mapAttachment(await http.upload<AttachmentView>(`/tasks/${enc(id)}/attachments`, form));
  },

  /** GET /tasks/:id/attachments/:attachmentId/download: permission-checked and logged on the server */
  downloadAttachment: async (taskId, file) => {
    const blob = await http.blob(`/tasks/${enc(taskId)}/attachments/${enc(file.id)}/download`);
    const href = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = href;
    a.download = file.fileName;
    document.body.appendChild(a); // some browsers only honour the click when the link is in the page
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10_000);
    return true;
  },

  /** POST /tasks/:id/repeat/stop { reason? } */
  stopRepeat: async (id, reason) => {
    await http.post<TaskView>(`/tasks/${enc(id)}/repeat/stop`, reason?.trim() ? { reason: reason.trim() } : {});
  },

  /** GET /projects (read-only demo rows) */
  projects: async () => (await http.get<ProjectView[]>("/projects")).map((p) => ({ id: p.id, name: p.name, client: p.client ?? undefined })),

  /** GET /settings/task-sizes: XS to XL as the Director set them */
  sizeRules: async () => (await http.get<SizeRuleView[]>("/settings/task-sizes")).map(mapSizeRule),

  /** GET /holidays?year= for this year and the next */
  holidays: async () => {
    const years = await Promise.all(holidayYears().map((year) => http.get<HolidayView[]>("/holidays", { year })));
    return years.flat().map((h) => ({ date: h.date, name: h.name }));
  },
};

export const tasksApi: TasksApi = live() ? liveTasksApi : mockTasksApi;
