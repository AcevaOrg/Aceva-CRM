"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  Ban, CircleAlert, CircleCheck, Coins, Eye, EyeOff, KeyRound, Pause, Play, RefreshCw, Settings2, TriangleAlert, UserPlus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress, Table, TBody, TD, TH, THead, TR } from "@/components/ui/misc";
import { Tip } from "@/components/ui/overlays";
import { PageHeader, SectionTitle } from "@/components/layout/page-header";
import { RequireAccess } from "@/components/shared/can";
import { FreshnessStamp, StatusBadge } from "@/components/shared/chips";
import { useStepUp } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { CardsSkeleton, EmptyState, ErrorState, ListSkeleton } from "@/components/shared/states";
import { useCan } from "@/lib/auth/viewer";
import { formatRelative, formatTime } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useIntegrationsOverview, useMailboxes, usePauseMailbox, useSyncNow, useSyncRuns, useUnmatched, useUpdateConnection } from "../hooks";
import { BOUNCE_LIMIT_PCT, creditRunwayDays, domainStats, rate, TOOL_META, TOOL_ORDER } from "../logic";
import type { IntegrationAlert, ToolConnection } from "../types";
import { ConnectionBadge, KeyMask, ToolTile } from "./tool-ui";

export function IntegrationsHealthScreen() {
  return (
    <RequireAccess permission="integrations.view">
      <HealthInner />
    </RequireAccess>
  );
}

function HealthInner() {
  const q = useIntegrationsOverview();
  return (
    <>
      <PageHeader
        title="Integrations"
        description="The sales tools Aceva pays for, connected read-only. Work counts sync every 15 to 30 minutes; API keys never leave the server."
        seal="highly"
      />
      {q.isPending ? (
        <CardsSkeleton count={4} className="xl:grid-cols-2" />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="grid gap-6">
          {q.data.alerts.length > 0 && <Alerts alerts={q.data.alerts} />}
          <div className="grid gap-5 lg:grid-cols-2">
            {TOOL_ORDER.map((t) => {
              const c = q.data.connections.find((x) => x.tool === t);
              return c ? <ToolCard key={t} c={c} /> : null;
            })}
          </div>
          <MailboxesSection />
          <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_380px]">
            <SyncRunsCard />
            <div className="grid content-start gap-5">
              <UnmatchedCard count={q.data.unmatchedUsers} />
              <FairUseCard />
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function Alerts({ alerts }: { alerts: IntegrationAlert[] }) {
  return (
    <ul className="grid gap-2" aria-label="Connection alerts">
      {alerts.map((a) => (
        <li key={a.id} className={cn("flex items-start gap-3 rounded-xl border px-4 py-3", a.severity === "danger" ? "border-danger/35 bg-danger/8" : "border-warning/40 bg-warning/10")}>
          {a.severity === "danger" ? <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" /> : <TriangleAlert className="mt-0.5 size-4 shrink-0 text-[oklch(0.6_0.14_70)]" />}
          <div className="min-w-0 flex-1">
            <p className="text-[13.5px] font-medium">{a.title}</p>
            <p className="text-[12.5px] text-muted-foreground">{a.detail}</p>
          </div>
          <Button asChild size="sm" variant="ghost">
            <Link href={`/integrations/${a.tool}${a.id.startsWith("unmatched") ? "?step=users" : ""}`}>Open</Link>
          </Button>
        </li>
      ))}
    </ul>
  );
}

function ToolCard({ c }: { c: ToolConnection }) {
  const m = TOOL_META[c.tool];
  const canManage = useCan("integrations.manage");
  const sync = useSyncNow();
  const update = useUpdateConnection();
  const stepUp = useStepUp();
  const connected = c.status !== "not_connected";
  const runway = creditRunwayDays(c);

  const togglePause = async () => {
    if (c.status === "paused") {
      update.mutate({ tool: c.tool, patch: { status: "working" } }, { onSuccess: () => toast.success(`${m.name} resumed`, { description: "The next sync runs within 15 minutes." }) });
      return;
    }
    if (!(await stepUp({ action: `Pause ${m.name}`, detail: "Numbers from this tool stop updating until you resume it. This is a security event." }))) return;
    update.mutate({ tool: c.tool, patch: { status: "paused" } }, { onSuccess: () => toast(`${m.name} paused`) });
  };

  return (
    <Card className="flex flex-col">
      <CardHeader>
        <div className="flex min-w-0 items-center gap-3">
          <ToolTile tool={c.tool} />
          <div className="min-w-0">
            <CardTitle className="truncate">{m.name}</CardTitle>
            {connected ? <FreshnessStamp source="Last sync" at={c.lastSuccessAt} /> : <p className="text-[12px] text-muted-foreground">Not connected</p>}
          </div>
        </div>
        <ConnectionBadge status={c.status} />
      </CardHeader>
      <CardContent className="grid flex-1 content-start gap-4">
        {connected ? (
          <>
            <dl className="grid grid-cols-3 gap-3 text-[12.5px]">
              <div>
                <dt className="text-muted-foreground">Items today</dt>
                <dd className="text-lg font-semibold tabular">{c.itemsToday.toLocaleString()}</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Sync</dt>
                <dd className="text-lg font-semibold tabular">{c.syncEveryMin} min</dd>
              </div>
              <div>
                <dt className="text-muted-foreground">Key</dt>
                <dd className="pt-1">
                  <KeyMask last4={c.keyLast4} className="text-[13px]" />
                </dd>
              </div>
            </dl>
            {c.callsLimit !== undefined && (
              <div className="grid gap-1.5">
                <div className="flex justify-between text-[12px]">
                  <span className="text-muted-foreground">API calls {c.callsWindow}</span>
                  <span className="font-mono tabular">
                    {c.callsUsed} of {c.callsLimit}
                  </span>
                </div>
                <Progress value={c.callsUsed ?? 0} max={c.callsLimit} barClassName={(c.callsUsed ?? 0) / c.callsLimit > 0.8 ? "bg-warning" : "bg-zone-control"} />
              </div>
            )}
            {c.creditsLeft !== undefined && (
              <div className="grid gap-1.5 rounded-lg border border-border bg-muted/40 p-3">
                <div className="flex items-center justify-between">
                  <span className="flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
                    <Coins className="size-3.5" /> Credits left
                  </span>
                  <span className={cn("font-mono text-lg font-semibold tabular", c.creditAlertAt !== undefined && c.creditsLeft <= c.creditAlertAt * 1.5 && "text-[oklch(0.6_0.14_70)]")}>
                    {c.creditsLeft.toLocaleString()}
                  </span>
                </div>
                <Progress value={c.creditsLeft} max={Math.max(c.creditsLeft, (c.creditAlertAt ?? 0) * 3)} barClassName="bg-zone-work" />
                <p className="text-[11.5px] text-muted-foreground">
                  About {c.creditsUsedPerDay} used a day · {runway !== undefined ? `about ${runway} days left` : "—"} · alert at {c.creditAlertAt?.toLocaleString()}
                </p>
              </div>
            )}
            {c.tool === "mailboxes" && <p className="text-[12.5px] text-muted-foreground">Read-only IMAP on {c.imapHost}. Only sender, receiver, date and subject are read.</p>}
          </>
        ) : (
          <div className="grid gap-2 text-[13px]">
            <p className="text-muted-foreground">{m.reads}</p>
            {m.advice && (
              <p className="flex gap-2 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-[12.5px]">
                <CircleAlert className="mt-0.5 size-4 shrink-0 text-info" /> {m.advice}
              </p>
            )}
          </div>
        )}
      </CardContent>
      <CardFooter className="flex-wrap">
        {connected ? (
          <>
            <Button
              size="sm"
              variant="outline"
              loading={sync.isPending}
              disabled={c.status === "paused"}
              onClick={() => sync.mutate(c.tool, { onSuccess: (r) => toast.success(`${m.name} synced`, { description: `${r.items} new items. Already-counted items are skipped by their tool ID.` }) })}
            >
              <RefreshCw /> Sync now
            </Button>
            {canManage && (
              <Button size="sm" variant="outline" onClick={togglePause} loading={update.isPending}>
                {c.status === "paused" ? <Play /> : <Pause />} {c.status === "paused" ? "Resume" : "Pause"}
              </Button>
            )}
            {canManage && (
              <Button asChild size="sm" variant="ghost">
                <Link href={`/integrations/${c.tool}?step=key`}>
                  <KeyRound /> Change key
                </Link>
              </Button>
            )}
            <Button asChild size="sm" variant="ghost" className="ml-auto">
              <Link href={`/integrations/${c.tool}`}>
                <Settings2 /> Manage
              </Link>
            </Button>
          </>
        ) : (
          <Button asChild size="sm" variant={c.tool === "salesforce" ? "outline" : "default"}>
            <Link href={`/integrations/${c.tool}`}>Connect {m.name}</Link>
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}

function MailboxesSection() {
  const q = useMailboxes();
  const pause = usePauseMailbox();
  const canManage = useCan("integrations.manage");
  const domains = domainStats(q.data ?? []);
  return (
    <section>
      <SectionTitle title="Outreach mailboxes and domains" description={`Bounce rate per mailbox and domain. Over ${BOUNCE_LIMIT_PCT}% of the day's emails, pause the mailbox before the domain's reputation is damaged.`} />
      {q.isPending ? (
        <ListSkeleton rows={4} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : (
        <div className="grid gap-4">
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            {domains.map((d) => {
              const pct = rate(d.bouncesToday, d.sentToday);
              const over = pct > BOUNCE_LIMIT_PCT;
              return (
                <Card key={d.domain} className={cn("px-4 py-3", over && "border-danger/40")}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="truncate font-mono text-[13px] font-semibold">{d.domain}</p>
                    <Badge tone={over ? "danger" : "success"}>{over ? "Over 3%" : "Healthy"}</Badge>
                  </div>
                  <p className="mt-1 text-[12px] text-muted-foreground">
                    {d.mailboxes} mailboxes · today <span className={cn("font-mono font-semibold tabular", over ? "text-danger" : "text-foreground")}>{pct.toFixed(1)}%</span> · week{" "}
                    <span className="font-mono tabular">{rate(d.bouncesWeek, d.sentWeek).toFixed(1)}%</span>
                  </p>
                </Card>
              );
            })}
          </div>
          <Card className="overflow-hidden">
            <Table>
              <THead>
                <tr>
                  <TH>Mailbox</TH>
                  <TH>Owner</TH>
                  <TH className="text-right">Sent today</TH>
                  <TH className="text-right">Replies</TH>
                  <TH className="text-right">Bounces</TH>
                  <TH className="w-48">Bounce rate today</TH>
                  <TH className="text-right">This week</TH>
                  <TH />
                </tr>
              </THead>
              <TBody>
                {(q.data ?? []).map((mb) => {
                  const pct = rate(mb.bouncesToday, mb.sentToday);
                  const over = pct > BOUNCE_LIMIT_PCT;
                  return (
                    <TR key={mb.mailbox} className={cn(mb.paused && "opacity-60")}>
                      <TD className="font-mono text-[12.5px]">{mb.mailbox}</TD>
                      <TD>{mb.ownerEmpId ? <EmpChip empId={mb.ownerEmpId} size="sm" showId={false} /> : "—"}</TD>
                      <TD className="text-right tabular">{mb.sentToday}</TD>
                      <TD className="text-right tabular">{mb.repliesToday}</TD>
                      <TD className={cn("text-right tabular", over && "font-semibold text-danger")}>{mb.bouncesToday}</TD>
                      <TD>
                        <div className="flex items-center gap-2">
                          <div className="relative h-1.5 flex-1 overflow-hidden rounded-full bg-muted">
                            <div className={cn("h-full rounded-full", over ? "bg-danger" : "bg-success")} style={{ width: `${Math.min(100, (pct / 10) * 100)}%` }} />
                            <span className="absolute inset-y-0 w-px bg-foreground/40" style={{ left: "30%" }} aria-hidden />
                          </div>
                          <span className={cn("w-12 text-right font-mono text-[12px] tabular", over && "font-semibold text-danger")}>{pct.toFixed(1)}%</span>
                        </div>
                      </TD>
                      <TD className="text-right font-mono text-[12px] tabular">{rate(mb.bouncesWeek, mb.sentWeek).toFixed(1)}%</TD>
                      <TD className="text-right">
                        {mb.paused ? (
                          <span className="inline-flex items-center gap-2">
                            <Badge tone="warning">Paused</Badge>
                            {canManage && (
                              <Button size="sm" variant="ghost" onClick={() => pause.mutate({ mailbox: mb.mailbox, paused: false }, { onSuccess: () => toast.success("Mailbox resumed") })}>
                                Resume
                              </Button>
                            )}
                          </span>
                        ) : (
                          canManage && (
                            <Button
                              size="sm"
                              variant={over ? "destructive" : "ghost"}
                              onClick={() => pause.mutate({ mailbox: mb.mailbox, paused: true }, { onSuccess: () => toast(`${mb.mailbox} paused`, { description: "Apollo sequences stop sending from it." }) })}
                            >
                              <Ban /> {over ? "Pause this mailbox" : "Pause"}
                            </Button>
                          )
                        )}
                      </TD>
                    </TR>
                  );
                })}
              </TBody>
            </Table>
          </Card>
        </div>
      )}
    </section>
  );
}

const RESULT = {
  ok: { label: "OK", tone: "success" as const },
  retrying: { label: "Retrying", tone: "warning" as const },
  failed: { label: "Failed", tone: "danger" as const },
};
const RETRY_AFTER = ["", "", "after 1 min", "after 5 min", "after 15 min"];

function SyncRunsCard() {
  const q = useSyncRuns();
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Recent sync runs</CardTitle>
          <p className="text-[12.5px] text-muted-foreground">Each run asks only for what changed since the last success. Failures retry after 1, 5 and 15 minutes, then the CTO is alerted.</p>
        </div>
      </CardHeader>
      {q.isPending ? (
        <CardContent>
          <ListSkeleton rows={5} />
        </CardContent>
      ) : q.isError ? (
        <CardContent>
          <ErrorState error={q.error} onRetry={() => q.refetch()} />
        </CardContent>
      ) : !q.data.length ? (
        <CardContent>
          <EmptyState compact title="No sync runs yet" />
        </CardContent>
      ) : (
        <Table>
          <THead>
            <tr>
              <TH>Time</TH>
              <TH>Tool</TH>
              <TH className="text-right">Items</TH>
              <TH>Result</TH>
              <TH>Try</TH>
            </tr>
          </THead>
          <TBody>
            {q.data.map((r) => (
              <TR key={r.id}>
                <TD className="font-mono text-[12.5px] tabular">
                  <Tip content={formatRelative(r.startedAt)}>
                    <span>{formatTime(r.startedAt)}</span>
                  </Tip>
                </TD>
                <TD>
                  <span className="flex items-center gap-2">
                    <ToolTile tool={r.tool} size={20} /> {TOOL_META[r.tool].name}
                  </span>
                </TD>
                <TD className="text-right tabular">{r.items}</TD>
                <TD>
                  <span className="grid justify-items-start gap-0.5">
                    <StatusBadge label={RESULT[r.result].label} tone={RESULT[r.result].tone} />
                    {r.error && <span className="text-[11.5px] text-muted-foreground">{r.error}</span>}
                  </span>
                </TD>
                <TD className="text-[12px] text-muted-foreground">
                  {r.attempt === 1 ? "First" : `Retry ${r.attempt - 1} ${RETRY_AFTER[r.attempt] ?? ""}`}
                </TD>
              </TR>
            ))}
          </TBody>
        </Table>
      )}
    </Card>
  );
}

function UnmatchedCard({ count }: { count: number }) {
  const q = useUnmatched();
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Unmatched users</CardTitle>
          <p className="text-[12.5px] text-muted-foreground">Activity from a tool user not linked to an Emp-ID waits here and isn&apos;t counted for anyone.</p>
        </div>
        <Badge tone={count ? "warning" : "success"}>{count}</Badge>
      </CardHeader>
      <CardContent className="grid gap-3">
        {q.data && q.data.length > 0 ? (
          <ul className="grid gap-1.5">
            {q.data.slice(0, 4).map((u) => (
              <li key={u.id} className="flex items-center justify-between gap-2 rounded-lg bg-muted/50 px-3 py-2 text-[12.5px]">
                <span className="min-w-0">
                  <span className="font-medium">{u.userName}</span> <span className="text-muted-foreground">· {u.summary}</span>
                </span>
                <span className="shrink-0 text-[11px] text-muted-foreground">{formatRelative(u.at)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="flex items-center gap-2 text-[13px] text-success">
            <CircleCheck className="size-4" /> Every tool user is linked.
          </p>
        )}
        {count > 0 && (
          <Button asChild size="sm" className="w-fit">
            <Link href="/integrations/apollo?step=users">
              <UserPlus /> Link users
            </Link>
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

function FairUseCard() {
  return (
    <Card>
      <CardHeader>
        <div>
          <CardTitle>Fair use</CardTitle>
          <p className="text-[12.5px] text-muted-foreground">Named in the tracking policy every employee accepts (version 2026-11).</p>
        </div>
      </CardHeader>
      <CardContent className="grid gap-3 text-[12.5px]">
        <div>
          <p className="mb-1 flex items-center gap-1.5 font-semibold">
            <Eye className="size-3.5 text-seal-own" /> What is read
          </p>
          <p className="text-muted-foreground">Work counts only: what was done, when, and with which lead. Only company accounts on tools Aceva pays for.</p>
        </div>
        <div>
          <p className="mb-1 flex items-center gap-1.5 font-semibold">
            <EyeOff className="size-3.5 text-muted-foreground" /> Never read
          </p>
          <p className="text-muted-foreground">Email text, call recordings, private messages, personal accounts.</p>
        </div>
        <p className="text-muted-foreground">Each salesperson sees their own synced numbers and can flag a wrong count to the sales manager.</p>
      </CardContent>
    </Card>
  );
}
