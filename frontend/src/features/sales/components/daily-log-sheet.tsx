"use client";
import * as React from "react";
import { Minus, Plus, Info } from "lucide-react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { useSubmitDailyLog } from "../hooks";
import type { ManualDailyLog, SelfReported } from "../types";
import { SELF_REPORTED_FIELDS } from "./sales-ui";

const EMPTY: SelfReported = { linkedin: 0, whatsapp: 0, fiverr: 0, calls: 0, fieldVisits: 0 };

/** Manual daily log (plan §20): work outside the connected tools, marked "self-reported". */
export function DailyLogSheet({ open, onOpenChange, existing }: { open: boolean; onOpenChange: (o: boolean) => void; existing?: ManualDailyLog }) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {/* Content unmounts when closed, so the form starts fresh on every open. */}
      <SheetContent size="md">
        <LogForm existing={existing} onDone={() => onOpenChange(false)} />
      </SheetContent>
    </Sheet>
  );
}

function LogForm({ existing, onDone }: { existing?: ManualDailyLog; onDone: () => void }) {
  const [counts, setCounts] = React.useState<SelfReported>(() =>
    existing ? { linkedin: existing.linkedin, whatsapp: existing.whatsapp, fiverr: existing.fiverr, calls: existing.calls, fieldVisits: existing.fieldVisits } : EMPTY,
  );
  const [note, setNote] = React.useState(existing?.note ?? "");
  const submit = useSubmitDailyLog();
  const onOpenChange = (o: boolean) => !o && onDone();

  const set = (k: keyof SelfReported, v: number) => setCounts((c) => ({ ...c, [k]: Math.max(0, Math.min(999, v)) }));
  const total = Object.values(counts).reduce((a, b) => a + b, 0);

  return (
    <>
        <SheetHeader>
          <SheetTitle>Log my sales day</SheetTitle>
          <SheetDescription>Work done outside Apollo and the outreach mailboxes. Takes about 2 minutes, before you check out.</SheetDescription>
        </SheetHeader>
        <SheetBody className="grid content-start gap-5">
          <div className="flex gap-2.5 rounded-lg border border-info/30 bg-info/10 px-3 py-2.5 text-[12.5px]">
            <Info className="mt-0.5 size-4 shrink-0 text-info" />
            <p>
              These counts are marked <span className="font-semibold">self-reported</span>. They count toward Activity only, and the Director can ask for proof,
              such as a screenshot, for any day.
            </p>
          </div>
          <ul className="grid gap-2">
            {SELF_REPORTED_FIELDS.map((f) => (
              <li key={f.key} className="flex items-center justify-between gap-3 rounded-xl border border-border bg-card px-3 py-2.5">
                <span className="flex items-center gap-2.5 text-[13.5px] font-medium [&_svg]:size-4 [&_svg]:text-muted-foreground">
                  {f.icon}
                  {f.label}
                </span>
                <span className="flex items-center gap-1">
                  <Button type="button" size="icon-sm" variant="outline" onClick={() => set(f.key, counts[f.key] - 1)} aria-label={`Fewer ${f.label}`} disabled={!counts[f.key]}>
                    <Minus />
                  </Button>
                  <input
                    inputMode="numeric"
                    aria-label={f.label}
                    value={counts[f.key]}
                    onChange={(e) => set(f.key, Number(e.target.value.replace(/\D/g, "") || 0))}
                    className="h-8 w-12 rounded-md border border-input bg-card text-center font-mono text-[14px] font-semibold tabular outline-none focus:border-ring"
                  />
                  <Button type="button" size="icon-sm" variant="outline" onClick={() => set(f.key, counts[f.key] + 1)} aria-label={`More ${f.label}`}>
                    <Plus />
                  </Button>
                </span>
              </li>
            ))}
          </ul>
          <Field label="Note (optional)" htmlFor="log-note" hint="For example: two walk-in inquiries at the expo stand.">
            <Textarea id="log-note" value={note} onChange={(e) => setNote(e.target.value)} />
          </Field>
        </SheetBody>
        <SheetFooter className="justify-between">
          <Badge tone="outline">{total} self-reported today</Badge>
          <div className="flex gap-2">
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              loading={submit.isPending}
              onClick={() =>
                submit.mutate(
                  { ...counts, note: note.trim() || undefined },
                  {
                    onSuccess: () => {
                      toast.success("Daily log saved", { description: "Marked as self-reported in today's sales report." });
                      onOpenChange(false);
                    },
                  },
                )
              }
            >
              {existing ? "Update log" : "Save log"}
            </Button>
          </div>
        </SheetFooter>
    </>
  );
}
