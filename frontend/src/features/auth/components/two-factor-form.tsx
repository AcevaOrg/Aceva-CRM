"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Smartphone } from "lucide-react";
import { Button } from "@/components/ui/button";
import { OtpInput } from "@/components/shared/otp-input";
import { useSession } from "@/lib/auth/session";
import { authApi } from "../api";
import { AuthHeading } from "./auth-frame";

export function TwoFactorForm() {
  const router = useRouter();
  const stage = useSession((s) => s.stage);
  const complete2fa = useSession((s) => s.complete2fa);
  const signOut = useSession((s) => s.signOut);
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const [bad, setBad] = React.useState(false);

  React.useEffect(() => {
    if (stage === "signed_out") router.replace("/login");
  }, [stage, router]);

  const verify = async (value = code) => {
    if (value.replace(/\s/g, "").length !== 6) return;
    setBusy(true);
    const res = await authApi.verify2fa(value.replace(/\s/g, ""));
    setBusy(false);
    if (!res.ok) return setBad(true);
    const next = complete2fa();
    router.push(next === "needs_first_login" ? "/first-login" : "/");
  };

  return (
    <>
      <span className="mb-5 grid size-12 place-content-center rounded-2xl bg-primary/10 text-primary">
        <Smartphone className="size-6" />
      </span>
      <AuthHeading title="Two-step sign in" description="Enter the 6-digit code from Google or Microsoft Authenticator." />
      <form
        className="grid gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          verify();
        }}
      >
        <OtpInput value={code} onChange={(v) => { setCode(v); setBad(false); }} autoFocus invalid={bad} onComplete={verify} />
        {bad && <p role="alert" className="text-[13px] text-danger">That code didn&apos;t work. Codes change every 30 seconds.</p>}
        <p className="text-[12.5px] text-muted-foreground">Required for levels 1 to 3 and anyone with finance duty. Demo: any 6 digits work.</p>
        <Button type="submit" size="lg" loading={busy} disabled={code.replace(/\s/g, "").length !== 6}>
          Verify and continue
        </Button>
        <Link href="/login" onClick={() => signOut()} className="justify-self-center text-[13px] text-muted-foreground hover:text-foreground">
          Use a different Emp-ID
        </Link>
      </form>
    </>
  );
}
