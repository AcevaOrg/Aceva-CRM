"use client";
import * as React from "react";
import { useForm, Controller, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { CircleAlert, Info, Sparkles, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect, SegmentedControl } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { WorkloadBar } from "@/components/shared/metrics";
import { EmployeeSelect } from "@/components/shared/pickers";
import { ListSkeleton } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { ApiError } from "@/lib/api/mock";
import { descendantsOf } from "@/lib/auth/scope";
import { useViewer } from "@/lib/auth/viewer";
import { formatWeekdayLong } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { confirmationWarnings } from "../api";
import { useCreateTask, useHolidays, useProjects, useSizeRules, useSizeRulesState, useWorkload } from "../hooks";
import { deadlineHints, sizeRule, suggestedDeadline, TASK_DATE_INPUT_MAX, TASK_DATE_INPUT_MIN, TASK_DATETIME_INPUT_MAX, TASK_DATETIME_INPUT_MIN, type Hint } from "../logic";
import type { Priority, TaskSize } from "../types";
import { ConfirmWarningsDialog, SizePicker } from "./task-bits";

const pad = (n: number) => String(n).padStart(2, "0");
export const toDateInput = (d: Date) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const toLocalInput = (d: Date) => `${toDateInput(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

const schema = z.object({
  title: z.string().trim().min(4, "Give the task a clear title (4+ characters)."),
  description: z.string().trim().optional(),
  assignee: z.string().min(1, "Choose who will do this."),
  projectId: z.string().optional(),
  priority: z.enum(["low", "medium", "high", "urgent"]),
  size: z.enum(["XS", "S", "M", "L", "XL"]),
  estimatedHours: z.number({ error: "Enter the estimated hours." }).min(0.5, "At least 0.5 h").max(200),
  startDate: z.string().min(1, "Choose a start date."),
  deadline: z.string().min(1, "A deadline is required."),
  checklist: z.string().optional(),
  repeat: z.enum(["none", "week", "month"]),
  repeatOn: z.number().min(1).max(28),
  repeatUntil: z.string().optional(),
});
type FormValues = z.infer<typeof schema>;

function HintLine({ hint }: { hint: Hint }) {
  const Icon = hint.tone === "error" ? CircleAlert : hint.tone === "warning" ? TriangleAlert : Info;
  return (
    <p
      role={hint.tone === "error" ? "alert" : undefined}
      className={cn(
        "flex items-start gap-1.5 rounded-md px-2 py-1.5 text-[12.5px]",
        hint.tone === "error" ? "bg-danger/10" : hint.tone === "warning" ? "bg-warning/14" : "bg-info/10",
      )}
    >
      <Icon className={cn("mt-0.5 size-3.5 shrink-0", hint.tone === "error" ? "text-danger" : hint.tone === "warning" ? "text-[oklch(0.6_0.14_70)]" : "text-info")} />
      {hint.text}
    </p>
  );
}

function AssignTaskForm({ presetAssignee, onClose }: { presetAssignee?: string; onClose: () => void }) {
  const viewer = useViewer();
  const lookup = useLookup();
  const projects = useProjects();
  const holidays = useHolidays();
  const workload = useWorkload();
  const create = useCreateTask();
  const rules = useSizeRules();
  // Live: the soft warnings the server asked about (a deadline shorter than usual, an overloaded week), waiting for a yes.
  const [confirm, setConfirm] = React.useState<{ lines: string[]; values: FormValues } | null>(null);
  const holidayDates = React.useMemo(() => (holidays.data ?? []).map((h) => h.date), [holidays.data]);
  // The directory is the live reporting structure when the modules are live; the server checks it again anyway.
  const below = React.useMemo(() => (viewer ? descendantsOf(viewer.employee.empId, lookup.employees) : []), [viewer, lookup.employees]);

  const defaults = React.useCallback((): FormValues => {
    const start = new Date();
    return {
      title: "",
      description: "",
      assignee: presetAssignee ?? "",
      projectId: "",
      priority: "medium",
      size: "M",
      estimatedHours: sizeRule("M", rules).hours,
      startDate: toDateInput(start),
      deadline: toLocalInput(suggestedDeadline(start, "M", holidayDates, rules)),
      checklist: "",
      repeat: "none",
      repeatOn: 1,
      repeatUntil: "",
    };
  }, [presetAssignee, holidayDates, rules]);

  const [initialValues] = React.useState(defaults);
  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: initialValues });
  const { register, control, handleSubmit, setValue, formState } = form;


  const [size, startDate, deadline, assignee, estimatedHours, repeat] = useWatch({ control, name: ["size", "startDate", "deadline", "assignee", "estimatedHours", "repeat"] });
  const [deadlineTouched, setDeadlineTouched] = React.useState(false);

  // Size → hours and suggested deadline (unless the manager edited the deadline).
  const applySize = (s: TaskSize) => {
    setValue("size", s);
    setValue("estimatedHours", sizeRule(s, rules).hours);
    if (!deadlineTouched && sizeRule(s, rules).days !== null) setValue("deadline", toLocalInput(suggestedDeadline(startDate || new Date(), s, holidayDates, rules)));
  };

  const suggestion = sizeRule(size, rules).days !== null ? suggestedDeadline(startDate || new Date(), size, holidayDates, rules) : null;
  const hints = deadlineHints(startDate, deadline, size, holidayDates, rules);
  const wl = workload.data?.find((w) => w.empId === assignee);
  const after = wl ? wl.openHours + (Number(estimatedHours) || 0) : 0;
  const assigneeName = lookup.employee(assignee)?.name.split(" ")[0];
  const isXL = size === "XL";
  const blocking = isXL || hints.some((h) => h.tone === "error");
  // The sheet already shows these two warnings; pressing Assign with them on screen is the person's confirmation.
  const warned = hints.some((h) => h.tone === "warning") || (!!wl && after > wl.capacity);

  const send = async (v: FormValues, confirmWarnings: boolean) => {
    try {
      await create.mutateAsync({
        title: v.title,
        description: v.description ?? "",
        assignee: v.assignee,
        projectId: v.projectId || undefined,
        priority: v.priority as Priority,
        size: v.size as TaskSize,
        estimatedHours: v.estimatedHours,
        startDate: new Date(v.startDate).toISOString(),
        deadline: new Date(v.deadline).toISOString(),
        checklist: (v.checklist ?? "").split("\n").map((s) => s.trim()).filter(Boolean),
        repeat: v.repeat === "none" ? undefined : { every: v.repeat, on: v.repeatOn, ...(v.repeatUntil ? { until: v.repeatUntil } : {}) },
        confirmWarnings: confirmWarnings || undefined,
      });
    } catch (err) {
      const lines = confirmationWarnings(err);
      if (lines) setConfirm({ lines, values: v });
      else toast.error(err instanceof ApiError ? err.message : "Couldn't assign the task.");
      return;
    }
    setConfirm(null);
    toast.success("Task assigned", { description: `${lookup.employee(v.assignee)?.name} will be notified.` });
    onClose();
  };

  const onSubmit = handleSubmit(async (v) => {
    if (blocking) return;
    await send(v, warned);
  });

  return (
    <>
        <SheetHeader>
          <SheetTitle>Assign a task</SheetTitle>
          <SheetDescription>One owner, a size and a deadline. You can assign only to people below you.</SheetDescription>
        </SheetHeader>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col">
          <SheetBody className="grid content-start gap-5">
            <Field label="Title" htmlFor="t-title" required error={formState.errors.title?.message}>
              <Input id="t-title" autoFocus placeholder="What must be done" {...register("title")} aria-invalid={!!formState.errors.title} />
            </Field>
            <Field label="Description" htmlFor="t-desc">
              <Textarea id="t-desc" rows={3} placeholder="Details, links, what 'done' looks like" {...register("description")} />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Assign to" htmlFor="t-assignee" required error={formState.errors.assignee?.message}>
                <Controller
                  control={control}
                  name="assignee"
                  render={({ field }) => (
                    <EmployeeSelect id="t-assignee" value={field.value} onChange={field.onChange} filter={(e) => below.includes(e.empId)} invalid={!!formState.errors.assignee} />
                  )}
                />
              </Field>
              <Field label="Project or client" htmlFor="t-project" hint="Optional. Lets finance show profit by project.">
                <NativeSelect id="t-project" {...register("projectId")}>
                  <option value="">No project</option>
                  {projects.data?.map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>

            {wl && (
              <div className={cn("grid gap-2 rounded-lg border p-3", after > wl.capacity ? "border-warning/40 bg-warning/8" : "border-border bg-muted/40")}>
                <p className="flex items-center gap-1.5 text-[12.5px]">
                  {after > wl.capacity ? <TriangleAlert className="size-3.5 text-[oklch(0.6_0.14_70)]" /> : <Info className="size-3.5 text-info" />}
                  {after > wl.capacity
                    ? `This puts ${assigneeName} at ${after} h of ${wl.capacity} h this week. You can still assign it.`
                    : `${assigneeName} will have ${after} h of ${wl.capacity} h this week.`}
                </p>
                <WorkloadBar hours={after} capacity={wl.capacity} compact />
              </div>
            )}

            <Field label="Priority">
              <Controller
                control={control}
                name="priority"
                render={({ field }) => (
                  <SegmentedControl
                    value={field.value}
                    onChange={field.onChange}
                    ariaLabel="Priority"
                    options={[
                      { value: "low", label: "Low" },
                      { value: "medium", label: "Medium" },
                      { value: "high", label: "High" },
                      { value: "urgent", label: "Urgent" },
                    ]}
                    className="w-full"
                  />
                )}
              />
            </Field>

            <Field label="Size" hint={sizeRule(size, rules).meaning}>
              <SizePicker value={size} onChange={applySize} />
              {isXL && <HintLine hint={{ tone: "error", text: "XL tasks must be split into smaller tasks before they are assigned." }} />}
            </Field>

            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Estimated hours" htmlFor="t-hours" hint="Filled in from the size." error={formState.errors.estimatedHours?.message}>
                <Input id="t-hours" type="number" step="0.5" min="0.5" {...register("estimatedHours", { valueAsNumber: true })} />
              </Field>
              <Field label="Start date" htmlFor="t-start">
                <Input
                  id="t-start"
                  type="date"
                  min={TASK_DATE_INPUT_MIN}
                  max={TASK_DATE_INPUT_MAX}
                  {...register("startDate", {
                    onChange: (e) => {
                      if (!deadlineTouched && sizeRule(size, rules).days !== null) setValue("deadline", toLocalInput(suggestedDeadline(e.target.value, size, holidayDates, rules)));
                    },
                  })}
                />
              </Field>
              <Field label="Deadline" htmlFor="t-deadline" required>
                <Input id="t-deadline" type="datetime-local" min={TASK_DATETIME_INPUT_MIN} max={TASK_DATETIME_INPUT_MAX} {...register("deadline", { onChange: () => setDeadlineTouched(true) })} />
              </Field>
            </div>
            {suggestion && (
              <p className="-mt-2 flex flex-wrap items-center gap-1.5 text-[12.5px] text-muted-foreground">
                <Sparkles className="size-3.5 text-primary" /> Suggested: {formatWeekdayLong(suggestion)}, working days only, holidays skipped.
                {deadlineTouched && (
                  <button
                    type="button"
                    className="font-medium text-primary hover:underline"
                    onClick={() => {
                      setDeadlineTouched(false);
                      setValue("deadline", toLocalInput(suggestion));
                    }}
                  >
                    Use it
                  </button>
                )}
              </p>
            )}
            {hints.length > 0 && <div className="-mt-2 grid gap-1.5">{hints.map((h) => <HintLine key={h.text} hint={h} />)}</div>}

            <Field label="Checklist" htmlFor="t-check" hint="One step per line. Optional.">
              <Textarea id="t-check" rows={3} placeholder={"Agree the details\nBuild it\nSelf-test"} {...register("checklist")} />
            </Field>

            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Repeat" htmlFor="t-repeat">
                <NativeSelect id="t-repeat" {...register("repeat")}>
                  <option value="none">Doesn&apos;t repeat</option>
                  <option value="week">Every week</option>
                  <option value="month">Every month</option>
                </NativeSelect>
              </Field>
              {repeat !== "none" && (
                <Field label={repeat === "week" ? "On" : "On day"} htmlFor="t-repeat-on">
                  <NativeSelect id="t-repeat-on" {...register("repeatOn", { valueAsNumber: true })}>
                    {repeat === "week"
                      ? ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"].map((d, i) => (
                          <option key={d} value={i + 1}>
                            {d}
                          </option>
                        ))
                      : Array.from({ length: 28 }, (_, i) => (
                          <option key={i} value={i + 1}>
                            {i + 1}
                          </option>
                        ))}
                  </NativeSelect>
                </Field>
              )}
            </div>
            {repeat !== "none" && (
              <Field label="Stop repeating after" htmlFor="t-repeat-until" hint="Optional. Leave empty to repeat until someone stops it.">
                <Input id="t-repeat-until" type="date" {...register("repeatUntil")} />
              </Field>
            )}
          </SheetBody>
          <SheetFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending && !confirm} disabled={blocking}>
              Assign task
            </Button>
          </SheetFooter>
        </form>
        {confirm && (
          <ConfirmWarningsDialog lines={confirm.lines} confirmLabel="Assign anyway" busy={create.isPending} onConfirm={() => send(confirm.values, true)} onCancel={() => setConfirm(null)} />
        )}
    </>
  );
}

/**
 * The sheet only mounts the form while open, so every open starts from fresh defaults
 * (suggested deadline from today, no "touched" state) without resetting in an effect.
 * The form takes its size, hours and suggested deadline from the size table and the holidays once, when it mounts, so it
 * is not mounted until both have answered: the Director's table (M = 16 h) is never replaced by the built-in one (M = 12 h).
 */
export function AssignTaskSheet({ open, onOpenChange, presetAssignee }: { open: boolean; onOpenChange: (o: boolean) => void; presetAssignee?: string }) {
  // Start the requests the form needs as soon as the screen shows, so they have usually answered by the time the sheet opens.
  const sizes = useSizeRulesState();
  const holidays = useHolidays();
  useProjects();
  useWorkload();
  const ready = sizes.ready && !holidays.isPending;
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent size="lg">
        {open &&
          (ready ? (
            <AssignTaskForm presetAssignee={presetAssignee} onClose={() => onOpenChange(false)} />
          ) : (
            <>
              <SheetHeader>
                <SheetTitle>Assign a task</SheetTitle>
                <SheetDescription>One owner, a size and a deadline. You can assign only to people below you.</SheetDescription>
              </SheetHeader>
              <SheetBody>
                <ListSkeleton rows={6} />
              </SheetBody>
            </>
          ))}
      </SheetContent>
    </Sheet>
  );
}
