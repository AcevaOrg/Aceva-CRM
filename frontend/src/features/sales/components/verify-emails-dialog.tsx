"use client";
import * as React from "react";
import { toast } from "sonner";
import { Coins, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/misc";
import { useVerifyEmails, useVerifyPreview } from "../hooks";
import type { VerifyResult } from "../types";

/** Sends emails to MillionVerifier through Aceva (plan §21): 1 credit each, 90-day skip rule. */
export function VerifyEmailsDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (o: boolean) => void }) {
  const preview = useVerifyPreview(open);
  const verify = useVerifyEmails();
  // The caller mounts this dialog only while it's open, so the result starts empty each time.
  const [result, setResult] = React.useState<VerifyResult | null>(null);

  const p = preview.data;
  const enough = p ? p.creditsLeft >= p.toCheck : false;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent size="sm">
        <DialogHeader>
          <span className="mb-1 grid size-10 place-content-center rounded-xl bg-zone-work/12 text-zone-work">
            <MailCheck className="size-5" />
          </span>
          <DialogTitle>{result ? "Emails checked" : "Verify emails"}</DialogTitle>
          <DialogDescription>Only valid emails can go into an outreach sequence. Checks go through Aceva so we know who asked for them.</DialogDescription>
        </DialogHeader>
        {result ? (
          <div className="grid gap-3">
            <dl className="grid grid-cols-2 gap-2 text-[13px]">
              {[
                ["Valid", result.valid, "text-success"],
                ["Invalid", result.invalid, "text-danger"],
                ["Catch-all", result.catchAll, "text-[oklch(0.6_0.14_70)]"],
                ["Unknown", result.unknown, "text-muted-foreground"],
              ].map(([k, v, c]) => (
                <div key={k as string} className="rounded-lg border border-border p-2.5">
                  <dt className="text-[11.5px] text-muted-foreground">{k}</dt>
                  <dd className={`text-xl font-semibold tabular ${c}`}>{v}</dd>
                </div>
              ))}
            </dl>
            <p className="text-[12.5px] text-muted-foreground">
              {result.skippedRecent} checked in the last 90 days were skipped. {result.creditsLeft.toLocaleString()} credits left.
            </p>
          </div>
        ) : !p ? (
          <Skeleton className="h-32" />
        ) : (
          <div className="grid gap-2 text-[13px]">
            <Row label="Emails to check" value={p.toCheck} />
            <Row label="Checked in the last 90 days, skipped" value={p.skippedRecent} muted />
            <div className="my-1 h-px bg-border" />
            <Row label="Credits this will use" value={p.toCheck} icon />
            <Row label="Credits left on MillionVerifier" value={p.creditsLeft} />
            {!enough && <p className="text-[12.5px] text-danger">Not enough credits. Ask the Director to top up MillionVerifier.</p>}
          </div>
        )}
        <DialogFooter>
          {result ? (
            <Button onClick={() => onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button
                disabled={!p || !p.toCheck || !enough}
                loading={verify.isPending}
                onClick={() =>
                  verify.mutate(undefined, {
                    onSuccess: (r) => {
                      setResult(r);
                      toast.success(`${r.checked} emails checked`, { description: `${r.valid} valid, ${r.invalid} invalid.` });
                    },
                    onError: (e) => toast.error(e instanceof Error ? e.message : "Verification failed."),
                  })
                }
              >
                Check {p?.toCheck ?? ""} emails
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Row({ label, value, muted, icon }: { label: string; value: number; muted?: boolean; icon?: boolean }) {
  return (
    <div className="flex items-center justify-between">
      <span className={muted ? "text-muted-foreground" : ""}>{label}</span>
      <span className="flex items-center gap-1.5 font-mono font-semibold tabular">
        {icon && <Coins className="size-3.5 text-[oklch(0.65_0.14_75)]" />}
        {value.toLocaleString()}
      </span>
    </div>
  );
}
