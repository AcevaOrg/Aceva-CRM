"use client";
import { useCan } from "@/lib/auth/viewer";
import { MyPayslips } from "./my-payslips";
import { RunsOverview } from "./runs-overview";

/** /payroll: finance and management see runs; everyone else sees their own payslips (spec §9.8). */
export function PayrollScreen() {
  const canView = useCan("payroll.view");
  return canView ? <RunsOverview /> : <MyPayslips />;
}
