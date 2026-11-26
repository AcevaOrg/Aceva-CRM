"use client";
/** Log activity dialog and Create deal sheet (lead page, pipeline). */
import * as React from "react";
import { useRouter } from "next/navigation";
import { useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { NativeSelect, SegmentedControl } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Sheet, SheetBody, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { addWorkingDays, isoDay } from "@/lib/dates";
import { useCreateDeal, useLogActivity } from "../hooks";
import { ACTIVITY_LABEL, activityLoggedMessage, DNC_BLOCKED_KINDS, isWebLink, SERVICE_LABEL } from "../logic";
import type { ActivityKind, Deal, DealService } from "../types";
import { dayToIso } from "./follow-up-dialog";

/** What a salesperson logs by hand (plan section 20; Fiverr inquiries by decision of the CTO). Tool entries come from Module 16. */
const MANUAL_KINDS: ActivityKind[] = ["call", "email_sent", "reply", "meeting", "linkedin", "whatsapp", "fiverr", "proposal", "note"];

export function LogActivityDialog({
  open,
  onOpenChange,
  leadId,
  deals,
  doNotContact = false,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  leadId: string;
  deals: Deal[];
  /** M15.4: the lead asked not to be contacted, so only replies, notes and Fiverr inquiries are offered. */
  doNotContact?: boolean;
}) {
  const kinds = doNotContact ? MANUAL_KINDS.filter((k) => !DNC_BLOCKED_KINDS.includes(k)) : MANUAL_KINDS;
  // The caller mounts this dialog only while it's open, so state starts fresh each time.
  const [kind, setKind] = React.useState<ActivityKind>(kinds[0]);
  const [dealId, setDealId] = React.useState(() => deals.find((d) => !["won", "lost"].includes(d.stage))?.id ?? "");
  const [summary, setSummary] = React.useState("");
  const [day, setDay] = React.useState(() => isoDay(new Date()));
  const [meetingAt, setMeetingAt] = React.useState("");
  const [proposalUrl, setProposalUrl] = React.useState("");
  const log = useLogActivity();
  const linkBad = kind === "proposal" && proposalUrl.trim() !== "" && !isWebLink(proposalUrl);

  const today = isoDay(new Date());
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>Log activity</DialogTitle>
          <DialogDescription>
            {doNotContact
              ? "This lead asked not to be contacted: only a reply or a note can be logged."
              : "For contact outside the connected tools. It shows on the timeline as Manual."}
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (summary.trim().length < 3 || linkBad) return;
            const at = day === today ? new Date().toISOString() : dayToIso(day, "12:00");
            log.mutate(
              {
                leadId,
                dealId: dealId || undefined,
                kind,
                summary: summary.trim(),
                at,
                meetingAt: kind === "meeting" && meetingAt ? new Date(meetingAt).toISOString() : undefined,
                proposalUrl: kind === "proposal" && proposalUrl.trim() ? proposalUrl.trim() : undefined,
              },
              {
                onSuccess: (result) => {
                  // Saved either way; the message says whether the deal moved, or in plain words why its stage stayed.
                  const m = activityLoggedMessage(kind, result);
                  (m.tone === "info" ? toast.info : toast.success)(m.title, m.description ? { description: m.description } : undefined);
                  onOpenChange(false);
                },
                onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't log the activity."),
              },
            );
          }}
        >
          <Field label="What happened" htmlFor="la-kind">
            <NativeSelect id="la-kind" value={kind} onChange={(e) => setKind(e.target.value as ActivityKind)}>
              {kinds.map((k) => (
                <option key={k} value={k}>
                  {ACTIVITY_LABEL[k]}
                </option>
              ))}
            </NativeSelect>
          </Field>
          {deals.length > 0 && (
            <Field label="Deal" htmlFor="la-deal">
              <NativeSelect id="la-deal" value={dealId} onChange={(e) => setDealId(e.target.value)}>
                <option value="">Not linked to a deal</option>
                {deals.map((d) => (
                  <option key={d.id} value={d.id}>
                    {d.number} · {SERVICE_LABEL[d.service]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field label="Summary" htmlFor="la-summary" required hint="Only work facts. Don't paste email or chat text.">
            <Textarea id="la-summary" autoFocus value={summary} onChange={(e) => setSummary(e.target.value)} placeholder="For example: 10-minute call, wants a quote by Friday" />
          </Field>
          {kind === "meeting" && (
            <Field label="Meeting date and time" htmlFor="la-meeting" hint="With a date, the deal moves to Meeting booked (forward only).">
              <Input id="la-meeting" type="datetime-local" value={meetingAt} onChange={(e) => setMeetingAt(e.target.value)} />
            </Field>
          )}
          {kind === "proposal" && (
            <Field label="Proposal link" htmlFor="la-proposal" error={linkBad ? "Enter a web address starting with https://" : undefined} hint="A link only. With a link, the deal moves to Proposal sent (forward only).">
              <Input id="la-proposal" value={proposalUrl} onChange={(e) => setProposalUrl(e.target.value)} placeholder="https://" aria-invalid={linkBad || undefined} />
            </Field>
          )}
          <Field label="Date" htmlFor="la-date">
            <Input id="la-date" type="date" max={today} value={day} onChange={(e) => setDay(e.target.value)} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={summary.trim().length < 3 || linkBad} loading={log.isPending}>
              Log activity
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const dealSchema = z.object({
  service: z.enum(["website", "custom_software", "ai_automation", "mobile_app", "ecommerce"]),
  amount: z.string().trim().refine((v) => Number(v) > 0, "Enter the estimated value."),
  currency: z.enum(["USD", "PKR"]),
  expectedClose: z.string().min(1, "Pick the expected close date."),
  nextStep: z.string().trim().min(3, "Every open deal needs a next step."),
  nextStepDate: z.string().min(1, "Pick a date for the next step."),
});
type DealForm = z.infer<typeof dealSchema>;

export function CreateDealSheet({ open, onOpenChange, leadId, leadName, defaultCurrency = "USD" }: { open: boolean; onOpenChange: (o: boolean) => void; leadId: string; leadName: string; defaultCurrency?: "USD" | "PKR" }) {
  const router = useRouter();
  const create = useCreateDeal();
  const defaults = React.useMemo<DealForm>(
    () => ({ service: "website", amount: "", currency: defaultCurrency, expectedClose: isoDay(addWorkingDays(new Date(), 20)), nextStep: "Send the first email from the Apollo sequence", nextStepDate: isoDay(addWorkingDays(new Date(), 1)) }),
    [defaultCurrency],
  );
  const { register, handleSubmit, formState, reset, control, setValue } = useForm<DealForm>({ resolver: zodResolver(dealSchema), defaultValues: defaults });
  React.useEffect(() => {
    if (open) reset(defaults);
  }, [open, reset, defaults]);
  const currency = useWatch({ control, name: "currency" });

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent size="md">
        <SheetHeader>
          <SheetTitle>Create a deal</SheetTitle>
          <SheetDescription>One sales opportunity with {leadName}. It starts in New.</SheetDescription>
        </SheetHeader>
        <form
          className="flex min-h-0 flex-1 flex-col"
          onSubmit={handleSubmit((v) =>
            create.mutate(
              {
                leadId,
                service: v.service as DealService,
                value: { amount: Number(v.amount).toFixed(2), currency: v.currency },
                expectedClose: dayToIso(v.expectedClose),
                nextStep: v.nextStep,
                nextStepDate: dayToIso(v.nextStepDate),
              },
              {
                onSuccess: (d) => {
                  toast.success(`${d.number} created`, { description: "It's on your pipeline in New." });
                  onOpenChange(false);
                  router.push(`/sales/deals/${d.id}`);
                },
                onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't create the deal."),
              },
            ),
          )}
        >
          <SheetBody className="grid content-start gap-4">
            <Field label="Service" htmlFor="dl-service" required>
              <NativeSelect id="dl-service" {...register("service")}>
                {(Object.keys(SERVICE_LABEL) as DealService[]).map((s) => (
                  <option key={s} value={s}>
                    {SERVICE_LABEL[s]}
                  </option>
                ))}
              </NativeSelect>
            </Field>
            <Field label="Estimated value" htmlFor="dl-amount" required error={formState.errors.amount?.message}>
              <div className="flex gap-2">
                <Input id="dl-amount" inputMode="decimal" placeholder="0" className="font-mono" {...register("amount")} aria-invalid={!!formState.errors.amount} />
                <SegmentedControl value={currency} onChange={(c) => setValue("currency", c)} options={[{ value: "USD", label: "USD" }, { value: "PKR", label: "PKR" }]} ariaLabel="Currency" />
              </div>
            </Field>
            <Field label="Expected close date" htmlFor="dl-close" required error={formState.errors.expectedClose?.message}>
              <Input id="dl-close" type="date" {...register("expectedClose")} />
            </Field>
            <Field label="Next step" htmlFor="dl-next" required error={formState.errors.nextStep?.message}>
              <Input id="dl-next" {...register("nextStep")} />
            </Field>
            <Field label="Next step date" htmlFor="dl-next-date" required error={formState.errors.nextStepDate?.message}>
              <Input id="dl-next-date" type="date" min={isoDay(new Date())} {...register("nextStepDate")} />
            </Field>
          </SheetBody>
          <SheetFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button type="submit" loading={create.isPending}>
              Create deal
            </Button>
          </SheetFooter>
        </form>
      </SheetContent>
    </Sheet>
  );
}
