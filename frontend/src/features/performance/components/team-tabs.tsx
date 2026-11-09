"use client";
/** Team, Review queue and Disputes tabs. */
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Check, ClipboardCheck, ExternalLink, Eye, Gavel, Info, Scale, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { SectionTitle } from "@/components/layout/page-header";
import { DataTable } from "@/components/shared/data-table";
import { DeadlineChip, StatusBadge, statusMap } from "@/components/shared/chips";
import { EmpChip } from "@/components/shared/emp-chip";
import { Mono } from "@/components/shared/money";
import { StarRating } from "@/components/shared/pickers";
import { EmptyState, QueryState } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { useTasks } from "@/features/tasks/hooks";
import { sizeRule } from "@/features/tasks/logic";
import type { Task } from "@/features/tasks/types";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate, formatMonthKey, formatRelative } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useDisputes, useTeamPerformance } from "../hooks";
import { isSalesMetrics } from "../logic";
import type { MetricSet, RatingDispute } from "../types";
import { BandBadge, SCORECARD_STATUS, Sparkline } from "./parts";
import { DecideDisputeDialog, ReviewTaskDialog } from "./perf-dialogs";

export function TeamPerformance() {
  const viewer = useViewer();
  const q = useTeamPerformance();
  const lookup = useLookup();
  const router = useRouter();
  const canRelease = !!viewer?.can("task.review");
  return (
    <div className="grid gap-3">
      <p className="flex items-start gap-2 rounded-lg border border-border bg-muted/50 px-3 py-2 text-[12.5px] text-muted-foreground">
        <Info className="mt-0.5 size-4 shrink-0" />
        Side by side, sorted by name. There is no ranking. You see the people below you in the reporting line. Sales staff are scored with the sales weights, so compare them with each other, not with task-based scores.
      </p>
      {!canRelease && (
        <p className="flex items-start gap-2 text-[12.5px] text-muted-foreground">
          <Eye className="mt-0.5 size-4 shrink-0" />
          View only. Each person&apos;s manager releases their scorecard: the CTO for Engineering, the Director for the CTO, Sales and Finance. The Director&apos;s own scorecard is released automatically.
        </p>
      )}
      <DataTable
        rows={q.data}
        loading={q.isPending}
        rowKey={(r) => r.empId}
        searchable
        searchText={(r) => `${lookup.employee(r.empId)?.name ?? ""} ${r.empId}`}
        searchPlaceholder="Search people"
        initialSort={{ key: "person", dir: "asc" }}
        onRowClick={(r) => r.latest && router.push(`/performance/scorecards/${r.latest.id}`)}
        empty={<EmptyState compact icon={<Users />} title="No one to show" description="People below you in the reporting line appear here." />}
        columns={[
          { key: "person", header: "Person", cell: (r) => <EmpChip empId={r.empId} size="sm" link={false} />, sortValue: (r) => lookup.employee(r.empId)?.name ?? r.empId },
          {
            key: "live",
            header: "This month",
            cell: (r) => (
              <span className="flex items-center gap-2">
                <span className="font-mono font-semibold tabular">{Math.round(r.live.score)}</span>
                <BandBadge band={r.live.band} />
                {r.live.smallSample && <Badge tone="outline">small sample</Badge>}
              </span>
            ),
            sortValue: (r) => r.live.score,
          },
          {
            key: "last",
            header: "Last scorecard",
            hideOnMobile: true,
            cell: (r) =>
              r.latest ? (
                <span className="grid justify-items-start gap-0.5">
                  <span className="flex items-center gap-2">
                    <span className="font-mono tabular">{Math.round(r.latest.score)}</span>
                    <span className="text-[12px] text-muted-foreground">{formatMonthKey(r.latest.month)}</span>
                  </span>
                  <StatusBadge {...SCORECARD_STATUS(r.latest.status)} />
                </span>
              ) : (
                "—"
              ),
          },
          {
            key: "metrics",
            header: "Q · T · C · R · A",
            hideOnMobile: true,
            cell: (r) => {
              if (!r.latest) return "—";
              if (isSalesMetrics(r.latest.metrics)) return <Badge tone="sales">Sales weights</Badge>;
              const m = r.latest.metrics as MetricSet;
              return (
                <span className="font-mono text-[12px] tabular text-muted-foreground">
                  {[m.quality, m.onTime, m.completion, m.rework, m.attendance].map((v) => Math.round(v)).join(" · ")}
                </span>
              );
            },
          },
          { key: "trend", header: "Trend", hideOnMobile: true, cell: (r) => <Sparkline points={r.trend.map((t) => t.score)} /> },
        ]}
      />
    </div>
  );
}

function ReviewCard({ t, onReview }: { t: Task; onReview: () => void }) {
  const onTime = !(t.submittedAt && new Date(t.submittedAt) > new Date(t.deadline));
  return (
    <Card className="grid gap-3 p-4 sm:grid-cols-[1fr_auto] sm:items-center">
      <div className="grid min-w-0 gap-1.5">
        <div className="flex flex-wrap items-center gap-2">
          <Mono className="text-[12px] text-muted-foreground">{t.number}</Mono>
          <Badge tone="outline">
            {t.size} · {sizeRule(t.size).points} pts
          </Badge>
          <Badge tone={onTime ? "success" : "warning"} dot>
            {onTime ? "Submitted on time" : "Submitted late"}
          </Badge>
          {t.extensionsCount > 0 && <Badge tone="info">{t.extensionsCount} extension</Badge>}
        </div>
        <Link href={`/tasks/${t.id}`} className="flex items-center gap-1 text-[14px] font-semibold hover:underline">
          {t.title} <ExternalLink className="size-3.5 text-muted-foreground" />
        </Link>
        <div className="flex flex-wrap items-center gap-3 text-[12.5px] text-muted-foreground">
          <EmpChip empId={t.assignee} size="sm" showId={false} />
          <span>Submitted {t.submittedAt ? formatRelative(t.submittedAt) : "recently"}</span>
          <DeadlineChip deadline={t.deadline} done />
        </div>
      </div>
      <Button onClick={onReview}>
        <Check /> Review
      </Button>
    </Card>
  );
}

export function ReviewQueue() {
  const viewer = useViewer();
  const q = useTasks({ scope: "team" });
  const [task, setTask] = React.useState<Task | null>(null);
  const me = viewer?.employee.empId;
  return (
    <section className="grid gap-3">
      <SectionTitle title="Waiting for your review" description="Approve with a rating from 1 to 5, or send back for rework with a reason. A rating or a reason is required." />
      <QueryState query={q}>
        {(tasks) => {
          const list = tasks.filter((t) => t.assignedBy === me && (t.status === "submitted" || t.status === "under_review")).sort((a, b) => (a.submittedAt ?? "").localeCompare(b.submittedAt ?? ""));
          return list.length ? (
            <div className="grid gap-3">
              {list.map((t) => (
                <ReviewCard key={t.id} t={t} onReview={() => setTask(t)} />
              ))}
            </div>
          ) : (
            <EmptyState compact icon={<ClipboardCheck />} title="Nothing to review" description="When someone you assigned work to submits it, it shows here." />
          );
        }}
      </QueryState>
      <ReviewTaskDialog task={task} onOpenChange={(o) => !o && setTask(null)} />
    </section>
  );
}

const DISPUTE_STATUS = statusMap<RatingDispute["status"]>({
  open: { label: "Open", tone: "warning" },
  upheld: { label: "Rating kept", tone: "neutral" },
  changed: { label: "Rating changed", tone: "success" },
});

export function DisputesPanel() {
  const viewer = useViewer();
  const q = useDisputes();
  const [deciding, setDeciding] = React.useState<RatingDispute | null>(null);
  const me = viewer?.employee.empId;
  // The CEO / Founder / Owner sees every dispute but decides none.
  const canDecide = !!viewer?.can("task.review");
  return (
    <section className="grid gap-3">
      <SectionTitle
        title="Rating disputes"
        description="If someone disagrees with a task rating, the level above the reviewer decides: the Director for ratings the CTO gave. The Director looks again at ratings the Director gave."
      />
      <QueryState query={q} isEmpty={(d) => d.length === 0} empty={<EmptyState compact icon={<Scale />} title="No disputes" description="Disputes you raise or need to decide appear here." />}>
        {(list) => (
          <div className="grid gap-3">
            {list.map((d) => (
              <Card key={d.id} className="grid gap-3 p-4">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="grid gap-1">
                    <EmpChip empId={d.empId} size="sm" />
                    <p className="text-[14px] font-semibold">
                      <Mono className="mr-1.5 text-[12px] font-normal text-muted-foreground">{d.taskNumber}</Mono>
                      {d.taskTitle}
                    </p>
                    <span className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                      Rated <StarRating value={d.currentRating} size={13} />
                      {d.newRating && (
                        <>
                          → <StarRating value={d.newRating} size={13} />
                        </>
                      )}
                    </span>
                  </div>
                  <StatusBadge {...DISPUTE_STATUS(d.status)} />
                </div>
                <blockquote className="rounded-lg border-l-2 border-border bg-muted/50 px-3 py-2 text-[13px]">“{d.reason}”</blockquote>
                {d.decision && (
                  <p className="text-[12.5px]">
                    <span className="text-muted-foreground">Decision by </span>
                    <EmpChip empId={d.decidedBy} size="sm" showId={false} />
                    <span className="text-muted-foreground"> · {d.decidedAt ? formatDate(d.decidedAt) : ""}</span>
                    <span className="mt-1 block">“{d.decision}”</span>
                  </p>
                )}
                <div className={cn("flex flex-wrap items-center justify-between gap-2 text-[12px] text-muted-foreground")}>
                  <span>
                    Raised {formatRelative(d.at)} · decided by <EmpChip empId={d.deciderEmpId} size="sm" showId={false} />
                  </span>
                  <div className="flex gap-2">
                    <Button asChild size="sm" variant="ghost">
                      <Link href={`/performance/scorecards/${d.scorecardId}`}>Scorecard</Link>
                    </Button>
                    {d.status === "open" && d.deciderEmpId === me && canDecide && (
                      <Button size="sm" onClick={() => setDeciding(d)}>
                        <Gavel /> Decide
                      </Button>
                    )}
                  </div>
                </div>
              </Card>
            ))}
          </div>
        )}
      </QueryState>
      <DecideDisputeDialog dispute={deciding} onOpenChange={(o) => !o && setDeciding(null)} />
    </section>
  );
}
