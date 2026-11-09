"use client";
import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Check, ChevronDown, Megaphone, Pin, PinOff, Plus, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox, SegmentedControl, Switch } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Progress } from "@/components/ui/misc";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { PageHeader } from "@/components/layout/page-header";
import { Can, RequireAccess } from "@/components/shared/can";
import { AvatarStack, EmpChip } from "@/components/shared/emp-chip";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { useUrlState } from "@/hooks/use-url-state";
import { ApiError } from "@/lib/api/mock";
import { useViewer } from "@/lib/auth/viewer";
import { formatDateTime, formatRelative } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useAcknowledge, useAnnouncements, usePublishAnnouncement, useTogglePinAnnouncement } from "../hooks";
import type { AnnouncementWithStats } from "../types";

type Filter = "all" | "todo";

export function AnnouncementsScreen() {
  const q = useAnnouncements();
  const [filter, setFilter] = useUrlState<Filter>("show", "all");
  const [composing, setComposing] = React.useState(false);
  const viewer = useViewer();
  const me = viewer?.employee.empId ?? "";
  const needsMe = (a: AnnouncementWithStats) => a.requiresAck && a.audienceEmpIds.includes(me) && !a.acknowledgedByMe;
  const todo = (q.data ?? []).filter(needsMe).length;
  const list = (q.data ?? []).filter((a) => filter === "all" || needsMe(a));

  return (
    <RequireAccess permission="comms.use">
      <PageHeader
        title="Announcements"
        description="Company and team news. Important ones are pinned and ask you to confirm you've read them."
        actions={
          <Can permission="announcements.publish">
            <Button onClick={() => setComposing(true)}>
              <Plus /> New announcement
            </Button>
          </Can>
        }
      />
      <div className="mx-auto grid max-w-3xl gap-4">
        <SegmentedControl
          value={filter}
          onChange={setFilter}
          className="w-fit"
          ariaLabel="Show"
          options={[
            { value: "all", label: "All" },
            { value: "todo", label: <>To acknowledge {todo > 0 && <span className="rounded-full bg-primary px-1.5 text-[10.5px] font-bold text-primary-foreground tabular">{todo}</span>}</> },
          ]}
        />
        {q.isPending ? (
          <ListSkeleton rows={3} className="[&>*]:h-40" />
        ) : q.isError ? (
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        ) : list.length === 0 ? (
          <EmptyState icon={<Megaphone />} title={filter === "todo" ? "You're all caught up" : "No announcements yet"} description={filter === "todo" ? "Nothing is waiting for your acknowledgement." : undefined} />
        ) : (
          list.map((a) => <AnnouncementCard key={a.id} a={a} me={me} />)
        )}
      </div>
      <ComposeSheet open={composing} onOpenChange={setComposing} />
    </RequireAccess>
  );
}

function AnnouncementCard({ a, me }: { a: AnnouncementWithStats; me: string }) {
  const lookup = useLookup();
  const viewer = useViewer();
  const ack = useAcknowledge();
  const pin = useTogglePinAnnouncement();
  const [showMissing, setShowMissing] = React.useState(false);
  const canPublish = !!viewer?.can("announcements.publish");
  const isPublisher = a.author === me || canPublish;
  const inAudience = a.audienceEmpIds.includes(me);
  const acked = a.ackEmpIds.filter((p) => a.audienceEmpIds.includes(p));
  const missing = a.audienceEmpIds.filter((p) => !a.ackEmpIds.includes(p));
  const pct = a.audienceEmpIds.length ? Math.round((acked.length / a.audienceEmpIds.length) * 100) : 0;

  return (
    <Card className={cn("overflow-hidden", a.pinned && "border-primary/30")}>
      {a.pinned && <div className="h-1 bg-[linear-gradient(90deg,var(--primary),var(--signal))]" />}
      <article className="grid gap-3 p-5">
        <header className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="mb-1.5 flex flex-wrap items-center gap-1.5">
              {a.pinned && (
                <Badge tone="primary">
                  <Pin /> Pinned
                </Badge>
              )}
              {a.audience.all ? (
                <Badge tone="outline">Everyone</Badge>
              ) : (
                a.audience.departmentIds.map((d) => (
                  <Badge key={d} tone="work">
                    {lookup.department(d)?.name ?? d}
                  </Badge>
                ))
              )}
              {a.requiresAck && <Badge tone="warning">Needs acknowledgement</Badge>}
            </div>
            <h2 className="text-[17px] font-semibold tracking-tight">{a.title}</h2>
          </div>
          {canPublish && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => pin.mutateAsync(a.id).then(() => toast.success(a.pinned ? "Unpinned" : "Pinned to the top"))}
              aria-label={a.pinned ? "Unpin" : "Pin"}
            >
              {a.pinned ? <PinOff /> : <Pin />}
              <span className="hidden sm:inline">{a.pinned ? "Unpin" : "Pin"}</span>
            </Button>
          )}
        </header>
        <p className="whitespace-pre-wrap text-[14px] leading-relaxed">{a.body}</p>
        <footer className="flex flex-wrap items-center justify-between gap-3 border-t border-border pt-3">
          <span className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            <EmpChip empId={a.author} size="sm" showId={false} />
            <span title={formatDateTime(a.at)}>· {formatRelative(a.at)}</span>
          </span>
          {a.requiresAck && inAudience && (
            a.acknowledgedByMe ? (
              <span className="inline-flex items-center gap-1.5 text-[13px] font-medium text-success">
                <Check className="size-4" /> You acknowledged this
              </span>
            ) : (
              <Button
                size="sm"
                loading={ack.isPending}
                onClick={() =>
                  ack.mutateAsync(a.id).then(
                    () => toast.success("Acknowledged", { description: "Thanks. Your confirmation is recorded." }),
                    (e) => toast.error(e instanceof ApiError ? e.message : "Couldn't record it."),
                  )
                }
              >
                <Check /> I&apos;ve read this
              </Button>
            )
          )}
        </footer>
        {a.requiresAck && isPublisher && (
          <div className="rounded-lg bg-muted/60 p-3">
            <div className="flex items-center justify-between gap-3 text-[12.5px]">
              <span className="flex items-center gap-1.5 font-medium">
                <Users className="size-3.5" /> {acked.length} of {a.audienceEmpIds.length} acknowledged
              </span>
              <span className="text-muted-foreground tabular">{pct}%</span>
            </div>
            <Progress value={acked.length} max={a.audienceEmpIds.length || 1} className="mt-2" barClassName={pct === 100 ? "bg-success" : "bg-primary"} label="Acknowledged" />
            {missing.length > 0 && (
              <>
                <button onClick={() => setShowMissing((s) => !s)} className="mt-2 inline-flex items-center gap-1 text-[12.5px] font-medium text-primary hover:underline" aria-expanded={showMissing}>
                  <ChevronDown className={cn("size-3.5 transition", showMissing && "rotate-180")} />
                  {missing.length} haven&apos;t acknowledged yet
                </button>
                {showMissing ? (
                  <ul className="mt-2 flex flex-wrap gap-x-4 gap-y-2">
                    {missing.map((p) => (
                      <li key={p}>
                        <EmpChip empId={p} size="sm" />
                      </li>
                    ))}
                  </ul>
                ) : (
                  <div className="mt-2">
                    <AvatarStack empIds={missing} max={8} size={24} />
                  </div>
                )}
              </>
            )}
          </div>
        )}
      </article>
    </Card>
  );
}

const schema = z
  .object({
    title: z.string().trim().min(4, "A short, clear title"),
    body: z.string().trim().min(10, "Write at least a sentence"),
    all: z.boolean(),
    departmentIds: z.array(z.string()),
    pinned: z.boolean(),
    requiresAck: z.boolean(),
  })
  .refine((v) => v.all || v.departmentIds.length > 0, { path: ["departmentIds"], message: "Choose at least one team, or send it to everyone" });
type Values = z.infer<typeof schema>;

function ComposeSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const lookup = useLookup();
  const publish = usePublishAnnouncement();
  const { register, handleSubmit, setValue, watch, reset, formState } = useForm<Values>({
    resolver: zodResolver(schema),
    defaultValues: { title: "", body: "", all: true, departmentIds: [], pinned: false, requiresAck: false },
  });
  const v = watch();
  const errors = formState.errors;
  const reach = v.all ? lookup.employees.filter((e) => e.status !== "left").length : lookup.employees.filter((e) => e.status !== "left" && v.departmentIds.includes(e.departmentId)).length;

  const onSubmit = handleSubmit(async (values) => {
    try {
      await publish.mutateAsync({ title: values.title, body: values.body, audience: { all: values.all, departmentIds: values.all ? [] : values.departmentIds }, pinned: values.pinned, requiresAck: values.requiresAck });
      toast.success("Announcement published", { description: `${reach} people notified${values.requiresAck ? "; they'll be asked to acknowledge it" : ""}.` });
      reset();
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't publish.");
    }
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent size="lg">
        <SheetHeader>
          <SheetTitle>New announcement</SheetTitle>
          <SheetDescription>Sent in the app and by email from an @acevatech.com address.</SheetDescription>
        </SheetHeader>
        <form onSubmit={onSubmit} className="flex min-h-0 flex-1 flex-col" noValidate>
          <SheetBody className="grid content-start gap-4">
            <Field label="Title" htmlFor="an-title" error={errors.title?.message}>
              <Input id="an-title" autoFocus {...register("title")} />
            </Field>
            <Field label="Message" htmlFor="an-body" error={errors.body?.message}>
              <Textarea id="an-body" rows={7} {...register("body")} />
            </Field>
            <Field label="Who should see it" error={errors.departmentIds?.message}>
              <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5 text-[13px]">
                <span>Everyone in the company</span>
                <Switch checked={v.all} onCheckedChange={(c) => setValue("all", c, { shouldValidate: true })} />
              </label>
              {!v.all && (
                <div className="grid gap-2 rounded-lg border border-border p-3 sm:grid-cols-2">
                  {lookup.departments.map((d) => {
                    const on = v.departmentIds.includes(d.id);
                    return (
                      <label key={d.id} className="flex cursor-pointer items-center gap-2.5 text-[13px]">
                        <Checkbox
                          checked={on}
                          onCheckedChange={(c) => setValue("departmentIds", c ? [...v.departmentIds, d.id] : v.departmentIds.filter((x) => x !== d.id), { shouldValidate: true })}
                        />
                        {d.name}
                      </label>
                    );
                  })}
                </div>
              )}
              <p className="text-[12px] text-muted-foreground">Reaches {reach} {reach === 1 ? "person" : "people"}.</p>
            </Field>
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5 text-[13px]">
              <span>
                <span className="block font-medium">Pin to the top</span>
                <span className="text-muted-foreground">Stays above newer announcements until unpinned.</span>
              </span>
              <Switch checked={v.pinned} onCheckedChange={(c) => setValue("pinned", c)} />
            </label>
            <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5 text-[13px]">
              <span>
                <span className="block font-medium">Ask people to acknowledge</span>
                <span className="text-muted-foreground">You&apos;ll see who has and hasn&apos;t confirmed.</span>
              </span>
              <Switch checked={v.requiresAck} onCheckedChange={(c) => setValue("requiresAck", c)} />
            </label>
          </SheetBody>
          <SheetFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={publish.isPending}>
              <Megaphone /> Publish
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
