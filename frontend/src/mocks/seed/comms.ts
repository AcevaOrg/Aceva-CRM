/** Seed: conversations, messages, presence, announcements, meetings (Module 14). */
import type { Announcement, Conversation, Meeting, Message, Presence } from "@/features/comms/types";
import { daysFromNow, minutesAgo, workdaysFromNow } from "../time";
import { EMPLOYEES } from "./people";

export type ConversationRecord = Omit<Conversation, "unread" | "lastMessageAt" | "lastMessagePreview">;
export type MessageRecord = Omit<Message, "replyCount" | "lastReplyAt" | "readBy">;

const ALL = EMPLOYEES.map((e) => e.empId);

export function seedConversations(): ConversationRecord[] {
  const c = (id: string, kind: ConversationRecord["kind"], members: string[], extra: Partial<ConversationRecord> = {}): ConversationRecord => ({
    id,
    kind,
    memberEmpIds: members,
    moderatorEmpIds: [],
    createdBy: members[0],
    createdAt: daysFromNow(-60),
    pinnedMessageIds: [],
    ...extra,
  });
  return [
    c("ch-general", "channel", ALL, { name: "general", topic: "Company-wide news and questions", moderatorEmpIds: ["ACV-0005", "ACV-0004"], createdBy: "ACV-0005", pinnedMessageIds: ["m_gen_1"] }),
    c("ch-eng", "channel", ["ACV-0004", "ACV-0006", "ACV-0007", "ACV-0008", "ACV-0011", "ACV-0013"], { name: "engineering", topic: "Build of the Aceva Digital System", scope: { departmentId: "dep-eng" }, moderatorEmpIds: ["ACV-0006"], createdBy: "ACV-0006", pinnedMessageIds: ["m_eng_1"] }),
    c("ch-sales", "channel", ["ACV-0014", "ACV-0009", "ACV-0012", "ACV-0003"], { name: "sales", topic: "Pipeline, replies and daily targets", scope: { departmentId: "dep-sales" }, moderatorEmpIds: ["ACV-0014"], createdBy: "ACV-0014" }),
    c("ch-finance", "channel", ["ACV-0003", "ACV-0010", "ACV-0002", "ACV-0001"], { name: "finance-desk", topic: "Month close, payroll and approvals", scope: { departmentId: "dep-fin" }, moderatorEmpIds: ["ACV-0003"], createdBy: "ACV-0003" }),
    c("ch-mgmt", "channel", ["ACV-0001", "ACV-0002", "ACV-0003", "ACV-0004"], { name: "management", topic: "Decisions for the go-live", moderatorEmpIds: ["ACV-0002"], createdBy: "ACV-0002" }),
    c("ch-golive", "channel", ["ACV-0004", "ACV-0005", "ACV-0006", "ACV-0003", "ACV-0007", "ACV-0010"], { name: "go-live", topic: "Release on 30 November", scope: { projectId: "prj-ads" }, moderatorEmpIds: ["ACV-0004"], createdBy: "ACV-0004", pinnedMessageIds: ["m_gl_1"] }),
    c("ch-harbor", "channel", ["ACV-0006", "ACV-0008", "ACV-0011", "ACV-0009", "ACV-0014"], { name: "harbor-and-co", topic: "Harbor & Co e-commerce build", scope: { projectId: "prj-harbor" }, moderatorEmpIds: ["ACV-0006"], createdBy: "ACV-0006" }),
    c("dm-07-06", "dm", ["ACV-0007", "ACV-0006"]),
    c("dm-07-13", "dm", ["ACV-0007", "ACV-0013"]),
    c("dm-06-04", "dm", ["ACV-0006", "ACV-0004"]),
    c("dm-09-14", "dm", ["ACV-0009", "ACV-0014"]),
    c("dm-10-03", "dm", ["ACV-0010", "ACV-0003"]),
    c("dm-02-03", "dm", ["ACV-0002", "ACV-0003"]),
    c("grp-payslip", "group", ["ACV-0010", "ACV-0003", "ACV-0011", "ACV-0006"], { name: "Payslip layout review", createdBy: "ACV-0010" }),
  ];
}

type Row = [id: string, conv: string, author: string, minAgo: number, body: string, extra?: Partial<MessageRecord>];

const pdf = (id: string, fileName: string, sizeBytes: number, by: string, mime = "application/pdf") => ({
  id,
  fileName,
  sizeBytes,
  mimeType: mime,
  uploadedAt: minutesAgo(600),
  uploadedBy: by,
  scan: "clean" as const,
});

const ROWS: Row[] = [
  // #general
  ["m_gen_1", "ch-general", "ACV-0005", 3000, "Welcome to the new Aceva Digital System! Please read the tracking policy before go-live on 30 November. Questions here or to me directly.", { reactions: [{ emoji: "🎉", empIds: ["ACV-0002", "ACV-0007", "ACV-0009", "ACV-0013", "ACV-0011"] }, { emoji: "👍", empIds: ["ACV-0006", "ACV-0008"] }] }],
  ["m_gen_2", "ch-general", "ACV-0002", 1500, "Reminder: Monday is Iqbal Day, the office is closed. Enjoy the long weekend.", { reactions: [{ emoji: "🙏", empIds: ["ACV-0010", "ACV-0012", "ACV-0005"] }] }],
  ["m_gen_3", "ch-general", "ACV-0013", 300, "Is there a guide for the new check-in button? I couldn't find it on my phone."],
  ["m_gen_4", "ch-general", "ACV-0005", 290, "It's on the Home screen and in the top bar, @Nida. The time comes from the server, so your phone clock doesn't matter.", { mentions: ["ACV-0013"] }],
  ["m_gen_5", "ch-general", "ACV-0004", 60, "Heads-up: the test system will be down from 19:00 to 19:30 tonight for a database upgrade."],
  // #engineering
  ["m_eng_1", "ch-eng", "ACV-0006", 2400, "Cycle 2 demo is on day 6. Each of you: one screen, two minutes, live on the test system. Pinning the order here.", { reactions: [{ emoji: "✅", empIds: ["ACV-0007", "ACV-0008", "ACV-0011", "ACV-0013"] }] }],
  ["m_eng_1r1", "ch-eng", "ACV-0007", 2380, "I'll show the leave balance widget.", { parentId: "m_eng_1" }],
  ["m_eng_1r2", "ch-eng", "ACV-0008", 2370, "Checkout flow for Harbor, if the sandbox keys arrive.", { parentId: "m_eng_1" }],
  ["m_eng_1r3", "ch-eng", "ACV-0011", 2300, "Payslip layout + the empty-state illustrations.", { parentId: "m_eng_1" }],
  ["m_eng_2", "ch-eng", "ACV-0008", 900, "PR for the product listing filters is up. Could someone review before lunch?", { reactions: [{ emoji: "👀", empIds: ["ACV-0007"] }] }],
  ["m_eng_3", "ch-eng", "ACV-0007", 870, "On it. Left two small comments, otherwise good to merge.", { editedAt: minutesAgo(860) }],
  ["m_eng_4", "ch-eng", "ACV-0008", 600, "", { deleted: true }],
  ["m_eng_5", "ch-eng", "ACV-0006", 42, "@Mariam can you pair with Nida on the check-in card? She's close but the grace ring needs the server time.", { mentions: ["ACV-0007"], linkedTaskId: "tsk_16" }],
  ["m_eng_6", "ch-eng", "ACV-0013", 30, "Thank you! I pushed what I have so far.", { attachments: [pdf("att_m1", "check-in-card-v2.png", 412_000, "ACV-0013", "image/png")] }],
  // #sales
  ["m_sal_1", "ch-sales", "ACV-0014", 1440, "Daily target today: 30 emails sent each through Apollo, and log LinkedIn messages before check-out please."],
  ["m_sal_2", "ch-sales", "ACV-0009", 300, "Harbor & Co replied! Olivia wants a call on Thursday. Moving the deal to Replied.", { reactions: [{ emoji: "🎉", empIds: ["ACV-0014", "ACV-0012", "ACV-0003"] }] }],
  ["m_sal_3", "ch-sales", "ACV-0012", 120, "Bounce rate on tryaceva.com was 2.8% yesterday. Pausing that mailbox for today to be safe."],
  ["m_sal_4", "ch-sales", "ACV-0003", 95, "Good call, Kamran. Keep it under 3%."],
  // #finance-desk
  ["m_fin_1", "ch-finance", "ACV-0010", 700, "October bank reconciliation is done. Two lines were missing in the ledger; entries are drafted for approval.", { attachments: [pdf("att_m2", "october-reconciliation.xlsx", 88_000, "ACV-0010", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")] }],
  ["m_fin_2", "ch-finance", "ACV-0003", 660, "Thanks Sana. I'll review them today. JE-2026-0311 needs the CEO because of the amount."],
  ["m_fin_3", "ch-finance", "ACV-0002", 120, "Looking at it now."],
  // #management
  ["m_mgt_1", "ch-mgmt", "ACV-0001", 2000, "Let's confirm the approval limits before the ledger goes live: Director up to 50k, CEO up to 500k, me above that."],
  ["m_mgt_2", "ch-mgmt", "ACV-0002", 1980, "Agreed. Bilal, please put them in Settings."],
  ["m_mgt_3", "ch-mgmt", "ACV-0004", 400, "Security check against the OWASP list is scheduled for cycle 4."],
  // #go-live
  ["m_gl_1", "ch-golive", "ACV-0004", 1700, "Go-live checklist is attached. Owners are in column C. Please update your rows by Friday.", { attachments: [pdf("att_m3", "go-live-checklist.xlsx", 64_000, "ACV-0004", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")] }],
  ["m_gl_2", "ch-golive", "ACV-0005", 800, "Employee list for go-live is 90% done. Waiting on two CNIC copies."],
  ["m_gl_2r1", "ch-golive", "ACV-0004", 780, "Thanks Zainab. Can we import the rest on Monday?", { parentId: "m_gl_2" }],
  ["m_gl_2r2", "ch-golive", "ACV-0005", 760, "Yes, Monday morning.", { parentId: "m_gl_2" }],
  ["m_gl_3", "ch-golive", "ACV-0010", 90, "Opening balances file is ready for the accountant's sign-off."],
  // #harbor-and-co
  ["m_hb_1", "ch-harbor", "ACV-0011", 1100, "Wireframes for the product page and checkout.", { attachments: [pdf("att_m4", "harbor-wireframes.pdf", 2_400_000, "ACV-0011")] }],
  ["m_hb_2", "ch-harbor", "ACV-0009", 1000, "The client loved the checkout. They asked if the loyalty points can show on the cart page."],
  ["m_hb_3", "ch-harbor", "ACV-0008", 200, "Possible, but it needs a new API from their side. Adding a task.", { linkedTaskId: "tsk_6" }],
  // DM Mariam ↔ Fahad
  ["m_d1_1", "dm-07-06", "ACV-0007", 400, "Hi Fahad, the balances API isn't ready yet. OK if I use mock data for the widget?"],
  ["m_d1_2", "dm-07-06", "ACV-0006", 380, "Yes, mock is fine. Switch once M7 lands."],
  ["m_d1_3", "dm-07-06", "ACV-0006", 25, "Also, nice work on the org chart. The CEO liked it.", { reactions: [{ emoji: "🙏", empIds: ["ACV-0007"] }] }],
  // DM Mariam ↔ Nida
  ["m_d2_1", "dm-07-13", "ACV-0013", 35, "Hi Mariam! Fahad said you could help me with the check-in card. Is now a good time?"],
  // DM Fahad ↔ Omar
  ["m_d3_1", "dm-06-04", "ACV-0006", 500, "Sprint plan for cycle 3 is in the task. Can you check the workload? Ali is over 40 hours."],
  ["m_d3_2", "dm-06-04", "ACV-0004", 480, "Move the shipping rules task to next week then."],
  // DM Hira ↔ Saad
  ["m_d4_1", "dm-09-14", "ACV-0009", 70, "Harbor & Co want a proposal by Thursday. Can you review my draft tomorrow?"],
  ["m_d4_2", "dm-09-14", "ACV-0014", 64, "Sure, send it over in the morning."],
  // DM Sana ↔ Bilal
  ["m_d5_1", "dm-10-03", "ACV-0010", 180, "November payroll draft is ready for your review."],
  ["m_d5_2", "dm-10-03", "ACV-0003", 170, "Reviewing now. Commission line for Hira looks right."],
  // DM Ayesha ↔ Bilal
  ["m_d6_1", "dm-02-03", "ACV-0003", 140, "Payroll is reviewed and waiting for your approval."],
  // Group: Payslip layout review
  ["m_g1_1", "grp-payslip", "ACV-0010", 260, "The accountant wants YTD totals on every payslip.", { attachments: [pdf("att_m5", "payslip-layout-v3.pdf", 310_000, "ACV-0010")] }],
  ["m_g1_2", "grp-payslip", "ACV-0011", 240, "Got it, I'll add a YTD column. That's why I asked for the extension.", { linkedTaskId: "tsk_12" }],
];

export function seedMessages(): MessageRecord[] {
  return ROWS.map(([id, conversationId, author, minAgo, body, extra]) => ({
    id,
    conversationId,
    author,
    body,
    at: minutesAgo(minAgo),
    reactions: [],
    mentions: [],
    attachments: [],
    ...extra,
  }));
}

/** Last time each member read each conversation. Default: 2 hours ago. */
export function seedReads(convs: ConversationRecord[]) {
  const out: { conversationId: string; empId: string; at: string }[] = [];
  for (const c of convs) for (const m of c.memberEmpIds) out.push({ conversationId: c.id, empId: m, at: minutesAgo(120) });
  return out;
}

export function seedPresence(): Presence[] {
  const online = ["ACV-0006", "ACV-0004", "ACV-0013", "ACV-0003", "ACV-0009", "ACV-0014", "ACV-0011", "ACV-0010"];
  const away = ["ACV-0002", "ACV-0008", "ACV-0005"];
  return EMPLOYEES.map((e, i) => ({
    empId: e.empId,
    state: online.includes(e.empId) ? "online" : away.includes(e.empId) ? "away" : "offline",
    lastSeenAt: online.includes(e.empId) ? minutesAgo(1) : minutesAgo(20 + i * 37),
  }));
}

export function seedAnnouncements(): Announcement[] {
  return [
    {
      id: "an1", title: "Go-live on Monday 30 November", author: "ACV-0002", pinned: true, requiresAck: true, at: daysFromNow(-2, "10:00"),
      audience: { all: true, departmentIds: [] },
      body: "From 30 November, tasks, attendance, leave, tracking and finance entries are recorded in the Aceva Digital System. On go-live day you'll get your Emp-ID and a temporary password by email. The first login asks you to set a new password and accept the tracking policy.\n\nThe whole team is available for five working days after go-live to fix problems quickly.",
      ackEmpIds: ["ACV-0001", "ACV-0003", "ACV-0004", "ACV-0005", "ACV-0006", "ACV-0010", "ACV-0011"],
    },
    {
      id: "an2", title: "What the system records (tracking policy)", author: "ACV-0005", pinned: true, requiresAck: true, at: daysFromNow(-3, "09:30"),
      audience: { all: true, departmentIds: [] },
      body: "We record logins, active and idle time inside the app, screens you open and changes you make. We never record your screen, keystrokes, camera, email text or personal accounts. You can see your own history any time under Activity.",
      ackEmpIds: ["ACV-0001", "ACV-0002", "ACV-0003", "ACV-0004", "ACV-0006", "ACV-0007", "ACV-0008", "ACV-0010", "ACV-0011", "ACV-0014"],
    },
    {
      id: "an3", title: "Office closed for Iqbal Day", author: "ACV-0005", pinned: false, requiresAck: false, at: daysFromNow(-4, "16:00"),
      audience: { all: true, departmentIds: [] }, body: "The office is closed on 9 November for Iqbal Day. Task deadlines skip public holidays automatically.", ackEmpIds: [],
    },
    {
      id: "an4", title: "Sales modules arrive in Phase 2 (15 December)", author: "ACV-0003", pinned: false, requiresAck: true, at: daysFromNow(-1, "12:00"),
      audience: { all: false, departmentIds: ["dep-sales"] },
      body: "Leads, pipeline and the daily sales report move into the system on 15 December. Apollo and MillionVerifier counts will arrive automatically; LinkedIn, WhatsApp and Fiverr go in the 2-minute daily log.",
      ackEmpIds: ["ACV-0014"],
    },
    {
      id: "an5", title: "Month close: entries by the 3rd", author: "ACV-0003", pinned: false, requiresAck: false, at: daysFromNow(-6, "11:00"),
      audience: { all: false, departmentIds: ["dep-fin"] }, body: "Please post all October entries and receipts by the 3rd so the month can close on time.", ackEmpIds: [],
    },
    {
      id: "an6", title: "Cycle 1 demo: thank you", author: "ACV-0004", pinned: false, requiresAck: false, at: daysFromNow(-8, "18:10"),
      audience: { all: false, departmentIds: ["dep-eng"] }, body: "Great demo of access control, login and profiles. Management signed off cycle 1. Next: activity tracking, tasks and performance.", ackEmpIds: [],
    },
  ];
}

export function seedMeetings(): Meeting[] {
  const m = (id: string, title: string, start: string, durationMin: number, organizer: string, participants: string[], agenda: string, extra: Partial<Meeting> = {}): Meeting => ({
    id,
    title,
    start,
    durationMin,
    location: "Dadu HQ · meeting room",
    organizer,
    participants: participants.map((empId, i) => ({ empId, rsvp: (["yes", "yes", "maybe", "pending", "yes", "no"] as const)[i % 6] })),
    agenda,
    attachments: [],
    linkedTaskIds: [],
    ...extra,
  });
  return [
    m("mtg1", "Engineering check-in", workdaysFromNow(1, "09:15"), 15, "ACV-0006", ["ACV-0007", "ACV-0008", "ACV-0011", "ACV-0013"], "1. Yesterday\n2. Today\n3. Anything blocking", { location: "Online (Google Meet)" }),
    m("mtg2", "Payslip layout review", workdaysFromNow(1, "14:00"), 30, "ACV-0010", ["ACV-0003", "ACV-0011", "ACV-0006"], "1. YTD totals column\n2. Deductions order\n3. Sign-off for the November run", { linkedTaskIds: ["tsk_12"], attachments: [{ id: "ma1", fileName: "payslip-layout-v3.pdf", sizeBytes: 310_000, mimeType: "application/pdf", uploadedAt: minutesAgo(260), uploadedBy: "ACV-0010" }] }),
    m("mtg3", "1:1 Fahad and Mariam", workdaysFromNow(2, "12:00"), 30, "ACV-0006", ["ACV-0007"], "Progress on the leave widget, the rework on the working-day tests, and goals for December.", { linkedTaskIds: ["tsk_1", "tsk_5"], location: "Karachi Studio · small room" }),
    m("mtg4", "Cycle demo to management", workdaysFromNow(2, "16:00"), 60, "ACV-0004", ["ACV-0001", "ACV-0002", "ACV-0003", "ACV-0005", "ACV-0006", "ACV-0007", "ACV-0010"], "Demo of activity tracking, task management and performance. Decisions needed: score weights and working hours."),
    m("mtg5", "Sales pipeline review", workdaysFromNow(3, "11:00"), 45, "ACV-0014", ["ACV-0009", "ACV-0012", "ACV-0003"], "1. Deals stuck in Proposal sent\n2. Bounce rates per mailbox\n3. Targets for next week", { location: "Online (Google Meet)" }),
    m("mtg6", "Harbor & Co kickoff", workdaysFromNow(4, "15:00"), 60, "ACV-0006", ["ACV-0008", "ACV-0011", "ACV-0009", "ACV-0014"], "Scope of milestone 1, the loyalty points question, and the delivery dates.", { linkedTaskIds: ["tsk_6"], location: "Online (Zoom) with the client" }),
    m("mtg7", "Go-live readiness", workdaysFromNow(5, "10:00"), 60, "ACV-0004", ["ACV-0003", "ACV-0005", "ACV-0006", "ACV-0010", "ACV-0002"], "Walk through the go-live checklist row by row. Backup and restore test result. Training dates."),
    m("mtg8", "Tracking policy walkthrough", workdaysFromNow(-1, "11:00"), 45, "ACV-0005", ["ACV-0003", "ACV-0004", "ACV-0006", "ACV-0014"], "Read through the policy wording before it goes to everyone.", {
      notes: "Agreed: no GPS, city only. Sales tools are named in the policy. Zainab sends the final text to everyone; acknowledgement required.",
      notesUpdatedAt: workdaysFromNow(-1, "12:00"),
    }),
    m("mtg9", "Cycle 3 planning", workdaysFromNow(-2, "10:00"), 60, "ACV-0004", ["ACV-0006", "ACV-0003", "ACV-0010"], "Attendance, payroll and ledger: API contracts and test data.", {
      notes: "Ledger chart of accounts signed off by the accountant. Payroll needs the tax slabs before day 1 of the cycle.",
      notesUpdatedAt: workdaysFromNow(-2, "11:15"),
    }),
  ];
}
