import { cn } from "@/lib/utils";

/** Aceva mark: three offset strata bars (placeholder until a brand guide exists, spec §14). */
export function AcevaMark({ size = 28, className }: { size?: number; className?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" className={className} aria-hidden>
      <rect x="2" y="3" width="28" height="26" rx="8" fill="var(--primary)" />
      <rect x="8" y="9" width="16" height="3.2" rx="1.6" fill="var(--signal)" />
      <rect x="10.5" y="14.4" width="13.5" height="3.2" rx="1.6" fill="oklch(1 0 0 / 0.92)" />
      <rect x="8" y="19.8" width="11" height="3.2" rx="1.6" fill="oklch(1 0 0 / 0.6)" />
    </svg>
  );
}

export function AcevaLogo({ collapsed, className, tone = "light" }: { collapsed?: boolean; className?: string; tone?: "light" | "dark" }) {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      <AcevaMark />
      {!collapsed && (
        <span className="grid leading-none">
          <span className={cn("text-[15px] font-semibold tracking-tight", tone === "light" ? "text-white" : "text-foreground")}>Aceva</span>
          <span className={cn("mt-0.5 text-[10.5px] font-medium uppercase tracking-[0.14em]", tone === "light" ? "text-sidebar-muted" : "text-muted-foreground")}>
            Digital System
          </span>
        </span>
      )}
    </span>
  );
}
