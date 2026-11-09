"use client";
import * as React from "react";
import Link from "next/link";
import { ArrowRight, CircleCheck, NotebookPen, Reply, Sunrise, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect } from "@/components/ui/controls";
import { Skeleton } from "@/components/ui/misc";
import { PageHeader } from "@/components/layout/page-header";
import { RequireAccess } from "@/components/shared/can";
import { FreshnessStamp } from "@/components/shared/chips";
import { ProgressRing } from "@/components/shared/metrics";
import { EmptyState, ErrorState } from "@/components/shared/states";
import { useUrlState } from "@/hooks/use-url-state";
import { useLookup } from "@/hooks/use-directory";
import { useViewer } from "@/lib/auth/viewer";
import { formatRelative, formatWeekdayLong } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { canWorkOn } from "../api";
import { useMySalesDay, useSalesPeople } from "../hooks";
import { emailsSentTotal, followUpsTotal, leadsAddedTotal, selfReportedTotal, STAGE_META, targetsMet } from "../logic";
import type { FollowUp, MySalesDay as Day } from "../types";
import { DailyLogSheet } from "./daily-log-sheet";
import { FollowUpDialog } from "./follow-up-dialog";
import { FollowUpDue, SELF_REPORTED_FIELDS } from "./sales-ui";

export function MySalesDayScreen() {
  return (
    <RequireAccess permission="sales.own">
      <MySalesDayInner />
    </RequireAccess>
  );
}

function MySalesDayInner() {
  const viewer = useViewer();
  const [person, setPerson] = useUrlState<string>("person", "");
  const [log, setLog] = useUrlState<string>("log", "");
  const people = useSalesPeople();
  const day = useMySalesDay(person || undefined);
  const lookup = useLookup();
  const isMe = day.data?.empId === viewer?.employee.empId;

  return (
    <>
      <PageHeader
        title={isMe || !day.data ? "My sales day" : `${lookup.employee(day.data.empId)?.name.split(" ")[0] ?? ""}'s sales day`}
        description={`${formatWeekdayLong(new Date())}. Targets, follow-ups and replies in one place. Tool numbers update every 15 to 30 minutes.`}
        meta={day.data && <FreshnessStamp source="Apollo" at={day.data.apolloLastSyncAt} />}
        actions={
          <>
            {(people.data?.length ?? 0) > 1 && (
              <label className="flex items-center gap-2 text-[12.5px] text-muted-foreground">
                <Users className="size-4" />
                <span className="sr-only sm:not-sr-only">Showing</span>
                <NativeSelect value={day.data?.empId ?? ""} onChange={(e) => setPerson(e.target.value)} className="w-44">
                  {people.data!.map((id) => (
                    <option key={id} value={id}>
                      {lookup.employee(id)?.name ?? id}
                    </option>
                  ))}
                </NativeSelect>
              </label>
            )}
            {isMe && (
              <Button onClick={() => setLog("1")}>
                <NotebookPen /> {day.data?.log ? "Edit my log" : "Log my day"}
              </Button>
            )}
          </>
        }
      />
      {day.isPending ? (
        <DaySkeleton />
      ) : day.isError ? (
        <ErrorState error={day.error} onRetry={() => day.refetch()} />
      ) : !day.data ? (
        <EmptyState icon={<Sunrise />} title="No sales day to show" description="Your account has no daily sales targets. Sales reports show the team's day." action={<Button asChild variant="outline"><Link href="/sales/reports">Open sales reports</Link></Button>} />
      ) : (
        <DayBody day={day.data} canLog={isMe} canWork={!!viewer && canWorkOn(viewer, day.data.empId)} onLog={() => setLog("1")} />
      )}
      {isMe && <DailyLogSheet open={log === "1"} onOpenChange={(o) => setLog(o ? "1" : "")} existing={day.data?.log} />}
    </>
  );
}

function DaySkeleton() {
  return (
    <div className="grid gap-5">
      <Skeleton className="h-56 rounded-xl" />
      <div className="grid gap-5 lg:grid-cols-2">
        <Skeleton className="h-64 rounded-xl" />
        <Skeleton className="h-64 rounded-xl" />
      </div>
    </div>
  );
}

function DayBody({ day, canLog, canWork, onLog }: { day: Day; canLog: boolean; canWork: boolean; onLog: () => void }) {
  const s = day.summary;
  const t = day.targets;
  const met = targetsMet(s, t);
  const metCount = [met.leadsAdded, met.emailsChecked, met.emailsSent, met.followUps].filter(Boolean).length;
  const rings = [
    { label: "Leads added", value: leadsAddedTotal(s), target: t.leadsAdded, split: `Apollo ${s.leadsAdded.auto} · Manual ${s.leadsAdded.manual}` },
    { label: "Emails checked", value: s.emailsChecked, target: t.emailsChecked, split: `MillionVerifier · ${s.invalid} invalid` },
    { label: "Emails sent", value: emailsSentTotal(s), target: t.emailsSent, split: `Apollo ${s.emailsSent.apollo} · Mailbox ${s.emailsSent.mailbox}` },
    { label: "Follow-ups", value: followUpsTotal(s), target: t.followUps, split: `Apollo tasks ${s.followUps.auto} · In Aceva ${s.followUps.manual}` },
  ];
  const self = selfReportedTotal(s);

  return (
    <div className="grid gap-5">
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_340px]">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Today&apos;s targets</CardTitle>
              <p className="text-[12.5px] text-muted-foreground">Counted automatically from Apollo, MillionVerifier and the outreach mailboxes.</p>
            </div>
            <Badge tone={met.all ? "success" : metCount >= 2 ? "info" : "warning"} dot>
              {metCount} of 4 met
            </Badge>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-x-3 gap-y-6 sm:grid-cols-4">
              {rings.map((r) => (
                <div key={r.label} className="grid justify-items-center gap-1 text-center">
                  <ProgressRing value={r.value} target={r.target} label={r.label} size={88} color="var(--zone-sales)" />
                  <span className="text-[11px] text-muted-foreground">{r.split}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        <Card className="flex flex-col">
          <CardHeader>
            <div>
              <CardTitle>Self-reported today</CardTitle>
              <p className="text-[12.5px] text-muted-foreground">Work outside the connected tools. Counts toward Activity only.</p>
            </div>
          </CardHeader>
          <CardContent className="flex flex-1 flex-col">
            {day.log ? (
              <>
                <ul className="grid gap-1.5">
                  {SELF_REPORTED_FIELDS.map((f) => (
                    <li key={f.key} className="flex items-center justify-between text-[13px] [&_svg]:size-4 [&_svg]:text-muted-foreground">
                      <span className="flex items-center gap-2">
                        {f.icon} {f.label}
                      </span>
                      <span className="font-mono font-semibold tabular">{s.selfReported[f.key]}</span>
                    </li>
                  ))}
                </ul>
                <div className="mt-auto flex items-center justify-between pt-3">
                  <Badge tone="outline">{self} self-reported</Badge>
                  {canLog && (
                    <Button size="sm" variant="ghost" onClick={onLog}>
                      Edit
                    </Button>
                  )}
                </div>
              </>
            ) : (
              <div className="flex flex-1 flex-col items-start justify-between gap-3 rounded-lg border border-dashed border-border p-3">
                <p className="text-[13px] text-muted-foreground">Before you check out, log LinkedIn messages, WhatsApp chats, Fiverr inquiries, calls and field visits. About 2 minutes.</p>
                {canLog && (
                  <Button size="sm" onClick={onLog}>
                    <NotebookPen /> Log my day
                  </Button>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        <FollowUps items={day.followUpsDue} canWork={canWork} />
        <Card>
          <CardHeader>
            <div>
              <CardTitle>New replies</CardTitle>
              <p className="text-[12.5px] text-muted-foreground">Pulled from Apollo in the last 24 hours.</p>
            </div>
            <Badge tone="success">{day.newReplies.length}</Badge>
          </CardHeader>
          <CardContent>
            {day.newReplies.length ? (
              <ul className="grid gap-2">
                {day.newReplies.map((r) => (
                  <li key={r.id}>
                    <Link href={`/sales/leads/${r.leadId}`} className="flex gap-3 rounded-lg border border-border px-3 py-2.5 transition hover:bg-muted">
                      <span className="mt-0.5 grid size-7 shrink-0 place-content-center rounded-full bg-success/12 text-success">
                        <Reply className="size-3.5" />
                      </span>
                      <span className="grid min-w-0 gap-0.5">
                        <span className="text-[13px] font-medium">
                          {r.leadName} <span className="font-normal text-muted-foreground">· {r.companyName}</span>
                        </span>
                        <span className="line-clamp-2 text-[12.5px] text-muted-foreground">{r.summary}</span>
                        <span className="text-[11px] text-muted-foreground">{formatRelative(r.at)}</span>
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            ) : (
              <EmptyState compact icon={<Reply />} title="No new replies yet" description="Replies appear here within 15 minutes of arriving in Apollo." />
            )}
          </CardContent>
        </Card>
      </div>

      <MiniPipeline day={day} />
    </div>
  );
}

function FollowUps({ items, canWork }: { items: FollowUp[]; canWork: boolean }) {
  const [active, setActive] = React.useState<FollowUp | null>(null);
  const missed = items.filter((i) => i.missed).length;
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Follow-ups due today</CardTitle>
          <p className="text-[12.5px] text-muted-foreground">Missed follow-ups turn red and are shown to the Director.</p>
        </div>
        {missed > 0 && <Badge tone="danger">{missed} missed</Badge>}
      </CardHeader>
      <CardContent>
        {items.length ? (
          <ul className="grid gap-2">
            {items.map((f) => (
              <li key={f.dealId} className={cn("flex flex-wrap items-center gap-3 rounded-lg border px-3 py-2.5", f.missed ? "border-danger/35 bg-danger/6" : "border-border")}>
                <div className="min-w-0 flex-1">
                  <Link href={`/sales/deals/${f.dealId}`} className="text-[13px] font-medium hover:underline">
                    {f.companyName}
                  </Link>
                  <p className="truncate text-[12.5px] text-muted-foreground">
                    {f.nextStep} · {f.leadName}
                  </p>
                </div>
                <FollowUpDue date={f.nextStepDate} />
                {canWork && (
                  <Button size="sm" variant="outline" onClick={() => setActive(f)}>
                    <CircleCheck /> Done
                  </Button>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState compact icon={<CircleCheck />} title="Nothing due today" description="Every open deal has its next step on a later date." />
        )}
      </CardContent>
      {canWork && active && (
        <FollowUpDialog open onOpenChange={(o) => !o && setActive(null)} dealId={active.dealId} company={active.companyName} currentStep={active.nextStep} currentDate={active.nextStepDate} />
      )}
    </Card>
  );
}

function MiniPipeline({ day }: { day: Day }) {
  const open = day.pipeline.filter((p) => !["won", "lost"].includes(p.stage));
  const max = Math.max(1, ...open.map((p) => p.count));
  const total = open.reduce((s, p) => s + p.valueUsd, 0);
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>My pipeline</CardTitle>
          <p className="text-[12.5px] text-muted-foreground">
            Open deals worth <span className="font-mono font-medium text-foreground tabular">USD {Math.round(total).toLocaleString()}</span>
          </p>
        </div>
        <Button asChild size="sm" variant="ghost">
          <Link href="/sales/pipeline">
            Open pipeline <ArrowRight />
          </Link>
        </Button>
      </CardHeader>
      <CardContent>
        <ol className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-6">
          {open.map((p) => (
            <li key={p.stage} className="rounded-lg border border-border bg-muted/30 p-3">
              <div className="flex items-center gap-1.5">
                <span className="size-2 rounded-full" style={{ background: STAGE_META[p.stage].color }} />
                <span className="truncate text-[12px] font-medium text-muted-foreground">{STAGE_META[p.stage].label}</span>
              </div>
              <p className="mt-1 text-xl font-semibold tabular">{p.count}</p>
              <div className="mt-1 h-1 overflow-hidden rounded-full bg-muted">
                <div className="h-full rounded-full" style={{ width: `${(p.count / max) * 100}%`, background: STAGE_META[p.stage].color }} />
              </div>
              <p className="mt-1.5 font-mono text-[11px] text-muted-foreground tabular">USD {Math.round(p.valueUsd).toLocaleString()}</p>
            </li>
          ))}
        </ol>
      </CardContent>
    </Card>
  );
}
