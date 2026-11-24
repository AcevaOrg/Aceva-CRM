/**
 * Approvals inbox service. Live: GET /approvals, GET /approvals/oversight, POST /approvals/:id/{approve|reject}.
 *
 * Module 5 live (NEXT_PUBLIC_LIVE_MODULES contains m5, or NEXT_PUBLIC_API_MODE=live): the task reviews and the extension
 * requests come from the server's inbox, and the server decides who may approve what. Module 6 live (m6): the
 * scorecards to release and the rating disputes come from the server's inbox too. The other modules still have
 * their items in the in-browser mock until they are switched live and register on the server's inbox as well, so the
 * live lists are the server's items plus the mock providers' items (the task provider gives none when M5 is live).
 */
import type { ApprovalItemView, ApprovalsListResponse } from "@aceva/contracts";
import { http, isLive } from "@/lib/api/http";
import { ApiError, mock } from "@/lib/api/mock";
import { descendantsOf } from "@/lib/auth/scope";
import { getViewer, viewerFor } from "@/lib/auth/viewer";
import { employeesTable } from "@/lib/directory";
import { APPROVER_PERMISSIONS } from "@/lib/nav";
import { PROVIDERS } from "./providers";
import type { ApprovalItem, ApprovalType, DecideOptions } from "./types";

/**
 * Items the server's inbox owns: the task reviews and extension requests when Module 5 is live, scorecards and rating
 * disputes when Module 6 is live. Everything else is still decided on the mock.
 */
function serverTypes(): ApprovalType[] {
  return [
    ...(isLive("m5") ? (["task_review", "extension"] as const) : []),
    ...(isLive("m6") ? (["scorecard", "dispute"] as const) : []),
    ...(isLive("m15") ? (["won_deal"] as const) : []),
  ];
}

/**
 * The server's inbox always carries every type it has a provider for (task reviews, extensions, scorecards, rating
 * disputes), whichever modules this build has switched live. Keep only the types this build owns on the server: the
 * other types come from the mock providers, and a type the server owns here is decided on the server. Without this,
 * a build with m5 but not m6 would list the server's real scorecards next to the mock ones, and Release on one of
 * them would be sent to the mock, which has no such item (so it would only look as if it worked).
 */
function serverOwned<T extends { type: ApprovalType }>(items: T[]): T[] {
  const owned = serverTypes();
  return items.filter((i) => owned.includes(i.type));
}

const mockApprovalsApi = {
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

const byAge = (a: ApprovalItem, b: ApprovalItem) => a.createdAt.localeCompare(b.createdAt);

/**
 * Module 5 and/or 6 live: the server's inbox (only the types this build owns, see serverOwned) next to the mock items
 * of every other type. Any mix of m5 and m6 works: the types of the module that is not live stay on the mock.
 */
const liveApprovalsApi: typeof mockApprovalsApi = {
  /** GET /approvals: items waiting for me; routedUp counts what I asked for that went to someone else (maker-checker) */
  list: async () => {
    const [server, rest] = await Promise.all([http.get<ApprovalsListResponse>("/approvals"), mockApprovalsApi.list()]);
    return { items: [...serverOwned(server.items), ...rest.items].sort(byAge), routedUp: server.routedUp + rest.routedUp };
  },

  /** GET /approvals/oversight: waiting for others in my reporting line, read-only */
  oversight: async () => {
    const [server, rest] = await Promise.all([http.get<ApprovalItemView[]>("/approvals/oversight"), mockApprovalsApi.oversight()]);
    const owned = serverOwned(server);
    const seen = new Set(owned.map((i) => i.id));
    return [...owned, ...rest.filter((i) => !seen.has(i.id))].sort(byAge);
  },

  /** POST /approvals/:id/approve | /reject { rating | reason } (the id is "<type>:<ref id>", the colon is URL-encoded) */
  decide: async (item: ApprovalItem, decision: "approve" | "reject", opts: DecideOptions = {}) => {
    if (!serverTypes().includes(item.type)) return mockApprovalsApi.decide(item, decision, opts);
    if ((item.type === "task_review" || item.type === "dispute") && decision === "approve" && !opts.rating) throw new ApiError("validation", "A rating from 1 to 5 is required.");
    if (decision === "reject" && !opts.reason?.trim()) throw new ApiError("validation", "A reason is required.");
    await http.post(`/approvals/${encodeURIComponent(item.id)}/${decision}`, {
      ...(decision === "approve" && opts.rating ? { rating: opts.rating } : {}),
      ...(decision === "reject" ? { reason: opts.reason?.trim() } : {}),
    });
  },
};

export const approvalsApi: typeof mockApprovalsApi = isLive("m5") || isLive("m6") || isLive("m15") ? liveApprovalsApi : mockApprovalsApi;
