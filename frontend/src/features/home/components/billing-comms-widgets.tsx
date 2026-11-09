"use client";
/** Home widgets from Billing (M13) and Communication (M14). */
import Link from "next/link";
import { toast } from "sonner";
import { CalendarClock, Check, CreditCard, Megaphone, Pin } from "lucide-react";
import { Button } from "@/components/ui/button";
import { DeadlineChip } from "@/components/shared/chips";
import { AvatarStack } from "@/components/shared/emp-chip";
import { Money } from "@/components/shared/money";
import { useBillingOverview } from "@/features/billing/hooks";
import { useAcknowledge, useAnnouncements, useUpcomingMeetings } from "@/features/comms/hooks";
import { formatDateShort, formatRelative, formatTime, formatWeekday } from "@/lib/dates";
import { Widget, WidgetEmpty, WidgetSkeleton } from "./widget";

export function BillingWidget() {
  const q = useBillingOverview();
  const b = q.data;
  return (
    <Widget title="Billing" icon={<CreditCard />} href="/billing" seal="confidential">
      {q.isPending ? (
        <WidgetSkeleton rows={3} />
      ) : !b ? (
        <WidgetEmpty>Billing isn&apos;t available to you.</WidgetEmpty>
      ) : (
        <div className="grid gap-4">
          <div className="grid grid-cols-3 gap-3">
            <Stat label="Collected this month" value={<Money value={b.collectedThisMonth} compact />} />
            <Stat label="Outstanding" value={<Money value={b.outstanding} compact />} />
            <Stat label={`Overdue (${b.overdueCount})`} value={<Money value={b.overdueAmount} compact className={b.overdueCount ? "text-danger" : ""} />} />
          </div>
          {b.renewalsSoon.length > 0 && (
            <div>
              <p className="mb-1.5 text-[11.5px] font-semibold uppercase tracking-wider text-muted-foreground">Renewals in the next 14 days</p>
              <ul className="grid gap-1">
                {b.renewalsSoon.slice(0, 3).map((s) => (
                  <li key={s.id} className="flex items-center justify-between gap-2 text-[13px]">
                    <span className="truncate">
                      {s.vendor} · {s.product}
                    </span>
                    <span className="flex shrink-0 items-center gap-2">
                      <Money value={s.cost} className="text-[12px] text-muted-foreground" />
                      <DeadlineChip deadline={s.renewalDate} />
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {b.draftsFromSales.length > 0 && (
            <Link href="/billing?tab=invoices" className="rounded-lg border border-zone-sales/35 bg-zone-sales/10 px-3 py-2 text-[12.5px] font-medium hover:bg-zone-sales/15">
              From sales: {b.draftsFromSales.length} draft invoice{b.draftsFromSales.length > 1 ? "s" : ""} to check
            </Link>
          )}
        </div>
      )}
    </Widget>
  );
}

function Stat({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="rounded-lg bg-muted/50 px-3 py-2">
      <p className="truncate text-[11.5px] text-muted-foreground">{label}</p>
      <p className="text-[16px] font-semibold">{value}</p>
    </div>
  );
}

export function AnnouncementsWidget() {
  const q = useAnnouncements();
  const ack = useAcknowledge();
  const list = q.data ?? [];
  const toAck = list.filter((a) => a.requiresAck && !a.acknowledgedByMe);
  const shown = [...toAck, ...list.filter((a) => !toAck.includes(a))].slice(0, 3);
  return (
    <Widget title="Announcements" icon={<Megaphone />} href="/announcements">
      {q.isPending ? (
        <WidgetSkeleton />
      ) : shown.length ? (
        <ul className="grid gap-3">
          {shown.map((a) => (
            <li key={a.id} className="grid gap-1">
              <div className="flex items-start justify-between gap-3">
                <Link href="/announcements" className="flex items-center gap-1.5 text-[13.5px] font-medium hover:underline">
                  {a.pinned && <Pin className="size-3.5 shrink-0 text-primary" />}
                  {a.title}
                </Link>
                <span className="shrink-0 text-[11.5px] text-muted-foreground">{formatRelative(a.at)}</span>
              </div>
              <p className="line-clamp-2 text-[12.5px] text-muted-foreground">{a.body}</p>
              {a.requiresAck && !a.acknowledgedByMe && (
                <Button
                  size="sm"
                  variant="outline"
                  className="w-fit"
                  loading={ack.isPending}
                  onClick={() => ack.mutate(a.id, { onSuccess: () => toast.success("Acknowledged") })}
                >
                  <Check /> Acknowledge
                </Button>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <WidgetEmpty>No announcements.</WidgetEmpty>
      )}
    </Widget>
  );
}

export function MeetingsWidget() {
  const q = useUpcomingMeetings(4);
  return (
    <Widget title="Upcoming meetings" icon={<CalendarClock />} href="/meetings">
      {q.isPending ? (
        <WidgetSkeleton />
      ) : q.data?.length ? (
        <ul className="-mx-2 grid">
          {q.data.map((m) => (
            <li key={m.id}>
              <Link href={`/meetings/${m.id}`} className="flex items-center gap-3 rounded-lg px-2 py-2 transition hover:bg-muted">
                <span className="grid w-12 shrink-0 text-center leading-tight">
                  <span className="text-[11px] font-semibold uppercase text-muted-foreground">{formatWeekday(m.start)}</span>
                  <span className="text-[13px] font-semibold tabular">{formatTime(m.start)}</span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[13.5px] font-medium">{m.title}</span>
                  <span className="block truncate text-[12px] text-muted-foreground">
                    {formatDateShort(m.start)} · {m.durationMin} min · {m.location}
                  </span>
                </span>
                <AvatarStack empIds={m.participants.map((p) => p.empId)} max={3} size={22} />
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <WidgetEmpty>No meetings coming up.</WidgetEmpty>
      )}
    </Widget>
  );
}
