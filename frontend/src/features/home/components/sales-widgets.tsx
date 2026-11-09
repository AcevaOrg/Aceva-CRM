"use client";
/** Home widgets from Sales and CRM (M15). */
import { SquareKanban } from "lucide-react";
import { Money } from "@/components/shared/money";
import { usePipelineSummary } from "@/features/sales/hooks";
import { OPEN_STAGES, STAGE_META } from "@/features/sales/logic";
import { PHASE2_ENABLED } from "@/lib/nav";
import { Widget, WidgetEmpty, WidgetSkeleton } from "./widget";

export { MySalesDayWidget } from "@/features/sales/components/my-sales-day-widget";

export function PipelineWidget() {
  const q = usePipelineSummary();
  if (!PHASE2_ENABLED) return null;
  const s = q.data;
  const max = Math.max(1, ...(s?.stages.filter((x) => OPEN_STAGES.includes(x.stage)).map((x) => x.valueUsd) ?? [1]));
  return (
    <Widget title="Sales pipeline" icon={<SquareKanban />} href="/sales/pipeline" seal="confidential">
      {q.isPending ? (
        <WidgetSkeleton rows={4} />
      ) : !s ? (
        <WidgetEmpty>The pipeline isn&apos;t available to you.</WidgetEmpty>
      ) : (
        <div className="grid gap-4">
          <div className="grid grid-cols-3 gap-3 text-[12px]">
            <div className="rounded-lg bg-muted/50 px-3 py-2">
              <p className="text-muted-foreground">Open ({s.openCount})</p>
              <p className="text-[16px] font-semibold"><Money value={s.openValueUsd} currency="USD" compact /></p>
            </div>
            <div className="rounded-lg bg-muted/50 px-3 py-2">
              <p className="text-muted-foreground">Won this month ({s.wonThisMonthCount})</p>
              <p className="text-[16px] font-semibold text-success"><Money value={s.wonThisMonthUsd} currency="USD" compact /></p>
            </div>
            <div className="rounded-lg bg-muted/50 px-3 py-2">
              <p className="text-muted-foreground">Lost this month</p>
              <p className="text-[16px] font-semibold tabular">{s.lostThisMonthCount}</p>
            </div>
          </div>
          <ul className="grid gap-1.5">
            {s.stages
              .filter((x) => OPEN_STAGES.includes(x.stage))
              .map((x) => (
                <li key={x.stage} className="grid grid-cols-[110px_1fr_70px] items-center gap-2 text-[12.5px]">
                  <span className="truncate text-muted-foreground">{STAGE_META[x.stage].label}</span>
                  <span className="h-2 overflow-hidden rounded-full bg-muted">
                    <span className="block h-full rounded-full" style={{ width: `${(x.valueUsd / max) * 100}%`, background: STAGE_META[x.stage].color }} />
                  </span>
                  <span className="text-right tabular">{x.count}</span>
                </li>
              ))}
          </ul>
          {s.pendingWonCount > 0 && <p className="text-[12.5px] text-muted-foreground">{s.pendingWonCount} won deal(s) waiting for manager confirmation.</p>}
        </div>
      )}
    </Widget>
  );
}
