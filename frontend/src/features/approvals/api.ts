/**
 * Approvals inbox service. Live: GET /approvals, POST /approvals/:id/{approve|reject}.
 */
import { mock } from "@/lib/api/mock";
import { getViewer } from "@/lib/auth/viewer";
import { PROVIDERS } from "./providers";
import type { ApprovalItem, DecideOptions } from "./types";

export const approvalsApi = {
  /** GET /approvals */
  list: () =>
    mock(() => {
      const viewer = getViewer();
      const items = PROVIDERS.flatMap((p) => p.list(viewer)).filter((i) => i.requester !== viewer.employee.empId);
      const routedUp = PROVIDERS.reduce((n, p) => n + (p.routedUp?.(viewer) ?? 0), 0);
      return { items: items.sort((a, b) => a.createdAt.localeCompare(b.createdAt)), routedUp };
    }, { delay: 120 }),

  /** POST /approvals/:id/approve | /reject */
  decide: (item: ApprovalItem, decision: "approve" | "reject", opts: DecideOptions = {}) =>
    mock(() => {
      const viewer = getViewer();
      const provider = PROVIDERS.find((p) => p.list(viewer).some((i) => i.id === item.id));
      provider?.decide(item, decision, viewer, opts);
    }),
};
