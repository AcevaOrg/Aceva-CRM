"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { LayoutGrid, List, MapPin, Search, UserPlus, Users, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NativeSelect, SegmentedControl } from "@/components/ui/controls";
import { Input } from "@/components/ui/input";
import { Avatar } from "@/components/ui/misc";
import { Tip } from "@/components/ui/overlays";
import { PageHeader } from "@/components/layout/page-header";
import { StatusBadge } from "@/components/shared/chips";
import { DataTable } from "@/components/shared/data-table";
import { EmpChip } from "@/components/shared/emp-chip";
import { LevelMark } from "@/components/shared/level-mark";
import { CardsSkeleton, EmptyState, ErrorState } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { useUrlState } from "@/hooks/use-url-state";
import { LEVEL_LABEL } from "@/lib/auth/permissions";
import { useCan } from "@/lib/auth/viewer";
import { formatDate } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { Employee } from "@/types";
import { usePeople, usePresence } from "../hooks";
import { STATUS_INFO, TYPE_LABEL } from "../logic";

type View = "grid" | "list";
type StatusFilter = "current" | "active" | "on_notice" | "left";

/** /people: staff directory (spec §9.3). Basic fields are visible to everyone. */
export function PeopleDirectory() {
  const router = useRouter();
  const query = usePeople();
  const presence = usePresence();
  const lookup = useLookup();
  const canAdd = useCan("people.manage");
  const [view, setView] = useUrlState<View>("view", "grid");
  const [q, setQ] = React.useState("");
  const [dept, setDept] = React.useState("");
  const [office, setOffice] = React.useState("");
  const [level, setLevel] = React.useState("");
  const [type, setType] = React.useState("");
  const [status, setStatus] = React.useState<StatusFilter>("current");

  const online = new Map((presence.data ?? []).map((p) => [p.empId, p.state]));

  const rows = (query.data ?? []).filter((e) => {
    const needle = q.trim().toLowerCase();
    if (needle && !`${e.name} ${e.empId} ${e.designation}`.toLowerCase().includes(needle)) return false;
    if (dept && e.departmentId !== dept) return false;
    if (office && e.officeId !== office) return false;
    if (level && e.level !== Number(level)) return false;
    if (type && e.type !== type) return false;
    if (status === "current") return e.status !== "left";
    return e.status === status;
  });

  const filtersOn = !!(q || dept || office || level || type || status !== "current");
  const clear = () => {
    setQ("");
    setDept("");
    setOffice("");
    setLevel("");
    setType("");
    setStatus("current");
  };

  return (
    <>
      <PageHeader
        title="People"
        description={`Everyone at Aceva. Basic details are visible to all staff; personal and pay details follow the hierarchy.${canAdd ? "" : " The Director (HR duty) adds and offboards employees."}`}
        seal="internal"
        actions={
          canAdd && (
            <Button asChild>
              <Link href="/people/new">
                <UserPlus /> Add employee
              </Link>
            </Button>
          )
        }
      />

      <div className="mb-5 grid gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="relative w-full sm:w-72">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, Emp-ID or role" className="pl-8" aria-label="Search people" />
          </div>
          <NativeSelect value={dept} onChange={(e) => setDept(e.target.value)} className="w-[calc(50%-4px)] sm:w-44" aria-label="Department">
            <option value="">All departments</option>
            {lookup.departments.map((d) => (
              <option key={d.id} value={d.id}>{d.name}</option>
            ))}
          </NativeSelect>
          <NativeSelect value={office} onChange={(e) => setOffice(e.target.value)} className="w-[calc(50%-4px)] sm:w-40" aria-label="Office">
            <option value="">All offices</option>
            {lookup.offices.map((o) => (
              <option key={o.id} value={o.id}>{o.name}</option>
            ))}
          </NativeSelect>
          <NativeSelect value={level} onChange={(e) => setLevel(e.target.value)} className="w-[calc(50%-4px)] sm:w-40" aria-label="Level">
            <option value="">All levels</option>
            {[1, 2, 3, 4, 5].map((l) => (
              <option key={l} value={l}>L{l} · {LEVEL_LABEL[l]}</option>
            ))}
          </NativeSelect>
          <NativeSelect value={type} onChange={(e) => setType(e.target.value)} className="w-[calc(50%-4px)] sm:w-36" aria-label="Type">
            <option value="">All types</option>
            {Object.entries(TYPE_LABEL).map(([k, v]) => (
              <option key={k} value={k}>{v}</option>
            ))}
          </NativeSelect>
          <NativeSelect value={status} onChange={(e) => setStatus(e.target.value as StatusFilter)} className="w-[calc(50%-4px)] sm:w-40" aria-label="Status">
            <option value="current">Current staff</option>
            <option value="active">Active</option>
            <option value="on_notice">On notice</option>
            <option value="left">Left</option>
          </NativeSelect>
          {filtersOn && (
            <Button variant="ghost" size="sm" onClick={clear}>
              <X /> Clear
            </Button>
          )}
          <SegmentedControl
            className="ml-auto"
            value={view}
            onChange={setView}
            ariaLabel="View"
            options={[
              { value: "grid", label: <><LayoutGrid /> <span className="sr-only sm:not-sr-only">Cards</span></> },
              { value: "list", label: <><List /> <span className="sr-only sm:not-sr-only">List</span></> },
            ]}
          />
        </div>
        <p className="text-[12.5px] text-muted-foreground" aria-live="polite">
          {query.data ? `${rows.length} ${rows.length === 1 ? "person" : "people"}` : " "}
        </p>
      </div>

      {query.isError ? (
        <ErrorState error={query.error} onRetry={() => query.refetch()} />
      ) : query.isPending ? (
        <CardsSkeleton count={8} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Users />} title="No one matches" description="Try a different search or clear the filters." action={<Button variant="outline" onClick={clear}>Clear filters</Button>} />
      ) : view === "grid" ? (
        <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 2xl:grid-cols-4">
          {rows.map((e) => (
            <li key={e.empId}>
              <PersonCard e={e} state={online.get(e.empId)} />
            </li>
          ))}
        </ul>
      ) : (
        <DataTable<Employee>
          rows={rows}
          rowKey={(e) => e.empId}
          onRowClick={(e) => router.push(`/people/${e.empId}`)}
          pageSize={20}
          columns={[
            { key: "name", header: "Name", cell: (e) => <EmpChip empId={e.empId} link={false} />, sortValue: (e) => e.name },
            { key: "designation", header: "Designation", cell: (e) => e.designation, sortValue: (e) => e.designation },
            { key: "dept", header: "Department", cell: (e) => lookup.department(e.departmentId)?.name, sortValue: (e) => lookup.department(e.departmentId)?.name ?? "" },
            { key: "office", header: "Office", cell: (e) => lookup.office(e.officeId)?.name, hideOnMobile: true },
            { key: "level", header: "Level", cell: (e) => <LevelMark level={e.level} showLabel />, sortValue: (e) => e.level, hideOnMobile: true },
            { key: "type", header: "Type", cell: (e) => TYPE_LABEL[e.type], hideOnMobile: true },
            { key: "status", header: "Status", cell: (e) => <StatusBadge {...STATUS_INFO[e.status]} /> },
            { key: "joined", header: "Joined", cell: (e) => formatDate(e.joiningDate), sortValue: (e) => e.joiningDate, hideOnMobile: true },
          ]}
        />
      )}
    </>
  );
}

function PersonCard({ e, state }: { e: Employee; state?: "active" | "idle" }) {
  const lookup = useLookup();
  const dept = lookup.department(e.departmentId);
  const office = lookup.office(e.officeId);
  return (
    <Link href={`/people/${e.empId}`} className="group block h-full rounded-xl outline-offset-2">
      <Card className={cn("relative h-full overflow-hidden p-5 transition group-hover:-translate-y-0.5 group-hover:shadow-float", e.status === "left" && "opacity-70")}>
        <span className="absolute inset-x-0 top-0 h-1" style={{ background: dept?.color ?? "var(--muted)" }} aria-hidden />
        <div className="flex items-start gap-3">
          <span className="relative">
            <Avatar name={e.name} hue={e.avatarHue} size={48} />
            {state && (
              <Tip content={state === "active" ? "Signed in, active" : "Signed in, idle"}>
                <span
                  className={cn("absolute -bottom-0.5 -right-0.5 size-3.5 rounded-full border-2 border-card", state === "active" ? "bg-signal" : "bg-warning")}
                  aria-label={state === "active" ? "Online" : "Idle"}
                />
              </Tip>
            )}
          </span>
          <div className="min-w-0 flex-1">
            <p className="truncate font-semibold group-hover:underline">{e.name}</p>
            <p className="truncate text-[12.5px] text-muted-foreground">{e.designation}</p>
            <p className="mt-0.5 font-mono text-[11.5px] text-muted-foreground">{e.empId}</p>
          </div>
          <LevelMark level={e.level} />
        </div>
        <div className="mt-4 flex flex-wrap items-center gap-1.5 text-[11.5px]">
          <span className="rounded-full border border-border px-2 py-0.5 font-medium">{dept?.name}</span>
          <span className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-muted-foreground">
            <MapPin className="size-3" /> {office?.name}
          </span>
          {e.type !== "full_time" && <span className="rounded-full bg-muted px-2 py-0.5 text-muted-foreground">{TYPE_LABEL[e.type]}</span>}
          {e.status !== "active" && <StatusBadge {...STATUS_INFO[e.status]} />}
        </div>
      </Card>
    </Link>
  );
}
