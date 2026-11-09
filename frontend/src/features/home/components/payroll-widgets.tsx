"use client";
/** Home widgets from Payroll (M8) and system backups (M12). */
import Link from "next/link";
import { DatabaseBackup, Wallet } from "lucide-react";
import { Money } from "@/components/shared/money";
import { StatusBadge } from "@/components/shared/chips";
import { usePayrollRuns } from "@/features/payroll/hooks";
import { STAGES } from "@/features/payroll/logic";
import { useBackupStatus } from "@/features/system/hooks";
import { formatDateTime, formatMonthKey, formatRelative } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { Widget, WidgetEmpty, WidgetSkeleton } from "./widget";

export function PayrollStageWidget() {
  const q = usePayrollRuns();
  const run = q.data?.[0];
  const idx = run ? STAGES.findIndex((s) => s.key === run.stage) : -1;
  return (
    <Widget title="Payroll" icon={<Wallet />} href={run ? `/payroll/runs/${run.id}` : "/payroll"} linkLabel="Open run" seal="highly">
      {q.isPending ? (
        <WidgetSkeleton rows={2} />
      ) : !run ? (
        <WidgetEmpty>No payroll runs yet.</WidgetEmpty>
      ) : (
        <div className="grid gap-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <p className="text-[12.5px] text-muted-foreground">{formatMonthKey(run.month)} · {run.headcount} people</p>
              <p className="text-[22px] font-semibold tracking-tight">
                <Money value={run.totals.net} compact />
                <span className="ml-1.5 text-[12.5px] font-normal text-muted-foreground">net</span>
              </p>
            </div>
            <StatusBadge label={STAGES[idx]?.label ?? run.stage} tone={run.stage === "paid" ? "success" : "warning"} />
          </div>
          <ol className="flex gap-1" aria-label="Payroll stages">
            {STAGES.map((s, i) => (
              <li key={s.key} title={s.label} className={cn("h-1.5 flex-1 rounded-full", i <= idx ? "bg-zone-finance" : "bg-muted")} />
            ))}
          </ol>
          <p className="text-[12px] text-muted-foreground">
            {!STAGES[idx + 1]
              ? "Done for this month"
              : STAGES[idx + 1].key === "approved"
                ? "Next step: the Director approves it"
                : `Next step: ${STAGES[idx + 1].label.toLowerCase()}`}
          </p>
        </div>
      )}
    </Widget>
  );
}

export function BackupWidget() {
  const q = useBackupStatus();
  const b = q.data;
  return (
    <Widget title="Backups" icon={<DatabaseBackup />} href="/settings?section=backups" linkLabel="Details">
      {q.isPending ? (
        <WidgetSkeleton rows={2} />
      ) : !b ? (
        <WidgetEmpty>Backup status isn&apos;t available to you.</WidgetEmpty>
      ) : (
        <div className="grid gap-2 text-[13px]">
          <p className="flex items-center justify-between">
            <span>Last nightly backup</span>
            <StatusBadge label={b.ok ? `OK · ${formatRelative(b.lastBackupAt)}` : "Failed"} tone={b.ok ? "success" : "danger"} />
          </p>
          <p className="flex items-center justify-between text-muted-foreground">
            <span>Copies kept</span>
            <span className="tabular">{b.dailyCopies} daily · {b.monthlyCopies} monthly</span>
          </p>
          <p className="flex items-center justify-between text-muted-foreground">
            <span>Last restore test</span>
            <span className={cn("tabular", !b.lastRestoreTest.ok && "text-danger")}>
              {b.lastRestoreTest.ok ? "Passed" : "Failed"} · {formatDateTime(b.lastRestoreTest.at).split(",")[0]}
            </span>
          </p>
          <Link href="/settings?section=backups" className="sr-only">
            Backups
          </Link>
        </div>
      )}
    </Widget>
  );
}
