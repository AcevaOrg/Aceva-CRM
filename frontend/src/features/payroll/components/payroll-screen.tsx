"use client";
import { useCan } from "@/lib/auth/viewer";
import { MyPayslips } from "./my-payslips";
import { RunsOverview } from "./runs-overview";

/** /payroll: Finance (prepares), the Director (approves) and the CEO / Founder / Owner (views) see runs; the CTO, Sales and Engineering see only their own payslips (spec §9.8). */
export function PayrollScreen() {
  const canView = useCan("payroll.view");
  return canView ? <RunsOverview /> : <MyPayslips />;
}
