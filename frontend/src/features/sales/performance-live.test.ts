import { describe, expect, it } from "vitest";
import { currencyLines, dayResult, metricText, money, NOT_MEASURED, selfReportedTotal } from "./performance-live";

describe("M15.6 display rules", () => {
  it("never shows an unmeasured metric as zero", () => {
    expect(metricText({ value: null, measured: false, target: 5, met: null })).toBe(NOT_MEASURED);
    expect(metricText({ value: 0, measured: false, target: null, met: null })).toBe(NOT_MEASURED); // measured flag wins
    expect(metricText({ value: 3, measured: true, target: 5, met: false })).toBe("3 / 5");
    expect(metricText({ value: 0, measured: true, target: null, met: null })).toBe("0");
  });

  it("names the day's result: met, not met, or no targets set (never counted as met)", () => {
    expect(dayResult(true)).toEqual({ label: "Targets met", tone: "success" });
    expect(dayResult(false)).toEqual({ label: "Targets not met", tone: "warning" });
    expect(dayResult(null)).toEqual({ label: "No targets set", tone: "neutral" });
  });

  it("lists money per currency and never adds USD and PKR together", () => {
    expect(currencyLines([{ currency: "PKR", total: "250000.00", count: 1 }, { currency: "USD", total: "1000.00", count: 2 }])).toEqual(["PKR 250,000.00", "USD 1,000.00"]);
    expect(currencyLines([])).toEqual(["—"]);
    expect(money("1234.5", "USD")).toBe("USD 1,234.50");
  });

  it("adds up the self-reported counts", () => {
    expect(selfReportedTotal({ linkedin: 4, whatsapp: 1, fiverr: 0, calls: 2, fieldVisits: 1 })).toBe(8);
  });
});
