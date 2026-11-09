import { Check } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { STAGES, stageIndex, stageLabel } from "../logic";
import type { PayrollStage } from "../types";

/** The seven payroll stages as a stepper (spec §9.8). Prepared (Finance) → Approved (Director), no separate review. */
export function StagePipeline({ stage, compact, className }: { stage: PayrollStage; compact?: boolean; className?: string }) {
  const current = stageIndex(stage);
  if (compact) {
    return (
      <div className={cn("grid gap-1.5", className)} aria-label={`Stage: ${stageLabel(stage)}`}>
        <div className="flex gap-1" aria-hidden>
          {STAGES.map((s, i) => (
            <span
              key={s.key}
              className={cn(
                "h-1.5 flex-1 rounded-full",
                i < current || stage === "paid" ? "bg-success" : i === current ? "bg-primary" : "bg-muted",
              )}
            />
          ))}
        </div>
        <p className="text-[11.5px] text-muted-foreground">
          Step {current + 1} of {STAGES.length} · <span className="font-medium text-foreground">{stageLabel(stage)}</span>
        </p>
      </div>
    );
  }
  return (
    <ol className={cn("flex items-start overflow-x-auto pb-1 scrollbar-thin", className)} aria-label="Payroll stages">
      {STAGES.map((s, i) => {
        const done = i < current || stage === "paid";
        const active = i === current && stage !== "paid";
        return (
          <li key={s.key} className="flex min-w-[92px] flex-1 flex-col items-center gap-1.5 text-center" aria-current={active ? "step" : undefined}>
            <div className="flex w-full items-center">
              <span className={cn("h-px flex-1", i === 0 ? "bg-transparent" : done || active ? "bg-success" : "bg-border")} />
              <span
                className={cn(
                  "grid size-7 shrink-0 place-content-center rounded-full border text-[11px] font-bold",
                  done && "border-success bg-success text-white",
                  active && "border-primary bg-primary text-primary-foreground ring-4 ring-primary/15",
                  !done && !active && "border-border bg-card text-muted-foreground",
                )}
              >
                {done ? <Check className="size-3.5" strokeWidth={3} /> : i + 1}
              </span>
              <span className={cn("h-px flex-1", i === STAGES.length - 1 ? "bg-transparent" : done ? "bg-success" : "bg-border")} />
            </div>
            <span className={cn("px-1 text-[11.5px] leading-tight", active ? "font-semibold text-foreground" : "text-muted-foreground")}>{s.label}</span>
          </li>
        );
      })}
    </ol>
  );
}

const TONE: Record<PayrollStage, BadgeTone> = {
  draft: "neutral",
  calculated: "info",
  prepared: "warning",
  approved: "primary",
  payslips_sent: "primary",
  posted: "finance",
  paid: "success",
};

export function StageBadge({ stage }: { stage: PayrollStage }) {
  return (
    <Badge tone={TONE[stage]} dot>
      {stageLabel(stage)}
    </Badge>
  );
}
