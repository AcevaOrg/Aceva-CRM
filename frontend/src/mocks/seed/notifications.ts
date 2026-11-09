import type { Notification, NotificationType } from "@/features/system/types";
import { ESSENTIAL_TYPES } from "@/features/system/types";
import { minutesAgo } from "../time";

/*
 * Structure: ACV-0001 CEO / Founder / Owner (sees everything, approves nothing) · ACV-0003 Director (the approver;
 * HR and sales manager) · ACV-0004 CTO · ACV-0010 Finance · ACV-0009/0012/0014 Sales · ACV-0006/0007/0008/0011/0013 Development.
 */
const DEVELOPERS = ["ACV-0006", "ACV-0007", "ACV-0008", "ACV-0011", "ACV-0013"];
const SALES = ["ACV-0009", "ACV-0012", "ACV-0014"];
const EVERYONE_BELOW_CEO = ["ACV-0003", "ACV-0004", "ACV-0010", ...SALES, ...DEVELOPERS];

type Seed = [empIds: string[], type: NotificationType, title: string, body: string, link: string, minAgo: number, read?: boolean];

const SEEDS: Seed[] = [
  [["ACV-0007"], "task_assigned", "New task: Build leave balance widget", "Omar Farooq (CTO) assigned you an M task, due in 3 working days.", "/tasks", 18],
  [["ACV-0007", "ACV-0008"], "task_due_soon", "Due in 24 hours: API contract for payroll lines", "Submit before the deadline to stay on time.", "/tasks", 95],
  [["ACV-0007", "ACV-0008", "ACV-0011", "ACV-0013", ...SALES, "ACV-0004", "ACV-0010"], "payslip_available", "Your October payslip is ready", "Net pay has been sent to your bank account.", "/payroll/payslips", 60 * 30, true],
  [["ACV-0007", "ACV-0008", "ACV-0011", "ACV-0009"], "scorecard_released", "October scorecard released", "Open it to acknowledge and add a comment.", "/performance", 60 * 50],
  [EVERYONE_BELOW_CEO, "announcement", "Go-live on 30 November: please acknowledge", "Read the tracking policy and the go-live plan.", "/announcements", 60 * 5],
  [["ACV-0007"], "message_mention", "Omar mentioned you in #development", "“@Mariam can Nida test the check-in card on your branch?”", "/messages", 42],
  // CTO: manages development
  [["ACV-0004"], "leave_requested", "Leave request from Ali Raza", "Casual leave, 2 days. Waiting for your approval, then the Director's.", "/approvals", 25],
  [["ACV-0004"], "approval_waiting", "Tasks are waiting for your review", "Submitted by Mariam Shah, Danish Iqbal and Ali Raza.", "/approvals", 70],
  [["ACV-0004"], "extension_requested", "Extension asked: Regression tests: payslip PDF", "Danish Iqbal asked for 2 more days.", "/approvals", 130],
  [["ACV-0004"], "leave_requested", "Leave request from Nida Aslam", "Sick leave, 1 day.", "/approvals", 200],
  [["ACV-0004"], "sales_tool_problem", "Apollo sync failing for 1 hour", "The API key may have expired. Check Integrations.", "/integrations", 65],
  // CEO / Founder / Owner: sees everything, approves nothing (for your information)
  [["ACV-0001"], "approval_waiting", "6 items are waiting for the Director", "November payroll, JE-2026-0311 and 4 more. View only: the Director approves.", "/approvals", 30],
  [["ACV-0001", "ACV-0003", "ACV-0004"], "security_alert", "Login from a new city", "Ali Raza signed in from Lahore on a new device.", "/activity?tab=alerts", 55],
  // Director: the approver for the company; HR duty, sales manager
  [["ACV-0003"], "payroll_ready", "November payroll is waiting for your approval", "Prepared by Sana Malik (Finance).", "/payroll", 35],
  [["ACV-0003"], "approval_waiting", "Journal entry JE-2026-0311 needs your approval", "PKR 120,000 · Annual hosting prepayment, entered by Sana Malik (Finance).", "/approvals", 80],
  [["ACV-0003"], "approval_waiting", "Won deal waiting for your confirmation", "Kamran Javed marked DL-0019 as Won.", "/approvals", 48],
  [["ACV-0003"], "approval_waiting", "Commission line ready for approval", "Hira Baig · first invoice paid by Northwind Studio.", "/approvals", 140],
  [["ACV-0003"], "leave_requested", "Leave request from Hira Baig", "Annual leave, 3 days.", "/approvals", 90],
  [["ACV-0010", "ACV-0003"], "renewal_due", "Apollo renews in 6 days", "Professional plan · USD 99 / month per seat.", "/billing/subscriptions", 60 * 3],
  [["ACV-0010", "ACV-0003"], "invoice_overdue", "INV-2026-0042 is 9 days overdue", "Bright Path Academy · PKR 185,000 outstanding.", "/billing", 60 * 7],
  // Sales
  [["ACV-0009"], "sales_reply", "New reply from Olivia Grant (Harbor & Co)", "“Thanks Hira, can we talk on Thursday?”", "/sales/leads", 12],
  [SALES, "sales_follow_up", "Follow-ups are due today", "Open My sales day to see them.", "/sales", 60 * 2],
];

export function seedNotifications(): Notification[] {
  const out: Notification[] = [];
  let n = 0;
  for (const [empIds, type, title, body, link, minAgo, read] of SEEDS) {
    for (const empId of new Set(empIds)) {
      out.push({ id: `ntf_${++n}`, empId, type, title, body, link, at: minutesAgo(minAgo), read: !!read, essential: ESSENTIAL_TYPES.includes(type) });
    }
  }
  return out.sort((a, b) => b.at.localeCompare(a.at));
}
