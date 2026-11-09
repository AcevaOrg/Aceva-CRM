"use client";
import * as React from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  BadgeCheck, BookOpen, CalendarDays, CalendarCheck, Check, ClipboardCheck, Gauge, Hourglass, Inbox, Lock, Scale, Trophy, Wallet, HandCoins, Info, X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/overlays";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { PageHeader } from "@/components/layout/page-header";
import { useReason, useStepUp } from "@/components/shared/dialogs";
import { EmpChip } from "@/components/shared/emp-chip";
import { Money } from "@/components/shared/money";
import { StarRating } from "@/components/shared/pickers";
import { EmptyState, QueryState } from "@/components/shared/states";
import { useUrlState } from "@/hooks/use-url-state";
import { formatDate, formatDateShort, formatRelative } from "@/lib/dates";
import { cn } from "@/lib/utils";
import { useApprovals, useDecide } from "../hooks";
import { APPROVAL_TYPE_LABEL, type ApprovalItem, type ApprovalType } from "../types";

const ICON: Record<ApprovalType, React.ElementType> = {
  task_review: ClipboardCheck,
  extension: Hourglass,
  leave: CalendarDays,
  attendance_correction: CalendarCheck,
  journal_entry: BookOpen,
  payroll: Wallet,
  month_close: Lock,
  commission: HandCoins,
  won_deal: Trophy,
  scorecard: Gauge,
  dispute: Scale,
};

const COLOR: Record<ApprovalType, string> = {
  task_review: "var(--zone-work)",
  extension: "var(--zone-work)",
  leave: "var(--zone-work)",
  attendance_correction: "var(--zone-work)",
  journal_entry: "var(--zone-finance)",
  payroll: "var(--zone-finance)",
  month_close: "var(--zone-finance)",
  commission: "var(--zone-sales)",
  won_deal: "var(--zone-sales)",
  scorecard: "var(--zone-work)",
  dispute: "var(--zone-work)",
};

function ReviewApprove({ item, onApprove, busy }: { item: ApprovalItem; onApprove: (rating: number) => void; busy: boolean }) {
  const [rating, setRating] = React.useState(0);
  const [open, setOpen] = React.useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button size="sm" loading={busy}>
          <Check /> {item.approveLabel ?? "Approve"}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72">
        <p className="text-[13px] font-semibold">Rate the work</p>
        <p className="mb-3 text-[12px] text-muted-foreground">A rating from 1 to 5 is required. It goes straight into the scorecard.</p>
        <StarRating value={rating} onChange={setRating} size={24} />
        <Button
          className="mt-3 w-full"
          size="sm"
          disabled={!rating}
          onClick={() => {
            setOpen(false);
            onApprove(rating);
          }}
        >
          Approve with {rating || "…"} star{rating === 1 ? "" : "s"}
        </Button>
      </PopoverContent>
    </Popover>
  );
}

function ApprovalRow({ item }: { item: ApprovalItem }) {
  const decide = useDecide();
  const askReason = useReason();
  const stepUp = useStepUp();
  const Icon = ICON[item.type];
  const busy = decide.isPending;

  const approve = async (rating?: number) => {
    if (item.needsStepUp && !(await stepUp({ action: `${item.approveLabel ?? "Approve"}: ${item.title}`, detail: item.amount ? undefined : item.subtitle }))) return;
    await decide.mutateAsync({ item, decision: "approve", opts: { rating } });
    toast.success("Approved", { description: item.title });
  };
  const reject = async () => {
    const reason = await askReason({ title: item.rejectLabel ?? "Reject", description: "The requester sees this reason. It is saved in the audit log.", destructive: item.type !== "task_review", confirmLabel: item.rejectLabel ?? "Reject" });
    if (!reason) return;
    await decide.mutateAsync({ item, decision: "reject", opts: { reason } });
    toast(item.type === "task_review" ? "Sent back for rework" : "Rejected", { description: item.title });
  };

  return (
    <li className="flex flex-wrap items-center gap-x-4 gap-y-3 px-5 py-4 transition hover:bg-muted/40 lg:flex-nowrap">
      <span className="grid size-10 shrink-0 place-content-center rounded-xl" style={{ background: `color-mix(in oklch, ${COLOR[item.type]} 13%, transparent)`, color: COLOR[item.type] }}>
        <Icon className="size-[18px]" />
      </span>
      <div className="min-w-0 flex-1 basis-[60%]">
        <div className="flex flex-wrap items-center gap-x-2">
          <Link href={item.href} className="truncate text-[14px] font-medium hover:underline">
            {item.title}
          </Link>
          {item.refNumber && <span className="font-mono text-[11.5px] text-muted-foreground">{item.refNumber}</span>}
        </div>
        {item.subtitle && <p className="mt-0.5 line-clamp-2 text-[12.5px] text-muted-foreground">{item.subtitle}</p>}
      </div>
      <EmpChip empId={item.requester} size="sm" className="w-44" />
      <div className="w-36 text-[12.5px] lg:text-right">
        {item.amount ? (
          <Money value={item.amount} className="font-semibold" />
        ) : item.from ? (
          <span className="whitespace-nowrap tabular">
            {item.to && item.to !== item.from ? (
              <>
                {formatDateShort(item.from)} → {formatDateShort(item.to)}
              </>
            ) : (
              formatDate(item.from)
            )}
          </span>
        ) : null}
        <p className="text-[11.5px] text-muted-foreground">waiting {formatRelative(item.createdAt).replace(" ago", "")}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <Button size="sm" variant="outline" onClick={reject} disabled={busy}>
          <X /> {item.rejectLabel ?? "Reject"}
        </Button>
        {item.needsRating ? (
          <ReviewApprove item={item} busy={busy} onApprove={(r) => approve(r)} />
        ) : (
          <Button size="sm" onClick={() => approve()} loading={busy}>
            {item.needsStepUp ? <Lock /> : <Check />} {item.approveLabel ?? "Approve"}
          </Button>
        )}
      </div>
    </li>
  );
}

export function ApprovalsScreen() {
  const q = useApprovals();
  const [tab, setTab] = useUrlState<string>("type", "all");

  return (
    <>
      <PageHeader
        title="Approvals"
        description="Everything waiting for your decision, from every module, in one place. Oldest first."
        actions={
          <span className="inline-flex items-center gap-1.5 text-[12.5px] text-muted-foreground">
            <BadgeCheck className="size-4 text-success" /> Nobody approves their own request
          </span>
        }
      />
      <QueryState query={q}>
        {({ items, routedUp }) => {
          const types = [...new Set(items.map((i) => i.type))];
          const visible = tab === "all" ? items : items.filter((i) => i.type === tab);
          return (
            <>
              <Tabs value={types.includes(tab as ApprovalType) || tab === "all" ? tab : "all"} onValueChange={setTab}>
                <TabsList className="mb-5">
                  <TabsTrigger value="all">
                    All <Count n={items.length} />
                  </TabsTrigger>
                  {types.map((t) => (
                    <TabsTrigger key={t} value={t}>
                      {APPROVAL_TYPE_LABEL[t]} <Count n={items.filter((i) => i.type === t).length} />
                    </TabsTrigger>
                  ))}
                </TabsList>
              </Tabs>
              {visible.length ? (
                <Card className="overflow-hidden">
                  <ul className="divide-y divide-border">
                    {visible.map((i) => (
                      <ApprovalRow key={i.id} item={i} />
                    ))}
                  </ul>
                </Card>
              ) : (
                <EmptyState icon={<Inbox />} title="All clear" description="Nothing is waiting for your decision. New requests appear here and in the bell." />
              )}
              {routedUp > 0 && (
                <p className="mt-4 flex items-center gap-2 text-[12.5px] text-muted-foreground">
                  <Info className="size-4" /> {routedUp} item{routedUp > 1 ? "s" : ""} you prepared went to the next level up for approval (maker-checker).
                </p>
              )}
            </>
          );
        }}
      </QueryState>
    </>
  );
}

function Count({ n }: { n: number }) {
  return <span className={cn("rounded-full bg-muted px-1.5 text-[11px] font-semibold tabular", n > 0 && "bg-signal/50 text-signal-foreground")}>{n}</span>;
}
