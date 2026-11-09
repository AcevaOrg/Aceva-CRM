"use client";
import * as React from "react";
import { useRouter } from "next/navigation";
import { Ban, Download, MailCheck, MailQuestion, Plus, Upload, Users } from "lucide-react";
import { Button } from "@/components/ui/button";
import { NativeSelect } from "@/components/ui/controls";
import { PageHeader } from "@/components/layout/page-header";
import { Can, RequireAccess } from "@/components/shared/can";
import { DataTable, type Column } from "@/components/shared/data-table";
import { useExport } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { StatCard } from "@/components/shared/metrics";
import { EmptyState, ErrorState } from "@/components/shared/states";
import { useUrlState } from "@/hooks/use-url-state";
import { useViewer } from "@/lib/auth/viewer";
import { formatRelative } from "@/lib/dates";
import type { LeadRow } from "../api";
import { useLeads } from "../hooks";
import { CHECK_META, SOURCE_LABEL, STAGE_META } from "../logic";
import type { EmailCheck, LeadSource } from "../types";
import { AddLeadSheet } from "./add-lead-sheet";
import { ImportLeadsDialog } from "./import-leads-dialog";
import { CheckBadge, DncBadge, SourceChip, StageBadge } from "./sales-ui";
import { VerifyEmailsDialog } from "./verify-emails-dialog";

export function LeadsScreen() {
  return (
    <RequireAccess permission="sales.own">
      <LeadsInner />
    </RequireAccess>
  );
}

function LeadsInner() {
  const router = useRouter();
  const viewer = useViewer();
  const team = !!viewer?.can(["sales.team", "sales.all"]);
  const leads = useLeads();
  const exportData = useExport();
  const [add, setAdd] = useUrlState<string>("add", "");
  const [importOpen, setImportOpen] = React.useState(false);
  const [verifyOpen, setVerifyOpen] = React.useState(false);
  const [source, setSource] = useUrlState<"" | LeadSource>("source", "");
  const [check, setCheck] = useUrlState<"" | EmailCheck>("check", "");
  const [country, setCountry] = useUrlState<string>("country", "");
  const [owner, setOwner] = useUrlState<string>("owner", "");
  const [stage, setStage] = useUrlState<string>("stage", "");

  const all = leads.data ?? [];
  const rows = all.filter(
    (l) =>
      (!source || l.source === source) &&
      (!check || l.emailCheck === check) &&
      (!country || l.country === country) &&
      (!owner || l.ownerEmpId === owner) &&
      (!stage || (stage === "none" ? !l.openDeal : l.openDeal?.stage === stage)),
  );
  const countries = [...new Set(all.map((l) => l.country).filter(Boolean))] as string[];
  const owners = [...new Set(all.map((l) => l.ownerEmpId))];
  const unchecked = all.filter((l) => l.emailCheck === "unchecked" && !l.doNotContact).length;

  const columns: Column<LeadRow>[] = [
    {
      key: "name",
      header: "Lead",
      sortValue: (l) => l.name,
      cell: (l) => (
        <div className="grid min-w-0 gap-0.5">
          <span className="flex items-center gap-2 font-medium">
            {l.name} {l.doNotContact && <Ban className="size-3.5 text-danger" aria-label="Do not contact" />}
          </span>
          <span className="truncate text-[12px] text-muted-foreground">{l.title ?? "—"}</span>
        </div>
      ),
    },
    {
      key: "company",
      header: "Company",
      sortValue: (l) => l.companyName,
      cell: (l) => (
        <div className="grid min-w-0 gap-0.5">
          <span className="truncate">{l.companyName}</span>
          <span className="truncate text-[12px] text-muted-foreground">{l.country}</span>
        </div>
      ),
    },
    { key: "source", header: "Source", sortValue: (l) => l.source, cell: (l) => <SourceChip source={l.source} />, hideOnMobile: true },
    { key: "check", header: "Email", sortValue: (l) => l.emailCheck, cell: (l) => (l.doNotContact ? <DncBadge /> : <CheckBadge check={l.emailCheck} />) },
    ...(team ? [{ key: "owner", header: "Owner", sortValue: (l: LeadRow) => l.ownerEmpId, cell: (l: LeadRow) => <EmpChip empId={l.ownerEmpId} size="sm" showId={false} link={false} />, hideOnMobile: true }] : []),
    { key: "stage", header: "Open deal", cell: (l) => (l.openDeal ? <StageBadge stage={l.openDeal.stage} /> : <span className="text-muted-foreground">—</span>), sortValue: (l) => (l.openDeal ? Object.keys(STAGE_META).indexOf(l.openDeal.stage) : -1) },
    {
      key: "last",
      header: "Last activity",
      align: "right",
      sortValue: (l) => l.lastActivityAt ?? "",
      cell: (l) => <span className="text-[12.5px] text-muted-foreground">{l.lastActivityAt ? formatRelative(l.lastActivityAt) : "—"}</span>,
      hideOnMobile: true,
    },
  ];

  return (
    <>
      <PageHeader
        title="Leads"
        description={team ? "Every lead in the sales team. Each lead has one owner and belongs to Aceva." : "Your leads. Each lead has one owner; the system blocks duplicates."}
        seal="confidential"
        actions={
          <>
            <Button variant="outline" onClick={() => setVerifyOpen(true)}>
              <MailCheck /> Verify emails{unchecked ? ` (${unchecked})` : ""}
            </Button>
            <Button variant="outline" onClick={() => setImportOpen(true)}>
              <Upload /> Import CSV
            </Button>
            <Can permission="sales.export">
              <Button variant="outline" onClick={() => exportData({ title: "Lead list", seal: "confidential", formats: ["xlsx", "csv"], rows: rows.length })}>
                <Download /> Export
              </Button>
            </Can>
            <Button onClick={() => setAdd("1")}>
              <Plus /> Add lead
            </Button>
          </>
        }
      />

      <div className="mb-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <StatCard label="Leads" value={all.length} hint={team ? "in the team" : "owned by you"} icon={<Users />} accent="var(--zone-sales)" />
        <StatCard label="Not checked yet" value={unchecked} hint="need MillionVerifier" icon={<MailQuestion />} onClick={() => setCheck("unchecked")} />
        <StatCard label="Invalid emails" value={all.filter((l) => l.emailCheck === "invalid").length} hint="can't go in a sequence" icon={<MailCheck />} onClick={() => setCheck("invalid")} />
        <StatCard label="Do not contact" value={all.filter((l) => l.doNotContact).length} hint="blocked from sequences" icon={<Ban />} />
      </div>

      {leads.isError ? (
        <ErrorState error={leads.error} onRetry={() => leads.refetch()} />
      ) : (
        <DataTable
          rows={rows}
          loading={leads.isPending}
          columns={columns}
          rowKey={(l) => l.id}
          onRowClick={(l) => router.push(`/sales/leads/${l.id}`)}
          searchable
          searchText={(l) => `${l.name} ${l.email ?? ""} ${l.companyName} ${l.domain ?? ""}`}
          searchPlaceholder="Search name, email or company"
          initialSort={{ key: "last", dir: "desc" }}
          pageSize={12}
          toolbar={
            <div className="flex flex-wrap items-center gap-2">
              <NativeSelect aria-label="Source" value={source} onChange={(e) => setSource(e.target.value as LeadSource | "")} className="w-36">
                <option value="">All sources</option>
                {(Object.keys(SOURCE_LABEL) as LeadSource[]).map((s) => (
                  <option key={s} value={s}>
                    {SOURCE_LABEL[s]}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect aria-label="Email check" value={check} onChange={(e) => setCheck(e.target.value as EmailCheck | "")} className="w-44">
                <option value="">Any email check</option>
                {(Object.keys(CHECK_META) as EmailCheck[]).map((c) => (
                  <option key={c} value={c}>
                    {CHECK_META[c].label}
                  </option>
                ))}
              </NativeSelect>
              <NativeSelect aria-label="Country" value={country} onChange={(e) => setCountry(e.target.value)} className="w-40">
                <option value="">All countries</option>
                {countries.map((c) => (
                  <option key={c}>{c}</option>
                ))}
              </NativeSelect>
              <NativeSelect aria-label="Deal stage" value={stage} onChange={(e) => setStage(e.target.value)} className="w-40">
                <option value="">Any deal stage</option>
                <option value="none">No open deal</option>
                {Object.entries(STAGE_META)
                  .filter(([k]) => k !== "lost")
                  .map(([k, m]) => (
                    <option key={k} value={k}>
                      {m.label}
                    </option>
                  ))}
              </NativeSelect>
              {team && (
                <NativeSelect aria-label="Owner" value={owner} onChange={(e) => setOwner(e.target.value)} className="w-40">
                  <option value="">All owners</option>
                  {owners.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </NativeSelect>
              )}
              {(source || check || country || owner || stage) && (
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSource("");
                    setCheck("");
                    setCountry("");
                    setOwner("");
                    setStage("");
                  }}
                >
                  Clear filters
                </Button>
              )}
            </div>
          }
          empty={
            <EmptyState
              icon={<Users />}
              title={all.length ? "No leads match these filters" : "No leads yet"}
              description={all.length ? "Clear a filter to see more." : "Add a lead or import the CSV you exported from Apollo."}
              action={!all.length ? <Button onClick={() => setAdd("1")}><Plus /> Add lead</Button> : undefined}
            />
          }
        />
      )}

      <AddLeadSheet open={add === "1"} onOpenChange={(o) => setAdd(o ? "1" : "")} />
      {importOpen && <ImportLeadsDialog open onOpenChange={setImportOpen} />}
      {verifyOpen && <VerifyEmailsDialog open onOpenChange={setVerifyOpen} />}
    </>
  );
}
