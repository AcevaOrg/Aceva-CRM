"use client";
import Link from "next/link";
import { cn } from "@/lib/utils";
import { formatDate } from "@/lib/dates";
import { formatStatementAmount } from "@/features/ledger/components/ledger-bits";
import type { ReportTable, Statement, StatementLine } from "../types";

function pct(cur: string, prev?: string) {
  const a = Number(cur);
  const b = Number(prev ?? 0);
  if (!prev || Math.abs(b) < 0.005) return "—";
  const p = ((a - b) / Math.abs(b)) * 100;
  return `${p >= 0 ? "+" : "−"}${Math.abs(p).toFixed(1)}%`;
}

/** Printable statement layout: indented lines, subtotals, totals, optional compare column. */
export function StatementPaper({ statement, onAccount }: { statement: Statement; onAccount: (accountId: string) => void }) {
  const s = statement;
  const asAt = s.type === "balance-sheet" || s.type === "trial-balance" || s.type === "ar-aging" || s.type === "ap-due";
  const period = asAt ? `As at ${formatDate(`${s.to}T12:00:00`)}` : `From ${formatDate(`${s.from}T12:00:00`)} to ${formatDate(`${s.to}T12:00:00`)}`;
  const compare = !!s.compare && s.sections.length > 0;

  return (
    <article className="relative mx-auto w-full max-w-4xl rounded-xl border border-border bg-card px-5 py-7 shadow-strata sm:px-10 print:border-0 print:shadow-none">
      <header className="mb-6 border-b border-border pb-5 text-center">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">Aceva (Private) Limited</p>
        <h2 className="mt-1 text-xl font-semibold tracking-tight">{s.title}</h2>
        <p className="mt-1 text-[13px] text-muted-foreground">{period}</p>
        <p className="text-[12px] text-muted-foreground">
          Amounts in {s.currency}
          {s.currency === "USD" ? ` (converted at ${s.rate} PKR per USD)` : ""}
        </p>
      </header>

      {s.sections.length > 0 && (
        <div className="grid gap-6">
          {compare && (
            <div className={cn("grid items-end gap-3 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground", "grid-cols-[minmax(0,1fr)_120px_120px_70px]")}>
              <span />
              <span className="text-right">This period</span>
              <span className="text-right">
                {asAt ? `At ${formatDate(`${s.compare!.to}T12:00:00`)}` : "Previous period"}
              </span>
              <span className="text-right">Change</span>
            </div>
          )}
          {s.sections.map((sec) => (
            <section key={sec.title}>
              <h3 className="mb-2 border-b border-foreground/15 pb-1 text-[12px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{sec.title}</h3>
              <ul>
                {sec.lines.map((l) => (
                  <Line key={l.key} line={l} compare={compare} onAccount={onAccount} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}

      {s.table && <TableReport table={s.table} onAccount={onAccount} />}

      <footer className="mt-8 border-t border-dashed border-border pt-3 text-[11px] text-muted-foreground">
        Prepared from posted ledger entries · generated {formatDate(s.generatedAt)} · {s.status === "snapshot" ? "Closed-month snapshot" : s.status === "final" ? "Marked final" : "Draft"}
      </footer>
    </article>
  );
}

function Line({ line: l, compare, onAccount }: { line: StatementLine; compare: boolean; onAccount: (id: string) => void }) {
  const isHeader = l.amount === "";
  const strong = l.isTotal || l.isSubtotal;
  const amount = isHeader ? null : l.accountId ? (
    <button type="button" onClick={() => onAccount(l.accountId!)} className="rounded font-mono tabular underline-offset-2 hover:text-primary hover:underline" title="Open the general ledger for this account">
      {formatStatementAmount(l.amount)}
    </button>
  ) : (
    <span className="font-mono tabular">{formatStatementAmount(l.amount)}</span>
  );
  return (
    <li
      className={cn(
        "grid items-baseline gap-3 py-1.5 text-[13.5px]",
        compare ? "grid-cols-[minmax(0,1fr)_120px_120px_70px]" : "grid-cols-[minmax(0,1fr)_160px]",
        l.isSubtotal && "border-t border-border font-semibold",
        l.isTotal && "mt-1 border-y-2 border-foreground/70 py-2 font-semibold",
        isHeader && "pt-3 font-semibold",
      )}
    >
      <span className="min-w-0" style={{ paddingLeft: l.depth * 18 }}>
        {l.code && <span className="mr-2 font-mono text-[11.5px] text-muted-foreground">{l.code}</span>}
        {l.label}
        {l.note && <span className="ml-2 text-[11.5px] font-normal text-muted-foreground">{l.note}</span>}
      </span>
      <span className={cn("text-right", strong && "font-semibold")}>{amount}</span>
      {compare && !isHeader && (
        <>
          <span className="text-right font-mono text-muted-foreground tabular">{formatStatementAmount(l.compareAmount ?? "0")}</span>
          <span className="text-right text-[12px] text-muted-foreground tabular">{pct(l.amount, l.compareAmount)}</span>
        </>
      )}
    </li>
  );
}

function TableReport({ table, onAccount }: { table: ReportTable; onAccount: (id: string) => void }) {
  return (
    <div className="overflow-x-auto scrollbar-thin">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr className="border-b-2 border-foreground/15">
            {table.columns.map((c) => (
              <th key={c.key} scope="col" className={cn("whitespace-nowrap px-2 py-2 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground first:pl-0 last:pr-0", c.align === "right" ? "text-right" : "text-left")}>
                {c.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((r) => (
            <tr
              key={r.id}
              className={cn(
                "border-b border-border",
                r.isTotal && "border-y-2 border-foreground/70 font-semibold",
                r.tone === "danger" && "bg-danger/6",
                r.tone === "warning" && "bg-warning/8",
                r.tone === "muted" && "text-muted-foreground",
              )}
            >
              {table.columns.map((c, i) => {
                const v = r.cells[c.key];
                const text =
                  v === null || v === undefined || v === ""
                    ? ""
                    : c.kind === "money"
                      ? formatStatementAmount(v)
                      : c.kind === "date"
                        ? formatDate(`${v}T12:00:00`)
                        : c.kind === "percent"
                          ? `${v}%`
                          : String(v);
                const content =
                  c.key === "account" && r.accountId && !r.isTotal ? (
                    <button type="button" onClick={() => onAccount(r.accountId!)} className="text-left hover:text-primary hover:underline">
                      {text}
                    </button>
                  ) : i === 0 && r.href ? (
                    <Link href={r.href} className="text-primary hover:underline">
                      {text}
                    </Link>
                  ) : (
                    text
                  );
                return (
                  <td key={c.key} className={cn("px-2 py-2 first:pl-0 last:pr-0", c.align === "right" && "text-right", (c.kind === "money" || c.kind === "mono" || c.kind === "number") && "font-mono tabular")}>
                    {content}
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
