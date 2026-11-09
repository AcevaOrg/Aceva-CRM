"use client";
/** Settings sections: finance, security, alerts, retention, backups, sales, links. */
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import { ArrowRight, CircleCheck, CircleX, DatabaseBackup, HardDrive, ListTree, Lock, Plug, Plus, ShieldCheck, Trash2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect, Switch } from "@/components/ui/controls";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { MakerCheckerNote } from "@/components/shared/approval-relay";
import { EmpChip } from "@/components/shared/emp-chip";
import { StatCard } from "@/components/shared/metrics";
import { ErrorState } from "@/components/shared/states";
import { useViewer } from "@/lib/auth/viewer";
import { formatDate, formatDateTime, formatRelative, formatTime } from "@/lib/dates";
import { formatMoneyCompact } from "@/lib/format";
import type { TaxSlab } from "@/features/payroll/types";
import { canRunBackup } from "../api";
import { useBackupStatus, useRunBackup } from "../hooks";
import { ChipsEditor, NumberInput, SettingsSection } from "./settings-kit";
import { SettingRow } from "./settings-sections-work";

/* ---------------- Approval limits ★ ---------------- */

/**
 * Journal entry approval (plan §13): Finance makes entries and the Director approves every one, any amount.
 * There is no CEO tier: the CEO / Founder / Owner is only notified (view only) of entries above ceoNotifiedAbove
 * and, when the switch is on, of every capital and loan entry. Maker-checker always applies.
 */
type Limits = { ceoNotifiedAbove: number; capitalAndLoansNotifyCeo: boolean; blockIfDirectorMade: boolean };

export function ApprovalLimitsSection() {
  return (
    <SettingsSection<Limits> section="approval-limits">
      {(d, set, can) => (
        <>
          <div className="grid gap-2 sm:grid-cols-2">
            {[
              { tag: "Approves", who: "Director", range: "Every journal entry Finance makes, any amount." },
              {
                tag: "Notified · view only",
                who: "CEO / Founder / Owner",
                range: `Entries above ${formatMoneyCompact(d.ceoNotifiedAbove)}${d.capitalAndLoansNotifyCeo ? " and every capital or loan entry" : ""}. Approves nothing.`,
              },
            ].map((t) => (
              <div key={t.who} className="rounded-xl border border-border bg-muted/40 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">{t.tag}</p>
                <p className="mt-1 font-semibold">{t.who}</p>
                <p className="text-[12.5px] text-muted-foreground">{t.range}</p>
              </div>
            ))}
          </div>
          <SettingRow label="Notify the CEO / Founder / Owner above" hint="Entries above this amount (PKR) are flagged “CEO / Founder / Owner notified”. The Director still approves them.">
            <NumberInput value={d.ceoNotifiedAbove} onChange={(n) => set({ ceoNotifiedAbove: n })} suffix="PKR" step={10000} disabled={!can} />
          </SettingRow>
          <SettingRow label="Notify the CEO / Founder / Owner of capital and loan entries" hint="Regardless of amount (plan §13). View only; the Director approves.">
            <Switch checked={d.capitalAndLoansNotifyCeo} disabled={!can} onCheckedChange={(v) => set({ capitalAndLoansNotifyCeo: v })} aria-label="Notify the CEO / Founder / Owner of capital and loan entries" />
          </SettingRow>
          <SettingRow
            label="Block entries the Director made"
            hint="Maker-checker: nobody approves their own entry. Finance makes entries and the Director approves them. The Director doesn't make entries; if one is made, nobody else can approve it, so it is blocked. This rule can't be turned off."
          >
            <Switch checked disabled aria-label="Block entries the Director made" />
          </SettingRow>
          {d.ceoNotifiedAbove <= 0 && <p className="text-[12.5px] text-danger">The notification amount must be more than zero.</p>}
        </>
      )}
    </SettingsSection>
  );
}

/* ---------------- Currencies ---------------- */

type Currencies = { base: string; secondary: string; revalueAtMonthEnd: boolean; rates: { date: string; rate: number; by: string }[] };

export function CurrenciesSection() {
  const [rate, setRate] = React.useState("");
  const me = useViewer()?.employee.empId ?? "";
  return (
    <SettingsSection<Currencies> section="currencies">
      {(d, set, can) => (
        <>
          <SettingRow label="Main currency" hint="All statements are kept in PKR.">
            <Badge tone="finance" className="text-[13px]">PKR · Pakistani rupee</Badge>
          </SettingRow>
          <SettingRow label="Second currency" hint="Each USD entry saves the rate used.">
            <Badge tone="neutral" className="text-[13px]">USD · US dollar</Badge>
          </SettingRow>
          <SettingRow label="Revalue USD balances at month end" hint="The gain or loss is posted during month close.">
            <Switch checked={d.revalueAtMonthEnd} disabled={!can} onCheckedChange={(v) => set({ revalueAtMonthEnd: v })} aria-label="Revalue at month end" />
          </SettingRow>
          <div className="grid gap-2">
            <p className="text-[13px] font-medium">USD → PKR rates</p>
            <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border text-[13px]">
              {d.rates.map((r, i) => (
                <li key={r.date + i} className="flex items-center justify-between gap-3 px-4 py-2">
                  <span className="w-32 text-muted-foreground">{formatDate(r.date)}</span>
                  <span className="font-mono font-semibold tabular">1 USD = {r.rate.toFixed(2)} PKR</span>
                  <EmpChip empId={r.by} size="sm" showId={false} />
                  {i === 0 && <Badge tone="success">Current</Badge>}
                </li>
              ))}
            </ul>
            {can && (
              <div className="flex max-w-md gap-2">
                <Input inputMode="decimal" value={rate} onChange={(e) => setRate(e.target.value.replace(/[^\d.]/g, ""))} placeholder="281.50" className="font-mono" aria-label="New USD rate" />
                <Button
                  variant="outline"
                  disabled={!Number(rate)}
                  onClick={() => {
                    set({ rates: [{ date: new Date().toISOString().slice(0, 10), rate: Number(rate), by: me }, ...d.rates] });
                    setRate("");
                  }}
                >
                  <Plus /> Add today&apos;s rate
                </Button>
              </div>
            )}
          </div>
        </>
      )}
    </SettingsSection>
  );
}

/* ---------------- Finance year ---------------- */

type FinanceYear = { startMonth: string; startDay: string; currentLabel: string; reportingFramework: string };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

export function FinanceYearSection() {
  return (
    <SettingsSection<FinanceYear> section="finance-year">
      {(d, set, can) => (
        <>
          <SettingRow label="Finance year starts" hint="Pakistan's normal tax year runs from 1 July to 30 June. The accountant confirms.">
            <NativeSelect value={d.startMonth} disabled={!can} onChange={(e) => set({ startMonth: e.target.value })} aria-label="Start month">
              {MONTHS.map((m, i) => (
                <option key={m} value={String(i + 1).padStart(2, "0")}>
                  1 {m}
                </option>
              ))}
            </NativeSelect>
          </SettingRow>
          <SettingRow label="Current finance year">
            <p className="text-[13px] font-medium">{d.currentLabel}</p>
          </SettingRow>
          <SettingRow label="Statement layout" hint="So the PDFs match what the auditor expects.">
            <Input value={d.reportingFramework} disabled={!can} onChange={(e) => set({ reportingFramework: e.target.value })} aria-label="Reporting framework" />
          </SettingRow>
        </>
      )}
    </SettingsSection>
  );
}

/* ---------------- Tax slabs ---------------- */

export function TaxSlabsSection() {
  return (
    <SettingsSection<{ slabs: TaxSlab[] }> section="tax-slabs">
      {(d, set, can) => {
        const update = (i: number, patch: Partial<TaxSlab>) => set({ slabs: d.slabs.map((s, j) => (j === i ? { ...s, ...patch } : s)) });
        return (
          <>
            <div className="overflow-x-auto rounded-lg border border-border">
              <table className="w-full min-w-[620px] text-[13px]">
                <thead>
                  <tr className="border-b border-border bg-muted/50 text-left text-[11px] uppercase tracking-wider text-muted-foreground">
                    <th className="px-3 py-2">Yearly income from</th>
                    <th className="px-3 py-2">Up to</th>
                    <th className="px-3 py-2">Fixed tax</th>
                    <th className="px-3 py-2">Rate on amount over “from”</th>
                    <th className="w-10" />
                  </tr>
                </thead>
                <tbody>
                  {d.slabs.map((s, i) => (
                    <tr key={i} className="border-b border-border last:border-0">
                      <td className="px-3 py-2">
                        <NumberInput value={s.from} onChange={(n) => update(i, { from: n })} suffix="PKR" step={1000} disabled={!can} />
                      </td>
                      <td className="px-3 py-2">
                        {s.to === null ? <span className="text-muted-foreground">No limit</span> : <NumberInput value={s.to} onChange={(n) => update(i, { to: n })} suffix="PKR" step={1000} disabled={!can} />}
                      </td>
                      <td className="px-3 py-2">
                        <NumberInput value={s.fixed} onChange={(n) => update(i, { fixed: n })} suffix="PKR" step={1000} disabled={!can} />
                      </td>
                      <td className="w-36 px-3 py-2">
                        <NumberInput value={Math.round(s.rate * 1000) / 10} onChange={(n) => update(i, { rate: n / 100 })} suffix="%" step={0.5} disabled={!can} />
                      </td>
                      <td className="px-2">
                        {can && i === d.slabs.length - 1 && d.slabs.length > 1 && (
                          <Button size="icon-sm" variant="ghost" aria-label="Remove last slab" onClick={() => set({ slabs: d.slabs.slice(0, -1).map((x, j, arr) => (j === arr.length - 1 ? { ...x, to: null } : x)) })}>
                            <Trash2 />
                          </Button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-[12px] text-muted-foreground">Payroll uses these slabs from the next calculation. Approved runs keep the tax they were approved with.</p>
          </>
        );
      }}
    </SettingsSection>
  );
}

/* ---------------- Security ★ ---------------- */

type Security = { minLength: number; historyCount: number; lockoutAttempts: number; idleMinutes: number; financeIdleMinutes: number; maxSessionHours: number; resetLinkMinutes: number; twoFactorFor: string; rememberMeForFinance: boolean; officeOnlyFinance: boolean };

export function SecuritySection() {
  return (
    <SettingsSection<Security> section="security">
      {(d, set, can) => (
        <>
          <SettingRow label="Password" hint="Minimum length and how many old passwords can't be reused.">
            <div className="grid grid-cols-2 gap-2">
              <NumberInput value={d.minLength} onChange={(n) => set({ minLength: Math.max(10, n) })} min={10} suffix="characters" disabled={!can} />
              <NumberInput value={d.historyCount} onChange={(n) => set({ historyCount: n })} suffix="remembered" disabled={!can} />
            </div>
          </SettingRow>
          <SettingRow label="Lock the account after" hint="The person's manager or the Director (HR duty) unlocks it.">
            <NumberInput value={d.lockoutAttempts} onChange={(n) => set({ lockoutAttempts: n })} suffix="wrong passwords" disabled={!can} />
          </SettingRow>
          <SettingRow label="Sign out after no activity" hint="Finance screens use the shorter limit.">
            <div className="grid grid-cols-2 gap-2">
              <NumberInput value={d.idleMinutes} onChange={(n) => set({ idleMinutes: n })} suffix="min" disabled={!can} />
              <NumberInput value={d.financeIdleMinutes} onChange={(n) => set({ financeIdleMinutes: n })} suffix="min finance" disabled={!can} />
            </div>
          </SettingRow>
          <SettingRow label="Maximum session" hint="Signed out after this time in any case.">
            <NumberInput value={d.maxSessionHours} onChange={(n) => set({ maxSessionHours: n })} suffix="hours" disabled={!can} />
          </SettingRow>
          <SettingRow label="Password reset link valid for">
            <NumberInput value={d.resetLinkMinutes} onChange={(n) => set({ resetLinkMinutes: n })} suffix="min" disabled={!can} />
          </SettingRow>
          <SettingRow label="Two-step login required for" hint="Finance access always requires it (plan §16), so Finance is always included.">
            <NativeSelect value={d.twoFactorFor} disabled={!can} onChange={(e) => set({ twoFactorFor: e.target.value })} aria-label="Two-step login required for">
              <option value="levels_1_3_and_finance">CEO / Founder / Owner, Director, CTO and Finance</option>
              <option value="levels_1_4_and_finance">CEO / Founder / Owner, Director, CTO, Finance and Sales</option>
              <option value="everyone">Everyone (adds Engineering)</option>
            </NativeSelect>
          </SettingRow>
          <SettingRow label="“Remember me” for finance users" hint="Off by plan §6.">
            <Switch checked={d.rememberMeForFinance} disabled aria-label="Remember me for finance users" />
          </SettingRow>
          <SettingRow label="Finance screens from office network only" hint="The Director decides. Remote finance work needs an approved device.">
            <Switch checked={d.officeOnlyFinance} disabled={!can} onCheckedChange={(v) => set({ officeOnlyFinance: v })} aria-label="Finance from office network only" />
          </SettingRow>
        </>
      )}
    </SettingsSection>
  );
}

/* ---------------- Alert rules ---------------- */

type Alerts = { newDevice: boolean; newCity: boolean; outsideHours: boolean; outsideFrom: string; outsideTo: string; largeExportRows: number; salaryViewsPerHour: number; financeAttempts: number; syncFailingMinutes: number; creditsBelow: number; bounceRatePct: number };

export function AlertRulesSection() {
  return (
    <SettingsSection<Alerts> section="alert-rules">
      {(d, set, can) => (
        <>
          <SettingRow label="Login from a new device" hint="Alert the CEO / Founder / Owner, the Director and the CTO.">
            <Switch checked={d.newDevice} disabled={!can} onCheckedChange={(v) => set({ newDevice: v })} aria-label="New device" />
          </SettingRow>
          <SettingRow label="Login from a new city" hint="Approximate city from the network, never GPS.">
            <Switch checked={d.newCity} disabled={!can} onCheckedChange={(v) => set({ newCity: v })} aria-label="New city" />
          </SettingRow>
          <SettingRow label="Login outside working hours">
            <div className="flex flex-wrap items-center gap-2">
              <Switch checked={d.outsideHours} disabled={!can} onCheckedChange={(v) => set({ outsideHours: v })} aria-label="Outside working hours" />
              <Input type="time" className="w-28" value={d.outsideFrom} disabled={!can || !d.outsideHours} onChange={(e) => set({ outsideFrom: e.target.value })} aria-label="From" />
              <span className="text-[12px] text-muted-foreground">to</span>
              <Input type="time" className="w-28" value={d.outsideTo} disabled={!can || !d.outsideHours} onChange={(e) => set({ outsideTo: e.target.value })} aria-label="To" />
            </div>
          </SettingRow>
          <SettingRow label="Large export" hint="Finance or employee data.">
            <NumberInput value={d.largeExportRows} onChange={(n) => set({ largeExportRows: n })} suffix="rows or more" disabled={!can} />
          </SettingRow>
          <SettingRow label="Many salary records opened">
            <NumberInput value={d.salaryViewsPerHour} onChange={(n) => set({ salaryViewsPerHour: n })} suffix="in one hour" disabled={!can} />
          </SettingRow>
          <SettingRow label="Repeated blocked finance attempts">
            <NumberInput value={d.financeAttempts} onChange={(n) => set({ financeAttempts: n })} suffix="attempts" disabled={!can} />
          </SettingRow>
          <SettingRow label="Sales tool connection failing for" hint="Alert the CTO (Module 16).">
            <NumberInput value={d.syncFailingMinutes} onChange={(n) => set({ syncFailingMinutes: n })} suffix="min" disabled={!can} />
          </SettingRow>
          <SettingRow label="MillionVerifier credits below">
            <NumberInput value={d.creditsBelow} onChange={(n) => set({ creditsBelow: n })} suffix="credits" step={100} disabled={!can} />
          </SettingRow>
          <SettingRow label="Mailbox bounce rate above" hint="Pause the mailbox before the domain's reputation suffers.">
            <NumberInput value={d.bounceRatePct} onChange={(n) => set({ bounceRatePct: n })} suffix="% of the day" step={0.5} disabled={!can} />
          </SettingRow>
        </>
      )}
    </SettingsSection>
  );
}

/* ---------------- Retention ---------------- */

type Retention = { sessionsYears: number; actionsYears: number; financeYears: number; rawSyncDays: number; inactiveLeadsMonths: number; messagesMonths: number; filesMonths: number };

export function RetentionSection() {
  return (
    <SettingsSection<Retention> section="retention">
      {(d, set, can) => (
        <>
          <SettingRow label="Session and screen records">
            <NumberInput value={d.sessionsYears} onChange={(n) => set({ sessionsYears: n })} suffix="years" disabled={!can} />
          </SettingRow>
          <SettingRow label="Action records">
            <NumberInput value={d.actionsYears} onChange={(n) => set({ actionsYears: n })} suffix="years" disabled={!can} />
          </SettingRow>
          <SettingRow label="Finance records and anything linked to them" hint="Companies Act 2017 s.220: at least ten financial years. Can't go lower.">
            <NumberInput value={d.financeYears} onChange={(n) => set({ financeYears: Math.max(10, n) })} min={10} suffix="years" disabled={!can} />
          </SettingRow>
          <SettingRow label="Raw sales-tool answers" hint="Kept only to help fix sync problems.">
            <NumberInput value={d.rawSyncDays} onChange={(n) => set({ rawSyncDays: n })} suffix="days" disabled={!can} />
          </SettingRow>
          <SettingRow label="Archive leads with no activity after" hint="Contact details are removed when archived.">
            <NumberInput value={d.inactiveLeadsMonths} onChange={(n) => set({ inactiveLeadsMonths: n })} suffix="months" disabled={!can} />
          </SettingRow>
          <SettingRow label="Messages and shared files" hint="The Director confirms before launch (spec §14).">
            <div className="grid grid-cols-2 gap-2">
              <NumberInput value={d.messagesMonths} onChange={(n) => set({ messagesMonths: n })} suffix="months msgs" disabled={!can} />
              <NumberInput value={d.filesMonths} onChange={(n) => set({ filesMonths: n })} suffix="months files" disabled={!can} />
            </div>
          </SettingRow>
        </>
      )}
    </SettingsSection>
  );
}

/* ---------------- Sales rules ---------------- */

type Sales = { dailyLeads: number; dailyEmailsChecked: number; dailyEmailsSent: number; dailyFollowUps: number; monthlyMeetings: number; monthlyProposals: number; stages: string[]; lostReasons: string[]; commissionPct: number; commissionBasis: string; recontactMonths: number };

export function SalesRulesSection() {
  return (
    <SettingsSection<Sales> section="sales">
      {(d, set, can) => (
        <>
          <SettingRow label="Default daily targets" hint="The Director (sales manager) can change them per person.">
            <div className="grid grid-cols-2 gap-2">
              <NumberInput value={d.dailyLeads} onChange={(n) => set({ dailyLeads: n })} suffix="leads" disabled={!can} />
              <NumberInput value={d.dailyEmailsChecked} onChange={(n) => set({ dailyEmailsChecked: n })} suffix="checked" disabled={!can} />
              <NumberInput value={d.dailyEmailsSent} onChange={(n) => set({ dailyEmailsSent: n })} suffix="sent" disabled={!can} />
              <NumberInput value={d.dailyFollowUps} onChange={(n) => set({ dailyFollowUps: n })} suffix="follow-ups" disabled={!can} />
            </div>
          </SettingRow>
          <SettingRow label="Default monthly targets">
            <div className="grid grid-cols-2 gap-2">
              <NumberInput value={d.monthlyMeetings} onChange={(n) => set({ monthlyMeetings: n })} suffix="meetings" disabled={!can} />
              <NumberInput value={d.monthlyProposals} onChange={(n) => set({ monthlyProposals: n })} suffix="proposals" disabled={!can} />
            </div>
          </SettingRow>
          <SettingRow label="Deal stages" hint="In pipeline order. Won and Lost must stay.">
            <ChipsEditor value={d.stages} onChange={(v) => set({ stages: v.includes("Won") && v.includes("Lost") ? v : d.stages })} disabled={!can} ordered placeholder="Add a stage" />
          </SettingRow>
          <SettingRow label="Lost reasons" hint="Required when a deal moves to Lost.">
            <ChipsEditor value={d.lostReasons} onChange={(v) => set({ lostReasons: v })} disabled={!can} placeholder="Add a reason" />
          </SettingRow>
          <SettingRow label="Commission" hint="Calculated when the client's first invoice is paid, approved by the Director, then sent to payroll.">
            <div className="grid grid-cols-[120px_1fr] gap-2">
              <NumberInput value={d.commissionPct} onChange={(n) => set({ commissionPct: n })} suffix="%" step={0.5} disabled={!can} />
              <NativeSelect value={d.commissionBasis} disabled={!can} onChange={(e) => set({ commissionBasis: e.target.value })} aria-label="Commission basis">
                <option value="first_payment">of the client&apos;s first payment</option>
                <option value="deal_value">of the won deal value</option>
              </NativeSelect>
            </div>
          </SettingRow>
          <SettingRow label="Lost leads can be contacted again after">
            <NumberInput value={d.recontactMonths} onChange={(n) => set({ recontactMonths: n })} suffix="months" disabled={!can} />
          </SettingRow>
        </>
      )}
    </SettingsSection>
  );
}

/* ---------------- Link sections ---------------- */

export function LinkSection({ icon, title, body, href, cta }: { icon: React.ReactNode; title: string; body: string; href: string; cta: string }) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-4 pt-5">
        <span className="grid size-12 place-content-center rounded-2xl bg-muted text-muted-foreground [&_svg]:size-5">{icon}</span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold">{title}</p>
          <p className="text-[13px] text-muted-foreground">{body}</p>
        </div>
        <Button asChild variant="outline">
          <Link href={href}>
            {cta} <ArrowRight />
          </Link>
        </Button>
      </CardContent>
    </Card>
  );
}

export const ChartOfAccountsLink = () => (
  <LinkSection
    icon={<ListTree />}
    title="Chart of accounts"
    body="Five groups with number codes: 1000 assets, 2000 liabilities, 3000 equity, 4000 income, 5000 expenses. The accountant signs it off before go-live."
    href="/finance/accounts"
    cta="Open accounts"
  />
);

export const SalesToolsLink = () => (
  <LinkSection
    icon={<Plug />}
    title="Sales tool connections"
    body="Apollo, MillionVerifier, outreach mailboxes and Salesforce. Only the CTO or the Director add or change a connection, with password and 2FA. The CEO / Founder / Owner can view them."
    href="/integrations"
    cta="Open integrations"
  />
);

/* ---------------- Backups ---------------- */

export function BackupsSection() {
  const q = useBackupStatus();
  const run = useRunBackup();
  const viewer = useViewer();
  const canRun = !!viewer && canRunBackup(viewer);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-96 rounded-xl" />;
  const s = q.data;
  return (
    <div className="grid gap-5">
      {!canRun && <MakerCheckerNote reason="View only. The CTO runs backups and restore tests; the Director can also start a backup." />}
      <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
        <StatCard label="Last backup" value={formatTime(s.lastBackupAt)} hint={`${formatDate(s.lastBackupAt)} · ${s.ok ? "succeeded" : "failed"}`} icon={<DatabaseBackup />} accent={s.ok ? "var(--success)" : "var(--danger)"} />
        <StatCard label="Daily copies" value={`${s.dailyCopies} / ${s.dailyKept}`} hint="Kept for 30 days" icon={<HardDrive />} accent="var(--zone-control)" />
        <StatCard label="Monthly copies" value={`${s.monthlyCopies} / ${s.monthlyKept}`} hint="Kept for 12 months" icon={<HardDrive />} accent="var(--zone-control)" />
        <StatCard label="Last restore test" value={s.lastRestoreTest.ok ? "Passed" : "Failed"} hint={formatDate(s.lastRestoreTest.at)} icon={<ShieldCheck />} accent={s.lastRestoreTest.ok ? "var(--success)" : "var(--danger)"} />
      </div>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Nightly backups</CardTitle>
            <CardDescription>
              Database and files every night. Stored in: {s.location}. Next run {formatDateTime(s.nextBackupAt)}.
            </CardDescription>
          </div>
          {canRun && (
            <Button
              variant="outline"
              loading={run.isPending}
              onClick={() => run.mutate(undefined, { onSuccess: () => toast.success("Backup finished", { description: "Encrypted copy stored. Logged." }) })}
            >
              <DatabaseBackup /> Back up now
            </Button>
          )}
        </CardHeader>
        <CardContent>
          <ul className="divide-y divide-border overflow-hidden rounded-lg border border-border text-[13px]">
            {s.recent.map((b) => (
              <li key={b.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
                <span className="flex items-center gap-2">
                  {b.ok ? <CircleCheck className="size-4 text-success" /> : <CircleX className="size-4 text-danger" />}
                  <span>{formatDateTime(b.at)}</span>
                  <span className="text-[12px] text-muted-foreground">{formatRelative(b.at)}</span>
                </span>
                <span className="flex items-center gap-3 text-[12.5px] text-muted-foreground">
                  <Badge tone={b.kind === "monthly" ? "control" : "outline"}>{b.kind === "monthly" ? "Monthly" : "Daily"}</Badge>
                  <span className="font-mono tabular">{b.sizeMb} MB</span>
                  <span>{b.durationMin} min</span>
                  <Lock className="size-3.5" aria-label="Encrypted" />
                </span>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <Card>
        <CardHeader>
          <div>
            <CardTitle>Monthly restore tests</CardTitle>
            <CardDescription>A backup is restored to the test server every month and checked (plan §17).</CardDescription>
          </div>
        </CardHeader>
        <CardContent>
          <ul className="grid gap-2">
            {s.restoreTests.map((t) => (
              <li key={t.at} className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-border px-4 py-3 text-[13px]">
                <span className="flex items-start gap-2">
                  {t.ok ? <CircleCheck className="mt-0.5 size-4 text-success" /> : <CircleX className="mt-0.5 size-4 text-danger" />}
                  <span className="grid gap-0.5">
                    <span className="font-medium">
                      {formatDate(t.at)} · {t.ok ? "Passed" : "Needs attention"} in {t.durationMin} min
                    </span>
                    <span className="text-muted-foreground">{t.note}</span>
                  </span>
                </span>
                <EmpChip empId={t.by} size="sm" />
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>
      <p className="text-[12px] text-muted-foreground">
        Backup storage is billed with hosting. See{" "}
        <Link href="/billing/subscriptions" className="text-primary hover:underline">
          Subscriptions
        </Link>{" "}
        for the current plan.
      </p>
    </div>
  );
}
