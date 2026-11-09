"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CircleCheck, LockOpen, ShieldAlert, ShieldCheck } from "lucide-react";
import { Badge, type BadgeTone } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { SegmentedControl } from "@/components/ui/controls";
import { useReason, useStepUp } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { CardsSkeleton, EmptyState, ErrorState } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { descendantsOf } from "@/lib/auth/scope";
import { useViewer } from "@/lib/auth/viewer";
import { formatDateTime, formatRelative } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useAccountLocks, useCheckAlert, useSecurityAlerts, useUnlockAccount } from "../hooks";
import { alertCheckerLabel, canActOn, canCheckAlert } from "../logic";
import type { AlertSeverity, SecurityAlert } from "../types";

const SEVERITY: Record<AlertSeverity, { label: string; tone: BadgeTone; bar: string }> = {
  high: { label: "High", tone: "danger", bar: "var(--danger)" },
  medium: { label: "Medium", tone: "warning", bar: "var(--warning)" },
  low: { label: "Low", tone: "info", bar: "var(--info)" },
};

/** Security alerts with "mark as checked" (plan §8 alerts). */
export function AlertsPanel() {
  const [filter, setFilter] = React.useState<"open" | "checked" | "all">("open");
  const query = useSecurityAlerts(filter);
  const open = useSecurityAlerts("open").data?.length ?? 0;

  return (
    <div className="grid gap-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          value={filter}
          onChange={setFilter}
          ariaLabel="Alert status"
          options={[
            { value: "open", label: `Open${open ? ` · ${open}` : ""}` },
            { value: "checked", label: "Checked" },
            { value: "all", label: "All" },
          ]}
        />
        <p className="text-[12.5px] text-muted-foreground">Rules: account locked, new device or city, outside working hours, large exports, many salary records, repeated finance attempts.</p>
      </div>
      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.isPending ? (
        <CardsSkeleton count={3} className="xl:grid-cols-1 sm:grid-cols-1" />
      ) : !query.data?.length ? (
        <EmptyState icon={<ShieldCheck />} title={filter === "open" ? "No open alerts" : "Nothing here"} description={filter === "open" ? "Every alert has been checked." : undefined} />
      ) : (
        <ul className="grid gap-3">
          {query.data.map((a) => (
            <li key={a.id}>
              <AlertCard a={a} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function AlertCard({ a }: { a: SecurityAlert }) {
  const viewer = useViewer();
  const lookup = useLookup();
  const check = useCheckAlert();
  const unlock = useUnlockAccount();
  const locks = useAccountLocks();
  const askReason = useReason();
  const stepUp = useStepUp();
  const sev = SEVERITY[a.severity];
  const stillLocked = a.kind === "account_locked" && locks.data?.some((l) => l.empId === a.empId);
  const me = viewer?.employee;
  const below = me ? descendantsOf(me.empId, lookup.employees) : [];
  // Maker-checker: never your own alert; otherwise someone above the person checks it, and unlocks only go downward.
  const canCheck = !!me && canCheckAlert(me, a.empId, below, lookup.employees);
  const canUnlock = !!me && !!viewer?.can("auth.unlock_account") && canActOn(me.empId, a.empId, below);

  return (
    <Card className={cn("relative overflow-hidden p-4 pl-5 sm:p-5 sm:pl-6", a.status === "checked" && "opacity-80")}>
      <span className="absolute inset-y-0 left-0 w-1" style={{ background: sev.bar }} aria-hidden />
      <div className="flex flex-wrap items-start gap-4">
        <span className="grid size-9 shrink-0 place-content-center rounded-xl" style={{ color: sev.bar, background: `color-mix(in oklch, ${sev.bar} 12%, transparent)` }}>
          <ShieldAlert className="size-4.5" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <p className="font-semibold">{a.rule}</p>
            <Badge tone={sev.tone}>{sev.label}</Badge>
            {a.status === "checked" ? <Badge tone="success"><CircleCheck /> Checked</Badge> : <Badge tone="outline">Open</Badge>}
          </div>
          <p className="mt-1 text-[13px]">{a.details}</p>
          <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-[12.5px] text-muted-foreground">
            <EmpChip empId={a.empId} size="sm" />
            <span title={formatDateTime(a.at)}>{formatRelative(a.at)}</span>
            <Link href={`/activity?tab=timeline&emp=${a.empId}`} className="text-primary hover:underline">Open timeline</Link>
          </div>
          {a.status === "checked" && (
            <p className="mt-2 rounded-lg bg-muted px-3 py-2 text-[12.5px]">
              Checked by {lookup.employee(a.checkedBy)?.name ?? a.checkedBy} {a.checkedAt ? formatRelative(a.checkedAt) : ""}
              {a.note && <> · “{a.note}”</>}
            </p>
          )}
        </div>
        <div className="flex flex-wrap gap-2">
          {stillLocked && canUnlock && (
            <Button
              size="sm"
              variant="outline"
              loading={unlock.isPending}
              onClick={async () => {
                if (!(await stepUp({ action: `Unlock the account of ${lookup.employee(a.empId)?.name}` }))) return;
                await unlock.mutateAsync(a.empId);
                toast.success("Account unlocked", { description: "They can sign in again. The unlock is logged." });
              }}
            >
              <LockOpen /> Unlock account
            </Button>
          )}
          {a.status === "open" && !canCheck && (
            <p className="max-w-56 text-[12px] text-muted-foreground">
              {a.empId === me?.empId ? "This alert is about you, so someone above you checks it." : `To be checked by ${alertCheckerLabel(a.empId, lookup.employees)}, who is above this person.`}
            </p>
          )}
          {a.status === "open" && canCheck && (
            <Button
              size="sm"
              onClick={async () => {
                const note = await askReason({ title: "Mark this alert as checked", description: "Write what you found. The note stays with the alert.", confirmLabel: "Mark as checked", placeholder: "For example: confirmed with the employee, new phone" });
                if (!note) return;
                await check.mutateAsync({ id: a.id, note });
                toast.success("Alert marked as checked");
              }}
            >
              <CircleCheck /> Mark as checked
            </Button>
          )}
        </div>
      </div>
    </Card>
  );
}
