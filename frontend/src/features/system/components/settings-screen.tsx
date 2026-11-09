"use client";
import * as React from "react";
import { Info, Star } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { NativeSelect } from "@/components/ui/controls";
import { RequireAccess } from "@/components/shared/can";
import { useUrlState } from "@/hooks/use-url-state";
import { useViewer } from "@/lib/auth/viewer";
import { cn } from "@/lib/utils";
import { canViewSection, SECTIONS, sectionMeta } from "../logic";
import type { SettingsSectionKey } from "../types";
import { ProtectedBadge, useSectionAccess } from "./settings-kit";
import {
  AlertRulesSection, ApprovalLimitsSection, BackupsSection, ChartOfAccountsLink, CurrenciesSection, FinanceYearSection, RetentionSection,
  SalesRulesSection, SalesToolsLink, SecuritySection, TaxSlabsSection,
} from "./settings-sections-control";
import { CompanySection, HolidaysSection, LeaveTypesSection, ScheduleSection, ScoreWeightsSection, TaskSizesSection } from "./settings-sections-work";

const PANELS: Record<SettingsSectionKey, React.ComponentType> = {
  company: CompanySection,
  schedule: ScheduleSection,
  holidays: HolidaysSection,
  "leave-types": LeaveTypesSection,
  "task-sizes": TaskSizesSection,
  "score-weights": ScoreWeightsSection,
  "approval-limits": ApprovalLimitsSection,
  currencies: CurrenciesSection,
  "finance-year": FinanceYearSection,
  "chart-of-accounts": ChartOfAccountsLink,
  "tax-slabs": TaxSlabsSection,
  security: SecuritySection,
  "alert-rules": AlertRulesSection,
  retention: RetentionSection,
  backups: BackupsSection,
  sales: SalesRulesSection,
  "sales-tools": SalesToolsLink,
};

export function SettingsScreen() {
  return (
    <RequireAccess permission="settings.view">
      <SettingsInner />
    </RequireAccess>
  );
}

function SettingsInner() {
  const viewer = useViewer();
  const [raw, setSection] = useUrlState<string>("section", "company");
  // Finance and sales sections are hidden from people without that access (the CTO sees neither).
  const visible = SECTIONS.filter((s) => !!viewer && canViewSection(s, viewer.can));
  const groups = Array.from(new Set(visible.map((s) => s.group)));
  const section = (visible.some((s) => s.key === raw) ? raw : "company") as SettingsSectionKey;
  const meta = sectionMeta(section);
  const access = useSectionAccess(section);
  const Panel = PANELS[section];
  const noForm = section === "chart-of-accounts" || section === "sales-tools" || section === "backups";

  return (
    <>
      <PageHeader title="Settings" description="Company rules every module reads. Each change asks for a reason and is saved in the audit log." />
      <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <div className="lg:hidden">
          <NativeSelect value={section} onChange={(e) => setSection(e.target.value)} aria-label="Settings section">
            {groups.map((g) => (
              <optgroup key={g} label={g}>
                {visible.filter((s) => s.group === g).map((s) => (
                  <option key={s.key} value={s.key}>
                    {s.label}
                    {s.protected ? " ★" : ""}
                  </option>
                ))}
              </optgroup>
            ))}
          </NativeSelect>
        </div>
        <nav aria-label="Settings sections" className="hidden lg:block">
          <div className="sticky top-20 grid gap-4">
            {groups.map((g) => (
              <div key={g}>
                <p className="mb-1 px-2.5 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{g}</p>
                <ul className="grid gap-0.5">
                  {visible.filter((s) => s.group === g).map((s) => {
                    const active = s.key === section;
                    return (
                      <li key={s.key}>
                        <button
                          onClick={() => setSection(s.key)}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "flex h-8 w-full items-center justify-between gap-2 rounded-lg px-2.5 text-left text-[13px] transition-colors",
                            active ? "bg-card font-medium text-foreground shadow-strata ring-1 ring-border" : "text-muted-foreground hover:bg-muted hover:text-foreground",
                          )}
                        >
                          <span className="truncate">{s.label}</span>
                          {s.protected && <Star className="size-3 shrink-0 fill-warning text-warning" aria-label="Director only, with step-up" />}
                        </button>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </div>
        </nav>

        <section className="grid min-w-0 content-start gap-5" aria-labelledby="settings-title">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-zone-control">{meta.group}</p>
              <h2 id="settings-title" className="mt-0.5 text-xl font-semibold tracking-tight">
                {meta.label}
              </h2>
              <p className="mt-1 max-w-2xl text-[13px] text-muted-foreground">{meta.description}</p>
            </div>
            {meta.protected && <ProtectedBadge />}
          </div>
          {!noForm && access.reason && (
            <p className="flex items-start gap-2 rounded-lg border border-info/30 bg-info/10 px-3 py-2 text-[12.5px]">
              <Info className="mt-0.5 size-4 shrink-0 text-info" />
              {access.reason}
            </p>
          )}
          {!noForm && access.canEdit && meta.protected && (
            <p className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/12 px-3 py-2 text-[12.5px]">
              <Star className="mt-0.5 size-4 shrink-0 fill-warning text-warning" />
              Saving asks for a reason and then your password and 2FA code again.
            </p>
          )}
          <Panel key={section} />
        </section>
      </div>
    </>
  );
}
