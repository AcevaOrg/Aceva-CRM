"use client";
import * as React from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  ArrowUpRight, Check, CircleAlert, FilePen, History, Send, Undo2, X,
} from "lucide-react";
import { PageHeader, SectionTitle } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TBody, TD, TH, THead, TR } from "@/components/ui/misc";
import { ApprovalRelay, MakerCheckerNote } from "@/components/shared/approval-relay";
import { NotFoundBlock, RequireAccess } from "@/components/shared/can";
import { useReason, useStepUp } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { Money, Mono } from "@/components/shared/money";
import { DetailList } from "@/components/shared/pickers";
import { ErrorState, ListSkeleton } from "@/components/shared/states";
import { FileCard, Timeline, type TimelineItem } from "@/components/shared/timeline";
import { useLookup } from "@/hooks/use-directory";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate, formatDateTime } from "@/lib/dates";
import { formatMoney } from "@/lib/format";
import { useAccounts, useApproveEntry, useEntries, useEntry, useFinanceProjects, useParties, useRejectEntry, useReverseEntry, useSubmitEntry } from "../hooks";
import { DIRECTOR_MADE_IT, lineBase, lineTotals, num } from "../logic";
import type { EntryEvent } from "../types";
import { ApprovalChip, EntryStatusBadge, SourceBadge, ViewOnlyNote } from "./ledger-bits";

const EVENT: Record<EntryEvent["action"], { label: string; color: string }> = {
  created: { label: "Created", color: "var(--muted-foreground)" },
  edited: { label: "Edited", color: "var(--muted-foreground)" },
  submitted: { label: "Submitted for approval", color: "var(--info)" },
  approved: { label: "Approved", color: "var(--success)" },
  rejected: { label: "Sent back", color: "var(--danger)" },
  posted: { label: "Posted to the ledger", color: "var(--success)" },
  reversed: { label: "Reversed", color: "var(--warning)" },
  ceo_notified: { label: "CEO / Founder / Owner notified (view only)", color: "var(--warning)" },
  blocked: { label: "Blocked (maker-checker)", color: "var(--danger)" },
};

export function EntryDetailScreen({ id }: { id: string }) {
  return (
    <RequireAccess permission="finance.view" mode="404">
      <EntryDetail id={id} />
    </RequireAccess>
  );
}

function EntryDetail({ id }: { id: string }) {
  const router = useRouter();
  const viewer = useViewer();
  const lookup = useLookup();
  const q = useEntry(id);
  const accounts = useAccounts();
  const parties = useParties();
  const projects = useFinanceProjects();
  const all = useEntries();
  const submit = useSubmitEntry();
  const approve = useApproveEntry();
  const reject = useRejectEntry();
  const reverse = useReverseEntry();
  const stepUp = useStepUp();
  const askReason = useReason();

  if (q.isPending) return <ListSkeleton rows={8} className="mt-6" />;
  if (q.isError) return (q.error as { status?: number }).status === 404 ? <NotFoundBlock /> : <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  const e = q.data;
  const me = viewer?.employee.empId;
  const isMaker = e.createdBy === me;
  // Live: the SERVER says whether this viewer may decide (permission, approval tier, never the maker). Mock: the Director.
  const live = e.canApprove !== undefined;
  const isApprover = live ? !!e.canApprove : !e.blocked && e.approverEmpId === me && !!viewer?.can("finance.entry_approve");
  const approverText = live ? `${e.requiredApproverLabel ?? "an approver"} (level ${e.requiredLevel ?? "?"} or higher)` : undefined;
  const canPrepare = !!viewer?.can("finance.entry_create");
  const approver = lookup.employee(e.approverEmpId);
  const acc = (aid: string) => accounts.data?.find((a) => a.id === aid);
  const party = (pid?: string) => parties.data?.find((p) => p.id === pid)?.name;
  const t = lineTotals(e.lines);
  const usd = e.currency === "USD";
  const baseDr = e.lines.reduce((s, l) => s + lineBase(l, e).dr, 0);
  const baseCr = e.lines.reduce((s, l) => s + lineBase(l, e).cr, 0);
  const reversalOf = all.data?.find((x) => x.id === e.reversalOf);
  const reversedBy = all.data?.find((x) => x.id === e.reversedBy);
  const pendingReversal = all.data?.find((x) => x.reversalOf === e.id && x.status !== "reversed" && x.status !== "posted");

  const doApprove = async () => {
    if ((live ? e.needsStepUp : e.ceoNotified) && !(await stepUp({ action: `Approve and post ${e.number}`, detail: `${formatMoney(Number(e.baseTotal.amount), { exact: true })} · ${e.description}` }))) return;
    try {
      await approve.mutateAsync(e.id);
      toast.success(`${e.number} posted`, { description: "The statements update on their own." });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't approve.");
    }
  };
  const doReject = async () => {
    const reason = await askReason({ title: `Send ${e.number} back`, description: "The maker sees your reason and can fix the draft.", confirmLabel: "Send back", destructive: true });
    if (!reason) return;
    await reject.mutateAsync({ id: e.id, reason });
    toast(`${e.number} sent back to ${lookup.employee(e.createdBy)?.name ?? "the maker"}`);
  };
  const doReverse = async () => {
    const reason = await askReason({
      title: `Reverse ${e.number}`,
      description: "Posted entries are never edited or deleted. A reversing draft is created that cancels this one; it goes through normal approval. Then enter the correct entry.",
      confirmLabel: "Create reversing draft",
      options: ["Entered twice", "Wrong account", "Wrong amount", "Wrong period", "Other"],
    });
    if (!reason) return;
    try {
      const r = await reverse.mutateAsync({ id: e.id, reason });
      toast.success(`Reversing draft ${r.number} created`, { description: "Submit it for approval to cancel the original." });
      router.push(`/finance/ledger/${r.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't reverse.");
    }
  };
  const doSubmit = async () => {
    try {
      await submit.mutateAsync(e.id);
      toast.success(`${e.number} sent for approval`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't submit.");
    }
  };

  const history: TimelineItem[] = [...e.history].reverse().map((h, i) => ({
    id: `${i}`,
    color: EVENT[h.action].color,
    icon: h.action === "approved" || h.action === "posted" ? <Check /> : h.action === "rejected" ? <X /> : h.action === "reversed" ? <Undo2 /> : <History />,
    title: EVENT[h.action].label,
    meta: (
      <span>
        {lookup.employee(h.by)?.name ?? h.by} · {formatDateTime(h.at)}
      </span>
    ),
    body: h.note ? <span className="text-muted-foreground">{h.note}</span> : undefined,
  }));

  return (
    <>
      <PageHeader
        title={<span className="flex flex-wrap items-baseline gap-3"><Mono>{e.number}</Mono><span className="text-muted-foreground font-normal">·</span><span>{e.description}</span></span>}
        back={{ href: "/finance/ledger", label: "Ledger" }}
        seal="highly"
        meta={
          <>
            <EntryStatusBadge status={e.status} rejected={e.rejected} />
            <SourceBadge source={e.source} />
            {e.status !== "posted" && e.status !== "reversed" && !e.rejected && (
              <ApprovalChip ceoNotified={e.ceoNotified} blocked={e.blocked} serverLabel={e.requiredApproverLabel} serverLevel={e.requiredLevel} />
            )}
          </>
        }
        actions={
          <>
            {e.status === "draft" && canPrepare && !e.rejected && (!live || isMaker) && (
              <>
                <Button variant="outline" asChild>
                  <Link href={`/finance/ledger/new?edit=${e.id}`}>
                    <FilePen /> Continue editing
                  </Link>
                </Button>
                <Button onClick={doSubmit} loading={submit.isPending}>
                  <Send /> Submit for approval
                </Button>
              </>
            )}
            {e.status === "pending_approval" && isApprover && !isMaker && (
              <>
                <Button variant="outline" onClick={doReject} loading={reject.isPending}>
                  <X /> Send back
                </Button>
                <Button onClick={doApprove} loading={approve.isPending}>
                  <Check /> Approve and post
                </Button>
              </>
            )}
            {e.status === "posted" && !pendingReversal && canPrepare && (
              <Button variant="outline" onClick={doReverse} loading={reverse.isPending}>
                <Undo2 /> Reverse
              </Button>
            )}
          </>
        }
      />

      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_360px]">
        <div className="grid min-w-0 content-start gap-6">
          {e.rejectionNote && e.status === "draft" && (
            <div role="alert" className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/8 px-4 py-3 text-[13px]">
              <CircleAlert className="mt-0.5 size-4 shrink-0 text-danger" />
              <p>
                {e.rejected ? (
                  <>
                    <span className="font-semibold">Rejected: </span>“{e.rejectionNote}” A rejected entry never changes; make a new entry instead.
                  </>
                ) : (
                  <>
                    <span className="font-semibold">Sent back: </span>“{e.rejectionNote}” Fix the draft and submit it again.
                  </>
                )}
              </p>
            </div>
          )}
          {reversedBy && (
            <Banner tone="warning">
              This entry was cancelled by <Link className="font-mono font-semibold underline" href={`/finance/ledger/${reversedBy.id}`}>{reversedBy.number}</Link>. It stays in the history.
            </Banner>
          )}
          {pendingReversal && (
            <Banner tone="info">
              A reversal is in progress: <Link className="font-mono font-semibold underline" href={`/finance/ledger/${pendingReversal.id}`}>{pendingReversal.number}</Link> ({pendingReversal.status.replace("_", " ")}).
            </Banner>
          )}
          {reversalOf && (
            <Banner tone="info">
              This entry reverses <Link className="font-mono font-semibold underline" href={`/finance/ledger/${reversalOf.id}`}>{reversalOf.number}</Link>
              {e.status !== "posted" ? ". When it is approved, the original is marked reversed." : "."}
            </Banner>
          )}

          <Card className="overflow-hidden">
            <CardHeader>
              <CardTitle>Lines</CardTitle>
              <span className="text-[12.5px] text-muted-foreground">{usd ? `USD at ${num(e.exchangeRate).toFixed(2)} PKR` : "PKR"}</span>
            </CardHeader>
            <Table>
              <THead>
                <tr>
                  <TH>Account</TH>
                  <TH>Description</TH>
                  <TH>Client or vendor</TH>
                  <TH className="text-right">Debit</TH>
                  <TH className="text-right">Credit</TH>
                  {usd && <TH className="text-right">PKR</TH>}
                </tr>
              </THead>
              <TBody>
                {e.lines.map((l) => {
                  const a = acc(l.accountId);
                  const b = lineBase(l, e);
                  return (
                    <TR key={l.id}>
                      <TD>
                        <span className="flex items-center gap-2">
                          <Mono className="text-[12px] text-muted-foreground">{a?.code}</Mono>
                          <span className="font-medium">{a?.name ?? l.accountId}</span>
                        </span>
                      </TD>
                      <TD className="text-muted-foreground">
                        {l.description ?? "—"}
                        {l.empId && <EmpChip empId={l.empId} size="sm" className="mt-1 block" />}
                      </TD>
                      <TD className="text-muted-foreground">{party(l.partyId) ?? "—"}</TD>
                      <TD className="text-right">{num(l.debit) > 0 ? <Money value={{ amount: l.debit, currency: e.currency }} exact /> : ""}</TD>
                      <TD className="text-right">{num(l.credit) > 0 ? <Money value={{ amount: l.credit, currency: e.currency }} exact /> : ""}</TD>
                      {usd && (
                        <TD className="text-right text-[12px] text-muted-foreground">
                          {b.dr ? `Dr ${formatMoney(b.dr, { exact: true })}` : `Cr ${formatMoney(b.cr, { exact: true })}`}
                        </TD>
                      )}
                    </TR>
                  );
                })}
                <tr className="bg-muted/50 font-semibold">
                  <TD colSpan={3}>Total {Math.abs(t.diff) < 0.005 ? <span className="ml-2 text-[12px] font-medium text-success">Balanced</span> : <span className="ml-2 text-[12px] text-danger">Not balanced</span>}</TD>
                  <TD className="text-right"><Money value={{ amount: t.debit.toFixed(2), currency: e.currency }} exact /></TD>
                  <TD className="text-right"><Money value={{ amount: t.credit.toFixed(2), currency: e.currency }} exact /></TD>
                  {usd && <TD className="text-right text-[12px]">{formatMoney(baseDr, { exact: true })} / {formatMoney(baseCr, { exact: true })}</TD>}
                </tr>
              </TBody>
            </Table>
          </Card>

          <section>
            <SectionTitle
              title="Approval"
              description={
                live
                  ? "Approved at the level its amount needs (limits in Settings); one level up when the approver made it. The person who enters an entry can never approve it (maker-checker)."
                  : "Prepared by Finance, approved by the Director. The person who enters an entry can never approve it (maker-checker)."
              }
            />
            <ApprovalRelay steps={e.chain} />
            <div className="mt-3 grid gap-2">
              {e.status === "pending_approval" && e.blocked && <MakerCheckerNote reason={DIRECTOR_MADE_IT} />}
              {e.status === "pending_approval" && isMaker && !e.blocked && (
                <MakerCheckerNote reason={`You prepared this, so you can't approve it. It goes to ${approverText ?? `${approver?.name ?? "the Director"} (Director)`}.`} />
              )}
              {e.status === "pending_approval" && !isMaker && !isApprover && !e.blocked && (
                <ViewOnlyNote>
                  {live
                    ? `View only. Waiting for ${approverText}.`
                    : `View only. Waiting for ${approver?.name ?? "the Director"} (Director). The Director approves every journal entry, any amount.`}
                </ViewOnlyNote>
              )}
              {!live && e.ceoNotified && e.status !== "draft" && (
                <ViewOnlyNote>Above PKR 500,000, or a capital or loan entry: the CEO / Founder / Owner is notified and can view it. The Director approves.</ViewOnlyNote>
              )}
              {e.status === "draft" && !canPrepare && <ViewOnlyNote>View only. The finance person prepares and submits entries; the Director approves them.</ViewOnlyNote>}
            </div>
          </section>
        </div>

        <aside className="grid content-start gap-6">
          <Card>
            <CardHeader>
              <CardTitle>Details</CardTitle>
            </CardHeader>
            <CardContent>
              <DetailList
                items={[
                  ["Date", formatDate(e.date)],
                  ["Amount", <span key="a" className="grid"><Money value={e.total} exact />{usd && <span className="text-[12px] text-muted-foreground"><Money value={e.baseTotal} exact /> at {num(e.exchangeRate).toFixed(2)}</span>}</span>],
                  ["Project", projects.data?.find((p) => p.id === e.projectId)?.name ?? "—"],
                  ["Prepared by", <EmpChip key="m" empId={e.createdBy} size="sm" />],
                  ["Created", formatDateTime(e.createdAt)],
                  ["Posted", e.postedAt ? formatDateTime(e.postedAt) : "Not yet"],
                ]}
              />
            </CardContent>
          </Card>
          {e.attachments.length > 0 && (
            <Card>
              <CardHeader>
                <CardTitle>Files</CardTitle>
              </CardHeader>
              <CardContent className="grid gap-2">
                {e.attachments.map((a) => (
                  <FileCard key={a.id} file={a} onOpen={() => toast("Opening a private link (expires in 5 minutes)", { description: a.fileName })} />
                ))}
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader>
              <CardTitle>History</CardTitle>
              <Link href="/audit" className="inline-flex items-center gap-1 text-[12px] text-primary hover:underline">
                Audit log <ArrowUpRight className="size-3" />
              </Link>
            </CardHeader>
            <CardContent>
              <Timeline items={history} />
            </CardContent>
          </Card>
        </aside>
      </div>
    </>
  );
}

function Banner({ tone, children }: { tone: "info" | "warning"; children: React.ReactNode }) {
  return (
    <p className={tone === "info" ? "rounded-xl border border-info/30 bg-info/10 px-4 py-3 text-[13px]" : "rounded-xl border border-warning/40 bg-warning/12 px-4 py-3 text-[13px]"}>{children}</p>
  );
}
