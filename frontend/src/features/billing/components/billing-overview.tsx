"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { AlarmClock, ArrowRight, Banknote, CalendarClock, HandCoins, Receipt, Repeat, Sparkles, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/controls";
import { DeadlineChip } from "@/components/shared/chips";
import { EmpChip } from "@/components/shared/emp-chip";
import { EChart } from "@/components/shared/echart";
import { StatCard } from "@/components/shared/metrics";
import { Money } from "@/components/shared/money";
import { CardsSkeleton, EmptyState, ErrorState } from "@/components/shared/states";
import { ApiError } from "@/lib/api/mock";
import { formatMonthKey } from "@/lib/dates";
import { useCan } from "@/lib/auth/viewer";
import { useBillingOverview, useCustomerList, useResolveDealHandover } from "../hooks";
import { Countdown } from "./bits";
import type { DealHandover, Invoice } from "../types";

function InvoiceRow({ inv, customerName }: { inv: Invoice; customerName: string }) {
  return (
    <Link href={`/billing/invoices/${inv.id}`} className="flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-muted">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-medium">{customerName}</p>
        <p className="font-mono text-[11.5px] text-muted-foreground">{inv.number}</p>
      </div>
      <div className="grid justify-items-end gap-1">
        <Money value={inv.balance} className="text-[13px]" />
        <DeadlineChip deadline={inv.dueDate} />
      </div>
    </Link>
  );
}

/** A Won deal whose client name matched several clients: Finance chooses which one (review decision 5). */
function HandoverRow({ h, canManage }: { h: DealHandover; canManage: boolean }) {
  const resolve = useResolveDealHandover();
  const [partyId, setPartyId] = React.useState("");
  const run = async () => {
    try {
      await resolve.mutateAsync({ id: h.id, partyId });
      toast.success(`${h.dealNumber}: draft invoice created`, { description: "Check it and issue it." });
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't choose the client.");
    }
  };
  return (
    <li className="flex flex-wrap items-center gap-3 rounded-lg border border-border px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="text-[13px] font-medium">
          {h.dealNumber} · {h.clientName} · <Money value={h.value} />
        </p>
        <p className="text-[12px] text-muted-foreground">{h.candidates.length} clients have exactly this name. Choose the right one; nothing is picked for you.</p>
      </div>
      {canManage && (
        <div className="flex items-center gap-2">
          <NativeSelect aria-label={`Client for ${h.dealNumber}`} value={partyId} onChange={(e) => setPartyId(e.target.value)}>
            <option value="">Choose the client</option>
            {h.candidates.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.email ? ` · ${c.email}` : ""}
                {c.country ? ` · ${c.country}` : ""}
              </option>
            ))}
          </NativeSelect>
          <Button size="sm" onClick={run} disabled={!partyId} loading={resolve.isPending}>
            Create draft
          </Button>
        </div>
      )}
    </li>
  );
}

export function BillingOverviewPanel() {
  const q = useBillingOverview();
  const customers = useCustomerList();
  const router = useRouter();
  const canManage = useCan("billing.manage");
  const name = (id: string) => customers.data?.find((c) => c.id === id)?.name ?? "Customer";

  if (q.isPending) return <CardsSkeleton />;
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const o = q.data;

  const chart = {
    xAxis: { type: "category", data: o.history.map((h) => formatMonthKey(h.month).split(" ")[0].slice(0, 3)) },
    yAxis: { type: "value", axisLabel: { formatter: (v: number) => `${v / 1_000_000}M` } },
    series: [
      { name: "Billed", type: "bar", barMaxWidth: 22, itemStyle: { borderRadius: [4, 4, 0, 0] }, data: o.history.map((h) => Math.round(h.billed)) },
      { name: "Collected", type: "bar", barMaxWidth: 22, itemStyle: { borderRadius: [4, 4, 0, 0] }, data: o.history.map((h) => Math.round(h.collected)) },
    ],
  };

  return (
    <div className="grid gap-6">
      {(o.dealsNeedingClient?.length ?? 0) > 0 && (
        <Card className="border-warning/45">
          <CardHeader>
            <div>
              <CardTitle className="flex items-center gap-2">
                <Users className="size-4" /> Won deals waiting for their client
              </CardTitle>
              <CardDescription>Several clients have the same name as the deal&apos;s client. The draft invoice is made once the right client is chosen.</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <ul className="grid gap-2">
              {o.dealsNeedingClient!.map((h) => (
                <HandoverRow key={h.id} h={h} canManage={canManage} />
              ))}
            </ul>
          </CardContent>
        </Card>
      )}
      {o.draftsFromSales.length > 0 && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border border-zone-sales/35 bg-zone-sales/10 px-4 py-3">
          <span className="grid size-9 place-content-center rounded-lg bg-zone-sales/20 text-foreground">
            <Sparkles className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-semibold">
              From sales: {o.draftsFromSales.length} draft invoice{o.draftsFromSales.length === 1 ? "" : "s"} to check
            </p>
            <p className="text-[12.5px] text-muted-foreground">Created automatically when a deal was marked Won. Check the scope and amount, then issue it.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {o.draftsFromSales.map((d) => (
              <Button key={d.id} size="sm" variant="outline" asChild>
                <Link href={`/billing/invoices/${d.id}`}>
                  {d.source?.dealNumber} · <Money value={d.total} />
                </Link>
              </Button>
            ))}
          </div>
        </div>
      )}

      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Billed this month" value={<Money value={o.billedThisMonth} compact />} icon={<Receipt />} accent="var(--zone-finance)" hint="All currencies, in PKR" />
        <StatCard label="Collected this month" value={<Money value={o.collectedThisMonth} compact />} icon={<HandCoins />} accent="var(--success)" hint={o.usdRate ? `USD at ${o.usdRate} PKR` : "USD at each invoice's own rate"} />
        <StatCard label="Outstanding" value={<Money value={o.outstanding} compact />} icon={<Banknote />} accent="var(--info)" hint="Sent, part paid and overdue" onClick={() => router.push("/billing?tab=invoices")} />
        <StatCard
          label="Overdue"
          value={<span className={o.overdueCount ? "text-danger" : undefined}>{o.overdueCount}</span>}
          icon={<AlarmClock />}
          accent="var(--danger)"
          hint={<Money value={o.overdueAmount} compact />}
          onClick={() => router.push("/billing?tab=invoices&status=overdue")}
        />
      </div>

      <div className="grid gap-4 xl:grid-cols-[1.4fr_1fr]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Billed and collected</CardTitle>
              <CardDescription>Last 6 months, PKR (USD converted at the saved rate)</CardDescription>
            </div>
          </CardHeader>
          <CardContent>
            <EChart option={chart} height={250} ariaLabel="Billed and collected by month" />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Needs attention</CardTitle>
              <CardDescription>Overdue first, then due in the next 14 days</CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid gap-1">
            {o.overdue.length === 0 && o.upcomingDue.length === 0 ? (
              <EmptyState compact icon={<CalendarClock />} title="Nothing due soon" description="No invoices are overdue or due in the next 14 days." />
            ) : (
              <>
                {o.overdue.map((inv) => (
                  <InvoiceRow key={inv.id} inv={inv} customerName={name(inv.customerId)} />
                ))}
                {o.upcomingDue.map((inv) => (
                  <InvoiceRow key={inv.id} inv={inv} customerName={name(inv.customerId)} />
                ))}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader>
          <div>
            <CardTitle>Renewals in the next 14 days</CardTitle>
            <CardDescription>Aceva&apos;s own tools and services. The owner is reminded before each one renews.</CardDescription>
          </div>
          <Button variant="ghost" size="sm" asChild>
            <Link href="/billing/subscriptions?tab=renewals">
              All renewals <ArrowRight />
            </Link>
          </Button>
        </CardHeader>
        <CardContent>
          {o.renewalsSoon.length === 0 ? (
            <EmptyState compact icon={<Repeat />} title="No renewals in the next 14 days" />
          ) : (
            <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
              {o.renewalsSoon.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-3 rounded-lg border border-border px-3 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-[13px] font-medium">{s.vendor}</p>
                    <p className="truncate text-[12px] text-muted-foreground">{s.product}</p>
                    <div className="mt-1">
                      <EmpChip empId={s.ownerEmpId} size="sm" showId={false} />
                    </div>
                  </div>
                  <div className="grid justify-items-end gap-1">
                    <Countdown date={s.renewalDate} alertDays={s.alertDaysBefore} />
                    <Money value={s.cost} className="text-[12.5px]" />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>

      {!canManage && (
        <p className="text-[12.5px] text-muted-foreground">View only. The finance person creates invoices and records payments.</p>
      )}
    </div>
  );
}
