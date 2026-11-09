/** Seed: tasks, comments, extensions, status history (Module 5). */
import type { ExtensionRequest, Priority, Project, StatusChange, Task, TaskComment, TaskSize, TaskStatus } from "@/features/tasks/types";
import { sizeRule } from "@/features/tasks/logic";
import { daysFromNow, minutesAgo, workdaysFromNow } from "../time";

export const PROJECTS: Project[] = [
  { id: "prj-ads", name: "Aceva Digital System", client: "Internal" },
  { id: "prj-northwind", name: "Northwind Studio website", client: "Northwind Studio" },
  { id: "prj-brightpath", name: "Bright Path Academy LMS", client: "Bright Path Academy" },
  { id: "prj-harbor", name: "Harbor & Co e-commerce", client: "Harbor & Co" },
  { id: "prj-ops", name: "Operations", client: "Internal" },
];

type Row = [
  title: string,
  assignee: string,
  assignedBy: string,
  size: TaskSize,
  status: TaskStatus,
  startWd: number,
  deadlineWd: number,
  priority: Priority,
  project?: string,
  extra?: Partial<Task>,
];

const ROWS: Row[] = [
  ["Build leave balance widget for the home screen", "ACV-0007", "ACV-0006", "M", "in_progress", -1, 2, "high", "prj-ads"],
  ["API contract for payroll lines", "ACV-0007", "ACV-0006", "S", "assigned", 0, 1, "urgent", "prj-ads"],
  ["Fix typo on the login screen", "ACV-0007", "ACV-0006", "XS", "submitted", -1, 0, "low", "prj-ads", { submittedAt: minutesAgo(90) }],
  ["Org chart tree component", "ACV-0007", "ACV-0006", "L", "approved", -9, -2, "medium", "prj-ads", { rating: 5, reviewComment: "Clean and fast. Great keyboard support." }],
  ["Unit tests for working-day calculator", "ACV-0007", "ACV-0006", "S", "rework", -3, -1, "medium", "prj-ads", { reviewComment: "Holidays crossing a weekend are not covered." }],
  ["Checkout flow for Harbor & Co", "ACV-0008", "ACV-0006", "L", "in_progress", -4, 3, "high", "prj-harbor"],
  ["Product listing filters", "ACV-0008", "ACV-0006", "M", "in_progress", -2, 1, "medium", "prj-harbor"],
  ["Payment gateway sandbox test", "ACV-0008", "ACV-0006", "M", "assigned", 0, 3, "high", "prj-harbor"],
  ["Database index review", "ACV-0008", "ACV-0006", "S", "submitted", -2, 0, "medium", "prj-ads", { submittedAt: minutesAgo(200) }],
  ["Course progress API for Bright Path", "ACV-0008", "ACV-0006", "M", "in_progress", -6, -1, "high", "prj-brightpath"],
  ["Shipping rules engine", "ACV-0008", "ACV-0006", "M", "assigned", 1, 5, "medium", "prj-harbor"],
  ["Payslip PDF layout", "ACV-0011", "ACV-0006", "M", "in_progress", -3, 1, "high", "prj-ads", { extensionsCount: 1 }],
  ["Strata icon set for the sidebar", "ACV-0011", "ACV-0006", "S", "submitted", -1, 1, "low", "prj-ads", { submittedAt: minutesAgo(45) }],
  ["Northwind homepage hero", "ACV-0011", "ACV-0006", "M", "approved", -10, -6, "medium", "prj-northwind", { rating: 4 }],
  ["Empty-state illustrations", "ACV-0011", "ACV-0006", "S", "under_review", -2, 0, "low", "prj-ads", { submittedAt: minutesAgo(300) }],
  ["Check-in card UI", "ACV-0013", "ACV-0006", "S", "in_progress", -1, 1, "medium", "prj-ads"],
  ["Write README for the tasks module", "ACV-0013", "ACV-0006", "XS", "assigned", 0, 0, "low", "prj-ads"],
  ["Learn the API contract process", "ACV-0013", "ACV-0006", "S", "approved", -6, -4, "low", "prj-ads", { rating: 4 }],
  ["Bright Path quiz builder", "ACV-0013", "ACV-0006", "M", "on_hold", -5, 2, "medium", "prj-brightpath"],
  ["Sprint plan for cycle 3", "ACV-0006", "ACV-0004", "S", "in_progress", -1, 1, "high", "prj-ads"],
  ["Review deployment checklist", "ACV-0006", "ACV-0004", "M", "assigned", 0, 3, "medium", "prj-ops"],
  ["Team code-review rota", "ACV-0006", "ACV-0004", "XS", "approved", -4, -3, "low", "prj-ops", { rating: 5 }],
  ["Prepare go-live employee list", "ACV-0005", "ACV-0003", "M", "in_progress", -2, 2, "high", "prj-ops"],
  ["Tracking policy wording", "ACV-0005", "ACV-0003", "S", "submitted", -2, 0, "high", "prj-ops", { submittedAt: minutesAgo(150) }],
  ["Opening balances import file", "ACV-0010", "ACV-0003", "L", "in_progress", -3, 4, "urgent", "prj-ops"],
  ["Bank reconciliation for October", "ACV-0010", "ACV-0003", "M", "approved", -8, -5, "high", "prj-ops", { rating: 4 }],
  ["Vendor list clean-up", "ACV-0010", "ACV-0003", "S", "assigned", 0, 1, "medium", "prj-ops"],
  ["Proposal deck for Harbor & Co", "ACV-0009", "ACV-0014", "M", "in_progress", -1, 2, "high", "prj-harbor"],
  ["Clean up duplicate leads from Fiverr", "ACV-0012", "ACV-0014", "S", "assigned", 0, 1, "medium"],
  ["Weekly sales report", "ACV-0014", "ACV-0003", "S", "assigned", 0, 1, "medium", "prj-ops", { repeat: { every: "week", on: 1 } }],
  ["Cancel: old CRM export", "ACV-0012", "ACV-0014", "XS", "cancelled", -5, -4, "low"],
];

const DESCRIPTIONS = [
  "Follow the API contract in spec.md and the Strata components. Keep it accessible and test at 360 px.",
  "Agree the fields with the backend developer first, then build. Add the contract to the module's types.ts.",
  "Small fix. Please attach a screenshot of the result when you submit.",
];

export function seedTasks(): Task[] {
  return ROWS.map(([title, assignee, assignedBy, size, status, startWd, deadlineWd, priority, projectId, extra], i) => {
    const rule = sizeRule(size);
    const deadline = workdaysFromNow(deadlineWd, "18:00");
    const original = extra?.extensionsCount ? workdaysFromNow(deadlineWd - 2, "18:00") : deadline;
    const open = !["approved", "cancelled", "submitted", "under_review"].includes(status);
    return {
      id: `tsk_${i + 1}`,
      number: `TSK-${String(120 + i).padStart(4, "0")}`,
      title,
      description: DESCRIPTIONS[i % DESCRIPTIONS.length],
      assignee,
      assignedBy,
      projectId,
      priority,
      size,
      points: rule.points,
      estimatedHours: rule.hours,
      startDate: workdaysFromNow(startWd, "09:00"),
      deadline,
      originalDeadline: original,
      status,
      isOverdue: open && new Date(deadline).getTime() < Date.now(),
      checklist: [
        { id: `c${i}a`, text: "Agree the details", done: status !== "assigned" },
        { id: `c${i}b`, text: "Build it", done: ["submitted", "under_review", "approved"].includes(status) },
        { id: `c${i}c`, text: "Self-test and attach evidence", done: ["submitted", "under_review", "approved"].includes(status) },
      ],
      attachments: i % 4 === 0 ? [{ id: `att${i}`, fileName: "brief.pdf", sizeBytes: 182_000, mimeType: "application/pdf", uploadedAt: daysFromNow(-2), uploadedBy: assignedBy }] : [],
      personal: false,
      extensionsCount: 0,
      createdAt: workdaysFromNow(startWd - 1, "10:00"),
      updatedAt: minutesAgo(30 + i * 17),
      ...extra,
    } satisfies Task;
  });
}

export function seedPersonalTodos(): Task[] {
  const base = seedTasks()[0];
  return [
    { ...base, id: "todo_1", number: "TODO-1", title: "Read the Strata spec section 3", personal: true, assignee: "ACV-0007", assignedBy: "ACV-0007", status: "assigned", size: "XS", points: 0, estimatedHours: 1, deadline: daysFromNow(0, "17:00"), originalDeadline: daysFromNow(0, "17:00"), checklist: [], attachments: [], isOverdue: false, projectId: undefined },
    { ...base, id: "todo_2", number: "TODO-2", title: "Book a pairing session with Nida", personal: true, assignee: "ACV-0007", assignedBy: "ACV-0007", status: "assigned", size: "XS", points: 0, estimatedHours: 1, deadline: daysFromNow(1, "12:00"), originalDeadline: daysFromNow(1, "12:00"), checklist: [], attachments: [], isOverdue: false, projectId: undefined },
  ];
}

export function seedComments(): TaskComment[] {
  return [
    { id: "cm1", taskId: "tsk_1", author: "ACV-0006", body: "Use the ProgressRing from shared for each leave type. @Mariam ping me if the balances API isn't ready.", mentions: ["ACV-0007"], attachments: [], at: minutesAgo(400) },
    { id: "cm2", taskId: "tsk_1", author: "ACV-0007", body: "Will do. Using mock data for now; switching once M7 lands.", mentions: [], attachments: [], at: minutesAgo(380) },
    { id: "cm3", taskId: "tsk_5", author: "ACV-0006", body: "Sent back: holidays that fall next to a weekend aren't covered by the tests.", mentions: [], attachments: [], at: minutesAgo(1500) },
    { id: "cm4", taskId: "tsk_12", author: "ACV-0011", body: "Asked for 2 more days: the accountant changed the payslip layout.", mentions: [], attachments: [], at: minutesAgo(130) },
  ];
}

export function seedExtensions(): ExtensionRequest[] {
  return [
    { id: "ext1", taskId: "tsk_12", requestedBy: "ACV-0011", currentDeadline: workdaysFromNow(1, "18:00"), requestedDeadline: workdaysFromNow(3, "18:00"), reason: "The accountant changed the payslip layout on Friday.", status: "pending", late: false, at: minutesAgo(130) },
    { id: "ext2", taskId: "tsk_6", requestedBy: "ACV-0008", currentDeadline: workdaysFromNow(1, "18:00"), requestedDeadline: workdaysFromNow(3, "18:00"), reason: "Waiting for payment gateway sandbox keys.", status: "approved", late: false, decidedBy: "ACV-0006", decidedAt: minutesAgo(3000), at: minutesAgo(3200) },
  ];
}

export function seedStatusHistory(tasks: Task[]): StatusChange[] {
  const out: StatusChange[] = [];
  const flow: TaskStatus[] = ["assigned", "in_progress", "submitted", "under_review", "approved"];
  tasks.forEach((t) => {
    const stop = flow.indexOf(t.status);
    const steps: TaskStatus[] =
      stop >= 0 ? flow.slice(0, stop + 1) : t.status === "rework" ? ["assigned", "in_progress", "submitted", "rework"] : ["assigned", t.status];
    steps.forEach((s, i) =>
      out.push({
        id: `sh_${t.id}_${i}`,
        taskId: t.id,
        from: i === 0 ? null : steps[i - 1],
        to: s,
        by: s === "approved" || s === "rework" || s === "under_review" || s === "assigned" || s === "on_hold" || s === "cancelled" ? t.assignedBy : t.assignee,
        at: new Date(new Date(t.createdAt).getTime() + i * 5 * 3600_000).toISOString(),
        reason: s === "rework" ? t.reviewComment : s === "on_hold" ? "Client paused the work" : s === "cancelled" ? "No longer needed" : undefined,
      }),
    );
  });
  return out;
}
