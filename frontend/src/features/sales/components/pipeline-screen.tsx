"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { CircleCheck, Hourglass, SquareKanban, Trophy, TriangleAlert, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { NativeSelect, SegmentedControl } from "@/components/ui/controls";
import { Avatar } from "@/components/ui/misc";
import { Tip } from "@/components/ui/overlays";
import { PageHeader } from "@/components/layout/page-header";
import { RequireAccess } from "@/components/shared/can";
import { useReason } from "@/components/shared/dialogs";
import { KanbanBoard, type KanbanColumn } from "@/components/shared/kanban-board";
import { StatCard } from "@/components/shared/metrics";
import { CardsSkeleton, EmptyState, ErrorState } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { useUrlState } from "@/hooks/use-url-state";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate } from "@/lib/dates";
import { formatMoneyCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import { canWorkOn, type DealRow } from "../api";
import { useDeals, useMoveDeal } from "../hooks";
import { convert, LOST_REASONS, OPEN_STAGES, SERVICE_LABEL, STAGE_META, STAGES } from "../logic";
import type { DealService, DealStage } from "../types";
import { DealValue, FollowUpDue } from "./sales-ui";

export function PipelineScreen() {
  return (
    <RequireAccess permission="sales.own">
      <PipelineInner />
    </RequireAccess>
  );
}

const isClosed = (d: DealRow) => d.stage === "lost" || (d.stage === "won" && d.wonStatus === "confirmed");

function PipelineInner() {
  const viewer = useViewer();
  const team = !!viewer?.can(["sales.team", "sales.all"]);
  // Owners and the Director move deals; the CEO / Founder / Owner sees the whole pipeline but moves nothing.
  const canMove = (d: DealRow) => !!viewer && canWorkOn(viewer, d.ownerEmpId);
  const deals = useDeals();
  const move = useMoveDeal();
  const askReason = useReason();
  const lookup = useLookup();
  const [currency, setCurrency] = useUrlState<"USD" | "PKR">("cur", "USD");
  const [owner, setOwner] = useUrlState<string>("owner", "");
  const [service, setService] = useUrlState<"" | DealService>("service", "");
  // Fixed when the page opens: "won in the last 30 days" counts from here.
  const [since] = React.useState(() => Date.now() - 30 * 86_400_000);

  const all = deals.data ?? [];
  const list = all.filter((d) => (!owner || d.ownerEmpId === owner) && (!service || d.service === service));
  const sum = (ds: DealRow[]) => ds.reduce((s, d) => s + convert(d.value, currency), 0);
  const open = list.filter((d) => OPEN_STAGES.includes(d.stage));
  const pending = list.filter((d) => d.wonStatus === "pending");
  const wonMonth = list.filter((d) => d.stage === "won" && d.wonStatus === "confirmed" && new Date(d.handover?.at ?? d.updatedAt).getTime() >= since);

  const columns: KanbanColumn[] = STAGES.map((s) => {
    const inCol = list.filter((d) => d.stage === s);
    return { id: s, title: STAGE_META[s].label, color: STAGE_META[s].color, subtitle: <span className="font-mono tabular">{formatMoneyCompact(sum(inCol), currency)}</span> };
  });

  const onMove = async (d: DealRow, to: string) => {
    const stage = to as DealStage;
    let reason: string | undefined;
    if (stage === "lost") {
      const r = await askReason({
        title: `Why was ${d.companyName} lost?`,
        description: "A reason is required. The lead can be contacted again after 6 months (a setting).",
        options: LOST_REASONS,
        confirmLabel: "Mark as lost",
        destructive: true,
      });
      if (!r) return;
      reason = r;
    }
    move.mutate(
      { id: d.id, stage, reason },
      {
        onSuccess: (res) => {
          if (res.pending) toast(`${d.companyName}: waiting for confirmation`, { description: `${res.confirmer} confirms Won deals. You'll be told when it's done.`, icon: <Hourglass className="size-4" /> });
          else if (res.handover) toast.success(`${d.companyName} won`, { description: `Client created, draft invoice ${res.handover.invoiceNumber} in Billing, CTO notified.` });
          else if (res.recontactAfter) toast(`${d.companyName} marked as lost`, { description: `You can contact them again after ${formatDate(res.recontactAfter)}.` });
          else toast.success(`Moved to ${STAGE_META[stage].label}`);
        },
        onError: (e) => toast.error(e instanceof Error ? e.message : "Couldn't move the deal."),
      },
    );
  };

  return (
    <>
      <PageHeader
        title="Pipeline"
        description={
          all.some(canMove) || !all.length
            ? "Drag a deal to move it. Lost needs a reason; Won by a salesperson waits for the Director to confirm."
            : "View only. Salespeople move their own deals; the Director confirms Won deals."
        }
        seal="confidential"
        actions={
          <>
            {team && (
              <NativeSelect aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} className="w-40">
                <option value="">Everyone</option>
                {[...new Set(all.map((d) => d.ownerEmpId))].map((id) => (
                  <option key={id} value={id}>
                    {lookup.employee(id)?.name ?? id}
                  </option>
                ))}
              </NativeSelect>
            )}
            <NativeSelect aria-label="Service" value={service} onChange={(e) => setService(e.target.value as DealService | "")} className="w-40">
              <option value="">All services</option>
              {(Object.keys(SERVICE_LABEL) as DealService[]).map((s) => (
                <option key={s} value={s}>
                  {SERVICE_LABEL[s]}
                </option>
              ))}
            </NativeSelect>
            <SegmentedControl value={currency} onChange={setCurrency} options={[{ value: "USD", label: "USD" }, { value: "PKR", label: "PKR" }]} ariaLabel="Display currency" />
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Open pipeline" value={formatMoneyCompact(sum(open), currency)} hint={`${open.length} open deals`} icon={<Wallet />} accent="var(--zone-sales)" />
        <StatCard label="Won in the last 30 days" value={formatMoneyCompact(sum(wonMonth), currency)} hint={`${wonMonth.length} deals`} icon={<Trophy />} />
        <StatCard label="Waiting for confirmation" value={pending.length} hint={team ? "Won deals, confirmed by the Director" : "Won, with the Director"} icon={<Hourglass />} />
        <StatCard label="Without a next step date" value={open.filter((d) => !d.nextStepDate).length} hint="every open deal needs one" icon={<TriangleAlert />} />
      </div>

      {deals.isPending ? (
        <CardsSkeleton count={4} />
      ) : deals.isError ? (
        <ErrorState error={deals.error} onRetry={() => deals.refetch()} />
      ) : !all.length ? (
        <EmptyState icon={<SquareKanban />} title="No deals yet" description="Create a deal from a lead's page when they show interest." />
      ) : (
        <KanbanBoard
          columns={columns}
          items={list}
          columnOf={(d) => d.stage}
          itemKey={(d) => d.id}
          canDrop={(d, to) => canMove(d) && !isClosed(d) && !(d.wonStatus === "pending" && to === "won")}
          onMove={all.some(canMove) ? onMove : undefined}
          columnWidth={264}
          renderCard={(d) => <DealCard d={d} currency={currency} />}
        />
      )}
    </>
  );
}

function DealCard({ d, currency }: { d: DealRow; currency: "USD" | "PKR" }) {
  const lookup = useLookup();
  const owner = lookup.employee(d.ownerEmpId);
  const open = OPEN_STAGES.includes(d.stage);
  return (
    <Link
      href={`/sales/deals/${d.id}`}
      draggable={false}
      className={cn(
        "grid gap-2 rounded-lg border border-border bg-card p-3 shadow-strata transition hover:border-input hover:shadow-float",
        d.wonStatus === "pending" && "border-warning/50",
        d.stage === "lost" && "opacity-75",
      )}
    >
      {/* line-clamp (not truncate) keeps the card's min-content small, so it never overflows its column */}
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="line-clamp-1 break-all text-[13px] font-semibold">{d.companyName}</p>
          <p className="line-clamp-1 text-[12px] text-muted-foreground">
            {d.leadName} · {SERVICE_LABEL[d.service]}
          </p>
        </div>
        <DealValue value={d.value} display={currency} compact className="shrink-0 text-[12.5px] font-semibold" />
      </div>
      {open &&
        (d.nextStepDate ? (
          <div className="grid gap-1">
            <p className="line-clamp-2 text-[12px]">{d.nextStep}</p>
            <FollowUpDue date={d.nextStepDate} className="w-fit" />
          </div>
        ) : (
          <Badge tone="warning" className="w-fit">
            <TriangleAlert /> No next step date
          </Badge>
        ))}
      {d.wonStatus === "pending" && (
        <Badge tone="warning" className="w-fit">
          <Hourglass /> Waiting for the Director
        </Badge>
      )}
      {d.stage === "won" && d.wonStatus === "confirmed" && (
        <Badge tone="success" className="w-fit">
          <CircleCheck /> Handed over · {d.handover?.invoiceNumber}
        </Badge>
      )}
      {d.stage === "lost" && <p className="text-[12px] text-muted-foreground">Lost: {d.lostReason}</p>}
      <div className="flex items-center justify-between text-[11px] text-muted-foreground">
        <span className="font-mono">{d.number}</span>
        <Tip content={owner?.name ?? d.ownerEmpId}>
          <span>
            <Avatar name={owner?.name ?? d.ownerEmpId} hue={owner?.avatarHue} size={20} />
          </span>
        </Tip>
      </div>
    </Link>
  );
}
