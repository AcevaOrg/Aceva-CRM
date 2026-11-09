/**
 * Module 5 service functions. Mock today; each JSDoc names the real endpoint (spec §7.3).
 * Other modules may read tasksTable() in mock mode (e.g. Performance, People offboarding).
 */
import { ApiError, mock, notFound } from "@/lib/api/mock";
import { descendantsOf, scopeOf } from "@/lib/auth/scope";
import { getViewer } from "@/lib/auth/viewer";
import { employeesTable } from "@/lib/directory";
import { uid } from "@/lib/utils";
import { nextNumber, table } from "@/mocks/db";
import { HOLIDAYS } from "@/mocks/seed/calendar";
import { PROJECTS, seedComments, seedExtensions, seedPersonalTodos, seedStatusHistory, seedTasks } from "@/mocks/seed/tasks";
import { computeOverdue, isOpen, openHours, SIZE_RULES, sizeRule } from "./logic";
import type { ExtensionRequest, NewTaskInput, StatusChange, Task, TaskComment, TaskListParams, TaskStatus, WorkloadRow } from "./types";

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
}

export const tasksApi = {
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

  /** POST /tasks/:id/{start|submit|approve|rework|hold|cancel|resume} */
  transition: (id: string, to: TaskStatus, opts: { reason?: string; rating?: number; comment?: string } = {}) =>
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

  /** PATCH /tasks/:id { deadline, reason } (manager change, reason required) */
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

  /** POST /tasks/:id/comments */
  comment: (id: string, body: string) =>
    mock(() => {
      const me = getViewer().employee.empId;
      const mentions = employeesTable()
        .filter((e) => body.includes(`@${e.name.split(" ")[0]}`))
        .map((e) => e.empId);
      const c: TaskComment = { id: uid("cm"), taskId: id, author: me, body, mentions, attachments: [], at: new Date().toISOString() };
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

  /** GET /projects */
  projects: () => mock(() => PROJECTS, { delay: 60 }),
  /** GET /settings/task-sizes */
  sizeRules: () => mock(() => SIZE_RULES, { delay: 60 }),
  /** GET /holidays */
  holidays: () => mock(() => HOLIDAYS, { delay: 60 }),
};
