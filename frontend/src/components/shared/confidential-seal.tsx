"use client";
import { Building2, Shield, ShieldAlert, UserRound } from "lucide-react";
import { Tip } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";
import type { Confidentiality } from "@/types";

const SEALS: Record<Confidentiality, { label: string; tip: string; icon: typeof Shield; cls: string }> = {
  highly: {
    label: "Highly confidential",
    tip: "Owner, CEO and Director only (and the finance duty person for assigned work). Views and exports are logged.",
    icon: ShieldAlert,
    cls: "border-seal-highly/35 bg-seal-highly/10 [&_svg]:text-seal-highly",
  },
  confidential: {
    label: "Confidential",
    tip: "Director and above, plus people with a duty for this data. Exports are logged.",
    icon: Shield,
    cls: "border-seal-confidential/45 bg-seal-confidential/14 [&_svg]:text-seal-confidential",
  },
  internal: {
    label: "Internal",
    tip: "Visible to employees, following the hierarchy.",
    icon: Building2,
    cls: "border-seal-internal/35 bg-seal-internal/10 [&_svg]:text-seal-internal",
  },
  own: {
    label: "Your data",
    tip: "Only you and the levels above you can see this.",
    icon: UserRound,
    cls: "border-seal-own/35 bg-seal-own/10 [&_svg]:text-seal-own",
  },
};

/** Confidentiality seal (spec §3.5.2). */
export function ConfidentialSeal({ level, compact, className }: { level: Confidentiality; compact?: boolean; className?: string }) {
  const s = SEALS[level];
  const Icon = s.icon;
  return (
    <Tip content={s.tip}>
      <span
        tabIndex={0}
        className={cn(
          "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-[11.5px] font-semibold tracking-wide text-foreground outline-none [&_svg]:size-3.5",
          compact && "h-6 px-2",
          s.cls,
          className,
        )}
      >
        <Icon aria-hidden />
        {!compact && s.label}
        <span className="sr-only">{compact ? s.label : ""}</span>
      </span>
    </Tip>
  );
}
