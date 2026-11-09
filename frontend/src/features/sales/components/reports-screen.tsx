"use client";
import * as React from "react";
import { toast } from "sonner";
import { Camera, ChartLine, CircleCheck, CircleX, Mail, Target, Trophy, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect, SegmentedControl } from "@/components/ui/controls";
import { Tip } from "@/components/ui/overlays";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/layout/page-header";
import { RequireAccess } from "@/components/shared/can";
import { DataTable, type Column } from "@/components/shared/data-table";
import { EChart, type EChartOption } from "@/components/shared/echart";
import { EmpChip } from "@/components/shared/emp-chip";
import { ScoreDial, StatCard } from "@/components/shared/metrics";
import { CardsSkeleton, EmptyState, ErrorState, ListSkeleton } from "@/components/shared/states";
import { useUrlState } from "@/hooks/use-url-state";
import { useViewer } from "@/lib/auth/viewer";
import { formatMonthKey, formatWeekdayLong, isoDay } from "@/lib/dates";
import { formatMoneyCompact } from "@/lib/format";
import { cn } from "@/lib/utils";
import { isSalesManager, type DailyReportRow } from "../api";
import { useDailyReport, useReportDates, useRequestProof, useSalesDashboard, useSalesScorecards } from "../hooks";
import { emailsSentTotal, followUpsTotal, leadsAddedTotal, selfReportedTotal, STAGE_META } from "../logic";
import type { SalesScorecard } from "../types";

type Tab = "daily" | "dashboard" | "scorecard";

export function SalesReportsScreen() {
  return (
    <RequireAccess permission="sales.own">
      <ReportsInner />
    </RequireAccess>
  );
}

function ReportsInner() {
  const [tab, setTab] = useUrlState<Tab>("tab", "daily");
  const viewer = useViewer();
  const team = !!viewer?.can(["sales.team", "sales.all"]);
  // Asking for proof is the sales manager's job: the Director.
  const canAskProof = !!viewer && isSalesManager(viewer);
  return (
    <>
      <PageHeader
        title="Sales reports"
        description={team ? "Built every night from the connected tools and each person's manual log, compared with the day's targets." : "Your daily report, a dashboard of your own deals, and your sales scorecard."}
        seal="confidential"
      />
      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="daily">Daily report</TabsTrigger>
          <TabsTrigger value="dashboard">Dashboard</TabsTrigger>
          <TabsTrigger value="scorecard">Sales scorecard</TabsTrigger>
        </TabsList>
        <TabsContent value="daily">
          <DailyReport canAskProof={canAskProof} />
        </TabsContent>
        <TabsContent value="dashboard">
          <Dashboard />
        </TabsContent>
        <TabsContent value="scorecard">
          <Scorecards />
        </TabsContent>
      </Tabs>
    </>
  );
}

/* ---------------- Daily report ---------------- */

function dayLabel(date: string) {
  return formatWeekdayLong(new Date(`${date}T12:00:00`));
}

function DailyReport({ canAskProof }: { canAskProof: boolean }) {
  const dates = useReportDates();
  const todayIso = isoDay(new Date());
  const [picked, setPicked] = useUrlState<string>("date", "");
  const date = picked || dates.data?.find((d) => d < todayIso) || dates.data?.[0];
  const report = useDailyReport(date);
  const proof = useRequestProof();

  const columns: Column<DailyReportRow>[] = [
    { key: "person", header: "Salesperson", cell: (r) => <EmpChip empId={r.summary.empId} size="sm" /> },
    { key: "leads", header: "Leads added", align: "right", cell: (r) => <Num v={leadsAddedTotal(r.summary)} t={r.targets?.leadsAdded} /> },
    { key: "checked", header: "Checked", align: "right", cell: (r) => <span className="tabular"><Num v={r.summary.emailsChecked} t={r.targets?.emailsChecked} /> <span className="text-[11.5px] text-muted-foreground">({r.summary.invalid} invalid)</span></span> },
    { key: "sent", header: "Emails sent", align: "right", cell: (r) => <Num v={emailsSentTotal(r.summary)} t={r.targets?.emailsSent} /> },
    { key: "replies", header: "Replies", align: "right", cell: (r) => <span className="tabular">{r.summary.replies}</span> },
    { key: "meetings", header: "Meetings", align: "right", cell: (r) => <span className="tabular">{r.summary.meetings}</span> },
    { key: "follow", header: "Follow-ups", align: "right", cell: (r) => <Num v={followUpsTotal(r.summary)} t={r.targets?.followUps} /> },
    {
      key: "self",
      header: "Self-reported",
      align: "right",
      cell: (r) => (
        <span className="inline-flex items-center gap-1.5">
          <span className="tabular">{selfReportedTotal(r.summary)}</span>
          {r.summary.proofRequested && (
            <Tip content="The Director asked for proof, such as a screenshot.">
              <span tabIndex={0}>
                <Badge tone="warning">
                  <Camera /> Proof asked
                </Badge>
              </span>
            </Tip>
          )}
        </span>
      ),
    },
    {
      key: "met",
      header: "Targets",
      align: "right",
      cell: (r) =>
        r.met ? (
          <Badge tone={r.met.all ? "success" : "warning"}>
            {r.met.all ? <CircleCheck /> : <CircleX />}
            {[r.met.leadsAdded, r.met.emailsChecked, r.met.emailsSent, r.met.followUps].filter(Boolean).length} of 4 met
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
    ...(canAskProof
      ? [
          {
            key: "actions",
            header: "",
            align: "right" as const,
            hideOnMobile: true,
            cell: (r: DailyReportRow) =>
              selfReportedTotal(r.summary) > 0 && !r.summary.proofRequested ? (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={(e) => {
                    e.stopPropagation();
                    proof.mutate({ empId: r.summary.empId, date: r.summary.date }, { onSuccess: () => toast.success("Proof requested", { description: "The salesperson is asked for a screenshot of the self-reported work." }) });
                  }}
                >
                  <Camera /> Ask for proof
                </Button>
              ) : null,
          },
        ]
      : []),
  ];

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center gap-3">
        <NativeSelect aria-label="Report date" value={date ?? ""} onChange={(e) => setPicked(e.target.value)} className="w-64">
          {(dates.data ?? []).map((d) => (
            <option key={d} value={d}>
              {dayLabel(d)}
              {d === todayIso ? " (live)" : ""}
            </option>
          ))}
        </NativeSelect>
        <p className="text-[12.5px] text-muted-foreground">{date === todayIso ? "Today's numbers update with every sync. The final report is built tonight." : "The Director gets this in the daily summary email."}</p>
      </div>
      {report.isError ? (
        <ErrorState error={report.error} onRetry={() => report.refetch()} />
      ) : (
        <DataTable rows={report.data} loading={report.isPending || dates.isPending} columns={columns} rowKey={(r) => r.summary.id} empty={<EmptyState compact title="No report for this day" />} />
      )}
      {report.data && report.data.length > 0 && (
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Report lines</CardTitle>
              <p className="text-[12.5px] text-muted-foreground">As sent in the daily summary email. Self-reported counts are marked.</p>
            </div>
          </CardHeader>
          <CardContent className="grid gap-2">
            {report.data.map((r) => (
              <p key={r.summary.id} className={cn("rounded-lg border px-3 py-2.5 text-[13px] leading-relaxed", r.met?.all ? "border-success/30 bg-success/6" : "border-border bg-muted/40")}>
                <span className="font-mono text-[12px] font-semibold">{r.summary.empId}</span>
                {r.sentence.slice(r.summary.empId.length)}
              </p>
            ))}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

function Num({ v, t }: { v: number; t?: number }) {
  const met = t !== undefined && v >= t;
  return (
    <span className="tabular">
      <span className={cn("font-semibold", t !== undefined && (met ? "text-success" : "text-foreground"))}>{v}</span>
      {t !== undefined && <span className="text-muted-foreground"> / {t}</span>}
    </span>
  );
}

/* ---------------- Dashboard ---------------- */

function Dashboard() {
  const q = useSalesDashboard();
  const d = q.data;
  const charts = React.useMemo(() => {
    if (!d) return null;
    const stages = d.byStage.filter((s) => s.stage !== "lost");
    const bar = (cats: string[], series: EChartOption[]) => ({ tooltip: { trigger: "axis" }, xAxis: { type: "category", data: cats, axisLabel: { interval: 0, rotate: cats.length > 5 ? 25 : 0 } }, yAxis: { type: "value" }, series });
    return {
      pipeline: {
        ...bar(stages.map((s) => s.label), [
          { name: "Value (USD)", type: "bar", barMaxWidth: 34, data: stages.map((s) => ({ value: Math.round(s.valueUsd), itemStyle: { color: cssColor(STAGE_META[s.stage].color), borderRadius: [5, 5, 0, 0] } })) },
        ]),
        legend: { show: false },
      },
      wonLost: {
        tooltip: { trigger: "item" },
        legend: { bottom: 0, top: "auto" },
        series: [
          {
            type: "pie",
            radius: ["52%", "75%"],
            itemStyle: { borderColor: "transparent", borderWidth: 2 },
            label: { show: false },
            data: [
              { name: `Won (${d.wonLost.won})`, value: Math.round(d.wonLost.wonUsd), itemStyle: { color: cssColor("var(--success)") } },
              { name: `Lost (${d.wonLost.lost})`, value: Math.round(d.wonLost.lostUsd), itemStyle: { color: cssColor("var(--danger)") } },
            ],
          },
        ],
      },
      conversion: {
        tooltip: { trigger: "axis", valueFormatter: (v: number) => `${v}%` },
        grid: { left: 8, right: 24, top: 8, bottom: 4, containLabel: true },
        xAxis: { type: "value", max: 100, axisLabel: { formatter: "{value}%" } },
        yAxis: { type: "category", inverse: true, data: d.conversion.map((c) => `${c.from} → ${c.to}`) },
        series: [{ type: "bar", barMaxWidth: 18, data: d.conversion.map((c) => c.rate), itemStyle: { borderRadius: [0, 5, 5, 0] }, label: { show: true, position: "right", formatter: "{c}%", fontSize: 11 } }],
      },
      source: { tooltip: { trigger: "item" }, legend: { orient: "vertical", right: 0, top: "middle" }, series: [{ type: "pie", radius: ["45%", "72%"], center: ["35%", "50%"], label: { show: false }, data: d.bySource }] },
      country: bar(d.byCountry.map((c) => c.name.replace("United Arab Emirates", "UAE").replace("United Kingdom", "UK").replace("United States", "US")), [{ name: "Leads", type: "bar", barMaxWidth: 34, data: d.byCountry.map((c) => c.value), itemStyle: { borderRadius: [5, 5, 0, 0] } }]),
      activity: bar(d.activityWeek.map((a) => a.name), [
        { name: "Emails sent", type: "bar", data: d.activityWeek.map((a) => a.emailsSent), barMaxWidth: 26 },
        { name: "Replies", type: "bar", data: d.activityWeek.map((a) => a.replies), barMaxWidth: 26 },
        { name: "Meetings", type: "bar", data: d.activityWeek.map((a) => a.meetings), barMaxWidth: 26 },
        { name: "Self-reported", type: "bar", data: d.activityWeek.map((a) => a.selfReported), barMaxWidth: 26 },
      ]),
    };
  }, [d]);

  if (q.isPending) return <CardsSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!d || !charts) return null;
  const openUsd = d.byStage.filter((s) => !["won", "lost"].includes(s.stage)).reduce((n, s) => n + s.valueUsd, 0);
  const closed = d.wonLost.won + d.wonLost.lost;

  return (
    <div className="grid gap-5">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Open pipeline" value={formatMoneyCompact(openUsd, "USD")} icon={<Wallet />} accent="var(--zone-sales)" />
        <StatCard label="Won value" value={formatMoneyCompact(d.wonLost.wonUsd, "USD")} hint={`${d.wonLost.won} deals`} icon={<Trophy />} />
        <StatCard label="Win rate" value={closed ? `${Math.round((d.wonLost.won / closed) * 100)}%` : "—"} hint="won ÷ closed deals" icon={<Target />} />
        <StatCard label="Emails sent this week" value={d.activityWeek.reduce((n, a) => n + a.emailsSent, 0)} hint="Apollo and mailboxes" icon={<Mail />} />
      </div>
      <div className="grid gap-5 lg:grid-cols-2">
        <ChartCard title="Pipeline value by stage" hint="USD at the saved exchange rate">
          <EChart option={charts.pipeline} ariaLabel="Pipeline value by stage" />
        </ChartCard>
        <ChartCard title="Won and lost" hint="By value, all time">
          <EChart option={charts.wonLost} ariaLabel="Won and lost deals" />
        </ChartCard>
        <ChartCard title="How many deals move to the next stage" hint="Share of deals that reached each next stage">
          <EChart option={charts.conversion} ariaLabel="Stage conversion rates" />
        </ChartCard>
        <ChartCard title="Leads by source">
          <EChart option={charts.source} ariaLabel="Leads by source" />
        </ChartCard>
        <ChartCard title="Leads by country">
          <EChart option={charts.country} ariaLabel="Leads by country" />
        </ChartCard>
        <ChartCard title="Activity per person this week">
          <EChart option={charts.activity} ariaLabel="Activity per person this week" />
        </ChartCard>
      </div>
    </div>
  );
}

function ChartCard({ title, hint, children }: { title: string; hint?: string; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>{title}</CardTitle>
          {hint && <p className="text-[12.5px] text-muted-foreground">{hint}</p>}
        </div>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}

/* ---------------- Sales scorecard ---------------- */

function Scorecards() {
  const [which, setWhich] = useUrlState<"current" | "previous">("month", "current");
  const q = useSalesScorecards(which);
  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl value={which} onChange={setWhich} options={[{ value: "current", label: "This month so far" }, { value: "previous", label: "Last month" }]} />
        <p className="rounded-lg bg-muted px-3 py-1.5 font-mono text-[12px]">Sales score = 0.20 V + 0.25 M + 0.30 W + 0.10 D + 0.15 A</p>
      </div>
      {q.isPending ? (
        <ListSkeleton rows={2} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : !q.data.length ? (
        <EmptyState icon={<ChartLine />} title="No sales scorecards" description="Scorecards are made for people with sales targets." />
      ) : (
        <div className="grid gap-5 xl:grid-cols-2">
          {q.data.map((s) => (
            <ScorecardCard key={s.empId} s={s} live={which === "current"} />
          ))}
        </div>
      )}
    </div>
  );
}

function ScorecardCard({ s, live }: { s: SalesScorecard; live: boolean }) {
  const metrics = [
    { key: "V", label: "Activity", value: s.activity, weight: s.weights.activity, how: live ? `Daily targets met on ${s.detail.daysMet} of ${s.detail.workingDays} working days` : "Working days with targets met ÷ working days" },
    { key: "M", label: "Meetings", value: s.meetings, weight: s.weights.meetings, how: live ? `${s.detail.meetingsBooked} booked of ${s.detail.meetingTarget} target` : "Meetings booked ÷ monthly meeting target" },
    { key: "W", label: "Deals won", value: s.won, weight: s.weights.won, how: live ? `USD ${Math.round(s.detail.wonUsd).toLocaleString()} of USD ${Math.round(s.detail.wonTargetUsd).toLocaleString()} target` : "Value of deals won ÷ monthly sales target" },
    { key: "D", label: "Data quality", value: s.dataQuality, weight: s.weights.dataQuality, how: live ? `Bounce rate ${s.detail.bounceRate.toFixed(1)}%, ${s.detail.duplicates} duplicate${s.detail.duplicates === 1 ? "" : "s"}` : "100 at ≤ 3% bounces and no duplicates" },
    { key: "A", label: "Attendance", value: s.attendance, weight: s.weights.attendance, how: "Days present on time ÷ working days" },
  ];
  return (
    <Card>
      <CardHeader>
        <div className="grid gap-1">
          <EmpChip empId={s.empId} />
          <p className="text-[12.5px] text-muted-foreground">
            {formatMonthKey(s.month)}
            {live ? " · so far" : ""}
          </p>
        </div>
        {live && <Badge tone="info">Draft · the Director releases it on the 1st</Badge>}
      </CardHeader>
      <CardContent className="grid gap-5 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center">
        <div className="justify-self-center">
          <ScoreDial score={s.score} size={140} />
        </div>
        <ul className="grid gap-2.5">
          {metrics.map((m) => (
            <li key={m.key} className="grid gap-1">
              <div className="flex items-center justify-between gap-2 text-[12.5px]">
                <span className="font-medium">
                  <span className="mr-1.5 inline-grid size-5 place-content-center rounded bg-muted font-mono text-[11px]">{m.key}</span>
                  {m.label} <span className="text-muted-foreground">· {Math.round(m.weight * 100)}%</span>
                </span>
                <span className="font-mono font-semibold tabular">{Math.round(m.value)}</span>
              </div>
              <div className="h-1.5 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full bg-zone-sales" style={{ width: `${Math.min(100, m.value)}%` }} />
              </div>
              <p className="text-[11.5px] text-muted-foreground">{m.how}</p>
            </li>
          ))}
        </ul>
      </CardContent>
    </Card>
  );
}

/** ECharts draws on a canvas, which can't read CSS variables: resolve them first. */
function cssColor(v: string) {
  if (typeof window === "undefined" || !v.startsWith("var(")) return v;
  return getComputedStyle(document.documentElement).getPropertyValue(v.slice(4, -1)).trim() || "#888";
}
