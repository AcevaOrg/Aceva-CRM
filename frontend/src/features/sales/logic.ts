/**
 * Pure sales rules (plan §20). Mirrored on the server; unit-test these.
 */
import type { BadgeTone } from "@/components/ui/badge";
import type { Money } from "@/types";
import type {
  ActivityKind, Company, DailySalesSummary, DailyTargets, DealService, DealStage, DuplicateResult, EmailCheck, Lead, LeadSource, SalesWeights,
} from "./types";

/** Exchange rate saved in Settings (mock). Every entry keeps its own rate in the real system. */
export const USD_PKR = 280.5;

export const STAGES: DealStage[] = ["new", "contacted", "replied", "meeting_booked", "proposal_sent", "negotiation", "won", "lost"];
export const OPEN_STAGES: DealStage[] = ["new", "contacted", "replied", "meeting_booked", "proposal_sent", "negotiation"];

export const STAGE_META: Record<DealStage, { label: string; meaning: string; color: string; tone: BadgeTone }> = {
  new: { label: "New", meaning: "Lead added and email checked, not contacted yet", color: "var(--muted-foreground)", tone: "neutral" },
  contacted: { label: "Contacted", meaning: "First email, call or message sent", color: "var(--chart-5)", tone: "control" },
  replied: { label: "Replied", meaning: "The lead answered", color: "var(--chart-2)", tone: "work" },
  meeting_booked: { label: "Meeting booked", meaning: "A call or meeting is scheduled", color: "var(--chart-1)", tone: "primary" },
  proposal_sent: { label: "Proposal sent", meaning: "Price and scope sent to the client", color: "var(--chart-4)", tone: "finance" },
  negotiation: { label: "Negotiation", meaning: "The client is discussing price or scope", color: "var(--chart-3)", tone: "sales" },
  won: { label: "Won", meaning: "The client agreed and work can start", color: "var(--success)", tone: "success" },
  lost: { label: "Lost", meaning: "No deal this time", color: "var(--danger)", tone: "danger" },
};

export const LOST_REASONS = ["Price", "No reply", "Chose another company", "Timing or budget", "Not a fit", "Other"];
export const RECONTACT_MONTHS = 6;

export const SERVICE_LABEL: Record<DealService, string> = {
  website: "Website",
  custom_software: "Custom software",
  ai_automation: "AI automation",
  mobile_app: "Mobile app",
  ecommerce: "E-commerce store",
};

export const SOURCE_LABEL: Record<LeadSource, string> = {
  apollo: "Apollo",
  fiverr: "Fiverr",
  linkedin: "LinkedIn",
  referral: "Referral",
  website: "Website",
  field: "Field promotion",
  walk_in: "Walk-in",
};

export const CHECK_META: Record<EmailCheck, { label: string; tone: BadgeTone }> = {
  valid: { label: "Valid", tone: "success" },
  invalid: { label: "Invalid", tone: "danger" },
  catch_all: { label: "Catch-all", tone: "warning" },
  unknown: { label: "Unknown", tone: "neutral" },
  unchecked: { label: "Not checked", tone: "outline" },
};

export const ACTIVITY_LABEL: Record<ActivityKind, string> = {
  email_sent: "Email sent",
  reply: "Reply received",
  bounce: "Email bounced",
  call: "Call",
  meeting: "Meeting",
  linkedin: "LinkedIn message",
  whatsapp: "WhatsApp chat",
  fiverr: "Fiverr inquiry",
  proposal: "Proposal sent",
  note: "Note",
  email_check: "Email checked",
  follow_up: "Follow-up done",
};

export const DEFAULT_SALES_WEIGHTS: SalesWeights = { activity: 0.2, meetings: 0.25, won: 0.3, dataQuality: 0.1, attendance: 0.15 };

const GENERIC_DOMAINS = ["gmail.com", "yahoo.com", "hotmail.com", "outlook.com", "icloud.com", "live.com", "proton.me", "aol.com"];

/** "https://www.harborandco.co.uk/about" → "harborandco.co.uk" */
export function domainOf(input?: string) {
  if (!input) return "";
  const s = input.trim().toLowerCase();
  if (s.includes("@")) return s.split("@")[1] ?? "";
  return s.replace(/^[a-z]+:\/\//, "").replace(/^www\./, "").split(/[/?#]/)[0];
}

export function isGenericDomain(domain: string) {
  return GENERIC_DOMAINS.includes(domain);
}

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * One owner, no duplicates (plan §20): match on the email first, then the company's website
 * domain (or the email's domain if it isn't a free mail provider).
 */
export function findDuplicate(input: { email?: string; website?: string }, leads: Lead[], companies: Company[]): DuplicateResult {
  const email = input.email?.trim().toLowerCase();
  if (email) {
    const byEmail = leads.find((l) => l.email?.toLowerCase() === email);
    if (byEmail) return toResult(byEmail, "email", companies);
  }
  const domain = domainOf(input.website) || (email ? domainOf(email) : "");
  if (domain && !isGenericDomain(domain)) {
    const company = companies.find((c) => c.domain === domain);
    const byDomain = company && leads.find((l) => l.companyId === company.id);
    if (byDomain) return toResult(byDomain, "domain", companies);
  }
  return { duplicate: false };
}

function toResult(lead: Lead, matchedOn: "email" | "domain", companies: Company[]): DuplicateResult {
  return {
    duplicate: true,
    matchedOn,
    leadId: lead.id,
    leadName: lead.name,
    companyName: companies.find((c) => c.id === lead.companyId)?.name,
    ownerEmpId: lead.ownerEmpId,
  };
}

export function toUsd(m: Money) {
  const n = Number(m.amount);
  return m.currency === "USD" ? n : n / USD_PKR;
}

export function convert(m: Money, to: "USD" | "PKR") {
  const usd = toUsd(m);
  return to === "USD" ? usd : usd * USD_PKR;
}

export const leadsAddedTotal = (s: DailySalesSummary) => s.leadsAdded.auto + s.leadsAdded.manual;
export const emailsSentTotal = (s: DailySalesSummary) => s.emailsSent.apollo + s.emailsSent.mailbox;
export const followUpsTotal = (s: DailySalesSummary) => s.followUps.auto + s.followUps.manual;
export const selfReportedTotal = (s: DailySalesSummary) =>
  s.selfReported.linkedin + s.selfReported.whatsapp + s.selfReported.fiverr + s.selfReported.calls + s.selfReported.fieldVisits;

/** Which daily targets were met (plan §20 "Target of 30 emails sent: met"). */
export function targetsMet(s: DailySalesSummary, t: DailyTargets) {
  const parts = {
    leadsAdded: leadsAddedTotal(s) >= t.leadsAdded,
    emailsChecked: s.emailsChecked >= t.emailsChecked,
    emailsSent: emailsSentTotal(s) >= t.emailsSent,
    followUps: followUpsTotal(s) >= t.followUps,
  };
  return { ...parts, all: Object.values(parts).every(Boolean) };
}

/** The sentence form of one line of the daily sales report (plan §20 example). */
export function reportSentence(s: DailySalesSummary, t: DailyTargets | undefined, weekdayDate: string) {
  const parts = [
    `${leadsAddedTotal(s)} leads added`,
    `${s.emailsChecked} emails checked (${s.invalid} invalid)`,
    `${s.emailsSent.apollo} emails sent through Apollo${s.emailsSent.mailbox ? ` and ${s.emailsSent.mailbox} from mailboxes` : ""}`,
    `${s.replies} ${s.replies === 1 ? "reply" : "replies"}`,
    `${s.meetings} ${s.meetings === 1 ? "meeting" : "meetings"} booked`,
  ];
  const self = selfReportedTotal(s);
  if (s.selfReported.linkedin) parts.push(`${s.selfReported.linkedin} LinkedIn messages (self-reported)`);
  else if (self) parts.push(`${self} other contacts (self-reported)`);
  let text = `${s.empId}, ${weekdayDate}: ${parts.join(", ")}.`;
  if (t) text += ` Target of ${t.emailsSent} emails sent: ${emailsSentTotal(s) >= t.emailsSent ? "met" : "not met"}.`;
  return text;
}

/** Data quality (D): 100 when bounce ≤ 3% and no duplicates; −10 per 1% above 3% and per duplicate. */
export function dataQuality(bounceRatePct: number, duplicates: number) {
  const over = Math.max(0, Math.ceil(bounceRatePct - 3));
  return Math.max(0, 100 - over * 10 - duplicates * 10);
}

const cap = (n: number) => Math.max(0, Math.min(100, n));

/** Sales score = 0.20 V + 0.25 M + 0.30 W + 0.10 D + 0.15 A (plan §20). */
export function salesScore(m: { activity: number; meetings: number; won: number; dataQuality: number; attendance: number }, w: SalesWeights = DEFAULT_SALES_WEIGHTS) {
  return (
    w.activity * cap(m.activity) + w.meetings * cap(m.meetings) + w.won * cap(m.won) + w.dataQuality * cap(m.dataQuality) + w.attendance * cap(m.attendance)
  );
}

export { cap as capScore };

export function isMissed(dateIso?: string) {
  if (!dateIso) return false;
  const d = new Date(dateIso);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  return d.getTime() < today.getTime();
}

export function isDueToday(dateIso?: string) {
  if (!dateIso) return false;
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return new Date(dateIso).getTime() <= end.getTime();
}

/** Simple CSV parser for lead imports (quoted values supported). */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  for (const raw of text.split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const cells: string[] = [];
    let cur = "";
    let quoted = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      if (ch === '"') {
        if (quoted && raw[i + 1] === '"') {
          cur += '"';
          i++;
        } else quoted = !quoted;
      } else if (ch === "," && !quoted) {
        cells.push(cur.trim());
        cur = "";
      } else cur += ch;
    }
    cells.push(cur.trim());
    rows.push(cells);
  }
  return rows;
}

export const SAMPLE_CSV = `name,email,company,website,country,title,source
Grace Holloway,grace@kestreldental.co.uk,Kestrel Dental,kestreldental.co.uk,United Kingdom,Practice Manager,apollo
Daniel Price,dan@lakeviewrealty.com,Lakeview Realty,lakeviewrealty.com,United States,Broker,apollo
Fatima Al Nuaimi,fatima@palmtech.ae,Palm Tech FZE,palmtech.ae,United Arab Emirates,COO,linkedin
Tom Reeves,tom.reeves@,Reeves Plumbing,reevesplumbing.co.uk,United Kingdom,Owner,apollo
Sophie Turner,sophie@fernandfig.co.uk,Fern & Fig,fernandfig.co.uk,United Kingdom,Founder,apollo
Marcus Lee,marcus@ridgelinegyms.com,Ridgeline Gyms,ridgelinegyms.com,United States,Operations Lead,apollo
Sophie Turner,sophie@fernandfig.co.uk,Fern & Fig,fernandfig.co.uk,United Kingdom,Founder,apollo`;
