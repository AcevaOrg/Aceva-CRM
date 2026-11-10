"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Check, CircleCheck, CircleX, QrCode } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/controls";
import { OtpInput } from "@/components/shared/otp-input";
import { isLive } from "@/lib/api/http";
import { useSession } from "@/lib/auth/session";
import { requires2fa } from "@/lib/auth/viewer";
import { cn } from "@/lib/utils";
import { EMPLOYEES } from "@/mocks/seed/people";
import { authApi } from "../api";
import { POLICY_VERSION, TRACKING_NEVER as NEVER, TRACKING_RECORDED as RECORDED } from "../policy";
import { AuthHeading } from "./auth-frame";
import { PasswordFields } from "./password-fields";
import { TwoFactorSetupPanel } from "./two-factor-setup";
import { toast } from "sonner";

export { POLICY_VERSION };

export function FirstLoginWizard() {
  const router = useRouter();
  const empId = useSession((s) => s.empId);
  const stage = useSession((s) => s.stage);
  const completeFirstLogin = useSession((s) => s.completeFirstLogin);
  // Live: who this is comes from the server (new hires are not in the built-in demo roster).
  const [liveMe, setLiveMe] = React.useState<{ empId: string; name: string; twoFactorRequired: boolean } | null>(null);
  React.useEffect(() => {
    if (isLive("m2")) authApi.me().then(setLiveMe).catch(() => undefined);
  }, []);
  const mockEmp = EMPLOYEES.find((e) => e.empId === empId);
  const emp = isLive("m2") ? (liveMe ? { empId: liveMe.empId, name: liveMe.name } : undefined) : mockEmp;
  const needs2fa = isLive("m2") ? !!liveMe?.twoFactorRequired : mockEmp ? requires2fa(mockEmp) : false;
  const steps = ["Password", "Tracking policy", ...(needs2fa ? ["Two-step login"] : [])];
  const [step, setStep] = React.useState(0);
  const [pw, setPw] = React.useState<string | null>(null);
  const [accepted, setAccepted] = React.useState(false);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const onValid = React.useCallback((v: string | null) => setPw(v), []);

  React.useEffect(() => {
    if (stage === "signed_out") router.replace("/login");
    if (stage === "signed_in") router.replace("/");
  }, [stage, router]);

  if (!emp) return null;

  const next = async () => {
    setBusy(true);
    try {
      if (step === 0 && pw) await authApi.changePassword(pw);
      if (step === 1) await authApi.acceptPolicy(POLICY_VERSION);
      if (step === 2 && !isLive("m2")) await authApi.setup2fa();
    } catch (err) {
      setBusy(false);
      toast.error(err instanceof Error ? err.message : "Couldn't save this step.");
      return;
    }
    setBusy(false);
    if (step < steps.length - 1) setStep(step + 1);
    else {
      completeFirstLogin();
      router.push("/");
    }
  };

  const liveTwoFactorStep = isLive("m2") && step === 2;
  const canNext = step === 0 ? !!pw : step === 1 ? accepted : code.replace(/\s/g, "").length === 6;

  return (
    <>
      <ol className="mb-8 flex items-center gap-2" aria-label="Steps">
        {steps.map((s, i) => (
          <li key={s} className="flex flex-1 items-center gap-2">
            <span
              className={cn(
                "grid size-6 shrink-0 place-content-center rounded-full text-[11px] font-bold",
                i < step ? "bg-success text-white" : i === step ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground",
              )}
            >
              {i < step ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
            </span>
            <span className={cn("truncate text-[12px] font-medium", i === step ? "text-foreground" : "text-muted-foreground")}>{s}</span>
            {i < steps.length - 1 && <span className="h-px flex-1 bg-border" />}
          </li>
        ))}
      </ol>

      {step === 0 && (
        <>
          <AuthHeading title={`Welcome, ${emp.name.split(" ")[0]}`} description="Set a new password to replace the temporary one." />
          <PasswordFields empId={emp.empId} onValid={onValid} />
        </>
      )}

      {step === 1 && (
        <>
          <AuthHeading title="What the system records" description="Read this once. You can see your own history any time under Activity." />
          <div className="grid gap-3">
            <PolicyList title="We record" items={RECORDED} good />
            <PolicyList title="We never record" items={NEVER} />
          </div>
          <label className="mt-5 flex cursor-pointer items-start gap-3 rounded-lg border border-border p-3 text-[13px]">
            <Checkbox checked={accepted} onCheckedChange={(v) => setAccepted(v === true)} className="mt-0.5" />
            <span>I have read the tracking policy (version {POLICY_VERSION}) and accept it. Tracking data is confidential and used only for security and work review.</span>
          </label>
        </>
      )}

      {liveTwoFactorStep && (
        <>
          <AuthHeading title="Turn on two-step login" description="Required for your level or finance duty. Scan the code with Google or Microsoft Authenticator." />
          <TwoFactorSetupPanel
            submitLabel="Finish and open Aceva"
            onVerified={() => {
              completeFirstLogin();
              router.push("/");
            }}
            onFatal={() => router.replace("/login")}
          />
        </>
      )}

      {step === 2 && !liveTwoFactorStep && (
        <>
          <AuthHeading title="Turn on two-step login" description="Required for your level or finance duty. Scan the code with Google or Microsoft Authenticator." />
          <div className="flex items-center gap-4 rounded-xl border border-border bg-card p-4">
            <div className="grid size-28 shrink-0 place-content-center rounded-lg border border-dashed border-border bg-muted text-muted-foreground">
              <QrCode className="size-12" />
            </div>
            <div className="text-[12.5px] text-muted-foreground">
              Can&apos;t scan? Enter this key:
              <p className="mt-1 font-mono text-[13px] font-semibold tracking-wider text-foreground">JBSW Y3DP EHPK 3PXP</p>
            </div>
          </div>
          <p className="mb-2 mt-5 text-[13px] font-medium">Enter the 6-digit code from the app</p>
          <OtpInput value={code} onChange={setCode} />
        </>
      )}

      {!liveTwoFactorStep && (
        <Button size="lg" className="mt-7 w-full" disabled={!canNext} loading={busy} onClick={next}>
          {step < steps.length - 1 ? "Continue" : "Finish and open Aceva"}
        </Button>
      )}
    </>
  );
}

function PolicyList({ title, items, good }: { title: string; items: string[]; good?: boolean }) {
  return (
    <div className={cn("rounded-xl border p-4", good ? "border-seal-own/30 bg-seal-own/6" : "border-border bg-muted/50")}>
      <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      <ul className="grid gap-1.5 text-[13px]">
        {items.map((t) => (
          <li key={t} className="flex gap-2">
            {good ? <CircleCheck className="mt-0.5 size-4 shrink-0 text-seal-own" /> : <CircleX className="mt-0.5 size-4 shrink-0 text-muted-foreground" />}
            {t}
          </li>
        ))}
      </ul>
    </div>
  );
}
