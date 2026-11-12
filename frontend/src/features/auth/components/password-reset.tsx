"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { ArrowLeft, MailCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { isLive } from "@/lib/api/http";
import { normalizeEmpId } from "@/lib/format";
import { authApi } from "../api";
import { AuthHeading } from "./auth-frame";
import { PasswordFields } from "./password-fields";

export function ForgotPasswordForm() {
  const [empId, setEmpId] = React.useState("");
  const [sent, setSent] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  if (sent)
    return (
      <>
        <span className="mb-5 grid size-12 place-content-center rounded-2xl bg-success/12 text-success">
          <MailCheck className="size-6" />
        </span>
        <AuthHeading
          title="Check your email"
          description="If this Emp-ID has an official @acevatech.com email, we sent a reset link. It works once and expires in 15 minutes."
        />
        <p className="rounded-lg bg-muted p-3 text-[13px] text-muted-foreground">No official email? Ask the Director (HR duty) for a temporary password. You&apos;ll set a new one when you sign in.</p>
        {!isLive("m2") && (
          <Button asChild variant="outline" className="mt-6">
            <Link href="/reset-password">Open the reset link (demo)</Link>
          </Button>
        )}
        <Link href="/login" className="mt-4 inline-flex items-center gap-1 justify-self-center text-[13px] text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Back to sign in
        </Link>
      </>
    );
  return (
    <>
      <AuthHeading title="Reset your password" description="Enter your Emp-ID. We'll email a one-time link to your official address." />
      <form
        className="grid gap-5"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          await authApi.forgotPassword(normalizeEmpId(empId));
          setBusy(false);
          setSent(true);
        }}
      >
        <Field label="Emp-ID" htmlFor="fp-emp">
          <Input id="fp-emp" autoFocus placeholder="ACV-0007" value={empId} onChange={(e) => setEmpId(e.target.value)} className="h-11 font-mono" />
        </Field>
        <Button type="submit" size="lg" loading={busy} disabled={!normalizeEmpId(empId)}>
          Send reset link
        </Button>
        <Link href="/login" className="inline-flex items-center gap-1 justify-self-center text-[13px] text-muted-foreground hover:text-foreground">
          <ArrowLeft className="size-3.5" /> Back to sign in
        </Link>
      </form>
    </>
  );
}

export function ResetPasswordForm() {
  const router = useRouter();
  const [pw, setPw] = React.useState<string | null>(null);
  const [busy, setBusy] = React.useState(false);
  const [linkError, setLinkError] = React.useState<string | null>(null);
  const onValid = React.useCallback((v: string | null) => setPw(v), []);
  return (
    <>
      <AuthHeading title="Choose a new password" description="This link works once and expires 15 minutes after it was sent." />
      <PasswordFields empId="ACV-0000" onValid={onValid} />
      <Button
        size="lg"
        className="mt-6 w-full"
        disabled={!pw}
        loading={busy}
        onClick={async () => {
          setBusy(true);
          setLinkError(null);
          try {
            // Live: the one-time link in the email carries ?token=...
            const token = new URLSearchParams(window.location.search).get("token") ?? "";
            if (isLive("m2")) await authApi.resetPassword(token, pw!);
            else await authApi.changePassword(pw!);
            toast.success("Password changed", { description: "You were signed out on every device. Sign in with the new password." });
            router.push("/login");
          } catch (err) {
            setLinkError(err instanceof Error ? err.message : "Couldn't save the new password.");
          } finally {
            setBusy(false);
          }
        }}
      >
        Save new password
      </Button>
      {linkError && (
        <p role="alert" className="mt-3 text-[13px] text-danger">
          {linkError} <Link href="/forgot-password" className="font-medium underline">Ask for a new link</Link>
        </p>
      )}
    </>
  );
}
