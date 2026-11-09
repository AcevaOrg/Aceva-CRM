"use client";
/** Small task widgets: status badge, priority, size chip, size picker. */
import { ArrowDown, ArrowUp, ChevronsUp, Minus, Scissors } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { statusMap, StatusBadge } from "@/components/shared/chips";
import { cn } from "@/lib/utils";
import { PRIORITY_LABEL, SIZE_RULES, STATUS_LABEL } from "../logic";
import type { Priority, TaskSize, TaskStatus } from "../types";

const STATUS_TONE: Record<TaskStatus, BadgeTone> = {
  assigned: "neutral",
  in_progress: "info",
  submitted: "primary",
  under_review: "primary",
  approved: "success",
  rework: "warning",
  on_hold: "outline",
  cancelled: "outline",
};

export const taskStatus = statusMap(
  Object.fromEntries(Object.entries(STATUS_LABEL).map(([k, label]) => [k, { label, tone: STATUS_TONE[k as TaskStatus] }])) as Record<
    TaskStatus,
    { label: string; tone: BadgeTone }
  >,
);

export const STATUS_COLOR: Record<TaskStatus, string> = {
  assigned: "var(--muted-foreground)",
  in_progress: "var(--info)",
  submitted: "var(--primary)",
  under_review: "var(--zone-finance)",
  approved: "var(--success)",
  rework: "var(--warning)",
  on_hold: "var(--muted-foreground)",
  cancelled: "var(--muted-foreground)",
};

export function TaskStatusBadge({ status }: { status: TaskStatus }) {
  const s = taskStatus(status);
  return <StatusBadge label={s.label} tone={s.tone} />;
}

const PRIORITY_ICON = { low: ArrowDown, medium: Minus, high: ArrowUp, urgent: ChevronsUp };
const PRIORITY_CLS: Record<Priority, string> = {
  low: "text-muted-foreground",
  medium: "text-info",
  high: "text-warning",
  urgent: "text-danger",
};

export function PriorityLabel({ priority, compact }: { priority: Priority; compact?: boolean }) {
  const Icon = PRIORITY_ICON[priority];
  return (
    <span className="inline-flex items-center gap-1 text-[12.5px]" title={`${PRIORITY_LABEL[priority]} priority`}>
      <Icon className={cn("size-3.5", PRIORITY_CLS[priority])} strokeWidth={2.5} />
      {!compact && PRIORITY_LABEL[priority]}
    </span>
  );
}

export function SizeChip({ size }: { size: TaskSize }) {
  const r = SIZE_RULES.find((x) => x.size === size)!;
  return (
    <Badge tone="work" className="font-mono" title={`${r.meaning} · ${r.hoursLabel} · ${r.points} pts`}>
      {size}
      {r.points > 0 && <span className="text-muted-foreground">·{r.points}</span>}
    </Badge>
  );
}

/** XS…XL picker showing hours and points; XL warns that it must be split (spec §3.5.10). */
export function SizePicker({ value, onChange }: { value: TaskSize; onChange: (s: TaskSize) => void }) {
  return (
    <div role="radiogroup" aria-label="Task size" className="grid grid-cols-5 gap-1.5">
      {SIZE_RULES.map((r) => {
        const active = r.size === value;
        const xl = r.size === "XL";
        return (
          <button
            key={r.size}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(r.size)}
            className={cn(
              "grid gap-0.5 rounded-lg border px-1 py-2 text-center transition",
              active ? (xl ? "border-warning bg-warning/12" : "border-zone-work bg-zone-work/12 ring-1 ring-zone-work/40") : "border-border bg-card hover:bg-muted",
            )}
          >
            <span className="flex items-center justify-center gap-1 font-mono text-[15px] font-semibold">
              {xl && <Scissors className="size-3.5" />}
              {r.size}
            </span>
            <span className="text-[10.5px] leading-tight text-muted-foreground">{r.hoursLabel}</span>
            <span className="text-[10.5px] font-medium">{xl ? "Split first" : `${r.points} pt${r.points > 1 ? "s" : ""}`}</span>
          </button>
        );
      })}
    </div>
  );
}
