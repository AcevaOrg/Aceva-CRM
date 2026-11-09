"use client";
/**
 * Review (approve with rating / rework), extension request and deadline change dialogs.
 * Each dialog mounts its form only while open, so it always starts fresh.
 */
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { StarRating } from "@/components/shared/pickers";
import { useNow } from "@/hooks/use-now";
import { formatDateTime } from "@/lib/dates";
import { useChangeDeadline, useRequestExtension, useTransitionTask } from "../hooks";
import type { Task } from "../types";
import { toLocalInput } from "./assign-task-sheet";

type DialogProps = { task: Task; open: boolean; onOpenChange: (o: boolean) => void };

/* ---------------- Review ---------------- */

export function ReviewDialog({ task, open, onOpenChange, initial = "approve" }: DialogProps & { initial?: "approve" | "rework" }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{open && <ReviewForm task={task} initial={initial} onClose={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

function ReviewForm({ task, initial, onClose }: { task: Task; initial: "approve" | "rework"; onClose: () => void }) {
  const [mode, setMode] = React.useState<"approve" | "rework">(initial);
  const [rating, setRating] = React.useState(0);
  const [text, setText] = React.useState("");
  const transition = useTransitionTask();
  const valid = mode === "approve" ? rating > 0 : text.trim().length >= 3;
  const submit = async () => {
    await transition.mutateAsync({
      id: task.id,
      to: mode === "approve" ? "approved" : "rework",
      rating: mode === "approve" ? rating : undefined,
      comment: mode === "approve" ? text : undefined,
      reason: mode === "rework" ? text : undefined,
    });
    toast.success(mode === "approve" ? `Approved with ${rating} star${rating > 1 ? "s" : ""}` : "Sent back for rework", {
      description: "The rating goes straight into the employee's figures.",
    });
    onClose();
  };
  return (
    <>
      <DialogHeader>
        <DialogTitle>Review “{task.title}”</DialogTitle>
        <DialogDescription>Approve it with a rating, or send it back with a reason. One of the two is required.</DialogDescription>
      </DialogHeader>
      <SegmentedControl
        value={mode}
        onChange={setMode}
        className="w-full"
        options={[
          { value: "approve", label: "Approve" },
          { value: "rework", label: "Send to rework" },
        ]}
      />
      {mode === "approve" ? (
        <div className="grid gap-4">
          <Field label="Rating">
            <StarRating value={rating} onChange={setRating} size={26} />
          </Field>
          <Field label="Comment (optional)">
            <Textarea value={text} onChange={(e) => setText(e.target.value)} placeholder="What was good, what to improve" />
          </Field>
        </div>
      ) : (
        <Field label="Reason" hint="The task goes back to In progress with this reason.">
          <Textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder="What needs to change" />
        </Field>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button onClick={submit} disabled={!valid} loading={transition.isPending} variant={mode === "rework" ? "secondary" : "default"}>
          {mode === "approve" ? "Approve" : "Send to rework"}
        </Button>
      </DialogFooter>
    </>
  );
}

/* ---------------- Extension request ---------------- */

export function ExtensionDialog({ task, open, onOpenChange }: DialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>{open && <ExtensionForm task={task} onClose={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

/** Two days after the later of now and the current deadline, at 18:00. */
function defaultExtensionDate(deadline: string, now: number) {
  const d = new Date(Math.max(now, new Date(deadline).getTime()));
  d.setDate(d.getDate() + 2);
  d.setHours(18, 0, 0, 0);
  return toLocalInput(d);
}

function ExtensionForm({ task, onClose }: { task: Task; onClose: () => void }) {
  const now = useNow(60_000);
  const [date, setDate] = React.useState<string | null>(null);
  const [reason, setReason] = React.useState("");
  const req = useRequestExtension();
  const value = date ?? (now ? defaultExtensionDate(task.deadline, now) : "");
  const late = now > 0 && new Date(task.deadline).getTime() < now;
  const tooEarly = !value || new Date(value).getTime() <= new Date(task.deadline).getTime();
  return (
    <>
      <DialogHeader>
        <DialogTitle>{late ? "Request extension (counts as late)" : "Request more time"}</DialogTitle>
        <DialogDescription>
          Current deadline: {formatDateTime(task.deadline)}. The assigner approves or rejects it; the original deadline is kept.
          {late && " Because the deadline has passed, this request counts as late on your scorecard."}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <Field label="New deadline" error={value && tooEarly ? "Pick a date after the current deadline." : undefined}>
          <Input type="datetime-local" value={value} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Reason">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why you need more time" />
        </Field>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={tooEarly || reason.trim().length < 3}
          loading={req.isPending}
          onClick={async () => {
            await req.mutateAsync({ id: task.id, requestedDeadline: new Date(value).toISOString(), reason });
            toast.success("Extension requested", { description: "Your manager will see it in their approvals." });
            onClose();
          }}
        >
          Send request
        </Button>
      </DialogFooter>
    </>
  );
}

/* ---------------- Manager changes the deadline ---------------- */

export function DeadlineDialog({ task, open, onOpenChange }: DialogProps) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">{open && <DeadlineForm task={task} onClose={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

function DeadlineForm({ task, onClose }: { task: Task; onClose: () => void }) {
  const now = useNow(60_000);
  const [date, setDate] = React.useState(() => toLocalInput(new Date(task.deadline)));
  const [reason, setReason] = React.useState("");
  const change = useChangeDeadline();
  const past = now > 0 && new Date(date).getTime() < now;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Change the deadline</DialogTitle>
        <DialogDescription>A reason is required and the change is logged.</DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <Field label="New deadline" error={past ? "A deadline can't be in the past." : undefined}>
          <Input type="datetime-local" value={date} onChange={(e) => setDate(e.target.value)} />
        </Field>
        <Field label="Reason">
          <Textarea value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          Cancel
        </Button>
        <Button
          disabled={past || reason.trim().length < 3}
          loading={change.isPending}
          onClick={async () => {
            await change.mutateAsync({ id: task.id, deadline: new Date(date).toISOString(), reason });
            toast.success("Deadline changed");
            onClose();
          }}
        >
          Save
        </Button>
      </DialogFooter>
    </>
  );
}
