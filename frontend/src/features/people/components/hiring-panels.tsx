"use client";
import * as React from "react";
import Link from "next/link";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Check, UserCheck, UserX, X } from "lucide-react";
import type { HireRequestView, UnresolvedReport } from "@aceva/contracts";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { useReason } from "@/components/shared/dialogs";
import { http, isLive } from "@/lib/api/http";
import { useCan } from "@/lib/auth/viewer";
import { formatDate } from "@/lib/dates";

/**
 * Hire requests: Director or HR start a hire; only the Owner or CEO authorize the level and reporting line.
 * Shown to people who can start or authorize hires (live mode only).
 */
export function HireRequestsPanel() {
  const authorize = useCan("org.manage");
  const manage = useCan("people.manage");
  const qc = useQueryClient();
  const askReason = useReason();
  const query = useQuery({
    queryKey: ["people", "hire-requests"],
    queryFn: () => http.get<HireRequestView[]>("/hire-requests", { status: "pending" }),
    enabled: isLive("m3") && (authorize || manage),
  });
  const decide = useMutation({
    mutationFn: ({ id, action, reason }: { id: string; action: "approve" | "reject"; reason?: string }) =>
      http.post<{ empId?: string; welcomeEmailSent?: boolean }>(`/hire-requests/${id}/${action}`, action === "reject" ? { reason } : {}),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["people"] }),
  });

  const rows = query.data ?? [];
  if (!isLive("m3") || !(authorize || manage) || rows.length === 0) return null;

  return (
    <Card className="mb-4 p-4" data-testid="hire-requests">
      <p className="mb-1 flex items-center gap-2 text-[13px] font-semibold">
        <UserCheck className="size-4" /> Hires waiting for approval ({rows.length})
      </p>
      <p className="mb-3 text-[12.5px] text-muted-foreground">
        {authorize ? "You authorize the level and reporting line. The Emp-ID and welcome email are created when you approve." : "The Owner or CEO authorize the level and reporting line. The Emp-ID and welcome email follow after that."}
      </p>
      <ul className="grid gap-2">
        {rows.map((r) => (
          <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border px-3 py-2 text-[13px]">
            <span>
              <span className="font-medium">{r.name}</span> · {r.designation} · Level {r.proposedLevel}, reports to <span className="font-mono">{r.proposedReportsTo}</span>
              <span className="block text-[12px] text-muted-foreground">
                Requested by {r.requestedBy} on {formatDate(r.requestedAt)} · joins {formatDate(r.joiningDate)}
              </span>
            </span>
            {authorize && (
              <span className="flex gap-2">
                <Button
                  size="sm"
                  loading={decide.isPending && decide.variables?.id === r.id}
                  onClick={async () => {
                    try {
                      const res = await decide.mutateAsync({ id: r.id, action: "approve" });
                      toast.success(`${res.empId} created`, { description: res.welcomeEmailSent === false ? "The welcome email could not be sent; use Send it again on the profile." : "A welcome email with a temporary password was sent." });
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Couldn't approve.");
                    }
                  }}
                >
                  <Check /> Approve
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={async () => {
                    const reason = await askReason({ title: `Reject the hire of ${r.name}?`, confirmLabel: "Reject", destructive: true, placeholder: "Why is it rejected?" });
                    if (!reason) return;
                    try {
                      await decide.mutateAsync({ id: r.id, action: "reject", reason });
                      toast.success("Hire request rejected");
                    } catch (e) {
                      toast.error(e instanceof Error ? e.message : "Couldn't reject.");
                    }
                  }}
                >
                  <X /> Reject
                </Button>
              </span>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}

/** People who still report to someone who has left. Nothing moves them automatically; the Owner or CEO assign a new manager. */
export function UnresolvedReportsPanel() {
  const authorize = useCan("org.manage");
  const manage = useCan("people.manage");
  const query = useQuery({
    queryKey: ["people", "unresolved-reports"],
    queryFn: () => http.get<UnresolvedReport[]>("/employees/unresolved-reports"),
    enabled: isLive("m3") && (authorize || manage),
  });
  const rows = query.data ?? [];
  if (!isLive("m3") || !(authorize || manage) || rows.length === 0) return null;

  return (
    <Card className="mb-4 border-warning/40 p-4" data-testid="unresolved-reports">
      <p className="mb-1 flex items-center gap-2 text-[13px] font-semibold">
        <UserX className="size-4" /> Need a new manager ({rows.length})
      </p>
      <p className="mb-3 text-[12.5px] text-muted-foreground">
        These people still report to someone who has left. Nothing is moved automatically. {authorize ? "Open each profile, then Job, to choose the new manager." : "The Owner or CEO assign the new manager."}
      </p>
      <ul className="grid gap-1.5 text-[13px]">
        {rows.map((r) => (
          <li key={r.empId} className="flex flex-wrap items-center justify-between gap-2">
            <span>
              <span className="font-medium">{r.name}</span> <span className="font-mono text-muted-foreground">{r.empId}</span> · reports to {r.leftManager.name} ({r.leftManager.empId}), who left{r.leftManager.lastWorkingDay ? ` on ${formatDate(r.leftManager.lastWorkingDay)}` : ""}
            </span>
            {authorize && (
              <Button asChild size="sm" variant="outline">
                <Link href={`/people/${r.empId}?tab=job`}>Assign manager</Link>
              </Button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
