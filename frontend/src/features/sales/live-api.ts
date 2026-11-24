/**
 * Module 15 against the REAL API (NEXT_PUBLIC_LIVE_MODULES contains m15). Same function names and result shapes as the
 * mock in api.ts, so the screens keep working. The server decides everything: who sees a lead in full (own; the team for
 * the sales manager; all), the duplicate check (email; the company's website domain) and who may change or move a lead.
 *
 * M15.1 makes leads and companies live. Activities, deals, the import, do-not-contact and email checks arrive with the
 * later parts of Module 15 (and Module 16 for email checks): in live mode those calls say so instead of using demo data.
 */
import type {
  CreateSalesLeadRequest, Page, SalesCompanyView, SalesDuplicateCheckView, SalesLeadResult, SalesLeadView, UpdateSalesLeadRequest,
} from "@aceva/contracts";
import { http } from "@/lib/api/http";
import { ApiError } from "@/lib/api/mock";
import type { LeadRow } from "./api";
import type { Company, DuplicateResult, ImportRow, Lead, LeadDetail, LeadStub, NewLeadInput, VerifyPreview, VerifyResult } from "./types";

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
    // The do-not-contact list arrives with M15.4.
    doNotContact: false,
    notes: opt(v.notes),
    lastActivityAt: v.lastActivityAt,
    archived: v.archived,
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
  importPreview(csv: string): Promise<ImportRow[]>;
  importCommit(rows: ImportRow[]): Promise<{ imported: number }>;
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
    // Activities and deals arrive with M15.2 and M15.3.
    return { lead: mapLead(v), company: v.company ? mapCompany(v.company) : NO_COMPANY, activities: [], deals: [] };
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

  markDoNotContact: async () => notYet("The do-not-contact list"),
  importPreview: async () => notYet("Importing leads"),
  importCommit: async () => notYet("Importing leads"),
  verifyPreview: async () => notYet("Checking emails (Module 16)"),
  verify: async () => notYet("Checking emails (Module 16)"),
};
