"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Ban, Briefcase, ChevronRight, Lock, MailCheck, NotebookPen, Plus, UserCog } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { SegmentedControl } from "@/components/ui/controls";
import { Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { PageHeader } from "@/components/layout/page-header";
import { RequireAccess } from "@/components/shared/can";
import { useReason } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { DetailList, EmployeeSelect } from "@/components/shared/pickers";
import { EmptyState, ErrorState } from "@/components/shared/states";
import { Timeline } from "@/components/shared/timeline";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate, formatDateTime } from "@/lib/dates";
import { useLead, useMarkDnc, useReassignLead, useUpdateLead } from "../hooks";
import { SERVICE_LABEL } from "../logic";
import type { LeadDetail as Detail } from "../types";
import { CreateDealSheet, LogActivityDialog } from "./lead-actions";
import { ACTIVITY_COLOR, ACTIVITY_ICON, activityLabel, CheckBadge, DealValue, DncBadge, SourceChip, SourceTag, StageBadge } from "./sales-ui";
import { VerifyEmailsDialog } from "./verify-emails-dialog";

export function LeadDetailScreen({ id }: { id: string }) {
  return (
    <RequireAccess permission="sales.own">
      <LeadDetailInner id={id} />
    </RequireAccess>
  );
}

function LeadDetailInner({ id }: { id: string }) {
  const q = useLead(id);
  const back = { href: "/sales/leads", label: "Leads" };
  if (q.isPending)
    return (
      <div className="grid gap-4 pt-6">
        <Skeleton className="h-24" />
        <Skeleton className="h-80" />
      </div>
    );
  if (q.isError)
    return (
      <>
        <PageHeader title="Lead" back={back} />
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      </>
    );
  const data = q.data;
  if ("restricted" in data)
    return (
      <>
        <PageHeader title={data.name} description={data.companyName} back={back} seal="confidential" />
        <EmptyState
          icon={<Lock />}
          title="This lead belongs to someone else"
          description={
            <span className="grid justify-items-center gap-3">
              You can see that it exists and who owns it, but not the notes, activity or deal values. Ask the owner or the sales manager if you need to work with it.
              <EmpChip empId={data.ownerEmpId} />
            </span>
          }
        />
      </>
    );
  return <LeadBody d={data} />;
}

function LeadBody({ d }: { d: Detail }) {
  const { lead, company, activities, deals } = d;
  const viewer = useViewer();
  const team = !!viewer?.can(["sales.team", "sales.all"]);
  const [logOpen, setLogOpen] = React.useState(false);
  const [dealOpen, setDealOpen] = React.useState(false);
  const [verifyOpen, setVerifyOpen] = React.useState(false);
  const [filter, setFilter] = React.useState<"all" | "auto" | "manual">("all");
  const askReason = useReason();
  const markDnc = useMarkDnc();
  const reassign = useReassignLead();

  const shown = activities.filter((a) => filter === "all" || (filter === "manual" ? a.source === "manual" : a.source !== "manual"));

  return (
    <>
      <PageHeader
        title={lead.name}
        description={`${lead.title ? `${lead.title} at ` : ""}${company.name}`}
        back={{ href: "/sales/leads", label: "Leads" }}
        seal="confidential"
        meta={
          <>
            <SourceChip source={lead.source} />
            {lead.doNotContact ? <DncBadge /> : <CheckBadge check={lead.emailCheck} />}
            <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
              Owner <EmpChip empId={lead.ownerEmpId} size="sm" showId={false} />
            </span>
          </>
        }
        actions={
          <>
            {lead.emailCheck === "unchecked" && !lead.doNotContact && (
              <Button variant="outline" onClick={() => setVerifyOpen(true)}>
                <MailCheck /> Verify email
              </Button>
            )}
            {!lead.doNotContact && (
              <Button
                variant="outline"
                onClick={async () => {
                  const reason = await askReason({
                    title: "Mark as do not contact",
                    description: "The email is blocked from every future sequence. This can't be undone from here.",
                    options: ["Unsubscribed from an email", "Asked by phone or message", "Complaint", "Other"],
                    confirmLabel: "Mark do not contact",
                    destructive: true,
                  });
                  if (reason) markDnc.mutate({ id: lead.id, reason }, { onSuccess: () => toast.success("Marked as do not contact") });
                }}
              >
                <Ban /> Do not contact
              </Button>
            )}
            <Button variant="outline" onClick={() => setLogOpen(true)}>
              <NotebookPen /> Log activity
            </Button>
            <Button onClick={() => setDealOpen(true)} disabled={lead.doNotContact}>
              <Plus /> Create deal
            </Button>
          </>
        }
      />

      <div className="grid gap-5 lg:grid-cols-[minmax(0,1fr)_360px]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Activity</CardTitle>
              <p className="text-[12.5px] text-muted-foreground">Every contact in time order. Auto items come from the connected tools.</p>
            </div>
            <SegmentedControl
              size="sm"
              value={filter}
              onChange={setFilter}
              options={[
                { value: "all", label: "All" },
                { value: "auto", label: "Auto" },
                { value: "manual", label: "Manual" },
              ]}
            />
          </CardHeader>
          <CardContent>
            {shown.length ? (
              <Timeline
                items={shown.map((a) => ({
                  id: a.id,
                  icon: ACTIVITY_ICON[a.kind],
                  color: ACTIVITY_COLOR[a.kind],
                  title: (
                    <span className="flex flex-wrap items-center gap-2">
                      {activityLabel(a.kind)} <SourceTag source={a.source} />
                    </span>
                  ),
                  time: formatDateTime(a.at),
                  body: <span className="text-muted-foreground">{a.summary}</span>,
                  meta: <EmpChip empId={a.empId} size="sm" showId={false} link={false} className="mt-1" />,
                }))}
              />
            ) : (
              <EmptyState compact title="No activity yet" description="Emails from Apollo appear here within 15 minutes." />
            )}
          </CardContent>
        </Card>

        <div className="grid content-start gap-5">
          <Card>
            <CardHeader>
              <CardTitle>Deals</CardTitle>
              <Button size="sm" variant="ghost" onClick={() => setDealOpen(true)} disabled={lead.doNotContact}>
                <Plus /> New
              </Button>
            </CardHeader>
            <CardContent>
              {deals.length ? (
                <ul className="grid gap-2">
                  {deals.map((deal) => (
                    <li key={deal.id}>
                      <Link href={`/sales/deals/${deal.id}`} className="flex items-center gap-3 rounded-lg border border-border px-3 py-2.5 transition hover:bg-muted">
                        <Briefcase className="size-4 shrink-0 text-muted-foreground" />
                        <span className="grid min-w-0 flex-1 gap-1">
                          <span className="flex items-center justify-between gap-2 text-[13px] font-medium">
                            <span className="truncate">
                              <span className="font-mono text-muted-foreground">{deal.number}</span> · {SERVICE_LABEL[deal.service]}
                            </span>
                            <DealValue value={deal.value} className="text-[12.5px]" />
                          </span>
                          <StageBadge stage={deal.stage} pending={deal.wonStatus === "pending"} />
                        </span>
                        <ChevronRight className="size-4 text-muted-foreground" />
                      </Link>
                    </li>
                  ))}
                </ul>
              ) : (
                <p className="text-[13px] text-muted-foreground">No deals yet. Create one when the lead shows interest.</p>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Contact</CardTitle>
            </CardHeader>
            <CardContent>
              <DetailList
                items={[
                  ["Email", lead.email ? <span className="break-all font-mono text-[12.5px]">{lead.email}</span> : null],
                  ["Phone", lead.phone ? <span className="font-mono text-[12.5px]">{lead.phone}</span> : null],
                  ["LinkedIn", lead.linkedinUrl ?? null],
                  ["Company", company.name],
                  ["Website", company.domain ?? null],
                  ["Country", lead.country ?? null],
                  ["Industry", lead.industry ?? null],
                  ["Email check", lead.checkedAt ? `${lead.emailCheck.replace("_", "-")} · ${formatDate(lead.checkedAt)}` : "Not checked"],
                  ["Added", formatDate(lead.createdAt)],
                ]}
                columns={2}
              />
            </CardContent>
          </Card>

          <NotesCard leadId={lead.id} notes={lead.notes} />

          {team && (
            <Card>
              <CardHeader>
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <UserCog className="size-4 text-muted-foreground" /> Owner
                  </CardTitle>
                  <p className="text-[12.5px] text-muted-foreground">Leads belong to Aceva. Moving a lead moves its open deals too.</p>
                </div>
              </CardHeader>
              <CardContent>
                <EmployeeSelect
                  value={lead.ownerEmpId}
                  filter={(e) => e.departmentId === "dep-sales"}
                  onChange={(empId) => empId && empId !== lead.ownerEmpId && reassign.mutate({ id: lead.id, empId }, { onSuccess: () => toast.success("Lead moved", { description: "Open deals moved with it." }) })}
                />
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {logOpen && <LogActivityDialog open onOpenChange={setLogOpen} leadId={lead.id} deals={deals} />}
      <CreateDealSheet open={dealOpen} onOpenChange={setDealOpen} leadId={lead.id} leadName={lead.name} defaultCurrency={lead.country === "Pakistan" ? "PKR" : "USD"} />
      {verifyOpen && <VerifyEmailsDialog open onOpenChange={setVerifyOpen} />}
    </>
  );
}

function NotesCard({ leadId, notes }: { leadId: string; notes?: string }) {
  const [editing, setEditing] = React.useState(false);
  const [text, setText] = React.useState(notes ?? "");
  const update = useUpdateLead();
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Notes</CardTitle>
          <p className="text-[12.5px] text-muted-foreground">Only the owner and the sales manager can read these.</p>
        </div>
        {!editing && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setText(notes ?? "");
              setEditing(true);
            }}
          >
            Edit
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {editing ? (
          <div className="grid gap-2">
            <Textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} />
            <div className="flex justify-end gap-2">
              <Button size="sm" variant="outline" onClick={() => { setText(notes ?? ""); setEditing(false); }}>
                Cancel
              </Button>
              <Button size="sm" loading={update.isPending} onClick={() => update.mutate({ id: leadId, notes: text }, { onSuccess: () => { setEditing(false); toast.success("Notes saved"); } })}>
                Save
              </Button>
            </div>
          </div>
        ) : notes ? (
          <p className="whitespace-pre-wrap text-[13px]">{notes}</p>
        ) : (
          <p className="text-[13px] text-muted-foreground">No notes yet.</p>
        )}
      </CardContent>
    </Card>
  );
}
