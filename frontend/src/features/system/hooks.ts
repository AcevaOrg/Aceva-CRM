"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSession } from "@/lib/auth/session";
import { useCan } from "@/lib/auth/viewer";
import { auditApi, backupApi, notificationsApi, settingsApi } from "./api";
import type { AuditFilters, SettingsSectionKey, SettingsValues, WeightsVersion } from "./types";

export const systemKeys = {
  all: ["system"] as const,
  notifications: (empId: string | null) => ["system", "notifications", empId] as const,
  prefs: (empId: string | null) => ["system", "notification-prefs", empId] as const,
  audit: (f: AuditFilters) => ["system", "audit", f] as const,
  integrity: ["system", "audit-integrity"] as const,
  settings: (section: SettingsSectionKey) => ["system", "settings", section] as const,
  settingsHistory: (section: SettingsSectionKey) => ["system", "settings-history", section] as const,
  weights: ["system", "weights"] as const,
  backup: ["system", "backup"] as const,
};

/* ---------------- Notifications ---------------- */

export function useNotifications() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: systemKeys.notifications(empId), queryFn: notificationsApi.list, enabled: !!empId });
}

export function useMarkRead() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids?: string[]) => notificationsApi.markRead(ids),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["system", "notifications"] }),
  });
}

export function useNotificationPrefs() {
  const empId = useSession((s) => s.empId);
  return useQuery({ queryKey: systemKeys.prefs(empId), queryFn: notificationsApi.getPrefs, enabled: !!empId });
}

export function useSaveNotificationPrefs() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: notificationsApi.savePrefs,
    onSuccess: () => qc.invalidateQueries({ queryKey: ["system", "notification-prefs"] }),
  });
}

/* ---------------- Audit ---------------- */

export function useAuditLog(filters: AuditFilters) {
  return useQuery({ queryKey: systemKeys.audit(filters), queryFn: () => auditApi.list(filters) });
}

export function useAuditIntegrity() {
  return useQuery({ queryKey: systemKeys.integrity, queryFn: auditApi.integrity });
}

/* ---------------- Settings ---------------- */

export function useSettings(section: SettingsSectionKey) {
  return useQuery({ queryKey: systemKeys.settings(section), queryFn: () => settingsApi.get(section) });
}

export function useSettingsHistory(section: SettingsSectionKey) {
  return useQuery({ queryKey: systemKeys.settingsHistory(section), queryFn: () => settingsApi.history(section) });
}

export function useSaveSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ section, values, reason }: { section: SettingsSectionKey; values: SettingsValues; reason: string }) => settingsApi.save(section, values, reason),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["system"] });
      qc.invalidateQueries({ queryKey: ["payroll", "tax-slabs"] });
    },
  });
}

export function useWeightVersions() {
  return useQuery({ queryKey: systemKeys.weights, queryFn: settingsApi.weightVersions });
}

export function useSaveWeights() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ kind, weights, reason }: { kind: WeightsVersion["kind"]; weights: Record<string, number>; reason: string }) => settingsApi.saveWeights(kind, weights, reason),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["system"] }),
  });
}

/* ---------------- Backups ---------------- */

/**
 * Backup status for the Home dashboard and Settings → Backups.
 * Returns BackupStatus: { lastBackupAt, ok, nextBackupAt, dailyCopies, monthlyCopies, lastRestoreTest: { at, ok, by }, recent[] … }.
 */
export function useBackupStatus() {
  const allowed = useCan(["backup.view", "settings.view"]);
  return useQuery({ queryKey: systemKeys.backup, queryFn: backupApi.status, enabled: allowed });
}

export function useRunBackup() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: backupApi.runNow, onSuccess: () => qc.invalidateQueries({ queryKey: ["system"] }) });
}
