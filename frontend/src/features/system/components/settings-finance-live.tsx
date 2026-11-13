"use client";
/**
 * Approval limits in LIVE mode (m9), read from and saved to the server (plan s.13): a journal entry is approved by a
 * different person at the level its PKR amount needs. The most senior tier (the Owner, level 1) has no upper limit and
 * approves every share capital and loan entry. The "confirm again" amount is in the same section. Every change asks for a
 * reason and for the password (and code) again; the server checks both and keeps the change in the audit log.
 * Only the Owner edits (finance.authority_manage, decision D22); everyone else with finance access sees them read-only.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Save } from "lucide-react";
import type { ApprovalLimitView, FinanceSettingsView } from "@aceva/contracts";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { useReason, useStepUp } from "@/components/shared/dialogs";
import { ErrorState } from "@/components/shared/states";
import { http } from "@/lib/api/http";
import { useCan } from "@/lib/auth/viewer";
import { formatMoneyCompact } from "@/lib/format";
import { NumberInput } from "./settings-kit";
import { SettingRow } from "./settings-sections-work";

const KEY = ["m9-settings"] as const;
const WHO: Record<number, string> = { 1: "Owner", 2: "CEO", 3: "Director" };

export function LiveApprovalLimitsSection() {
  const limits = useQuery({ queryKey: [...KEY, "limits"], queryFn: () => http.get<ApprovalLimitView[]>("/settings/approval-limits") });
  const finance = useQuery({ queryKey: [...KEY, "finance"], queryFn: () => http.get<FinanceSettingsView>("/settings/finance") });
  if (limits.isError) return <ErrorState error={limits.error} onRetry={() => limits.refetch()} />;
  if (finance.isError) return <ErrorState error={finance.error} onRetry={() => finance.refetch()} />;
  if (!limits.data || !finance.data) return <Skeleton className="h-80 rounded-xl" />;
  return <LimitsForm key={JSON.stringify([limits.data, finance.data])} limits={limits.data} finance={finance.data} />;
}

function LimitsForm({ limits, finance }: { limits: ApprovalLimitView[]; finance: FinanceSettingsView }) {
  const can = useCan("finance.authority_manage"); // decision D22: the Owner only; the server checks it too
  const qc = useQueryClient();
  const askReason = useReason();
  const stepUp = useStepUp();
  const capped = limits.filter((l) => l.maxAmount !== null).sort((a, b) => b.approverLevel - a.approverLevel);
  const [draft, setDraft] = React.useState<Record<number, number>>(() => Object.fromEntries(capped.map((l) => [l.approverLevel, Number(l.maxAmount)])));
  const [stepUpAbove, setStepUpAbove] = React.useState(() => Number(finance.stepUpAbove));

  const increasing = capped.every((l, i) => i === 0 || draft[l.approverLevel] > draft[capped[i - 1].approverLevel]);
  const valid = capped.every((l) => draft[l.approverLevel] > 0) && increasing && stepUpAbove >= 0;
  const limitsChanged = capped.some((l) => draft[l.approverLevel] !== Number(l.maxAmount));
  const financeChanged = stepUpAbove !== Number(finance.stepUpAbove);

  const save = async () => {
    const reason = await askReason({ title: "Change approval rules", description: "Approval rules protect the ledger. Your reason is kept in the audit log.", confirmLabel: "Continue" });
    if (!reason) return;
    if (!(await stepUp({ action: "Change approval rules", detail: "Approval limits and the confirm-again amount need your password (and code) again." }))) return;
    try {
      if (limits.length && limitsChanged) {
        await http.put("/settings/approval-limits", {
          reason,
          limits: limits.map((l) => ({ approverLevel: l.approverLevel, label: l.label, maxAmount: l.maxAmount === null ? null : String(draft[l.approverLevel]) })),
        });
      }
      if (financeChanged) await http.put("/settings/finance", { reason, stepUpAbove: String(stepUpAbove), financeYearStartMonth: finance.financeYearStartMonth });
      toast.success("Saved", { description: "Logged in the audit trail." });
      await qc.invalidateQueries({ queryKey: KEY });
      await qc.invalidateQueries({ queryKey: ["ledger"] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  const sorted = [...limits].sort((a, b) => b.approverLevel - a.approverLevel);
  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="grid gap-2 sm:grid-cols-3">
          {sorted.map((l, i) => {
            const below = i > 0 ? sorted[i - 1] : null;
            const from = below && below.maxAmount !== null ? `Above ${formatMoneyCompact(draft[below.approverLevel] ?? Number(below.maxAmount))}` : "Any amount";
            return (
              <div key={l.approverLevel} className="rounded-xl border border-border bg-muted/40 p-4">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Level {l.approverLevel}</p>
                <p className="mt-1 font-semibold">{WHO[l.approverLevel] ?? l.label}</p>
                <p className="text-[12.5px] text-muted-foreground">
                  {l.maxAmount === null
                    ? `${i > 0 ? from : "Any amount"} and every share capital or loan entry. No upper limit.`
                    : `${i === 0 ? "Up to" : `${from}, up to`} ${formatMoneyCompact(draft[l.approverLevel])}.`}
                </p>
              </div>
            );
          })}
        </div>
        {capped.map((l) => (
          <SettingRow key={l.approverLevel} label={`${WHO[l.approverLevel] ?? l.label} approves up to`} hint="PKR, total of the entry. A more senior level always has a higher limit.">
            <NumberInput value={draft[l.approverLevel]} onChange={(n) => setDraft((d) => ({ ...d, [l.approverLevel]: n }))} suffix="PKR" step={10000} disabled={!can} />
          </SettingRow>
        ))}
        <SettingRow label="Confirm again above" hint="Approving an entry above this amount asks for the password (and code) again (plan s.16).">
          <NumberInput value={stepUpAbove} onChange={setStepUpAbove} suffix="PKR" step={10000} disabled={!can} />
        </SettingRow>
        <p className="text-[12.5px] text-muted-foreground">
          Nobody approves their own entry. If the approver at the needed level made it, it goes one level up. The Owner tier has no limit and cannot be removed.
        </p>
        {!valid && <p className="text-[12.5px] text-danger">Each limit must be more than zero, and a more senior level must have a higher limit.</p>}
      </CardContent>
      {can && (
        <CardFooter className="justify-end">
          <Button onClick={save} disabled={!valid || (!limitsChanged && !financeChanged)}>
            <Save /> Save changes
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
