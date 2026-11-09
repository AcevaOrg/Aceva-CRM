"use client";
import * as React from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { toast } from "sonner";
import { CornerDownLeft, Lock, Paperclip, Plus, Send, Trash2, X } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { NativeSelect, SegmentedControl } from "@/components/ui/controls";
import { Field } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/overlays";
import { RequireAccess } from "@/components/shared/can";
import { EmployeeSelect } from "@/components/shared/pickers";
import { ListSkeleton } from "@/components/shared/states";
import { FileCard } from "@/components/shared/timeline";
import { useLookup } from "@/hooks/use-directory";
import { useViewer } from "@/lib/auth/viewer";
import { formatMonthKey } from "@/lib/dates";
import { formatMoney } from "@/lib/format";
import { useUi } from "@/lib/ui-store";
import { cn, uid } from "@/lib/utils";
import type { Attachment, Currency } from "@/types";
import { useAccounts, useEntry, useFinanceProjects, useParties, usePeriods, useRates, useSaveEntry } from "../hooks";
import type { JournalEntry } from "../types";
import { approverFor, balanceCheck, LEVEL_APPROVER_TITLE, monthKeyOf, num, requiredLevel, round2, touchesCapitalOrLoan } from "../logic";
import { AccountPicker } from "./account-picker";
import { BalanceMeter } from "./balance-meter";
import { ApprovalLevelChip } from "./ledger-bits";

interface DraftLine {
  key: string;
  accountId: string;
  description: string;
  debit: string;
  credit: string;
  partyId: string;
  empId: string;
}

const blank = (): DraftLine => ({ key: uid("l"), accountId: "", description: "", debit: "", credit: "", partyId: "", empId: "" });

function todayYmd() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export function EntryComposerScreen() {
  return (
    <RequireAccess permission="finance.entry_create" mode="404">
      <EntryComposer />
    </RequireAccess>
  );
}

function EntryComposer() {
  const params = useSearchParams();
  const editId = params.get("edit") ?? undefined;
  const existing = useEntry(editId);
  if (editId && existing.isPending) return <ListSkeleton rows={8} />;
  const draft = existing.data?.status === "draft" ? existing.data : undefined;
  return <ComposerForm key={draft?.id ?? "new"} draft={draft} notEditable={existing.data && !draft ? existing.data : undefined} />;
}

function toYmd(iso: string) {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function ComposerForm({ draft, notEditable }: { draft?: JournalEntry; notEditable?: JournalEntry }) {
  const router = useRouter();
  const viewer = useViewer();
  const lookup = useLookup();
  const accountsQ = useAccounts();
  const parties = useParties();
  const projects = useFinanceProjects();
  const periods = usePeriods();
  const rates = useRates();
  const save = useSaveEntry();
  const sidebarCollapsed = useUi((s) => s.sidebarCollapsed);

  // A loaded draft initialises the form once (the component is keyed by the draft id).
  const [date, setDate] = React.useState(() => (draft ? toYmd(draft.date) : todayYmd()));
  const [description, setDescription] = React.useState(draft?.description ?? "");
  const [projectId, setProjectId] = React.useState(draft?.projectId ?? "");
  const [currency, setCurrency] = React.useState<Currency>(draft?.currency ?? "PKR");
  const [rateInput, setRate] = React.useState<string | null>(draft && draft.currency === "USD" ? draft.exchangeRate : null);
  const [lines, setLines] = React.useState<DraftLine[]>(() =>
    draft
      ? draft.lines.map((l) => ({
          key: uid("l"),
          accountId: l.accountId,
          description: l.description ?? "",
          debit: num(l.debit) ? String(num(l.debit)) : "",
          credit: num(l.credit) ? String(num(l.credit)) : "",
          partyId: l.partyId ?? "",
          empId: l.empId ?? "",
        }))
      : [blank(), blank()],
  );
  const [attachments, setAttachments] = React.useState<Attachment[]>(draft?.attachments ?? []);
  const [tried, setTried] = React.useState(false);
  const fileRef = React.useRef<HTMLInputElement>(null);

  const latestRate = rates.data?.[rates.data.length - 1]?.rate;
  const rate = rateInput ?? latestRate ?? "";

  const accounts = accountsQ.data ?? [];
  const me = viewer?.employee.empId ?? "";
  const fxRate = currency === "PKR" ? 1 : num(rate) || 1;
  const check = balanceCheck(lines.map((l) => ({ debit: l.debit || "0", credit: l.credit || "0", accountId: l.accountId })));
  const baseTotal = round2(check.debit * fxRate);
  const capital = touchesCapitalOrLoan(lines.filter((l) => l.accountId), accounts);
  const level = requiredLevel(baseTotal, capital);
  const route = approverFor(level, me, lookup.employees);
  const approver = lookup.employee(route.empId);
  const month = date ? monthKeyOf(new Date(`${date}T12:00:00`)) : "";
  const period = periods.data?.find((p) => p.month === month);
  const locked = period?.status === "closed" || period?.status === "closing";
  const usedLines = lines.filter((l) => l.accountId || num(l.debit) || num(l.credit));

  const update = (key: string, patch: Partial<DraftLine>) =>
    setLines((ls) =>
      ls.map((l) => {
        if (l.key !== key) return l;
        const next = { ...l, ...patch };
        if (patch.debit && num(patch.debit) > 0) next.credit = "";
        if (patch.credit && num(patch.credit) > 0) next.debit = "";
        return next;
      }),
    );

  const addLine = (focus = true) => {
    const l = blank();
    // Pre-fill the amount that balances the entry.
    if (check.debit !== check.credit) {
      const d = round2(check.debit - check.credit);
      if (d > 0) l.credit = String(d);
      else l.debit = String(-d);
    }
    setLines((ls) => [...ls, l]);
    if (focus) setTimeout(() => document.getElementById(`acct-${l.key}`)?.focus(), 30);
  };

  const onEnter = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      addLine();
    }
  };

  const submit = async (send: boolean) => {
    setTried(true);
    if (!description.trim()) return toast.error("Add a description for the entry.");
    if (send && !check.ok) return toast.error(check.problems[0] ?? "The entry isn't balanced yet.");
    try {
      const entry = await save.mutateAsync({
        draftId: draft?.id,
        date: new Date(`${date}T12:00:00`).toISOString(),
        description: description.trim(),
        projectId: projectId || undefined,
        currency,
        exchangeRate: currency === "PKR" ? "1" : String(fxRate),
        attachments,
        submit: send,
        lines: usedLines.map((l) => ({
          accountId: l.accountId,
          description: l.description || undefined,
          debit: (num(l.debit) || 0).toFixed(2),
          credit: (num(l.credit) || 0).toFixed(2),
          partyId: l.partyId || undefined,
          empId: l.empId || undefined,
        })),
      });
      toast.success(send ? `${entry.number} sent for approval` : `${entry.number} saved as a draft`, {
        description: send ? `It goes to ${lookup.employee(entry.approverEmpId)?.name ?? "the approver"} (${LEVEL_APPROVER_TITLE[entry.requiredApproverLevel]}).` : "You can finish it later from the ledger.",
      });
      router.push(`/finance/ledger/${entry.id}`);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Couldn't save the entry.");
    }
  };

  const editing = draft;

  return (
    <>
      <PageHeader
        title={editing ? `Edit draft ${editing.number}` : "New journal entry"}
        description="Debits must equal credits before the entry can be submitted. Press Enter in any line to add another."
        back={{ href: editing ? `/finance/ledger/${editing.id}` : "/finance/ledger", label: editing ? editing.number : "Ledger" }}
        seal="highly"
      />

      {notEditable && (
        <p className="mb-4 rounded-lg border border-warning/40 bg-warning/12 px-3 py-2 text-[13px]">
          {notEditable.number} is {notEditable.status.replace("_", " ")}, so it can&apos;t be edited. This form starts a new entry instead.
        </p>
      )}

      <div className="grid gap-5 pb-40">
        <Card className="grid gap-4 p-5 md:grid-cols-2 xl:grid-cols-[160px_minmax(0,1fr)_minmax(0,0.8fr)_auto_140px]">
          <Field label="Date" htmlFor="je-date" required error={locked ? "This month is closed" : undefined}>
            <Input id="je-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-invalid={locked || undefined} />
          </Field>
          <Field label="Description" htmlFor="je-desc" required error={tried && !description.trim() ? "Required" : undefined}>
            <Input id="je-desc" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Annual hosting prepayment" />
          </Field>
          <Field label="Project or client" htmlFor="je-project" hint="Optional: shows profit by project">
            <NativeSelect id="je-project" value={projectId} onChange={(e) => setProjectId(e.target.value)}>
              <option value="">No project</option>
              {(projects.data ?? []).map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </NativeSelect>
          </Field>
          <Field label="Currency">
            <SegmentedControl value={currency} onChange={setCurrency} options={[{ value: "PKR", label: "PKR" }, { value: "USD", label: "USD" }]} ariaLabel="Currency" />
          </Field>
          <Field label="Rate (PKR per USD)" htmlFor="je-rate" hint={currency === "USD" ? "Saved on the entry" : "Only for USD"}>
            <Input id="je-rate" inputMode="decimal" value={currency === "PKR" ? "1.00" : rate} disabled={currency === "PKR"} onChange={(e) => setRate(e.target.value)} className="font-mono" />
          </Field>
        </Card>

        {locked && (
          <div role="alert" className="flex items-start gap-3 rounded-xl border border-danger/30 bg-danger/8 px-4 py-3 text-[13px]">
            <Lock className="mt-0.5 size-4 shrink-0 text-danger" />
            <p>
              <span className="font-semibold">{formatMonthKey(month)} is closed.</span> Entries can&apos;t be dated in a closed month. Ask the CEO or Owner to reopen it (the reopening is logged and alerted), or date the entry in an open month.
            </p>
          </div>
        )}

        <Card className="overflow-hidden">
          <div className="hidden grid-cols-[minmax(220px,1.5fr)_minmax(140px,1fr)_130px_130px_minmax(150px,1fr)_minmax(150px,1fr)_40px] gap-2 border-b border-border bg-muted/50 px-4 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground xl:grid">
            <span>Account</span>
            <span>Line description</span>
            <span className="text-right">Debit ({currency})</span>
            <span className="text-right">Credit ({currency})</span>
            <span>Client or vendor</span>
            <span>Employee</span>
            <span />
          </div>
          <ul className="divide-y divide-border">
            {lines.map((l, i) => {
              const lineInvalid = tried && (num(l.debit) > 0 || num(l.credit) > 0) && !l.accountId;
              return (
                <li key={l.key} className="grid gap-2 px-4 py-3 sm:grid-cols-2 xl:grid-cols-[minmax(220px,1.5fr)_minmax(140px,1fr)_130px_130px_minmax(150px,1fr)_minmax(150px,1fr)_40px] xl:items-center">
                  <div className="sm:col-span-2 xl:col-span-1">
                    <span className="mb-1 block text-[11px] font-semibold uppercase tracking-wider text-muted-foreground xl:hidden">Line {i + 1}</span>
                    <AccountPicker id={`acct-${l.key}`} accounts={accounts} value={l.accountId} onChange={(id) => update(l.key, { accountId: id })} invalid={lineInvalid} />
                  </div>
                  <Input value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} onKeyDown={onEnter} placeholder="Optional" aria-label={`Line ${i + 1} description`} className="sm:col-span-2 xl:col-span-1" />
                  <Input inputMode="decimal" value={l.debit} onChange={(e) => update(l.key, { debit: e.target.value.replace(/[^\d.]/g, "") })} onKeyDown={onEnter} placeholder="Debit" aria-label={`Line ${i + 1} debit`} className="text-right font-mono" />
                  <Input inputMode="decimal" value={l.credit} onChange={(e) => update(l.key, { credit: e.target.value.replace(/[^\d.]/g, "") })} onKeyDown={onEnter} placeholder="Credit" aria-label={`Line ${i + 1} credit`} className="text-right font-mono" />
                  <NativeSelect value={l.partyId} onChange={(e) => update(l.key, { partyId: e.target.value })} aria-label={`Line ${i + 1} client or vendor`}>
                    <option value="">No client or vendor</option>
                    <optgroup label="Clients">
                      {(parties.data ?? []).filter((p) => p.kind === "client").map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                    <optgroup label="Vendors">
                      {(parties.data ?? []).filter((p) => p.kind === "vendor").map((p) => (
                        <option key={p.id} value={p.id}>
                          {p.name}
                        </option>
                      ))}
                    </optgroup>
                  </NativeSelect>
                  <EmployeeSelect value={l.empId} onChange={(v) => update(l.key, { empId: v })} placeholder="No employee" />
                  <Tip content="Remove line">
                    <Button size="icon-sm" variant="ghost" onClick={() => setLines((ls) => (ls.length > 2 ? ls.filter((x) => x.key !== l.key) : ls.map((x) => (x.key === l.key ? blank() : x))))} aria-label={`Remove line ${i + 1}`} className="justify-self-end">
                      <Trash2 />
                    </Button>
                  </Tip>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-3">
            <Button variant="outline" size="sm" onClick={() => addLine()}>
              <Plus /> Add line
            </Button>
            <p className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
              <CornerDownLeft className="size-3.5" /> Enter adds a line pre-filled with the amount that balances the entry
            </p>
          </div>
        </Card>

        <Card className="grid gap-3 p-5">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-[14px] font-semibold">Receipt or supporting file</p>
              <p className="text-[12.5px] text-muted-foreground">PDF or image. Stored privately; opened only through links that expire in minutes.</p>
            </div>
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()}>
              <Paperclip /> Attach file
            </Button>
            <input
              ref={fileRef}
              type="file"
              accept=".pdf,image/*"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (!f) return;
                setAttachments((a) => [...a, { id: uid("att"), fileName: f.name, sizeBytes: f.size, mimeType: f.type, uploadedAt: new Date().toISOString(), uploadedBy: me }]);
                e.target.value = "";
              }}
            />
          </div>
          {attachments.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {attachments.map((a) => (
                <div key={a.id} className="relative">
                  <FileCard file={a} />
                  <button className="absolute right-2 top-2 rounded p-1 text-muted-foreground hover:bg-muted" onClick={() => setAttachments((x) => x.filter((y) => y.id !== a.id))} aria-label={`Remove ${a.fileName}`}>
                    <X className="size-3.5" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>

      {/* Sticky footer: balance meter, approval routing, actions */}
      <div className={cn("fixed inset-x-0 bottom-0 z-20 border-t border-border bg-background/92 backdrop-blur-md lg:left-[72px]", !sidebarCollapsed && "xl:left-[264px]")}>
        <div className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4 py-3 sm:px-6 lg:px-8">
          <BalanceMeter debit={check.debit} credit={check.credit} currency={currency} />
          <div className="grid min-w-0 flex-1 gap-1 text-[12.5px]">
            {check.debit > 0 ? (
              <>
                <span className="flex flex-wrap items-center gap-2">
                  <ApprovalLevelChip level={route.level} />
                  <span className="text-muted-foreground">
                    {formatMoney(baseTotal, { exact: true })}
                    {capital ? " · share capital or loan" : ""}
                  </span>
                </span>
                <span className="text-muted-foreground">
                  Goes to <span className="font-medium text-foreground">{approver?.name ?? "the approver"}</span>
                  {route.routedUp ? " (one level up, because nobody approves their own entry)" : ""}.
                </span>
              </>
            ) : (
              <span className="text-muted-foreground">Up to PKR 50,000 → Director · up to 500,000 → CEO · above, and capital or loans → Owner</span>
            )}
          </div>
          <div className="ml-auto flex gap-2">
            <Button variant="outline" onClick={() => submit(false)} loading={save.isPending && !save.variables?.submit} disabled={locked || save.isPending}>
              Save draft
            </Button>
            <Tip content={!check.ok ? (check.problems[0] ?? "Balance the entry first") : undefined}>
              <span>
                <Button onClick={() => submit(true)} disabled={!check.ok || locked || save.isPending} loading={save.isPending && !!save.variables?.submit}>
                  <Send /> Submit for approval
                </Button>
              </span>
            </Tip>
          </div>
        </div>
      </div>
    </>
  );
}
