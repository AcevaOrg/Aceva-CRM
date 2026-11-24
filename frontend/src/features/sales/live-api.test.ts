import { describe, expect, it } from "vitest";
import type { SalesDuplicateCheckView, SalesLeadView } from "@aceva/contracts";
import { mapDuplicate, mapLead } from "./live-api";

const view: SalesLeadView = {
  restricted: false,
  id: "8f2d0e7c-1111-4222-8333-444455556666",
  fullName: "Ayesha Khan",
  jobTitle: null,
  company: { id: "c1", name: "Acme", website: "acme.com", domain: "acme.com", country: null, industry: null, partyId: null, archived: false, version: 1, createdAt: "2026-12-07T05:00:00.000Z", canEdit: true },
  email: "ayesha@acme.com",
  phone: null,
  linkedinUrl: null,
  country: "United Kingdom",
  industry: null,
  source: "linkedin",
  owner: { empId: "ACV-0009", name: "Hira Baig" },
  emailCheck: "unchecked",
  emailCheckedAt: null,
  notes: null,
  lastActivityAt: "2026-12-07T05:00:00.000Z",
  archived: false,
  version: 3,
  createdAt: "2026-12-07T05:00:00.000Z",
  createdBy: { empId: "ACV-0009", name: "Hira Baig" },
  updatedAt: "2026-12-07T05:00:00.000Z",
  canEdit: true,
  canReassign: false,
};

describe("M15.1 live mapping", () => {
  it("maps a server lead to the screens' lead, keeping the version for the next edit", () => {
    expect(mapLead(view)).toMatchObject({ id: view.id, name: "Ayesha Khan", companyId: "c1", ownerEmpId: "ACV-0009", source: "linkedin", version: 3, title: undefined, phone: undefined });
  });

  it("an email match blocks (one owner, no duplicates); a company match is only shown", () => {
    const company = { companyId: "c1", name: "Acme", leadOwners: [{ empId: "ACV-0012", name: "Kamran Javed" }] };
    const byEmail: SalesDuplicateCheckView = { email: { leadId: "l1", owner: { empId: "ACV-0012", name: "Kamran Javed" }, mine: false, canOpen: false }, domain: "acme.com", sharedDomain: false, company };
    expect(mapDuplicate(byEmail)).toEqual({ duplicate: true, matchedOn: "email", leadId: "l1", ownerEmpId: "ACV-0012", company: { name: "Acme", ownerEmpIds: ["ACV-0012"] } });
    const byCompany: SalesDuplicateCheckView = { email: null, domain: "acme.com", sharedDomain: false, company };
    expect(mapDuplicate(byCompany)).toEqual({ duplicate: false, company: { name: "Acme", ownerEmpIds: ["ACV-0012"] } });
    expect(mapDuplicate({ email: null, domain: null, sharedDomain: true, company: null })).toEqual({ duplicate: false, company: undefined });
  });
});
