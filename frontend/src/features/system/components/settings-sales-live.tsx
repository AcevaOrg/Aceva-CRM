"use client";
/**
 * Settings > Sales in LIVE mode (m15), read from and saved to the server (GET/PUT /settings/modules/sales).
 *
 * What the server keeps today (Module 15.2): the reasons a deal can be marked Lost, the months after which a lost lead may
 * be contacted again, and the website domains that never identify one company. The lost reasons and the re-contact period
 * start EMPTY: management decides the values (nothing is invented), and until both are set no deal can be marked Lost.
 * Only the Director changes them (settings.manage; the server checks it too); every change needs a reason and is kept in
 * the audit log with the old and the new value. The same rules (salesSettingsSchema) check the form here and on the server.
 * Targets, commission and the other sales rules arrive with their parts of Module 15 and are not shown here.
 */
import * as React from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Save } from "lucide-react";
import { type ModuleSettingsView, salesSettingsSchema, type SalesSettings } from "@aceva/contracts";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { useReason } from "@/components/shared/dialogs";
import { ErrorState } from "@/components/shared/states";
import { http } from "@/lib/api/http";
import { useCan } from "@/lib/auth/viewer";
import { formatDateTime } from "@/lib/dates";
import { ChipsEditor } from "./settings-kit";
import { SettingRow } from "./settings-sections-work";

const KEY = ["m15-settings"] as const;

export function LiveSalesSettingsSection() {
  const q = useQuery({ queryKey: KEY, queryFn: () => http.get<ModuleSettingsView>("/settings/modules/sales") });
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-60 rounded-xl" />;
  return <SalesSettingsForm key={`${q.data.version}`} view={q.data} />;
}

function SalesSettingsForm({ view }: { view: ModuleSettingsView }) {
  const can = useCan("settings.manage");
  const qc = useQueryClient();
  const askReason = useReason();
  const saved = salesSettingsSchema.parse(view.value);
  const [lostReasons, setLostReasons] = React.useState<string[]>(saved.lostReasons);
  // Empty means "not set" (null on the server); never a made-up number.
  const [months, setMonths] = React.useState<string>(saved.recontactMonths === null ? "" : String(saved.recontactMonths));
  const [shared, setShared] = React.useState<string[]>(saved.sharedWebsiteDomains);
  const [busy, setBusy] = React.useState(false);

  const next = {
    sharedWebsiteDomains: shared,
    lostReasons,
    recontactMonths: months.trim() === "" ? null : Number(months),
  };
  const check = salesSettingsSchema.safeParse(next);
  const problem = check.success ? null : check.error.issues[0]?.message ?? "Check the values";
  const changed = JSON.stringify(next) !== JSON.stringify({ sharedWebsiteDomains: saved.sharedWebsiteDomains, lostReasons: saved.lostReasons, recontactMonths: saved.recontactMonths });
  const lostReady = saved.lostReasons.length > 0 && saved.recontactMonths !== null;

  const save = async () => {
    if (!check.success) return;
    const reason = await askReason({ title: "Change the sales settings", description: "Your reason is kept in the audit log with the old and the new values.", confirmLabel: "Save" });
    if (!reason) return;
    setBusy(true);
    try {
      await http.put<ModuleSettingsView>("/settings/modules/sales", { value: check.data satisfies SalesSettings, version: view.version, reason });
      toast.success("Saved", { description: "Logged in the audit trail." });
      await qc.invalidateQueries({ queryKey: KEY });
      await qc.invalidateQueries({ queryKey: ["sales"] });
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Card>
      <CardContent className="grid gap-5 pt-5">
        <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
          {lostReady ? <Badge tone="success">Lost deals can be recorded</Badge> : <Badge tone="warning">Lost deals are blocked until the reasons and the period are set</Badge>}
          <span>{view.updatedAt ? `Last changed ${formatDateTime(view.updatedAt)}${view.updatedByEmpId ? ` by ${view.updatedByEmpId}` : ""}` : "Never changed"}</span>
        </div>
        <SettingRow label="Lost reasons" hint="A deal marked Lost needs one of these. Management decides the list.">
          <ChipsEditor value={lostReasons} onChange={setLostReasons} disabled={!can || busy} placeholder="Add a reason" />
        </SettingRow>
        <SettingRow label="Lost leads can be contacted again after" htmlFor="ss-months" hint="Months, 1 to 60. Empty = not set yet.">
          <div className="flex items-center gap-2">
            <Input id="ss-months" inputMode="numeric" value={months} onChange={(e) => setMonths(e.target.value.replace(/[^0-9]/g, ""))} disabled={!can || busy} className="w-24 font-mono" placeholder="Not set" aria-invalid={!check.success && months !== "" ? true : undefined} />
            <span className="text-[13px] text-muted-foreground">months</span>
          </div>
        </SettingRow>
        <SettingRow label="Shared website domains" hint="Marketplaces or social sites where many companies have a page: never used to match a company.">
          <ChipsEditor value={shared} onChange={setShared} disabled={!can || busy} placeholder="Add a domain, for example fiverr.com" />
        </SettingRow>
        {problem && changed && <p className="text-[12.5px] text-danger" role="alert">{problem}</p>}
      </CardContent>
      {can && (
        <CardFooter className="justify-end">
          <Button onClick={save} disabled={!changed || !check.success} loading={busy}>
            <Save /> Save
          </Button>
        </CardFooter>
      )}
    </Card>
  );
}
