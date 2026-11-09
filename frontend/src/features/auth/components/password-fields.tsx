"use client";
import * as React from "react";
import { Check, Circle } from "lucide-react";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { checkPassword, passwordStrength } from "../logic";

/** New password + confirm with a live rule checklist and strength meter (plan §6). */
export function PasswordFields({ empId, onValid }: { empId: string; onValid: (pw: string | null) => void }) {
  const [pw, setPw] = React.useState("");
  const [confirm, setConfirm] = React.useState("");
  const rules = checkPassword(pw, empId);
  const strength = passwordStrength(pw);
  const allOk = rules.every((r) => r.ok) && pw === confirm;

  React.useEffect(() => onValid(allOk ? pw : null), [allOk, pw, onValid]);

  return (
    <div className="grid gap-4">
      <Field label="New password" htmlFor="new-pw">
        <Input id="new-pw" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} className="h-11" autoFocus />
        <div className="mt-1 flex items-center gap-2">
          <div className="flex flex-1 gap-1" aria-hidden>
            {[1, 2, 3, 4].map((i) => (
              <span
                key={i}
                className={cn(
                  "h-1 flex-1 rounded-full bg-muted transition-colors",
                  pw && i <= strength.score && (strength.score <= 1 ? "bg-danger" : strength.score === 2 ? "bg-warning" : "bg-success"),
                )}
              />
            ))}
          </div>
          <span className="w-16 text-right text-[11.5px] text-muted-foreground">{pw ? strength.label : ""}</span>
        </div>
      </Field>
      <ul className="grid gap-1.5 text-[12.5px]" aria-label="Password rules">
        {rules.map((r) => (
          <li key={r.key} className={cn("flex items-center gap-2", r.ok ? "text-foreground" : "text-muted-foreground")}>
            {r.ok ? <Check className="size-3.5 text-success" strokeWidth={3} /> : <Circle className="size-3.5" />}
            {r.label}
          </li>
        ))}
      </ul>
      <Field label="Confirm new password" htmlFor="confirm-pw" error={confirm && confirm !== pw ? "The passwords don't match." : undefined}>
        <Input id="confirm-pw" type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className="h-11" aria-invalid={!!confirm && confirm !== pw} />
      </Field>
    </div>
  );
}
