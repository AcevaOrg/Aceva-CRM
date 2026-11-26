/**
 * Module 15.7 in live mode: commission lines and the company commission rule, straight from the server (approved M15.7
 * scope). The server decides who sees which lines (own, team, all) and what each viewer may do on a line (`can`); the
 * screen only shows that. Commission is always PKR (each payment converted at its own recorded rate); the collected value
 * is shown in the invoice's own currency, never converted.
 */
import {
  SALES_COMMISSION_STATUS_LABEL,
  type ApproveSalesCommissionRequest,
  type DecideSalesCommissionRequest,
  type SalesCommissionLeaverDecisionRequest,
  type SalesCommissionLineView,
  type SalesCommissionListView,
  type SalesCommissionRulesView,
  type SalesCommissionStatus,
  type SetSalesCommissionRuleRequest,
} from "@aceva/contracts";
import { http } from "@/lib/api/http";
import { money } from "./performance-live";

/** The commission routes are finance screens on the server (10 minutes idle; "not found" without access). */
export const liveCommissionApi = {
  list: (status?: SalesCommissionStatus) => http.get<SalesCommissionListView>("/sales/commission", status ? { status } : undefined),
  rules: () => http.get<SalesCommissionRulesView>("/sales/commission/rules"),
  setRule: (body: SetSalesCommissionRuleRequest) => http.put<SalesCommissionRulesView>("/sales/commission/rules", body),
  approve: (id: string, body: ApproveSalesCommissionRequest) => http.post<SalesCommissionLineView>(`/sales/commission/${id}/approve`, body),
  reject: (id: string, body: DecideSalesCommissionRequest) => http.post<SalesCommissionLineView>(`/sales/commission/${id}/reject`, body),
  hold: (id: string, body: DecideSalesCommissionRequest) => http.post<SalesCommissionLineView>(`/sales/commission/${id}/hold`, body),
  leaverDecision: (id: string, body: SalesCommissionLeaverDecisionRequest) => http.post<SalesCommissionLineView>(`/sales/commission/${id}/leaver-decision`, body),
};

/* ---------------- display rules (pure, unit-tested) ---------------- */

export type Tone = "neutral" | "info" | "warning" | "success" | "danger";

export const COMMISSION_STATUS_TONE: Record<SalesCommissionStatus, Tone> = {
  waiting_rate: "neutral",
  calculated: "warning",
  approved: "info",
  rejected: "danger",
  held: "warning",
  included: "success",
};

/** The status as people read it; a hold says why. */
export function commissionStatusText(l: Pick<SalesCommissionLineView, "status" | "hold">): string {
  if (l.status === "held" && l.hold) return l.hold.reason === "earner_left" ? "On hold: the earner left" : "On hold";
  return SALES_COMMISSION_STATUS_LABEL[l.status];
}

/** The commission in PKR; a line waiting for a rate has no amount yet (never shown as zero). */
export function commissionAmountText(l: Pick<SalesCommissionLineView, "amount">): string {
  return l.amount === null ? "Waiting for a rate" : `PKR ${money(l.amount)}`;
}

/** What was collected, in the invoice's own currency; for a USD invoice also its PKR value at the payments' rates. */
export function collectedText(l: Pick<SalesCommissionLineView, "invoiceCurrency" | "collectedBase" | "basePkr">): string {
  const own = `${l.invoiceCurrency} ${money(l.collectedBase)}`;
  return l.invoiceCurrency === "PKR" ? own : `${own} (PKR ${money(l.basePkr)} at the payments' rates)`;
}

/** Why a viewer cannot act on a line, when it waits for someone (null: nothing to explain). */
export function waitingFor(l: Pick<SalesCommissionLineView, "status" | "hold" | "can">, isEarner: boolean): string | null {
  if (l.can.approve || l.can.reject || l.can.hold || l.can.decideLeaver) return null;
  if (isEarner && (l.status === "calculated" || l.status === "held")) return "Nobody decides their own commission";
  if (l.status === "held" && l.hold?.reason === "earner_left") return "With the Owner (final settlement)";
  if (l.status === "calculated") return "With the approver";
  return null;
}
