"use client";
import * as React from "react";
import { QRCodeSVG } from "qrcode.react";
import { CircleAlert } from "lucide-react";
import type { TwoFactorSetupResponse } from "@aceva/contracts";
import { Button } from "@/components/ui/button";
import { OtpInput } from "@/components/shared/otp-input";
import { ApiError } from "@/lib/api/mock";
import type { ServerStage } from "@/lib/auth/session";
import { authApi } from "../api";

/** The secret in groups of four, easier to type: "JBSW Y3DP EHPK 3PXP". */
const grouped = (secret: string) => secret.replace(/(.{4})/g, "$1 ").trim();

/**
 * Sets up the authenticator app (QR code and typed key) and checks the first 6-digit code on the server.
 * If two-step login is already set up, it only asks for the current code.
 * Used on the "two-step login required" screen, in the first-login wizard and in Account settings.
 */
export function TwoFactorSetupPanel({
  onVerified,
  onFatal,
  submitLabel = "Verify and continue",
}: {
  onVerified: (stage: ServerStage | undefined) => void;
  /** Called when the server ended the session (too many wrong codes). */
  onFatal?: (message: string) => void;
  submitLabel?: string;
}) {
  const [setup, setSetup] = React.useState<TwoFactorSetupResponse | null>(null);
  const [alreadyOn, setAlreadyOn] = React.useState(false);
  const [loadError, setLoadError] = React.useState<string | null>(null);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const started = React.useRef(false);

  React.useEffect(() => {
    if (started.current) return;
    started.current = true;
    authApi
      .setup2fa()
      .then(setSetup)
      .catch((err: unknown) => {
        if (err instanceof ApiError && err.code === "already_enabled") setAlreadyOn(true);
        else setLoadError(err instanceof Error ? err.message : "Couldn't start the set-up.");
      });
  }, []);

  const verify = async (value = code) => {
    const digits = value.replace(/\s/g, "");
    if (digits.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      const res = await authApi.verify2fa(digits);
      onVerified(res.stage);
    } catch (err) {
      if (err instanceof ApiError && err.code === "too_many_wrong_codes") onFatal?.(err.message);
      else setError(err instanceof Error ? err.message : "That code didn't work.");
      setCode("");
    } finally {
      setBusy(false);
    }
  };

  if (loadError) {
    return (
      <p role="alert" className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-3 py-2 text-[13px]">
        <CircleAlert className="size-4 text-danger" /> {loadError}
      </p>
    );
  }

  return (
    <div className="grid gap-4">
      {!alreadyOn && (
        <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4">
          <div className="grid size-32 shrink-0 place-content-center rounded-lg border border-border bg-white p-2">
            {setup ? <QRCodeSVG value={setup.otpauthUrl} size={112} aria-label="Authenticator QR code" /> : <span className="text-[12px] text-muted-foreground">Loading…</span>}
          </div>
          <div className="min-w-0 text-[12.5px] text-muted-foreground">
            Scan this with Google or Microsoft Authenticator. Can&apos;t scan? Enter this key:
            <p className="mt-1 break-all font-mono text-[13px] font-semibold tracking-wider text-foreground">{setup ? grouped(setup.secret) : "…"}</p>
          </div>
        </div>
      )}
      <div>
        <p className="mb-2 text-[13px] font-medium">Enter the 6-digit code from the app</p>
        <OtpInput value={code} onChange={(v) => { setCode(v); setError(null); }} invalid={!!error} onComplete={verify} />
        {error && (
          <p role="alert" className="mt-2 text-[13px] text-danger">
            {error}
          </p>
        )}
      </div>
      <Button size="lg" loading={busy} disabled={code.replace(/\s/g, "").length !== 6 || (!alreadyOn && !setup)} onClick={() => verify()}>
        {submitLabel}
      </Button>
    </div>
  );
}
