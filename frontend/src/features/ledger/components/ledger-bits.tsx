"use client";
/** Small Module 9 widgets: status/source badges, approval chip, view-only note, PKR amount with USD note. */
import type * as React from "react";
import { ArrowRightLeft, Ban, BookOpen, CircleDollarSign, Eye, FileText, Landmark, Receipt, Repeat, Undo2, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { StatusBadge, statusMap } from "@/components/shared/chips";
import { LevelMark } from "@/components/shared/level-mark";
import { Money } from "@/components/shared/money";
import { useCan } from "@/lib/auth/viewer";
import { cn } from "@/lib/utils";
import { CEO_NOTIFIED_LABEL, SOURCE_LABEL } from "../logic";
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

/**
 * Approval chip: every entry needs the Director, any amount. Entries above PKR 500,000 and every
 * capital or loan entry also show that the CEO / Founder / Owner is notified (view only).
 */
export function ApprovalChip({ ceoNotified, blocked, className }: { ceoNotified?: boolean; blocked?: boolean; className?: string }) {
  if (blocked)
    return (
      <Badge tone="danger" className={cn("gap-1.5", className)}>
        <Ban /> Blocked: the Director made it
      </Badge>
    );
  return (
    <span className={cn("inline-flex flex-wrap items-center gap-1.5", className)}>
      <Badge tone="info" className="gap-1.5">
        <LevelMark level={2} /> Needs Director approval
      </Badge>
      {ceoNotified && (
        <Badge tone="warning" className="gap-1.5">
          <Eye /> {CEO_NOTIFIED_LABEL}
        </Badge>
      )}
    </span>
  );
}

/** Short "you can look but not act" note (CEO / Founder / Owner and other view-only readers). */
export function ViewOnlyNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <p className={cn("flex items-start gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-[12.5px] text-muted-foreground", className)}>
      <Eye className="mt-0.5 size-4 shrink-0" />
      <span>{children}</span>
    </p>
  );
}

/**
 * Who does the work on a finance screen, for people who can't prepare it (permission-driven):
 * the Director approves; the CEO / Founder / Owner and anyone else with finance.view only looks.
 */
export function FinanceRoleNote({ prepares, className }: { prepares: string; className?: string }) {
  const canPrepare = useCan("finance.entry_create");
  const canApprove = useCan("finance.entry_approve");
  if (canPrepare) return null;
  return (
    <ViewOnlyNote className={className}>
      {canApprove ? `The finance person ${prepares}. You approve the entries, any amount.` : `View only. The finance person ${prepares}; the Director approves.`}
    </ViewOnlyNote>
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
