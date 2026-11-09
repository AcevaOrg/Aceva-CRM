/**
 * Approvals provider for Module 15:
 *  - won deals marked by a salesperson wait for their sales manager (the person they report to);
 *  - commission lines wait for the Director (plan §20). Never the requester.
 */
import type { ApprovalItem, ApprovalProvider } from "@/features/approvals/types";
import { employeeName, findEmployee } from "@/lib/directory";
import { commissionLines, companiesTable, dealsTable, handoverDeal } from "./api";
import { SERVICE_LABEL } from "./logic";

export const salesApprovals: ApprovalProvider = {
  key: "sales",
  list: (viewer) => {
    const me = viewer.employee.empId;
    const items: ApprovalItem[] = [];
    if (viewer.can("sales.team")) {
      dealsTable()
        .filter((d) => d.stage === "won" && d.wonStatus === "pending" && d.ownerEmpId !== me && findEmployee(d.ownerEmpId)?.reportsTo === me)
        .forEach((d) => {
          const company = companiesTable().find((c) => c.id === d.companyId)?.name ?? "—";
          items.push({
            id: `won_deal:${d.id}`,
            type: "won_deal",
            refId: d.id,
            refNumber: d.number,
            title: `${company} marked as Won`,
            subtitle: `${SERVICE_LABEL[d.service]} · ${employeeName(d.ownerEmpId)} asks you to confirm. A draft invoice is created on confirmation.`,
            requester: d.ownerEmpId,
            amount: d.value,
            createdAt: d.wonRequestedAt ?? d.updatedAt,
            href: `/sales/deals/${d.id}`,
            approveLabel: "Confirm won",
            rejectLabel: "Not yet",
          });
        });
    }
    if (viewer.can("sales.commission_approve") && viewer.employee.level === 3) {
      commissionLines()
        .filter((c) => c.status === "calculated" && c.empId !== me)
        .forEach((c) =>
          items.push({
            id: `commission:${c.id}`,
            type: "commission",
            refId: c.id,
            refNumber: c.dealNumber,
            title: `Commission for ${employeeName(c.empId)}`,
            subtitle: `${c.ratePercent}% of the first payment on ${c.invoiceNumber}. Goes to payroll as a bonus line.`,
            requester: c.empId,
            amount: c.amount,
            createdAt: c.invoicePaidAt,
            href: "/sales/targets?tab=commission",
            approveLabel: "Approve and send to payroll",
          }),
        );
    }
    return items;
  },
  decide: (item, decision, viewer, opts) => {
    const me = viewer.employee.empId;
    const now = new Date().toISOString();
    if (item.type === "won_deal") {
      const d = dealsTable().find((x) => x.id === item.refId);
      if (!d) return;
      if (decision === "approve") handoverDeal(d, me);
      else {
        d.stage = d.previousStage ?? "negotiation";
        d.wonStatus = undefined;
        d.history.push({ stage: d.stage, at: now, by: me, note: `Won not confirmed: ${opts.reason ?? ""}` });
      }
    }
    if (item.type === "commission") {
      const c = commissionLines().find((x) => x.id === item.refId);
      if (!c) return;
      c.status = decision === "approve" ? "sent_to_payroll" : "rejected";
      c.approvedBy = me;
      c.approvedAt = now;
      if (decision === "approve") c.payrollMonth = now.slice(0, 7);
      else c.rejectReason = opts.reason;
    }
  },
};
