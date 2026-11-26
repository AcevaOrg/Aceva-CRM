/**
 * Module 15.6 in live mode: targets, the manual daily log, proof requests, the nightly daily report, the dashboard and each
 * person's progress, straight from the server (plan section 20). These screens use the server's shapes as they are; the
 * demo-data screens keep their own (mock mode only).
 *
 * Rules the screens keep (approved): emails checked is "Not measured yet" (never 0) until Module 16; a day is met only when
 * every target that is set and measured is met, and a day with none set has no result; money is shown per currency (USD
 * and PKR apart), never converted.
 */
import type {
  Currency,
  SalesCurrencyTotals,
  SalesDailyLogView,
  SalesDailyMetric,
  SalesDailyReportView,
  SalesDashboardView,
  SalesLogField,
  SalesMetricResult,
  SalesPersonProgressView,
  SalesProofRequestView,
  SalesProofStatus,
  SalesTargetsRowView,
  SetSalesDailyTargetsRequest,
  SetSalesMonthlyTargetsRequest,
  SubmitSalesDailyLogRequest,
} from "@aceva/contracts";
import { http } from "@/lib/api/http";

export const performanceApi = {
  targets: (month?: string) => http.get<SalesTargetsRowView[]>("/sales/targets", month ? { month } : undefined),
  setDaily: (body: SetSalesDailyTargetsRequest) => http.put<SalesTargetsRowView>("/sales/targets/daily", body),
  setMonthly: (body: SetSalesMonthlyTargetsRequest) => http.put<SalesTargetsRowView>("/sales/targets/monthly", body),
  log: async (day: string, empId?: string) => (await http.get<{ log: SalesDailyLogView | null }>(`/sales/daily-logs/${day}`, empId ? { empId } : undefined)).log,
  saveLog: (day: string, body: SubmitSalesDailyLogRequest) => http.put<SalesDailyLogView>(`/sales/daily-logs/${day}`, body),
  proofs: (q: { status?: SalesProofStatus; empId?: string } = {}) => http.get<SalesProofRequestView[]>("/sales/proof-requests", q),
  requestProof: (empId: string, day: string, note: string) => http.post<SalesProofRequestView>("/sales/proof-requests", { empId, day, note }),
  answerProof: (id: string, answer: string) => http.post<SalesProofRequestView>(`/sales/proof-requests/${id}/answer`, { answer }),
  closeProof: (id: string, note: string) => http.post<SalesProofRequestView>(`/sales/proof-requests/${id}/close`, { note }),
  reportDates: () => http.get<string[]>("/sales/reports/daily/dates"),
  reports: (day: string) => http.get<SalesDailyReportView[]>("/sales/reports/daily", { day }),
  dashboard: (month?: string) => http.get<SalesDashboardView>("/sales/dashboard", month ? { month } : undefined),
  progress: (empId?: string) => http.get<SalesPersonProgressView>("/sales/progress", empId ? { empId } : undefined),
};

/* ---------------- display rules (pure, unit-tested) ---------------- */

export const METRIC_LABEL: Record<SalesDailyMetric, string> = {
  leadsAdded: "Leads added",
  emailsChecked: "Emails checked",
  emailsSent: "Emails sent",
  followUpsDone: "Follow-ups done",
};

export const LOG_FIELD_LABEL: Record<SalesLogField, string> = {
  linkedin: "LinkedIn messages",
  whatsapp: "WhatsApp chats",
  fiverr: "Fiverr inquiries",
  calls: "Phone calls",
  fieldVisits: "Field visits",
};

export const NOT_MEASURED = "Not measured yet";

/** "3 / 5", "3" (no target), or "Not measured yet" (never 0). */
export function metricText(r: SalesMetricResult): string {
  if (!r.measured || r.value === null) return NOT_MEASURED;
  return r.target === null ? String(r.value) : `${r.value} / ${r.target}`;
}

/** The day's result: met, not met, or no targets (a day with none set is neither). */
export function dayResult(met: boolean | null): { label: string; tone: "success" | "warning" | "neutral" } {
  if (met === null) return { label: "No targets set", tone: "neutral" };
  return met ? { label: "Targets met", tone: "success" } : { label: "Targets not met", tone: "warning" };
}

/** Money per currency, never added together: ["USD 1,000.00", "PKR 250,000.00"], or ["—"]. */
export function currencyLines(totals: SalesCurrencyTotals): string[] {
  if (!totals.length) return ["—"];
  return totals.map((t) => `${t.currency} ${money(t.total)}`);
}

export function money(amount: string, currency?: Currency): string {
  const n = Number(amount);
  const text = n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return currency ? `${currency} ${text}` : text;
}

export function selfReportedTotal(counts: Record<SalesLogField, number>): number {
  return counts.linkedin + counts.whatsapp + counts.fiverr + counts.calls + counts.fieldVisits;
}
