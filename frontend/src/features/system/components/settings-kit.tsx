"use client";
/** Shared building blocks for Settings sections (spec §9.12). */
import * as React from "react";
import { toast } from "sonner";
import { ArrowRight, Eye, Plus, RotateCcw, Save, Star, X } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/misc";
import { useReason, useStepUp } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { ErrorState } from "@/components/shared/states";
import { useViewer } from "@/lib/auth/viewer";
import { formatDateTime, formatRelative } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useSaveSettings, useSettings, useSettingsHistory } from "../hooks";
import { sectionMeta } from "../logic";
import type { SettingsRecord, SettingsSectionKey, SettingsValues } from "../types";

/** Who may edit a section: settings.manage, and Owner/CEO for ★ sections. */
export function useSectionAccess(section: SettingsSectionKey) {
  const viewer = useViewer();
  const meta = sectionMeta(section);
  const canManage = !!viewer?.can("settings.manage");
  const levelOk = !meta.protected || (viewer?.employee.level ?? 5) <= 2;
  return {
    canEdit: canManage && levelOk,
    reason: !canManage ? "You can view settings but not change them." : !levelOk ? "Only the Owner or CEO can change this section." : undefined,
    protected: !!meta.protected,
  };
}

/** Save with a required reason, plus step-up for ★ sections. Resolves true when saved. */
export function useSectionSaver(section: SettingsSectionKey) {
  const askReason = useReason();
  const stepUp = useStepUp();
  const save = useSaveSettings();
  const meta = sectionMeta(section);
  const run = async (values: SettingsValues) => {
    const reason = await askReason({ title: `Save ${meta.label.toLowerCase()}`, description: "Every settings change is saved in the audit log with your reason.", confirmLabel: "Save change" });
    if (!reason) return false;
    if (meta.protected && !(await stepUp({ action: `Change ${meta.label.toLowerCase()}`, detail: "Owner or CEO only." }))) return false;
    try {
      await save.mutateAsync({ section, values, reason });
      toast.success(`${meta.label} saved`, { description: "Logged in the audit trail." });
      return true;
    } catch (e) {
      toast.error((e as Error).message);
      return false;
    }
  };
  return { save: run, saving: save.isPending };
}

/**
 * Loads a section, keeps a draft, and renders the frame with Save / Reset.
 * children receive (draft, setDraft, canEdit).
 */
export function SettingsSection<T extends SettingsValues>({
  section,
  children,
  hideSave,
}: {
  section: SettingsSectionKey;
  children: (draft: T, set: (patch: Partial<T>) => void, canEdit: boolean) => React.ReactNode;
  hideSave?: boolean;
}) {
  const q = useSettings(section);
  if (q.isError) return <ErrorState error={q.error} onRetry={() => q.refetch()} />;
  if (!q.data) return <Skeleton className="h-96 rounded-xl" />;
  // Remount the body when the saved record changes, so the draft starts from it.
  return (
    <SectionBody<T> key={`${q.data.updatedAt}`} section={section} record={q.data} hideSave={hideSave}>
      {children}
    </SectionBody>
  );
}

function SectionBody<T extends SettingsValues>({
  section,
  record,
  children,
  hideSave,
}: {
  section: SettingsSectionKey;
  record: SettingsRecord;
  children: (draft: T, set: (patch: Partial<T>) => void, canEdit: boolean) => React.ReactNode;
  hideSave?: boolean;
}) {
  const access = useSectionAccess(section);
  const { save, saving } = useSectionSaver(section);
  const [draft, setDraft] = React.useState<T>(() => structuredClone(record.values) as T);
  const q = { data: record };

  const dirty = JSON.stringify(draft) !== JSON.stringify(q.data.values);
  const set = (patch: Partial<T>) => setDraft((d) => ({ ...d, ...patch }));

  return (
    <div className="grid gap-5">
      <Card>
        <CardContent className="grid gap-5 pt-5">{children(draft, set, access.canEdit)}</CardContent>
        {!hideSave && (
          <CardFooter className="flex-wrap justify-between gap-3">
            <span className="text-[12px] text-muted-foreground">
              Last changed {formatRelative(q.data.updatedAt)} by <EmpChip empId={q.data.updatedBy} size="sm" showId={false} className="align-middle" />
            </span>
            {access.canEdit ? (
              <span className="flex gap-2">
                <Button variant="ghost" disabled={!dirty} onClick={() => setDraft(structuredClone(q.data.values) as T)}>
                  <RotateCcw /> Reset
                </Button>
                <Button disabled={!dirty} loading={saving} onClick={() => save(draft)}>
                  <Save /> Save changes
                </Button>
              </span>
            ) : (
              <Badge tone="outline">
                <Eye /> Read-only
              </Badge>
            )}
          </CardFooter>
        )}
      </Card>
      <RecentChanges section={section} />
    </div>
  );
}

export function RecentChanges({ section }: { section: SettingsSectionKey }) {
  const h = useSettingsHistory(section);
  if (!h.data?.length) return null;
  return (
    <section aria-label="Recent changes">
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Recent changes</h3>
      <ul className="grid gap-2">
        {h.data.map((r) => (
          <li key={r.id} className="grid gap-1.5 rounded-xl border border-border bg-card px-4 py-3 text-[12.5px]">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <EmpChip empId={r.empId} size="sm" />
              <span className="text-muted-foreground">{formatDateTime(r.at)}</span>
            </div>
            {r.changes?.slice(0, 4).map((c) => (
              <p key={c.field} className="flex flex-wrap items-center gap-1.5">
                <span className="font-medium">{c.field}</span>
                <span className="font-mono text-muted-foreground line-through">{c.from}</span>
                <ArrowRight className="size-3 text-muted-foreground" />
                <span className="font-mono">{c.to}</span>
              </p>
            ))}
            {r.reason && <p className="text-muted-foreground">Reason: “{r.reason}”</p>}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function ProtectedBadge() {
  return (
    <Badge tone="warning">
      <Star className="fill-current" /> Owner or CEO
    </Badge>
  );
}

/** Editable list of short strings (deal stages, lost reasons, networks). */
export function ChipsEditor({ value, onChange, disabled, placeholder = "Add item", ordered }: { value: string[]; onChange: (v: string[]) => void; disabled?: boolean; placeholder?: string; ordered?: boolean }) {
  const [text, setText] = React.useState("");
  const add = () => {
    const t = text.trim();
    if (!t || value.includes(t)) return;
    onChange([...value, t]);
    setText("");
  };
  return (
    <div className="grid gap-2">
      <ul className="flex flex-wrap gap-1.5">
        {value.map((v, i) => (
          <li key={v} className="inline-flex items-center gap-1 rounded-full border border-border bg-muted px-2.5 py-1 text-[12.5px]">
            {ordered && <span className="font-mono text-[11px] text-muted-foreground">{i + 1}</span>}
            {v}
            {!disabled && (
              <button type="button" onClick={() => onChange(value.filter((x) => x !== v))} className="rounded-full p-0.5 text-muted-foreground hover:bg-card hover:text-foreground" aria-label={`Remove ${v}`}>
                <X className="size-3" />
              </button>
            )}
          </li>
        ))}
      </ul>
      {!disabled && (
        <div className="flex max-w-sm gap-2">
          <Input
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                add();
              }
            }}
            placeholder={placeholder}
          />
          <Button type="button" variant="outline" onClick={add} disabled={!text.trim()}>
            <Plus /> Add
          </Button>
        </div>
      )}
    </div>
  );
}

/** Number input with a unit suffix. */
export function NumberInput({ value, onChange, suffix, disabled, id, min = 0, step = 1, className }: { value: number; onChange: (n: number) => void; suffix?: string; disabled?: boolean; id?: string; min?: number; step?: number; className?: string }) {
  return (
    <div className={cn("flex h-9 items-stretch overflow-hidden rounded-lg border border-input bg-card focus-within:border-ring focus-within:outline-2 focus-within:outline-ring/30", disabled && "opacity-60", className)}>
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        step={step}
        disabled={disabled}
        value={Number.isFinite(value) ? value : ""}
        onChange={(e) => onChange(e.target.value === "" ? 0 : Number(e.target.value))}
        className="min-w-0 flex-1 bg-transparent px-3 font-mono text-sm tabular outline-none disabled:cursor-not-allowed"
      />
      {suffix && <span className="grid place-content-center border-l border-border bg-muted px-2.5 text-[12px] text-muted-foreground">{suffix}</span>}
    </div>
  );
}
