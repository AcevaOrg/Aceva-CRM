"use client";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { SegmentedControl } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { formatMonthKey } from "@/lib/dates";
import { formatMoney } from "@/lib/format";
import { useAddAdjustment } from "../hooks";
import { nextMonthKey } from "../logic";
import type { PayrollRun } from "../types";

/** Fix a mistake in an approved run through next month's payroll (plan §12). */
export function AdjustmentDialog({ run, empId, name, open, onOpenChange }: { run: PayrollRun; empId: string; name: string; open: boolean; onOpenChange: (o: boolean) => void }) {
  const add = useAddAdjustment();
  const [kind, setKind] = React.useState<"add" | "deduct">("add");
  const [amount, setAmount] = React.useState("");
  const [note, setNote] = React.useState("");
  const value = Number(amount);
  const valid = value > 0 && note.trim().length >= 3;
  const toMonth = formatMonthKey(nextMonthKey(run.month));

  const save = async () => {
    await add.mutateAsync({ runId: run.id, empId, amount: kind === "add" ? value : -value, note: note.trim() });
    toast.success(`Adjustment added to ${toMonth}`, { description: `${kind === "add" ? "+" : "−"}${formatMoney(value)} for ${name}. Logged.` });
    onOpenChange(false);
    setAmount("");
    setNote("");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Add adjustment for {name}</DialogTitle>
          <DialogDescription>
            {formatMonthKey(run.month)} is approved and can&apos;t be edited. The adjustment is added to the {toMonth} payroll.
          </DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <SegmentedControl
            value={kind}
            onChange={setKind}
            options={[
              { value: "add", label: "Pay more" },
              { value: "deduct", label: "Deduct" },
            ]}
            ariaLabel="Adjustment type"
          />
          <Field label="Amount (PKR)" htmlFor="adj-amount">
            <Input id="adj-amount" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ""))} className="font-mono" placeholder="5000" />
          </Field>
          <Field label="Reason" htmlFor="adj-note" hint="Shown on the payslip and saved in the audit log.">
            <Textarea id="adj-note" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Allowance missed in October" />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={save} disabled={!valid} loading={add.isPending}>
            Add to {toMonth.split(" ")[0]}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
