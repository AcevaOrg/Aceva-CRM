"use client";
import * as React from "react";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { StatusBadge } from "@/components/shared/chips";
import { useLookup } from "@/hooks/use-directory";
import { ROLE_LABEL } from "@/lib/auth/permissions";
import { useViewer } from "@/lib/auth/viewer";
import { DetailList } from "@/components/shared/pickers";
import { formatDate, formatTime, formatWeekdayLong, isoDay } from "@/lib/dates";
import { useCorrections, useRequestCorrection } from "../hooks";
import { correctionApprover, DAY_STATUS, minutesBetween } from "../logic";
import type { AttendanceDay } from "../types";
import { CorrectionCompare, CORRECTION_STATUS } from "./corrections-panel";

const schema = z
  .object({
    checkIn: z.string(),
    checkOut: z.string(),
    reason: z.string().trim().min(10, "Explain what happened in at least 10 characters."),
  })
  .refine((v) => v.checkIn || v.checkOut, { message: "Enter the correct check-in or check-out time.", path: ["checkIn"] })
  .refine((v) => !v.checkIn || !v.checkOut || v.checkIn < v.checkOut, { message: "Check-out must be after check-in.", path: ["checkOut"] });

type FormValues = z.infer<typeof schema>;

const toClock = (iso?: string) => (iso ? formatTime(iso) : "");

function toIso(date: string, clock: string) {
  if (!clock) return undefined;
  const [h, m] = clock.split(":").map(Number);
  const d = new Date(`${date}T00:00:00`);
  d.setHours(h, m, 0, 0);
  return d.toISOString();
}

export function DaySheet({ day, onClose }: { day: AttendanceDay | null; onClose: () => void }) {
  const viewer = useViewer();
  const lookup = useLookup();
  const corrections = useCorrections("mine");
  const request = useRequestCorrection();
  const existing = day ? corrections.data?.find((c) => c.date === day.date) : undefined;
  const isPast = day ? day.date < isoDay(new Date()) : false;
  // Corrections go to the person's manager (the Director's own to the CEO / Founder / Owner); the CEO / Founder / Owner has no one above.
  const approver = viewer ? correctionApprover(viewer.employee.empId, lookup.employees) : null;
  const correctable = !!day && isPast && !["holiday", "leave", "weekend", "future"].includes(day.status) && existing?.status !== "pending";
  const canCorrect = correctable && !!approver;

  const form = useForm<FormValues>({ resolver: zodResolver(schema), values: { checkIn: toClock(day?.checkIn), checkOut: toClock(day?.checkOut), reason: "" } });

  const submit = form.handleSubmit(async (v) => {
    if (!day) return;
    try {
      await request.mutateAsync({ date: day.date, checkIn: toIso(day.date, v.checkIn), checkOut: toIso(day.date, v.checkOut), reason: v.reason });
      toast.success(`Correction sent to ${approver?.name ?? "your manager"}`, { description: "The original record is kept next to your request." });
      onClose();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't send the correction");
    }
  });

  const gap = day ? minutesBetween(day.checkIn, day.firstLogin) : null;

  return (
    <Sheet open={!!day} onOpenChange={(o) => !o && onClose()}>
      <SheetContent size="md">
        {day && (
          <>
            <SheetHeader>
              <SheetTitle>{formatWeekdayLong(day.date)}</SheetTitle>
              <SheetDescription>{formatDate(day.date)}</SheetDescription>
            </SheetHeader>
            <SheetBody className="grid content-start gap-6">
              <div>
                <StatusBadge label={day.note && (day.status === "holiday" || day.status === "leave") ? `${DAY_STATUS[day.status].label}: ${day.note}` : DAY_STATUS[day.status].label} tone={DAY_STATUS[day.status].tone} />
              </div>
              <DetailList
                columns={2}
                items={[
                  ["Check-in", day.checkIn ? <span className="font-mono tabular">{formatTime(day.checkIn)}</span> : "—"],
                  ["Check-out", day.checkOut ? <span className="font-mono tabular">{formatTime(day.checkOut)}{day.status === "missed_checkout" ? " (closed automatically)" : ""}</span> : "—"],
                  ["Late by", day.lateMinutes ? `${day.lateMinutes} min` : "—"],
                  ["First login (activity)", day.firstLogin ? <span className="font-mono tabular">{formatTime(day.firstLogin)}{gap !== null ? ` · ${gap >= 0 ? "+" : ""}${gap} min` : ""}</span> : "—"],
                ]}
              />
              {existing && (
                <div className="grid gap-2 rounded-xl border border-border p-4">
                  <div className="flex items-center justify-between">
                    <p className="text-[13px] font-semibold">Correction request</p>
                    <StatusBadge {...CORRECTION_STATUS(existing.status)} />
                  </div>
                  <CorrectionCompare c={existing} />
                  <p className="text-[12.5px] text-muted-foreground">“{existing.reason}”</p>
                  {existing.decisionNote && <p className="text-[12.5px]">Manager: “{existing.decisionNote}”</p>}
                </div>
              )}
              {canCorrect ? (
                <form id="correction-form" onSubmit={submit} className="grid gap-4">
                  <div>
                    <p className="text-[13px] font-semibold">Ask for a correction</p>
                    <p className="text-[12.5px] text-muted-foreground">
                      Your manager{approver ? ` (${approver.name}, ${ROLE_LABEL[approver.role]})` : ""} approves it. The original stays on record.
                    </p>
                  </div>
                  <div className="grid grid-cols-2 gap-3">
                    <Field label="Correct check-in" htmlFor="cor-in" error={form.formState.errors.checkIn?.message}>
                      <Input id="cor-in" type="time" {...form.register("checkIn")} />
                    </Field>
                    <Field label="Correct check-out" htmlFor="cor-out" error={form.formState.errors.checkOut?.message}>
                      <Input id="cor-out" type="time" {...form.register("checkOut")} />
                    </Field>
                  </div>
                  <Field label="What happened?" htmlFor="cor-reason" required error={form.formState.errors.reason?.message}>
                    <Textarea id="cor-reason" placeholder="For example: I forgot to check out after the release call." {...form.register("reason")} />
                  </Field>
                </form>
              ) : correctable && !approver ? (
                <p className="flex gap-2 rounded-lg bg-muted p-3 text-[12.5px] text-muted-foreground">
                  <Info className="mt-0.5 size-4 shrink-0" /> Corrections are approved by the person&apos;s manager. As CEO / Founder / Owner there is no one above you, so this record stays as it is.
                </p>
              ) : (
                !existing &&
                !isPast && (
                  <p className="flex gap-2 rounded-lg bg-muted p-3 text-[12.5px] text-muted-foreground">
                    <Info className="mt-0.5 size-4 shrink-0" /> Today can&apos;t be corrected yet. Use the check-in card; corrections are for past days.
                  </p>
                )
              )}
            </SheetBody>
            {canCorrect && (
              <SheetFooter>
                <Button variant="outline" onClick={onClose}>
                  Close
                </Button>
                <Button type="submit" form="correction-form" loading={request.isPending}>
                  Send to manager
                </Button>
              </SheetFooter>
            )}
          </>
        )}
      </SheetContent>
    </Sheet>
  );
}
