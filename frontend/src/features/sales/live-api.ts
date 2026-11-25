/**
 * Module 15 against the REAL API (NEXT_PUBLIC_LIVE_MODULES contains m15). Same function names and result shapes as the
 * mock in api.ts, so the screens keep working. The server decides everything: who sees a lead in full (own; the team for
 * the sales manager; all), the duplicate check (email; the company's website domain) and who may change or move a lead.
 *
 * M15.1 makes leads and companies live, M15.2 deals and the pipeline, M15.3 activities, follow-ups and proposal links. The
 * import, do-not-contact and email checks arrive with the later parts of Module 15 (and Module 16 for email checks): in live
 * mode those calls say so instead of using demo data.
 */
import type {
  CreateSalesDealRequest, CreateSalesLeadRequest, LogSalesActivityRequest, MoveSalesDealRequest, Page, SalesActivityResult, SalesActivityView, SalesCompanyView,
  SalesDealDetailView, SalesDealHistoryView, SalesDealResult, SalesFollowUpView,
  SalesDealView, SalesDncEntryView, SalesDuplicateCheckView, SalesImportPreviewView, SalesImportResultView, SalesImportRowView, SalesLeadResult, SalesLeadView,
  SalesPipelineSummaryView, SalesReassignmentIssueView, UpdateSalesLeadRequest,
} from "@aceva/contracts";
import { SALES_OPEN_STAGES } from "@aceva/contracts";
import { http } from "@/lib/api/http";
import { ApiError } from "@/lib/api/mock";
import { isoDay, monthKey } from "@/lib/dates";
import type { DealRow, LeadRow, MoveResult } from "./api";
import { totalsByCurrency } from "./logic";
import type {
  Company, Deal, DealDetail, DealStage, DncEntry, DuplicateResult, FollowUp, Handover, ImportPreview, ImportRow, Lead, LeadDetail, LeadSource, LeadStub,
  LogActivityInput, LoggedActivity, NewDealInput, NewLeadInput, ReassignmentIssue,
  PipelineSummary, SalesActivity, StageChange, VerifyPreview, VerifyResult,
} from "./types";

const opt = (v: string | null | undefined) => v ?? undefined;

/** A lead may have no company on the server; the screens always show one. */
const NO_COMPANY: Company = { id: "", name: "—" };

export function mapCompany(c: SalesCompanyView): Company {
  return { id: c.id, name: c.name, website: opt(c.website), domain: opt(c.domain), country: opt(c.country), industry: opt(c.industry) };
}

export function mapLead(v: SalesLeadView): Lead {
  return {
    id: v.id,
    name: v.fullName,
    title: opt(v.jobTitle),
    companyId: v.company?.id ?? "",
    email: opt(v.email),
    phone: opt(v.phone),
    linkedinUrl: opt(v.linkedinUrl),
    country: opt(v.country),
    industry: opt(v.industry),
    source: v.source,
    ownerEmpId: v.owner.empId,
    emailCheck: v.emailCheck,
    checkedAt: opt(v.emailCheckedAt),
    doNotContact: v.doNotContact,
    notes: opt(v.notes),
    lastActivityAt: v.lastActivityAt,
    archived: v.archived,
    archiveInfo: v.archive ? { at: v.archive.at, inactiveMonths: v.archive.inactiveMonths, lastActivityAt: v.archive.lastActivityAt, byJob: v.archive.by === null } : undefined,
    createdAt: v.createdAt,
    version: v.version,
  };
}

function toRow(v: SalesLeadView): LeadRow {
  return { ...mapLead(v), companyName: v.company?.name ?? "—", domain: opt(v.company?.domain) };
}

/** The duplicate check: an email match blocks (one owner, no duplicates); a company match is shown, not blocking (D-8). */
export function mapDuplicate(v: SalesDuplicateCheckView): DuplicateResult {
  const company = v.company ? { name: v.company.name, ownerEmpIds: v.company.leadOwners.map((o) => o.empId) } : undefined;
  if (v.email) return { duplicate: true, matchedOn: "email", leadId: v.email.leadId, ownerEmpId: v.email.owner.empId, company };
  return { duplicate: false, company };
}

const notYet = (what: string): never => {
  throw new ApiError("not_available", `${what} arrives with a later part of the Sales module.`, 501);
};

/** The version the server has now, for screens that do not carry one. */
async function currentVersion(id: string): Promise<number> {
  const lead = await http.get<SalesLeadResult>(`/sales/leads/${id}`);
  if (lead.restricted) throw new ApiError("forbidden", "Only the owner or the sales manager changes this lead.", 403);
  return lead.version;
}

/** The leads service both the mock (api.ts) and the real API provide. */
export interface LeadsApi {
  list(): Promise<LeadRow[]>;
  get(id: string): Promise<LeadDetail | LeadStub>;
  checkDuplicate(input: { email?: string; website?: string }): Promise<DuplicateResult>;
  create(input: NewLeadInput): Promise<Lead>;
  update(id: string, patch: Partial<Pick<Lead, "notes" | "phone" | "title" | "linkedinUrl">>, version?: number): Promise<void>;
  reassign(id: string, empId: string, reason?: string, version?: number): Promise<void>;
  markDoNotContact(id: string, reason: string): Promise<void>;
  importPreview(csv: string, source: LeadSource): Promise<ImportPreview>;
  importCommit(batchId: string, rows: ImportRow[]): Promise<{ imported: number; skipped: number }>;
  verifyPreview(): Promise<VerifyPreview>;
  verify(): Promise<VerifyResult>;
}

const PAGE = 200;
const MAX_ROWS = 5000;

export const liveLeadsApi: LeadsApi = {
  /** GET /sales/leads (every page the caller may see) */
  async list(): Promise<LeadRow[]> {
    const out: LeadRow[] = [];
    for (let page = 1; out.length < MAX_ROWS; page++) {
      const res = await http.get<Page<SalesLeadView>>("/sales/leads", { page, pageSize: PAGE });
      out.push(...res.items.map(toRow));
      if (out.length >= res.total || !res.items.length) break;
    }
    return out;
  },

  /** GET /sales/leads/:id: in full, or only that it exists and who owns it. */
  async get(id: string): Promise<LeadDetail | LeadStub> {
    const v = await http.get<SalesLeadResult>(`/sales/leads/${id}`);
    if (v.restricted) return { id: v.id, name: v.fullName, companyName: v.companyName ?? "—", ownerEmpId: v.owner.empId, restricted: true };
    const [deals, activities] = await Promise.all([allDeals({ leadId: v.id }), http.get<SalesActivityView[]>(`/sales/leads/${v.id}/activities`)]);
    return { lead: mapLead(v), company: v.company ? mapCompany(v.company) : NO_COMPANY, activities: activities.map(mapActivity), deals: deals.map(mapDeal) };
  },

  /** POST /sales/leads/check-duplicate */
  async checkDuplicate(input: { email?: string; website?: string }): Promise<DuplicateResult> {
    const body = { email: input.email?.trim() || undefined, website: input.website?.trim() || undefined };
    if (!body.email && !body.website) return { duplicate: false };
    return mapDuplicate(await http.post<SalesDuplicateCheckView>("/sales/leads/check-duplicate", body));
  },

  /** POST /sales/leads (409 duplicate_lead names the owner) */
  async create(input: NewLeadInput): Promise<Lead> {
    const body: CreateSalesLeadRequest = {
      fullName: input.name,
      jobTitle: input.title || undefined,
      email: input.email || undefined,
      phone: input.phone || undefined,
      linkedinUrl: input.linkedinUrl || undefined,
      country: input.country || undefined,
      industry: input.industry || undefined,
      source: input.source,
      notes: input.notes || undefined,
      company: { name: input.companyName, website: input.website || undefined, country: input.country || undefined, industry: input.industry || undefined },
    };
    return mapLead(await http.post<SalesLeadView>("/sales/leads", body));
  },

  /** PATCH /sales/leads/:id (the version the screen read; otherwise the current one) */
  async update(id: string, patch: Partial<Pick<Lead, "notes" | "phone" | "title" | "linkedinUrl">>, version?: number): Promise<void> {
    const body: UpdateSalesLeadRequest = { version: version ?? (await currentVersion(id)) };
    if (patch.notes !== undefined) body.notes = patch.notes || null;
    if (patch.phone !== undefined) body.phone = patch.phone || null;
    if (patch.title !== undefined) body.jobTitle = patch.title || null;
    if (patch.linkedinUrl !== undefined) body.linkedinUrl = patch.linkedinUrl || null;
    await http.patch<SalesLeadView>(`/sales/leads/${id}`, body);
  },

  /** POST /sales/leads/:id/owner: the sales manager moves a lead (reason required, logged) */
  async reassign(id: string, empId: string, reason?: string, version?: number): Promise<void> {
    if (!reason?.trim()) throw new ApiError("validation", "Give a reason for moving the lead.", 400);
    await http.post<SalesLeadView>(`/sales/leads/${id}/owner`, { toEmpId: empId, reason: reason.trim(), version: version ?? (await currentVersion(id)) });
  },

  /** POST /sales/leads/:id/do-not-contact (the owner, or the sales manager). Never removed. */
  async markDoNotContact(id, reason) {
    await http.post<SalesLeadResult>(`/sales/leads/${id}/do-not-contact`, { reason });
  },

  /** POST /sales/leads/import/preview: the CSV is checked on the server; nothing is added yet. */
  async importPreview(csv, source) {
    const form = new FormData();
    form.append("source", source);
    form.append("file", new Blob([csv], { type: "text/csv" }), "leads.csv");
    const v = await http.upload<SalesImportPreviewView>("/sales/leads/import/preview", form);
    return { batchId: v.batchId, rows: v.rows.map(mapImportRow) };
  },

  /** POST /sales/leads/import/:batchId/commit: adds the rows that are still good (once). */
  async importCommit(batchId) {
    const r = await http.post<SalesImportResultView>(`/sales/leads/import/${batchId}/commit`);
    return { imported: r.created, skipped: r.skipped.length };
  },
  verifyPreview: async () => notYet("Checking emails (Module 16)"),
  verify: async () => notYet("Checking emails (Module 16)"),
};

/* ---------------- M15.2: deals and the pipeline ---------------- */

/** The deals service both the mock (api.ts) and the real API provide. */
export interface DealsApi {
  list(): Promise<DealRow[]>;
  get(id: string): Promise<DealDetail>;
  create(input: NewDealInput): Promise<Deal>;
  move(id: string, stage: DealStage, reason?: string, version?: number): Promise<MoveResult>;
  confirmWon(id: string): Promise<Handover>;
  rejectWon(id: string, reason: string): Promise<void>;
  decideWonException(id: string, decision: "confirm" | "send_back", reason: string): Promise<void>;
  setNextStep(id: string, nextStep: string, nextStepDate: string): Promise<void>;
  setProposal(id: string, url: string): Promise<void>;
  followUpDone(id: string, summary: string, nextStep: string, nextStepDate: string): Promise<void>;
  summary(): Promise<PipelineSummary>;
}

/** What each history row says on the timeline (the screens show "Moved to <stage>" and the note). */
function historyRow(h: SalesDealHistoryView): StageChange {
  const by = h.by?.empId ?? "system";
  switch (h.event) {
    case "created":
      return { stage: h.toStage, at: h.at, by, note: "Deal added" };
    case "won_requested":
      return { stage: "won", at: h.at, by, note: "Marked as Won, waiting for confirmation" };
    case "won_rejected":
      return { stage: h.toStage, at: h.at, by, note: `Won not confirmed${h.reason ? `: ${h.reason}` : ""}` };
    case "won_confirmed":
      return { stage: "won", at: h.at, by, note: "Won confirmed" };
    case "owner_changed":
      return { stage: h.toStage, at: h.at, by, note: `Owner changed${h.note ? ` (${h.note})` : ""}${h.reason ? `: ${h.reason}` : ""}` };
    default:
      return { stage: h.toStage, at: h.at, by, note: [h.reason, h.note].filter(Boolean).join(" · ") || undefined };
  }
}

/**
 * A server deal in the screens' shape. The server keeps a pending Won request in the deal's real stage; the screens show
 * it in the Won column as "waiting for confirmation" (stage won, wonStatus pending, previousStage the real stage).
 */
export function mapDeal(v: SalesDealView | SalesDealDetailView): Deal {
  const pending = v.wonStatus === "pending";
  const detail = "history" in v ? v : null;
  return {
    id: v.id,
    number: v.number,
    leadId: v.leadId,
    companyId: v.company.id,
    service: v.service,
    value: { amount: v.value, currency: v.currency },
    expectedClose: v.expectedClose,
    stage: pending ? "won" : v.stage,
    previousStage: pending ? v.stage : undefined,
    nextStep: opt(v.nextStep),
    nextStepDate: opt(v.nextStepDate),
    ownerEmpId: v.owner.empId,
    proposalUrl: opt(v.proposalUrl),
    lostReason: opt(v.lostReason),
    recontactAfter: opt(v.recontactAfter),
    wonStatus: v.wonStatus === "none" ? undefined : v.wonStatus,
    wonRequestedAt: opt(v.wonRequestedAt),
    wonConfirmedBy: v.wonConfirmedBy?.empId,
    // Module 13 makes the draft invoice from the Won event; until its reader has, there is no number to show yet.
    handover:
      v.wonStatus === "confirmed"
        ? { clientName: v.company.name, invoiceNumber: detail?.handover?.status === "drafted" ? "Draft created" : detail?.handover?.status === "needs_client" ? "Finance chooses the client" : "", ctoNotified: false, at: v.wonConfirmedAt ?? v.updatedAt }
        : undefined,
    history: detail ? detail.history.map(historyRow) : [],
    createdAt: v.createdAt,
    updatedAt: v.closedAt ?? v.updatedAt,
    version: v.version,
    canDecideWon: v.canDecideWon,
  };
}

/** The screens pass dates as ISO date-times (local noon); the server takes the calendar day. */
const toDay = (value: string): string => (/^\d{4}-\d{2}-\d{2}$/.test(value) ? value : isoDay(new Date(value)));

const toDealRow = (v: SalesDealView): DealRow => ({ ...mapDeal(v), companyName: v.company.name, leadName: v.leadName });

async function dealVersion(id: string): Promise<number> {
  const d = await http.get<SalesDealResult>(`/sales/deals/${id}`);
  if (d.restricted) throw new ApiError("forbidden", "Only the owner or the sales manager works on this deal.", 403);
  return d.version;
}

async function allDeals(params: Record<string, string> = {}): Promise<SalesDealView[]> {
  const out: SalesDealView[] = [];
  for (let page = 1; out.length < MAX_ROWS; page++) {
    const res = await http.get<Page<SalesDealView>>("/sales/deals", { ...params, page, pageSize: PAGE });
    out.push(...res.items);
    if (out.length >= res.total || !res.items.length) break;
  }
  return out;
}

export const liveDealsApi: DealsApi = {
  /** GET /sales/deals (every page the caller may see) */
  async list() {
    return (await allDeals()).map(toDealRow);
  },

  /** GET /sales/deals/:id, with its lead and its timeline (commission arrives with M15.7) */
  async get(id) {
    const v = await http.get<SalesDealResult>(`/sales/deals/${id}`);
    if (v.restricted) throw new ApiError("not_found", "This deal belongs to someone else.", 404);
    const [lead, activities] = await Promise.all([http.get<SalesLeadResult>(`/sales/leads/${v.leadId}`), http.get<SalesActivityView[]>(`/sales/deals/${v.id}/activities`)]);
    const company: Company = lead.restricted || !lead.company ? { id: v.company.id, name: v.company.name } : mapCompany(lead.company);
    const leadView: Lead = lead.restricted
      ? { id: lead.id, name: lead.fullName, companyId: v.company.id, source: "referral", ownerEmpId: lead.owner.empId, emailCheck: "unchecked", doNotContact: false, archived: false, createdAt: v.createdAt }
      : mapLead(lead);
    return { deal: { ...mapDeal(v), wonExceptionEligible: v.wonExceptionEligible }, lead: leadView, company, activities: activities.map(mapActivity) };
  },

  /** POST /sales/deals (it starts in New, with its next step) */
  async create(input) {
    const body: CreateSalesDealRequest = {
      leadId: input.leadId,
      service: input.service,
      value: Number(input.value.amount).toFixed(2),
      currency: input.value.currency,
      expectedClose: toDay(input.expectedClose),
      nextStep: input.nextStep,
      nextStepDate: toDay(input.nextStepDate),
    };
    return mapDeal(await http.post<SalesDealDetailView>("/sales/deals", body));
  },

  /** POST /sales/deals/:id/move, or /request-won for Won (the sales manager confirms it) */
  async move(id, stage, reason, version) {
    const v = version ?? (await dealVersion(id));
    if (stage === "won") {
      await http.post<SalesDealDetailView>(`/sales/deals/${id}/request-won`, { version: v });
      return { stage, pending: true, confirmer: "The sales manager" };
    }
    // The reason dialog gives "<reason>" or "<reason>: <note>": the reason is the one chosen from the settings list.
    const [lostReason, ...rest] = (reason ?? "").split(": ");
    const note = rest.join(": ").trim();
    const body: MoveSalesDealRequest = stage === "lost" ? { toStage: "lost", lostReason, ...(note ? { note } : {}), version: v } : { toStage: stage, version: v };
    const res = await http.post<SalesDealDetailView>(`/sales/deals/${id}/move`, body);
    return { stage, recontactAfter: opt(res.recontactAfter) };
  },

  /** POST /sales/deals/:id/confirm-won (Module 13 then makes the draft invoice from the event) */
  async confirmWon(id) {
    const res = await http.post<SalesDealDetailView>(`/sales/deals/${id}/confirm-won`, { version: await dealVersion(id) });
    return mapDeal(res).handover!;
  },

  /** POST /sales/deals/:id/reject-won */
  async rejectWon(id, reason) {
    await http.post<SalesDealDetailView>(`/sales/deals/${id}/reject-won`, { reason, version: await dealVersion(id) });
  },

  /** POST /sales/deals/:id/won-exception (the Owner; a reason and a fresh step-up are required) */
  async decideWonException(id, decision, reason) {
    await http.post<SalesDealDetailView>(`/sales/deals/${id}/won-exception`, { decision, reason, version: await dealVersion(id) });
  },

  /** PATCH /sales/deals/:id */
  async setNextStep(id, nextStep, nextStepDate) {
    await http.patch<SalesDealDetailView>(`/sales/deals/${id}`, { nextStep, nextStepDate: toDay(nextStepDate), version: await dealVersion(id) });
  },

  /** A proposal link is a proposal activity on the deal: it becomes the deal's link and moves it to Proposal sent (forward only). */
  async setProposal(id, url) {
    const d = await http.get<SalesDealResult>(`/sales/deals/${id}`);
    if (d.restricted) throw new ApiError("forbidden", "Only the owner or the sales manager works on this deal.", 403);
    const body: LogSalesActivityRequest = { kind: "proposal", summary: "Proposal linked", proposalUrl: url.trim() };
    await http.post<SalesActivityResult>(`/sales/deals/${id}/activities`, body);
  },

  /** POST /sales/deals/:id/follow-up: the follow-up is done (an activity) and the next step is set. */
  async followUpDone(id, summary, nextStep, nextStepDate) {
    await http.post<SalesDealDetailView>(`/sales/deals/${id}/follow-up`, { summary: summary.trim() || undefined, nextStep, nextStepDate: toDay(nextStepDate), version: await dealVersion(id) });
  },

  /**
   * The server's summary (GET /sales/deals/summary) is the authority for each stage's count and totals, per original
   * currency. Nothing is converted: the USD fields stay 0 and `totals` carries the amounts. This month's Won and Lost
   * deals come from the deal list, also per currency.
   */
  async summary() {
    const [server, deals] = await Promise.all([http.get<SalesPipelineSummaryView>("/sales/deals/summary"), allDeals()]);
    const money = (totals: { currency: "PKR" | "USD"; value: string }[]) => totals.map((t) => ({ amount: t.value, currency: t.currency }));
    const isOpen = (stage: string) => (SALES_OPEN_STAGES as readonly string[]).includes(stage);
    const month = monthKey();
    const closedThisMonth = (d: SalesDealView) => !!d.closedAt && monthKey(d.closedAt) === month;
    const won = deals.filter((d) => d.stage === "won" && closedThisMonth(d));
    const openStages = server.stages.filter((s) => isOpen(s.stage));
    return {
      stages: server.stages.map((s) => ({ stage: s.stage, count: s.count, valueUsd: 0, totals: money(s.totals) })),
      openValueUsd: 0,
      openCount: openStages.reduce((n, s) => n + s.count, 0),
      wonThisMonthUsd: 0,
      wonThisMonthCount: won.length,
      lostThisMonthCount: deals.filter((d) => d.stage === "lost" && closedThisMonth(d)).length,
      pendingWonCount: server.pendingWonCount,
      totals: { open: totalsByCurrency(openStages.flatMap((s) => money(s.totals))), wonThisMonth: totalsByCurrency(won.map((d) => ({ amount: d.value, currency: d.currency }))) },
    };
  },
};

/* ---------------- M15.3: activities and follow-ups ---------------- */

/** A server activity in the screens' shape (who did it, when, and whether it was typed in by hand or came from a tool). */
export function mapActivity(v: SalesActivityView): SalesActivity {
  return {
    id: v.id,
    leadId: v.leadId,
    dealId: opt(v.dealId),
    empId: v.actor?.empId ?? "",
    kind: v.kind,
    at: v.at,
    source: v.source,
    externalId: opt(v.externalId),
    summary: v.proposalUrl ? `${v.summary} (${v.proposalUrl})` : v.meetingAt ? `${v.summary} (meeting on ${new Date(v.meetingAt).toLocaleString("en-GB", { dateStyle: "medium", timeStyle: "short" })})` : v.summary,
  };
}

export function mapFollowUp(v: SalesFollowUpView): FollowUp {
  return { dealId: v.dealId, dealNumber: v.dealNumber, companyName: v.companyName, leadName: v.leadName, nextStep: v.nextStep, nextStepDate: v.nextStepDate, missed: v.missed, ownerEmpId: v.owner.empId };
}

export interface ActivitiesApi {
  log(input: LogActivityInput): Promise<LoggedActivity>;
}

/** The server's answer to a logged activity: the entry, and what it did (or why it did not) to the deal's stage. */
export function mapLoggedActivity(r: SalesActivityResult): LoggedActivity {
  return { activity: mapActivity(r.activity), stageChange: r.stageChange, stageNotChanged: r.stageNotChanged };
}

export const liveActivitiesApi: ActivitiesApi = {
  /** POST /sales/deals/:id/activities or /sales/leads/:id/activities (a contact on a deal moves it forward only) */
  async log(input) {
    const body: LogSalesActivityRequest = {
      kind: input.kind as LogSalesActivityRequest["kind"],
      summary: input.summary,
      at: input.at,
      ...(input.kind === "meeting" && input.meetingAt ? { meetingAt: input.meetingAt } : {}),
      ...(input.kind === "proposal" && input.proposalUrl ? { proposalUrl: input.proposalUrl.trim() } : {}),
    };
    const path = input.dealId ? `/sales/deals/${input.dealId}/activities` : `/sales/leads/${input.leadId}/activities`;
    return mapLoggedActivity(await http.post<SalesActivityResult>(path, body));
  },
};

/** GET /sales/follow-ups: the caller's due and missed follow-ups, or one team member's (sales manager). */
export async function liveFollowUps(ownerEmpId?: string): Promise<FollowUp[]> {
  const rows = await http.get<SalesFollowUpView[]>("/sales/follow-ups", ownerEmpId ? { scope: "team", owner: ownerEmpId } : { scope: "mine" });
  return rows.map(mapFollowUp);
}

/* ---------------- M15.4: the lead import and the do-not-contact list ---------------- */

export function mapImportRow(v: SalesImportRowView): ImportRow {
  return {
    line: v.line,
    name: v.name,
    email: v.email ?? "",
    companyName: v.companyName ?? "",
    website: opt(v.website),
    country: opt(v.country),
    title: opt(v.title),
    source: v.source ?? undefined,
    status: v.status,
    message: v.problems.length ? v.problems.join(" ") : undefined,
    ownerEmpId: v.owner?.empId,
  };
}

/** A list entry as the screens show it: the email stays masked ("a***@domain.com"); the list never has the real email. */
export function mapDncEntry(v: SalesDncEntryView): DncEntry {
  return { id: v.id, email: v.maskedEmail ?? "No email (marked on the lead)", leadId: v.lead?.id, reason: v.reason, addedBy: v.addedBy?.empId ?? "", at: v.addedAt };
}

export interface DncApi {
  list(): Promise<DncEntry[]>;
  add(email: string, reason: string): Promise<void>;
}

export const liveDncApi: DncApi = {
  /** GET /sales/do-not-contact (the sales manager; the CEO / Owner views) */
  async list() {
    const page = await http.get<Page<SalesDncEntryView>>("/sales/do-not-contact", { page: 1, pageSize: PAGE });
    return page.items.map(mapDncEntry);
  },
  /** POST /sales/do-not-contact (the sales manager only) */
  async add(email, reason) {
    await http.post<SalesDncEntryView>("/sales/do-not-contact", { email, reason });
  },
};

/* ---------------- M15.5: leavers' leads waiting for an owner ---------------- */

export function mapReassignmentIssue(v: SalesReassignmentIssueView): ReassignmentIssue {
  return { id: v.id, empId: v.employee.empId, name: v.employee.name, detail: v.detail, openLeads: v.openLeads, openDeals: v.openDeals, since: v.createdAt };
}

/** GET /sales/reassignment-issues (the sales manager; the CEO / Owner views). */
export async function liveReassignmentIssues(): Promise<ReassignmentIssue[]> {
  return (await http.get<SalesReassignmentIssueView[]>("/sales/reassignment-issues")).map(mapReassignmentIssue);
}
