/**
 * Module 15 service functions. Mock today; each JSDoc names the real endpoint (spec §7.3).
 * Scope (plan §20): Sales (L4) see and work their own leads and deals. sales.team / sales.all (the Director and the
 * CEO / Founder / Owner) see the whole team. The Director is the sales manager (sales.targets): he confirms Won deals,
 * sets targets, moves leads, asks for proof and approves commission lines. The CEO / Founder / Owner only views:
 * no add, edit, confirm or approve. Nobody confirms or approves their own item.
 */
import { ApiError, forbidden, mock, notFound } from "@/lib/api/mock";
import { getViewer, type Viewer } from "@/lib/auth/viewer";
import { employeeName, employeesTable, findEmployee } from "@/lib/directory";
import { ROLE_LABEL } from "@/lib/auth/permissions";
import { formatWeekdayLong, isoDay, monthKey } from "@/lib/dates";
import { uid } from "@/lib/utils";
import { nextNumber, table } from "@/mocks/db";
import {
  PREVIOUS_MONTH_SCORE, SALES_PEOPLE, seedActivities, seedCommissionLines, seedCommissionRules, seedCompanies, seedDailyTargets, seedDeals, seedDnc,
  seedLeads, seedMonthlyTargets, seedSummariesAndLogs,
} from "@/mocks/seed/sales";
import { daysFromNow } from "@/mocks/time";
import { apolloLastSyncAt, consumeMillionVerifierCredits, millionVerifierCredits } from "@/features/integrations/api";
import {
  capScore, dataQuality, DEFAULT_SALES_WEIGHTS, domainOf, EMAIL_RE, emailsSentTotal, findDuplicate, isDueToday, isGenericDomain, isMissed, OPEN_STAGES,
  parseCsv, RECONTACT_MONTHS, reportSentence, salesScore, SOURCE_LABEL, STAGE_META, STAGES, targetsMet, toUsd,
} from "./logic";
import type {
  CommissionLine, CommissionRule, Company, DailySalesSummary, DailyTargets, Deal, DealDetail, DealStage, DncEntry, DuplicateResult, EmailCheck, FollowUp,
  ImportRow, Lead, LeadDetail, LeadSource, LeadStub, LogActivityInput, ManualDailyLog, MonthlyTargets, MySalesDay, NewDealInput, NewLeadInput,
  PipelineSummary, SalesActivity, SalesScorecard, SelfReported, VerifyPreview, VerifyResult,
} from "./types";

/* ---------------- Tables ---------------- */

export const companiesTable = () => table<Company>("sales.companies", seedCompanies);
export const leadsTable = () => table<Lead>("sales.leads", seedLeads);
export const dealsTable = () => table<Deal>("sales.deals", seedDeals);
export const activitiesTable = () => table<SalesActivity>("sales.activities", seedActivities);
const dailyTargets = () => table<DailyTargets>("sales.daily_targets", seedDailyTargets);
const monthlyTargets = () => table<MonthlyTargets>("sales.monthly_targets", seedMonthlyTargets);
let seededDays: ReturnType<typeof seedSummariesAndLogs> | null = null;
const days = () => (seededDays ??= seedSummariesAndLogs());
const summaries = () => table<DailySalesSummary>("sales.summaries", () => days().summaries);
const logs = () => table<ManualDailyLog>("sales.logs", () => days().logs);
export const commissionLines = () => table<CommissionLine>("sales.commission_lines", seedCommissionLines);
const commissionRules = () => table<CommissionRule>("sales.commission_rules", seedCommissionRules);
const dncTable = () => table<DncEntry>("sales.dnc", seedDnc);

/* ---------------- Scope helpers ---------------- */

const seesTeam = (v: Viewer) => v.can("sales.team") || v.can("sales.all");
const me = () => getViewer().employee.empId;

/** The sales manager: the Director (sales.targets). Sets targets, moves leads, confirms Won deals, asks for proof. */
export function isSalesManager(v: Viewer) {
  return v.can("sales.team") && v.can("sales.targets");
}

/** Leads and tool accounts can only belong to people in Sales (L4). */
export function isSalesPerson(empId: string) {
  const e = findEmployee(empId);
  return !!e && e.role === "sales" && e.status !== "left";
}

/** Salespeople own leads: only they add or import leads and log their own sales day. */
export function ownsSalesWork(v: Viewer) {
  return v.can("sales.own") && isSalesPerson(v.employee.empId);
}

/** Who may change a lead or deal: its owner, or the sales manager. Everyone else with team view (the CEO) only reads. */
export function canWorkOn(v: Viewer, ownerEmpId: string) {
  return (v.employee.empId === ownerEmpId && ownsSalesWork(v)) || isSalesManager(v);
}

/** Sales work that isn't tied to one lead (email checks, do-not-contact list): salespeople and the sales manager. */
export function canDoSalesWork(v: Viewer) {
  return ownsSalesWork(v) || isSalesManager(v);
}

const VIEW_ONLY = "View only. Salespeople work their own leads and deals; the Director confirms and approves.";

function requireWork(v: Viewer, ownerEmpId: string) {
  if (!canWorkOn(v, ownerEmpId)) forbidden(VIEW_ONLY);
}

/** The sales manager's Emp-ID: the Director. */
function salesManagerEmpId() {
  return employeesTable().find((e) => e.role === "director" && e.status !== "left")?.empId;
}

/** Who confirms a Won deal: the Director (sales manager). Never the owner, so a deal the Director owns has no confirmer. */
export function wonConfirmerOf(ownerEmpId: string) {
  const director = salesManagerEmpId();
  return director && director !== ownerEmpId ? director : undefined;
}

export function canConfirmWon(v: Viewer, d: Pick<Deal, "ownerEmpId">) {
  return isSalesManager(v) && v.employee.empId !== d.ownerEmpId;
}

const confirmerName = (ownerEmpId: string) => {
  const id = wonConfirmerOf(ownerEmpId);
  return id ? employeeName(id) : "the Director";
};

/**
 * Commission lines are approved by the Director (sales.commission_approve), never by the person paid.
 * Nothing goes above the Director: the CEO / Founder / Owner and Finance only view the lines.
 */
export function canDecideCommission(v: Viewer, c: Pick<CommissionLine, "empId" | "status">) {
  return c.status === "calculated" && c.empId !== v.employee.empId && v.can("sales.commission_approve");
}
const today = () => isoDay(new Date());

function requireSales(v: Viewer = getViewer()) {
  if (!v.can("sales.own")) notFound("Page");
}

function canSeeLead(v: Viewer, l: Lead) {
  return seesTeam(v) || l.ownerEmpId === v.employee.empId;
}

function canSeeDeal(v: Viewer, d: Deal) {
  return seesTeam(v) || d.ownerEmpId === v.employee.empId;
}

/** The salespeople a viewer can report on. */
function salesScope(v: Viewer) {
  if (seesTeam(v)) return SALES_PEOPLE;
  return SALES_PEOPLE.includes(v.employee.empId) ? [v.employee.empId] : [];
}

const companyOf = (id: string) => companiesTable().find((c) => c.id === id);
const leadOf = (id: string) => leadsTable().find((l) => l.id === id);

function summaryFor(empId: string, date = today()) {
  let s = summaries().find((x) => x.empId === empId && x.date === date);
  if (!s) {
    s = {
      id: `ds_${empId}_${date}`,
      empId,
      date,
      leadsAdded: { auto: 0, manual: 0 },
      emailsChecked: 0,
      invalid: 0,
      emailsSent: { apollo: 0, mailbox: 0 },
      replies: 0,
      bounces: 0,
      meetings: 0,
      followUps: { auto: 0, manual: 0 },
      selfReported: { linkedin: 0, whatsapp: 0, fiverr: 0, calls: 0, fieldVisits: 0 },
    };
    summaries().push(s);
  }
  return s;
}

function addActivity(a: Omit<SalesActivity, "id">) {
  const act = { ...a, id: uid("sa") };
  activitiesTable().unshift(act);
  if (a.leadId) {
    const l = leadOf(a.leadId);
    if (l) l.lastActivityAt = a.at;
  }
  return act;
}

function pushHistory(d: Deal, stage: DealStage, note?: string) {
  d.history.push({ stage, at: new Date().toISOString(), by: me(), note });
  d.updatedAt = new Date().toISOString();
}

/* ---------------- Row shapes for lists ---------------- */

export type LeadRow = Lead & { companyName: string; domain?: string; openDeal?: { id: string; number: string; stage: DealStage } };
export type DealRow = Deal & { companyName: string; leadName: string };

function toLeadRow(l: Lead): LeadRow {
  const co = companyOf(l.companyId);
  const deal = dealsTable().find((d) => d.leadId === l.id && d.stage !== "lost" && !(d.stage === "won" && d.wonStatus === "confirmed"));
  return { ...l, companyName: co?.name ?? "—", domain: co?.domain, openDeal: deal ? { id: deal.id, number: deal.number, stage: deal.stage } : undefined };
}

function toDealRow(d: Deal): DealRow {
  return { ...d, companyName: companyOf(d.companyId)?.name ?? "—", leadName: leadOf(d.leadId)?.name ?? "—" };
}

function stableHash(s: string) {
  let h = 0;
  for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return h;
}

function checkResultFor(email: string): EmailCheck {
  if (!EMAIL_RE.test(email)) return "invalid";
  const h = stableHash(email) % 100;
  return h < 80 ? "valid" : h < 88 ? "invalid" : h < 95 ? "catch_all" : "unknown";
}

function createLead(input: NewLeadInput, owner: string, manual: boolean): Lead {
  const domain = domainOf(input.website) || (input.email && !isGenericDomain(domainOf(input.email)) ? domainOf(input.email) : "");
  let company = domain ? companiesTable().find((c) => c.domain === domain) : companiesTable().find((c) => c.name.toLowerCase() === input.companyName.trim().toLowerCase());
  if (!company) {
    company = { id: uid("co"), name: input.companyName.trim(), website: domain ? `https://${domain}` : undefined, domain: domain || undefined, country: input.country, industry: input.industry };
    companiesTable().push(company);
  }
  const email = input.email?.trim().toLowerCase();
  const dnc = !!email && dncTable().some((d) => d.email === email);
  const now = new Date().toISOString();
  const lead: Lead = {
    id: uid("ld"),
    name: input.name.trim(),
    title: input.title?.trim() || undefined,
    companyId: company.id,
    email: email || undefined,
    phone: input.phone?.trim() || undefined,
    linkedinUrl: input.linkedinUrl?.trim() || undefined,
    country: input.country || company.country,
    industry: input.industry || company.industry,
    source: input.source,
    ownerEmpId: owner,
    emailCheck: "unchecked",
    doNotContact: dnc,
    notes: input.notes?.trim() || undefined,
    archived: false,
    createdAt: now,
    lastActivityAt: now,
  };
  leadsTable().unshift(lead);
  const s = summaryFor(owner);
  if (manual) s.leadsAdded.manual += 1;
  else s.leadsAdded.auto += 1;
  addActivity({ leadId: lead.id, empId: owner, kind: "note", source: "manual", at: now, summary: `Lead added (${SOURCE_LABEL[input.source]})` });
  return lead;
}

/* ---------------- Leads ---------------- */

export const leadsApi = {
  /** GET /leads */
  list: () =>
    mock<LeadRow[]>(() => {
      const v = getViewer();
      requireSales(v);
      return leadsTable()
        .filter((l) => !l.archived && canSeeLead(v, l))
        .map(toLeadRow);
    }),

  /** GET /leads/:id — other salespeople only see that the lead exists and who owns it */
  get: (id: string) =>
    mock<LeadDetail | LeadStub>(() => {
      const v = getViewer();
      requireSales(v);
      const lead = leadOf(id);
      if (!lead) notFound("Lead");
      const company = companyOf(lead.companyId)!;
      if (!canSeeLead(v, lead)) return { id: lead.id, name: lead.name, companyName: company.name, ownerEmpId: lead.ownerEmpId, restricted: true };
      return {
        lead,
        company,
        activities: activitiesTable().filter((a) => a.leadId === id).sort((a, b) => b.at.localeCompare(a.at)),
        deals: dealsTable().filter((d) => d.leadId === id),
      };
    }),

  /** POST /leads/check-duplicate { email, website } — checks every lead in the company */
  checkDuplicate: (input: { email?: string; website?: string }) =>
    mock<DuplicateResult>(() => findDuplicate(input, leadsTable(), companiesTable()), { delay: 180 }),

  /** POST /leads */
  create: (input: NewLeadInput) =>
    mock(() => {
      const v = getViewer();
      requireSales(v);
      if (!ownsSalesWork(v)) forbidden("Leads belong to salespeople. Only someone in Sales can add a lead.");
      const dup = findDuplicate(input, leadsTable(), companiesTable());
      if (dup.duplicate) throw new ApiError("duplicate", `This lead already exists. Owner: ${employeeName(dup.ownerEmpId)} (${dup.ownerEmpId}).`, 409);
      return createLead(input, v.employee.empId, true);
    }),

  /** PATCH /leads/:id */
  update: (id: string, patch: Partial<Pick<Lead, "notes" | "phone" | "title" | "linkedinUrl">>) =>
    mock(() => {
      const v = getViewer();
      const l = leadOf(id);
      if (!l || !canSeeLead(v, l)) notFound("Lead");
      requireWork(v, l.ownerEmpId);
      Object.assign(l, patch);
    }),

  /** POST /leads/:id/owner { empId } — the Director (sales manager) moves leads between salespeople */
  reassign: (id: string, empId: string) =>
    mock(() => {
      const v = getViewer();
      if (!isSalesManager(v)) forbidden("Only the Director (sales manager) can move leads between people.");
      if (!isSalesPerson(empId)) throw new ApiError("validation", "Leads can only be owned by someone in Sales.");
      const l = leadOf(id);
      if (!l) notFound("Lead");
      l.ownerEmpId = empId;
      dealsTable().forEach((d) => {
        if (d.leadId === id && OPEN_STAGES.includes(d.stage)) d.ownerEmpId = empId;
      });
    }),

  /** POST /leads/:id/do-not-contact { reason } */
  markDoNotContact: (id: string, reason: string) =>
    mock(() => {
      const v = getViewer();
      const l = leadOf(id);
      if (!l || !canSeeLead(v, l)) notFound("Lead");
      requireWork(v, l.ownerEmpId);
      l.doNotContact = true;
      if (l.email && !dncTable().some((d) => d.email === l.email)) dncTable().unshift({ id: uid("dnc"), email: l.email, leadId: l.id, reason, addedBy: v.employee.empId, at: new Date().toISOString() });
      addActivity({ leadId: l.id, empId: v.employee.empId, kind: "note", source: "manual", at: new Date().toISOString(), summary: `Marked do not contact: ${reason}` });
    }),

  /** POST /leads/import (preview only) */
  importPreview: (csv: string) =>
    mock<ImportRow[]>(() => {
      const v = getViewer();
      requireSales(v);
      if (!ownsSalesWork(v)) forbidden("Leads belong to salespeople. Only someone in Sales can import leads.");
      const rows = parseCsv(csv);
      if (!rows.length) return [];
      const header = rows[0].map((h) => h.toLowerCase());
      const hasHeader = header.includes("email") || header.includes("name");
      const idx = (k: string, fallback: number) => (hasHeader ? header.indexOf(k) : fallback);
      const cols = { name: idx("name", 0), email: idx("email", 1), company: idx("company", 2), website: idx("website", 3), country: idx("country", 4), title: idx("title", 5), source: idx("source", 6) };
      const seen = new Set<string>();
      return rows.slice(hasHeader ? 1 : 0).map((r, i) => {
        const get = (c: number) => (c >= 0 ? (r[c] ?? "").trim() : "");
        const sourceRaw = get(cols.source).toLowerCase().replace(/[\s-]/g, "_") as LeadSource;
        const row: ImportRow = {
          line: i + (hasHeader ? 2 : 1),
          name: get(cols.name),
          email: get(cols.email).toLowerCase(),
          companyName: get(cols.company),
          website: get(cols.website) || undefined,
          country: get(cols.country) || undefined,
          title: get(cols.title) || undefined,
          source: sourceRaw in SOURCE_LABEL ? sourceRaw : "apollo",
          status: "ok",
        };
        if (!row.name || !row.companyName) return { ...row, status: "invalid", message: "Name and company are required." };
        if (!EMAIL_RE.test(row.email)) return { ...row, status: "invalid", message: "The email address isn't valid." };
        if (seen.has(row.email)) return { ...row, status: "repeated", message: "Appears earlier in this file." };
        seen.add(row.email);
        const dup = findDuplicate({ email: row.email, website: row.website }, leadsTable(), companiesTable());
        if (dup.duplicate) return { ...row, status: "duplicate", ownerEmpId: dup.ownerEmpId, message: `Already exists (matched on ${dup.matchedOn}). Owner: ${employeeName(dup.ownerEmpId)}.` };
        return row;
      });
    }),

  /** POST /leads/import/commit — saves only the good rows */
  importCommit: (rows: ImportRow[]) =>
    mock(() => {
      const v = getViewer();
      requireSales(v);
      if (!ownsSalesWork(v)) forbidden("Leads belong to salespeople. Only someone in Sales can import leads.");
      let n = 0;
      for (const r of rows.filter((x) => x.status === "ok")) {
        if (findDuplicate({ email: r.email, website: r.website }, leadsTable(), companiesTable()).duplicate) continue;
        createLead({ name: r.name, email: r.email, companyName: r.companyName, website: r.website, country: r.country, title: r.title, source: r.source }, v.employee.empId, r.source !== "apollo");
        n++;
      }
      return { imported: n };
    }),

  /** GET /leads/verify/preview */
  verifyPreview: () =>
    mock<VerifyPreview>(() => {
      const v = getViewer();
      const mine = leadsTable().filter((l) => !l.archived && !l.doNotContact && l.email && canWorkOn(v, l.ownerEmpId));
      const recent = (l: Lead) => !!l.checkedAt && Date.now() - new Date(l.checkedAt).getTime() < 90 * 86_400_000;
      return { toCheck: mine.filter((l) => !recent(l)).length, skippedRecent: mine.filter(recent).length, creditsLeft: millionVerifierCredits() };
    }),

  /** POST /leads/verify — sends unchecked emails to MillionVerifier (Module 16), 1 credit each */
  verify: () =>
    mock<VerifyResult>(() => {
      const v = getViewer();
      requireSales(v);
      if (!canDoSalesWork(v)) forbidden(VIEW_ONLY);
      const mine = leadsTable().filter((l) => !l.archived && !l.doNotContact && l.email && canWorkOn(v, l.ownerEmpId));
      const recent = (l: Lead) => !!l.checkedAt && Date.now() - new Date(l.checkedAt).getTime() < 90 * 86_400_000;
      const todo = mine.filter((l) => !recent(l));
      const creditsLeft = todo.length ? consumeMillionVerifierCredits(todo.length) : millionVerifierCredits();
      const res: VerifyResult = { checked: todo.length, valid: 0, invalid: 0, catchAll: 0, unknown: 0, skippedRecent: mine.length - todo.length, creditsLeft };
      const now = new Date().toISOString();
      for (const l of todo) {
        const r = checkResultFor(l.email!);
        l.emailCheck = r;
        l.checkedAt = now;
        if (r === "valid") res.valid++;
        else if (r === "invalid") res.invalid++;
        else if (r === "catch_all") res.catchAll++;
        else res.unknown++;
        const s = summaryFor(l.ownerEmpId);
        s.emailsChecked += 1;
        if (r === "invalid") s.invalid += 1;
        addActivity({ leadId: l.id, empId: v.employee.empId, kind: "email_check", source: "millionverifier", at: now, summary: `Email checked: ${r.replace("_", "-")}`, externalId: `mv-${uid("chk")}` });
      }
      return res;
    }, { delay: 1200 }),
};

/* ---------------- Activities ---------------- */

export const activitiesApi = {
  /** POST /leads/:id/activities */
  log: (input: LogActivityInput) =>
    mock(() => {
      const v = getViewer();
      const l = leadOf(input.leadId);
      if (!l || !canSeeLead(v, l)) notFound("Lead");
      requireWork(v, l.ownerEmpId);
      const at = input.at ?? new Date().toISOString();
      const a = addActivity({ leadId: l.id, dealId: input.dealId, empId: v.employee.empId, kind: input.kind, source: "manual", at, summary: input.summary });
      if (input.kind === "meeting" && isoDay(at) === today()) summaryFor(l.ownerEmpId).meetings += 1;
      return a;
    }),
};

/* ---------------- Deals ---------------- */

/**
 * Won deal handover (plan §20): the company becomes a client, a draft invoice is created in
 * Billing (Module 13) for Finance to check and send, and the CTO is told to create project tasks.
 * Mock: the invoice number is recorded on the deal; Billing creates the real draft in live mode.
 */
export function handoverDeal(d: Deal, by: string) {
  const n = nextNumber("sales.invoice", 51);
  const now = new Date().toISOString();
  d.stage = "won";
  d.wonStatus = "confirmed";
  d.wonConfirmedBy = by;
  d.handover = { clientName: companyOf(d.companyId)?.name ?? "Client", invoiceNumber: `INV-2026-${String(n).padStart(4, "0")}`, ctoNotified: true, at: now };
  d.nextStep = undefined;
  d.nextStepDate = undefined;
  const role = findEmployee(by)?.role;
  d.history.push({ stage: "won", at: now, by, note: `Confirmed by the ${role ? ROLE_LABEL[role] : "manager"}` });
  d.updatedAt = now;
  addActivity({ leadId: d.leadId, dealId: d.id, empId: by, kind: "note", source: "manual", at: now, summary: `Won confirmed. Draft invoice ${d.handover.invoiceNumber} created in Billing; CTO asked to create the project tasks.` });
}

function handover(d: Deal) {
  handoverDeal(d, me());
}

export interface MoveResult {
  stage: DealStage;
  pending?: boolean;
  confirmer?: string;
  recontactAfter?: string;
  handover?: Deal["handover"];
}

export const dealsApi = {
  /** GET /deals */
  list: () =>
    mock<DealRow[]>(() => {
      const v = getViewer();
      requireSales(v);
      return dealsTable().filter((d) => canSeeDeal(v, d)).map(toDealRow);
    }),

  /** GET /deals/:id */
  get: (id: string) =>
    mock<DealDetail>(() => {
      const v = getViewer();
      requireSales(v);
      const deal = dealsTable().find((d) => d.id === id || d.number === id);
      if (!deal || !canSeeDeal(v, deal)) notFound("Deal");
      return {
        deal,
        lead: leadOf(deal.leadId)!,
        company: companyOf(deal.companyId)!,
        activities: activitiesTable().filter((a) => a.dealId === deal.id || (a.leadId === deal.leadId && !a.dealId)).sort((a, b) => b.at.localeCompare(a.at)),
        commission: commissionLines().find((c) => c.dealId === deal.id),
      };
    }),

  /** POST /deals */
  create: (input: NewDealInput) =>
    mock(() => {
      const v = getViewer();
      const lead = leadOf(input.leadId);
      if (!lead || !canSeeLead(v, lead)) notFound("Lead");
      requireWork(v, lead.ownerEmpId);
      if (lead.doNotContact) throw new ApiError("dnc", "This lead asked not to be contacted.");
      if (!input.nextStep || !input.nextStepDate) throw new ApiError("validation", "Every open deal needs a next step with a date.");
      const n = nextNumber("sales.deal", 36);
      const now = new Date().toISOString();
      const deal: Deal = {
        id: uid("dl"),
        number: `DL-${String(n).padStart(4, "0")}`,
        leadId: lead.id,
        companyId: lead.companyId,
        service: input.service,
        value: input.value,
        expectedClose: input.expectedClose,
        stage: "new",
        nextStep: input.nextStep,
        nextStepDate: input.nextStepDate,
        ownerEmpId: lead.ownerEmpId,
        history: [{ stage: "new", at: now, by: v.employee.empId }],
        createdAt: now,
        updatedAt: now,
      };
      dealsTable().unshift(deal);
      return deal;
    }),

  /** POST /deals/:id/move { stage, reason? } */
  move: (id: string, stage: DealStage, reason?: string) =>
    mock<MoveResult>(() => {
      const v = getViewer();
      const d = dealsTable().find((x) => x.id === id);
      if (!d || !canSeeDeal(v, d)) notFound("Deal");
      requireWork(v, d.ownerEmpId);
      if (d.stage === "lost" || (d.stage === "won" && d.wonStatus === "confirmed")) throw new ApiError("closed", "This deal is closed. Create a new deal to work with the client again.");
      if (d.stage === stage) return { stage };
      if (stage === "lost") {
        if (!reason) throw new ApiError("validation", "A reason is required to mark a deal as lost.");
        d.stage = "lost";
        d.lostReason = reason;
        d.wonStatus = undefined;
        d.recontactAfter = daysFromNow(RECONTACT_MONTHS * 30);
        d.nextStep = undefined;
        d.nextStepDate = undefined;
        pushHistory(d, "lost", reason);
        return { stage, recontactAfter: d.recontactAfter };
      }
      if (stage === "won") {
        // The Director (sales manager) can mark it Won straight away; a salesperson's Won waits for him.
        if (canConfirmWon(v, d)) {
          handover(d);
          return { stage, handover: d.handover };
        }
        d.previousStage = d.stage;
        d.stage = "won";
        d.wonStatus = "pending";
        d.wonRequestedAt = new Date().toISOString();
        pushHistory(d, "won", "Waiting for the Director to confirm");
        return { stage, pending: true, confirmer: confirmerName(d.ownerEmpId) };
      }
      d.stage = stage;
      d.wonStatus = undefined;
      pushHistory(d, stage);
      return { stage };
    }),

  /** POST /deals/:id/confirm-won — the Director (sales manager), never the owner */
  confirmWon: (id: string) =>
    mock(() => {
      const v = getViewer();
      const d = dealsTable().find((x) => x.id === id);
      if (!d || !canSeeDeal(v, d)) notFound("Deal");
      if (d.ownerEmpId === v.employee.empId) forbidden("You can't confirm your own deal. Nobody approves their own request.");
      if (!canConfirmWon(v, d)) forbidden(`View only. ${confirmerName(d.ownerEmpId)} (Director) confirms Won deals.`);
      if (d.wonStatus !== "pending") throw new ApiError("closed", "This deal isn't waiting for confirmation.");
      handover(d);
      return d.handover!;
    }),

  /** POST /deals/:id/reject-won { reason } */
  rejectWon: (id: string, reason: string) =>
    mock(() => {
      const v = getViewer();
      const d = dealsTable().find((x) => x.id === id);
      if (!d || !canSeeDeal(v, d)) notFound("Deal");
      if (!canConfirmWon(v, d)) forbidden(`View only. ${confirmerName(d.ownerEmpId)} (Director) answers this.`);
      if (d.wonStatus !== "pending") throw new ApiError("closed", "This deal isn't waiting for confirmation.");
      d.stage = d.previousStage ?? "negotiation";
      d.wonStatus = undefined;
      pushHistory(d, d.stage, `Won not confirmed: ${reason}`);
    }),

  /** PATCH /deals/:id { nextStep, nextStepDate } */
  setNextStep: (id: string, nextStep: string, nextStepDate: string) =>
    mock(() => {
      const v = getViewer();
      const d = dealsTable().find((x) => x.id === id);
      if (!d || !canSeeDeal(v, d)) notFound("Deal");
      requireWork(v, d.ownerEmpId);
      d.nextStep = nextStep;
      d.nextStepDate = nextStepDate;
      d.updatedAt = new Date().toISOString();
    }),

  /** PATCH /deals/:id { proposalUrl } */
  setProposal: (id: string, url: string) =>
    mock(() => {
      const v = getViewer();
      const d = dealsTable().find((x) => x.id === id);
      if (!d || !canSeeDeal(v, d)) notFound("Deal");
      requireWork(v, d.ownerEmpId);
      d.proposalUrl = url;
      addActivity({ leadId: d.leadId, dealId: d.id, empId: me(), kind: "proposal", source: "manual", at: new Date().toISOString(), summary: "Proposal linked to the deal" });
    }),

  /** POST /deals/:id/follow-up — marks today's follow-up done and sets the next one */
  followUpDone: (id: string, summary: string, nextStep: string, nextStepDate: string) =>
    mock(() => {
      const v = getViewer();
      const d = dealsTable().find((x) => x.id === id);
      if (!d || !canSeeDeal(v, d)) notFound("Deal");
      requireWork(v, d.ownerEmpId);
      addActivity({ leadId: d.leadId, dealId: d.id, empId: v.employee.empId, kind: "follow_up", source: "manual", at: new Date().toISOString(), summary: summary || `Follow-up done: ${d.nextStep ?? ""}` });
      summaryFor(d.ownerEmpId).followUps.manual += 1;
      d.nextStep = nextStep;
      d.nextStepDate = nextStepDate;
      d.updatedAt = new Date().toISOString();
    }),

  /** GET /deals/summary */
  summary: () =>
    mock<PipelineSummary>(() => {
      const v = getViewer();
      return pipelineSummary(dealsTable().filter((d) => canSeeDeal(v, d)));
    }),
};

function pipelineSummary(deals: Deal[]): PipelineSummary {
  const month = monthKey();
  const stages = STAGES.map((stage) => {
    const list = deals.filter((d) => d.stage === stage);
    return { stage, count: list.length, valueUsd: list.reduce((s, d) => s + toUsd(d.value), 0) };
  });
  const open = deals.filter((d) => OPEN_STAGES.includes(d.stage));
  const closedAt = (d: Deal) => d.history[d.history.length - 1]?.at ?? d.updatedAt;
  const wonMonth = deals.filter((d) => d.stage === "won" && d.wonStatus === "confirmed" && monthKey(closedAt(d)) === month);
  return {
    stages,
    openValueUsd: open.reduce((s, d) => s + toUsd(d.value), 0),
    openCount: open.length,
    wonThisMonthUsd: wonMonth.reduce((s, d) => s + toUsd(d.value), 0),
    wonThisMonthCount: wonMonth.length,
    lostThisMonthCount: deals.filter((d) => d.stage === "lost" && monthKey(closedAt(d)) === month).length,
    pendingWonCount: deals.filter((d) => d.wonStatus === "pending").length,
  };
}

/* ---------------- My sales day, daily log ---------------- */

function followUpsFor(empIds: string[]): FollowUp[] {
  return dealsTable()
    .filter((d) => empIds.includes(d.ownerEmpId) && OPEN_STAGES.includes(d.stage) && d.nextStepDate && isDueToday(d.nextStepDate))
    .map((d) => ({
      dealId: d.id,
      dealNumber: d.number,
      companyName: companyOf(d.companyId)?.name ?? "—",
      leadName: leadOf(d.leadId)?.name ?? "—",
      nextStep: d.nextStep ?? "Next step",
      nextStepDate: d.nextStepDate!,
      missed: isMissed(d.nextStepDate),
      ownerEmpId: d.ownerEmpId,
    }))
    .sort((a, b) => Number(b.missed) - Number(a.missed) || a.nextStepDate.localeCompare(b.nextStepDate));
}

export const salesDayApi = {
  /** People whose day the viewer may open (self, or the team for managers). */
  people: () => mock(() => salesScope(getViewer()), { delay: 60 }),

  /** GET /sales/my-day?empId= */
  myDay: (empId?: string) =>
    mock<MySalesDay | null>(() => {
      const v = getViewer();
      requireSales(v);
      const scope = salesScope(v);
      const target = empId && scope.includes(empId) ? empId : scope.includes(v.employee.empId) ? v.employee.empId : scope[0];
      if (!target) return null;
      const s = summaryFor(target);
      const replies = activitiesTable()
        .filter((a) => a.kind === "reply" && a.source === "apollo" && Date.now() - new Date(a.at).getTime() < 24 * 3_600_000)
        .map((a) => ({ a, lead: a.leadId ? leadOf(a.leadId) : undefined }))
        .filter(({ lead }) => lead?.ownerEmpId === target)
        .map(({ a, lead }) => ({ ...a, leadName: lead!.name, companyName: companyOf(lead!.companyId)?.name ?? "—" }));
      return {
        empId: target,
        date: today(),
        targets: dailyTargets().find((t) => t.empId === target) ?? { empId: target, leadsAdded: 0, emailsChecked: 0, emailsSent: 0, followUps: 0 },
        summary: s,
        log: logs().find((l) => l.empId === target && l.date === today()),
        followUpsDue: followUpsFor([target]),
        newReplies: replies,
        pipeline: pipelineSummary(dealsTable().filter((d) => d.ownerEmpId === target)).stages,
        apolloLastSyncAt: apolloLastSyncAt(),
      };
    }),

  /** POST /sales/daily-logs (today, self-reported) */
  submitLog: (input: SelfReported & { note?: string }) =>
    mock(() => {
      const v = getViewer();
      requireSales(v);
      if (!ownsSalesWork(v)) forbidden("Only salespeople log a sales day.");
      const empId = v.employee.empId;
      const date = today();
      const list = logs();
      const existing = list.find((l) => l.empId === empId && l.date === date);
      const log: ManualDailyLog = { id: existing?.id ?? uid("log"), empId, date, ...input, submittedAt: new Date().toISOString() };
      if (existing) Object.assign(existing, log);
      else list.push(log);
      summaryFor(empId, date).selfReported = { linkedin: input.linkedin, whatsapp: input.whatsapp, fiverr: input.fiverr, calls: input.calls, fieldVisits: input.fieldVisits };
      return log;
    }),
};

/* ---------------- Reports ---------------- */

export interface DailyReportRow {
  summary: DailySalesSummary;
  targets?: DailyTargets;
  met: ReturnType<typeof targetsMet> | null;
  sentence: string;
  log?: ManualDailyLog;
}

export interface SalesDashboard {
  byStage: { stage: DealStage; label: string; count: number; valueUsd: number }[];
  wonLost: { won: number; lost: number; wonUsd: number; lostUsd: number };
  conversion: { from: string; to: string; rate: number }[];
  bySource: { name: string; value: number }[];
  byCountry: { name: string; value: number }[];
  activityWeek: { empId: string; name: string; emailsSent: number; replies: number; meetings: number; selfReported: number }[];
}

export const reportsApi = {
  /** GET /sales/reports/daily/dates */
  dates: () =>
    mock(() => {
      const set = new Set(summaries().map((s) => s.date));
      return [...set].sort().reverse();
    }, { delay: 60 }),

  /** GET /sales/reports/daily?date= */
  daily: (date: string) =>
    mock<DailyReportRow[]>(() => {
      const v = getViewer();
      requireSales(v);
      return salesScope(v).map((empId) => {
        const summary = summaries().find((s) => s.empId === empId && s.date === date) ?? summaryFor(empId, date);
        const targets = dailyTargets().find((t) => t.empId === empId);
        const label = formatWeekdayLong(new Date(`${date}T12:00:00`));
        return { summary, targets, met: targets ? targetsMet(summary, targets) : null, sentence: reportSentence(summary, targets, label), log: logs().find((l) => l.empId === empId && l.date === date) };
      });
    }),

  /** POST /sales/daily-logs/:empId/:date/request-proof */
  requestProof: (empId: string, date: string) =>
    mock(() => {
      const v = getViewer();
      if (!isSalesManager(v)) forbidden("Only the Director (sales manager) can ask for proof.");
      const s = summaries().find((x) => x.empId === empId && x.date === date);
      if (s) s.proofRequested = true;
      const l = logs().find((x) => x.empId === empId && x.date === date);
      if (l) l.proofRequested = true;
    }),

  /** GET /sales/dashboard?month= */
  dashboard: () =>
    mock<SalesDashboard>(() => {
      const v = getViewer();
      requireSales(v);
      const deals = dealsTable().filter((d) => canSeeDeal(v, d));
      const leads = leadsTable().filter((l) => canSeeLead(v, l));
      const sum = pipelineSummary(deals);
      const reached = (s: DealStage) => deals.filter((d) => d.history.some((h) => h.stage === s) || d.stage === s).length;
      const flow: DealStage[] = ["new", "contacted", "replied", "meeting_booked", "proposal_sent", "negotiation", "won"];
      const conversion = flow.slice(0, -1).map((s, i) => {
        const a = reached(s);
        const b = reached(flow[i + 1]);
        return { from: STAGE_META[s].label, to: STAGE_META[flow[i + 1]].label, rate: a ? Math.round((b / a) * 100) : 0 };
      });
      const count = <K extends string>(keys: K[]) => {
        const m = new Map<string, number>();
        keys.forEach((k) => m.set(k, (m.get(k) ?? 0) + 1));
        return [...m.entries()].map(([name, value]) => ({ name, value })).sort((a, b) => b.value - a.value);
      };
      const week = summaries().filter((s) => Date.now() - new Date(`${s.date}T12:00:00`).getTime() < 7 * 86_400_000);
      return {
        byStage: sum.stages.map((s) => ({ ...s, label: STAGE_META[s.stage].label })),
        wonLost: {
          won: deals.filter((d) => d.stage === "won").length,
          lost: deals.filter((d) => d.stage === "lost").length,
          wonUsd: deals.filter((d) => d.stage === "won").reduce((s, d) => s + toUsd(d.value), 0),
          lostUsd: deals.filter((d) => d.stage === "lost").reduce((s, d) => s + toUsd(d.value), 0),
        },
        conversion,
        bySource: count(leads.map((l) => SOURCE_LABEL[l.source])),
        byCountry: count(leads.map((l) => l.country ?? "Unknown")),
        activityWeek: salesScope(v).map((empId) => {
          const mine = week.filter((s) => s.empId === empId);
          return {
            empId,
            name: employeeName(empId),
            emailsSent: mine.reduce((n, s) => n + emailsSentTotal(s), 0),
            replies: mine.reduce((n, s) => n + s.replies, 0),
            meetings: mine.reduce((n, s) => n + s.meetings, 0),
            selfReported: mine.reduce((n, s) => n + Object.values(s.selfReported).reduce((a, b) => a + b, 0), 0),
          };
        }),
      };
    }),

  /** GET /sales/scorecards?month=current|previous */
  scorecards: (which: "current" | "previous") =>
    mock<SalesScorecard[]>(() => {
      const v = getViewer();
      requireSales(v);
      const month = which === "current" ? monthKey() : (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return monthKey(d); })();
      return salesScope(v).map((empId) => {
        if (which === "previous") {
          const p = PREVIOUS_MONTH_SCORE[empId];
          return { empId, month, ...p, score: salesScore(p), weights: DEFAULT_SALES_WEIGHTS, detail: { daysMet: 0, workingDays: 0, meetingsBooked: 0, meetingTarget: 0, wonUsd: 0, wonTargetUsd: 0, bounceRate: 0, duplicates: 0 } };
        }
        const t = dailyTargets().find((x) => x.empId === empId);
        const mt = monthlyTargets().find((x) => x.empId === empId);
        const mine = summaries().filter((s) => s.empId === empId && s.date.startsWith(month));
        const daysMet = t ? mine.filter((s) => targetsMet(s, t).all).length : 0;
        const meetingsBooked = mine.reduce((n, s) => n + s.meetings, 0) + (empId === "ACV-0009" ? 3 : 2);
        const wonUsd = dealsTable()
          .filter((d) => d.ownerEmpId === empId && d.stage === "won" && d.wonStatus === "confirmed" && monthKey(d.history[d.history.length - 1]?.at ?? d.updatedAt) === month)
          .reduce((s, d) => s + toUsd(d.value), 0) + (empId === "ACV-0009" ? 2400 : 0);
        const sent = mine.reduce((n, s) => n + emailsSentTotal(s), 0);
        const bounces = mine.reduce((n, s) => n + s.bounces, 0);
        const bounceRate = sent ? (bounces / sent) * 100 : 0;
        const duplicates = empId === "ACV-0012" ? 1 : 0;
        const wonTargetUsd = mt ? toUsd(mt.wonValue) : 1;
        const m = {
          activity: capScore(mine.length ? (daysMet / mine.length) * 100 : 0),
          meetings: capScore(mt ? (meetingsBooked / mt.meetings) * 100 : 0),
          won: capScore((wonUsd / wonTargetUsd) * 100),
          dataQuality: dataQuality(bounceRate, duplicates),
          attendance: empId === "ACV-0009" ? 96 : 88,
        };
        return { empId, month, ...m, score: salesScore(m), weights: DEFAULT_SALES_WEIGHTS, detail: { daysMet, workingDays: mine.length, meetingsBooked, meetingTarget: mt?.meetings ?? 0, wonUsd, wonTargetUsd, bounceRate, duplicates } };
      });
    }),
};

/* ---------------- Targets, commission, do-not-contact ---------------- */

export const targetsApi = {
  /** GET /sales/targets */
  get: () =>
    mock(() => {
      const v = getViewer();
      const scope = v.can("sales.targets") ? SALES_PEOPLE : salesScope(v);
      return { daily: dailyTargets().filter((t) => scope.includes(t.empId)), monthly: monthlyTargets().filter((t) => scope.includes(t.empId)) };
    }),

  /** PUT /sales/targets */
  save: (daily: DailyTargets[], monthly: MonthlyTargets[]) =>
    mock(() => {
      const v = getViewer();
      if (!isSalesManager(v)) forbidden("View only. The Director (sales manager) sets targets.");
      daily.forEach((d) => Object.assign(dailyTargets().find((x) => x.empId === d.empId) ?? {}, d));
      monthly.forEach((m) => Object.assign(monthlyTargets().find((x) => x.empId === m.empId) ?? {}, m));
    }),
};

export type CommissionRow = CommissionLine & { companyName: string; dealValue?: Deal["value"] };

export const commissionApi = {
  /** GET /sales/commission */
  get: () =>
    mock(() => {
      const v = getViewer();
      if (!v.can(["sales.commission_view", "sales.commission_approve"])) notFound("Page");
      const rows: CommissionRow[] = commissionLines().map((c) => {
        const d = dealsTable().find((x) => x.id === c.dealId);
        return { ...c, companyName: d ? (companyOf(d.companyId)?.name ?? "—") : "—", dealValue: d?.value };
      });
      return { rules: commissionRules(), lines: rows };
    }),

  /** POST /sales/commission/:id/approve — the Director only; sent to payroll as a bonus line (Module 8) */
  approve: (id: string) =>
    mock(() => {
      const v = getViewer();
      if (!v.can("sales.commission_approve")) forbidden("View only. The Director approves commission.");
      const c = commissionLines().find((x) => x.id === id);
      if (!c) notFound("Commission line");
      if (c.empId === v.employee.empId) forbidden("You can't approve your own commission. Nobody approves their own request.");
      if (!canDecideCommission(v, c)) forbidden("This line isn't waiting for approval.");
      c.status = "sent_to_payroll";
      c.approvedBy = v.employee.empId;
      c.approvedAt = new Date().toISOString();
      c.payrollMonth = monthKey();
    }),

  /** POST /sales/commission/:id/reject { reason } */
  reject: (id: string, reason: string) =>
    mock(() => {
      const v = getViewer();
      if (!v.can("sales.commission_approve")) forbidden("View only. The Director answers commission lines.");
      const c = commissionLines().find((x) => x.id === id);
      if (!c) notFound("Commission line");
      if (!canDecideCommission(v, c)) forbidden(c.empId === v.employee.empId ? "You can't answer your own commission." : "This line isn't waiting for approval.");
      c.status = "rejected";
      c.rejectReason = reason;
      c.approvedBy = v.employee.empId;
      c.approvedAt = new Date().toISOString();
    }),

  /** PATCH /settings/commission-rules/:id { ratePercent, reason } */
  updateRule: (id: string, ratePercent: number) =>
    mock(() => {
      const v = getViewer();
      if (!v.can("sales.commission_approve")) forbidden("View only. The Director sets commission rules.");
      const r = commissionRules().find((x) => x.id === id);
      if (!r) notFound("Rule");
      r.ratePercent = ratePercent;
      r.setBy = v.employee.empId;
      r.effectiveFrom = isoDay(new Date());
    }),
};

export const dncApi = {
  /** GET /sales/do-not-contact */
  list: () => mock(() => { requireSales(); return dncTable(); }),
  /** POST /sales/do-not-contact { email, reason } */
  add: (email: string, reason: string) =>
    mock(() => {
      const v = getViewer();
      requireSales(v);
      if (!canDoSalesWork(v)) forbidden(VIEW_ONLY);
      const e = email.trim().toLowerCase();
      if (!EMAIL_RE.test(e)) throw new ApiError("validation", "Enter a valid email address.");
      if (dncTable().some((d) => d.email === e)) throw new ApiError("validation", "This email is already on the list.");
      const lead = leadsTable().find((l) => l.email === e);
      if (lead) lead.doNotContact = true;
      dncTable().unshift({ id: uid("dnc"), email: e, leadId: lead?.id, reason, addedBy: v.employee.empId, at: new Date().toISOString() });
    }),
};

/** Sales staff (L4) for selects. */
export function salesPeopleOptions() {
  return employeesTable().filter((e) => SALES_PEOPLE.includes(e.empId) && isSalesPerson(e.empId));
}
