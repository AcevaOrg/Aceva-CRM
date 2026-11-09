"use client";
import { Card } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { ErrorState } from "@/components/shared/states";
import { cn } from "@/lib/utils";
import { useLeaveBalances } from "../hooks";
import type { LeaveBalanceView } from "../types";

export function BalanceBar({ b }: { b: LeaveBalanceView }) {
  if (!b.total) return <div className="h-2 rounded-full bg-muted" />;
  const used = Math.min(100, (b.used / b.total) * 100);
  const pending = Math.min(100 - used, (b.pending / b.total) * 100);
  return (
    <div className="flex h-2 overflow-hidden rounded-full bg-muted" role="img" aria-label={`${b.used} used, ${b.pending} pending, of ${b.total}`}>
      <div style={{ width: `${used}%`, background: b.leaveType.color }} />
      <div
        style={{
          width: `${pending}%`,
          background: b.leaveType.color,
          opacity: 0.45,
          backgroundImage: "repeating-linear-gradient(45deg, transparent 0 3px, oklch(1 0 0 / 0.5) 3px 6px)",
        }}
      />
    </div>
  );
}

export function LeaveBalanceCard({ b, className }: { b: LeaveBalanceView; className?: string }) {
  return (
    <Card className={cn("grid gap-3 p-4", className)}>
      <div className="flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-[13px] font-medium">
          <span className="size-2.5 rounded-full" style={{ background: b.leaveType.color }} aria-hidden />
          {b.leaveType.name}
        </p>
        {!b.leaveType.paid && <span className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">Unpaid</span>}
      </div>
      {b.remaining === null ? (
        <p className="text-[24px] font-semibold leading-none tabular">
          {b.used}
          <span className="ml-1.5 text-[13px] font-normal text-muted-foreground">used this year</span>
        </p>
      ) : (
        <p className="text-[24px] font-semibold leading-none tabular">
          {b.remaining}
          <span className="ml-1.5 text-[13px] font-normal text-muted-foreground">of {b.total} left</span>
        </p>
      )}
      <BalanceBar b={b} />
      <p className="text-[11.5px] text-muted-foreground">
        {b.remaining === null ? "No yearly limit; deducted in payroll." : `${b.used} used${b.pending ? ` · ${b.pending} waiting for approval` : ""}`}
      </p>
    </Card>
  );
}

export function LeaveBalanceCards({ empId }: { empId?: string }) {
  const q = useLeaveBalances(empId);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {q.isPending ? Array.from({ length: 4 }, (_, i) => <Skeleton key={i} className="h-[128px] rounded-xl" />) : q.data.map((b) => <LeaveBalanceCard key={b.leaveTypeId} b={b} />)}
    </div>
  );
}
