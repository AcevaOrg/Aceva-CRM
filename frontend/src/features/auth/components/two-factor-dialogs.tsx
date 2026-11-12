"use client";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { OtpInput } from "@/components/shared/otp-input";
import { authApi } from "../api";
import { TwoFactorSetupPanel } from "./two-factor-setup";

/** Turn two-step login on from Account settings (only where it is optional). */
export function EnableTwoFactorDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Turn on two-step login</DialogTitle>
          <DialogDescription>After your password you will enter a 6-digit code from the app.</DialogDescription>
        </DialogHeader>
        <TwoFactorSetupPanel
          submitLabel="Turn on"
          onVerified={() => {
            toast.success("Two-step login turned on", { description: "Security events are logged." });
            onDone();
            onClose();
          }}
          onFatal={() => onClose()}
        />
      </DialogContent>
    </Dialog>
  );
}

/** Turn two-step login off: needs the password and a current code. */
export function DisableTwoFactorDialog({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);

  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await authApi.disable2fa(password, code.replace(/\s/g, ""));
      toast.success("Two-step login turned off", { description: "Security events are logged." });
      onDone();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Couldn't turn it off.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Turn off two-step login</DialogTitle>
          <DialogDescription>Enter your password and a current code from the app.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <Field label="Password" htmlFor="dis-pw">
            <Input id="dis-pw" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <div>
            <p className="mb-2 text-[13px] font-medium">6-digit code</p>
            <OtpInput value={code} onChange={setCode} />
          </div>
          {error && (
            <p role="alert" className="text-[13px] text-danger">
              {error}
            </p>
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="destructive" loading={busy} disabled={!password || code.replace(/\s/g, "").length !== 6} onClick={submit}>
            Turn off
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
