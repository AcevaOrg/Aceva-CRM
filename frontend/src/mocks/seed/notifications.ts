import type { Notification, NotificationType } from "@/features/system/types";
import { ESSENTIAL_TYPES } from "@/features/system/types";
import { minutesAgo } from "../time";

type Seed = [empIds: string[], type: NotificationType, title: string, body: string, link: string, minAgo: number, read?: boolean];

const SEEDS: Seed[] = [
  [["ACV-0007"], "task_assigned", "New task: Build leave balance widget", "Fahad Khan assigned you an M task, due in 3 working days.", "/tasks", 18],
  [["ACV-0007", "ACV-0008"], "task_due_soon", "Due in 24 hours: API contract for payroll lines", "Submit before the deadline to stay on time.", "/tasks", 95],
  [["ACV-0007", "ACV-0008", "ACV-0011", "ACV-0013", "ACV-0009", "ACV-0012", "ACV-0010"], "payslip_available", "Your October payslip is ready", "Net pay has been sent to your bank account.", "/payroll/payslips", 60 * 30, true],
  [["ACV-0007", "ACV-0008", "ACV-0011", "ACV-0009"], "scorecard_released", "October scorecard released", "Open it to acknowledge and add a comment.", "/performance", 60 * 50],
  [["ACV-0007", "ACV-0008", "ACV-0011", "ACV-0013", "ACV-0009", "ACV-0012", "ACV-0010", "ACV-0005", "ACV-0006", "ACV-0014"], "announcement", "Go-live on 30 November: please acknowledge", "Read the tracking policy and the go-live plan.", "/announcements", 60 * 5],
  [["ACV-0007"], "message_mention", "Fahad mentioned you in #engineering", "“@Mariam can you pair with Nida on the check-in card?”", "/messages", 42],
  [["ACV-0006"], "leave_requested", "Leave request from Ali Raza", "Casual leave, 2 days. Waiting for your approval.", "/approvals", 25],
  [["ACV-0006"], "approval_waiting", "3 tasks are waiting for your review", "Submitted by Mariam Shah, Danish Iqbal and Ali Raza.", "/approvals", 70],
  [["ACV-0006"], "extension_requested", "Extension asked: Payslip PDF layout", "Danish Iqbal asked for 2 more days.", "/approvals", 130],
  [["ACV-0002"], "payroll_ready", "November payroll is waiting for your approval", "Prepared by Sana Malik, reviewed by Bilal Ahmed.", "/payroll", 35],
  [["ACV-0002", "ACV-0001"], "approval_waiting", "Journal entry JE-2026-0311 needs CEO approval", "PKR 120,000 · Annual hosting prepayment.", "/approvals", 80],
  [["ACV-0004", "ACV-0002", "ACV-0001", "ACV-0003"], "security_alert", "Login from a new city", "Ali Raza signed in from Lahore on a new device.", "/activity?tab=alerts", 55],
  [["ACV-0004"], "sales_tool_problem", "Apollo sync failing for 1 hour", "The API key may have expired. Check Integrations.", "/integrations", 65],
  [["ACV-0003"], "approval_waiting", "Commission line ready for approval", "Hira Baig · first invoice paid by Northwind Studio.", "/approvals", 140],
  [["ACV-0003", "ACV-0010"], "renewal_due", "Apollo renews in 6 days", "Professional plan · USD 99 / month per seat.", "/billing/subscriptions", 60 * 3],
  [["ACV-0010", "ACV-0003"], "invoice_overdue", "INV-2026-0042 is 9 days overdue", "Bright Path Academy · PKR 185,000 outstanding.", "/billing", 60 * 7],
  [["ACV-0009"], "sales_reply", "New reply from Olivia Grant (Harbor & Co)", "“Thanks Hira, can we talk on Thursday?”", "/sales/leads", 12],
  [["ACV-0009", "ACV-0012"], "sales_follow_up", "4 follow-ups are due today", "Open My sales day to see them.", "/sales", 60 * 2],
  [["ACV-0014"], "approval_waiting", "Won deal waiting for your confirmation", "Kamran Javed marked DL-0019 as Won.", "/approvals", 48],
  [["ACV-0005"], "leave_requested", "Leave request from Nida Aslam", "Sick leave, 1 day.", "/approvals", 200],
];

export function seedNotifications(): Notification[] {
  const out: Notification[] = [];
  let n = 0;
  for (const [empIds, type, title, body, link, minAgo, read] of SEEDS) {
    for (const empId of empIds) {
      out.push({ id: `ntf_${++n}`, empId, type, title, body, link, at: minutesAgo(minAgo), read: !!read, essential: ESSENTIAL_TYPES.includes(type) });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
