"use client";
/**
 * Dialogs: acknowledge a scorecard, raise a dispute, decide a dispute, review a task.
 * Each form lives inside DialogContent, which unmounts on close, so its state resets on every open.
 */
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { NativeSelect, SegmentedControl } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { StarRating } from "@/components/shared/pickers";
import { useTransitionTask } from "@/features/tasks/hooks";
import { useLookup } from "@/hooks/use-directory";
import type { Task } from "@/features/tasks/types";
import { formatMonthKey } from "@/lib/dates";
import { useAcknowledgeScorecard, useDecideDispute, useRaiseDispute } from "../hooks";
import type { RatingDispute, Scorecard } from "../types";

const errMsg = (e: unknown) => (e instanceof Error ? e.message : "Something went wrong");

/* ---------------- Acknowledge ---------------- */

function AcknowledgeForm({ scorecard, close }: { scorecard: Scorecard; close: () => void }) {
  const [comment, setComment] = React.useState("");
  const ack = useAcknowledgeScorecard();
  return (
    <>
      <DialogHeader>
        <DialogTitle>Acknowledge your {formatMonthKey(scorecard.month)} scorecard</DialogTitle>
        <DialogDescription>Acknowledging means you have seen it. You can still dispute a task rating afterwards.</DialogDescription>
      </DialogHeader>
      <Field label="Comment (optional)" htmlFor="ack-comment" hint="Your reviewer and the levels above you will see it.">
        <Textarea id="ack-comment" value={comment} onChange={(e) => setComment(e.target.value)} placeholder="For example: I'll plan my larger tasks earlier next month." />
      </Field>
      <DialogFooter>
        <Button variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button
          loading={ack.isPending}
          onClick={async () => {
            try {
              await ack.mutateAsync({ id: scorecard.id, comment: comment.trim() || undefined });
              toast.success("Scorecard acknowledged");
              close();
            } catch (e) {
              toast.error(errMsg(e));
            }
          }}
        >
          Acknowledge
        </Button>
      </DialogFooter>
    </>
  );
}

export function AcknowledgeDialog({ scorecard, open, onOpenChange }: { scorecard: Scorecard; open: boolean; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <AcknowledgeForm scorecard={scorecard} close={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Raise a dispute ---------------- */

function RaiseDisputeForm({ scorecard, taskNumber, close }: { scorecard: Scorecard; taskNumber?: string; close: () => void }) {
  const rated = scorecard.tasks.filter((t) => t.rating);
  const [task, setTask] = React.useState(taskNumber ?? rated[0]?.number ?? "");
  const [reason, setReason] = React.useState("");
  const raise = useRaiseDispute();
  const lookup = useLookup();
  const chosen = rated.find((t) => t.number === task);
  // The CEO / Founder / Owner decides nothing, so a rating the Director gave goes back to the Director.
  const reviewerIsDirector = lookup.employee(scorecard.reviewerEmpId)?.role === "director";
  return (
    <>
      <DialogHeader>
        <DialogTitle>Dispute a task rating</DialogTitle>
        <DialogDescription>
          {reviewerIsDirector
            ? "Your reviewer is the Director, the final approver, so the Director looks at the rating again. The CEO / Founder / Owner can see the dispute. Explain what the rating missed."
            : "The level above your reviewer (the Director) decides. Explain what the rating missed."}
        </DialogDescription>
      </DialogHeader>
      <div className="grid gap-4">
        <Field label="Task" htmlFor="dsp-task">
          <NativeSelect id="dsp-task" value={task} onChange={(e) => setTask(e.target.value)}>
            {rated.map((t) => (
              <option key={t.number} value={t.number}>
                {t.number} · {t.title} · {t.rating}★
              </option>
            ))}
          </NativeSelect>
        </Field>
        {chosen && (
          <div className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
            Current rating <StarRating value={chosen.rating ?? 0} size={14} />
          </div>
        )}
        <Field label="Why do you disagree?" htmlFor="dsp-reason" required hint="At least 20 characters.">
          <Textarea id="dsp-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
        </Field>
      </div>
      <DialogFooter>
        <Button variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button
          disabled={!task || reason.trim().length < 20}
          loading={raise.isPending}
          onClick={async () => {
            try {
              await raise.mutateAsync({ scorecardId: scorecard.id, taskNumber: task, reason: reason.trim() });
              toast.success("Dispute sent", { description: "You'll get a notification when it's decided." });
              close();
            } catch (e) {
              toast.error(errMsg(e));
            }
          }}
        >
          Send dispute
        </Button>
      </DialogFooter>
    </>
  );
}

export function RaiseDisputeDialog({ scorecard, open, onOpenChange, taskNumber }: { scorecard: Scorecard; open: boolean; onOpenChange: (o: boolean) => void; taskNumber?: string }) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <RaiseDisputeForm key={taskNumber ?? "any"} scorecard={scorecard} taskNumber={taskNumber} close={() => onOpenChange(false)} />
      </DialogContent>
    </Dialog>
  );
}

/* ---------------- Decide a dispute ---------------- */

function DecideDisputeForm({ dispute, close }: { dispute: RatingDispute; close: () => void }) {
  const [mode, setMode] = React.useState<"keep" | "change">("keep");
  const [rating, setRating] = React.useState(dispute.currentRating);
  const [decision, setDecision] = React.useState("");
  const decide = useDecideDispute();
  const ok = decision.trim().length >= 5 && (mode === "keep" || (rating > 0 && rating !== dispute.currentRating));
  return (
    <>
      <DialogHeader>
        <DialogTitle>Decide the dispute</DialogTitle>
        <DialogDescription>
          {dispute.taskNumber} · {dispute.taskTitle} · rated {dispute.currentRating}★
        </DialogDescription>
      </DialogHeader>
      <blockquote className="rounded-lg border-l-2 border-primary bg-muted/60 px-3 py-2 text-[13px]">“{dispute.reason}”</blockquote>
      <SegmentedControl
        value={mode}
        onChange={setMode}
        className="w-full"
        options={[
          { value: "keep", label: "Keep rating" },
          { value: "change", label: "Change rating" },
        ]}
      />
      {mode === "change" && (
        <Field label="New rating">
          <StarRating value={rating} onChange={setRating} />
        </Field>
      )}
      <Field label="Decision" htmlFor="dsp-decision" required hint="The employee and the reviewer see this.">
        <Textarea id="dsp-decision" value={decision} onChange={(e) => setDecision(e.target.value)} />
      </Field>
      <DialogFooter>
        <Button variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button
          disabled={!ok}
          loading={decide.isPending}
          onClick={async () => {
            try {
              await decide.mutateAsync({ id: dispute.id, change: mode === "change", decision: decision.trim(), newRating: mode === "change" ? rating : undefined });
              toast.success(mode === "change" ? "Rating changed; the scorecard was recalculated" : "Rating kept");
              close();
            } catch (e) {
              toast.error(errMsg(e));
            }
          }}
        >
          Save decision
        </Button>
      </DialogFooter>
    </>
  );
}

export function DecideDisputeDialog({ dispute, onOpenChange }: { dispute: RatingDispute | null; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={!!dispute} onOpenChange={onOpenChange}>
      <DialogContent size="sm">{dispute && <DecideDisputeForm key={dispute.id} dispute={dispute} close={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}

/* ---------------- Review a task ---------------- */

/** Approve with a 1–5 rating, or send to rework with a reason (plan §10). */
function ReviewTaskForm({ task, close }: { task: Task; close: () => void }) {
  const [mode, setMode] = React.useState<"approve" | "rework">("approve");
  const [rating, setRating] = React.useState(0);
  const [text, setText] = React.useState("");
  const transition = useTransitionTask();
  const ok = mode === "approve" ? rating > 0 : text.trim().length >= 5;
  return (
    <>
      <DialogHeader>
        <DialogTitle>Review {task.number}</DialogTitle>
        <DialogDescription>{task.title}</DialogDescription>
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
        <>
          <Field label="Rating" required hint="Goes straight into the employee's quality score.">
            <StarRating value={rating} onChange={setRating} size={24} />
          </Field>
          <Field label="Comment (optional)" htmlFor="rv-comment">
            <Textarea id="rv-comment" value={text} onChange={(e) => setText(e.target.value)} placeholder="What was good, what to improve" />
          </Field>
        </>
      ) : (
        <Field label="What needs to change?" htmlFor="rv-reason" required hint="The task goes back to In progress with your reason.">
          <Textarea id="rv-reason" value={text} onChange={(e) => setText(e.target.value)} />
        </Field>
      )}
      <DialogFooter>
        <Button variant="outline" onClick={close}>
          Cancel
        </Button>
        <Button
          variant={mode === "rework" ? "destructive" : "default"}
          disabled={!ok}
          loading={transition.isPending}
          onClick={async () => {
            try {
              if (mode === "approve") await transition.mutateAsync({ id: task.id, to: "approved", rating, comment: text.trim() || undefined });
              else await transition.mutateAsync({ id: task.id, to: "rework", reason: text.trim() });
              toast.success(mode === "approve" ? `${task.number} approved with ${rating}★` : `${task.number} sent back for rework`);
              close();
            } catch (e) {
              toast.error(errMsg(e));
            }
          }}
        >
          {mode === "approve" ? "Approve" : "Send to rework"}
        </Button>
      </DialogFooter>
    </>
  );
}

export function ReviewTaskDialog({ task, onOpenChange }: { task: Task | null; onOpenChange: (o: boolean) => void }) {
  return (
    <Dialog open={!!task} onOpenChange={onOpenChange}>
      <DialogContent size="sm">{task && <ReviewTaskForm key={task.id} task={task} close={() => onOpenChange(false)} />}</DialogContent>
    </Dialog>
  );
}
