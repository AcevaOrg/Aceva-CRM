"use client";
import * as React from "react";
import { toast } from "sonner";
import { ChevronDown, ChevronRight, FilePlus2, Flag, Receipt, Search, TriangleAlert } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/controls";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Tip } from "@/components/ui/overlays";
import { Label } from "@/components/ui/label";
import { EmpChip } from "@/components/shared/emp-chip";
import { MaskedValue } from "@/components/shared/masked-value";
import { Money } from "@/components/shared/money";
import { EmptyState } from "@/components/shared/states";
import { useLookup } from "@/hooks/use-directory";
import { formatMoney, toNumber } from "@/lib/format";
import { cn } from "@/lib/utils";
import { usePayslipFor } from "../hooks";
import { isLocked, stageIndex, VARIANCE_FLAG, variancePct } from "../logic";
import type { PayrollLine, PayrollRun } from "../types";
import { AdjustmentDialog } from "./adjustment-dialog";
import { PayslipDocument } from "./payslip-document";

const num = (m: { amount: string }) => toNumber(m.amount);

function VarianceCell({ line }: { line: PayrollLine }) {
  const v = variancePct(line);
  if (v === undefined) return <span className="text-[12px] text-muted-foreground">New</span>;
  const flagged = Math.abs(v) > VARIANCE_FLAG;
  return (
    <Tip content={flagged ? `Changed more than ${VARIANCE_FLAG}% from last month. Check before approving.` : "Change from last month's net"}>
      <span tabIndex={0} className={cn("inline-flex items-center gap-1 font-mono text-[12px] tabular outline-none", flagged ? "font-semibold text-[oklch(0.58_0.15_60)]" : "text-muted-foreground")}>
        {flagged && <Flag className="size-3" />}
        {v > 0 ? "+" : v < 0 ? "−" : ""}
        {Math.abs(v).toFixed(1)}%
      </span>
    </Tip>
  );
}

function Formula({ line, run }: { line: PayrollLine; run: PayrollRun }) {
  const parts: [string, number, "+" | "−"][] = [
    ["base", num(line.base), "+"],
    ["allowances", num(line.allowances), "+"],
    ["bonus", num(line.bonus), "+"],
    ["commission", num(line.commission), "+"],
    ["adjustment", num(line.adjustment), "+"],
    ["unpaid leave", num(line.unpaidDeduction), "−"],
    ["tax", num(line.tax), "−"],
    ["other deductions", num(line.otherDeductions), "−"],
  ];
  return (
    <div className="grid gap-2 font-mono text-[12px] leading-relaxed">
      <p>
        <span className="font-sans font-semibold">Net</span> ={" "}
        {parts.map(([label, v, op], i) => (
          <span key={label} className={cn(!v && "text-muted-foreground/60")}>
            {i > 0 && ` ${op} `}
            {label} {formatMoney(v).replace("PKR ", "")}
          </span>
        ))}{" "}
        = <span className="font-semibold">{formatMoney(num(line.net))}</span>
      </p>
      {line.unpaidDays > 0 && (
        <p>
          <span className="font-sans font-semibold">Unpaid leave</span> = base {formatMoney(num(line.base)).replace("PKR ", "")} ÷ {run.workingDays} working days × {line.unpaidDays} day
          {line.unpaidDays > 1 ? "s" : ""} = {formatMoney(num(line.unpaidDeduction))}
        </p>
      )}
      <p className="font-sans text-muted-foreground">Tax: yearly slab on (gross {formatMoney(num(line.gross))} × 12), divided by 12.</p>
    </div>
  );
}

function PayslipViewer({ run, empId, onClose }: { run: PayrollRun; empId: string | null; onClose: () => void }) {
  const q = usePayslipFor(run.id, empId);
  return (
    <Dialog open={!!empId} onOpenChange={(o) => !o && onClose()}>
      <DialogContent size="xl" className="bg-background">
        <DialogHeader>
          <DialogTitle>Payslip</DialogTitle>
          <DialogDescription>Opening someone else&apos;s payslip is a sensitive view and is logged.</DialogDescription>
        </DialogHeader>
        {q.data ? <PayslipDocument slip={q.data} canRevealBank /> : <p className="py-10 text-center text-[13px] text-muted-foreground">{q.isPending ? "Loading…" : "No payslip yet."}</p>}
      </DialogContent>
    </Dialog>
  );
}

export function RunLinesTable({ run, lines }: { run: PayrollRun; lines: PayrollLine[] }) {
  const lookup = useLookup();
  const [open, setOpen] = React.useState<Set<string>>(new Set());
  const [q, setQ] = React.useState("");
  const [flaggedOnly, setFlaggedOnly] = React.useState(false);
  const [payslipFor, setPayslipFor] = React.useState<string | null>(null);
  const [adjustFor, setAdjustFor] = React.useState<string | null>(null);
  const locked = isLocked(run.stage);
  const hasPayslips = stageIndex(run.stage) >= stageIndex("payslips_sent");

  const flaggedCount = lines.filter((l) => Math.abs(variancePct(l) ?? 0) > VARIANCE_FLAG).length;
  const shown = lines.filter((l) => {
    const e = lookup.employee(l.empId);
    const text = `${e?.name ?? ""} ${l.empId}`.toLowerCase();
    if (q && !text.includes(q.toLowerCase())) return false;
    if (flaggedOnly && !(Math.abs(variancePct(l) ?? 0) > VARIANCE_FLAG)) return false;
    return true;
  });
  const sumOf = (f: (l: PayrollLine) => number) => shown.reduce((s, l) => s + f(l), 0);
  const toggle = (id: string) =>
    setOpen((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  return (
    <div className="grid gap-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative w-full sm:w-72">
          <Search className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name or Emp-ID" className="pl-8" aria-label="Search lines" />
        </div>
        <div className="flex items-center gap-2">
          <Switch id="flagged" checked={flaggedOnly} onCheckedChange={setFlaggedOnly} />
          <Label htmlFor="flagged" className="font-normal">
            Changed over {VARIANCE_FLAG}% only
          </Label>
          {flaggedCount > 0 && (
            <Badge tone="warning">
              <TriangleAlert /> {flaggedCount} flagged
            </Badge>
          )}
        </div>
      </div>

      {!shown.length ? (
        <EmptyState compact title="No matching lines" description="Try a different search or turn off the filter." />
      ) : (
        <div className="overflow-x-auto rounded-xl border border-border bg-card shadow-strata scrollbar-thin">
          <table className="w-full min-w-[980px] border-collapse text-[13px]">
            <thead>
              <tr className="border-b border-border text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
                <th className="w-8 py-2.5 pl-3" aria-label="Expand" />
                <th className="py-2.5 pr-3">Employee</th>
                <th className="px-3 py-2.5 text-right">Base + allowances</th>
                <th className="px-3 py-2.5 text-right">Bonus · commission</th>
                <th className="px-3 py-2.5 text-right">Unpaid leave</th>
                <th className="px-3 py-2.5 text-right">Tax</th>
                <th className="px-3 py-2.5 text-right">Other</th>
                <th className="px-3 py-2.5 text-right">Net</th>
                <th className="py-2.5 pl-3 pr-5 text-right">vs last month</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((l) => {
                const isOpen = open.has(l.id);
                const name = lookup.employee(l.empId)?.name ?? l.empId;
                const extra = num(l.bonus) + num(l.commission) + num(l.adjustment);
                return (
                  <React.Fragment key={l.id}>
                    <tr className={cn("border-b border-border transition-colors hover:bg-muted/50", isOpen && "bg-muted/40")}>
                      <td className="py-2 pl-3">
                        <button onClick={() => toggle(l.id)} aria-expanded={isOpen} aria-label={`${isOpen ? "Hide" : "Show"} details for ${name}`} className="rounded p-1 text-muted-foreground hover:bg-muted hover:text-foreground">
                          {isOpen ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                        </button>
                      </td>
                      <td className="py-2 pr-3">
                        <EmpChip empId={l.empId} size="sm" />
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Money value={num(l.base) + num(l.allowances)} />
                      </td>
                      <td className="px-3 py-2 text-right">
                        {extra ? <Money value={extra} /> : <span className="text-muted-foreground">—</span>}
                        {num(l.commission) > 0 && (
                          <span className="mt-0.5 flex justify-end">
                            <Badge tone="sales">Commission</Badge>
                          </span>
                        )}
                        {num(l.adjustment) !== 0 && (
                          <span className="mt-0.5 flex justify-end">
                            <Badge tone="info">Adjustment</Badge>
                          </span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {l.unpaidDays ? (
                          <>
                            <Money value={-num(l.unpaidDeduction)} />
                            <p className="text-[11.5px] text-muted-foreground">
                              {l.unpaidDays} day{l.unpaidDays > 1 ? "s" : ""}
                            </p>
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        <Money value={-num(l.tax)} className="text-muted-foreground" />
                      </td>
                      <td className="px-3 py-2 text-right">{num(l.otherDeductions) ? <Money value={-num(l.otherDeductions)} className="text-muted-foreground" /> : <span className="text-muted-foreground">—</span>}</td>
                      <td className="px-3 py-2 text-right font-semibold">
                        <Money value={l.net} />
                      </td>
                      <td className="py-2 pl-3 pr-5 text-right">
                        <VarianceCell line={l} />
                      </td>
                    </tr>
                    {isOpen && (
                      <tr className="border-b border-border bg-muted/30">
                        <td />
                        <td colSpan={8} className="py-4 pr-5">
                          <div className="grid gap-4 lg:grid-cols-[minmax(0,1fr)_280px]">
                            <div className="grid gap-3">
                              <Formula line={l} run={run} />
                              {(l.bonusNote || l.otherNote || l.adjustmentNote || num(l.commission) > 0) && (
                                <ul className="grid gap-1 text-[12.5px] text-muted-foreground">
                                  {l.bonusNote && <li>Bonus: {l.bonusNote}</li>}
                                  {num(l.commission) > 0 && <li>Commission: approved by the Director from the first paid invoice of a won deal (Sales).</li>}
                                  {l.adjustmentNote && <li>Adjustment: {l.adjustmentNote}</li>}
                                  {l.otherNote && <li>Other: {l.otherNote}</li>}
                                </ul>
                              )}
                            </div>
                            <div className="grid content-start gap-3 rounded-lg border border-border bg-card p-3 text-[12.5px]">
                              <div>
                                <p className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">Paid to</p>
                                <p>
                                  {l.bankName} · <MaskedValue value={l.accountNumber} canReveal stepUp label="bank account number" />
                                </p>
                              </div>
                              <div className="flex flex-wrap gap-2">
                                {hasPayslips && (
                                  <Button
                                    size="sm"
                                    variant="outline"
                                    onClick={() => {
                                      setPayslipFor(l.empId);
                                      toast(`Viewing payslip of ${l.empId}`, { description: "This view is logged." });
                                    }}
                                  >
                                    <Receipt /> View payslip
                                  </Button>
                                )}
                                {locked && (
                                  <Button size="sm" variant="outline" onClick={() => setAdjustFor(l.empId)}>
                                    <FilePlus2 /> Add adjustment
                                  </Button>
                                )}
                              </div>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </React.Fragment>
                );
              })}
            </tbody>
            <tfoot>
              <tr className="bg-muted/50 font-semibold">
                <td />
                <td className="py-2.5 pr-3 text-[12.5px]">
                  Total · {shown.length} {shown.length === 1 ? "person" : "people"}
                </td>
                <td className="px-3 py-2.5 text-right">
                  <Money value={sumOf((l) => num(l.base) + num(l.allowances))} />
                </td>
                <td className="px-3 py-2.5 text-right">
                  <Money value={sumOf((l) => num(l.bonus) + num(l.commission) + num(l.adjustment))} />
                </td>
                <td className="px-3 py-2.5 text-right">
                  <Money value={-sumOf((l) => num(l.unpaidDeduction))} />
                </td>
                <td className="px-3 py-2.5 text-right">
                  <Money value={-sumOf((l) => num(l.tax))} />
                </td>
                <td className="px-3 py-2.5 text-right">
                  <Money value={-sumOf((l) => num(l.otherDeductions))} />
                </td>
                <td className="px-3 py-2.5 text-right">
                  <Money value={sumOf((l) => num(l.net))} />
                </td>
                <td />
              </tr>
            </tfoot>
          </table>
        </div>
      )}
      <PayslipViewer run={run} empId={payslipFor} onClose={() => setPayslipFor(null)} />
      {adjustFor && (
        <AdjustmentDialog run={run} empId={adjustFor} name={lookup.employee(adjustFor)?.name ?? adjustFor} open={!!adjustFor} onOpenChange={(o) => !o && setAdjustFor(null)} />
      )}
    </div>
  );
}
