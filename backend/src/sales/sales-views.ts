import type { SalesCompanyView, SalesLeadStubView, SalesLeadView, SalesPersonRef } from '@aceva/contracts';
import type { Prisma } from '../generated/prisma/client';

export const companyInclude = {} satisfies Prisma.SalesCompanyInclude;
export type CompanyRow = Prisma.SalesCompanyGetPayload<{ include: typeof companyInclude }>;

export const leadInclude = {
  company: true,
  owner: { select: { id: true, empId: true, fullName: true } },
} satisfies Prisma.SalesLeadInclude;
export type LeadRow = Prisma.SalesLeadGetPayload<{ include: typeof leadInclude }>;

export const person = (e: { empId: string; fullName: string }): SalesPersonRef => ({ empId: e.empId, name: e.fullName });

export function companyView(c: CompanyRow, canEdit: boolean): SalesCompanyView {
  return {
    id: c.id,
    name: c.name,
    website: c.website,
    domain: c.domain,
    country: c.country,
    industry: c.industry,
    partyId: c.partyId,
    archived: c.archivedAt !== null,
    version: c.version,
    createdAt: c.createdAt.toISOString(),
    canEdit,
  };
}

export function leadView(
  l: LeadRow,
  extra: { createdBy: SalesPersonRef | null; canEdit: boolean; canReassign: boolean; companyCanEdit: boolean },
): SalesLeadView {
  return {
    restricted: false,
    id: l.id,
    fullName: l.fullName,
    jobTitle: l.jobTitle,
    company: l.company ? companyView(l.company, extra.companyCanEdit) : null,
    email: l.email,
    phone: l.phone,
    linkedinUrl: l.linkedinUrl,
    country: l.country,
    industry: l.industry,
    source: l.source,
    owner: person(l.owner),
    emailCheck: l.emailCheck,
    emailCheckedAt: l.emailCheckedAt?.toISOString() ?? null,
    notes: l.notes,
    lastActivityAt: l.lastActivityAt.toISOString(),
    archived: l.archivedAt !== null,
    version: l.version,
    createdAt: l.createdAt.toISOString(),
    createdBy: extra.createdBy,
    updatedAt: l.updatedAt.toISOString(),
    canEdit: extra.canEdit,
    canReassign: extra.canReassign,
  };
}

/** Someone else's lead: only that it exists and who owns it. Never the email, phone, notes or anything else. */
export function leadStub(l: LeadRow): SalesLeadStubView {
  return { restricted: true, id: l.id, fullName: l.fullName, companyName: l.company?.name ?? null, owner: person(l.owner) };
}
