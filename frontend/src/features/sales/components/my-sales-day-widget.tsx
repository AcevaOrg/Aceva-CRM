"use client";
/**
 * Compact "My sales day" for the Home dashboard (plan §17: sales staff home).
 * Usage: <MySalesDayWidget /> — renders nothing for people without sales targets in scope.
 * For the Director (sales manager) it shows a salesperson's day and says whose it is.
 */
import Link from "next/link";
import { AlarmClock, ArrowRight, Reply } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/misc";
import { FreshnessStamp } from "@/components/shared/chips";
import { ProgressRing } from "@/components/shared/metrics";
import { useLookup } from "@/hooks/use-directory";
import { useSession } from "@/lib/auth/session";
import { useMySalesDay } from "../hooks";
import { emailsSentTotal, followUpsTotal, leadsAddedTotal } from "../logic";

export function MySalesDayWidget({ className }: { className?: string }) {
  const q = useMySalesDay();
  const me = useSession((st) => st.empId);
  const lookup = useLookup();
  if (q.isPending) return <Skeleton className="h-64 rounded-xl" />;
  if (q.isError || !q.data) return null;
  const { summary: s, targets: t, followUpsDue, newReplies, apolloLastSyncAt } = q.data;
  const missed = followUpsDue.filter((f) => f.missed).length;
  const mine = q.data.empId === me;
  const href = mine ? "/sales" : `/sales?person=${q.data.empId}`;
  return (
    <Card className={className}>
      <CardHeader>
        <div>
          <CardTitle>{mine ? "My sales day" : `Sales day · ${lookup.employee(q.data.empId)?.name ?? q.data.empId}`}</CardTitle>
          <FreshnessStamp source="Apollo" at={apolloLastSyncAt} />
        </div>
        <Button asChild size="sm" variant="ghost">
          <Link href={href}>
            Open <ArrowRight />
          </Link>
        </Button>
      </CardHeader>
      <CardContent className="grid gap-4">
        <div className="grid grid-cols-4 gap-2">
          <ProgressRing value={leadsAddedTotal(s)} target={t.leadsAdded} label="Leads" size={64} color="var(--zone-sales)" />
          <ProgressRing value={s.emailsChecked} target={t.emailsChecked} label="Checked" size={64} color="var(--zone-sales)" />
          <ProgressRing value={emailsSentTotal(s)} target={t.emailsSent} label="Sent" size={64} color="var(--zone-sales)" />
          <ProgressRing value={followUpsTotal(s)} target={t.followUps} label="Follow-ups" size={64} color="var(--zone-sales)" />
        </div>
        <div className="grid grid-cols-2 gap-2 text-[12.5px]">
          <Link href={href} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 transition hover:bg-muted">
            <AlarmClock className={missed ? "size-4 text-danger" : "size-4 text-muted-foreground"} />
            <span>
              <span className="font-semibold tabular">{followUpsDue.length}</span> follow-ups due{missed ? <span className="text-danger"> · {missed} missed</span> : null}
            </span>
          </Link>
          <Link href={href} className="flex items-center gap-2 rounded-lg border border-border px-3 py-2 transition hover:bg-muted">
            <Reply className="size-4 text-success" />
            <span>
              <span className="font-semibold tabular">{newReplies.length}</span> new replies
            </span>
          </Link>
        </div>
      </CardContent>
    </Card>
  );
}
