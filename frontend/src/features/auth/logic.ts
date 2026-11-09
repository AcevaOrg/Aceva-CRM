import type { PasswordRuleResult } from "./types";

/** Live password checklist (plan §6). "Not reused" is checked on the server; shown as info here. */
export function checkPassword(pw: string, empId: string, previous: string[] = []): PasswordRuleResult[] {
  const digits = empId.replace(/\D/g, "");
  return [
    { key: "length", label: "At least 10 characters", ok: pw.length >= 10 },
    { key: "mixed", label: "Letters and at least one number or symbol", ok: /[a-z]/i.test(pw) && /[^a-z]/i.test(pw) },
    { key: "notEmpId", label: "Doesn't contain your Emp-ID", ok: pw.length > 0 && !(digits && pw.includes(digits)) && !pw.toUpperCase().includes(empId) },
    { key: "notReused", label: "Not one of your last 3 passwords", ok: pw.length > 0 && !previous.includes(pw) },
  ];
}

export function passwordStrength(pw: string): { score: 0 | 1 | 2 | 3 | 4; label: string } {
  let s = 0;
  if (pw.length >= 10) s++;
  if (pw.length >= 14) s++;
  if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) s++;
  if (/\d/.test(pw) && /[^a-z0-9]/i.test(pw)) s++;
  const score = Math.min(4, s) as 0 | 1 | 2 | 3 | 4;
  return { score, label: ["Too weak", "Weak", "Fair", "Good", "Strong"][score] };
}
