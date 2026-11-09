"use client";
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth/session";
import { useCan } from "@/lib/auth/viewer";
import { analysisApi } from "./api";
import type { DrillKind, ImportRow, InsightsParams, SavedView } from "./types";

const useUser = () => useSession((s) => s.empId);

export function useSheetRows() {
  const u = useUser();
  return useQuery({ queryKey: ["analysis", "rows", u], queryFn: analysisApi.rows, enabled: !!u });
}

export function useSavedViews() {
  const u = useUser();
  return useQuery({ queryKey: ["analysis", "views", u], queryFn: analysisApi.views, enabled: !!u });
}

export function useInsights(p: InsightsParams) {
  const u = useUser();
  return useQuery({ queryKey: ["analysis", "insights", u, p], queryFn: () => analysisApi.insights(p), enabled: !!u, placeholderData: keepPreviousData });
}

export function useDrill(kind: DrillKind | null, key: string | null, p: InsightsParams) {
  return useQuery({ queryKey: ["analysis", "drill", kind, key, p], queryFn: () => analysisApi.drill(kind!, key!, p), enabled: !!kind && !!key });
}

/**
 * Home dashboard: finance KPI cards (spec §9.12).
 * Returns FinanceKpis: { asOf, currency, cash, cashDelta, revenue, revenueDelta, expenses, expensesDelta,
 * profit, profitDelta, unpaidInvoices, unpaidCount, overdueCount } — Money values in PKR, deltas in % (null when
 * there is nothing to compare with).
 * Revenue/expenses/profit are month to date; deltas compare with the same days last month.
 */
export function useFinanceKpis() {
  const u = useUser();
  const allowed = useCan("insights.view");
  return useQuery({ queryKey: ["analysis", "kpis", u], queryFn: () => analysisApi.kpis("PKR"), enabled: !!u && allowed });
}

/**
 * Home dashboard: revenue vs expenses for the last 6 months (PKR).
 * Returns MonthlySeries: { currency, months: "YYYY-MM"[], labels: "Jun"[], revenue[], expenses[], profit[], cash[] }.
 */
export function useRevenueExpenseSeries() {
  const u = useUser();
  const allowed = useCan("insights.view");
  return useQuery({ queryKey: ["analysis", "revenue-expense", u], queryFn: analysisApi.revenueExpense, enabled: !!u && allowed });
}

function useInvalidate() {
  const qc = useQueryClient();
  return () => {
    qc.invalidateQueries({ queryKey: ["analysis"] });
    qc.invalidateQueries({ queryKey: ["ledger"] });
    qc.invalidateQueries({ queryKey: ["statements"] });
    qc.invalidateQueries({ queryKey: ["approvals"] });
  };
}

export function useSaveView() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (v: Omit<SavedView, "id" | "createdBy">) => analysisApi.saveView(v), onSuccess: done });
}

export function useDeleteView() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (id: string) => analysisApi.deleteView(id), onSuccess: done });
}

export function useImportPreview() {
  return useMutation({ mutationFn: (csv: string) => analysisApi.importPreview(csv) });
}

export function useImportCommit() {
  const done = useInvalidate();
  return useMutation({ mutationFn: (rows: ImportRow[]) => analysisApi.importCommit(rows), onSuccess: done });
}

export function useUpdateDraftLine() {
  const done = useInvalidate();
  return useMutation({
    mutationFn: ({ entryId, lineId, field, value }: { entryId: string; lineId: string; field: "description" | "debit" | "credit"; value: string }) =>
      analysisApi.updateDraftLine(entryId, lineId, field, value),
    onSuccess: done,
  });
}
