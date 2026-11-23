"use client";
import * as React from "react";
import Link from "next/link";
import { Archive, ArrowLeft, Hash, Search, Shield } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PageHeader } from "@/components/layout/page-header";
import { RequireAccess } from "@/components/shared/can";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { toast } from "sonner";
import { useReason, useStepUp } from "@/components/shared/dialogs";
import { Field } from "@/components/ui/field";
import { NativeSelect } from "@/components/ui/controls";
import { ApiError } from "@/lib/api/mock";
import { formatDateTime } from "@/lib/dates";
import { useAdminChannels, useCommsAudit, useRetentionSettings, useSaveRetention } from "../hooks";
import { retentionNotice } from "../logic";

/**
 * comms.admin: every channel in the company with its scope, members and moderators (plan section 19: "Admins can create
 * channels, set moderators..."). The messages are never shown here: opening a channel you are not a member of shows only
 * its details, where its name, topic, members and moderators are managed and where it is archived.
 */
export function ChannelsAdminScreen() {
  return (
    <RequireAccess permission={["comms.use", "comms.admin"]}>
      <ChannelsAdmin />
    </RequireAccess>
  );
}

function ChannelsAdmin() {
  const q = useAdminChannels(true);
  const lookup = useLookup();
  const [search, setSearch] = React.useState("");
  const needle = search.trim().toLowerCase();
  const rows = (q.data ?? []).filter(
    (c) => !needle || `${c.name} ${c.topic ?? ""} ${c.projectName ?? ""} ${lookup.department(c.departmentId ?? undefined)?.name ?? ""}`.toLowerCase().includes(needle),
  );
  const open = rows.filter((c) => !c.archived);
  const archived = rows.filter((c) => c.archived);

  return (
    <>
      <PageHeader
        title="Channels"
        description="Every department and project channel. You manage names, topics, members and moderators here; the messages stay private to each channel's members."
        actions={
          <Button size="sm" variant="outline" asChild>
            <Link href="/messages">
              <ArrowLeft /> Messages
            </Link>
          </Button>
        }
      />
      <div className="relative mb-4 max-w-sm">
        <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
        <Input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Find a channel" className="pl-8" aria-label="Find a channel" />
      </div>
      {q.isPending ? (
        <ListSkeleton rows={5} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <EmptyState icon={<Hash />} title={needle ? "No channel matches" : "No channels yet"} description="Create one from Messages → New message → Channel." />
      ) : (
        <div className="grid gap-6">
          <ChannelTable title={`Active · ${open.length}`} rows={open} />
          {archived.length > 0 && <ChannelTable title={`Archived · ${archived.length}`} rows={archived} />}
        </div>
      )}
      <RetentionCard />
      <AuditCard />
    </>
  );
}

function ChannelTable({ title, rows }: { title: string; rows: NonNullable<ReturnType<typeof useAdminChannels>["data"]> }) {
  const lookup = useLookup();
  if (!rows.length) return null;
  return (
    <section>
      <h2 className="mb-2 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</h2>
      <div className="overflow-x-auto rounded-xl border border-border bg-card">
        <table className="w-full min-w-[640px] text-[13px]">
          <thead className="border-b border-border text-left text-[11.5px] text-muted-foreground">
            <tr>
              <th className="px-3 py-2 font-medium">Channel</th>
              <th className="px-3 py-2 font-medium">Belongs to</th>
              <th className="px-3 py-2 font-medium">Members</th>
              <th className="px-3 py-2 font-medium">Moderators</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} className="border-b border-border last:border-0">
                <td className="px-3 py-2">
                  <span className="font-medium">#{c.name}</span>
                  {c.archived && (
                    <Badge tone="outline" className="ml-2 text-[10.5px]">
                      <Archive /> Archived
                    </Badge>
                  )}
                  {c.topic && <p className="line-clamp-1 text-[12px] text-muted-foreground">{c.topic}</p>}
                </td>
                <td className="px-3 py-2">
                  {c.scope === "department" ? (
                    <Badge tone="work">{lookup.department(c.departmentId ?? undefined)?.name ?? c.departmentId}</Badge>
                  ) : (
                    <Badge tone="info">Project · {c.projectName}</Badge>
                  )}
                </td>
                <td className="px-3 py-2 tabular">{c.memberCount}</td>
                <td className="px-3 py-2">
                  {c.moderatorEmpIds.length ? (
                    <span className="inline-flex flex-wrap gap-1">
                      {c.moderatorEmpIds.map((id) => (
                        <Badge key={id} tone="outline" className="text-[10.5px]">
                          <Shield /> {lookup.employee(id)?.name ?? id}
                        </Badge>
                      ))}
                    </span>
                  ) : (
                    <span className="text-muted-foreground">None</span>
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <Button size="sm" variant="outline" asChild>
                    <Link href={`/messages/${c.id}`}>Manage</Link>
                  </Button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

const PERIODS: Array<{ value: string; label: string }> = [
  { value: "", label: "Not set yet (keep everything)" },
  { value: "90", label: "90 days" },
  { value: "180", label: "180 days" },
  { value: "365", label: "1 year" },
  { value: "730", label: "2 years" },
  { value: "1095", label: "3 years" },
  { value: "1825", label: "5 years" },
];

/**
 * Plan section 19: "Define message and file retention periods with management before launch" and "Admins can ... manage
 * retention". The comms admins record management's decision here ("confirm again", with a reason, audited). Everyone sees
 * it in conversation details. Automatic removal is not switched on in this release.
 */
function RetentionCard() {
  const q = useRetentionSettings(true);
  const save = useSaveRetention();
  const stepUp = useStepUp();
  const askReason = useReason();
  const [messages, setMessages] = React.useState<string | null>(null);
  const [files, setFiles] = React.useState<string | null>(null);
  if (!q.data) return null;
  const current = q.data.value;
  const msgValue = messages ?? (current.messageRetentionDays === null ? "" : String(current.messageRetentionDays));
  const fileValue = files ?? (current.fileRetentionDays === null ? "" : String(current.fileRetentionDays));
  const next = { messageRetentionDays: msgValue ? Number(msgValue) : null, fileRetentionDays: fileValue ? Number(fileValue) : null };
  const changed = next.messageRetentionDays !== current.messageRetentionDays || next.fileRetentionDays !== current.fileRetentionDays;
  const options = (value: number | null) => (value !== null && !PERIODS.some((p) => p.value === String(value)) ? [...PERIODS, { value: String(value), label: `${value} days` }] : PERIODS);
  const onSave = async () => {
    if (!(await stepUp({ action: "Change the retention periods", detail: "Messages and files" }))) return;
    const reason = await askReason({ title: "Why are the retention periods changing?", description: "Record management's decision. The reason is kept in the audit log.", confirmLabel: "Save", placeholder: "For example: Director's decision of 23 November" });
    if (!reason) return;
    try {
      await save.mutateAsync({ value: next, version: q.data!.version, reason });
      toast.success("Retention periods saved");
      setMessages(null);
      setFiles(null);
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save the retention periods.");
    }
  };
  return (
    <section className="mt-6 max-w-2xl rounded-xl border border-border bg-card p-4">
      <h2 className="mb-1 text-[14px] font-semibold">Retention</h2>
      <p className="mb-3 text-[12.5px] text-muted-foreground">{retentionNotice(current)}</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Messages are kept for" htmlFor="ret-messages">
          <NativeSelect id="ret-messages" value={msgValue} onChange={(e) => setMessages(e.target.value)}>
            {options(current.messageRetentionDays).map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <Field label="Files are kept for" htmlFor="ret-files">
          <NativeSelect id="ret-files" value={fileValue} onChange={(e) => setFiles(e.target.value)}>
            {options(current.fileRetentionDays).map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
      </div>
      <div className="mt-3 flex items-center justify-between gap-3">
        <span className="text-[12px] text-muted-foreground">{q.data.updatedAt ? `Last changed ${formatDateTime(q.data.updatedAt)} by ${q.data.updatedByEmpId ?? "someone"}` : "Never changed"}</span>
        <Button size="sm" onClick={() => void onSave()} disabled={!changed} loading={save.isPending}>
          Save
        </Button>
      </div>
    </section>
  );
}

const AUDIT_GROUPS: Array<{ value: string; label: string }> = [
  { value: "", label: "Everything" },
  { value: "messages", label: "Messages" },
  { value: "conversations", label: "Conversations, members and moderators" },
  { value: "files", label: "Files and malware checks" },
  { value: "announcements", label: "Announcements" },
  { value: "meetings", label: "Meetings" },
  { value: "settings", label: "Retention settings" },
  { value: "denied", label: "Refused attempts" },
];

/** Shown on one line; the details are ids, numbers and Emp-IDs only (the audit log never holds message text). */
function detailText(d: Record<string, unknown> | null): string {
  if (!d) return "";
  return Object.entries(d)
    .filter(([, v]) => v !== null && v !== undefined && typeof v !== "object")
    .map(([k, v]) => `${k}: ${String(v)}`)
    .join(" · ")
    .slice(0, 200);
}

/**
 * Plan section 19: "Admins can ... review security/audit events". Every Module 14 record of the shared audit log and the
 * refusals on its routes, newest first. Metadata only: who did what, when, to which conversation, message, file,
 * announcement or meeting, with the reason given; never what a message, file, agenda or note says.
 */
function AuditCard() {
  const [action, setAction] = React.useState("");
  const [deniedOnly, setDeniedOnly] = React.useState(false);
  const q = useCommsAudit({ action: action || undefined, outcome: deniedOnly ? "denied" : undefined }, true);
  const rows = q.data?.pages.flatMap((p) => p.items) ?? [];
  return (
    <section className="mt-6 rounded-xl border border-border bg-card p-4" aria-label="Security and audit events">
      <h2 className="mb-1 text-[14px] font-semibold">Security and audit events</h2>
      <p className="mb-3 text-[12.5px] text-muted-foreground">Who did what in Messages, Announcements and Meetings, refused attempts and malware findings. The content of messages, files, agendas and notes is never recorded here.</p>
      <div className="mb-3 flex flex-wrap items-end gap-3">
        <Field label="Show" htmlFor="audit-group">
          <NativeSelect id="audit-group" value={action} onChange={(e) => setAction(e.target.value)}>
            {AUDIT_GROUPS.map((g) => (
              <option key={g.value} value={g.value}>
                {g.label}
              </option>
            ))}
          </NativeSelect>
        </Field>
        <label className="flex items-center gap-2 pb-2 text-[13px]">
          <input type="checkbox" checked={deniedOnly} onChange={(e) => setDeniedOnly(e.target.checked)} /> Refused only
        </label>
      </div>
      {q.isPending ? (
        <ListSkeleton rows={4} />
      ) : q.isError ? (
        <ErrorState error={q.error} onRetry={() => q.refetch()} />
      ) : rows.length === 0 ? (
        <p className="text-[13px] text-muted-foreground">Nothing recorded for this filter.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[720px] text-[12.5px]">
            <thead className="border-b border-border text-left text-[11.5px] text-muted-foreground">
              <tr>
                <th className="px-2 py-1.5 font-medium">When</th>
                <th className="px-2 py-1.5 font-medium">Who</th>
                <th className="px-2 py-1.5 font-medium">What</th>
                <th className="px-2 py-1.5 font-medium">Target</th>
                <th className="px-2 py-1.5 font-medium">Reason and details</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} className="border-b border-border last:border-0 align-top">
                  <td className="whitespace-nowrap px-2 py-1.5 tabular">{formatDateTime(r.at)}</td>
                  <td className="px-2 py-1.5 font-mono">{r.actorEmpId ?? "system"}</td>
                  <td className="px-2 py-1.5">
                    <span className="font-mono">{r.action}</span>
                    {r.outcome === "denied" && (
                      <Badge tone="outline" className="ml-1.5 text-[10.5px]">
                        Refused
                      </Badge>
                    )}
                  </td>
                  <td className="max-w-48 truncate px-2 py-1.5 font-mono" title={r.targetId ?? ""}>
                    {r.targetType}
                    {r.targetId ? ` · ${r.targetId}` : ""}
                  </td>
                  <td className="px-2 py-1.5 text-muted-foreground">{[r.reason, detailText(r.details)].filter(Boolean).join(" · ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {q.hasNextPage && (
            <div className="mt-3 flex justify-center">
              <Button size="sm" variant="outline" onClick={() => void q.fetchNextPage()} loading={q.isFetchingNextPage}>
                Load more
              </Button>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
