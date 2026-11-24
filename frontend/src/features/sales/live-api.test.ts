import { describe, expect, it } from "vitest";
import type { SalesDealDetailView, SalesDuplicateCheckView, SalesLeadView } from "@aceva/contracts";
import { pipelineSummary, totalsByCurrency } from "./logic";
import { mapDeal, mapDuplicate, mapLead } from "./live-api";

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

const deal: SalesDealDetailView = {
  restricted: false,
  id: "d1",
  number: "DL-2026-0007",
  leadId: view.id,
  leadName: "Ayesha Khan",
  company: { id: "c1", name: "Acme", partyId: null },
  owner: { empId: "ACV-0009", name: "Hira Baig" },
  service: "website",
  value: "2500.00",
  currency: "USD",
  expectedClose: "2026-12-31",
  stage: "negotiation",
  nextStep: "Sign",
  nextStepDate: "2026-12-10",
  lostReason: null,
  lostNote: null,
  recontactAfter: null,
  wonStatus: "pending",
  wonRequestedAt: "2026-12-08T05:00:00.000Z",
  wonRequestedBy: { empId: "ACV-0009", name: "Hira Baig" },
  wonConfirmedAt: null,
  wonConfirmedBy: null,
  closedAt: null,
  version: 6,
  createdAt: "2026-12-07T05:00:00.000Z",
  updatedAt: "2026-12-08T05:00:00.000Z",
  canEdit: false,
  canDecideWon: true,
  history: [
    { event: "created", fromStage: null, toStage: "new", by: { empId: "ACV-0009", name: "Hira Baig" }, at: "2026-12-07T05:00:00.000Z", reason: null, note: null },
    { event: "stage_changed", fromStage: "new", toStage: "negotiation", by: { empId: "ACV-0009", name: "Hira Baig" }, at: "2026-12-07T06:00:00.000Z", reason: null, note: null },
    { event: "won_requested", fromStage: "negotiation", toStage: "negotiation", by: { empId: "ACV-0009", name: "Hira Baig" }, at: "2026-12-08T05:00:00.000Z", reason: null, note: null },
  ],
  handover: null,
};

describe("M15.2 live deal mapping", () => {
  it("a pending Won request shows in the Won column, waiting, with its real stage kept; the server's decision right is kept", () => {
    expect(mapDeal(deal)).toMatchObject({ stage: "won", wonStatus: "pending", previousStage: "negotiation", value: { amount: "2500.00", currency: "USD" }, version: 6, canDecideWon: true, handover: undefined });
    expect(mapDeal(deal).history.map((h) => [h.stage, h.note])).toEqual([
      ["new", "Deal added"],
      ["negotiation", undefined],
      ["won", "Marked as Won, waiting for confirmation"],
    ]);
  });

  it("a confirmed Won deal shows the Module 13 handover only once Billing has made the draft; a lost deal keeps its reason", () => {
    const confirmed = { ...deal, stage: "won" as const, wonStatus: "confirmed" as const, wonConfirmedAt: "2026-12-08T06:00:00.000Z", closedAt: "2026-12-08T06:00:00.000Z" };
    expect(mapDeal(confirmed).handover).toMatchObject({ clientName: "Acme", invoiceNumber: "", ctoNotified: false });
    expect(mapDeal({ ...confirmed, handover: { status: "drafted", invoiceId: "i1" } }).handover?.invoiceNumber).toBe("Draft created");
    const lost = mapDeal({ ...deal, stage: "lost", wonStatus: "none", lostReason: "Price", recontactAfter: "2027-06-08", closedAt: "2026-12-08T06:00:00.000Z", history: [] });
    expect(lost).toMatchObject({ stage: "lost", wonStatus: undefined, lostReason: "Price", recontactAfter: "2027-06-08" });
  });

  it("the pipeline summary built from live deals counts the pending request as waiting", () => {
    const summary = pipelineSummary([mapDeal(deal)]);
    expect(summary.pendingWonCount).toBe(1);
    expect(summary.stages.find((s) => s.stage === "won")?.count).toBe(1);
  });
});

describe("M15.2 live totals: per original currency, never converted", () => {
  it("adds PKR and USD separately, in exact cents", () => {
    expect(totalsByCurrency([
      { amount: "0.10", currency: "USD" },
      { amount: "0.20", currency: "USD" },
      { amount: "250000.00", currency: "PKR" },
      { amount: "1200.55", currency: "USD" },
    ])).toEqual([
      { amount: "250000.00", currency: "PKR" },
      { amount: "1200.85", currency: "USD" },
    ]);
    expect(totalsByCurrency([])).toEqual([]);
  });
});
