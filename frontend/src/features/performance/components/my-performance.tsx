"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowRight, Flag, Hourglass, Info, MessageSquareQuote, ScrollText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { StatusBadge } from "@/components/shared/chips";
import { EmpChip } from "@/components/shared/emp-chip";
import { ErrorState, EmptyState } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { formatDate, formatMonthKey } from "@/lib/dates";
import { useLatestScorecard, useLivePerformance, useScorecards } from "../hooks";
import { SMALL_SAMPLE } from "../logic";
import type { LivePerformance, MetricSet, SalesDetail } from "../types";
import { BandBadge, FormulaLine, MetricTiles, SCORECARD_STATUS, ScoreDialOrNone, TrendChart, UnmeasuredNotice } from "./parts";
import { AcknowledgeDialog, RaiseDisputeDialog } from "./perf-dialogs";

export function SalesNumbers({ d }: { d: SalesDetail }) {
  const rows: [string, string][] = [
    ["Days with targets met", `${d.targetDaysMet} of ${d.workingDays}`],
    ["Meetings booked", `${d.meetings} of ${d.meetingTarget}`],
    ["Deals won", `USD ${d.wonValueUsd.toLocaleString()} of ${d.wonTargetUsd.toLocaleString()}`],
    ["Bounce rate", `${d.bounceRate}%`],
    ["Duplicate leads", `${d.duplicates}`],
  ];
  return (
    <dl className="grid gap-2 text-[13px]">
      {rows.map(([k, v]) => (
        <div key={k} className="flex items-center justify-between gap-3 border-b border-dashed border-border pb-1.5 last:border-0">
          <dt className="text-muted-foreground">{k}</dt>
          <dd className="font-mono tabular">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Shown instead of the sales numbers while the Sales module does not exist: the figures are not invented. */
export function NoSalesFigures() {
  return (
    <p className="flex items-start gap-2 text-[13px] text-muted-foreground">
      <Info className="mt-0.5 size-4 shrink-0" /> Sales figures arrive with the Sales module. Until then there are no sales numbers here and no sales score.
    </p>
  );
}

function LiveCard({ live }: { live: LivePerformance }) {
  const noSalesFigures = live.kind === "sales" && !live.salesDetail;
  return (
    <Card className="grid gap-5 p-5 lg:grid-cols-[auto_1fr] lg:items-center">
      <div className="grid justify-items-center gap-2">
        <ScoreDialOrNone score={live.score} size={148} showBand={false} />
        <BandBadge band={live.band} />
        <p className="text-[12px] text-muted-foreground">{formatMonthKey(live.month)} · so far</p>
      </div>
      <div className="grid gap-4">
        <div className="flex flex-wrap items-center gap-2">
          <StatusBadge label={`${live.weights.label} weights`} tone="outline" />
          {live.smallSample && (
            <StatusBadge label={`Small sample: under ${SMALL_SAMPLE} tasks`} tone="info" icon={<Info />} />
          )}
        </div>
        <FormulaLine kind={live.kind} metrics={live.metrics} weights={live.weights.weights} score={live.score} />
        <UnmeasuredNotice kind={live.kind} unmeasured={live.unmeasured} />
        <p className="text-[12.5px] text-muted-foreground">
          {live.kind === "sales"
            ? noSalesFigures
              ? "Sales figures arrive with the Sales module, so there is no sales score yet. Nobody types a score in."
              : "Calculated from the daily sales report and attendance. Self-reported counts count toward Activity only."
            : "Calculated from your reviewed tasks and attendance. Nobody types a score in; your manager can add a remark but can't change the numbers."}
        </p>
        {live.kind === "standard" && (
          <p className="text-[12.5px]">
            <Hourglass className="mr-1.5 inline size-3.5 align-[-2px] text-muted-foreground" />
            Workload right now: <span className="font-semibold tabular">{(live.metrics as MetricSet).workloadHours} h</span> of open tasks (shown for information, not scored)
          </p>
        )}
      </div>
    </Card>
  );
}

function LatestScorecardCard() {
  const q = useLatestScorecard();
  const lookup = useLookup();
  const [ack, setAck] = React.useState(false);
  const [dispute, setDispute] = React.useState(false);
  if (q.isPending) return <Skeleton className="h-56 rounded-xl" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const sc = q.data;
  if (!sc) return <EmptyState compact icon={<ScrollText />} title="No scorecard yet" description="Your first scorecard is created on the 1st of next month." />;
  const st = SCORECARD_STATUS(sc.status);
  return (
    <Card>
      <CardHeader className="flex-wrap">
        <div>
          <CardTitle>{formatMonthKey(sc.month)} scorecard</CardTitle>
          <p className="text-[13px] text-muted-foreground">
            Released {sc.releasedAt ? formatDate(sc.releasedAt) : "—"}
            {sc.reviewerEmpId ? ` by ${lookup.employee(sc.reviewerEmpId)?.name ?? sc.reviewerEmpId}` : " automatically (nobody above reviews work)"}
          </p>
        </div>
        <StatusBadge label={st.label} tone={st.tone} />
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="flex flex-wrap items-center gap-5">
          <ScoreDialOrNone score={sc.score} size={104} showBand={false} />
          <div className="grid gap-2">
            <BandBadge band={sc.band} />
            <p className="text-[12.5px] text-muted-foreground">{sc.kind === "sales" ? "Sales weights" : `${sc.taskCount} tasks counted`}</p>
            {!!sc.recomputeCount && <p className="text-[12.5px] text-muted-foreground">Recalculated after a rating dispute was decided.</p>}
          </div>
        </div>
        {sc.reviewerRemark && (
          <div className="flex gap-2 rounded-lg bg-muted/60 p-3 text-[13px]">
            <MessageSquareQuote className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
            <div>
              <p>“{sc.reviewerRemark}”</p>
              <div className="mt-1">
                <EmpChip empId={sc.reviewerEmpId} size="sm" showId={false} />
              </div>
            </div>
          </div>
        )}
        {sc.employeeComment && <p className="text-[12.5px] text-muted-foreground">Your comment: “{sc.employeeComment}”</p>}
        <div className="flex flex-wrap gap-2">
          {sc.status === "released" && <Button onClick={() => setAck(true)}>Acknowledge</Button>}
          {sc.kind === "standard" && !!sc.reviewerEmpId && sc.tasks.some((t) => t.rating) && (
            <Button variant="outline" onClick={() => setDispute(true)}>
              <Flag /> Dispute a rating
            </Button>
          )}
          <Button asChild variant="ghost">
            <Link href={`/performance/scorecards/${sc.id}`}>
              Open scorecard <ArrowRight />
            </Link>
          </Button>
        </div>
      </CardContent>
      <AcknowledgeDialog scorecard={sc} open={ack} onOpenChange={setAck} />
      <RaiseDisputeDialog scorecard={sc} open={dispute} onOpenChange={setDispute} />
    </Card>
  );
}

function PastScorecards() {
  const q = useScorecards();
  if (q.isPending) return <Skeleton className="h-56 rounded-xl" />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  return (
    <Card>
      <CardHeader>
        <CardTitle>All my scorecards</CardTitle>
      </CardHeader>
      <CardContent className="grid gap-1 px-2 pb-2">
        {q.data.length === 0 && <p className="px-3 pb-3 text-[13px] text-muted-foreground">None yet.</p>}
        {q.data.map((s) => (
          <Link key={s.id} href={`/performance/scorecards/${s.id}`} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 transition hover:bg-muted">
            <span className="text-[13px] font-medium">{formatMonthKey(s.month)}</span>
            <span className="flex items-center gap-2">
              <span className="font-mono text-[13px] font-semibold tabular">{s.score === null ? "—" : Math.round(s.score)}</span>
              <BandBadge band={s.band} />
            </span>
          </Link>
        ))}
      </CardContent>
    </Card>
  );
}

export function MyPerformance() {
  const live = useLivePerformance();
  if (live.isError) return <ErrorState error={live.error} onRetry={() => live.refetch()} />;
  if (live.isPending)
    return (
      <div className="grid gap-4">
        <Skeleton className="h-52 rounded-xl" />
        <div className="grid grid-cols-2 gap-3 xl:grid-cols-5">
          {Array.from({ length: 5 }, (_, i) => (
            <Skeleton key={i} className="h-32 rounded-xl" />
          ))}
        </div>
      </div>
    );
  const d = live.data;
  return (
    <div className="grid gap-6">
      <LiveCard live={d} />
      <MetricTiles kind={d.kind} metrics={d.metrics} weights={d.weights.weights} unmeasured={d.unmeasured} />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Trend</CardTitle>
              <p className="text-[13px] text-muted-foreground">Closed months, then this month so far (dashed).</p>
            </div>
          </CardHeader>
          <CardContent>
            <TrendChart trend={d.trend} liveMonth={d.month} />
          </CardContent>
        </Card>
        {d.kind === "sales" ? (
          <Card>
            <CardHeader>
              <div>
                <CardTitle>Where the numbers come from</CardTitle>
                <p className="text-[13px] text-muted-foreground">This month so far, from the daily sales report.</p>
              </div>
            </CardHeader>
            <CardContent>{d.salesDetail ? <SalesNumbers d={d.salesDetail} /> : <NoSalesFigures />}</CardContent>
          </Card>
        ) : (
          <PastScorecards />
        )}
      </div>
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <LatestScorecardCard />
        {d.kind === "sales" && <PastScorecards />}
      </div>
    </div>
  );
}
