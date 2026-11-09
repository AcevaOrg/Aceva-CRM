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
  /*
   * Channels follow the structure: #general (everyone), #engineering (CTO moderates, engineers),
   * #sales (Director as sales manager, sales), #finance (Director and the finance person),
   * #management (CEO / Founder / Owner, Director, CTO), plus project channels.
   * Channels are created by managers (Director, CTO); the CEO / Founder / Owner reads and posts but moderates nothing.
   */
  return [
    c("ch-general", "channel", ALL, { name: "general", topic: "Company-wide news and questions", moderatorEmpIds: ["ACV-0003", "ACV-0004"], createdBy: "ACV-0003", pinnedMessageIds: ["m_gen_1"] }),
    c("ch-eng", "channel", ["ACV-0004", "ACV-0006", "ACV-0007", "ACV-0008", "ACV-0011", "ACV-0013"], { name: "engineering", topic: "Build of the Aceva Digital System", scope: { departmentId: "dep-eng" }, moderatorEmpIds: ["ACV-0004"], createdBy: "ACV-0004", pinnedMessageIds: ["m_eng_1"] }),
    c("ch-sales", "channel", ["ACV-0003", "ACV-0009", "ACV-0012", "ACV-0014"], { name: "sales", topic: "Pipeline, replies and daily targets", scope: { departmentId: "dep-sales" }, moderatorEmpIds: ["ACV-0003"], createdBy: "ACV-0003" }),
    c("ch-fin", "channel", ["ACV-0003", "ACV-0010"], { name: "finance", topic: "Entries, payroll and the month close. Finance prepares, the Director approves.", scope: { departmentId: "dep-fin" }, moderatorEmpIds: ["ACV-0003"], createdBy: "ACV-0003", pinnedMessageIds: ["m_fin_1"] }),
    c("ch-mgmt", "channel", ["ACV-0001", "ACV-0003", "ACV-0004"], { name: "management", topic: "Company updates and go-live planning", moderatorEmpIds: ["ACV-0003"], createdBy: "ACV-0003" }),
    c("ch-golive", "channel", ["ACV-0004", "ACV-0003", "ACV-0006", "ACV-0007", "ACV-0010"], { name: "go-live", topic: "Release on 30 November", scope: { projectId: "prj-ads" }, moderatorEmpIds: ["ACV-0004"], createdBy: "ACV-0004", pinnedMessageIds: ["m_gl_1"] }),
    c("ch-harbor", "channel", ["ACV-0004", "ACV-0006", "ACV-0008", "ACV-0011", "ACV-0009"], { name: "harbor-and-co", topic: "Harbor & Co e-commerce build", scope: { projectId: "prj-harbor" }, moderatorEmpIds: ["ACV-0004"], createdBy: "ACV-0004" }),
    c("dm-07-04", "dm", ["ACV-0007", "ACV-0004"]),
    c("dm-07-13", "dm", ["ACV-0007", "ACV-0013"]),
    c("dm-06-04", "dm", ["ACV-0006", "ACV-0004"]),
    c("dm-04-03", "dm", ["ACV-0004", "ACV-0003"]),
    c("dm-09-03", "dm", ["ACV-0009", "ACV-0003"]),
    c("dm-03-01", "dm", ["ACV-0003", "ACV-0001"]),
    c("dm-09-10", "dm", ["ACV-0009", "ACV-0010"]),
    c("grp-payslip", "group", ["ACV-0010", "ACV-0011", "ACV-0004"], { name: "Payslip layout review", createdBy: "ACV-0010" }),
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
  ["m_gen_1", "ch-general", "ACV-0003", 3000, "Welcome to the new Aceva Digital System! Please read the tracking policy before go-live on 30 November. Questions here or to me directly.", { reactions: [{ emoji: "🎉", empIds: ["ACV-0001", "ACV-0007", "ACV-0009", "ACV-0013", "ACV-0011", "ACV-0010"] }, { emoji: "👍", empIds: ["ACV-0006", "ACV-0008"] }] }],
  ["m_gen_2", "ch-general", "ACV-0001", 1500, "Reminder: Monday is Iqbal Day, the office is closed. Enjoy the long weekend.", { reactions: [{ emoji: "🙏", empIds: ["ACV-0003", "ACV-0012", "ACV-0014", "ACV-0010"] }] }],
  ["m_gen_3", "ch-general", "ACV-0013", 300, "Is there a guide for the new check-in button? I couldn't find it on my phone."],
  ["m_gen_4", "ch-general", "ACV-0003", 290, "It's on the Home screen and in the top bar, @Nida. The time comes from the server, so your phone clock doesn't matter.", { mentions: ["ACV-0013"] }],
  ["m_gen_5", "ch-general", "ACV-0010", 180, "From Finance: November payslips will appear under Payroll once Bilal approves the run. Questions about your payslip can come to me.", { reactions: [{ emoji: "👍", empIds: ["ACV-0006", "ACV-0009", "ACV-0012"] }] }],
  ["m_gen_6", "ch-general", "ACV-0004", 60, "Heads-up: the test system will be down from 19:00 to 19:30 tonight for a database upgrade."],
  // #engineering (the CTO runs it)
  ["m_eng_1", "ch-eng", "ACV-0004", 2400, "Cycle 2 demo is on day 6. Each of you: one screen, two minutes, live on the test system. Pinning the order here.", { reactions: [{ emoji: "✅", empIds: ["ACV-0006", "ACV-0007", "ACV-0008", "ACV-0011", "ACV-0013"] }] }],
  ["m_eng_1r1", "ch-eng", "ACV-0007", 2380, "I'll show the leave balance widget.", { parentId: "m_eng_1" }],
  ["m_eng_1r2", "ch-eng", "ACV-0008", 2370, "Checkout flow for Harbor, if the sandbox keys arrive.", { parentId: "m_eng_1" }],
  ["m_eng_1r3", "ch-eng", "ACV-0011", 2300, "Payslip layout + the empty-state illustrations.", { parentId: "m_eng_1" }],
  ["m_eng_1r4", "ch-eng", "ACV-0006", 2290, "Deployment checklist walkthrough.", { parentId: "m_eng_1" }],
  ["m_eng_2", "ch-eng", "ACV-0008", 900, "PR for the product listing filters is up. Could someone review before lunch?", { reactions: [{ emoji: "👀", empIds: ["ACV-0007"] }] }],
  ["m_eng_3", "ch-eng", "ACV-0007", 870, "On it. Left two small comments, otherwise good to merge.", { editedAt: minutesAgo(860) }],
  ["m_eng_4", "ch-eng", "ACV-0008", 600, "", { deleted: true }],
  ["m_eng_5", "ch-eng", "ACV-0004", 42, "@Mariam can you pair with Nida on the check-in card? She's close but the grace ring needs the server time.", { mentions: ["ACV-0007"], linkedTaskId: "tsk_16" }],
  ["m_eng_6", "ch-eng", "ACV-0013", 30, "Thank you! I pushed what I have so far.", { attachments: [pdf("att_m1", "check-in-card-v2.png", 412_000, "ACV-0013", "image/png")] }],
  // #sales (the Director is the sales manager)
  ["m_sal_1", "ch-sales", "ACV-0003", 1440, "Daily target today: 30 emails sent each through Apollo, and log LinkedIn messages before check-out please."],
  ["m_sal_2", "ch-sales", "ACV-0009", 300, "Harbor & Co replied! Olivia wants a call on Thursday. Moving the deal to Replied.", { reactions: [{ emoji: "🎉", empIds: ["ACV-0014", "ACV-0012", "ACV-0003"] }] }],
  ["m_sal_3", "ch-sales", "ACV-0012", 120, "Bounce rate on tryaceva.com was 2.8% yesterday. Pausing that mailbox for today to be safe."],
  ["m_sal_4", "ch-sales", "ACV-0003", 95, "Good call, Kamran. Keep it under 3%."],
  ["m_sal_5", "ch-sales", "ACV-0014", 50, "Two replies from the Dubai agencies list this morning. Logging both before lunch."],
  // #finance (Sana prepares, Bilal approves)
  ["m_fin_1", "ch-fin", "ACV-0003", 4000, "How we work here: Sana prepares journal entries, payroll runs, bills, invoices and the month close; I approve them. Nobody approves their own work. Hamza sees everything but signs nothing."],
  ["m_fin_2", "ch-fin", "ACV-0010", 1300, "October bank reconciliation is done. Two lines were missing in the ledger, so I've entered them as drafts for your approval.", { attachments: [pdf("att_m2", "october-reconciliation.xlsx", 88_000, "ACV-0010", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")] }],
  ["m_fin_3", "ch-fin", "ACV-0003", 1250, "Thanks, Sana. I'll go through the reconciliation and approve the two entries today."],
  ["m_fin_4", "ch-fin", "ACV-0010", 80, "JE-2026-0311 (annual hosting prepayment, PKR 120,000) is entered and waiting for your approval."],
  ["m_fin_5", "ch-fin", "ACV-0010", 60, "November payroll is prepared too. It's in Approvals and needs step-up when you approve it."],
  ["m_fin_6", "ch-fin", "ACV-0003", 45, "Will do both after lunch. Hamza can open the run any time; it doesn't need his sign-off.", { reactions: [{ emoji: "👍", empIds: ["ACV-0010"] }] }],
  // #management (CEO / Founder / Owner, Director, CTO)
  ["m_mgt_1", "ch-mgmt", "ACV-0001", 2000, "Bilal, please have the working hours and the score weights settled before go-live. I'd like to see them at the cycle demo."],
  ["m_mgt_2", "ch-mgmt", "ACV-0003", 1980, "Will do. I'll set both in Settings after the demo, and bring the leave policy and the final employee list."],
  ["m_mgt_3", "ch-mgmt", "ACV-0004", 400, "Security check against the OWASP list is scheduled for cycle 4."],
  // #go-live
  ["m_gl_1", "ch-golive", "ACV-0004", 1700, "Go-live checklist is attached. Each row has a name in column C. Please update your rows by Friday.", { attachments: [pdf("att_m3", "go-live-checklist.xlsx", 64_000, "ACV-0004", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")] }],
  ["m_gl_2", "ch-golive", "ACV-0003", 800, "Employee list for go-live is 90% done. Waiting on two CNIC copies."],
  ["m_gl_2r1", "ch-golive", "ACV-0004", 780, "Thanks Bilal. Can we import the rest on Monday?", { parentId: "m_gl_2" }],
  ["m_gl_2r2", "ch-golive", "ACV-0003", 760, "Yes, Monday morning.", { parentId: "m_gl_2" }],
  ["m_gl_3", "ch-golive", "ACV-0010", 90, "Opening balances are entered in the ledger and waiting for Bilal's approval. I'll tick that row once he approves."],
  // #harbor-and-co
  ["m_hb_1", "ch-harbor", "ACV-0011", 1100, "Wireframes for the product page and checkout.", { attachments: [pdf("att_m4", "harbor-wireframes.pdf", 2_400_000, "ACV-0011")] }],
  ["m_hb_2", "ch-harbor", "ACV-0009", 1000, "The client loved the checkout. They asked if the loyalty points can show on the cart page."],
  ["m_hb_3", "ch-harbor", "ACV-0008", 200, "Possible, but it needs a new API from their side. Adding a task.", { linkedTaskId: "tsk_6" }],
  // DM Mariam and Omar (CTO)
  ["m_d1_1", "dm-07-04", "ACV-0007", 400, "Hi Omar, the balances API isn't ready yet. OK if I use mock data for the widget?"],
  ["m_d1_2", "dm-07-04", "ACV-0004", 380, "Yes, mock is fine. Switch once M7 lands."],
  ["m_d1_3", "dm-07-04", "ACV-0004", 25, "Also, nice work on the org chart. Hamza liked it at the demo.", { reactions: [{ emoji: "🙏", empIds: ["ACV-0007"] }] }],
  // DM Mariam and Nida
  ["m_d2_1", "dm-07-13", "ACV-0013", 35, "Hi Mariam! Omar said you could help me with the check-in card. Is now a good time?"],
  // DM Fahad and Omar (CTO)
  ["m_d3_1", "dm-06-04", "ACV-0006", 520, "I'll start the deployment checklist review after the Harbor demo. Is Thursday OK?"],
  ["m_d3_2", "dm-06-04", "ACV-0004", 505, "Thursday is fine. Flag anything that blocks go-live."],
  // DM Omar (CTO) and Bilal (Director)
  ["m_d4_1", "dm-04-03", "ACV-0004", 500, "Sprint plan for cycle 3 is in the task for your review. Ali was over 40 hours, so I moved the shipping rules task to next week."],
  ["m_d4_2", "dm-04-03", "ACV-0003", 480, "Makes sense. I'll review it this afternoon."],
  // DM Hira and Bilal (Director, sales manager)
  ["m_d5_1", "dm-09-03", "ACV-0009", 70, "Harbor & Co want a proposal by Thursday. Can you review my draft tomorrow?"],
  ["m_d5_2", "dm-09-03", "ACV-0003", 64, "Sure, send it over in the morning."],
  // DM Hira (Sales) and Sana (Finance)
  ["m_d7_1", "dm-09-10", "ACV-0009", 150, "Hi Sana, if Harbor & Co sign the proposal, they'll want an invoice for the 30% deposit straight away."],
  ["m_d7_2", "dm-09-10", "ACV-0010", 140, "No problem. Send me the signed proposal once Bilal confirms the deal and I'll raise the invoice the same day."],
  // DM Bilal (Director) and Hamza (CEO / Founder / Owner: sees everything, signs nothing)
  ["m_d6_1", "dm-03-01", "ACV-0001", 2100, "Bilal, before go-live: how will I see the large ledger entries?"],
  ["m_d6_2", "dm-03-01", "ACV-0003", 2080, "Sana makes every entry and I approve it, whatever the amount. Anything above PKR 500,000 and every capital or loan entry is marked \"CEO / Founder / Owner notified\", so you'll see it on your Home and in the ledger."],
  ["m_d6_3", "dm-03-01", "ACV-0001", 2060, "Good. I want to see them, not sign them."],
  ["m_d6_4", "dm-03-01", "ACV-0003", 700, "October reconciliation is done. Sana found two missing lines and entered them; I'm approving them today."],
  ["m_d6_5", "dm-03-01", "ACV-0003", 95, "November payroll is prepared by Sana and waiting for my approval. You can open the run any time under Payroll."],
  ["m_d6_6", "dm-03-01", "ACV-0001", 80, "Thanks. I'll look through it tonight."],
  // Group: Payslip layout review (Finance asks, Engineering builds; real pay figures stay with Finance)
  ["m_g1_1", "grp-payslip", "ACV-0010", 260, "Could every payslip show YTD totals? People keep asking me for them.", { attachments: [pdf("att_m5", "payslip-layout-v3.pdf", 310_000, "ACV-0010")] }],
  ["m_g1_2", "grp-payslip", "ACV-0011", 240, "Got it, I'll add a YTD column. That's why I asked for the extension.", { linkedTaskId: "tsk_12" }],
  ["m_g1_3", "grp-payslip", "ACV-0004", 200, "Fine by me. Danish, build it with the sample figures in the attachment; real pay data stays with Finance."],
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
  const online = ["ACV-0006", "ACV-0004", "ACV-0013", "ACV-0003", "ACV-0009", "ACV-0010", "ACV-0014", "ACV-0011"];
  const away = ["ACV-0001", "ACV-0008"];
  return EMPLOYEES.map((e, i) => ({
    empId: e.empId,
    state: online.includes(e.empId) ? "online" : away.includes(e.empId) ? "away" : "offline",
    lastSeenAt: online.includes(e.empId) ? minutesAgo(1) : minutesAgo(20 + i * 37),
  }));
}

export function seedAnnouncements(): Announcement[] {
  return [
    {
      id: "an1", title: "Go-live on Monday 30 November", author: "ACV-0001", pinned: true, requiresAck: true, at: daysFromNow(-2, "10:00"),
      audience: { all: true, departmentIds: [] },
      body: "From 30 November, tasks, attendance, leave, tracking and finance entries are recorded in the Aceva Digital System. On go-live day you'll get your Emp-ID and a temporary password by email. The first login asks you to set a new password and accept the tracking policy.\n\nThe whole team is available for five working days after go-live to fix problems quickly.",
      ackEmpIds: ["ACV-0001", "ACV-0003", "ACV-0004", "ACV-0006", "ACV-0010", "ACV-0011"],
    },
    {
      id: "an2", title: "What the system records (tracking policy)", author: "ACV-0003", pinned: true, requiresAck: true, at: daysFromNow(-3, "09:30"),
      audience: { all: true, departmentIds: [] },
      body: "We record logins, active and idle time inside the app, screens you open and changes you make. We never record your screen, keystrokes, camera, email text or personal accounts. You can see your own history any time under Activity.",
      ackEmpIds: ["ACV-0001", "ACV-0003", "ACV-0004", "ACV-0006", "ACV-0007", "ACV-0008", "ACV-0010", "ACV-0011", "ACV-0014"],
    },
    {
      id: "an3", title: "Office closed for Iqbal Day", author: "ACV-0003", pinned: false, requiresAck: false, at: daysFromNow(-4, "16:00"),
      audience: { all: true, departmentIds: [] }, body: "The office is closed on 9 November for Iqbal Day. Task deadlines skip public holidays automatically.", ackEmpIds: [],
    },
    {
      id: "an4", title: "Sales modules arrive in Phase 2 (15 December)", author: "ACV-0003", pinned: false, requiresAck: true, at: daysFromNow(-1, "12:00"),
      audience: { all: false, departmentIds: ["dep-sales"] },
      body: "Leads, pipeline and the daily sales report move into the system on 15 December. Apollo and MillionVerifier counts will arrive automatically; LinkedIn, WhatsApp and Fiverr go in the 2-minute daily log.",
      ackEmpIds: ["ACV-0014"],
    },
    {
      id: "an5", title: "Month close: expense receipts by 3 December", author: "ACV-0003", pinned: false, requiresAck: false, at: daysFromNow(-6, "11:00"),
      audience: { all: true, departmentIds: [] }, body: "Please send all November expense receipts and reimbursement claims to Sana Malik (Finance) by 3 December. Sana records them and runs the month close, and I approve it, so the month can close on time.", ackEmpIds: [],
    },
    {
      id: "an6", title: "Cycle 1 demo: thank you", author: "ACV-0004", pinned: false, requiresAck: false, at: daysFromNow(-8, "18:10"),
      audience: { all: false, departmentIds: ["dep-eng"] }, body: "Great demo of access control, login and profiles. Bilal signed off cycle 1 as Director. Next: activity tracking, tasks and performance.", ackEmpIds: [],
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
    m("mtg1", "Engineering check-in", workdaysFromNow(1, "09:15"), 15, "ACV-0004", ["ACV-0007", "ACV-0008", "ACV-0011", "ACV-0013", "ACV-0006"], "1. Yesterday\n2. Today\n3. Anything blocking", { location: "Online (Google Meet)" }),
    m("mtg2", "Payslip layout review", workdaysFromNow(1, "14:00"), 30, "ACV-0010", ["ACV-0011", "ACV-0004"], "1. YTD totals column\n2. Deductions order\n3. Layout ready for the November run", { linkedTaskIds: ["tsk_12"], attachments: [{ id: "ma1", fileName: "payslip-layout-v3.pdf", sizeBytes: 310_000, mimeType: "application/pdf", uploadedAt: minutesAgo(260), uploadedBy: "ACV-0010" }] }),
    m("mtg3", "1:1 Omar and Mariam", workdaysFromNow(2, "12:00"), 30, "ACV-0004", ["ACV-0007"], "Progress on the leave widget, the rework on the working-day tests, and goals for December.", { linkedTaskIds: ["tsk_1", "tsk_5"], location: "Online (Google Meet)" }),
    m("mtg4", "Cycle demo to management", workdaysFromNow(2, "16:00"), 60, "ACV-0004", ["ACV-0001", "ACV-0003", "ACV-0006", "ACV-0007", "ACV-0011"], "Demo of activity tracking, task management and performance. For the Director to decide afterwards: score weights and working hours."),
    m("mtg5", "Sales pipeline review", workdaysFromNow(3, "11:00"), 45, "ACV-0003", ["ACV-0009", "ACV-0012", "ACV-0014"], "1. Deals stuck in Proposal sent\n2. Bounce rates per mailbox\n3. Targets for next week", { location: "Online (Google Meet)" }),
    m("mtg6", "Harbor & Co kickoff", workdaysFromNow(4, "15:00"), 60, "ACV-0004", ["ACV-0008", "ACV-0011", "ACV-0009", "ACV-0006"], "Scope of milestone 1, the loyalty points question, and the delivery dates.", { linkedTaskIds: ["tsk_6"], location: "Online (Zoom) with the client" }),
    m("mtg7", "Go-live readiness", workdaysFromNow(5, "10:00"), 60, "ACV-0004", ["ACV-0003", "ACV-0006", "ACV-0007", "ACV-0001", "ACV-0010"], "Walk through the go-live checklist row by row. Opening balances status. Backup and restore test result. Training dates."),
    m("mtg8", "Tracking policy walkthrough", workdaysFromNow(-1, "11:00"), 45, "ACV-0003", ["ACV-0001", "ACV-0004"], "Read through the policy wording before it goes to everyone.", {
      notes: "Agreed: no GPS, city only. Sales tools are named in the policy. Bilal sends the final text to everyone; acknowledgement required.",
      notesUpdatedAt: workdaysFromNow(-1, "12:00"),
    }),
    m("mtg9", "Cycle 3 planning", workdaysFromNow(-2, "10:00"), 60, "ACV-0004", ["ACV-0006", "ACV-0003", "ACV-0010"], "Attendance, payroll and ledger: API contracts and test data.", {
      notes: "Chart of accounts prepared by Sana (Finance) and approved by Bilal. Payroll needs the tax slabs before day 1 of the cycle.",
      notesUpdatedAt: workdaysFromNow(-2, "11:15"),
    }),
    m("mtg10", "November close plan", workdaysFromNow(3, "15:00"), 30, "ACV-0010", ["ACV-0003"], "1. Receipts still missing\n2. Bank reconciliation\n3. Close run by Finance, then the Director's approval"),
  ];
}
