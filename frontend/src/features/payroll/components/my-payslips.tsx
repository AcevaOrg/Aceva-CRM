"use client";
import * as React from "react";
import { toast } from "sonner";
import { Download, HandCoins, Printer, Receipt } from "lucide-react";
import { PageHeader } from "@/components/layout/page-header";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Progress, Skeleton } from "@/components/ui/misc";
import { Money } from "@/components/shared/money";
import { EmptyState, ErrorState, ListSkeleton } from "@/components/shared/states";
import { useViewer } from "@/lib/auth/viewer";
import { formatMonthKey } from "@/lib/dates";
import { toNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { useAdvances, usePayslips } from "../hooks";
import { PayslipDocument } from "./payslip-document";

/** /payroll/payslips: the viewer's own payslips, styled like the PDF (spec §9.8). */
export function MyPayslips() {
  const viewer = useViewer();
  const slips = usePayslips();
  const advances = useAdvances();
  const [selected, setSelected] = React.useState<string | null>(null);
  const list = slips.data ?? [];
  const slip = list.find((s) => s.id === selected) ?? list[0];
  const myAdvances = (advances.data ?? []).filter((a) => a.empId === viewer?.employee.empId && a.status === "active");

  return (
    <>
      <PageHeader
        title="My payslips"
        description="Your monthly pay, deductions and year-to-date totals. Only you, Finance, the Director and the CEO / Founder / Owner can see these."
        zone="work"
        seal="own"
        actions={
          slip && (
            <>
              <Button variant="outline" onClick={() => window.print()}>
                <Printer /> Print
              </Button>
              <Button onClick={() => toast.success(`Payslip for ${formatMonthKey(slip.month)} downloaded`, { description: "PDF prepared (demo)." })}>
                <Download /> Download PDF
              </Button>
            </>
          )
        }
      />
      {slips.isError ? (
        <ErrorState error={slips.error} onRetry={() => slips.refetch()} />
      ) : slips.isPending ? (
        <div className="grid gap-6 lg:grid-cols-[260px_1fr]">
          <ListSkeleton rows={4} />
          <Skeleton className="h-[520px] rounded-xl" />
        </div>
      ) : !list.length ? (
        <EmptyState icon={<Receipt />} title="No payslips yet" description="Your first payslip appears here after your first payroll is approved." />
      ) : (
        <div className="grid gap-6 lg:grid-cols-[260px_minmax(0,1fr)]">
          <div className="grid content-start gap-4">
            <nav aria-label="Payslip months" className="grid gap-1.5">
              {list.map((s) => {
                const active = s.id === slip?.id;
                return (
                  <button
                    key={s.id}
                    onClick={() => setSelected(s.id)}
                    aria-current={active ? "true" : undefined}
                    className={cn(
                      "flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-left transition",
                      active ? "border-primary/40 bg-primary/6 shadow-strata" : "border-border bg-card hover:bg-muted",
                    )}
                  >
                    <span>
                      <span className="block text-[13.5px] font-medium">{formatMonthKey(s.month)}</span>
                      <span className="text-[11.5px] text-muted-foreground">{s.unpaidDays ? `${s.unpaidDays} unpaid day${s.unpaidDays > 1 ? "s" : ""}` : "Full month"}</span>
                    </span>
                    <Money value={s.net} className="text-[13px] font-semibold" />
                  </button>
                );
              })}
            </nav>
            {myAdvances.map((a) => {
              const paid = toNumber(a.amount) - toNumber(a.remaining);
              return (
                <Card key={a.id}>
                  <CardHeader className="pb-2">
                    <div>
                      <CardTitle className="flex items-center gap-2 text-[14px]">
                        <HandCoins className="size-4 text-muted-foreground" /> Salary advance
                      </CardTitle>
                      <CardDescription>
                        <Money value={a.monthlyDeduction} /> a month from your salary
                      </CardDescription>
                    </div>
                  </CardHeader>
                  <CardContent className="grid gap-1.5">
                    <Progress value={paid} max={toNumber(a.amount)} label="Advance repaid" barClassName="bg-success" />
                    <p className="flex justify-between text-[12px] text-muted-foreground">
                      <span>
                        Repaid <Money value={paid} />
                      </span>
                      <span>
                        Left <Money value={a.remaining} />
                      </span>
                    </p>
                  </CardContent>
                </Card>
              );
            })}
          </div>
          {slip && <PayslipDocument slip={slip} canRevealBank />}
        </div>
      )}
    </>
  );
}
