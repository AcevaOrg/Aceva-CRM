"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth/session";
import { activitiesApi, commissionApi, dealsApi, dncApi, leadsApi, reportsApi, salesDayApi, targetsApi } from "./api";
import type { DailyTargets, DealStage, ImportRow, LogActivityInput, MonthlyTargets, NewDealInput, NewLeadInput, SelfReported } from "./types";

export const salesKeys = {
  all: ["sales"] as const,
  leads: (empId: string | null) => ["sales", "leads", empId] as const,
  lead: (id: string) => ["sales", "lead", id] as const,
  deals: (empId: string | null) => ["sales", "deals", empId] as const,
  deal: (id: string) => ["sales", "deal", id] as const,
  day: (viewer: string | null, empId?: string) => ["sales", "day", viewer, empId ?? null] as const,
  summary: (empId: string | null) => ["sales", "summary", empId] as const,
};

/* ---------- Home dashboard hooks ---------- */

/**
 * "My sales day" for the viewer (or, for a sales manager, the chosen salesperson).
 * Returns MySalesDay | null (null when the viewer has no salespeople in scope).
 */
export function useMySalesDay(empId?: string) {
  const viewer = useSession((s) => s.empId);
  return useQuery({ queryKey: salesKeys.day(viewer, empId), queryFn: () => salesDayApi.myDay(empId), enabled: !!viewer });
}

/** Pipeline totals by stage for the deals the viewer can see. Returns PipelineSummary. */
export function usePipelineSummary() {
  const viewer = useSession((s) => s.empId);
  return useQuery({ queryKey: salesKeys.summary(viewer), queryFn: dealsApi.summary, enabled: !!viewer });
}

/* ---------- Queries ---------- */

export function useSalesPeople() {
  const viewer = useSession((s) => s.empId);
  return useQuery({ queryKey: ["sales", "people", viewer], queryFn: salesDayApi.people, enabled: !!viewer });
}

export function useLeads() {
  const viewer = useSession((s) => s.empId);
  return useQuery({ queryKey: salesKeys.leads(viewer), queryFn: leadsApi.list, enabled: !!viewer });
}

export function useLead(id: string) {
  return useQuery({ queryKey: salesKeys.lead(id), queryFn: () => leadsApi.get(id) });
}

export function useDuplicateCheck(input: { email?: string; website?: string }, enabled: boolean) {
  return useQuery({ queryKey: ["sales", "duplicate", input.email ?? "", input.website ?? ""], queryFn: () => leadsApi.checkDuplicate(input), enabled, staleTime: 5_000 });
}

export function useVerifyPreview(enabled: boolean) {
  return useQuery({ queryKey: ["sales", "verify-preview"], queryFn: leadsApi.verifyPreview, enabled });
}

export function useDeals() {
  const viewer = useSession((s) => s.empId);
  return useQuery({ queryKey: salesKeys.deals(viewer), queryFn: dealsApi.list, enabled: !!viewer });
}

export function useDeal(id: string) {
  return useQuery({ queryKey: salesKeys.deal(id), queryFn: () => dealsApi.get(id) });
}

export function useReportDates() {
  return useQuery({ queryKey: ["sales", "report-dates"], queryFn: reportsApi.dates });
}

export function useDailyReport(date: string | undefined) {
  const viewer = useSession((s) => s.empId);
  return useQuery({ queryKey: ["sales", "daily-report", viewer, date], queryFn: () => reportsApi.daily(date!), enabled: !!date && !!viewer });
}

export function useSalesDashboard() {
  const viewer = useSession((s) => s.empId);
  return useQuery({ queryKey: ["sales", "dashboard", viewer], queryFn: reportsApi.dashboard, enabled: !!viewer });
}

export function useSalesScorecards(which: "current" | "previous") {
  const viewer = useSession((s) => s.empId);
  return useQuery({ queryKey: ["sales", "scorecards", viewer, which], queryFn: () => reportsApi.scorecards(which), enabled: !!viewer });
}

export function useTargets() {
  const viewer = useSession((s) => s.empId);
  return useQuery({ queryKey: ["sales", "targets", viewer], queryFn: targetsApi.get, enabled: !!viewer });
}

export function useCommission() {
  const viewer = useSession((s) => s.empId);
  return useQuery({ queryKey: ["sales", "commission", viewer], queryFn: commissionApi.get, enabled: !!viewer });
}

export function useDnc() {
  return useQuery({ queryKey: ["sales", "dnc"], queryFn: dncApi.list });
}

/* ---------- Mutations ---------- */

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["sales"] });
    qc.invalidateQueries({ queryKey: ["approvals"] });
    qc.invalidateQueries({ queryKey: ["integrations"] });
  };
}

export function useCreateLead() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (input: NewLeadInput) => leadsApi.create(input), onSuccess: done });
}

export function useUpdateLead() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, notes }: { id: string; notes: string }) => leadsApi.update(id, { notes }), onSuccess: done });
}

export function useReassignLead() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, empId }: { id: string; empId: string }) => leadsApi.reassign(id, empId), onSuccess: done });
}

export function useMarkDnc() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => leadsApi.markDoNotContact(id, reason), onSuccess: done });
}

export function useImportPreview() {
  return useMutation({ mutationFn: (csv: string) => leadsApi.importPreview(csv) });
}

export function useImportCommit() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (rows: ImportRow[]) => leadsApi.importCommit(rows), onSuccess: done });
}

export function useVerifyEmails() {
  const done = useInvalidate();
  return useMutation({ mutationFn: leadsApi.verify, onSuccess: done });
}

export function useLogActivity() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (input: LogActivityInput) => activitiesApi.log(input), onSuccess: done });
}

export function useCreateDeal() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (input: NewDealInput) => dealsApi.create(input), onSuccess: done });
}

export function useMoveDeal() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, stage, reason }: { id: string; stage: DealStage; reason?: string }) => dealsApi.move(id, stage, reason), onSuccess: done });
}

export function useConfirmWon() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (id: string) => dealsApi.confirmWon(id), onSuccess: done });
}

export function useRejectWon() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => dealsApi.rejectWon(id, reason), onSuccess: done });
}

export function useSetNextStep() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, nextStep, nextStepDate }: { id: string; nextStep: string; nextStepDate: string }) => dealsApi.setNextStep(id, nextStep, nextStepDate), onSuccess: done });
}

export function useSetProposal() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, url }: { id: string; url: string }) => dealsApi.setProposal(id, url), onSuccess: done });
}

export function useFollowUpDone() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ id, summary, nextStep, nextStepDate }: { id: string; summary: string; nextStep: string; nextStepDate: string }) => dealsApi.followUpDone(id, summary, nextStep, nextStepDate),
    onSuccess: done,
  });
}

export function useSubmitDailyLog() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (input: SelfReported & { note?: string }) => salesDayApi.submitLog(input), onSuccess: done });
}

export function useRequestProof() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ empId, date }: { empId: string; date: string }) => reportsApi.requestProof(empId, date), onSuccess: done });
}

export function useSaveTargets() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ daily, monthly }: { daily: DailyTargets[]; monthly: MonthlyTargets[] }) => targetsApi.save(daily, monthly), onSuccess: done });
}

export function useApproveCommission() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (id: string) => commissionApi.approve(id), onSuccess: done });
}

export function useRejectCommission() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, reason }: { id: string; reason: string }) => commissionApi.reject(id, reason), onSuccess: done });
}

export function useUpdateCommissionRule() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ id, ratePercent }: { id: string; ratePercent: number }) => commissionApi.updateRule(id, ratePercent), onSuccess: done });
}

export function useAddDnc() {
  const done = useInvalidate();
  return useMutation({ mutationFn: ({ email, reason }: { email: string; reason: string }) => dncApi.add(email, reason), onSuccess: done });
}
