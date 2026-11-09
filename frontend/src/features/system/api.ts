/**
 * Module 12 service functions. Mock today; each JSDoc names the real endpoint (spec §7.3).
 */
import { currentTaxSlabs, setTaxSlabs } from "@/features/payroll/api";
import type { TaxSlab } from "@/features/payroll/types";
import { ApiError, mock, notFound } from "@/lib/api/mock";
import { getViewer } from "@/lib/auth/viewer";
import { uid } from "@/lib/utils";
import { table } from "@/mocks/db";
import { seedNotifications } from "@/mocks/seed/notifications";
import { seedAudit, seedBackupStatus, seedSettings, seedWeightVersions } from "@/mocks/seed/system";
import { chainHash, diffValues, GENESIS_HASH, sectionMeta } from "./logic";
import type {
  AuditChange, AuditFilters, AuditIntegrity, AuditRecord, BackupStatus, Notification, NotificationPrefs, SettingsRecord,
  SettingsSectionKey, SettingsValues, WeightsVersion,
} from "./types";

const notifications = () => table<Notification>("notifications", seedNotifications);
const prefsTable = () => table<NotificationPrefs & { empId: string }>("notification_prefs", () => []);
const auditTable = () => table<AuditRecord>("system.audit", seedAudit);
const settingsTable = () => table<SettingsRecord>("system.settings", seedSettings);
const weightsTable = () => table<WeightsVersion>("system.weights", seedWeightVersions);
const backupTable = () => table<BackupStatus>("system.backup", () => [seedBackupStatus()]);

export const notificationsApi = {
  /** GET /notifications */
  list: () => mock(() => notifications().filter((n) => n.empId === getViewer().employee.empId), { delay: 120 }),

  /** POST /notifications/read { ids } (no ids = all) */
  markRead: (ids?: string[]) =>
    mock(() => {
      const me = getViewer().employee.empId;
      notifications().forEach((n) => {
        if (n.empId === me && (!ids || ids.includes(n.id))) n.read = true;
      });
    }),

  /** GET /notifications/prefs */
  getPrefs: () =>
    mock<NotificationPrefs>(() => {
      const me = getViewer().employee.empId;
      return prefsTable().find((p) => p.empId === me) ?? { email: {}, dailySummary: true };
    }),

  /** PATCH /notifications/prefs */
  savePrefs: (prefs: NotificationPrefs) =>
    mock(() => {
      const me = getViewer().employee.empId;
      const list = prefsTable();
      const i = list.findIndex((p) => p.empId === me);
      if (i >= 0) list[i] = { ...prefs, empId: me };
      else list.push({ ...prefs, empId: me });
    }),
};

/* ---------------- Audit log ---------------- */

/** Append a row to the tamper-proof chain (the server does this in an interceptor). */
export function appendAudit(row: Omit<AuditRecord, "id" | "seq" | "hash" | "prevHash" | "at"> & { at?: string }) {
  const list = auditTable();
  const last = list.reduce<AuditRecord | null>((m, r) => (!m || r.seq > m.seq ? r : m), null);
  const seq = (last?.seq ?? 0) + 1;
  const prevHash = last?.hash ?? GENESIS_HASH;
  const at = row.at ?? new Date().toISOString();
  const hash = chainHash(prevHash, `${seq}|${at}|${row.empId}|${row.module}|${row.action}|${row.recordId}|${JSON.stringify(row.changes ?? [])}`);
  const rec: AuditRecord = { ...row, id: uid("aud"), seq, at, hash, prevHash };
  list.push(rec);
  return rec;
}

function requireAudit() {
  const v = getViewer();
  if (!v.can("audit.view")) notFound("Audit log");
  return v;
}

export const auditApi = {
  /** GET /audit?empId&module&action&from&to&q */
  list: (f: AuditFilters) =>
    mock(() => {
      requireAudit();
      const q = f.q?.trim().toLowerCase();
      return auditTable()
        .filter((r) => !f.empId || r.empId === f.empId)
        .filter((r) => !f.module || r.module === f.module)
        .filter((r) => !f.action || r.action === f.action)
        .filter((r) => !f.from || r.at.slice(0, 10) >= f.from)
        .filter((r) => !f.to || r.at.slice(0, 10) <= f.to)
        .filter((r) => !q || `${r.summary} ${r.recordId} ${r.recordType} ${r.empId}`.toLowerCase().includes(q))
        .sort((a, b) => b.seq - a.seq);
    }),

  /** GET /audit/integrity (the nightly job re-computes every fingerprint) */
  integrity: () =>
    mock<AuditIntegrity>(() => {
      requireAudit();
      const rows = [...auditTable()].sort((a, b) => a.seq - b.seq);
      let prev = GENESIS_HASH;
      let brokenAt: number | undefined;
      for (const r of rows) {
        const expect = chainHash(prev, `${r.seq}|${r.at}|${r.empId}|${r.module}|${r.action}|${r.recordId}|${JSON.stringify(r.changes ?? [])}`);
        if (r.prevHash !== prev || r.hash !== expect) {
          brokenAt = r.seq;
          break;
        }
        prev = r.hash;
      }
      const checked = new Date();
      if (checked.getHours() < 2) checked.setDate(checked.getDate() - 1);
      checked.setHours(2, 0, 0, 0);
      return { ok: brokenAt === undefined, checkedAt: checked.toISOString(), rows: rows.length, brokenAt };
    }),
};

/* ---------------- Settings ---------------- */

function canEditSection(section: SettingsSectionKey) {
  const v = getViewer();
  if (!v.can("settings.manage")) return { ok: false, reason: "You can view settings but not change them." };
  if (sectionMeta(section).protected && v.employee.level > 2) return { ok: false, reason: "Only the Owner or CEO can change this section." };
  return { ok: true as const };
}

export const settingsApi = {
  /** GET /settings/:section */
  get: (section: SettingsSectionKey) =>
    mock<SettingsRecord>(() => {
      if (!getViewer().can("settings.view")) notFound("Settings");
      const rec = settingsTable().find((s) => s.section === section);
      if (!rec) notFound("Settings section");
      if (section === "tax-slabs") return { ...rec, values: { slabs: currentTaxSlabs() } };
      return rec;
    }, { delay: 120 }),

  /** PATCH /settings/:section { values, reason } — logged in the audit trail */
  save: (section: SettingsSectionKey, values: SettingsValues, reason: string) =>
    mock(() => {
      const v = getViewer();
      const allowed = canEditSection(section);
      if (!allowed.ok) throw new ApiError("forbidden", allowed.reason, 403);
      if (!reason || reason.trim().length < 3) throw new ApiError("validation", "A reason is required.");
      const rec = settingsTable().find((s) => s.section === section);
      if (!rec) notFound("Settings section");
      const before = section === "tax-slabs" ? { slabs: currentTaxSlabs() } : rec.values;
      const changes: AuditChange[] = diffValues(before, values);
      rec.values = structuredClone(values);
      rec.updatedAt = new Date().toISOString();
      rec.updatedBy = v.employee.empId;
      if (section === "tax-slabs") setTaxSlabs(values.slabs as TaxSlab[]);
      appendAudit({ empId: v.employee.empId, module: "Settings", action: "edit", recordType: "settings", recordId: section, summary: `Changed ${sectionMeta(section).label.toLowerCase()}`, changes, reason });
      return rec;
    }),

  /** GET /audit?recordType=settings&recordId=:section (recent changes panel) */
  history: (section: SettingsSectionKey) =>
    mock(() => {
      if (!getViewer().can("settings.view")) notFound("Settings");
      return auditTable()
        .filter((r) => r.recordType === "settings" && r.recordId === section)
        .sort((a, b) => b.seq - a.seq)
        .slice(0, 5);
    }, { delay: 100 }),

  /** GET /settings/score-weights (all versions) */
  weightVersions: () =>
    mock(() => {
      if (!getViewer().can("settings.view")) notFound("Settings");
      return [...weightsTable()].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
    }),

  /** POST /settings/score-weights (creates a new version; old scorecards keep theirs) */
  saveWeights: (kind: WeightsVersion["kind"], weights: Record<string, number>, reason: string) =>
    mock(() => {
      const v = getViewer();
      if (!v.can("performance.weights") && !v.can("settings.manage")) throw new ApiError("forbidden", "Only the Director and above set score weights.", 403);
      const total = Object.values(weights).reduce((a, b) => a + b, 0);
      if (total !== 100) throw new ApiError("validation", `Weights must add up to 100% (now ${total}%).`);
      const prev = weightsTable().filter((w) => w.kind === kind).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom))[0];
      const ver: WeightsVersion = { id: uid("wv"), kind, weights, effectiveFrom: new Date().toISOString(), createdBy: v.employee.empId, note: reason };
      weightsTable().push(ver);
      appendAudit({
        empId: v.employee.empId,
        module: "Settings",
        action: "edit",
        recordType: "settings",
        recordId: "score-weights",
        summary: `Saved new ${kind} score weights`,
        changes: diffValues(prev?.weights ?? {}, weights).map((c) => ({ ...c, from: `${c.from}%`, to: `${c.to}%` })),
        reason,
      });
      return ver;
    }),

  /** POST /settings/:section/test-alert etc. are added per section when the backend exists. */
};

/* ---------------- Backups ---------------- */

export const backupApi = {
  /** GET /backups/status */
  status: () =>
    mock(() => {
      if (!getViewer().can(["backup.view", "settings.view"])) notFound("Backups");
      return backupTable()[0];
    }),

  /** POST /backups/run (manual backup outside the nightly schedule) */
  runNow: () =>
    mock(() => {
      const v = getViewer();
      if (!v.can("settings.manage")) throw new ApiError("forbidden", "Only the Director and above can start a backup.", 403);
      const s = backupTable()[0];
      const at = new Date().toISOString();
      s.recent.unshift({ id: uid("bk"), at, kind: "daily", sizeMb: (s.recent[0]?.sizeMb ?? 840) + 2, ok: true, durationMin: 8 });
      s.recent = s.recent.slice(0, 7);
      s.lastBackupAt = at;
      appendAudit({ empId: v.employee.empId, module: "Settings", action: "create", recordType: "backup", recordId: "manual", summary: "Started a manual encrypted backup" });
      return s;
    }, { delay: 900 }),
};
