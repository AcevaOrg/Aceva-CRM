"use client";
/**
 * Finance approval settings in LIVE mode (m9), read from and saved to the server (decision D26): the Director approves every
 * journal entry whatever its amount, so there are no approval tiers. Two amounts remain: the "confirm again" amount (approving
 * an entry above it asks for the password and code again, plan s.16) and the amount above which the Owner is told about an
 * entry (the Owner only views; capital and loan entries are always reported). Every change asks for a reason and for the
 * password (and code) again; the server checks both and keeps the change in the audit log.
 * Only the Director edits (finance.authority_manage); everyone else with finance access sees them read-only.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Save } from "lucide-react";
import type { FinanceSettingsView } from "@aceva/contracts";
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

export function LiveApprovalLimitsSection() {
  const finance = useQuery({ queryKey: [...KEY, "finance"], queryFn: () => http.get<FinanceSettingsView>("/settings/finance") });
  if (finance.isError) return <ErrorState error={finance.error} onRetry={() => finance.refetch()} />;
  if (!finance.data) return <Skeleton className="h-60 rounded-xl" />;
  return <FinanceForm key={JSON.stringify(finance.data)} finance={finance.data} />;
}

function FinanceForm({ finance }: { finance: FinanceSettingsView }) {
  const can = useCan("finance.authority_manage"); // decision D26: the Director only; the server checks it too
  const qc = useQueryClient();
  const askReason = useReason();
  const stepUp = useStepUp();
  const [stepUpAbove, setStepUpAbove] = React.useState(() => Number(finance.stepUpAbove));
  const [ownerNotifyAbove, setOwnerNotifyAbove] = React.useState(() => Number(finance.ownerNotifyAbove));

  const valid = stepUpAbove >= 0 && ownerNotifyAbove >= 0;
  const changed = stepUpAbove !== Number(finance.stepUpAbove) || ownerNotifyAbove !== Number(finance.ownerNotifyAbove);

  const save = async () => {
    const reason = await askReason({ title: "Change finance approval settings", description: "These settings protect the ledger. Your reason is kept in the audit log.", confirmLabel: "Continue" });
    if (!reason) return;
    if (!(await stepUp({ action: "Change finance approval settings", detail: "The confirm-again amount and the Owner notice amount need your password (and code) again." }))) return;
    try {
      await http.put("/settings/finance", { reason, stepUpAbove: String(stepUpAbove), ownerNotifyAbove: String(ownerNotifyAbove), financeYearStartMonth: finance.financeYearStartMonth });
      toast.success("Saved", { description: "Logged in the audit trail." });
      await qc.invalidateQueries({ queryKey: KEY });
      await qc.invalidateQueries({ queryKey: ["ledger"] });
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <Card>
      <CardContent className="space-y-4 pt-6">
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="rounded-xl border border-border bg-muted/40 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Level 2</p>
            <p className="mt-1 font-semibold">Director</p>
            <p className="text-[12.5px] text-muted-foreground">Approves every journal entry, whatever its amount, including capital and loan entries.</p>
          </div>
          <div className="rounded-xl border border-border bg-muted/40 p-4">
            <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Level 1</p>
            <p className="mt-1 font-semibold">CEO / Founder / Owner</p>
            <p className="text-[12.5px] text-muted-foreground">Only views. Approves just the entries the Director made, and is told about large and capital or loan entries.</p>
          </div>
        </div>
        <SettingRow label="Confirm again above" hint={`Approving an entry above this amount asks for the password (and code) again (plan s.16). Now ${formatMoneyCompact(Number(finance.stepUpAbove))}.`}>
          <NumberInput value={stepUpAbove} onChange={setStepUpAbove} suffix="PKR" step={10000} disabled={!can} />
        </SettingRow>
        <SettingRow label="Tell the Owner above" hint={`An entry above this amount is reported to the Owner (view only; it does not wait for the Owner). Now ${formatMoneyCompact(Number(finance.ownerNotifyAbove))}.`}>
          <NumberInput value={ownerNotifyAbove} onChange={setOwnerNotifyAbove} suffix="PKR" step={50000} disabled={!can} />
        </SettingRow>
        <p className="text-[12.5px] text-muted-foreground">Nobody approves their own entry. An entry the Director made goes one level up, to the Owner.</p>
        {!valid && <p className="text-[12.5px] text-danger">Each amount must be zero or more.</p>}
      </CardContent>
      {can && (
        <CardFooter className="justify-end">
          <Button onClick={save} disabled={!valid || !changed}>
            <Save /> Save changes
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
