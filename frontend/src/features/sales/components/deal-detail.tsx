"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowRight, Check, CircleCheck, ExternalLink, FileText, Hourglass, NotebookPen, Pencil, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/controls";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { PageHeader } from "@/components/layout/page-header";
import { MakerCheckerNote } from "@/components/shared/approval-relay";
import { RequireAccess } from "@/components/shared/can";
import { StatusBadge } from "@/components/shared/chips";
import { useReason } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { Money } from "@/components/shared/money";
import { DetailList } from "@/components/shared/pickers";
import { ErrorState } from "@/components/shared/states";
import { Timeline, type TimelineItem } from "@/components/shared/timeline";
import { useLookup } from "@/hooks/use-directory";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate, formatDateTime, formatMonthKey } from "@/lib/dates";
import { ROLE_LABEL } from "@/lib/auth/permissions";
import { cn } from "@/lib/utils";
import { canConfirmWon, canWorkOn, isSalesManager, wonConfirmerOf } from "../api";
import { useConfirmWon, useDeal, useMoveDeal, useRejectWon, useSetProposal } from "../hooks";
import { LOST_REASONS, OPEN_STAGES, SERVICE_LABEL, STAGE_META } from "../logic";
import type { DealDetail, DealStage } from "../types";
import { FollowUpDialog } from "./follow-up-dialog";
import { LogActivityDialog } from "./lead-actions";
import { ACTIVITY_COLOR, ACTIVITY_ICON, activityLabel, DealValue, FollowUpDue, SourceTag, StageBadge } from "./sales-ui";

export function DealDetailScreen({ id }: { id: string }) {
  return (
    <RequireAccess permission="sales.own">
      <DealInner id={id} />
    </RequireAccess>
  );
}

function DealInner({ id }: { id: string }) {
  const q = useDeal(id);
  if (q.isPending)
    return (
      <div className="grid gap-4 pt-6">
        <Skeleton className="h-24" />
        <Skeleton className="h-16" />
        <Skeleton className="h-80" />
      </div>
    );
  if (q.isError)
    return (
      <>
        <PageHeader title="Deal" back={{ href: "/sales/pipeline", label: "Pipeline" }} />
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </>
    );
  return <DealBody d={q.data} />;
}

const FLOW: DealStage[] = ["new", "contacted", "replied", "meeting_booked", "proposal_sent", "negotiation", "won"];

function DealBody({ d }: { d: DealDetail }) {
  const { deal, lead, company, activities, commission } = d;
  const viewer = useViewer();
  const lookup = useLookup();
  const isOwner = viewer?.employee.empId === deal.ownerEmpId;
  // Won is confirmed by the Director (sales manager), never by the owner (maker-checker).
  const canConfirm = !!viewer && canConfirmWon(viewer, deal);
  // The owner and the Director work the deal; the CEO / Founder / Owner only views it.
  const canWork = !!viewer && canWorkOn(viewer, deal.ownerEmpId);
  const move = useMoveDeal();
  const confirm = useConfirmWon();
  const reject = useRejectWon();
  const askReason = useReason();
  const [logOpen, setLogOpen] = React.useState(false);
  const [stepMode, setStepMode] = React.useState<"done" | "edit" | null>(null);
  const open = OPEN_STAGES.includes(deal.stage);
  const closed = deal.stage === "lost" || (deal.stage === "won" && deal.wonStatus === "confirmed");
  const manager = lookup.employee(wonConfirmerOf(deal.ownerEmpId));

  const doMove = async (stage: DealStage) => {
    let reason: string | undefined;
    if (stage === "lost") {
      const r = await askReason({ title: `Why was ${company.name} lost?`, options: LOST_REASONS, confirmLabel: "Mark as lost", destructive: true });
      if (!r) return;
      reason = r;
    }
    move.mutate(
      { id: deal.id, stage, reason },
      {
        onSuccess: (res) => {
          if (res.pending) toast(`Waiting for ${res.confirmer} to confirm`, { icon: <Hourglass className="size-4" /> });
          else if (res.handover) toast.success("Won and handed over", { description: `Draft invoice ${res.handover.invoiceNumber} created in Billing.` });
          else toast.success(`Moved to ${STAGE_META[stage].label}`);
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't move the deal."),
      },
    );
  };

  const items: (TimelineItem & { at: string })[] = [
    ...activities.map((a) => ({
      id: a.id,
      at: a.at,
      icon: ACTIVITY_ICON[a.kind],
      color: ACTIVITY_COLOR[a.kind],
      title: (
        <span className="flex flex-wrap items-center gap-2">
          {activityLabel(a.kind)} <SourceTag source={a.source} />
        </span>
      ),
      body: <span className="text-muted-foreground">{a.summary}</span>,
      time: formatDateTime(a.at),
    })),
    ...deal.history.map((h, i) => ({
      id: `h${i}`,
      at: h.at,
      icon: <ArrowRight />,
      color: STAGE_META[h.stage].color,
      title: <span>Moved to {STAGE_META[h.stage].label}</span>,
      meta: (
        <span>
          by {lookup.employee(h.by)?.name ?? h.by}
          {h.note ? ` · ${h.note}` : ""}
        </span>
      ),
      time: formatDateTime(h.at),
    })),
  ].sort((a, b) => b.at.localeCompare(a.at));

  return (
    <>
      <PageHeader
        title={company.name}
        description={`${deal.number} · ${SERVICE_LABEL[deal.service]} for ${lead.name}`}
        back={{ href: "/sales/pipeline", label: "Pipeline" }}
        seal="confidential"
        meta={
          <>
            <StageBadge stage={deal.stage} pending={deal.wonStatus === "pending"} />
            <DealValue value={deal.value} className="text-[13px] font-semibold" />
            <EmpChip empId={deal.ownerEmpId} size="sm" showId={false} />
          </>
        }
        actions={
          canWork && (
          <>
            {!closed && (
              <NativeSelect aria-label="Move to stage" value="" onChange={(e) => e.target.value && doMove(e.target.value as DealStage)} className="w-44">
                <option value="">Move to…</option>
                {[...FLOW, "lost" as DealStage]
                  .filter((s) => s !== deal.stage)
                  .map((s) => (
                    <option key={s} value={s}>
                      {STAGE_META[s].label}
                    </option>
                  ))}
              </NativeSelect>
            )}
            <Button variant="outline" onClick={() => setLogOpen(true)}>
              <NotebookPen /> Log activity
            </Button>
          </>
          )
        }
      />

      {!canWork && (
        <div className="mb-5">
          <MakerCheckerNote reason="View only. The salesperson works this deal; the Director confirms Won deals and approves commission." />
        </div>
      )}

      {deal.wonStatus === "pending" && (
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-warning/40 bg-warning/10 p-4">
          <div className="flex items-start gap-3">
            <Hourglass className="mt-0.5 size-5 text-[oklch(0.6_0.14_70)]" />
            <div>
              <p className="text-[13.5px] font-semibold">Won · waiting for {canConfirm ? "you to confirm" : manager ? `${manager.name} (${ROLE_LABEL[manager.role]})` : "the manager"}</p>
              <p className="text-[12.5px] text-muted-foreground">
                {lookup.employee(deal.ownerEmpId)?.name} marked this deal as Won {deal.wonRequestedAt ? formatDateTime(deal.wonRequestedAt) : ""}. On confirmation the client is created, a draft invoice goes to
                Billing and the CTO is asked to create the project tasks.
              </p>
            </div>
          </div>
          {canConfirm ? (
            <div className="flex gap-2">
              <Button
                variant="outline"
                onClick={async () => {
                  const reason = await askReason({ title: "Not won yet?", description: "The deal goes back to its previous stage.", confirmLabel: "Send back" });
                  if (reason) reject.mutate({ id: deal.id, reason }, { onSuccess: () => toast("Sent back to the salesperson") });
                }}
              >
                <X /> Not yet
              </Button>
              <Button loading={confirm.isPending} onClick={() => confirm.mutate(deal.id, { onSuccess: (h) => toast.success("Won confirmed", { description: `Draft invoice ${h.invoiceNumber} created. CTO notified.` }) })}>
                <Check /> Confirm won
              </Button>
            </div>
          ) : isOwner && viewer && isSalesManager(viewer) ? (
            <MakerCheckerNote reason="You own this deal, so you can't confirm it. Nobody approves their own request." />
          ) : !isOwner ? (
            <MakerCheckerNote reason="View only. The Director confirms Won deals." />
          ) : (
            <Badge tone="warning">With {manager?.name ?? "the Director"}</Badge>
          )}
        </div>
      )}

      <StageStepper stage={deal.stage} pending={deal.wonStatus === "pending"} />

      <div className="mt-5 grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Timeline</CardTitle>
              <p className="text-[12.5px] text-muted-foreground">Contacts and stage changes, newest first.</p>
            </div>
          </CardHeader>
          <CardContent>
            <Timeline items={items} />
          </CardContent>
        </Card>

        <div className="grid content-start gap-5">
          {open && (
            <Card className={cn(!deal.nextStepDate && "border-warning/50")}>
              <CardHeader>
                <CardTitle>Next step</CardTitle>
                {canWork && (
                  <Button size="sm" variant="ghost" onClick={() => setStepMode("edit")}>
                    <Pencil /> Edit
                  </Button>
                )}
              </CardHeader>
              <CardContent className="grid gap-3">
                {deal.nextStepDate ? (
                  <>
                    <p className="text-[13.5px]">{deal.nextStep}</p>
                    <FollowUpDue date={deal.nextStepDate} className="w-fit" />
                    {canWork && (
                      <Button size="sm" variant="outline" className="w-fit" onClick={() => setStepMode("done")}>
                        <CircleCheck /> Mark done and set the next one
                      </Button>
                    )}
                  </>
                ) : (
                  <p className="text-[13px] text-[oklch(0.55_0.13_70)]">Every open deal needs a next step with a date.{canWork ? " Add one now." : ""}</p>
                )}
              </CardContent>
            </Card>
          )}

          {deal.handover && (
            <Card>
              <CardHeader>
                <CardTitle>Handover</CardTitle>
                <Badge tone="success">Done {formatDate(deal.handover.at)}</Badge>
              </CardHeader>
              <CardContent>
                <ul className="grid gap-2 text-[13px]">
                  <HandoverRow done>
                    {deal.handover.clientName} is now a client
                  </HandoverRow>
                  <HandoverRow done>
                    Draft invoice <span className="font-mono">{deal.handover.invoiceNumber}</span> for Finance to check and send
                    <Link href="/billing" className="ml-1 inline-flex items-center gap-0.5 text-primary hover:underline">
                      Billing <ExternalLink className="size-3" />
                    </Link>
                  </HandoverRow>
                  <HandoverRow done={deal.handover.ctoNotified}>CTO asked to create the project tasks</HandoverRow>
                  {deal.wonConfirmedBy && <li className="pl-6 text-[12px] text-muted-foreground">Confirmed by {lookup.employee(deal.wonConfirmedBy)?.name}</li>}
                </ul>
              </CardContent>
            </Card>
          )}

          {commission && (
            <Card>
              <CardHeader>
                <CardTitle>Commission</CardTitle>
                <StatusBadge
                  label={
                    {
                      calculated: "Waiting for the Director",
                      approved: "Approved",
                      sent_to_payroll: "Sent to payroll",
                      rejected: "Rejected",
                    }[commission.status]
                  }
                  tone={commission.status === "sent_to_payroll" ? "success" : commission.status === "rejected" ? "danger" : "warning"}
                />
              </CardHeader>
              <CardContent>
                <DetailList
                  columns={2}
                  items={[
                    ["Amount", <Money key="a" value={commission.amount} />],
                    ["Rate", `${commission.ratePercent}% of first payment`],
                    ["Invoice", <span key="i" className="font-mono">{commission.invoiceNumber}</span>],
                    ["Payroll month", commission.payrollMonth ? formatMonthKey(commission.payrollMonth) : "—"],
                  ]}
                />
              </CardContent>
            </Card>
          )}

          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <DetailList
                columns={2}
                items={[
                  ["Service", SERVICE_LABEL[deal.service]],
                  ["Value", <DealValue key="v" value={deal.value} />],
                  ["Expected close", formatDate(deal.expectedClose)],
                  ["Created", formatDate(deal.createdAt)],
                  ["Lead", <Link key="l" href={`/sales/leads/${lead.id}`} className="text-primary hover:underline">{lead.name}</Link>],
                  ["Country", company.country ?? "—"],
                  ...(deal.stage === "lost"
                    ? ([
                        ["Lost reason", deal.lostReason ?? "—"],
                        ["Contact again after", deal.recontactAfter ? formatDate(deal.recontactAfter) : "—"],
                      ] as [React.ReactNode, React.ReactNode][])
                    : []),
                ]}
              />
            </CardContent>
          </Card>

          <ProposalCard dealId={deal.id} url={deal.proposalUrl} editable={!closed && canWork} />
        </div>
      </div>

      {logOpen && <LogActivityDialog open onOpenChange={setLogOpen} leadId={lead.id} deals={[deal]} />}
      {stepMode && (
        <FollowUpDialog open onOpenChange={(o) => !o && setStepMode(null)} dealId={deal.id} company={company.name} currentStep={deal.nextStep} currentDate={deal.nextStepDate} mode={stepMode} />
      )}
    </>
  );
}

function HandoverRow({ done, children }: { done: boolean; children: React.ReactNode }) {
  return (
    <li className="flex gap-2">
      <span className={cn("mt-0.5 grid size-4 shrink-0 place-content-center rounded-full", done ? "bg-success text-white" : "bg-muted text-muted-foreground")}>
        <Check className="size-2.5" strokeWidth={3.5} />
      </span>
      <span>{children}</span>
    </li>
  );
}

function StageStepper({ stage, pending }: { stage: DealStage; pending: boolean }) {
  const idx = stage === "lost" ? -1 : FLOW.indexOf(stage);
  return (
    <ol className="flex gap-1 overflow-x-auto rounded-xl border border-border bg-card p-1.5 shadow-strata scrollbar-thin" aria-label="Deal stages">
      {FLOW.map((s, i) => {
        const done = idx >= 0 && i < idx;
        const current = i === idx;
        return (
          <li
            key={s}
            aria-current={current ? "step" : undefined}
            className={cn(
              "flex min-w-28 flex-1 items-center justify-center gap-1.5 rounded-lg px-2 py-2 text-[12px] font-medium whitespace-nowrap",
              done && "bg-muted text-foreground",
              current && (pending ? "bg-warning/20 font-semibold text-foreground" : "font-semibold text-foreground"),
              !done && !current && "text-muted-foreground",
            )}
            style={
              current && !pending
                ? { background: `color-mix(in oklch, ${STAGE_META[s].color} 18%, transparent)`, boxShadow: `inset 0 0 0 1.5px ${STAGE_META[s].color}` }
                : undefined
            }
          >
            {done && <Check className="size-3.5 text-success" strokeWidth={3} />}
            {current && <span className="size-2 rounded-full" style={{ background: STAGE_META[s].color }} />}
            {STAGE_META[s].label}
          </li>
        );
      })}
      {stage === "lost" && <li className="flex min-w-24 items-center justify-center rounded-lg bg-danger px-2 py-2 text-[12px] font-medium text-white">Lost</li>}
    </ol>
  );
}

function ProposalCard({ dealId, url, editable }: { dealId: string; url?: string; editable: boolean }) {
  const [value, setValue] = React.useState("");
  const save = useSetProposal();
  return (
    <Card>
      <CardHeader>
        <CardTitle>Proposal</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-2">
        {url ? (
          <a href={url} target="_blank" rel="noreferrer" className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-[13px] transition hover:bg-muted">
            <FileText className="size-4 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate">{url.split("/").pop()}</span>
            <ExternalLink className="size-3.5 text-muted-foreground" />
          </a>
        ) : (
          <p className="text-[13px] text-muted-foreground">No proposal linked yet.</p>
        )}
        {editable && (
          <form
            className="flex gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              if (value.trim().length < 8) return;
              save.mutate({ id: dealId, url: value.trim() }, { onSuccess: () => { setValue(""); toast.success("Proposal linked"); } });
            }}
          >
            <Input value={value} onChange={(e) => setValue(e.target.value)} placeholder="Paste a link to the proposal" aria-label="Proposal link" />
            <Button type="submit" variant="outline" loading={save.isPending} disabled={value.trim().length < 8}>
              {url ? "Replace" : "Link"}
            </Button>
          </form>
        )}
      </CardContent>
    </Card>
  );
}
