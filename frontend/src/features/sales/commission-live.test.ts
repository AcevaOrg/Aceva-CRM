import { describe, expect, it } from "vitest";
import { collectedText, commissionAmountText, commissionStatusText, waitingFor } from "./commission-live";

const none = { approve: false, reject: false, hold: false, decideLeaver: false };

describe("M15.7 commission display rules", () => {
  it("a line waiting for a rate shows no amount, never zero; others show PKR", () => {
    expect(commissionAmountText({ amount: null })).toBe("Waiting for a rate");
    expect(commissionAmountText({ amount: "1234.57" })).toBe("PKR 1,234.57");
  });

  it("the collected value stays in the invoice's currency; USD also shows its PKR value at the payments' rates", () => {
    expect(collectedText({ invoiceCurrency: "PKR", collectedBase: "8000.00", basePkr: "8000.00" })).toBe("PKR 8,000.00");
    expect(collectedText({ invoiceCurrency: "USD", collectedBase: "1000.00", basePkr: "280357.15" })).toBe("USD 1,000.00 (PKR 280,357.15 at the payments' rates)");
  });

  it("a hold says why; other statuses use their labels", () => {
    expect(commissionStatusText({ status: "held", hold: { reason: "earner_left", note: null, by: null, at: "2026-12-01T00:00:00.000Z" } })).toBe("On hold: the earner left");
    expect(commissionStatusText({ status: "held", hold: { reason: "manual", note: "Refund", by: null, at: "2026-12-01T00:00:00.000Z" } })).toBe("On hold");
    expect(commissionStatusText({ status: "calculated", hold: null })).toBe("Waiting for approval");
    expect(commissionStatusText({ status: "included", hold: null })).toBe("In payroll");
  });

  it("explains who decides when the viewer cannot act; nothing when they can", () => {
    expect(waitingFor({ status: "calculated", hold: null, can: none }, true)).toBe("Nobody decides their own commission");
    expect(waitingFor({ status: "held", hold: { reason: "earner_left", note: null, by: null, at: "x" }, can: none }, false)).toBe("With the Owner (final settlement)");
    expect(waitingFor({ status: "calculated", hold: null, can: none }, false)).toBe("With the approver");
    expect(waitingFor({ status: "calculated", hold: null, can: { ...none, approve: true } }, false)).toBeNull();
    expect(waitingFor({ status: "rejected", hold: null, can: none }, false)).toBeNull();
  });
});
