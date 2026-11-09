"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { CalendarPlus, Paperclip, Search, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox, NativeSelect } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useTasks } from "@/features/tasks/hooks";
import { useLookup } from "@/hooks/use-directory";
import { ApiError } from "@/lib/api/mock";
import { useViewer } from "@/lib/auth/viewer";
import { isoDay } from "@/lib/dates";
import { formatBytes } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useCreateMeeting } from "../hooks";
import { checkFile } from "../logic";

const schema = z
  .object({
    title: z.string().trim().min(3, "Give the meeting a title"),
    date: z.string().min(1, "Choose a date"),
    time: z.string().regex(/^\d{2}:\d{2}$/, "Choose a time"),
    duration: z.string(),
    location: z.string().trim().min(2, "Where, or which video link?"),
    participants: z.array(z.string()).min(1, "Invite at least one person"),
    agenda: z.string().trim().min(5, "Share a short agenda"),
    linkedTaskIds: z.array(z.string()),
  })
  .refine((v) => new Date(`${v.date}T${v.time}`).getTime() > Date.now(), { path: ["time"], message: "Pick a time in the future" });
type Values = z.infer<typeof schema>;

function nextSlot() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  while (d.getDay() === 0 || d.getDay() === 6) d.setDate(d.getDate() + 1);
  return isoDay(d);
}

export function NewMeetingSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const lookup = useLookup();
  const viewer = useViewer();
  const tasks = useTasks({ scope: "all" });
  const create = useCreateMeeting();
  const router = useRouter();
  const [q, setQ] = React.useState("");
  const [files, setFiles] = React.useState<{ fileName: string; sizeBytes: number; mimeType: string }[]>([]);
  const fileRef = React.useRef<HTMLInputElement>(null);
  const { register, handleSubmit, setValue, watch, reset, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { title: "", date: nextSlot(), time: "11:00", duration: "30", location: "Dadu HQ · meeting room", participants: [], agenda: "", linkedTaskIds: [] },
  });
  const v = watch();
  const errors = formState.errors;
  const me = viewer?.employee.empId;
  const people = lookup.employees.filter((e) => e.empId !== me && e.status !== "left" && (!q.trim() || `${e.name} ${e.designation}`.toLowerCase().includes(q.trim().toLowerCase())));

  const togglePerson = (id: string) =>
    setValue("participants", v.participants.includes(id) ? v.participants.filter((x) => x !== id) : [...v.participants, id], { shouldValidate: formState.isSubmitted });

  const onSubmit = handleSubmit(async (values) => {
    try {
      const m = await create.mutateAsync({
        title: values.title,
        start: new Date(`${values.date}T${values.time}`).toISOString(),
        durationMin: Number(values.duration),
        location: values.location,
        participants: values.participants,
        agenda: values.agenda,
        attachments: files,
        linkedTaskIds: values.linkedTaskIds,
      });
      toast.success("Meeting scheduled", { description: `${values.participants.length} ${values.participants.length === 1 ? "person" : "people"} invited.` });
      reset();
      setFiles([]);
      onOpenChange(false);
      router.push(`/meetings/${m.id}`);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't schedule the meeting.");
    }
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent size="lg">
        <SheetHeader>
          <SheetTitle>New meeting</SheetTitle>
          <SheetDescription>Invites appear in each person&apos;s Meetings list and notifications.</SheetDescription>
        </SheetHeader>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col" noValidate>
          <SheetBody className="grid content-start gap-4">
            <Field label="Title" htmlFor="mt-title" error={errors.title?.message}>
              <Input id="mt-title" autoFocus placeholder="Payslip layout review" {...register("title")} />
            </Field>
            <div className="grid gap-4 sm:grid-cols-3">
              <Field label="Date" htmlFor="mt-date" error={errors.date?.message}>
                <Input id="mt-date" type="date" {...register("date")} />
              </Field>
              <Field label="Start" htmlFor="mt-time" error={errors.time?.message}>
                <Input id="mt-time" type="time" step={900} {...register("time")} />
              </Field>
              <Field label="Length" htmlFor="mt-dur">
                <NativeSelect id="mt-dur" {...register("duration")}>
                  {[15, 30, 45, 60, 90, 120].map((d) => (
                    <option key={d} value={d}>
                      {d < 60 ? `${d} min` : `${Math.floor(d / 60)} h${d % 60 ? ` ${d % 60} min` : ""}`}
                    </option>
                  ))}
                </NativeSelect>
              </Field>
            </div>
            <Field label="Where" htmlFor="mt-loc" error={errors.location?.message}>
              <Input id="mt-loc" list="mt-loc-list" {...register("location")} />
              <datalist id="mt-loc-list">
                <option value="Dadu HQ · meeting room" />
                <option value="Karachi Studio · small room" />
                <option value="Online (Google Meet)" />
                <option value="Online (Zoom)" />
              </datalist>
            </Field>

            <Field label={`Invite people · ${v.participants.length} chosen`} error={errors.participants?.message}>
              <div className="relative">
                <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search people" className="pl-8" aria-label="Search people" />
              </div>
              <ul className="max-h-52 overflow-y-auto rounded-lg border border-border scrollbar-thin">
                {people.map((e) => {
                  const on = v.participants.includes(e.empId);
                  return (
                    <li key={e.empId} className={cn("flex items-center gap-3 border-b border-border px-3 py-1.5 last:border-0", on && "bg-accent/60")}>
                      <Checkbox checked={on} onCheckedChange={() => togglePerson(e.empId)} aria-label={`Invite ${e.name}`} />
                      <button type="button" onClick={() => togglePerson(e.empId)} className="flex min-w-0 flex-1 items-center gap-2.5 text-left">
                        <Avatar name={e.name} hue={e.avatarHue} size={24} />
                        <span className="min-w-0 flex-1 truncate text-[13px]">{e.name}</span>
                        <span className="hidden truncate text-[11.5px] text-muted-foreground sm:block">{e.designation}</span>
                      </button>
                    </li>
                  );
                })}
              </ul>
            </Field>

            <Field label="Agenda" htmlFor="mt-agenda" error={errors.agenda?.message} hint="One item per line works well.">
              <Textarea id="mt-agenda" rows={4} placeholder={"1. …\n2. …"} {...register("agenda")} />
            </Field>

            <Field label="Linked tasks (optional)" htmlFor="mt-tasks">
              <NativeSelect
                id="mt-tasks"
                value=""
                onChange={(e) => e.target.value && !v.linkedTaskIds.includes(e.target.value) && setValue("linkedTaskIds", [...v.linkedTaskIds, e.target.value])}
              >
                <option value="">Add a task…</option>
                {tasks.data
                  ?.filter((t) => !t.personal)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.number} · {t.title}
                    </option>
                  ))}
              </NativeSelect>
              {v.linkedTaskIds.length > 0 && (
                <ul className="flex flex-wrap gap-1.5">
                  {v.linkedTaskIds.map((id) => {
                    const t = tasks.data?.find((x) => x.id === id);
                    return (
                      <li key={id} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted py-0.5 pl-2.5 pr-1 text-[12px]">
                        <span className="font-mono">{t?.number}</span>
                        <button type="button" onClick={() => setValue("linkedTaskIds", v.linkedTaskIds.filter((x) => x !== id))} className="rounded-full p-0.5 hover:bg-card" aria-label={`Remove ${t?.number}`}>
                          <X className="size-3" />
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </Field>

            <Field label="Files (optional)">
              <input
                ref={fileRef}
                type="file"
                multiple
                hidden
                onChange={(e) => {
                  Array.from(e.target.files ?? []).forEach((f) => {
                    const err = checkFile(f.name, f.size);
                    if (err) toast.error(`Can't attach ${f.name}`, { description: err });
                    else setFiles((p) => [...p, { fileName: f.name, sizeBytes: f.size, mimeType: f.type }]);
                  });
                  e.target.value = "";
                }}
              />
              <div className="flex flex-wrap items-center gap-2">
                <Button type="button" variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
                  <Paperclip /> Attach
                </Button>
                {files.map((f, i) => (
                  <span key={i} className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted py-1 pl-2 pr-1 text-[12px]">
                    {f.fileName} <span className="text-muted-foreground">{formatBytes(f.sizeBytes)}</span>
                    <button type="button" onClick={() => setFiles((p) => p.filter((_, j) => j !== i))} className="rounded p-0.5 hover:bg-card" aria-label={`Remove ${f.fileName}`}>
                      <X className="size-3" />
                    </button>
                  </span>
                ))}
              </div>
            </Field>
            <p className="text-[12px] text-muted-foreground">Calendar integration (Google or Outlook) can be added later if management approves it.</p>
          </SheetBody>
          <SheetFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              <CalendarPlus /> Schedule
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
