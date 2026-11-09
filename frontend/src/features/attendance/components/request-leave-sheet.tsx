"use client";
import * as React from "react";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { ArrowRight, CalendarHeart, CircleAlert, TriangleAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Avatar } from "@/components/ui/misc";
import { useLookup } from "@/hooks/use-directory";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate, isoDay } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { HOLIDAYS } from "@/mocks/seed/calendar";
import { attendanceApi } from "../api";
import { useLeaveBalances, useLeaveClashes, useRequestLeave } from "../hooks";
import { buildLeaveChain } from "../logic";

const today = () => isoDay(new Date());

const schema = z
  .object({
    leaveTypeId: z.string().min(1, "Choose a leave type."),
    from: z.string().min(1, "Choose the first day."),
    to: z.string().min(1, "Choose the last day."),
    halfDay: z.boolean(),
    reason: z.string().trim().min(3, "Add a short reason."),
  })
  .refine((v) => v.from >= today(), { message: "Leave can't start in the past.", path: ["from"] })
  .refine((v) => !v.to || v.to >= v.from, { message: "The last day must be on or after the first day.", path: ["to"] });

type FormValues = z.infer<typeof schema>;

export function RequestLeaveSheet({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const viewer = useViewer();
  const lookup = useLookup();
  const balances = useLeaveBalances();
  const request = useRequestLeave();
  const form = useForm<FormValues>({
    resolver: zodResolver(schema),
    defaultValues: { leaveTypeId: "lt-casual", from: "", to: "", halfDay: false, reason: "" },
  });
  const v = useWatch({ control: form.control });
  const from = v.from ?? "";
  const to = v.to || from;
  const single = !!from && from === to;
  const days = from && to >= from ? attendanceApi.countDays(from, to, !!v.halfDay && single) : 0;
  const bal = balances.data?.find((b) => b.leaveTypeId === v.leaveTypeId);
  const after = bal && bal.remaining !== null ? bal.remaining - days : null;
  const clashes = useLeaveClashes(from, to);
  const holidaysIn = from && to >= from ? HOLIDAYS.filter((h) => h.date >= from && h.date <= to) : [];
  const chain = viewer ? buildLeaveChain(viewer.employee.empId, lookup.employees) : [];

  React.useEffect(() => {
    if (!open) form.reset();
  }, [open, form]);

  const submit = form.handleSubmit(async (values) => {
    try {
      const r = await request.mutateAsync({ ...values, to: values.to || values.from, halfDay: values.halfDay && values.from === (values.to || values.from) });
      toast.success(`Leave request ${r.number} sent`, { description: chain[0] ? `It's waiting for ${lookup.employee(chain[0].empId)?.name}.` : "Approved." });
      onOpenChange(false);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send the request");
    }
  });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent size="lg">
        <SheetHeader>
          <SheetTitle>Request leave</SheetTitle>
          <SheetDescription>Weekends and public holidays aren&apos;t counted. Your team lead approves first, then the Director.</SheetDescription>
        </SheetHeader>
        <SheetBody>
          <form id="leave-form" onSubmit={submit} className="grid gap-5">
            <fieldset className="grid gap-2">
              <legend className="mb-2 text-[13px] font-medium leading-none">Leave type</legend>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-4" role="radiogroup">
                {(balances.data ?? []).map((b) => {
                  const active = v.leaveTypeId === b.leaveTypeId;
                  return (
                    <button
                      key={b.leaveTypeId}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => form.setValue("leaveTypeId", b.leaveTypeId, { shouldValidate: true })}
                      className={cn(
                        "grid gap-1 rounded-xl border border-border bg-card p-3 text-left transition hover:bg-muted",
                        active && "border-primary bg-primary/5 outline-2 -outline-offset-1 outline-primary/40",
                      )}
                    >
                      <span className="flex items-center gap-1.5 text-[13px] font-medium">
                        <span className="size-2 rounded-full" style={{ background: b.leaveType.color }} />
                        {b.leaveType.name}
                      </span>
                      <span className="text-[11.5px] text-muted-foreground">{b.remaining === null ? "Unpaid, no limit" : `${b.remaining} days left`}</span>
                    </button>
                  );
                })}
              </div>
            </fieldset>

            <div className="grid grid-cols-2 items-start gap-3">
              <Field label="First day" htmlFor="lv-from" required error={form.formState.errors.from?.message}>
                <Input id="lv-from" type="date" min={today()} {...form.register("from")} />
              </Field>
              <Field label="Last day" htmlFor="lv-to" error={form.formState.errors.to?.message} hint="Leave empty for one day.">
                <Input id="lv-to" type="date" min={from || today()} {...form.register("to")} />
              </Field>
            </div>

            {single && (
              <label className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5 text-[13px]">
                Half day only
                <Switch checked={!!v.halfDay} onCheckedChange={(c) => form.setValue("halfDay", c)} />
              </label>
            )}

            <Field label="Reason" htmlFor="lv-reason" required error={form.formState.errors.reason?.message}>
              <Textarea id="lv-reason" placeholder="For example: family wedding in Hyderabad" {...form.register("reason")} />
            </Field>

            <div className="grid gap-3 rounded-xl border border-border bg-muted/40 p-4">
              <div className="flex flex-wrap items-end justify-between gap-2">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Working days</p>
                  <p className="text-[26px] font-semibold leading-tight tabular">{days}</p>
                </div>
                {bal && (
                  <p className={cn("text-[13px]", after !== null && after < 0 ? "font-medium text-danger" : "text-muted-foreground")}>
                    {after === null
                      ? `Unpaid: ${days} day${days === 1 ? "" : "s"} deducted in payroll.`
                      : after < 0
                        ? `Only ${bal.remaining} ${bal.leaveType.name.toLowerCase()} days left.`
                        : `You'll have ${after} of ${bal.total} ${bal.leaveType.name.toLowerCase()} days left.`}
                  </p>
                )}
              </div>
              {holidaysIn.length > 0 && (
                <p className="flex items-start gap-2 text-[12.5px]">
                  <CalendarHeart className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  Not counted: {holidaysIn.map((h) => `${h.name} (${formatDate(h.date)})`).join(", ")}.
                </p>
              )}
              {from && to >= from && days === 0 && (
                <p className="flex items-start gap-2 text-[12.5px] text-danger">
                  <CircleAlert className="mt-0.5 size-4 shrink-0" /> These dates have no working days.
                </p>
              )}
              {!!clashes.data?.length && (
                <div className="grid gap-1 rounded-lg border border-warning/40 bg-warning/12 p-3 text-[12.5px]">
                  <p className="flex items-center gap-2 font-medium">
                    <TriangleAlert className="size-4 text-[oklch(0.6_0.14_70)]" /> {clashes.data.length} task deadline{clashes.data.length > 1 ? "s" : ""} fall in this leave
                  </p>
                  <ul className="grid gap-0.5 pl-6 text-muted-foreground">
                    {clashes.data.map((c) => (
                      <li key={c.taskId}>
                        <span className="font-mono">{c.number}</span> {c.title} · due {formatDate(c.deadline)}
                      </li>
                    ))}
                  </ul>
                  <p className="pl-6 text-muted-foreground">Ask your team lead for an extension, or finish them before you go.</p>
                </div>
              )}
              {chain.length > 0 && (
                <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
                  Goes to
                  {chain.map((s, i) => {
                    const e = lookup.employee(s.empId);
                    return (
                      <React.Fragment key={s.label}>
                        {i > 0 && <ArrowRight className="size-3.5" />}
                        <span className="inline-flex items-center gap-1.5 rounded-full bg-card px-2 py-0.5 text-foreground">
                          {e && <Avatar name={e.name} hue={e.avatarHue} size={16} />}
                          {e?.name ?? s.empId} <span className="text-muted-foreground">({s.label})</span>
                        </span>
                      </React.Fragment>
                    );
                  })}
                </div>
              )}
            </div>
          </form>
        </SheetBody>
        <SheetFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button type="submit" form="leave-form" loading={request.isPending} disabled={days <= 0 || (after !== null && after < 0)}>
            Send request
          </Button>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
