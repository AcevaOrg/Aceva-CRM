"use client";
import { AcevaMark } from "@/components/layout/logo";
import { formatDate } from "@/lib/dates";
import { formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { INVOICE_STATUS, INVOICE_TYPE, lineAmount, PERIOD_LABEL } from "../logic";
import type { Customer, Invoice, InvoiceLine } from "../types";

/** Aceva's details printed on every invoice (Settings → Company details). */
export const ACEVA_DETAILS = {
  name: "Aceva Tech (Private) Limited",
  address: ["Station Road, Dadu HQ", "Sindh 76200, Pakistan"],
  email: "accounts@acevatech.com",
  web: "acevatech.com",
  ntn: "NTN 7712490-6",
  bank: "Meezan Bank · Account •••• 2214 · IBAN PK•• MEZN •••• 2214",
};

export type PreviewInvoice = Pick<Invoice, "number" | "type" | "period" | "issueDate" | "dueDate" | "currency" | "notes" | "status"> & {
  lines: Pick<InvoiceLine, "description" | "qty" | "rate" | "taxRate">[];
  subtotal: number;
  tax: number;
  total: number;
  paid?: number;
};

/**
 * Invoice laid out like the PDF the customer receives (plan §13: "Client invoices with Aceva's details, as PDF").
 */
export function InvoicePreview({ invoice, customer, className, watermark }: { invoice: PreviewInvoice; customer?: Pick<Customer, "name" | "contactName" | "email" | "address" | "country" | "taxId">; className?: string; watermark?: string }) {
  const cur = invoice.currency;
  const fmt = (n: number) => formatMoney(n, { currency: cur, exact: true });
  const balance = invoice.total - (invoice.paid ?? 0);
  const stamp = invoice.status === "paid" ? "Paid" : invoice.status === "draft" ? "Draft" : invoice.status === "cancelled" ? "Cancelled" : null;
  return (
    <article
      aria-label={`Invoice ${invoice.number}`}
      className={cn("relative overflow-hidden rounded-xl border border-border bg-white text-[oklch(0.22_0.02_265)] shadow-strata", className)}
    >
      <div className="h-1.5 w-full bg-[linear-gradient(90deg,var(--primary),var(--zone-finance),var(--signal))]" />
      <div className="grid gap-6 p-6 sm:p-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div className="flex items-start gap-3">
            <AcevaMark size={36} />
            <div className="text-[11.5px] leading-relaxed text-[oklch(0.45_0.02_265)]">
              <p className="text-[14px] font-semibold text-[oklch(0.22_0.02_265)]">{ACEVA_DETAILS.name}</p>
              {ACEVA_DETAILS.address.map((l) => (
                <p key={l}>{l}</p>
              ))}
              <p>
                {ACEVA_DETAILS.email} · {ACEVA_DETAILS.web}
              </p>
              <p>{ACEVA_DETAILS.ntn}</p>
            </div>
          </div>
          <div className="text-right">
            <p className="text-[22px] font-semibold tracking-tight">Invoice</p>
            <p className="font-mono text-[13px] tabular">{invoice.number}</p>
            <p className="mt-1 text-[11.5px] text-[oklch(0.45_0.02_265)]">
              {INVOICE_TYPE[invoice.type]}
              {invoice.period && invoice.type !== "one_time" ? ` · ${PERIOD_LABEL[invoice.period]}` : ""}
            </p>
            {stamp && (
              <span
                className={cn(
                  "mt-2 inline-block rotate-[-6deg] rounded-md border-2 px-2.5 py-0.5 text-[13px] font-bold uppercase tracking-[0.2em] opacity-75",
                  stamp === "Paid" ? "border-[oklch(0.6_0.15_155)] text-[oklch(0.55_0.15_155)]" : "border-[oklch(0.6_0.02_265)] text-[oklch(0.55_0.02_265)]",
                )}
              >
                {stamp}
              </span>
            )}
          </div>
        </header>

        <section className="grid gap-4 text-[12.5px] sm:grid-cols-[1.4fr_1fr]">
          <div>
            <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[oklch(0.5_0.02_265)]">Bill to</p>
            {customer ? (
              <div className="leading-relaxed">
                <p className="font-semibold">{customer.name}</p>
                {customer.contactName && <p>Attn: {customer.contactName}</p>}
                {customer.address && <p className="text-[oklch(0.45_0.02_265)]">{customer.address}</p>}
                {customer.country && <p className="text-[oklch(0.45_0.02_265)]">{customer.country}</p>}
                {customer.email && <p className="text-[oklch(0.45_0.02_265)]">{customer.email}</p>}
                {customer.taxId && <p className="text-[oklch(0.45_0.02_265)]">{customer.taxId}</p>}
              </div>
            ) : (
              <p className="italic text-[oklch(0.55_0.02_265)]">Choose a customer</p>
            )}
          </div>
          <dl className="grid grid-cols-2 gap-x-3 gap-y-1 self-start rounded-lg bg-[oklch(0.97_0.005_265)] p-3">
            <dt className="text-[oklch(0.5_0.02_265)]">Issue date</dt>
            <dd className="text-right tabular">{invoice.issueDate ? formatDate(invoice.issueDate) : "—"}</dd>
            <dt className="text-[oklch(0.5_0.02_265)]">Due date</dt>
            <dd className="text-right font-semibold tabular">{invoice.dueDate ? formatDate(invoice.dueDate) : "—"}</dd>
            <dt className="text-[oklch(0.5_0.02_265)]">Currency</dt>
            <dd className="text-right">{cur}</dd>
            <dt className="text-[oklch(0.5_0.02_265)]">Status</dt>
            <dd className="text-right">{INVOICE_STATUS[invoice.status].label}</dd>
          </dl>
        </section>

        <table className="w-full border-collapse text-[12.5px]">
          <thead>
            <tr className="border-b border-[oklch(0.9_0.01_265)] text-left text-[10.5px] uppercase tracking-[0.1em] text-[oklch(0.5_0.02_265)]">
              <th className="py-2 pr-2 font-semibold">Description</th>
              <th className="w-14 py-2 text-right font-semibold">Qty</th>
              <th className="w-28 py-2 text-right font-semibold">Rate</th>
              <th className="hidden w-16 py-2 text-right font-semibold sm:table-cell">Tax</th>
              <th className="w-32 py-2 text-right font-semibold">Amount</th>
            </tr>
          </thead>
          <tbody>
            {invoice.lines.length ? (
              invoice.lines.map((l, i) => (
                <tr key={i} className="border-b border-[oklch(0.94_0.006_265)] align-top">
                  <td className="py-2 pr-2">{l.description || <span className="italic text-[oklch(0.6_0.02_265)]">Line description</span>}</td>
                  <td className="py-2 text-right font-mono tabular">{l.qty || 0}</td>
                  <td className="py-2 text-right font-mono tabular">{Number(l.rate || 0).toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  <td className="hidden py-2 text-right font-mono tabular sm:table-cell">{l.taxRate ? `${l.taxRate}%` : "—"}</td>
                  <td className="py-2 text-right font-mono tabular">{lineAmount(l).toLocaleString("en-PK", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                </tr>
              ))
            ) : (
              <tr>
                <td colSpan={5} className="py-6 text-center italic text-[oklch(0.6_0.02_265)]">
                  No lines yet
                </td>
              </tr>
            )}
          </tbody>
        </table>

        <div className="flex flex-wrap items-end justify-between gap-6">
          <div className="max-w-xs text-[11.5px] leading-relaxed text-[oklch(0.45_0.02_265)]">
            <p className="mb-1 text-[10.5px] font-semibold uppercase tracking-[0.12em] text-[oklch(0.5_0.02_265)]">Pay to</p>
            <p>{ACEVA_DETAILS.bank}</p>
            <p className="mt-1">Please quote {invoice.number} as the payment reference.</p>
            {invoice.notes && <p className="mt-2 italic">{invoice.notes}</p>}
          </div>
          <dl className="grid min-w-56 grid-cols-2 gap-x-4 gap-y-1 text-[12.5px]">
            <dt className="text-[oklch(0.5_0.02_265)]">Subtotal</dt>
            <dd className="text-right font-mono tabular">{fmt(invoice.subtotal)}</dd>
            <dt className="text-[oklch(0.5_0.02_265)]">Tax</dt>
            <dd className="text-right font-mono tabular">{fmt(invoice.tax)}</dd>
            <dt className="border-t border-[oklch(0.9_0.01_265)] pt-1.5 font-semibold">Total</dt>
            <dd className="border-t border-[oklch(0.9_0.01_265)] pt-1.5 text-right font-mono text-[14px] font-semibold tabular">{fmt(invoice.total)}</dd>
            {invoice.paid !== undefined && invoice.paid > 0 && (
              <>
                <dt className="text-[oklch(0.5_0.02_265)]">Paid</dt>
                <dd className="text-right font-mono tabular">−{fmt(invoice.paid)}</dd>
                <dt className="font-semibold">Balance due</dt>
                <dd className="text-right font-mono font-semibold tabular">{fmt(balance)}</dd>
              </>
            )}
          </dl>
        </div>
        {watermark && <p className="border-t border-dashed border-[oklch(0.9_0.01_265)] pt-3 text-center font-mono text-[10.5px] text-[oklch(0.55_0.02_265)]">{watermark}</p>}
      </div>
    </article>
  );
}
