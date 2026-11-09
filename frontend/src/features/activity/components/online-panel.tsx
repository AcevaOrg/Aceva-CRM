"use client";
import Link from "next/link";
import { toast } from "sonner";
import { Activity, Lock, LogOut, MoreHorizontal, Moon, Smartphone, Users, Wifi } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { useReason, useStepUp } from "@/components/shared/dialogs";
import { DataTable } from "@/components/shared/data-table";
import { EmpChip } from "@/components/shared/emp-chip";
import { StatCard } from "@/components/shared/metrics";
import { EmptyState } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { descendantsOf } from "@/lib/auth/scope";
import { useViewer } from "@/lib/auth/viewer";
import { formatRelative, formatTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useForceLogout, useLockAccount, useOnlineNow } from "../hooks";
import { canActOn } from "../logic";
import type { OnlineSession } from "../types";

/** "Who is online now" (plan §8 admin screens). */
export function OnlinePanel() {
  const viewer = useViewer();
  const query = useOnlineNow();
  const lookup = useLookup();
  const stepUp = useStepUp();
  const askReason = useReason();
  const force = useForceLogout();
  const lock = useLockAccount();
  const rows = query.data ?? [];
  const active = rows.filter((r) => r.state === "active").length;
  const below = viewer ? descendantsOf(viewer.employee.empId, lookup.employees) : [];

  const forceLogout = async (s: OnlineSession) => {
    const name = lookup.employee(s.empId)?.name ?? s.empId;
    const reason = await askReason({ title: `Sign ${name} out now?`, description: "The session ends at once on that device. The reason is saved and the employee sees it in their login history.", confirmLabel: "Continue", destructive: true });
    if (!reason) return;
    if (!(await stepUp({ action: `Force sign-out of ${name}`, detail: `${s.device} · ${s.city}` }))) return;
    await force.mutateAsync({ sessionId: s.sessionId, reason });
    toast.success(`${name} was signed out`);
  };

  const lockAccount = async (s: OnlineSession) => {
    const name = lookup.employee(s.empId)?.name ?? s.empId;
    const reason = await askReason({ title: `Lock ${name}'s account?`, description: "They're signed out everywhere and can't sign in until someone with permission unlocks the account.", confirmLabel: "Continue", destructive: true });
    if (!reason) return;
    if (!(await stepUp({ action: `Lock the account of ${name}` }))) return;
    await lock.mutateAsync({ empId: s.empId, reason });
    toast.success(`${name}'s account is locked`);
  };

  return (
    <div className="grid gap-5">
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Signed in now" value={rows.length} icon={<Wifi />} accent="var(--zone-control)" hint="in your reporting line" />
        <StatCard label="Active" value={active} icon={<Activity />} accent="var(--signal)" hint="used mouse or keyboard in the last 5 min" />
        <StatCard label="Idle" value={rows.length - active} icon={<Moon />} accent="var(--warning)" hint="no input for 5 min or more" />
        <StatCard label="New devices today" value={rows.filter((r) => r.newDevice).length} icon={<Smartphone />} accent="var(--danger)" hint="also raised as alerts" />
      </div>
      {viewer && !viewer.can(["session.force_logout", "auth.unlock_account"]) && (
        <p className="text-[12.5px] text-muted-foreground">View only. The Director and the CTO sign people out or lock accounts, for people below them.</p>
      )}
      <DataTable<OnlineSession>
        rows={rows}
        loading={query.isPending}
        rowKey={(s) => s.sessionId}
        searchable
        searchText={(s) => `${lookup.employee(s.empId)?.name ?? ""} ${s.empId} ${s.currentScreen} ${s.city}`}
        searchPlaceholder="Find a person or screen"
        initialSort={{ key: "since", dir: "asc" }}
        empty={<EmptyState icon={<Users />} title="Nobody else is signed in" description="People in your reporting line appear here while the app is open." />}
        columns={[
          { key: "person", header: "Person", cell: (s) => <EmpChip empId={s.empId} />, sortValue: (s) => lookup.employee(s.empId)?.name ?? s.empId },
          {
            key: "since",
            header: "Signed in since",
            cell: (s) => (
              <span className="tabular">
                {formatTime(s.since)} <span className="text-muted-foreground">· {formatRelative(s.since).replace(" ago", "")}</span>
              </span>
            ),
            sortValue: (s) => s.since,
          },
          { key: "screen", header: "Current screen", cell: (s) => s.currentScreen, sortValue: (s) => s.currentScreen },
          {
            key: "state",
            header: "State",
            cell: (s) => (
              <span className="inline-flex items-center gap-1.5 text-[12.5px] font-medium">
                <span className={cn("size-2 rounded-full", s.state === "active" ? "bg-signal animate-pulse-signal" : "bg-warning")} />
                {s.state === "active" ? "Active" : "Idle"}
              </span>
            ),
            sortValue: (s) => s.state,
          },
          {
            key: "device",
            header: "Device",
            cell: (s) => (
              <span className="inline-flex flex-wrap items-center gap-1.5 text-[12.5px]">
                {s.device} · {s.city}
                {s.newDevice && <Badge tone="danger">New device</Badge>}
              </span>
            ),
            hideOnMobile: true,
          },
          {
            key: "actions",
            header: "",
            align: "right",
            cell: (s) => (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button size="icon-sm" variant="ghost" aria-label="Session actions" onClick={(e) => e.stopPropagation()}>
                    <MoreHorizontal />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuItem asChild>
                    <Link href={`/activity?tab=timeline&emp=${s.empId}`}>
                      <Activity /> View today&apos;s timeline
                    </Link>
                  </DropdownMenuItem>
                  {viewer?.can("session.force_logout") && canActOn(viewer.employee.empId, s.empId, below) && (
                    <DropdownMenuItem destructive onSelect={() => forceLogout(s)}>
                      <LogOut /> Force sign-out
                    </DropdownMenuItem>
                  )}
                  {viewer?.can("auth.unlock_account") && canActOn(viewer.employee.empId, s.empId, below) && (
                    <DropdownMenuItem destructive onSelect={() => lockAccount(s)}>
                      <Lock /> Lock account
                    </DropdownMenuItem>
                  )}
                </DropdownMenuContent>
              </DropdownMenu>
            ),
          },
        ]}
      />
    </div>
  );
}
