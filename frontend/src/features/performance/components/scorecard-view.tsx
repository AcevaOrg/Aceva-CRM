"use client";
import * as React from "react";
import { toast } from "sonner";
import { Bot, CheckCheck, Eye, Flag, Info, Lock, MessageSquareQuote, Send, Undo2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { PageHeader } from "@/components/layout/page-header";
import { DataTable } from "@/components/shared/data-table";
import { StatusBadge } from "@/components/shared/chips";
import { EmpChip } from "@/components/shared/emp-chip";
import { ScoreDial } from "@/components/shared/metrics";
import { Mono } from "@/components/shared/money";
import { StarRating } from "@/components/shared/pickers";
import { NotFoundBlock } from "@/components/shared/can";
import { ErrorState } from "@/components/shared/states";
import { Timeline, type TimelineItem } from "@/components/shared/timeline";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate, formatDateTime, formatMonthKey } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useAddRemark, useReleaseScorecard, useScorecard } from "../hooks";
import { SMALL_SAMPLE } from "../logic";
import type { ScorecardTask } from "../types";
import { SalesNumbers } from "./my-performance";
import { BandBadge, FormulaLine, MetricTiles, SCORECARD_STATUS } from "./parts";
import { AcknowledgeDialog, RaiseDisputeDialog } from "./perf-dialogs";

export function ScorecardView({ id }: { id: string }) {
  const viewer = useViewer();
  const q = useScorecard(id);
  const addRemark = useAddRemark();
  const release = useReleaseScorecard();
  const [remark, setRemark] = React.useState<string | null>(null);
  const [ack, setAck] = React.useState(false);
  const [disputeTask, setDisputeTask] = React.useState<string | null>(null);

  if (q.isPending)
    return (
      <div className="grid gap-4 pt-6">
        <Skeleton className="h-24 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    );
  if (q.isError) {
    const status = (q.error as { status?: number }).status;
    return <div className="pt-8">{status === 404 ? <NotFoundBlock /> : <ErrorState error={q.error} onRetry={() => q.refetch()} />}</div>;
  }

  const { scorecard: sc, weights, disputes } = q.data;
  const me = viewer?.employee.empId;
  const mine = sc.empId === me;
  // Only the person's manager releases or adds a remark; anyone above them (the CEO / Founder / Owner included) only views.
  const isReviewer = !!sc.reviewerEmpId && sc.reviewerEmpId === me && !!viewer?.can("task.review");
  const st = SCORECARD_STATUS(sc.status);
  const canDispute = mine && !!sc.reviewerEmpId && sc.status !== "draft" && sc.kind === "standard";
  const viewOnly = !mine && !isReviewer;
  const openDisputeTasks = new Set(disputes.filter((d) => d.status === "open").map((d) => d.taskNumber));

  const timeline: TimelineItem[] = [
    { id: "c", icon: <Bot />, title: "Draft created by the system", meta: "From approved task ratings and attendance", time: formatDateTime(sc.createdAt) },
    ...(sc.remarkAt ? [{ id: "r", icon: <MessageSquareQuote />, title: "Reviewer remark added", meta: <EmpChip empId={sc.reviewerEmpId} size="sm" showId={false} />, time: formatDateTime(sc.remarkAt) }] : []),
    sc.releasedAt
      ? sc.reviewerEmpId
        ? { id: "rel", icon: <Send />, color: "var(--info)", title: "Released to the employee", meta: <EmpChip empId={sc.reviewerEmpId} size="sm" showId={false} />, time: formatDateTime(sc.releasedAt) }
        : { id: "rel", icon: <Send />, color: "var(--info)", title: "Released automatically", meta: "No reviewer above the Director; the CEO / Founder / Owner views it", time: formatDateTime(sc.releasedAt) }
      : { id: "rel", icon: <Send />, title: "Waiting for the reviewer to release", meta: <EmpChip empId={sc.reviewerEmpId} size="sm" showId={false} />, muted: true },
    sc.acknowledgedAt
      ? { id: "ack", icon: <CheckCheck />, color: "var(--success)", title: "Acknowledged", meta: sc.employeeComment ? `“${sc.employeeComment}”` : undefined, time: formatDateTime(sc.acknowledgedAt) }
      : { id: "ack", icon: <CheckCheck />, title: "Not acknowledged yet", muted: true },
  ];

  const saveRemark = async (andRelease: boolean) => {
    const text = (remark ?? sc.reviewerRemark ?? "").trim();
    try {
      if (andRelease) await release.mutateAsync({ id: sc.id, remark: text || undefined });
      else await addRemark.mutateAsync({ id: sc.id, remark: text });
      toast.success(andRelease ? "Scorecard released" : "Remark saved", { description: andRelease ? "The employee was notified." : undefined });
      setRemark(null);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Couldn't save");
    }
  };

  return (
    <>
      <PageHeader
        back={{ href: mine ? "/performance" : "/performance?tab=team", label: "Performance" }}
        title={`${formatMonthKey(sc.month)} scorecard`}
        description={
          mine
            ? `Your monthly results. You can acknowledge${canDispute ? " and dispute a task rating" : ""}.`
            : isReviewer
              ? "Monthly results. As the reviewer you can add a remark and release it, but you can't change the numbers."
              : "Monthly results. View only: the person's manager reviews and releases it."
        }
        seal={mine ? "own" : "confidential"}
        meta={
          <>
            <EmpChip empId={sc.empId} size="sm" />
            <StatusBadge label={st.label} tone={st.tone} />
            <Badge tone="outline">{weights.label} weights · from {formatMonthKey(weights.effectiveFrom)}</Badge>
          </>
        }
        actions={
          <>
            {mine && sc.status === "released" && <Button onClick={() => setAck(true)}>Acknowledge</Button>}
            {isReviewer && sc.status === "draft" && (
              <Button onClick={() => saveRemark(true)} loading={release.isPending}>
                <Send /> Release
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-6">
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          <Card className="grid gap-5 p-5 md:grid-cols-[auto_1fr] md:items-center">
            <div className="grid justify-items-center gap-2">
              <ScoreDial score={sc.score} size={140} showBand={false} />
              <BandBadge band={sc.band} />
            </div>
            <div className="grid gap-3">
              <FormulaLine kind={sc.kind} metrics={sc.metrics} weights={weights.weights} score={sc.score} />
              {sc.smallSample && (
                <p className="flex items-start gap-2 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-[12.5px]">
                  <Info className="mt-0.5 size-4 shrink-0 text-info" /> Small sample: fewer than {SMALL_SAMPLE} tasks this month, so one task can move the score a lot.
                </p>
              )}
              <p className="flex items-start gap-2 text-[12.5px] text-muted-foreground">
                <Lock className="mt-0.5 size-3.5 shrink-0" /> This scorecard keeps the weights it was made with, even if the Director changes them later.
              </p>
              {viewOnly && sc.status === "draft" && sc.reviewerEmpId && (
                <p className="flex items-start gap-2 text-[12.5px] text-muted-foreground">
                  <Eye className="mt-0.5 size-3.5 shrink-0" /> View only. <EmpChip empId={sc.reviewerEmpId} size="sm" showId={false} /> releases it.
                </p>
              )}
            </div>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
            </CardHeader>
            <CardContent>
              <Timeline items={timeline} />
            </CardContent>
          </Card>
        </div>

        <MetricTiles kind={sc.kind} metrics={sc.metrics} weights={weights.weights} />

        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
          {sc.kind === "sales" && sc.salesDetail ? (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Sales numbers for the month</CardTitle>
                  <p className="text-[13px] text-muted-foreground">From the daily sales reports. Self-reported counts count toward Activity only.</p>
                </div>
              </CardHeader>
              <CardContent>
                <SalesNumbers d={sc.salesDetail} />
              </CardContent>
            </Card>
          ) : (
            <section className="grid gap-3">
              <div>
                <h2 className="text-base font-semibold tracking-tight">Tasks counted</h2>
                <p className="text-[13px] text-muted-foreground">Cancelled tasks don&apos;t count. An extension approved before the deadline isn&apos;t late.</p>
              </div>
              <DataTable<ScorecardTask>
                rows={sc.tasks}
                rowKey={(t) => t.number + t.title}
                pageSize={12}
                dense
                rowClassName={(t) => (t.status === "cancelled" ? "opacity-55" : undefined)}
                columns={[
                  {
                    key: "task",
                    header: "Task",
                    cell: (t) => (
                      <span className="grid min-w-0">
                        <span className={cn("truncate font-medium", t.status === "cancelled" && "line-through")}>{t.title}</span>
                        <Mono className="text-[11.5px] text-muted-foreground">
                          {t.number} · due {formatDate(t.deadline)}
                        </Mono>
                      </span>
                    ),
                  },
                  { key: "size", header: "Size", cell: (t) => <Badge tone="outline">{t.size} · {t.points} pt</Badge>, sortValue: (t) => t.points },
                  { key: "rating", header: "Rating", cell: (t) => (t.rating ? <StarRating value={t.rating} size={13} /> : <span className="text-[12px] text-muted-foreground">{t.status === "cancelled" ? "Cancelled" : "Not approved"}</span>), sortValue: (t) => t.rating ?? 0 },
                  {
                    key: "flags",
                    header: "On time",
                    cell: (t) =>
                      t.status === "cancelled" ? (
                        <span className="text-[12px] text-muted-foreground">Not counted</span>
                      ) : (
                        <span className="flex flex-wrap gap-1">
                          <Badge tone={t.onTime ? "success" : "warning"} dot>
                            {t.onTime ? "On time" : "Late"}
                          </Badge>
                          {t.reworked && <Badge tone="danger">Rework</Badge>}
                          {t.extensions > 0 && <Badge tone="info">Extended</Badge>}
                        </span>
                      ),
                  },
                  ...(canDispute
                    ? [
                        {
                          key: "dispute",
                          header: "",
                          align: "right" as const,
                          cell: (t: ScorecardTask) =>
                            t.rating ? (
                              openDisputeTasks.has(t.number) ? (
                                <Badge tone="warning">Disputed</Badge>
                              ) : (
                                <Button size="sm" variant="ghost" onClick={() => setDisputeTask(t.number)}>
                                  <Flag /> Dispute
                                </Button>
                              )
                            ) : null,
                        },
                      ]
                    : []),
                ]}
              />
            </section>
          )}

          <div className="grid content-start gap-6">
            <Card>
              <CardHeader>
                <div>
                  <CardTitle>Reviewer remark</CardTitle>
                  {sc.reviewerEmpId ? (
                    <p className="text-[13px] text-muted-foreground">Reviewer: <EmpChip empId={sc.reviewerEmpId} size="sm" showId={false} /></p>
                  ) : (
                    <p className="text-[13px] text-muted-foreground">No reviewer. The Director&apos;s scorecard is released automatically; the CEO / Founder / Owner views it.</p>
                  )}
                </div>
              </CardHeader>
              <CardContent className="grid gap-3">
                {isReviewer && sc.status !== "acknowledged" ? (
                  <>
                    <Textarea
                      value={remark ?? sc.reviewerRemark ?? ""}
                      onChange={(e) => setRemark(e.target.value)}
                      placeholder="Add context for the employee: what went well, what to focus on next month."
                      aria-label="Reviewer remark"
                    />
                    <div className="flex flex-wrap justify-end gap-2">
                      {remark !== null && (
                        <Button size="sm" variant="ghost" onClick={() => setRemark(null)}>
                          <Undo2 /> Undo
                        </Button>
                      )}
                      <Button size="sm" variant="outline" onClick={() => saveRemark(false)} loading={addRemark.isPending} disabled={!(remark ?? "").trim()}>
                        Save remark
                      </Button>
                      {sc.status === "draft" && (
                        <Button size="sm" onClick={() => saveRemark(true)} loading={release.isPending}>
                          <Send /> Save and release
                        </Button>
                      )}
                    </div>
                  </>
                ) : sc.reviewerRemark ? (
                  <p className="text-[13.5px]">“{sc.reviewerRemark}”</p>
                ) : (
                  <p className="text-[13px] text-muted-foreground">No remark.</p>
                )}
              </CardContent>
            </Card>

            {disputes.length > 0 && (
              <Card>
                <CardHeader>
                  <CardTitle>Disputes on this scorecard</CardTitle>
                </CardHeader>
                <CardContent className="grid gap-3">
                  {disputes.map((d) => (
                    <div key={d.id} className="grid gap-1 rounded-lg border border-border p-3 text-[12.5px]">
                      <div className="flex items-center justify-between gap-2">
                        <Mono className="font-medium">{d.taskNumber}</Mono>
                        <StatusBadge label={d.status === "open" ? "Open" : d.status === "changed" ? `Changed to ${d.newRating}★` : "Rating kept"} tone={d.status === "open" ? "warning" : d.status === "changed" ? "success" : "neutral"} />
                      </div>
                      <p className="text-muted-foreground">“{d.reason}”</p>
                      {d.decision && <p>Decision: “{d.decision}”</p>}
                    </div>
                  ))}
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </div>

      {mine && <AcknowledgeDialog scorecard={sc} open={ack} onOpenChange={setAck} />}
      {canDispute && <RaiseDisputeDialog scorecard={sc} open={!!disputeTask} taskNumber={disputeTask ?? undefined} onOpenChange={(o) => !o && setDisputeTask(null)} />}
    </>
  );
}
