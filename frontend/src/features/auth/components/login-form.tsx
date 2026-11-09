"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { ArrowRight, CircleAlert, Eye, EyeOff, Lock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { API_MODE } from "@/lib/api/http";
import { ROLE_LABEL } from "@/lib/auth/permissions";
import { useSession } from "@/lib/auth/session";
import { requires2fa } from "@/lib/auth/viewer";
import { normalizeEmpId } from "@/lib/format";
import { cn } from "@/lib/utils";
import { EMPLOYEES } from "@/mocks/seed/people";
import { authApi } from "../api";
import { AuthHeading } from "./auth-frame";

export function LoginForm() {
  const router = useRouter();
  const beginSignIn = useSession((s) => s.beginSignIn);
  const [digits, setDigits] = React.useState("");
  const [password, setPassword] = React.useState("");
  const [show, setShow] = React.useState(false);
  const [caps, setCaps] = React.useState(false);
  const [error, setError] = React.useState<{ title: string; body?: string; locked?: boolean } | null>(null);
  const [busy, setBusy] = React.useState(false);
  const pwRef = React.useRef<HTMLInputElement>(null);

  const empId = digits ? `ACV-${digits.padStart(4, "0")}` : "";

  const submit = async (id = empId, pw = password) => {
    if (!id || !pw) {
      setError({ title: "Enter your Emp-ID and password." });
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const res = await authApi.login({ empId: id, password: pw });
      if (res.status === "invalid") setError({ title: "Emp-ID or password is wrong.", body: `${res.attemptsLeft} ${res.attemptsLeft === 1 ? "try" : "tries"} left before the account locks.` });
      else if (res.status === "locked") setError({ title: "Account locked after 5 wrong passwords.", body: "Ask HR or your manager to unlock it.", locked: true });
      else if (res.status === "rate_limited") setError({ title: "Too many attempts from this network.", body: `Try again in ${Math.ceil((res.retryAfterSec ?? 600) / 60)} minutes.` });
      else {
        const emp = EMPLOYEES.find((e) => e.empId === id)!;
        const stage = beginSignIn(id, { needs2fa: requires2fa(emp) });
        router.push(stage === "needs_2fa" ? "/login/verify" : stage === "needs_first_login" ? "/first-login" : "/");
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <AuthHeading title="Sign in" description="Use your Emp-ID and password." />
      <form
        className="grid gap-5"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <Field label="Emp-ID" htmlFor="empId" hint="Printed on your welcome email, for example ACV-0007.">
          <div className="flex h-11 items-stretch overflow-hidden rounded-lg border border-input bg-card shadow-[0_1px_1px_oklch(0.2_0.03_265/0.04)] focus-within:border-ring focus-within:outline-2 focus-within:outline-ring/30">
            <span className="grid place-content-center border-r border-border bg-muted px-3 font-mono text-[14px] font-semibold text-muted-foreground">ACV-</span>
            <input
              id="empId"
              autoFocus
              inputMode="numeric"
              autoComplete="username"
              placeholder="0007"
              value={digits}
              aria-invalid={!!error || undefined}
              onPaste={(e) => {
                const v = normalizeEmpId(e.clipboardData.getData("text"));
                if (v) {
                  e.preventDefault();
                  setDigits(v.slice(4));
                  pwRef.current?.focus();
                }
              }}
              onChange={(e) => setDigits(e.target.value.replace(/\D/g, "").slice(0, 4))}
              className="min-w-0 flex-1 bg-transparent px-3 font-mono text-[15px] tracking-wider outline-none placeholder:text-muted-foreground/50"
            />
          </div>
        </Field>
        <Field label="Password" htmlFor="password">
          <div className="relative">
            <Input
              ref={pwRef}
              id="password"
              type={show ? "text" : "password"}
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyUp={(e) => setCaps(e.getModifierState("CapsLock"))}
              className="h-11 pr-10"
              aria-invalid={!!error || undefined}
            />
            <button type="button" onClick={() => setShow((s) => !s)} className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1.5 text-muted-foreground hover:text-foreground" aria-label={show ? "Hide password" : "Show password"}>
              {show ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          {caps && <p className="text-xs font-medium text-[oklch(0.55_0.13_70)]">Caps Lock is on.</p>}
        </Field>

        {error && (
          <div role="alert" className={cn("flex gap-2.5 rounded-lg border px-3 py-2.5 text-[13px]", error.locked ? "border-danger/35 bg-danger/10" : "border-warning/40 bg-warning/12")}>
            {error.locked ? <Lock className="mt-0.5 size-4 shrink-0 text-danger" /> : <CircleAlert className="mt-0.5 size-4 shrink-0 text-[oklch(0.6_0.14_70)]" />}
            <div>
              <p className="font-medium">{error.title}</p>
              {error.body && <p className="text-muted-foreground">{error.body}</p>}
            </div>
          </div>
        )}

        <Button type="submit" size="lg" loading={busy} className="w-full">
          Sign in <ArrowRight />
        </Button>
        <Link href="/forgot-password" className="justify-self-center text-[13px] font-medium text-primary hover:underline">
          Forgot your password?
        </Link>
      </form>

      {API_MODE === "mock" && <DemoAccounts onPick={(id) => submit(id, "demo-password")} busy={busy} />}
    </>
  );
}

function DemoAccounts({ onPick, busy }: { onPick: (empId: string) => void; busy: boolean }) {
  return (
    <section className="mt-10 rounded-xl border border-dashed border-border p-4" aria-label="Demo accounts">
      <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Demo accounts · mock mode</p>
      <p className="mt-1 text-[12.5px] text-muted-foreground">One click signs in. Levels 1–3 and finance duty also see the 2FA step (any 6 digits).</p>
      <div className="mt-3 grid max-h-64 gap-1 overflow-y-auto pr-1 scrollbar-thin">
        {EMPLOYEES.map((e) => (
          <button
            key={e.empId}
            disabled={busy}
            onClick={() => onPick(e.empId)}
            className="flex items-center gap-2.5 rounded-lg px-2 py-1.5 text-left transition hover:bg-muted disabled:opacity-50"
          >
            <Avatar name={e.name} hue={e.avatarHue} size={26} />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-[13px] font-medium">{e.name}</span>
              <span className="block truncate text-[11.5px] text-muted-foreground">
                L{e.level} · {ROLE_LABEL[e.role]}
                {e.duties.includes("finance") ? " · Finance duty" : ""}
                {e.duties.includes("hr") ? " · HR duty" : ""}
              </span>
            </span>
            <span className="font-mono text-[11.5px] text-muted-foreground">{e.empId}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
