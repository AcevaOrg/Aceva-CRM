/**
 * Approvals provider for Module 9 (plan section 13, maker-checker):
 *   Journal entries: approved at the level their PKR amount needs (approval limits in Settings; capital and loan entries need
 *     the Owner); one level up when the approver made it; never by the maker.
 *   Month close: run by the finance person, approved by the CEO (never the person who ran it).
 * Mock mode decides from the in-browser store. Live mode (m9) shows what the SERVER says this viewer may decide
 * (GET /journal-entries?awaitingMe=true and GET /periods) and sends the decision to the server.
 */
import { toast } from "sonner";
import type { EntryView, Page, PeriodView } from "@aceva/contracts";
import type { ApprovalItem, ApprovalProvider } from "@/features/approvals/types";
import { http, isLive } from "@/lib/api/http";
import { formatMonthKey } from "@/lib/dates";
import { canApproveClose, CEO_NOTIFIED_LABEL, SOURCE_LABEL } from "./logic";
import { approveClose, approveEntry, entriesTable, periodsTable, rejectClose, rejectEntry } from "./store";

/* ---------- live mode: a small cache, refreshed in the background (the provider interface is synchronous) ---------- */

let cache: { viewer: string; entries: EntryView[]; periods: PeriodView[]; at: number } | null = null;
let inflight: Promise<void> | null = null;

function refresh(viewer: string) {
  if (inflight) return;
  inflight = Promise.all([http.get<Page<EntryView>>("/journal-entries", { awaitingMe: "true", pageSize: 100 }), http.get<PeriodView[]>("/periods")])
    .then(([entries, periods]) => {
      cache = { viewer, entries: entries.items, periods, at: Date.now() };
    })
    .catch(() => undefined)
    .finally(() => {
      inflight = null;
    });
}

function liveList(viewer: Parameters<ApprovalProvider["list"]>[0]): ApprovalItem[] {
  const me = viewer.employee.empId;
  if (!viewer.can("finance.view")) return [];
  if (!cache || cache.viewer !== me || Date.now() - cache.at > 15_000) refresh(me);
  if (!cache || cache.viewer !== me) return [];
  const entries: ApprovalItem[] = cache.entries
    .filter((e) => e.canApprove)
    .map((e) => ({
      id: `journal_entry:${e.id}`,
      type: "journal_entry" as const,
      refId: e.id,
      refNumber: e.number,
      title: e.description,
      subtitle: `${SOURCE_LABEL[e.source] ?? e.source} · Needs ${e.requiredApproverLabel ?? "approval"}${e.currency === "USD" ? ` · USD at ${Number(e.exchangeRate).toFixed(2)}` : ""}`,
      requester: e.makerEmpId,
      amount: { amount: e.totalBase, currency: "PKR" },
      createdAt: e.submittedAt ?? e.createdAt,
      href: `/finance/ledger/${e.id}`,
      needsStepUp: e.needsStepUp,
      approveLabel: "Approve and post",
    }));
  const closes: ApprovalItem[] = cache.periods
    .filter((p) => p.status === "closing" && p.canApproveClose)
    .map((p) => ({
      id: `month_close:${p.month}`,
      type: "month_close" as const,
      refId: p.month,
      refNumber: p.month,
      title: `Close ${formatMonthKey(p.month)}`,
      subtitle: "Run by Finance. Checklist complete. Approving locks the month.",
      requester: p.closeRequestedByEmpId ?? "",
      createdAt: p.closeRequestedAt ?? new Date().toISOString(),
      href: "/finance/close",
      approveLabel: "Approve close",
    }));
  return [...entries, ...closes];
}

async function liveDecide(item: ApprovalItem, decision: "approve" | "reject", reason?: string) {
  try {
    if (item.type === "journal_entry") {
      if (decision === "approve") await http.post(`/journal-entries/${item.refId}/approve`, {});
      else await http.post(`/journal-entries/${item.refId}/reject`, { reason: reason ?? "Sent back" });
    } else if (item.type === "month_close") {
      if (decision === "approve") await http.post(`/periods/${item.refId}/approve-close`);
      else await http.post(`/periods/${item.refId}/reject-close`, { reason: reason ?? "Sent back" });
    }
  } catch (err) {
    toast.error(err instanceof Error ? err.message : "The decision was not saved.");
  } finally {
    cache = null;
  }
}

export const ledgerApprovals: ApprovalProvider = {
  key: "ledger",
  list: (viewer) => {
    if (isLive("m9")) return liveList(viewer);
    const me = viewer.employee.empId;
    const entries: ApprovalItem[] = viewer.can("finance.entry_approve")
      ? entriesTable()
          .filter((e) => e.status === "pending_approval" && !e.blocked && e.approverEmpId === me && e.createdBy !== me)
          .map((e) => ({
            id: `journal_entry:${e.id}`,
            type: "journal_entry" as const,
            refId: e.id,
            refNumber: e.number,
            title: e.description,
            subtitle: `${SOURCE_LABEL[e.source]} · Prepared by Finance${e.ceoNotified ? ` · ${CEO_NOTIFIED_LABEL}` : ""}${e.currency === "USD" ? ` · USD at ${Number(e.exchangeRate).toFixed(2)}` : ""}`,
            requester: e.createdBy,
            amount: e.baseTotal,
            createdAt: e.createdAt,
            href: `/finance/ledger/${e.id}`,
            needsStepUp: !!e.ceoNotified,
            approveLabel: "Approve and post",
          }))
      : [];
    // The CEO approves a month close the finance person ran, never one they ran themselves.
    const closes: ApprovalItem[] = (canApproveClose(viewer.can) ? periodsTable() : [])
      .filter((p) => p.status === "closing" && p.closedBy && p.closedBy !== me)
      .map((p) => ({
        id: `month_close:${p.month}`,
        type: "month_close" as const,
        refId: p.month,
        refNumber: p.month,
        title: `Close ${formatMonthKey(p.month)}`,
        subtitle: "Run by Finance. Checklist complete. Approving locks the month and saves the statements as a snapshot.",
        requester: p.closedBy!,
        createdAt: p.closedAt ?? new Date().toISOString(),
        href: "/finance/close",
        needsStepUp: true,
        approveLabel: "Approve close",
      }));
    return [...entries, ...closes];
  },
  decide: (item, decision, viewer, opts) => {
    if (isLive("m9")) {
      void liveDecide(item, decision, opts.reason);
      return;
    }
    const me = viewer.employee.empId;
    if (item.type === "journal_entry") {
      if (decision === "approve") approveEntry(item.refId, me);
      else rejectEntry(item.refId, me, opts.reason ?? "Sent back");
    }
    if (item.type === "month_close") {
      if (decision === "approve") approveClose(item.refId, me);
      else rejectClose(item.refId, me, opts.reason ?? "Sent back");
    }
  },
  routedUp: (viewer) => (isLive("m9") ? 0 : entriesTable().filter((e) => e.status === "pending_approval" && e.createdBy === viewer.employee.empId).length),
};
