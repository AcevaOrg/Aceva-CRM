"use client";
/** Small Module 9 widgets: status/source badges, approval-level chip, PKR amount with USD note. */
import { ArrowRightLeft, BookOpen, CircleDollarSign, FileText, Landmark, Receipt, Repeat, Undo2, Wallet } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { StatusBadge, statusMap } from "@/components/shared/chips";
import { LevelMark } from "@/components/shared/level-mark";
import { Money } from "@/components/shared/money";
import { cn } from "@/lib/utils";
import type { Level } from "@/types";
import { LEVEL_APPROVER_TITLE, SOURCE_LABEL } from "../logic";
import type { EntrySource, EntryStatus, JournalEntry } from "../types";

export const entryStatus = statusMap<EntryStatus>({
  draft: { label: "Draft", tone: "neutral" },
  pending_approval: { label: "Pending approval", tone: "warning" },
  posted: { label: "Posted", tone: "success" },
  reversed: { label: "Reversed", tone: "outline" },
});

export function EntryStatusBadge({ status }: { status: EntryStatus }) {
  const s = entryStatus(status);
  return <StatusBadge label={s.label} tone={s.tone} />;
}

const SOURCE_ICON: Record<EntrySource, typeof BookOpen> = {
  manual: BookOpen,
  invoice: FileText,
  bill: Receipt,
  payroll: Wallet,
  payment: CircleDollarSign,
  reversal: Undo2,
  revaluation: Repeat,
  transfer: ArrowRightLeft,
  opening: Landmark,
};

export function SourceBadge({ source }: { source: EntrySource }) {
  const Icon = SOURCE_ICON[source];
  return (
    <Badge tone="outline">
      <Icon /> {SOURCE_LABEL[source]}
    </Badge>
  );
}

export function ApprovalLevelChip({ level, className }: { level: Level; className?: string }) {
  const tone: BadgeTone = level === 1 ? "danger" : level === 2 ? "warning" : "info";
  return (
    <Badge tone={tone} className={cn("gap-1.5", className)}>
      <LevelMark level={level} /> Needs {LEVEL_APPROVER_TITLE[level]} approval
    </Badge>
  );
}

/** Entry total in its own currency, plus the PKR base for USD entries. */
export function EntryAmount({ entry, align = "right" }: { entry: Pick<JournalEntry, "total" | "baseTotal" | "currency" | "exchangeRate">; align?: "left" | "right" }) {
  return (
    <span className={cn("inline-grid leading-tight", align === "right" ? "justify-items-end" : "justify-items-start")}>
      <Money value={entry.total} exact />
      {entry.currency === "USD" && (
        <span className="text-[11px] text-muted-foreground">
          <Money value={entry.baseTotal} /> @ {Number(entry.exchangeRate).toFixed(2)}
        </span>
      )}
    </span>
  );
}

/** Statement-style amount: negatives in parentheses (spec §11). */
export function formatStatementAmount(value: string | number, decimals = 2) {
  const n = typeof value === "number" ? value : Number(value);
  const abs = Math.abs(n).toLocaleString("en-PK", { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
  if (Math.abs(n) < 0.005) return "–";
  return n < 0 ? `(${abs})` : abs;
}
