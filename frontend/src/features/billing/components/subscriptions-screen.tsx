"use client";
import * as React from "react";
import { Activity, CalendarClock, Gauge, History, MoreHorizontal, Pencil, Plus, Repeat, TriangleAlert, Wallet } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Progress } from "@/components/ui/misc";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/layout/page-header";
import { Can, RequireAccess } from "@/components/shared/can";
import { FreshnessStamp } from "@/components/shared/chips";
import { DataTable, type Column } from "@/components/shared/data-table";
import { EmpChip } from "@/components/shared/emp-chip";
import { StatCard } from "@/components/shared/metrics";
import { Money } from "@/components/shared/money";
import { CardsSkeleton, EmptyState, ErrorState, ListSkeleton } from "@/components/shared/states";
import { Timeline } from "@/components/shared/timeline";
import { useUrlState } from "@/hooks/use-url-state";
import { useEmployee } from "@/hooks/use-directory";
import { useCan } from "@/lib/auth/viewer";
import { formatDate, formatRelative } from "@/lib/dates";
import { formatMoney, formatNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useRenewalDecisions, useSubscriptions } from "../hooks";
import { daysUntil, monthlyCostPkr, SUB_CATEGORY, SUB_PERIOD, usageFlag, usagePercent, USD_TO_PKR } from "../logic";
import type { Subscription } from "../types";
import { Countdown, Sparkline, SubStatusBadge, ViewOnlyNote } from "./bits";
import { RenewalDecisionDialog, SubscriptionSheet, UsageReadingDialog } from "./subscription-forms";

type Tab = "register" | "renewals" | "usage";

export function SubscriptionsScreen() {
  return (
    <RequireAccess permission="subscriptions.view" mode="404">
      <SubscriptionsBody />
    </RequireAccess>
  );
}

function SubscriptionsBody() {
  const [tab, setTab] = useUrlState<Tab>("tab", "register");
  const q = useSubscriptions();
  const [editing, setEditing] = React.useState<Subscription | "new" | null>(null);
  const [deciding, setDeciding] = React.useState<Subscription | null>(null);
  const [reading, setReading] = React.useState<Subscription | null>(null);
  const subs = q.data ?? [];
  const live = subs.filter((s) => s.status !== "cancelled");
  const monthly = live.reduce((s, x) => s + monthlyCostPkr(x), 0);
  const soon = live.filter((s) => daysUntil(s.renewalDate) >= 0 && daysUntil(s.renewalDate) <= 14).length;
  const flagged = live.filter((s) => usageFlag(s.usage)).length;
  const actions = { edit: (s: Subscription) => setEditing(s), decide: (s: Subscription) => setDeciding(s), reading: (s: Subscription) => setReading(s) };

  return (
    <>
      <PageHeader
        title="Subscriptions"
        description="Tools, domains and services Aceva pays for, who owns each one, and when it renews."
        seal="confidential"
        actions={
          <Can permission="subscriptions.manage">
            <Button onClick={() => setEditing("new")}>
              <Plus /> Add subscription
            </Button>
          </Can>
        }
      />

      <Can permission="subscriptions.manage" fallback={<ViewOnlyNote className="mb-4">View only. The Director adds subscriptions, records usage and decides renewals.</ViewOnlyNote>}>
        {null}
      </Can>
      {q.isPending ? (
        <CardsSkeleton className="mb-6" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} className="mb-6" />
      ) : (
        <div className="mb-6 grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          <StatCard label="Monthly cost" value={<Money value={monthly} compact />} icon={<Wallet />} accent="var(--zone-finance)" hint={`Yearly plans spread per month · USD at ${USD_TO_PKR}`} />
          <StatCard label="Active services" value={live.length} icon={<Repeat />} accent="var(--info)" hint={`${subs.length - live.length} cancelled`} />
          <StatCard label="Renewing in 14 days" value={soon} icon={<CalendarClock />} accent="var(--warning)" onClick={() => setTab("renewals")} />
          <StatCard label="Usage flags" value={<span className={flagged ? "text-danger" : undefined}>{flagged}</span>} icon={<Gauge />} accent="var(--danger)" hint="Near limit or unusual" onClick={() => setTab("usage")} />
        </div>
      )}

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)}>
        <TabsList>
          <TabsTrigger value="register">
            <Repeat /> Register
          </TabsTrigger>
          <TabsTrigger value="renewals">
            <CalendarClock /> Renewals
          </TabsTrigger>
          <TabsTrigger value="usage">
            <Activity /> Usage
          </TabsTrigger>
        </TabsList>
        <TabsContent value="register">
          <RegisterTab subs={subs} loading={q.isPending} actions={actions} />
        </TabsContent>
        <TabsContent value="renewals">
          <RenewalsTab subs={subs} loading={q.isPending} onDecide={setDeciding} />
        </TabsContent>
        <TabsContent value="usage">
          <UsageTab subs={subs} loading={q.isPending} onReading={setReading} />
        </TabsContent>
      </Tabs>

      <SubscriptionSheet open={!!editing} onOpenChange={(o) => !o && setEditing(null)} sub={editing && editing !== "new" ? editing : undefined} />
      {deciding && <RenewalDecisionDialog sub={deciding} onClose={() => setDeciding(null)} />}
      {reading && <UsageReadingDialog sub={reading} onClose={() => setReading(null)} />}
    </>
  );
}

function RowMenu({ s, actions }: { s: Subscription; actions: { edit: (s: Subscription) => void; decide: (s: Subscription) => void; reading: (s: Subscription) => void } }) {
  const canManage = useCan("subscriptions.manage");
  if (!canManage) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon-sm" variant="ghost" aria-label={`Actions for ${s.vendor}`} onClick={(e) => e.stopPropagation()}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onSelect={() => actions.edit(s)}>
          <Pencil /> Edit
        </DropdownMenuItem>
        {s.status !== "cancelled" && (
          <DropdownMenuItem onSelect={() => actions.decide(s)}>
            <History /> Record renewal decision
          </DropdownMenuItem>
        )}
        {s.usage?.source === "manual" && (
          <DropdownMenuItem onSelect={() => actions.reading(s)}>
            <Gauge /> Add usage reading
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function RegisterTab({ subs, loading, actions }: { subs: Subscription[]; loading: boolean; actions: Parameters<typeof RowMenu>[0]["actions"] }) {
  const columns: Column<Subscription>[] = [
    {
      key: "service",
      header: "Service",
      sortValue: (s) => s.vendor,
      cell: (s) => (
        <div className="grid min-w-0">
          <span className="font-medium">{s.vendor}</span>
          <span className="truncate text-[12px] text-muted-foreground">{s.product}</span>
        </div>
      ),
    },
    { key: "category", header: "Category", sortValue: (s) => s.category, hideOnMobile: true, cell: (s) => <Badge tone="outline">{SUB_CATEGORY[s.category]}</Badge> },
    { key: "owner", header: "Owner", hideOnMobile: true, cell: (s) => <EmpChip empId={s.ownerEmpId} size="sm" showId={false} /> },
    { key: "plan", header: "Plan", hideOnMobile: true, cell: (s) => <span className="text-[12.5px]">{s.plan}</span> },
    {
      key: "cost",
      header: "Cost",
      align: "right",
      sortValue: (s) => monthlyCostPkr(s),
      cell: (s) => (
        <div className="grid justify-items-end">
          <Money value={s.cost} />
          <span className="text-[11px] text-muted-foreground">{SUB_PERIOD[s.period]}</span>
        </div>
      ),
    },
    {
      key: "renewal",
      header: "Renews",
      sortValue: (s) => (s.status === "cancelled" ? "9999" : s.renewalDate),
      cell: (s) =>
        s.status === "cancelled" ? (
          <span className="text-muted-foreground">—</span>
        ) : (
          <div className="grid justify-items-start gap-0.5">
            <span className="tabular text-[12.5px]">{formatDate(s.renewalDate)}</span>
            <Countdown date={s.renewalDate} alertDays={s.alertDaysBefore} />
          </div>
        ),
    },
    { key: "status", header: "Status", sortValue: (s) => s.status, cell: (s) => <SubStatusBadge status={s.status} /> },
    { key: "actions", header: <span className="sr-only">Actions</span>, align: "right", cell: (s) => <RowMenu s={s} actions={actions} /> },
  ];
  return (
    <DataTable
      rows={subs}
      loading={loading}
      columns={columns}
      rowKey={(s) => s.id}
      searchable
      searchText={(s) => `${s.vendor} ${s.product} ${s.plan} ${SUB_CATEGORY[s.category]}`}
      searchPlaceholder="Search tools and services"
      initialSort={{ key: "renewal", dir: "asc" }}
      rowClassName={(s) => (s.status === "cancelled" ? "opacity-60" : undefined)}
      pageSize={20}
      empty={<EmptyState compact icon={<Repeat />} title="No subscriptions recorded" />}
    />
  );
}

function RenewalsTab({ subs, loading, onDecide }: { subs: Subscription[]; loading: boolean; onDecide: (s: Subscription) => void }) {
  const decisions = useRenewalDecisions();
  const canManage = useCan("subscriptions.manage");
  const upcoming = subs
    .filter((s) => s.status !== "cancelled" && daysUntil(s.renewalDate) >= 0 && daysUntil(s.renewalDate) <= 90)
    .sort((a, b) => a.renewalDate.localeCompare(b.renewalDate));
  const groups = [
    { label: "Next 14 days", items: upcoming.filter((s) => daysUntil(s.renewalDate) <= 14) },
    { label: "15 to 30 days", items: upcoming.filter((s) => daysUntil(s.renewalDate) > 14 && daysUntil(s.renewalDate) <= 30) },
    { label: "31 to 90 days", items: upcoming.filter((s) => daysUntil(s.renewalDate) > 30) },
  ];
  const vendor = (id: string) => subs.find((s) => s.id === id);

  return (
    <div className="grid items-start gap-6 xl:grid-cols-[1.4fr_1fr]">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Upcoming renewals</CardTitle>
            <CardDescription>Next 90 days. The owner is reminded the set number of days before.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-5">
          {loading ? (
            <ListSkeleton rows={4} />
          ) : upcoming.length === 0 ? (
            <EmptyState compact icon={<CalendarClock />} title="Nothing renews in the next 90 days" />
          ) : (
            groups
              .filter((g) => g.items.length)
              .map((g) => (
                <section key={g.label}>
                  <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{g.label}</h3>
                  <ul className="grid gap-2">
                    {g.items.map((s) => {
                      const d = daysUntil(s.renewalDate);
                      return (
                        <li key={s.id} className={cn("flex flex-wrap items-center gap-3 rounded-xl border border-border px-3 py-3", d <= s.alertDaysBefore && "border-warning/45 bg-warning/[0.06]")}>
                          <div className="grid w-14 shrink-0 place-items-center rounded-lg bg-muted py-1.5 text-center">
                            <span className="text-[17px] font-semibold leading-none tabular">{d}</span>
                            <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{d === 1 ? "day" : "days"}</span>
                          </div>
                          <div className="min-w-0 flex-1">
                            <p className="truncate text-[13.5px] font-medium">
                              {s.vendor} <span className="font-normal text-muted-foreground">· {s.product}</span>
                            </p>
                            <p className="text-[12px] text-muted-foreground">
                              {formatDate(s.renewalDate)} · {formatMoney(s.cost)} {SUB_PERIOD[s.period]} · alert {s.alertDaysBefore} days before
                            </p>
                            <div className="mt-1">
                              <EmpChip empId={s.ownerEmpId} size="sm" showId={false} />
                            </div>
                          </div>
                          {canManage && (
                            <Button size="sm" variant="outline" onClick={() => onDecide(s)}>
                              Decide
                            </Button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </section>
              ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Decision log</CardTitle>
            <CardDescription>Every renewal, change and cancellation, with who decided.</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          {decisions.isPending ? (
            <ListSkeleton rows={4} />
          ) : decisions.isError ? (
            <ErrorState error={decisions.error} onRetry={() => decisions.refetch()} />
          ) : decisions.data.length === 0 ? (
            <EmptyState compact icon={<History />} title="No decisions yet" />
          ) : (
            <Timeline
              items={decisions.data.map((d) => ({
                id: d.id,
                color: d.decision === "renewed" ? "var(--success)" : d.decision === "cancelled" ? "var(--danger)" : "var(--info)",
                title: `${vendor(d.subscriptionId)?.vendor ?? "Service"} ${d.decision}`,
                time: formatDate(d.at),
                meta: <DecisionBy empId={d.by} cost={d.newCost ? formatMoney(d.newCost) : undefined} />,
                body: d.note ? <span className="text-muted-foreground">“{d.note}”</span> : undefined,
              }))}
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function DecisionBy({ empId, cost }: { empId: string; cost?: string }) {
  const e = useEmployee(empId);
  return (
    <span>
      by {e?.name ?? empId}
      {cost ? ` · new cost ${cost}` : ""}
    </span>
  );
}

function UsageTab({ subs, loading, onReading }: { subs: Subscription[]; loading: boolean; onReading: (s: Subscription) => void }) {
  const canManage = useCan("subscriptions.manage");
  const withUsage = subs.filter((s) => s.usage && s.status !== "cancelled");
  if (loading) return <CardsSkeleton count={6} className="xl:grid-cols-3" />;
  if (!withUsage.length) return <EmptyState icon={<Activity />} title="No usage data yet" description="Usage appears when a provider has an API, or when someone adds a reading." />;
  return (
    <div className="grid gap-4">
      <p className="text-[12.5px] text-muted-foreground">
        Usage comes from the provider&apos;s API where one exists, otherwise someone types it in. Costs are marked “Estimated” when the provider doesn&apos;t give exact figures.
      </p>
      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {withUsage.map((s) => {
          const u = s.usage!;
          const pct = usagePercent(u.used, u.limit);
          const flag = usageFlag(u);
          return (
            <Card key={s.id} className={cn(flag === "near_limit" && "border-danger/40")}>
              <CardHeader className="pb-2">
                <div className="min-w-0">
                  <CardTitle className="truncate">{s.vendor}</CardTitle>
                  <CardDescription className="truncate">{u.metric}</CardDescription>
                </div>
                {flag && (
                  <Badge tone={flag === "near_limit" ? "danger" : "warning"}>
                    <TriangleAlert /> {flag === "near_limit" ? "Near limit" : "Unusual jump"}
                  </Badge>
                )}
              </CardHeader>
              <CardContent className="grid gap-3">
                <div className="flex items-end justify-between gap-3">
                  <div>
                    <p className="text-[24px] font-semibold leading-none tabular">{formatNumber(u.used)}</p>
                    <p className="mt-1 text-[12px] text-muted-foreground">
                      {u.limit ? `of ${formatNumber(u.limit)} ${u.unit ?? ""}` : `${u.unit ?? ""} · no fixed limit`}
                    </p>
                  </div>
                  {u.trend && <Sparkline values={u.trend} color={flag === "near_limit" ? "var(--danger)" : flag ? "var(--warning)" : "var(--zone-finance)"} />}
                </div>
                {pct !== undefined && (
                  <div className="grid gap-1">
                    <Progress value={u.used} max={u.limit} barClassName={pct >= 80 ? "bg-danger" : pct >= 60 ? "bg-warning" : "bg-zone-finance"} label={`${pct}% used`} />
                    <span className="text-right text-[11.5px] text-muted-foreground tabular">{pct}% used</span>
                  </div>
                )}
                <div className="flex items-center justify-between gap-2 border-t border-border pt-3 text-[12px]">
                  {u.source === "api" ? <FreshnessStamp source="From API" at={u.updatedAt} /> : <ManualStamp empId={u.enteredBy} at={u.updatedAt} />}
                  {u.estimatedCost && (
                    <span className="text-muted-foreground">
                      Estimated <Money value={u.estimatedCost} className="text-foreground" />
                    </span>
                  )}
                </div>
                {u.source === "manual" && canManage && (
                  <Button size="sm" variant="outline" onClick={() => onReading(s)}>
                    <Gauge /> Add reading
                  </Button>
                )}
              </CardContent>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function ManualStamp({ empId, at }: { empId?: string; at: string }) {
  const e = useEmployee(empId);
  return (
    <span className="text-[11.5px] text-muted-foreground">
      Manual entry · {e?.name ?? "someone"}, {formatRelative(at)}
    </span>
  );
}
