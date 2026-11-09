"use client";
/**
 * Promise-based dialogs used by every module (spec §3.5.5, §11):
 *
 *   const stepUp = useStepUp();      if (!(await stepUp({ action: "Approve payroll" }))) return;
 *   const askReason = useReason();   const reason = await askReason({ title: "Reverse entry" });
 *   const exportData = useExport();  await exportData({ title: "Balance sheet", seal: "highly" });
 *
 * <DialogsHost/> is mounted once in the AppShell.
 */
import * as React from "react";
import { create } from "zustand";
import { FileDown, Fingerprint, ScrollText } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { NativeSelect, SegmentedControl } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Field } from "@/components/ui/field";
import { Input, Textarea } from "@/components/ui/input";
import { useViewer } from "@/lib/auth/viewer";
import { formatDateTime } from "@/lib/dates";
import type { Confidentiality } from "@/types";
import { ConfidentialSeal } from "./confidential-seal";
import { OtpInput } from "./otp-input";

interface StepUpReq {
  kind: "stepup";
  action: string;
  detail?: string;
  resolve: (ok: boolean) => void;
}
interface ReasonReq {
  kind: "reason";
  title: string;
  description?: string;
  confirmLabel?: string;
  destructive?: boolean;
  options?: string[];
  placeholder?: string;
  resolve: (reason: string | null) => void;
}
type ExportFormat = "pdf" | "xlsx" | "csv";
interface ExportReq {
  kind: "export";
  title: string;
  seal?: Confidentiality;
  formats?: ExportFormat[];
  stepUp?: boolean;
  rows?: number;
  resolve: (format: ExportFormat | null) => void;
}
type Req = StepUpReq | ReasonReq | ExportReq;

const useDialogStore = create<{ req: Req | null; set: (r: Req | null) => void }>((set) => ({
  req: null,
  set: (req) => set({ req }),
}));

type Opts<T extends Req> = Omit<T, "kind" | "resolve">;

export function useStepUp() {
  const set = useDialogStore((s) => s.set);
  return React.useCallback(
    (opts: Opts<StepUpReq>) => new Promise<boolean>((resolve) => set({ kind: "stepup", ...opts, resolve })),
    [set],
  );
}

export function useReason() {
  const set = useDialogStore((s) => s.set);
  return React.useCallback(
    (opts: Opts<ReasonReq>) => new Promise<string | null>((resolve) => set({ kind: "reason", ...opts, resolve })),
    [set],
  );
}

export function useExport() {
  const set = useDialogStore((s) => s.set);
  return React.useCallback(
    (opts: Opts<ExportReq>) => new Promise<ExportFormat | null>((resolve) => set({ kind: "export", ...opts, resolve })),
    [set],
  );
}

export function DialogsHost() {
  const { req, set } = useDialogStore();
  const close = () => set(null);
  if (!req) return null;
  if (req.kind === "stepup") return <StepUpDialog req={req} close={close} />;
  if (req.kind === "reason") return <ReasonDialog req={req} close={close} />;
  return <ExportDialog req={req} close={close} />;
}

function StepUpDialog({ req, close }: { req: StepUpReq; close: () => void }) {
  const [password, setPassword] = React.useState("");
  const [code, setCode] = React.useState("");
  const [busy, setBusy] = React.useState(false);
  const ready = password.length > 0 && code.replace(/\s/g, "").length === 6;

  const finish = (ok: boolean) => {
    req.resolve(ok);
    close();
  };
  const confirm = async () => {
    if (!ready) return;
    setBusy(true);
    await new Promise((r) => setTimeout(r, 450));
    toast.success("Confirmed", { description: `${req.action}. This action is logged.` });
    finish(true);
  };

  return (
    <Dialog open onOpenChange={(o) => !o && finish(false)}>
      <DialogContent size="sm">
        <DialogHeader>
          <span className="mb-1 grid size-10 place-content-center rounded-xl bg-primary/10 text-primary">
            <Fingerprint className="size-5" />
          </span>
          <DialogTitle>Confirm it&apos;s you</DialogTitle>
          <DialogDescription>
            <span className="font-medium text-foreground">{req.action}</span>
            {req.detail && <span className="block">{req.detail}</span>}
            <span className="mt-1 block">Enter your password and the 6-digit code from your authenticator app.</span>
          </DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            confirm();
          }}
        >
          <Field label="Password" htmlFor="stepup-pw">
            <Input id="stepup-pw" type="password" autoFocus autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
          </Field>
          <Field label="Authenticator code" hint="Demo: any 6 digits work.">
            <OtpInput value={code} onChange={setCode} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(false)}>
              Cancel
            </Button>
            <Button type="submit" disabled={!ready} loading={busy}>
              Confirm
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function ReasonDialog({ req, close }: { req: ReasonReq; close: () => void }) {
  const [choice, setChoice] = React.useState(req.options?.[0] ?? "");
  const [text, setText] = React.useState("");
  const needsText = !req.options || choice === "Other";
  const reason = req.options ? (choice === "Other" ? text.trim() : [choice, text.trim()].filter(Boolean).join(": ")) : text.trim();
  const finish = (r: string | null) => {
    req.resolve(r);
    close();
  };
  return (
    <Dialog open onOpenChange={(o) => !o && finish(null)}>
      <DialogContent size="sm">
        <DialogHeader>
          <DialogTitle>{req.title}</DialogTitle>
          <DialogDescription>{req.description ?? "A reason is required. It is saved with the change and in the audit log."}</DialogDescription>
        </DialogHeader>
        <form
          className="grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            if (reason.length >= 3) finish(reason);
          }}
        >
          {req.options && (
            <Field label="Reason">
              <NativeSelect value={choice} onChange={(e) => setChoice(e.target.value)}>
                {req.options.map((o) => (
                  <option key={o}>{o}</option>
                ))}
              </NativeSelect>
            </Field>
          )}
          <Field label={req.options ? (needsText ? "Details" : "Note (optional)") : "Reason"} hint={needsText ? "At least 3 characters." : undefined}>
            <Textarea autoFocus value={text} onChange={(e) => setText(e.target.value)} placeholder={req.placeholder ?? "Write a short reason"} />
          </Field>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => finish(null)}>
              Cancel
            </Button>
            <Button type="submit" variant={req.destructive ? "destructive" : "default"} disabled={reason.length < 3}>
              {req.confirmLabel ?? "Confirm"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

const FORMAT_LABEL: Record<ExportFormat, string> = { pdf: "PDF", xlsx: "Excel", csv: "CSV" };

function ExportDialog({ req, close }: { req: ExportReq; close: () => void }) {
  const viewer = useViewer();
  const formats = req.formats ?? ["pdf", "xlsx"];
  const [format, setFormat] = React.useState<ExportFormat>(formats[0]);
  const stepUp = useStepUp();
  const [busy, setBusy] = React.useState(false);
  const empId = viewer?.employee.empId ?? "ACV-0000";
  const watermark = `${req.seal === "highly" || req.seal === "confidential" ? "Confidential, e" : "E"}xported by ${empId} on ${formatDateTime(new Date())}`;

  const run = async () => {
    if (req.stepUp) {
      close();
      const ok = await stepUp({ action: `Export ${req.title}`, detail: `${FORMAT_LABEL[format]} file, watermarked and logged.` });
      if (!ok) return req.resolve(null);
      toast.success(`${req.title} exported`, { description: `${FORMAT_LABEL[format]} file prepared (demo). The export is logged.` });
      return req.resolve(format);
    }
    setBusy(true);
    await new Promise((r) => setTimeout(r, 500));
    toast.success(`${req.title} exported`, { description: `${FORMAT_LABEL[format]} file prepared (demo). The export is logged.` });
    req.resolve(format);
    close();
  };

  return (
    <Dialog
      open
      onOpenChange={(o) => {
        if (!o) {
          req.resolve(null);
          close();
        }
      }}
    >
      <DialogContent size="sm">
        <DialogHeader>
          <span className="mb-1 grid size-10 place-content-center rounded-xl bg-primary/10 text-primary">
            <FileDown className="size-5" />
          </span>
          <DialogTitle>Export {req.title}</DialogTitle>
          <DialogDescription>{req.rows !== undefined ? `${req.rows} rows. ` : ""}Choose a format.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-4">
          <SegmentedControl value={format} onChange={setFormat} options={formats.map((f) => ({ value: f, label: FORMAT_LABEL[f] }))} ariaLabel="Format" />
          <div className="rounded-xl border border-dashed border-border bg-muted/50 p-3">
            <p className="mb-1.5 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Watermark on every page</p>
            <p className="font-mono text-[12px]">{watermark}</p>
          </div>
          <div className="flex flex-wrap items-center gap-2 text-[12.5px] text-muted-foreground">
            {req.seal && <ConfidentialSeal level={req.seal} compact />}
            <ScrollText className="size-3.5" /> This export is saved in activity tracking and the audit log.
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => {
              req.resolve(null);
              close();
            }}
          >
            Cancel
          </Button>
          <Button onClick={run} loading={busy}>
            {req.stepUp ? "Confirm and export" : "Export"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
