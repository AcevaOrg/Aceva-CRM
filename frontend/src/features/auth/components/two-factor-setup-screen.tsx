"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { ShieldCheck } from "lucide-react";
import { useSession } from "@/lib/auth/session";
import { AuthHeading } from "./auth-frame";
import { TwoFactorSetupPanel } from "./two-factor-setup";

/** /login/setup: two-step login is required for this person but not set up yet. Nothing else works until it is. */
export function TwoFactorSetupScreen() {
  const router = useRouter();
  const stage = useSession((s) => s.stage);
  const empId = useSession((s) => s.empId);
  const applyServerStage = useSession((s) => s.applyServerStage);
  const signOut = useSession((s) => s.signOut);

  React.useEffect(() => {
    if (stage === "signed_out") router.replace("/login");
    if (stage === "signed_in") router.replace("/");
  }, [stage, router]);

  return (
    <>
      <span className="mb-5 grid size-12 place-content-center rounded-2xl bg-primary/10 text-primary">
        <ShieldCheck className="size-6" />
      </span>
      <AuthHeading title="Set up two-step login" description="It is required for your level or finance duty. Scan the code with Google or Microsoft Authenticator." />
      <TwoFactorSetupPanel
        onVerified={(next) => {
          const s = empId ? applyServerStage(empId, next ?? "ok") : "signed_out";
          router.push(s === "needs_first_login" ? "/first-login" : "/");
        }}
        onFatal={() => {
          signOut();
          router.replace("/login");
        }}
      />
    </>
  );
}
