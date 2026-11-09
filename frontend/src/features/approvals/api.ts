/**
 * Approvals inbox service. Live: GET /approvals, GET /approvals/oversight, POST /approvals/:id/{approve|reject}.
 */
import { mock } from "@/lib/api/mock";
import { descendantsOf } from "@/lib/auth/scope";
import { getViewer, viewerFor } from "@/lib/auth/viewer";
import { employeesTable } from "@/lib/directory";
import { APPROVER_PERMISSIONS } from "@/lib/nav";
import { PROVIDERS } from "./providers";
import type { ApprovalItem, DecideOptions } from "./types";

export const approvalsApi = {
  /** GET /approvals — items waiting for the signed-in person. */
  list: () =>
    mock(() => {
      const viewer = getViewer();
      const items = PROVIDERS.flatMap((p) => p.list(viewer)).filter((i) => i.requester !== viewer.employee.empId);
      const routedUp = PROVIDERS.reduce((n, p) => n + (p.routedUp?.(viewer) ?? 0), 0);
      return { items: items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)), routedUp };
    }, { delay: 120 }),

  /**
   * GET /approvals/oversight — everything waiting for anyone else in the viewer's reporting line,
   * read-only. The CEO / Founder / Owner sees the whole company here (spec §2: sees everything, approves nothing).
   */
  oversight: () =>
    mock(() => {
      const viewer = getViewer();
      if (!viewer.can("activity.view_all")) return [] as ApprovalItem[];
      const me = viewer.employee.empId;
      // Only approvers below the viewer (the CEO / Founder / Owner's line is the whole company).
      const below = new Set(descendantsOf(me));
      const seen = new Set<string>();
      const out: ApprovalItem[] = [];
      for (const e of employeesTable()) {
        if (!below.has(e.empId) || e.status === "left") continue;
        const v = viewerFor(e.empId);
        if (!v || !v.can(APPROVER_PERMISSIONS)) continue;
        for (const p of PROVIDERS) {
          for (const item of p.list(v)) {
            if (item.requester === e.empId || seen.has(item.id)) continue;
            seen.add(item.id);
            out.push({ ...item, waitingFor: e.empId });
          }
        }
      }
      return out.sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    }, { delay: 160 }),

  /** POST /approvals/:id/approve | /reject */
  decide: (item: ApprovalItem, decision: "approve" | "reject", opts: DecideOptions = {}) =>
    mock(() => {
      const viewer = getViewer();
      const provider = PROVIDERS.find((p) => p.list(viewer).some((i) => i.id === item.id));
      provider?.decide(item, decision, viewer, opts);
    }),
};
