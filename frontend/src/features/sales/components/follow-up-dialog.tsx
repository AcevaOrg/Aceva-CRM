"use client";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { addWorkingDays, isoDay } from "@/lib/dates";
import { useFollowUpDone, useSetNextStep } from "../hooks";

export function dayToIso(day: string, time = "12:00") {
  return new Date(`${day}T${time}:00`).toISOString();
}

/**
 * Mark a follow-up as done and set the next one, or just edit the next step.
 * Every open deal must have a next step with a date (plan §20).
 */
export function FollowUpDialog({
  open,
  onOpenChange,
  dealId,
  company,
  currentStep,
  currentDate,
  mode = "done",
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  dealId: string;
  company: string;
  currentStep?: string;
  currentDate?: string;
  mode?: "done" | "edit";
}) {
  // Callers mount this dialog only while it's in use, so the initial state is fresh each time.
  const [summary, setSummary] = React.useState(() => (mode === "done" && currentStep ? `Done: ${currentStep}` : ""));
  const [nextStep, setNextStep] = React.useState(() => (mode === "edit" ? (currentStep ?? "") : ""));
  const [date, setDate] = React.useState(() => (mode === "edit" && currentDate ? isoDay(currentDate) : isoDay(addWorkingDays(new Date(), 2))));
  const done = useFollowUpDone();
  const edit = useSetNextStep();

  const minDay = isoDay(new Date());
  const valid = nextStep.trim().length >= 3 && !!date && date >= minDay;
  const busy = done.isPending || edit.isPending;

  const save = () => {
    if (!valid) return;
    const nextStepDate = dayToIso(date);
    const onSuccess = () => {
      toast.success(mode === "done" ? "Follow-up done" : "Next step saved", { description: `${company}: next step on ${new Date(nextStepDate).toLocaleDateString("en-GB", { day: "numeric", month: "short" })}.` });
      onOpenChange(false);
    };
    if (mode === "done") done.mutate({ id: dealId, summary: summary.trim(), nextStep: nextStep.trim(), nextStepDate }, { onSuccess });
    else edit.mutate({ id: dealId, nextStep: nextStep.trim(), nextStepDate }, { onSuccess });
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{mode === "done" ? "Follow-up done" : "Next step"}</DialogTitle>
          <DialogDescription>{company} · every open deal needs a next step with a date.</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            save();
          }}
        >
          {mode === "done" && (
            <Field label="What happened" htmlFor="fu-summary">
              <Textarea id="fu-summary" value={summary} onChange={(e) => setSummary(e.target.value)} className="min-h-16" />
            </Field>
          )}
          <Field label="Next step" htmlFor="fu-next" required>
            <Input id="fu-next" autoFocus value={nextStep} onChange={(e) => setNextStep(e.target.value)} placeholder="For example: send the revised quote" />
          </Field>
          <Field label="Next step date" htmlFor="fu-date" required error={date && date < minDay ? "The date can't be in the past." : undefined}>
            <Input id="fu-date" type="date" min={minDay} value={date} onChange={(e) => setDate(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!valid} loading={busy}>
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
