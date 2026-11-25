import { describe, expect, it } from "vitest";
import type { SalesDealDetailView, SalesDuplicateCheckView, SalesLeadView } from "@aceva/contracts";
import { activityLoggedMessage, isWebLink, pipelineSummary, STAGE_NOT_CHANGED_TEXT, totalsByCurrency } from "./logic";
import { mapActivity, mapDeal, mapDuplicate, mapFollowUp, mapLead, mapLoggedActivity } from "./live-api";

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
  proposalUrl: null,
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

describe("M15.3 live activities and follow-ups", () => {
  it("keeps who did it, when and the source; a tool entry with no person shows no one", () => {
    const base = { id: "a1", leadId: "l1", dealId: "d1", dealNumber: "DL-2026-0007", kind: "call" as const, source: "manual" as const, at: "2026-12-08T05:00:00.000Z", summary: "First call", meetingAt: null, proposalUrl: null, actor: { empId: "ACV-0009", name: "Hira Baig" }, externalId: null, createdAt: "2026-12-08T05:00:01.000Z" };
    expect(mapActivity(base)).toEqual({ id: "a1", leadId: "l1", dealId: "d1", empId: "ACV-0009", kind: "call", at: "2026-12-08T05:00:00.000Z", source: "manual", externalId: undefined, summary: "First call" });
    expect(mapActivity({ ...base, kind: "proposal", proposalUrl: "https://docs.example.com/p" }).summary).toBe("First call (https://docs.example.com/p)");
    expect(mapActivity({ ...base, source: "apollo", actor: null, externalId: "ap-1" })).toMatchObject({ source: "apollo", empId: "", externalId: "ap-1" });
  });

  it("maps a follow-up with its missed flag and owner", () => {
    expect(mapFollowUp({ dealId: "d1", dealNumber: "DL-2026-0007", companyName: "Acme", leadId: "l1", leadName: "Ayesha", owner: { empId: "ACV-0009", name: "Hira Baig" }, nextStep: "Call", nextStepDate: "2026-12-06", missed: true, wonPending: false }))
      .toEqual({ dealId: "d1", dealNumber: "DL-2026-0007", companyName: "Acme", leadName: "Ayesha", nextStep: "Call", nextStepDate: "2026-12-06", missed: true, ownerEmpId: "ACV-0009" });
  });

  it("accepts only web links for proposals (the server checks the same)", () => {
    expect(isWebLink("https://docs.example.com/proposal")).toBe(true);
    expect(isWebLink("http://example.org/p.pdf")).toBe(true);
    for (const bad of ["", "ftp://example.com/p", "javascript:alert(1)", "docs", "https://localhost/p", `https://x.com/${"a".repeat(500)}`]) expect(isWebLink(bad), bad).toBe(false);
  });
});

describe("M15.3 after logging an activity: whether the deal moved, and why not", () => {
  const entry = { id: "a1", leadId: "l1", dealId: "d1", dealNumber: "DL-2026-0007", kind: "reply" as const, source: "manual" as const, at: "2026-12-08T05:00:00.000Z", summary: "They answered", meetingAt: null, proposalUrl: null, actor: { empId: "ACV-0009", name: "Hira Baig" }, externalId: null, createdAt: "2026-12-08T05:00:01.000Z" };

  it("keeps the server's stage result with the saved entry", () => {
    expect(mapLoggedActivity({ activity: entry, stageChange: null, stageNotChanged: "needs_contacted" })).toMatchObject({ activity: { id: "a1", kind: "reply" }, stageChange: null, stageNotChanged: "needs_contacted" });
  });

  it("says the deal moved only when it did", () => {
    expect(activityLoggedMessage("reply", { stageChange: { from: "contacted", to: "replied" }, stageNotChanged: null })).toEqual({ tone: "success", title: "Reply received logged", description: "The deal moved to Replied." });
    expect(activityLoggedMessage("note", { stageChange: null, stageNotChanged: null })).toEqual({ tone: "success", title: "Note logged" });
  });

  it("explains each reason the stage stayed, in plain words, without the server's codes or a claim that it moved", () => {
    const expected = {
      deal_closed: /already closed/,
      won_pending: /waiting for its Won confirmation/,
      not_forward: /already at this stage or further on/,
      needs_contacted: /still New.*first contact/,
    } as const;
    for (const reason of Object.keys(expected) as (keyof typeof expected)[]) {
      const m = activityLoggedMessage("call", { stageChange: null, stageNotChanged: reason });
      expect(m.tone, reason).toBe("info");
      expect(m.title).toBe("Call logged"); // the activity is saved
      expect(m.description).toMatch(/^Stage not changed\. /);
      expect(m.description).toMatch(expected[reason]);
      expect(m.description).not.toMatch(/moved to|deal_closed|won_pending|not_forward|needs_contacted|_/);
    }
    expect(Object.keys(STAGE_NOT_CHANGED_TEXT).sort()).toEqual(["deal_closed", "needs_contacted", "not_forward", "won_pending"]);
  });
});
