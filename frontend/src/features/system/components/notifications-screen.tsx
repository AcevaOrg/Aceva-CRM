"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  AlarmClock, AtSign, Bell, BellOff, CalendarDays, CheckCheck, CircleCheck, ClipboardCheck, CreditCard, Gauge, Inbox, ListTodo, Lock,
  Megaphone, Plug, Receipt, Repeat, ShieldAlert, Sunrise, Wallet,
} from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardFooter, CardHeader, CardTitle } from "@/components/ui/card";
import { NativeSelect, SegmentedControl, Switch } from "@/components/ui/controls";
import { Label } from "@/components/ui/label";
import { Tip } from "@/components/ui/overlays";
import { Skeleton } from "@/components/ui/misc";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/shared/states";
import { formatDate, formatRelative, formatTime, isoDay } from "@/lib/dates";
import { useCan } from "@/lib/auth/viewer";
import { cn } from "@/lib/utils";
import { useMarkRead, useNotificationPrefs, useNotifications, useSaveNotificationPrefs } from "../hooks";
import { NOTIFICATION_LABEL } from "../logic";
import { ESSENTIAL_TYPES, NOTIFICATION_GROUP, type Notification, type NotificationPrefs, type NotificationType } from "../types";

const ICON: Record<NotificationType, React.ElementType> = {
  task_assigned: ListTodo, task_due_soon: AlarmClock, task_overdue: AlarmClock, task_reviewed: ClipboardCheck,
  extension_requested: AlarmClock, extension_answered: AlarmClock, leave_requested: CalendarDays, leave_answered: CalendarDays,
  approval_waiting: Inbox, payroll_ready: Wallet, payslip_available: Receipt, scorecard_released: Gauge,
  security_alert: ShieldAlert, sales_reply: Sunrise, sales_follow_up: Sunrise, sales_tool_problem: Plug,
  message_mention: AtSign, announcement: Megaphone, renewal_due: Repeat, invoice_overdue: CreditCard,
};

const PREF_GROUPS: { title: string; types: NotificationType[]; permission?: Parameters<typeof useCan>[0] }[] = [
  { title: "Work", types: ["task_assigned", "task_due_soon", "task_overdue", "task_reviewed", "extension_answered", "leave_answered"] },
  { title: "Approvals", types: ["approval_waiting", "extension_requested", "leave_requested", "payroll_ready"] },
  { title: "Pay and results", types: ["payslip_available", "scorecard_released"] },
  { title: "Messages", types: ["message_mention", "announcement"] },
  { title: "Security", types: ["security_alert"] },
  { title: "Sales", types: ["sales_reply", "sales_follow_up", "sales_tool_problem"], permission: "sales.own" },
  { title: "Finance", types: ["renewal_due", "invoice_overdue"], permission: "billing.view" },
];

function dayLabel(iso: string) {
  const d = isoDay(iso);
  const today = isoDay(new Date());
  const y = new Date();
  y.setDate(y.getDate() - 1);
  if (d === today) return "Today";
  if (d === isoDay(y)) return "Yesterday";
  return formatDate(iso);
}

export function NotificationsScreen() {
  const q = useNotifications();
  const markRead = useMarkRead();
  const [tab, setTab] = React.useState<"all" | "unread" | "approvals" | "mentions">("all");
  const [type, setType] = React.useState<"" | NotificationType>("");
  const all = q.data ?? [];
  const unread = all.filter((n) => !n.read).length;
  const list = all.filter((n) => {
    if (tab === "unread" && n.read) return false;
    if ((tab === "approvals" || tab === "mentions") && NOTIFICATION_GROUP[n.type] !== tab) return false;
    if (type && n.type !== type) return false;
    return true;
  });
  const groups = list.reduce<Record<string, Notification[]>>((acc, n) => {
    (acc[dayLabel(n.at)] ||= []).push(n);
    return acc;
  }, {});
  const typesPresent = Array.from(new Set(all.map((n) => n.type)));

  return (
    <>
      <PageHeader
        title="Notifications"
        description="Everything the system told you, and how you want to hear about it by email."
        zone="control"
        actions={
          <Button variant="outline" onClick={() => markRead.mutate(undefined, { onSuccess: () => toast.success("All marked as read") })} disabled={!unread}>
            <CheckCheck /> Mark all read
          </Button>
        }
      />
      <div className="grid gap-6 xl:grid-cols-[minmax(0,1fr)_380px]">
        <section className="grid content-start gap-4">
          <div className="flex flex-wrap items-center gap-2">
            <SegmentedControl
              value={tab}
              onChange={setTab}
              ariaLabel="Filter notifications"
              options={[
                { value: "all", label: "All" },
                { value: "unread", label: `Unread${unread ? ` · ${unread}` : ""}` },
                { value: "approvals", label: "Approvals" },
                { value: "mentions", label: "Mentions" },
              ]}
            />
            <NativeSelect value={type} onChange={(e) => setType(e.target.value as NotificationType | "")} className="w-56" aria-label="Type">
              <option value="">All types</option>
              {typesPresent.map((t) => (
                <option key={t} value={t}>
                  {NOTIFICATION_LABEL[t]}
                </option>
              ))}
            </NativeSelect>
          </div>
          {q.isError ? (
            <ErrorState error={q.error} onRetry={() => q.refetch()} />
          ) : q.isPending ? (
            <ListSkeleton rows={6} />
          ) : !list.length ? (
            <EmptyState icon={<CircleCheck />} title="You're all caught up" description={tab === "all" && !type ? "New notifications appear here." : "Nothing matches this filter."} />
          ) : (
            Object.entries(groups).map(([label, items]) => (
              <div key={label} className="grid gap-2">
                <h2 className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</h2>
                <ul className="overflow-hidden rounded-xl border border-border bg-card shadow-strata">
                  {items.map((n) => {
                    const Icon = ICON[n.type] ?? Bell;
                    return (
                      <li key={n.id} className="border-b border-border last:border-0">
                        <Link
                          href={n.link ?? "#"}
                          onClick={() => !n.read && markRead.mutate([n.id])}
                          className={cn("flex gap-3 px-4 py-3 transition hover:bg-muted/60", !n.read && "bg-primary/[0.04]")}
                        >
                          <span className={cn("grid size-9 shrink-0 place-content-center rounded-xl border border-border bg-muted text-muted-foreground", n.type === "security_alert" && "border-danger/30 bg-danger/10 text-danger", n.essential && n.type !== "security_alert" && "border-primary/25 bg-primary/8 text-primary")}>
                            <Icon className="size-4" />
                          </span>
                          <span className="grid min-w-0 flex-1 gap-0.5">
                            <span className="flex items-start justify-between gap-3">
                              <span className={cn("text-[13.5px] leading-snug", !n.read ? "font-semibold" : "font-medium")}>{n.title}</span>
                              <Tip content={`${formatDate(n.at)}, ${formatTime(n.at)}`}>
                                <span className="shrink-0 text-[11.5px] text-muted-foreground">{formatRelative(n.at)}</span>
                              </Tip>
                            </span>
                            {n.body && <span className="text-[12.5px] text-muted-foreground">{n.body}</span>}
                            <span className="text-[11px] text-muted-foreground">{NOTIFICATION_LABEL[n.type]}</span>
                          </span>
                          {!n.read && <span className="mt-2 size-2 shrink-0 rounded-full bg-primary" aria-label="Unread" />}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))
          )}
        </section>
        <EmailPreferences />
      </div>
    </>
  );
}

function EmailPreferences() {
  const prefs = useNotificationPrefs();
  if (!prefs.data)
    return (
      <Card className="h-fit">
        <CardContent className="pt-5">
          <Skeleton className="h-80 rounded-lg" />
        </CardContent>
      </Card>
    );
  // Remount when saved prefs change so the draft starts from them.
  return <PrefsForm key={JSON.stringify(prefs.data)} saved={prefs.data} />;
}

function PrefsForm({ saved }: { saved: NotificationPrefs }) {
  const save = useSaveNotificationPrefs();
  const canSales = useCan("sales.own");
  const canBilling = useCan("billing.view");
  const isManager = useCan("task.view_team");
  const [draft, setDraft] = React.useState<NotificationPrefs | null>(saved);
  const prefs = { data: saved };

  const isOn = (t: NotificationType) => ESSENTIAL_TYPES.includes(t) || draft?.email[t] !== false;
  const dirty = !!draft && !!prefs.data && JSON.stringify(draft) !== JSON.stringify(prefs.data);
  const groups = PREF_GROUPS.filter((g) => (g.title === "Sales" ? canSales : g.title === "Finance" ? canBilling : true));

  return (
    <Card className="h-fit xl:sticky xl:top-20">
      <CardHeader>
        <div>
          <CardTitle>Email preferences</CardTitle>
          <CardDescription>Emails come from an @acevatech.com address. Approvals and security alerts can&apos;t be turned off.</CardDescription>
        </div>
      </CardHeader>
      <CardContent className="grid gap-4">
        {!draft ? (
          <Skeleton className="h-80 rounded-lg" />
        ) : (
          <>
            {isManager && (
              <label className="flex items-start justify-between gap-3 rounded-lg border border-border bg-muted/40 p-3">
                <span className="grid gap-0.5">
                  <span className="text-[13px] font-medium">Daily summary email</span>
                  <span className="text-[12px] text-muted-foreground">One email each morning for your team instead of many single emails.</span>
                </span>
                <Switch checked={draft.dailySummary} onCheckedChange={(v) => setDraft({ ...draft, dailySummary: v })} aria-label="Daily summary email" />
              </label>
            )}
            {groups.map((g) => (
              <div key={g.title} className="grid gap-1.5">
                <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{g.title}</p>
                <ul className="grid gap-1">
                  {g.types.map((t) => {
                    const locked = ESSENTIAL_TYPES.includes(t);
                    return (
                      <li key={t} className="flex items-center justify-between gap-3 py-1">
                        <Label htmlFor={`pref-${t}`} className="flex items-center gap-1.5 font-normal">
                          {NOTIFICATION_LABEL[t]}
                          {locked && (
                            <Tip content="Approvals and security alerts are always emailed (plan §17).">
                              <Lock className="size-3 text-muted-foreground" aria-label="Always on" />
                            </Tip>
                          )}
                        </Label>
                        <Switch
                          id={`pref-${t}`}
                          checked={isOn(t)}
                          disabled={locked}
                          onCheckedChange={(v) => setDraft({ ...draft, email: { ...draft.email, [t]: v } })}
                        />
                      </li>
                    );
                  })}
                </ul>
              </div>
            ))}
          </>
        )}
      </CardContent>
      <CardFooter className="justify-between">
        <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground">
          <BellOff className="size-3.5" /> In-app notifications always show.
        </span>
        <Button
          size="sm"
          disabled={!dirty}
          loading={save.isPending}
          onClick={() => draft && save.mutate(draft, { onSuccess: () => toast.success("Email preferences saved") })}
        >
          Save
        </Button>
      </CardFooter>
    </Card>
  );
}
