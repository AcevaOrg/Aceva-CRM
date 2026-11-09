"use client";
import { AcevaMark } from "@/components/layout/logo";
import { MaskedValue } from "@/components/shared/masked-value";
import { Money } from "@/components/shared/money";
import { useLookup } from "@/hooks/use-directory";
import { formatDate, formatMonthKey } from "@/lib/dates";
import { cn } from "@/lib/utils";
import type { Payslip } from "../types";

/** Payslip styled like the PDF (plan §12). Bank account stays masked. */
export function PayslipDocument({ slip, canRevealBank, className }: { slip: Payslip; canRevealBank?: boolean; className?: string }) {
  const lookup = useLookup();
  const e = lookup.employee(slip.empId);
  const dept = lookup.department(e?.departmentId);
  const earnings = slip.lines.filter((l) => l.kind === "earning");
  const deductions = slip.lines.filter((l) => l.kind === "deduction");

  return (
    <article className={cn("relative overflow-hidden rounded-xl border border-border bg-card shadow-strata", className)} aria-label={`Payslip ${formatMonthKey(slip.month)}`}>
      <div className="h-1.5 bg-gradient-to-r from-primary via-zone-finance to-signal" aria-hidden />
      <div className="grid gap-6 p-6 sm:p-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-center gap-3">
            <AcevaMark size={36} />
            <div>
              <p className="text-[15px] font-semibold tracking-tight">Aceva (Private) Limited</p>
              <p className="text-[12px] text-muted-foreground">House 12, Block B, Dadu, Sindh · acevatech.com</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Payslip</p>
            <p className="text-lg font-semibold tracking-tight">{formatMonthKey(slip.month)}</p>
            <p className="text-[12px] text-muted-foreground">Issued {formatDate(slip.issuedAt)}</p>
          </div>
        </header>

        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 rounded-lg bg-muted/60 p-4 text-[12.5px] sm:grid-cols-4">
          <div>
            <dt className="text-muted-foreground">Employee</dt>
            <dd className="font-medium">{e?.name ?? slip.empId}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Emp-ID</dt>
            <dd className="font-mono">{slip.empId}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Designation</dt>
            <dd>{e?.designation ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Department</dt>
            <dd>{dept?.name ?? "—"}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Working days</dt>
            <dd className="tabular">{slip.workingDays}</dd>
          </div>
          <div>
            <dt className="text-muted-foreground">Unpaid days</dt>
            <dd className="tabular">{slip.unpaidDays}</dd>
          </div>
          <div className="col-span-2">
            <dt className="text-muted-foreground">Paid to</dt>
            <dd>
              {slip.bankName} · <MaskedValue value={slip.accountNumber} canReveal={!!canRevealBank} stepUp label="bank account number" />
            </dd>
          </div>
        </dl>

        <div className="grid gap-6 sm:grid-cols-2">
          <SlipTable title="Earnings" rows={earnings} total={slip.gross} />
          <SlipTable title="Deductions" rows={deductions} total={slip.totalDeductions} negative />
        </div>

        <div className="flex flex-wrap items-end justify-between gap-4 rounded-xl border border-primary/20 bg-primary/6 px-5 py-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">Net pay</p>
            <Money value={slip.net} className="text-[28px] font-semibold tracking-tight" />
          </div>
          <dl className="grid grid-cols-2 gap-x-6 text-[12px]">
            <dt className="text-muted-foreground">Net this year</dt>
            <dd className="text-right">
              <Money value={slip.ytdNet} />
            </dd>
            <dt className="text-muted-foreground">Tax this year</dt>
            <dd className="text-right">
              <Money value={slip.ytdTax} />
            </dd>
          </dl>
        </div>

        <p className="text-[11px] text-muted-foreground">
          Year to date counts from 1 July (finance year). This payslip is confidential and visible only to you, finance and management. Questions: finance@acevatech.com
        </p>
      </div>
    </article>
  );
}

function SlipTable({ title, rows, total, negative }: { title: string; rows: Payslip["lines"]; total: Payslip["net"]; negative?: boolean }) {
  return (
    <section>
      <h3 className="mb-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">{title}</h3>
      <table className="w-full text-[13px]">
        <tbody>
          {rows.map((r) => (
            <tr key={r.label} className="border-b border-dashed border-border">
              <td className="py-1.5 pr-3">{r.label}</td>
              <td className="py-1.5 text-right">
                <Money value={r.amount} className={negative ? "text-muted-foreground" : undefined} />
              </td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr>
            <td className="pt-2 font-semibold">Total {title.toLowerCase()}</td>
            <td className="pt-2 text-right font-semibold">
              <Money value={total} />
            </td>
          </tr>
        </tfoot>
      </table>
    </section>
  );
}
