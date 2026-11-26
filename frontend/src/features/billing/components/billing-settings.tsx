"use client";
import * as React from "react";
import { toast } from "sonner";
import { Mail, Settings2, TriangleAlert, UserPlus } from "lucide-react";
import type { BillingSettings } from "@aceva/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { SegmentedControl, Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { Can } from "@/components/shared/can";
import { useReason, useStepUp } from "@/components/shared/dialogs";
import { ErrorState } from "@/components/shared/states";
import { ApiError } from "@/lib/api/mock";
import { useCan } from "@/lib/auth/viewer";
import { formatDateTime } from "@/lib/dates";
import { useBillingSettings, useCreateCustomer, useSaveBillingSettings } from "../hooks";
import { reminderLabel } from "../logic";

const COMPANY_FIELDS: Array<{ key: keyof BillingSettings["company"]; label: string; multiline?: boolean; hint?: string }> = [
  { key: "legalName", label: "Legal name", hint: "Printed at the top of every invoice." },
  { key: "address", label: "Address", multiline: true },
  { key: "email", label: "Email on invoices" },
  { key: "phone", label: "Phone" },
  { key: "taxNumbers", label: "Tax numbers (NTN / STRN)" },
  { key: "paymentDetails", label: "How to pay (bank details)", multiline: true, hint: "Printed under \"Pay to\". Never store a card number here." },
];

/**
 * Module 13 settings (module "billing"): the company details printed on invoices, the address customer emails are sent
 * from, and the reminder timing. Nothing is filled in for you: management enters the real values. Billing viewers see
 * them; the Director changes them (settings.manage), with a reason and "confirm again".
 */
export function BillingSettingsPanel() {
  const q = useBillingSettings();
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-96 w-full rounded-xl" />;
  // A new version from the server starts a fresh form.
  return <SettingsForm key={q.data.version} meta={q.data} />;
}

function SettingsForm({ meta }: { meta: { value: BillingSettings; version: number; updatedAt: string | null; updatedByEmpId: string | null } }) {
  const save = useSaveBillingSettings();
  const canManage = useCan("settings.manage");
  const stepUp = useStepUp();
  const askReason = useReason();
  const [draft, setDraft] = React.useState<BillingSettings>(() => structuredClone(meta.value));
  const s = draft;
  const setCompany = (k: keyof BillingSettings["company"], v: string) => setDraft({ ...s, company: { ...s.company, [k]: v.trim() ? v : null } });
  const setEmails = (patch: Partial<BillingSettings["customerEmails"]>) => setDraft({ ...s, customerEmails: { ...s.customerEmails, ...patch } });
  const missing = [!s.company.legalName && "the company legal name", !s.customerEmails.fromAddress && "the sending address"].filter(Boolean) as string[];

  const onSave = async () => {
    const reason = await askReason({ title: "Save billing settings", description: "Saved in the audit log with the old and new values.", confirmLabel: "Save" });
    if (!reason) return;
    if (!(await stepUp({ action: "Change billing settings", detail: "Company details and customer emails" }))) return;
    try {
      await save.mutateAsync({ value: s, version: meta.version, reason });
      toast.success("Billing settings saved");
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't save the settings.");
    }
  };

  return (
    <div className="grid items-start gap-5 xl:grid-cols-2">
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Company details on invoices</CardTitle>
            <CardDescription>Only what is filled in here is printed. Nothing is made up.</CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4">
          {COMPANY_FIELDS.map((f) => (
            <Field key={f.key} label={f.label} htmlFor={`bs-${f.key}`} hint={f.hint}>
              {f.multiline ? (
                <Textarea id={`bs-${f.key}`} rows={2} value={s.company[f.key] ?? ""} onChange={(e) => setCompany(f.key, e.target.value)} disabled={!canManage} />
              ) : (
                <Input id={`bs-${f.key}`} value={s.company[f.key] ?? ""} onChange={(e) => setCompany(f.key, e.target.value)} disabled={!canManage} />
              )}
            </Field>
          ))}
        </CardContent>
      </Card>

      <div className="grid gap-5">
        <Card>
          <CardHeader>
            <div>
              <CardTitle>Customer emails</CardTitle>
              <CardDescription>The invoice and the reminders to the client. Staff reminders go through notifications either way.</CardDescription>
            </div>
            <Badge tone={s.customerEmails.enabled ? "success" : "neutral"}>
              <Mail /> {s.customerEmails.enabled ? "On" : "Off"}
            </Badge>
          </CardHeader>
          <CardContent className="grid gap-4">
            {missing.length > 0 && (
              <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-[12.5px]">
                <TriangleAlert className="mt-0.5 size-4 shrink-0" /> Customer emails stay off until {missing.join(" and ")} {missing.length === 1 ? "is" : "are"} entered. Use a real Aceva mailbox.
              </p>
            )}
            <Field label="Send from" htmlFor="bs-from" hint="For example a billing mailbox on the company domain.">
              <Input id="bs-from" type="email" value={s.customerEmails.fromAddress ?? ""} onChange={(e) => setEmails({ fromAddress: e.target.value.trim() || null })} disabled={!canManage} />
            </Field>
            <Field label="Replies go to (optional)" htmlFor="bs-reply">
              <Input id="bs-reply" type="email" value={s.customerEmails.replyTo ?? ""} onChange={(e) => setEmails({ replyTo: e.target.value.trim() || null })} disabled={!canManage} />
            </Field>
            <label className="flex items-center gap-3 text-[13px]">
              <Switch checked={s.customerEmails.enabled} onCheckedChange={(c) => setEmails({ enabled: c })} disabled={!canManage || (missing.length > 0 && !s.customerEmails.enabled)} aria-label="Customer emails" />
              Send invoices and reminders to clients by email
            </label>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <div>
              <CardTitle>Defaults</CardTitle>
              <CardDescription>
                Used for new invoices; each invoice can change its own reminders and terms. 14 days and account 4100 are development defaults, not confirmed
                accounting policy.
              </CardDescription>
            </div>
          </CardHeader>
          <CardContent className="grid gap-4">
            <p className="text-[13px]">
              <span className="text-muted-foreground">Reminders: </span>
              {s.reminderOffsets.map((o) => reminderLabel(o).toLowerCase()).join(", ")}
            </p>
            <div className="grid gap-4 sm:grid-cols-2">
              <Field label="Payment terms (days)" htmlFor="bs-terms">
                <Input id="bs-terms" inputMode="numeric" value={String(s.defaultTermsDays)} onChange={(e) => /^\d{0,3}$/.test(e.target.value) && setDraft({ ...s, defaultTermsDays: Number(e.target.value || 0) })} disabled={!canManage} />
              </Field>
              <Field label="Default income account" htmlFor="bs-income" hint="Account code from the chart of accounts.">
                <Input id="bs-income" value={s.defaultIncomeAccountCode ?? ""} onChange={(e) => setDraft({ ...s, defaultIncomeAccountCode: e.target.value.trim() || null })} disabled={!canManage} />
              </Field>
            </div>
            {meta.updatedAt && (
              <p className="text-[12px] text-muted-foreground">
                Last changed {formatDateTime(meta.updatedAt)}
                {meta.updatedByEmpId ? ` by ${meta.updatedByEmpId}` : ""}
              </p>
            )}
            <Can permission="settings.manage" fallback={<p className="text-[12.5px] text-muted-foreground">View only. The Director changes these settings.</p>}>
              <Button className="w-fit" onClick={onSave} loading={save.isPending}>
                <Settings2 /> Save settings
              </Button>
            </Can>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}

/** A new client (a Module 9 client with its billing details). */
export function NewCustomerDialog({ onClose }: { onClose: () => void }) {
  const create = useCreateCustomer();
  const [v, setV] = React.useState({ name: "", contactName: "", email: "", country: "", address: "", taxId: "", termsDays: "14", currency: "PKR" as "PKR" | "USD" });
  const ok = v.name.trim().length > 1 && /^\d{1,3}$/.test(v.termsDays) && (!v.email || /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(v.email));
  const field = (k: keyof typeof v) => ({ value: v[k], onChange: (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setV({ ...v, [k]: e.target.value }) });
  const run = async () => {
    try {
      const c = await create.mutateAsync({ name: v.name.trim(), contactName: v.contactName.trim(), email: v.email.trim(), country: v.country.trim(), address: v.address.trim(), taxId: v.taxId.trim(), termsDays: Number(v.termsDays), currency: v.currency });
      toast.success(`${c.name} added`);
      onClose();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : "Couldn't add the client.");
    }
  };
  return (
    <Dialog open onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="md">
        <DialogHeader>
          <DialogTitle>New client</DialogTitle>
          <DialogDescription>The client is added to the finance ledger&apos;s client list with its billing details.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" htmlFor="nc-name" required>
            <Input id="nc-name" autoFocus {...field("name")} />
          </Field>
          <Field label="Contact person" htmlFor="nc-contact">
            <Input id="nc-contact" {...field("contactName")} />
          </Field>
          <Field label="Billing email" htmlFor="nc-email" hint="Invoices and reminders go here.">
            <Input id="nc-email" type="email" {...field("email")} />
          </Field>
          <Field label="Country" htmlFor="nc-country">
            <Input id="nc-country" {...field("country")} />
          </Field>
          <Field label="Address" htmlFor="nc-address" className="sm:col-span-2">
            <Textarea id="nc-address" rows={2} {...field("address")} />
          </Field>
          <Field label="Tax ID (optional)" htmlFor="nc-tax">
            <Input id="nc-tax" {...field("taxId")} />
          </Field>
          <Field label="Payment terms (days)" htmlFor="nc-terms">
            <Input id="nc-terms" inputMode="numeric" {...field("termsDays")} />
          </Field>
          <Field label="Currency">
            <SegmentedControl value={v.currency} onChange={(c) => setV({ ...v, currency: c })} ariaLabel="Currency" options={[{ value: "PKR", label: "PKR" }, { value: "USD", label: "USD" }]} />
          </Field>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Cancel
          </Button>
          <Button onClick={run} disabled={!ok} loading={create.isPending}>
            <UserPlus /> Add client
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
