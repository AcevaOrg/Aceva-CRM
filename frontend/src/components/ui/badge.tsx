import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";
import { cn } from "@/lib/utils";

/** Tinted badge. Tints at ~12% with a 25% border; text stays ink (spec §3.2). */
export const badgeVariants = cva(
  "inline-flex items-center gap-1 whitespace-nowrap rounded-full border px-2 py-0.5 text-[11.5px] font-medium leading-4 [&_svg]:size-3 [&_svg]:shrink-0",
  {
    variants: {
      tone: {
        neutral: "border-border bg-muted text-foreground",
        primary: "border-primary/25 bg-primary/10 text-foreground",
        success: "border-success/30 bg-success/12 text-foreground",
        warning: "border-warning/35 bg-warning/15 text-foreground",
        danger: "border-danger/30 bg-danger/12 text-foreground",
        info: "border-info/30 bg-info/12 text-foreground",
        signal: "border-signal/60 bg-signal/40 text-signal-foreground",
        work: "border-zone-work/30 bg-zone-work/12 text-foreground",
        finance: "border-zone-finance/30 bg-zone-finance/12 text-foreground",
        sales: "border-zone-sales/35 bg-zone-sales/14 text-foreground",
        control: "border-zone-control/30 bg-zone-control/12 text-foreground",
        outline: "border-border bg-transparent text-muted-foreground",
      },
    },
    defaultVariants: { tone: "neutral" },
  },
);

export type BadgeTone = NonNullable<VariantProps<typeof badgeVariants>["tone"]>;

export interface BadgeProps extends React.ComponentProps<"span">, VariantProps<typeof badgeVariants> {
  dot?: boolean;
}

const DOT: Record<BadgeTone, string> = {
  success: "bg-success", warning: "bg-warning", danger: "bg-danger", info: "bg-info", primary: "bg-primary",
  neutral: "bg-muted-foreground", signal: "bg-signal-foreground", work: "bg-zone-work", finance: "bg-zone-finance",
  sales: "bg-zone-sales", control: "bg-zone-control", outline: "bg-muted-foreground",
};

export function Badge({ className, tone, dot, children, ...props }: BadgeProps) {
  return (
    <span className={cn(badgeVariants({ tone }), className)} {...props}>
      {dot && <span className={cn("size-1.5 rounded-full", DOT[tone ?? "neutral"])} aria-hidden />}
      {children}
    </span>
  );
}
