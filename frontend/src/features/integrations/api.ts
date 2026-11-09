/**
 * Module 16 service functions. Mock today; each JSDoc names the real endpoint (spec §7.3).
 * Keys never come back to the browser: only the last 4 characters (plan §21).
 */
import { ApiError, forbidden, mock, notFound } from "@/lib/api/mock";
import { getViewer } from "@/lib/auth/viewer";
import { uid } from "@/lib/utils";
import { table } from "@/mocks/db";
import { seedConnections, seedMailboxes, seedSyncRuns, seedToolUsers, seedUnmatched } from "@/mocks/seed/integrations";
import { buildAlerts, TOOL_META } from "./logic";
import type { MailboxStat, SyncRun, TestResult, ToolConnection, ToolId, ToolOverview, ToolUserLink, UnmatchedItem } from "./types";

const connections = () => table<ToolConnection>("integrations.connections", seedConnections);
const users = () => table<ToolUserLink>("integrations.users", seedToolUsers);
const runs = () => table<SyncRun>("integrations.runs", seedSyncRuns);
const mailboxes = () => table<MailboxStat>("integrations.mailboxes", seedMailboxes);
const unmatched = () => table<UnmatchedItem>("integrations.unmatched", seedUnmatched);

function requireManage() {
  if (!getViewer().can("integrations.manage")) forbidden("Only the CTO or the Director can change sales tool connections.");
}
function requireView() {
  if (!getViewer().can("integrations.view")) notFound("Integration");
}
function conn(tool: ToolId) {
  const c = connections().find((x) => x.tool === tool);
  if (!c) notFound("Integration");
  return c;
}

function unmatchedUserNames() {
  return users()
    .filter((u) => (u.tool === "apollo" || u.tool === "mailboxes") && !u.empId && !u.closedAt)
    .map((u) => u.name);
}

/* ---------- Read by other modules in mock mode (Sales) ---------- */

export function apolloLastSyncAt() {
  return connections().find((c) => c.tool === "apollo")?.lastSuccessAt;
}

export function millionVerifierCredits() {
  return connections().find((c) => c.tool === "millionverifier")?.creditsLeft ?? 0;
}

/** Used by Sales → Verify emails: each check costs 1 credit. */
export function consumeMillionVerifierCredits(n: number) {
  const c = connections().find((x) => x.tool === "millionverifier");
  if (!c || c.creditsLeft === undefined) return 0;
  if (c.creditsLeft < n) throw new ApiError("credits", `Only ${c.creditsLeft} MillionVerifier credits left.`);
  c.creditsLeft -= n;
  c.itemsToday += n;
  c.lastSuccessAt = new Date().toISOString();
  runs().unshift({ id: uid("run"), tool: "millionverifier", startedAt: new Date().toISOString(), finishedAt: new Date().toISOString(), items: n, result: "ok", attempt: 1 });
  return c.creditsLeft;
}

export const integrationsApi = {
  /** GET /integrations */
  overview: () =>
    mock<ToolOverview>(() => {
      requireView();
      const names = unmatchedUserNames();
      return { connections: connections(), alerts: buildAlerts(connections(), mailboxes(), unmatched(), names.filter((n) => !n.includes("@"))), unmatchedUsers: names.length };
    }),

  /** GET /integrations/:tool */
  get: (tool: ToolId) =>
    mock(() => {
      requireView();
      return { connection: conn(tool), users: users().filter((u) => u.tool === tool), runs: runs().filter((r) => r.tool === tool).slice(0, 8) };
    }),

  /** POST /integrations/:tool/key (step-up). The key is encrypted at once and never shown again. */
  saveKey: (tool: ToolId, key: string, imapHost?: string) =>
    mock(() => {
      requireManage();
      if (key.trim().length < 8) throw new ApiError("validation", "That doesn't look like a full key.");
      const c = conn(tool);
      c.keyLast4 = key.trim().slice(-4);
      if (imapHost) c.imapHost = imapHost;
      if (c.status === "failing") {
        c.status = "working";
        c.failingSince = undefined;
        c.lastError = undefined;
      }
      return { keyLast4: c.keyLast4 };
    }, { delay: 500 }),

  /** POST /integrations/:tool/test */
  test: (tool: ToolId) =>
    mock<TestResult>(() => {
      requireView();
      const c = conn(tool);
      if (!c.keyLast4) return { ok: false, canRead: [], error: "No key saved yet." };
      if (c.keyLast4.toLowerCase().includes("bad")) return { ok: false, canRead: [], error: "The tool rejected the key (401 Unauthorized)." };
      const canRead: Record<ToolId, string[]> = {
        apollo: ["4 Apollo users", "Sequences and sent emails", "Replies and bounces", "Dialer calls", "Tasks and new contacts"],
        millionverifier: [`${(c.creditsLeft ?? 0).toLocaleString()} credits on the account`, "Single and bulk email checks"],
        mailboxes: ["4 mailboxes on 3 domains", "Sender, receiver, date and subject only"],
        salesforce: ["Leads", "Opportunities", "Activities"],
      };
      return { ok: true, canRead: canRead[tool] };
    }, { delay: 900 }),

  /** GET /integrations/:tool/users */
  users: (tool: ToolId) => mock(() => users().filter((u) => u.tool === tool)),

  /** PUT /integrations/:tool/users/:externalUserId { empId } */
  linkUser: (tool: ToolId, externalUserId: string, empId: string | null) =>
    mock(() => {
      requireManage();
      const u = users().find((x) => x.tool === tool && x.externalUserId === externalUserId);
      if (!u) notFound("Tool user");
      u.empId = empId ?? undefined;
      if (empId) {
        const list = unmatched();
        for (let i = list.length - 1; i >= 0; i--) if (list[i].externalUserId === externalUserId) list.splice(i, 1);
      }
    }),

  /** PATCH /integrations/:tool { syncEveryMin, status } (turning off needs step-up) */
  update: (tool: ToolId, patch: { syncEveryMin?: 15 | 30; status?: "working" | "paused" }) =>
    mock(() => {
      requireManage();
      const c = conn(tool);
      if (patch.status === "working" && !c.keyLast4) throw new ApiError("validation", "Save and test a key first.");
      if (patch.syncEveryMin) c.syncEveryMin = patch.syncEveryMin;
      if (patch.status) {
        c.status = patch.status;
        if (patch.status === "working") {
          c.lastSuccessAt = c.lastSuccessAt ?? new Date().toISOString();
          c.connectedBy = c.connectedBy ?? getViewer().employee.empId;
          c.connectedAt = c.connectedAt ?? new Date().toISOString();
        }
      }
    }),

  /** POST /integrations/:tool/sync-now */
  syncNow: (tool: ToolId) =>
    mock(() => {
      requireView();
      const c = conn(tool);
      if (c.status === "not_connected" || !c.keyLast4) throw new ApiError("validation", `${TOOL_META[tool].name} isn't connected.`);
      const items = tool === "apollo" ? 6 + Math.round(Math.random() * 12) : tool === "mailboxes" ? 1 + Math.round(Math.random() * 4) : Math.round(Math.random() * 20);
      const now = new Date().toISOString();
      runs().unshift({ id: uid("run"), tool, startedAt: now, finishedAt: now, items, result: "ok", attempt: 1 });
      c.lastSuccessAt = now;
      c.itemsToday += items;
      if (c.callsUsed !== undefined) c.callsUsed += 3;
      if (c.status === "failing") {
        c.status = "working";
        c.failingSince = undefined;
      }
      return { items };
    }, { delay: 1100 }),

  /** GET /integrations/sync-runs */
  syncRuns: () => mock(() => { requireView(); return runs().slice(0, 15); }),

  /** GET /integrations/mailboxes */
  mailboxes: () => mock(() => { requireView(); return mailboxes(); }),

  /** PATCH /integrations/mailboxes/:mailbox { paused } */
  pauseMailbox: (mailbox: string, paused: boolean) =>
    mock(() => {
      requireManage();
      const m = mailboxes().find((x) => x.mailbox === mailbox);
      if (m) m.paused = paused;
    }),

  /** GET /integrations/unmatched */
  unmatched: () => mock(() => { requireView(); return unmatched(); }),
};
