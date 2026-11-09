/**
 * Seed: Module 15 Sales and CRM. Prospects are made up; UK/US/UAE/Pakistan companies.
 * Owners: ACV-0009 Hira Baig, ACV-0012 Kamran Javed (sales lead ACV-0014 Saad Mirza).
 */
import type {
  ActivityKind, ActivitySource, CommissionLine, CommissionRule, Company, DailySalesSummary, DailyTargets, Deal, DealService, DealStage,
  DncEntry, EmailCheck, Lead, LeadSource, ManualDailyLog, MonthlyTargets, SalesActivity,
} from "@/features/sales/types";
import { daysFromNow, minutesAgo, monthFromNow, workdaysFromNow } from "../time";

const C: [key: string, name: string, website: string, country: string, industry: string][] = [
  ["harbor", "Harbor & Co", "harborandco.co.uk", "United Kingdom", "Retail"],
  ["northwind", "Northwind Studio", "northwindstudio.co.uk", "United Kingdom", "Design agency"],
  ["kestrel", "Kestrel Dental", "kestreldental.co.uk", "United Kingdom", "Healthcare"],
  ["bramble", "Bramble & Oak", "brambleoak.com", "United Kingdom", "Furniture"],
  ["mersey", "Mersey Logistics", "merseylogistics.co.uk", "United Kingdom", "Logistics"],
  ["pennine", "Pennine Fitness", "penninefitness.co.uk", "United Kingdom", "Fitness"],
  ["lakeview", "Lakeview Realty", "lakeviewrealty.com", "United States", "Real estate"],
  ["summit", "Summit Legal Group", "summitlegalgroup.com", "United States", "Legal"],
  ["coral", "Coral Bay Cafe", "coralbaycafe.com", "United States", "Food and drink"],
  ["atlas", "Atlas Freight", "atlasfreight.us", "United States", "Logistics"],
  ["bluebird", "Bluebird Tutors", "bluebirdtutors.com", "United States", "Education"],
  ["redwood", "Redwood Clinics", "redwoodclinics.com", "United States", "Healthcare"],
  ["desertrose", "Desert Rose Interiors", "desertrose.ae", "United Arab Emirates", "Interior design"],
  ["gulfline", "Gulf Line Trading", "gulflinetrading.ae", "United Arab Emirates", "Trading"],
  ["palmtech", "Palm Tech FZE", "palmtech.ae", "United Arab Emirates", "Technology"],
  ["brightpath", "Bright Path Academy", "brightpath.edu.pk", "Pakistan", "Education"],
  ["indus", "Indus Textiles", "industextiles.pk", "Pakistan", "Manufacturing"],
  ["karachibites", "Karachi Bites", "karachibites.pk", "Pakistan", "Food and drink"],
  ["sukkur", "Sukkur Agro", "sukkuragro.pk", "Pakistan", "Agriculture"],
  ["hydmotors", "Hyderabad Motors", "hydmotors.pk", "Pakistan", "Automotive"],
  ["olive", "Olive & Thyme", "oliveandthyme.co.uk", "United Kingdom", "Restaurants"],
  ["granite", "Granite Peak Roofing", "granitepeakroofing.com", "United States", "Construction"],
  ["thistle", "Thistle Accounting", "thistleaccounting.co.uk", "United Kingdom", "Accounting"],
  ["quarry", "Quarry Labs", "quarrylabs.io", "United States", "Software"],
  ["willow", "Willow Bakery", "willowbakery.co.uk", "United Kingdom", "Food and drink"],
  ["rohi", "Rohi Crafts", "rohicrafts.pk", "Pakistan", "Handicrafts"],
  ["lyceum", "Lyceum Schools", "lyceumschools.pk", "Pakistan", "Education"],
  ["emirateshaul", "Emirates Haul", "emirateshaul.ae", "United Arab Emirates", "Logistics"],
  ["bayside", "Bayside Vets", "baysidevets.com", "United States", "Veterinary"],
  ["clarkesons", "Clarke & Sons Builders", "clarkesons.co.uk", "United Kingdom", "Construction"],
];

export function seedCompanies(): Company[] {
  return C.map(([key, name, website, country, industry]) => ({ id: `co_${key}`, name, website: `https://${website}`, domain: website, country, industry }));
}

type LeadRow = [name: string, title: string, company: string, source: LeadSource, owner: string, check: EmailCheck, createdDaysAgo: number, extra?: Partial<Lead>];

const L: LeadRow[] = [
  ["Olivia Grant", "Founder", "harbor", "apollo", "ACV-0009", "valid", 40, { notes: "Wants a Shopify-like store with UK shipping rules. Budget approved by her partner." }],
  ["James Whitaker", "Creative Director", "northwind", "referral", "ACV-0009", "valid", 90, { notes: "Referred by Harbor & Co. Very responsive on WhatsApp." }],
  ["Grace Holloway", "Practice Manager", "kestrel", "apollo", "ACV-0009", "valid", 12],
  ["Henry Blake", "Owner", "bramble", "apollo", "ACV-0009", "catch_all", 8],
  ["Chloe Evans", "Operations Director", "mersey", "apollo", "ACV-0012", "valid", 20, { notes: "Needs a driver dispatch tool. Current system is spreadsheets." }],
  ["Ryan Patel", "General Manager", "pennine", "linkedin", "ACV-0012", "valid", 15],
  ["Daniel Price", "Broker", "lakeview", "apollo", "ACV-0009", "valid", 25],
  ["Sarah Mitchell", "Managing Partner", "summit", "apollo", "ACV-0012", "valid", 30],
  ["Emily Carter", "Owner", "coral", "fiverr", "ACV-0009", "valid", 120],
  ["Michael Torres", "Logistics Manager", "atlas", "apollo", "ACV-0012", "invalid", 18],
  ["Ava Johnson", "Founder", "bluebird", "website", "ACV-0012", "valid", 22],
  ["Noah Williams", "Practice Administrator", "redwood", "apollo", "ACV-0009", "unknown", 5],
  ["Layla Haddad", "Design Lead", "desertrose", "linkedin", "ACV-0009", "valid", 33],
  ["Omar Al Mansoori", "Head of Purchasing", "gulfline", "referral", "ACV-0012", "valid", 45, { notes: "Signed after the second demo. Wants Arabic and English storefront." }],
  ["Fatima Al Nuaimi", "COO", "palmtech", "linkedin", "ACV-0012", "unchecked", 2],
  ["Asad Rehman", "Principal", "brightpath", "walk_in", "ACV-0009", "valid", 200, { notes: "Existing client (LMS). Phase 2 covers parent app and fee reminders." }],
  ["Kashif Mehmood", "IT Manager", "indus", "field", "ACV-0012", "valid", 150],
  ["Sana Javed", "Owner", "karachibites", "fiverr", "ACV-0009", "valid", 30],
  ["Imran Soomro", "Director", "sukkur", "field", "ACV-0012", "unknown", 6],
  ["Bilal Chandio", "Sales Manager", "hydmotors", "walk_in", "ACV-0012", "valid", 9],
  ["Charlotte Hughes", "Marketing Lead", "olive", "apollo", "ACV-0009", "valid", 3],
  ["Ethan Brooks", "Owner", "granite", "apollo", "ACV-0012", "valid", 4],
  ["Lucy Adams", "Office Manager", "thistle", "apollo", "ACV-0009", "valid", 11],
  ["Benjamin Scott", "CTO", "quarry", "apollo", "ACV-0009", "valid", 7, { doNotContact: true }],
  ["Hannah Lewis", "Owner", "willow", "fiverr", "ACV-0012", "catch_all", 11],
  ["Zain Abbasi", "Founder", "rohi", "linkedin", "ACV-0009", "valid", 14],
  ["Mariam Qazi", "Head of Admissions", "lyceum", "referral", "ACV-0012", "valid", 35],
  ["Khalid Rahman", "Fleet Manager", "emirateshaul", "apollo", "ACV-0009", "invalid", 16],
  ["Jessica Moore", "Practice Owner", "bayside", "apollo", "ACV-0012", "unchecked", 1],
  ["Peter Clarke", "Director", "clarkesons", "apollo", "ACV-0009", "unchecked", 0],
];

function emailFor(name: string, domain: string) {
  return `${name.split(" ")[0].toLowerCase()}@${domain}`;
}

export function seedLeads(): Lead[] {
  return L.map(([name, title, ck, source, owner, check, ago, extra], i) => {
    const co = C.find((c) => c[0] === ck)!;
    return {
      id: `ld_${i + 1}`,
      name,
      title,
      companyId: `co_${ck}`,
      email: emailFor(name, co[2]),
      phone: co[3] === "Pakistan" ? `+92 3${i % 5}${i % 10} ${String(4100000 + i * 7919).slice(0, 7)}` : co[3] === "United Arab Emirates" ? `+971 50 ${String(3100000 + i * 6271).slice(0, 7)}` : co[3] === "United States" ? `+1 (415) 555-${String(1000 + i * 37).slice(0, 4)}` : `+44 20 7946 ${String(1000 + i * 41).slice(0, 4)}`,
      linkedinUrl: source === "linkedin" || i % 3 === 0 ? `linkedin.com/in/${name.toLowerCase().replace(/\s+/g, "-")}` : undefined,
      country: co[3],
      industry: co[4],
      source,
      ownerEmpId: owner,
      emailCheck: check,
      checkedAt: check === "unchecked" ? undefined : daysFromNow(-ago, "10:15"),
      doNotContact: false,
      archived: false,
      createdAt: daysFromNow(-ago, ago === 0 ? "09:40" : "10:05"),
      lastActivityAt: daysFromNow(-Math.min(ago, 2), "16:20"),
      ...extra,
    };
  });
}

type DealRow = [num: number, lead: number, service: DealService, amount: number, currency: "USD" | "PKR", stage: DealStage, nextStep: string | null, nextStepDays: number | null, createdDaysAgo: number, extra?: Partial<Deal>];

const D: DealRow[] = [
  [4, 9, "website", 2400, "USD", "won", null, null, 75, { wonStatus: "confirmed", wonConfirmedBy: "ACV-0014", handover: { clientName: "Coral Bay Cafe", invoiceNumber: "INV-2026-0031", ctoNotified: true, at: daysFromNow(-60, "15:00") } }],
  [7, 17, "custom_software", 1850000, "PKR", "won", null, null, 70, { wonStatus: "confirmed", wonConfirmedBy: "ACV-0014", handover: { clientName: "Indus Textiles", invoiceNumber: "INV-2026-0036", ctoNotified: true, at: daysFromNow(-45, "12:30") } }],
  [12, 2, "website", 4800, "USD", "won", null, null, 40, { wonStatus: "confirmed", wonConfirmedBy: "ACV-0014", handover: { clientName: "Northwind Studio", invoiceNumber: "INV-2026-0045", ctoNotified: true, at: daysFromNow(-12, "11:10") } }],
  [19, 14, "ecommerce", 7500, "USD", "won", null, null, 30, { wonStatus: "pending", wonRequestedAt: minutesAgo(48), previousStage: "negotiation" }],
  [20, 1, "ecommerce", 9000, "USD", "replied", "Book a discovery call for Thursday", 0, 21],
  [21, 3, "website", 3200, "USD", "contacted", "Send the second follow-up email", 0, 10],
  [22, 4, "ecommerce", 6500, "USD", "new", "Send the first email from the Apollo sequence", 1, 7],
  [23, 5, "custom_software", 12000, "USD", "meeting_booked", "Discovery call with Chloe and the dispatch team", 2, 18],
  [24, 6, "mobile_app", 8000, "USD", "proposal_sent", "Chase the proposal", -1, 14],
  [25, 7, "website", 3800, "USD", "negotiation", "Send a revised quote with the blog removed", 0, 24],
  [26, 8, "ai_automation", 15000, "USD", "contacted", "Second email with the legal intake case study", -2, 28],
  [27, 11, "website", 2600, "USD", "replied", "Share three portfolio links", 0, 20],
  [28, 13, "website", 5200, "USD", "meeting_booked", "Video call to review the mood board", 1, 30],
  [29, 16, "custom_software", 2400000, "PKR", "proposal_sent", "Call the principal about phase 2 scope", 3, 25],
  [30, 18, "mobile_app", 950000, "PKR", "lost", null, null, 30, { lostReason: "Price", recontactAfter: daysFromNow(160) }],
  [31, 10, "ai_automation", 6000, "USD", "lost", null, null, 17, { lostReason: "No reply", recontactAfter: daysFromNow(170) }],
  [32, 20, "website", 600000, "PKR", "new", "Visit the showroom with a demo", null, 8],
  [33, 21, "website", 2900, "USD", "new", "Send the first email from the Apollo sequence", 0, 3],
];

export function seedDeals(): Deal[] {
  const leads = seedLeads();
  return D.map(([num, leadIdx, service, amount, currency, stage, nextStep, nsDays, ago, extra]) => {
    const lead = leads[leadIdx - 1];
    const order = ["new", "contacted", "replied", "meeting_booked", "proposal_sent", "negotiation", "won"] as DealStage[];
    const upto = stage === "lost" ? 2 : order.indexOf(stage === "won" && extra?.wonStatus === "pending" ? "negotiation" : stage);
    const history = order.slice(0, upto + 1).map((s, i) => ({
      stage: s,
      at: daysFromNow(-ago + Math.round((i * ago) / (upto + 2)), "11:00"),
      by: lead.ownerEmpId,
      note: s === "won" ? "Confirmed by the sales manager" : undefined,
    }));
    if (stage === "lost") history.push({ stage: "lost", at: daysFromNow(-Math.round(ago / 3), "15:00"), by: lead.ownerEmpId, note: extra?.lostReason });
    if (stage === "won" && extra?.wonStatus === "pending") history.push({ stage: "won", at: minutesAgo(48), by: lead.ownerEmpId, note: "Waiting for manager confirmation" });
    return {
      id: `dl_${num}`,
      number: `DL-${String(num).padStart(4, "0")}`,
      leadId: lead.id,
      companyId: lead.companyId,
      service,
      value: { amount: amount.toFixed(2), currency },
      expectedClose: daysFromNow(stage === "won" || stage === "lost" ? -Math.round(ago / 3) : 10 + (num % 5) * 7),
      stage,
      nextStep: nextStep ?? undefined,
      nextStepDate: nsDays === null ? undefined : nsDays === 0 ? daysFromNow(0, "15:00") : workdaysFromNow(nsDays, "12:00"),
      ownerEmpId: lead.ownerEmpId,
      proposalUrl: ["proposal_sent", "negotiation", "won"].includes(stage) ? `https://drive.acevatech.com/proposals/DL-${String(num).padStart(4, "0")}.pdf` : undefined,
      history,
      createdAt: daysFromNow(-ago, "11:00"),
      updatedAt: minutesAgo(60 + num * 13),
      ...extra,
    };
  });
}

/* ---------------- Activities (timeline) ---------------- */

const act = (id: string, leadId: string, empId: string, kind: ActivityKind, source: ActivitySource, at: string, summary: string, dealId?: string): SalesActivity => ({
  id,
  leadId,
  dealId,
  empId,
  kind,
  source,
  at,
  summary,
  externalId: source === "manual" ? undefined : `${source}-${id}`,
});

export function seedActivities(): SalesActivity[] {
  const leads = seedLeads();
  const deals = seedDeals();
  const out: SalesActivity[] = [];
  let n = 0;
  const id = () => `sa_${++n}`;
  leads.forEach((l, i) => {
    const ago = Math.max(0, Math.round((Date.now() - new Date(l.createdAt).getTime()) / 86_400_000));
    if (l.emailCheck !== "unchecked")
      out.push(act(id(), l.id, l.ownerEmpId, "email_check", "millionverifier", daysFromNow(-ago, "10:15"), `Email checked: ${l.emailCheck.replace("_", "-")}`));
    const deal = deals.find((d) => d.leadId === l.id);
    const stageIdx = deal ? ["new", "contacted", "replied", "meeting_booked", "proposal_sent", "negotiation", "won"].indexOf(deal.stage === "lost" ? "replied" : deal.stage) : i % 3 === 0 ? 1 : 0;
    if (stageIdx >= 1) out.push(act(id(), l.id, l.ownerEmpId, "email_sent", "apollo", daysFromNow(-ago + 1, "09:30"), "Step 1 of the “UK small business” sequence", deal?.id));
    if (stageIdx >= 1 && i % 2 === 0) out.push(act(id(), l.id, l.ownerEmpId, "linkedin", "manual", daysFromNow(-ago + 1, "13:05"), "Connection request with a short note", deal?.id));
    if (stageIdx >= 2) out.push(act(id(), l.id, l.ownerEmpId, "reply", "apollo", daysFromNow(-Math.max(1, ago - 3), "14:22"), "“Sounds interesting, what would this cost?”", deal?.id));
    if (stageIdx >= 3) out.push(act(id(), l.id, l.ownerEmpId, "meeting", "manual", daysFromNow(-Math.max(1, ago - 6), "16:00"), "30-minute discovery call on Google Meet", deal?.id));
    if (stageIdx >= 4) out.push(act(id(), l.id, l.ownerEmpId, "proposal", "manual", daysFromNow(-Math.max(1, ago - 9), "12:00"), "Proposal and scope sent (PDF)", deal?.id));
    if (stageIdx >= 5) out.push(act(id(), l.id, l.ownerEmpId, "call", "manual", daysFromNow(-Math.max(1, ago - 12), "17:10"), "Price discussion: asked for a phased payment plan", deal?.id));
    if (stageIdx >= 6) out.push(act(id(), l.id, l.ownerEmpId, "note", "manual", daysFromNow(-Math.max(1, ago - 14), "18:00"), "Client agreed. Contract sent for signature.", deal?.id));
    if (l.emailCheck === "invalid") out.push(act(id(), l.id, l.ownerEmpId, "bounce", "apollo", daysFromNow(-ago + 1, "09:42"), "Hard bounce: mailbox does not exist"));
  });
  // New replies today (from Apollo, shown on "My sales day").
  const reply = (leadIdx: number, dealNum: number | undefined, min: number, text: string) => {
    const l = leads[leadIdx - 1];
    out.push(act(id(), l.id, l.ownerEmpId, "reply", "apollo", minutesAgo(min), text, dealNum ? `dl_${dealNum}` : undefined));
  };
  reply(1, 20, 12, "“Thanks Hira, can we talk on Thursday?”");
  reply(7, 25, 70, "“If you can drop the blog section we have a deal.”");
  reply(13, 28, 185, "“Tomorrow at 3 pm Dubai time works.”");
  reply(11, 27, 40, "“Could you share a few sites you have built for tutors?”");
  reply(5, 23, 125, "“Confirmed for the call. I'll bring our dispatch lead.”");
  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/* ---------------- Targets, daily summaries and manual logs ---------------- */

export const SALES_PEOPLE = ["ACV-0009", "ACV-0012"];

export function seedDailyTargets(): DailyTargets[] {
  return [
    { empId: "ACV-0009", leadsAdded: 40, emailsChecked: 40, emailsSent: 30, followUps: 8 },
    { empId: "ACV-0012", leadsAdded: 35, emailsChecked: 35, emailsSent: 30, followUps: 6 },
  ];
}

export function seedMonthlyTargets(): MonthlyTargets[] {
  const m = monthFromNow(0);
  return [
    { empId: "ACV-0009", month: m, meetings: 8, proposals: 5, wonValue: { amount: "6000.00", currency: "USD" } },
    { empId: "ACV-0012", month: m, meetings: 6, proposals: 4, wonValue: { amount: "5000.00", currency: "USD" } },
  ];
}

function rng(seed: number) {
  let s = seed;
  return () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
}

function iso(d: string) {
  const x = new Date(d);
  return `${x.getFullYear()}-${String(x.getMonth() + 1).padStart(2, "0")}-${String(x.getDate()).padStart(2, "0")}`;
}

/** Last 10 working days + today's live record for each salesperson. Logs mirror the self-reported counts. */
export function seedSummariesAndLogs(): { summaries: DailySalesSummary[]; logs: ManualDailyLog[] } {
  const summaries: DailySalesSummary[] = [];
  const logs: ManualDailyLog[] = [];
  const targets = seedDailyTargets();
  SALES_PEOPLE.forEach((empId, p) => {
    const t = targets.find((x) => x.empId === empId)!;
    const r = rng(17 + p * 101);
    for (let wd = 10; wd >= 1; wd--) {
      const date = iso(workdaysFromNow(-wd));
      const strong = r() > 0.35;
      const f = (target: number) => Math.max(0, Math.round(target * (strong ? 0.98 + r() * 0.3 : 0.6 + r() * 0.35)));
      const sent = f(t.emailsSent);
      const self = { linkedin: Math.round(r() * 6), whatsapp: Math.round(r() * 4), fiverr: p === 0 ? Math.round(r() * 2) : 0, calls: Math.round(r() * 3), fieldVisits: p === 1 && r() > 0.7 ? 1 : 0 };
      const proof = wd === 3 && p === 1;
      summaries.push({
        id: `ds_${empId}_${date}`,
        empId,
        date,
        leadsAdded: { auto: Math.round(f(t.leadsAdded) * 0.85), manual: Math.round(f(t.leadsAdded) * 0.15) },
        emailsChecked: f(t.emailsChecked),
        invalid: Math.round(r() * 4),
        emailsSent: { apollo: Math.round(sent * 0.93), mailbox: sent - Math.round(sent * 0.93) },
        replies: Math.round(r() * 4),
        bounces: Math.round(r() * 2),
        meetings: r() > 0.7 ? 1 : 0,
        followUps: { auto: Math.round(f(t.followUps) * 0.4), manual: Math.round(f(t.followUps) * 0.6) },
        selfReported: self,
        proofRequested: proof,
      });
      logs.push({ id: `log_${empId}_${date}`, empId, date, ...self, note: wd === 2 ? "Two walk-in inquiries at the Karachi expo stand." : undefined, proofRequested: proof, submittedAt: workdaysFromNow(-wd, "17:52") });
    }
    // Today (live, updated by each sync)
    const today = iso(new Date().toISOString());
    summaries.push(
      p === 0
        ? { id: `ds_${empId}_${today}`, empId, date: today, leadsAdded: { auto: 31, manual: 3 }, emailsChecked: 36, invalid: 3, emailsSent: { apollo: 33, mailbox: 2 }, replies: 3, bounces: 1, meetings: 1, followUps: { auto: 2, manual: 3 }, selfReported: { linkedin: 0, whatsapp: 0, fiverr: 0, calls: 0, fieldVisits: 0 } }
        : { id: `ds_${empId}_${today}`, empId, date: today, leadsAdded: { auto: 28, manual: 2 }, emailsChecked: 30, invalid: 2, emailsSent: { apollo: 27, mailbox: 1 }, replies: 2, bounces: 2, meetings: 0, followUps: { auto: 1, manual: 2 }, selfReported: { linkedin: 0, whatsapp: 0, fiverr: 0, calls: 0, fieldVisits: 0 } },
    );
  });
  return { summaries, logs };
}

/* ---------------- Commission and do-not-contact ---------------- */

export function seedCommissionRules(): CommissionRule[] {
  return [{ id: "cr_1", name: "First payment commission", ratePercent: 5, effectiveFrom: "2026-10-01", setBy: "ACV-0003", active: true }];
}

export function seedCommissionLines(): CommissionLine[] {
  return [
    { id: "cl_1", dealId: "dl_12", dealNumber: "DL-0012", empId: "ACV-0009", invoiceNumber: "INV-2026-0045", invoicePaidAt: daysFromNow(-2, "14:30"), base: { amount: "2400.00", currency: "USD" }, ratePercent: 5, amount: { amount: "120.00", currency: "USD" }, status: "calculated" },
    { id: "cl_2", dealId: "dl_4", dealNumber: "DL-0004", empId: "ACV-0009", invoiceNumber: "INV-2026-0031", invoicePaidAt: daysFromNow(-50, "11:00"), base: { amount: "1200.00", currency: "USD" }, ratePercent: 5, amount: { amount: "60.00", currency: "USD" }, status: "sent_to_payroll", approvedBy: "ACV-0003", approvedAt: daysFromNow(-48, "10:00"), payrollMonth: monthFromNow(-1) },
    { id: "cl_3", dealId: "dl_7", dealNumber: "DL-0007", empId: "ACV-0012", invoiceNumber: "INV-2026-0036", invoicePaidAt: daysFromNow(-38, "16:00"), base: { amount: "925000.00", currency: "PKR" }, ratePercent: 5, amount: { amount: "46250.00", currency: "PKR" }, status: "sent_to_payroll", approvedBy: "ACV-0003", approvedAt: daysFromNow(-37, "10:00"), payrollMonth: monthFromNow(-1) },
  ];
}

export function seedDnc(): DncEntry[] {
  return [
    { id: "dnc_1", email: "benjamin@quarrylabs.io", leadId: "ld_24", reason: "Unsubscribed from an Apollo sequence", addedBy: "ACV-0009", at: daysFromNow(-5, "10:20") },
    { id: "dnc_2", email: "accounts@willowbakery.co.uk", reason: "Asked by phone not to be contacted again", addedBy: "ACV-0012", at: daysFromNow(-19, "15:45") },
    { id: "dnc_3", email: "info@brightsmile.co.uk", reason: "Complaint about cold email, removed under UK GDPR", addedBy: "ACV-0014", at: daysFromNow(-33, "12:00") },
  ];
}

/** Previous month's sales scorecard inputs (the current month is calculated live). */
export const PREVIOUS_MONTH_SCORE: Record<string, { activity: number; meetings: number; won: number; dataQuality: number; attendance: number }> = {
  "ACV-0009": { activity: 82, meetings: 88, won: 100, dataQuality: 90, attendance: 95 },
  "ACV-0012": { activity: 70, meetings: 67, won: 37, dataQuality: 80, attendance: 91 },
};
