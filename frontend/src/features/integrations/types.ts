/**
 * Module 16 · Sales tool integrations: Apollo, MillionVerifier, outreach mailboxes, Salesforce (plan §21)
 * Owners: Developer A (hub, Apollo, security) and Developer C (MillionVerifier, mailboxes, health screen),
 * Phase 2, cycles 6 and 7. Spec §9.16.
 * This file is the API contract for the module.
 */

export type ToolId = "apollo" | "millionverifier" | "mailboxes" | "salesforce";
export type ConnectionStatus = "not_connected" | "working" | "failing" | "paused";

export interface ToolConnection {
  tool: ToolId;
  status: ConnectionStatus;
  /** Only the last 4 characters are ever sent to the browser (plan §21). */
  keyLast4?: string;
  syncEveryMin: 15 | 30;
  lastSuccessAt?: string;
  failingSince?: string;
  lastError?: string;
  itemsToday: number;
  callsUsed?: number;
  callsLimit?: number;
  callsWindow?: string;
  creditsLeft?: number;
  creditAlertAt?: number;
  creditsUsedPerDay?: number;
  connectedBy?: string;
  connectedAt?: string;
  /** Mailboxes: IMAP server and login name (never the password). */
  imapHost?: string;
}

export interface ToolUserLink {
  tool: ToolId;
  externalUserId: string;
  name: string;
  email: string;
  empId?: string;
  closedAt?: string;
}

export interface SyncRun {
  id: string;
  tool: ToolId;
  startedAt: string;
  finishedAt?: string;
  items: number;
  result: "ok" | "retrying" | "failed";
  /** 1 = first try; retries after 1, 5 and 15 minutes (plan §21). */
  attempt: number;
  error?: string;
}

export interface MailboxStat {
  mailbox: string;
  domain: string;
  ownerEmpId?: string;
  sentToday: number;
  repliesToday: number;
  bouncesToday: number;
  sentWeek: number;
  bouncesWeek: number;
  paused: boolean;
}

export interface UnmatchedItem {
  id: string;
  tool: ToolId;
  externalUserId: string;
  userName: string;
  kind: "email_sent" | "reply" | "bounce" | "call";
  at: string;
  summary: string;
}

export interface IntegrationAlert {
  id: string;
  tool: ToolId;
  severity: "warning" | "danger";
  title: string;
  detail: string;
}

export interface TestResult {
  ok: boolean;
  canRead: string[];
  error?: string;
}

export interface ToolOverview {
  connections: ToolConnection[];
  alerts: IntegrationAlert[];
  unmatchedUsers: number;
}
