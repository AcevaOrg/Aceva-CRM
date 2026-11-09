"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { CalendarSearch } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SegmentedControl } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { DataTable } from "@/components/shared/data-table";
import { chartPalette, EChart } from "@/components/shared/echart";
import { EmpChip } from "@/components/shared/emp-chip";
import { EmptyState } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { useUrlState } from "@/hooks/use-url-state";
import { formatTime, isoDay } from "@/lib/dates";
import { minutesToHours } from "@/lib/format";
import { useDailySummaries } from "../hooks";

interface Row {
  empId: string;
  days: number;
  firstLogin?: string;
  lastLogout?: string;
  active: number;
  idle: number;
  actions: number;
}

/** Daily and weekly login/active-hours report per person (plan §8). */
export function ReportsPanel() {
  const router = useRouter();
  const lookup = useLookup();
  const [range, setRange] = useUrlState<"day" | "week">("range", "day");
  const [date, setDate] = React.useState(isoDay(new Date()));
  const from = React.useMemo(() => {
    if (range === "day") return date;
    const d = new Date(`${date}T12:00`);
    d.setDate(d.getDate() - 6);
    return isoDay(d);
  }, [range, date]);
  const query = useDailySummaries(from, date);

  const rows: Row[] = React.useMemo(() => {
    const map = new Map<string, Row>();
    (query.data ?? []).forEach((s) => {
      const r = map.get(s.empId) ?? { empId: s.empId, days: 0, active: 0, idle: 0, actions: 0 };
      r.days += 1;
      r.active += s.activeMinutes;
      r.idle += s.idleMinutes;
      r.actions += s.actions;
      if (s.firstLogin && (!r.firstLogin || s.firstLogin < r.firstLogin)) r.firstLogin = s.firstLogin;
      if (s.lastLogout && (!r.lastLogout || s.lastLogout > r.lastLogout)) r.lastLogout = s.lastLogout;
      map.set(s.empId, r);
    });
    return [...map.values()].sort((a, b) => (lookup.employee(a.empId)?.name ?? "").localeCompare(lookup.employee(b.empId)?.name ?? ""));
  }, [query.data, lookup]);

  const option = React.useMemo(
    () => ({
      tooltip: { trigger: "axis", axisPointer: { type: "shadow" } },
      legend: { data: ["Active", "Idle"] },
      xAxis: { type: "category", data: rows.map((r) => lookup.employee(r.empId)?.name.split(" ")[0] ?? r.empId), axisLabel: { interval: 0, rotate: rows.length > 8 ? 30 : 0 } },
      yAxis: { type: "value", name: "hours", nameTextStyle: { fontSize: 11 } },
      series: [
        { name: "Active", type: "bar", stack: "t", data: rows.map((r) => +(r.active / 60).toFixed(1)), itemStyle: { borderRadius: [0, 0, 0, 0] }, barMaxWidth: 34 },
        { name: "Idle", type: "bar", stack: "t", data: rows.map((r) => +(r.idle / 60).toFixed(1)), itemStyle: { borderRadius: [4, 4, 0, 0], color: chartPalette()[2] }, barMaxWidth: 34 },
      ],
    }),
    [rows, lookup],
  );

  return (
    <div className="grid gap-5">
      <div className="flex flex-wrap items-end gap-3">
        <SegmentedControl
          value={range}
          onChange={setRange}
          ariaLabel="Report range"
          options={[
            { value: "day", label: "Daily" },
            { value: "week", label: "Last 7 days" },
          ]}
        />
        <Field label={range === "day" ? "Day" : "Ending on"} htmlFor="r-date">
          <Input id="r-date" type="date" value={date} max={isoDay(new Date())} onChange={(e) => setDate(e.target.value || isoDay(new Date()))} />
        </Field>
        <p className="pb-2 text-[12.5px] text-muted-foreground">Your team only. Click a row to open that person&apos;s timeline.</p>
      </div>

      {!query.isPending && rows.length === 0 ? (
        <EmptyState icon={<CalendarSearch />} title="No activity for these dates" description="Weekends and holidays have no data. Try another day." />
      ) : (
        <>
          <Card>
            <CardHeader>
              <CardTitle>Active and idle hours</CardTitle>
            </CardHeader>
            <CardContent>
              <EChart option={option} height={260} ariaLabel="Active and idle hours per person" />
            </CardContent>
          </Card>
          <DataTable<Row>
            rows={rows}
            loading={query.isPending}
            rowKey={(r) => r.empId}
            onRowClick={(r) => router.push(`/activity?tab=timeline&emp=${r.empId}&date=${date}`)}
            columns={[
              { key: "who", header: "Person", cell: (r) => <EmpChip empId={r.empId} size="sm" link={false} />, sortValue: (r) => lookup.employee(r.empId)?.name ?? "" },
              { key: "dept", header: "Team", cell: (r) => lookup.department(lookup.employee(r.empId)?.departmentId)?.name, hideOnMobile: true },
              ...(range === "week" ? [{ key: "days", header: "Days", align: "right" as const, cell: (r: Row) => <span className="tabular">{r.days}</span>, sortValue: (r: Row) => r.days }] : []),
              { key: "first", header: range === "day" ? "First login" : "Earliest login", cell: (r) => <span className="font-mono tabular">{r.firstLogin ? formatTime(r.firstLogin) : "—"}</span>, sortValue: (r) => r.firstLogin ?? "" },
              { key: "last", header: range === "day" ? "Last logout" : "Latest logout", cell: (r) => <span className="font-mono tabular">{r.lastLogout ? formatTime(r.lastLogout) : "Signed in"}</span>, sortValue: (r) => r.lastLogout ?? "", hideOnMobile: true },
              { key: "active", header: "Active", align: "right", cell: (r) => <span className="font-mono tabular">{minutesToHours(r.active)}</span>, sortValue: (r) => r.active },
              { key: "idle", header: "Idle", align: "right", cell: (r) => <span className="font-mono tabular text-muted-foreground">{minutesToHours(r.idle)}</span>, sortValue: (r) => r.idle },
              { key: "actions", header: "Actions", align: "right", cell: (r) => <span className="font-mono tabular">{r.actions}</span>, sortValue: (r) => r.actions },
            ]}
          />
        </>
      )}
    </div>
  );
}
