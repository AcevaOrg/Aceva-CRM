"use client";
import { Check, Clock, Info, Minus, X } from "lucide-react";
import { useLookup } from "@/hooks/use-directory";
import { Avatar } from "@/components/ui/misc";
import { formatDateTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { ApprovalStep, Employee } from "@/types";

const STATE = {
  done: { icon: Check, ring: "bg-success text-white", text: "Done" },
  waiting: { icon: Clock, ring: "bg-warning text-foreground animate-pulse-signal", text: "Waiting" },
  pending: { icon: Clock, ring: "bg-muted text-muted-foreground", text: "Not yet" },
  skipped: { icon: Minus, ring: "bg-muted text-muted-foreground", text: "Skipped" },
  rejected: { icon: X, ring: "bg-danger text-white", text: "Rejected" },
} as const;

/**
 * Maker-checker chain (spec §3.5.6): Prepared by → Reviewed by → Approved by.
 */
export function ApprovalRelay({ steps, className }: { steps: ApprovalStep[]; className?: string }) {
  const lookup = useLookup();
  return (
    <ol className={cn("flex flex-wrap items-stretch gap-y-3", className)}>
      {steps.map((s, i) => {
        const st = STATE[s.state];
        const Icon = st.icon;
        const e = lookup.employee(s.empId);
        return (
          <li key={i} className="flex items-center">
            <div className="flex min-w-40 items-start gap-2.5 rounded-xl border border-border bg-card px-3 py-2.5">
              <span className={cn("mt-0.5 grid size-5 shrink-0 place-content-center rounded-full", st.ring)}>
                <Icon className="size-3" strokeWidth={3} />
              </span>
              <div className="min-w-0">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{s.label}</p>
                {e ? (
                  <p className="mt-0.5 flex items-center gap-1.5 text-[13px] font-medium">
                    <Avatar name={e.name} hue={e.avatarHue} size={18} />
                    <span className="truncate">{e.name}</span>
                  </p>
                ) : (
                  <p className="mt-0.5 text-[13px] text-muted-foreground">{s.empId ?? "To be assigned"}</p>
                )}
                <p className="text-[11.5px] text-muted-foreground">{s.at ? formatDateTime(s.at) : st.text}</p>
                {s.note && <p className="mt-1 max-w-56 text-[12px] text-muted-foreground">“{s.note}”</p>}
              </div>
            </div>
            {i < steps.length - 1 && <span className="mx-1.5 h-px w-5 bg-border" aria-hidden />}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * Maker-checker rule: the maker can never approve; the item goes one level up (plan §5, §16).
 */
export function canApprove(makerEmpId: string | undefined, viewer: Employee, chainAbove: Employee[]) {
  if (makerEmpId && makerEmpId === viewer.empId) {
    const routedTo = chainAbove[0];
    return {
      ok: false as const,
      reason: `You prepared this, so you can't approve it.${routedTo ? ` It goes to ${routedTo.name} (${routedTo.designation}).` : ""}`,
      routedTo,
    };
  }
  return { ok: true as const };
}

export function MakerCheckerNote({ reason }: { reason: string }) {
  return (
    <p className="flex items-start gap-2 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-[12.5px]">
      <Info className="mt-0.5 size-4 shrink-0 text-info" />
      {reason}
    </p>
  );
}
