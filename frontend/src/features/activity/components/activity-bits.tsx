"use client";
/** Small display helpers for Module 4: action labels/icons, source chips, the fair-use dialog. */
import * as React from "react";
import {
  Ban, CircleCheck, CircleX, Download, Eye, FileUp, Info, LogIn, LogOut, Mail, MailCheck, MailWarning, MessageSquare, MonitorSmartphone,
  Pencil, Phone, Plus, Printer, Reply, Send, ShieldAlert, ThumbsDown, ThumbsUp, Trash2, UserPlus,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { POLICY_VERSION, TRACKING_NEVER, TRACKING_RECORDED } from "@/features/auth/policy";
import type { ActivityAction, ActivitySource } from "../types";

export const ACTION_META: Record<ActivityAction, { label: string; icon: React.ElementType; color: string }> = {
  login: { label: "Login", icon: LogIn, color: "var(--success)" },
  logout: { label: "Logout", icon: LogOut, color: "var(--muted-foreground)" },
  login_failed: { label: "Failed login", icon: CircleX, color: "var(--danger)" },
  screen_view: { label: "Opened screen", icon: MonitorSmartphone, color: "var(--zone-control)" },
  create: { label: "Create", icon: Plus, color: "var(--primary)" },
  edit: { label: "Edit", icon: Pencil, color: "var(--primary)" },
  delete: { label: "Delete", icon: Trash2, color: "var(--danger)" },
  submit: { label: "Submit", icon: Send, color: "var(--primary)" },
  assign: { label: "Assign", icon: UserPlus, color: "var(--primary)" },
  approve: { label: "Approve", icon: ThumbsUp, color: "var(--success)" },
  reject: { label: "Reject", icon: ThumbsDown, color: "var(--warning)" },
  comment: { label: "Comment", icon: MessageSquare, color: "var(--zone-work)" },
  upload: { label: "Upload", icon: FileUp, color: "var(--zone-work)" },
  download: { label: "Download", icon: Download, color: "var(--zone-work)" },
  export: { label: "Export", icon: Download, color: "var(--seal-confidential)" },
  print: { label: "Print", icon: Printer, color: "var(--seal-confidential)" },
  sensitive_view: { label: "Sensitive view", icon: Eye, color: "var(--seal-highly)" },
  blocked: { label: "Blocked attempt", icon: Ban, color: "var(--danger)" },
  security: { label: "Security event", icon: ShieldAlert, color: "var(--danger)" },
  email_sent: { label: "Emails sent", icon: Mail, color: "var(--zone-sales)" },
  reply: { label: "Reply", icon: Reply, color: "var(--zone-sales)" },
  bounce: { label: "Bounce", icon: MailWarning, color: "var(--warning)" },
  call: { label: "Call", icon: Phone, color: "var(--zone-sales)" },
  email_check: { label: "Email check", icon: MailCheck, color: "var(--zone-sales)" },
};

const SOURCE_LABEL: Record<ActivitySource, string> = { aceva: "Aceva", apollo: "Apollo", millionverifier: "MillionVerifier", mailbox: "Mailbox" };

/** Sales-tool events carry the tool's name (plan §8). */
export function SourceChip({ source }: { source: ActivitySource }) {
  if (source === "aceva") return <span className="text-[12px] text-muted-foreground">Aceva</span>;
  return <Badge tone="sales">{SOURCE_LABEL[source]}</Badge>;
}

export function ActionBadge({ action }: { action: ActivityAction }) {
  const m = ACTION_META[action];
  const Icon = m.icon;
  return (
    <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[12.5px] font-medium">
      <span className="grid size-5 place-content-center rounded-md" style={{ color: m.color, background: `color-mix(in oklch, ${m.color} 12%, transparent)` }}>
        <Icon className="size-3" />
      </span>
      {m.label}
    </span>
  );
}

export const SOURCES = SOURCE_LABEL;

/** "Fair use" explainer: what is tracked and what never is (plan §8). */
export function FairUseButton() {
  const [open, setOpen] = React.useState(false);
  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Info /> Fair use
      </Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent size="lg">
          <DialogHeader>
            <DialogTitle>What activity tracking covers</DialogTitle>
            <DialogDescription>
              Tracking covers activity inside the Aceva Digital System and, for sales staff, work counts from the company&apos;s own accounts on connected sales tools. Everyone accepts this policy (version {POLICY_VERSION}) at first login and can see their own history.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="rounded-xl border border-seal-own/30 bg-seal-own/6 p-4">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Recorded</p>
              <ul className="grid gap-1.5 text-[13px]">
                {TRACKING_RECORDED.map((t) => (
                  <li key={t} className="flex gap-2"><CircleCheck className="mt-0.5 size-4 shrink-0 text-seal-own" /> {t}</li>
                ))}
              </ul>
            </div>
            <div className="rounded-xl border border-border bg-muted/50 p-4">
              <p className="mb-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Never recorded</p>
              <ul className="grid gap-1.5 text-[13px]">
                {TRACKING_NEVER.map((t) => (
                  <li key={t} className="flex gap-2"><CircleX className="mt-0.5 size-4 shrink-0 text-muted-foreground" /> {t}</li>
                ))}
              </ul>
            </div>
          </div>
          <ul className="grid gap-1 text-[12.5px] text-muted-foreground">
            <li>· Nobody, at any level, can edit or delete tracking data.</li>
            <li>· Tracking data is confidential and used only for security and work review.</li>
            <li>· Sessions and screens are kept 1 year, actions 3 years, finance-linked records at least 10 years.</li>
          </ul>
        </DialogContent>
      </Dialog>
    </>
  );
}
