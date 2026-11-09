"use client";
/** Small display pieces used across the Sales module. */
import * as React from "react";
import {
  AlarmClock, Ban, Briefcase, CalendarCheck, CalendarClock, CheckCheck, FileText, Mail, MailCheck, MailX, MapPin, MessageCircle, Phone, Reply, Send, StickyNote, Store, Zap, Hand,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Tip } from "@/components/ui/overlays";
import { Money } from "@/components/shared/money";
import { formatDateShort } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { Money as MoneyT } from "@/types";
import { ACTIVITY_LABEL, CHECK_META, convert, SOURCE_LABEL, STAGE_META } from "../logic";
import type { ActivityKind, ActivitySource, DealStage, EmailCheck, LeadSource } from "../types";

/** Follow-ups are due on a day, not at a time: "Due today", "Missed · 2 days", "Tomorrow", "12 Nov". */
export function FollowUpDue({ date, className }: { date: string; className?: string }) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const diff = Math.round((d.getTime() - today.getTime()) / 86_400_000);
  const label = diff < 0 ? `Missed · ${-diff} day${diff === -1 ? "" : "s"} ago` : diff === 0 ? "Due today" : diff === 1 ? "Tomorrow" : formatDateShort(date);
  const tone = diff < 0 ? "danger" : diff === 0 ? "warning" : diff <= 3 ? "info" : "outline";
  return (
    <Badge tone={tone} className={cn(diff < 0 && "font-semibold", className)}>
      {diff < 0 ? <AlarmClock /> : <CalendarClock />} {label}
    </Badge>
  );
}

export function StageBadge({ stage, pending }: { stage: DealStage; pending?: boolean }) {
  const m = STAGE_META[stage];
  if (pending) return <Badge tone="warning" dot>Won · waiting for confirmation</Badge>;
  return (
    <Badge tone={m.tone} dot>
      {m.label}
    </Badge>
  );
}

export function SourceChip({ source }: { source: LeadSource }) {
  return <Badge tone={source === "apollo" ? "sales" : "outline"}>{SOURCE_LABEL[source]}</Badge>;
}

export function CheckBadge({ check }: { check: EmailCheck }) {
  const m = CHECK_META[check];
  const Icon = check === "valid" ? MailCheck : check === "invalid" ? MailX : Mail;
  return (
    <Badge tone={m.tone}>
      <Icon /> {m.label}
    </Badge>
  );
}

export function DncBadge() {
  return (
    <Tip content="Asked not to be contacted. This email is blocked from every future sequence.">
      <span tabIndex={0} className="outline-none">
        <Badge tone="danger">
          <Ban /> Do not contact
        </Badge>
      </span>
    </Tip>
  );
}

/** Auto (from a connected tool) or Manual (typed in) tag, plan §20 activity timeline. */
export function SourceTag({ source }: { source: ActivitySource }) {
  if (source === "manual")
    return (
      <Badge tone="outline">
        <Hand /> Manual
      </Badge>
    );
  const label = source === "apollo" ? "Apollo" : source === "millionverifier" ? "MillionVerifier" : "Mailbox";
  return (
    <Badge tone="signal">
      <Zap /> Auto ({label})
    </Badge>
  );
}

export const ACTIVITY_ICON: Record<ActivityKind, React.ReactNode> = {
  email_sent: <Send />,
  reply: <Reply />,
  bounce: <MailX />,
  call: <Phone />,
  meeting: <CalendarCheck />,
  linkedin: <Briefcase />,
  whatsapp: <MessageCircle />,
  fiverr: <Store />,
  proposal: <FileText />,
  note: <StickyNote />,
  email_check: <MailCheck />,
  follow_up: <CheckCheck />,
};

export const ACTIVITY_COLOR: Partial<Record<ActivityKind, string>> = {
  reply: "var(--success)",
  bounce: "var(--danger)",
  meeting: "var(--primary)",
  proposal: "var(--zone-finance)",
  email_sent: "var(--zone-sales)",
  email_check: "var(--zone-work)",
  follow_up: "var(--zone-control)",
};

export function activityLabel(kind: ActivityKind) {
  return ACTIVITY_LABEL[kind];
}

/** Deal value, optionally converted to a display currency. */
export function DealValue({ value, display, compact, className }: { value: MoneyT; display?: "USD" | "PKR"; compact?: boolean; className?: string }) {
  if (!display || display === value.currency) return compact ? <Money value={value} compact className={className} /> : <Money value={value} className={className} />;
  const converted = Math.round(convert(value, display));
  return (
    <Tip content={`Original: ${value.currency} ${Number(value.amount).toLocaleString()} · converted at the saved rate`}>
      <span tabIndex={0} className="outline-none">
        <Money value={converted} currency={display} compact={compact} className={cn("opacity-90", className)} />
      </span>
    </Tip>
  );
}

export const SELF_REPORTED_FIELDS: { key: "linkedin" | "whatsapp" | "fiverr" | "calls" | "fieldVisits"; label: string; icon: React.ReactNode }[] = [
  { key: "linkedin", label: "LinkedIn messages", icon: <Briefcase /> },
  { key: "whatsapp", label: "WhatsApp chats", icon: <MessageCircle /> },
  { key: "fiverr", label: "Fiverr inquiries", icon: <Store /> },
  { key: "calls", label: "Phone calls", icon: <Phone /> },
  { key: "fieldVisits", label: "Field visits", icon: <MapPin /> },
];
