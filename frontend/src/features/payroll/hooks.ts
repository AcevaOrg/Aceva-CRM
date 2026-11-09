"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth/session";
import { useCan } from "@/lib/auth/viewer";
import { payrollApi, type RunAction } from "./api";
import type { NewAdvanceInput } from "./types";

export const payrollKeys = {
  all: ["payroll"] as const,
  runs: (empId: string | null) => ["payroll", "runs", empId] as const,
  run: (id: string) => ["payroll", "run", id] as const,
  payslips: (empId: string | null, target?: string) => ["payroll", "payslips", empId, target] as const,
  advances: (empId: string | null) => ["payroll", "advances", empId] as const,
};

/**
 * True for the person who prepares payroll: Finance (payroll.prepare). The Director approves and never
 * prepares (the maker can't also be the checker); the CEO / Founder / Owner only views.
 */
export function useCanPreparePayroll() {
  return useCan("payroll.prepare");
}

/**
 * Payroll runs, newest first (people with payroll.view only).
 * Returns PayrollRun[]: { id, number, month, stage, totals: { gross, deductions, tax, net }, headcount, chain, … }.
 */
export function usePayrollRuns() {
  const empId = useSession((s) => s.empId);
  const allowed = useCan("payroll.view");
  return useQuery({ queryKey: payrollKeys.runs(empId), queryFn: payrollApi.listRuns, enabled: !!empId && allowed });
}

export function usePayrollRun(id: string) {
  return useQuery({ queryKey: payrollKeys.run(id), queryFn: () => payrollApi.getRun(id) });
}

/** The viewer's own payslips (or another person's, for payroll.view). */
export function usePayslips(target?: string) {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: payrollKeys.payslips(empId, target), queryFn: () => payrollApi.payslips(target), enabled: !!empId });
}

export function usePayslipFor(runId: string, empId: string | null) {
  return useQuery({ queryKey: ["payroll", "payslip", runId, empId], queryFn: () => payrollApi.payslipFor(runId, empId!), enabled: !!empId });
}

export function useAdvances() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: payrollKeys.advances(empId), queryFn: payrollApi.advances, enabled: !!empId });
}

export function useAdjustments() {
  return useQuery({ queryKey: ["payroll", "adjustments"], queryFn: payrollApi.adjustments });
}

export function useTaxSlabs() {
  return useQuery({ queryKey: ["payroll", "tax-slabs"], queryFn: payrollApi.taxSlabs, staleTime: Infinity });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["payroll"] });
    qc.invalidateQueries({ queryKey: ["approvals"] });
  };
}

export function useStartRun() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (month: string) => payrollApi.startRun(month), onSuccess: done });
}

export function useRunAction() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, action, note }: { id: string; action: RunAction; note?: string }) => payrollApi.act(id, action, { note }), onSuccess: done });
}

export function useAddAdjustment() {
  const done = useInvalidate();
  return useMutation({ mutationFn: payrollApi.addAdjustment, onSuccess: done });
}

export function useCreateAdvance() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (input: NewAdvanceInput) => payrollApi.createAdvance(input), onSuccess: done });
}
