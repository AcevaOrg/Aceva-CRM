"use client";
import * as React from "react";
import { toast } from "sonner";
import { ShieldAlert } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Textarea } from "@/components/ui/input";
import { http } from "@/lib/api/http";
import type { Employee } from "@/types";

/**
 * Lost authenticator phone: reset the second step for someone below you. Every session of that person ends, the old
 * authenticator stops working, and they set up a new one at their next sign-in. A reason is required and the reset is
 * recorded in the audit log. The server decides who may do this (never yourself, never upward or sideways).
 */
export function ResetTwoFactorDialog({ employee, onClose }: { employee: Employee; onClose: () => void }) {
  const [reason, setReason] = React.useState("");
  const [busy, setBusy] = React.useState(false);

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <span className="mb-1 grid size-10 place-content-center rounded-xl bg-warning/15 text-[oklch(0.55_0.13_70)]">
            <ShieldAlert className="size-5" />
          </span>
          <DialogTitle>Reset authenticator for {employee.name}</DialogTitle>
          <DialogDescription>
            Use this when their phone is lost. They are signed out everywhere, their old authenticator stops working, and they set up a new one at the next sign-in.
          </DialogDescription>
        </DialogHeader>
        <Field label="Reason" htmlFor="r2fa-reason" required hint="Saved in the audit log.">
          <Textarea id="r2fa-reason" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Phone lost; identity confirmed in person" />
        </Field>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="destructive"
            disabled={reason.trim().length < 5}
            loading={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await http.post(`/auth/employees/${employee.empId}/reset-2fa`, { reason: reason.trim() });
                toast.success(`Authenticator reset for ${employee.name}`, { description: "They are signed out and must set up a new authenticator." });
                onClose();
              } catch (e) {
                toast.error(e instanceof Error ? e.message : "Couldn't reset the authenticator.");
              } finally {
                setBusy(false);
              }
            }}
          >
            Reset authenticator
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
