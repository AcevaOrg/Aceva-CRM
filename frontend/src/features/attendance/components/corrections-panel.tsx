"use client";
import { toast } from "sonner";
import { ArrowRight, Check, ClipboardCheck, Eye, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { EmpChip } from "@/components/shared/emp-chip";
import { StatusBadge, statusMap } from "@/components/shared/chips";
import { useReason } from "@/components/shared/dialogs";
import { SectionTitle } from "@/components/layout/page-header";
import { EmptyState, QueryState } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate, formatRelative, formatTime } from "@/lib/dates";
import { useCorrections, useDecideCorrection } from "../hooks";
import { approverLabel, correctionApprover } from "../logic";
import type { AttendanceCorrection } from "../types";

export const CORRECTION_STATUS = statusMap<AttendanceCorrection["status"]>({
  pending: { label: "Waiting for manager", tone: "warning" },
  approved: { label: "Approved", tone: "success" },
  rejected: { label: "Rejected", tone: "danger" },
});

/** Original (struck through) next to the requested times. The original is always kept. */
export function CorrectionCompare({ c }: { c: AttendanceCorrection }) {
  const t = (iso?: string) => (iso ? formatTime(iso) : "—");
  return (
    <div className="grid gap-1.5 text-[12.5px]">
      {(["checkIn", "checkOut"] as const).map((k) => (
        <div key={k} className="flex items-center gap-2">
          <span className="w-20 text-muted-foreground">{k === "checkIn" ? "Check-in" : "Check-out"}</span>
          <span className="font-mono tabular text-muted-foreground line-through decoration-muted-foreground/60">{t(c.original[k])}</span>
          <ArrowRight className="size-3 text-muted-foreground" />
          <span className="font-mono font-semibold tabular">{t(c.requested[k])}</span>
        </div>
      ))}
    </div>
  );
}

function CorrectionCard({ c, canDecide, viewOnlyNote }: { c: AttendanceCorrection; canDecide: boolean; viewOnlyNote?: string }) {
  const decide = useDecideCorrection();
  const askReason = useReason();
  const act = async (approve: boolean) => {
    const note = approve ? undefined : await askReason({ title: "Reject correction", description: "Tell the employee why. The original record stays as it was.", confirmLabel: "Reject", destructive: true });
    if (!approve && !note) return;
    try {
      await decide.mutateAsync({ id: c.id, approve, note: note ?? undefined });
      toast.success(approve ? "Correction approved" : "Correction rejected", { description: approve ? "The day was updated; the original is kept in history." : undefined });
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save");
    }
  };
  return (
    <Card className="grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-start">
      <div className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <EmpChip empId={c.empId} size="sm" />
          <span className="text-[13px] font-medium">{formatDate(c.date)}</span>
          <StatusBadge {...CORRECTION_STATUS(c.status)} />
        </div>
        <CorrectionCompare c={c} />
        <p className="text-[12.5px] text-muted-foreground">“{c.reason}” · asked {formatRelative(c.at)}</p>
        {c.decidedBy && (
          <p className="text-[12px] text-muted-foreground">
            {c.status === "approved" ? "Approved" : "Rejected"} by <EmpChip empId={c.decidedBy} size="sm" showId={false} />
            {c.decisionNote ? ` · “${c.decisionNote}”` : ""}
          </p>
        )}
        {viewOnlyNote && c.status === "pending" && (
          <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
            <Eye className="size-3.5 shrink-0" /> {viewOnlyNote}
          </p>
        )}
      </div>
      {canDecide && c.status === "pending" && (
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={() => act(false)} disabled={decide.isPending}>
            <X /> Reject
          </Button>
          <Button size="sm" onClick={() => act(true)} loading={decide.isPending}>
            <Check /> Approve
          </Button>
        </div>
      )}
    </Card>
  );
}

export function CorrectionsPanel() {
  const viewer = useViewer();
  const lookup = useLookup();
  const mine = useCorrections("mine");
  const team = useCorrections("team");
  const canApprove = viewer?.can("attendance.approve_correction");
  return (
    <div className="grid gap-8">
      {canApprove && (
        <section>
          <SectionTitle
            title="Team requests"
            description="Each request is approved by the person's manager: the CTO for Development, the Director for the CTO, Sales and Finance, and the CEO / Founder / Owner only for the Director's own. The rest are view only."
          />
          <QueryState
            query={team}
            isEmpty={(d) => d.length === 0}
            empty={<EmptyState compact icon={<ClipboardCheck />} title="No correction requests" description="When someone in your team asks to fix a check-in or check-out, it shows here." />}
          >
            {(list) => (
              <div className="grid gap-3">
                {list.map((c) => {
                  // Live (m7): the server routes the correction (Module 1, stand-ins included) and says who decides.
                  const approver = c.approverEmpId !== undefined ? (lookup.employees.find((e) => e.empId === c.approverEmpId) ?? null) : correctionApprover(c.empId, lookup.employees);
                  const canDecide = c.canDecide ?? (c.empId !== viewer?.employee.empId && approver?.empId === viewer?.employee.empId);
                  return <CorrectionCard key={c.id} c={c} canDecide={canDecide} viewOnlyNote={canDecide ? undefined : `View only. ${approverLabel(approver)} approves it.`} />;
                })}
              </div>
            )}
          </QueryState>
        </section>
      )}
      <section>
        <SectionTitle title="My requests" description="Open a day in My attendance to ask for a correction." />
        <QueryState
          query={mine}
          isEmpty={(d) => d.length === 0}
          empty={<EmptyState compact icon={<ClipboardCheck />} title="You haven't asked for any corrections" description="If you forget to check in or out, open that day in My attendance." />}
        >
          {(list) => (
            <div className="grid gap-3">
              {list.map((c) => (
                <CorrectionCard key={c.id} c={c} canDecide={false} />
              ))}
            </div>
          )}
        </QueryState>
      </section>
    </div>
  );
}
