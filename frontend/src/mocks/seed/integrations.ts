/** Seed: Module 16 sales tool integrations. */
import type { MailboxStat, SyncRun, ToolConnection, ToolUserLink, UnmatchedItem } from "@/features/integrations/types";
import { daysFromNow, minutesAgo } from "../time";

export function seedConnections(): ToolConnection[] {
  return [
    { tool: "apollo", status: "working", keyLast4: "x7Qa", syncEveryMin: 15, lastSuccessAt: minutesAgo(8), itemsToday: 214, callsUsed: 112, callsLimit: 400, callsWindow: "this hour", connectedBy: "ACV-0004", connectedAt: daysFromNow(-6, "11:00") },
    { tool: "millionverifier", status: "working", keyLast4: "9mVk", syncEveryMin: 30, lastSuccessAt: minutesAgo(19), itemsToday: 66, creditsLeft: 1412, creditAlertAt: 1000, creditsUsedPerDay: 152, connectedBy: "ACV-0004", connectedAt: daysFromNow(-6, "11:20") },
    { tool: "mailboxes", status: "working", keyLast4: "dX2p", syncEveryMin: 30, lastSuccessAt: minutesAgo(26), itemsToday: 9, imapHost: "imap.hostinger.com", connectedBy: "ACV-0004", connectedAt: daysFromNow(-5, "15:00") },
    { tool: "salesforce", status: "not_connected", syncEveryMin: 30, itemsToday: 0 },
  ];
}

export function seedToolUsers(): ToolUserLink[] {
  return [
    { tool: "apollo", externalUserId: "ap_u_101", name: "Hira Baig", email: "hira@acevatech.com", empId: "ACV-0009" },
    { tool: "apollo", externalUserId: "ap_u_102", name: "Kamran Javed", email: "kamran@acevatech.com", empId: "ACV-0012" },
    { tool: "apollo", externalUserId: "ap_u_103", name: "Saad Mirza", email: "saad@acevatech.com", empId: "ACV-0014" },
    { tool: "apollo", externalUserId: "ap_u_104", name: "Rehan Qadir", email: "rehan.q@acevatech.com" },
    { tool: "mailboxes", externalUserId: "hira@tryaceva.com", name: "hira@tryaceva.com", email: "hira@tryaceva.com", empId: "ACV-0009" },
    { tool: "mailboxes", externalUserId: "hira@acevahq.com", name: "hira@acevahq.com", email: "hira@acevahq.com", empId: "ACV-0009" },
    { tool: "mailboxes", externalUserId: "kamran@tryaceva.com", name: "kamran@tryaceva.com", email: "kamran@tryaceva.com", empId: "ACV-0012" },
    { tool: "mailboxes", externalUserId: "kamran@getaceva.com", name: "kamran@getaceva.com", email: "kamran@getaceva.com", empId: "ACV-0012" },
    { tool: "salesforce", externalUserId: "sf_005", name: "Integration User", email: "integration@acevatech.com" },
  ];
}

export function seedMailboxes(): MailboxStat[] {
  return [
    { mailbox: "hira@tryaceva.com", domain: "tryaceva.com", ownerEmpId: "ACV-0009", sentToday: 18, repliesToday: 2, bouncesToday: 0, sentWeek: 92, bouncesWeek: 1, paused: false },
    { mailbox: "hira@acevahq.com", domain: "acevahq.com", ownerEmpId: "ACV-0009", sentToday: 15, repliesToday: 1, bouncesToday: 0, sentWeek: 80, bouncesWeek: 2, paused: false },
    { mailbox: "kamran@tryaceva.com", domain: "tryaceva.com", ownerEmpId: "ACV-0012", sentToday: 16, repliesToday: 1, bouncesToday: 0, sentWeek: 85, bouncesWeek: 1, paused: false },
    { mailbox: "kamran@getaceva.com", domain: "getaceva.com", ownerEmpId: "ACV-0012", sentToday: 13, repliesToday: 1, bouncesToday: 2, sentWeek: 72, bouncesWeek: 4, paused: false },
  ];
}

export function seedSyncRuns(): SyncRun[] {
  const run = (id: number, tool: SyncRun["tool"], min: number, items: number, result: SyncRun["result"] = "ok", attempt = 1, error?: string): SyncRun => ({
    id: `run_${id}`,
    tool,
    startedAt: minutesAgo(min),
    finishedAt: result === "retrying" ? undefined : minutesAgo(min - 1),
    items,
    result,
    attempt,
    error,
  });
  return [
    run(1, "apollo", 8, 14),
    run(2, "millionverifier", 19, 40),
    run(3, "apollo", 23, 9),
    run(4, "mailboxes", 26, 5),
    run(5, "mailboxes", 31, 0, "failed", 3, "IMAP login timed out"),
    run(6, "mailboxes", 46, 0, "retrying", 2, "IMAP login timed out"),
    run(7, "apollo", 38, 21),
    run(8, "millionverifier", 49, 26),
    run(9, "apollo", 53, 17),
    run(10, "mailboxes", 56, 4),
    run(11, "apollo", 68, 12),
    run(12, "millionverifier", 79, 0),
  ];
}

export function seedUnmatched(): UnmatchedItem[] {
  return [
    { id: "um_1", tool: "apollo", externalUserId: "ap_u_104", userName: "Rehan Qadir", kind: "email_sent", at: minutesAgo(35), summary: "Step 1 email to a prospect at Fern & Fig" },
    { id: "um_2", tool: "apollo", externalUserId: "ap_u_104", userName: "Rehan Qadir", kind: "email_sent", at: minutesAgo(36), summary: "Step 1 email to a prospect at Ridgeline Gyms" },
    { id: "um_3", tool: "apollo", externalUserId: "ap_u_104", userName: "Rehan Qadir", kind: "call", at: minutesAgo(90), summary: "4-minute call with the Apollo dialer" },
    { id: "um_4", tool: "apollo", externalUserId: "ap_u_104", userName: "Rehan Qadir", kind: "reply", at: minutesAgo(110), summary: "Reply received from a prospect at Fern & Fig" },
  ];
}
