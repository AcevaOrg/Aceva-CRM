/**
 * Pure rules for Module 16 (plan §21): tool descriptions, bounce rate, credit runway, alerts.
 */
import type { IntegrationAlert, MailboxStat, ToolConnection, ToolId, UnmatchedItem } from "./types";

export interface ToolMeta {
  id: ToolId;
  name: string;
  short: string;
  /** CSS colour of the logo tile. */
  color: string;
  reads: string;
  how: string;
  limits: string;
  keyLabel: string;
  linksUsers: boolean;
  advice?: string;
}

export const TOOL_META: Record<ToolId, ToolMeta> = {
  apollo: {
    id: "apollo",
    name: "Apollo.io",
    short: "Ap",
    color: "oklch(0.72 0.17 60)",
    reads: "The list of Apollo users (to link each one to an Emp-ID); emails sent through sequences with opened, replied and bounced; calls made with the Apollo dialer; Apollo tasks; new contacts.",
    how: "Apollo's official API, read only, every 15 to 30 minutes.",
    limits: "Needs a paid plan and a master API key, which can open the whole Apollo account, so it is kept encrypted on the server only. Apollo limits calls per hour, so the system asks only for what changed since the last sync.",
    keyLabel: "Master API key",
    linksUsers: true,
  },
  millionverifier: {
    id: "millionverifier",
    name: "MillionVerifier",
    short: "MV",
    color: "oklch(0.62 0.15 155)",
    reads: "The result of every email check (valid, invalid, catch-all, unknown), who asked for it, and the credits left.",
    how: "Lists are checked through the Aceva system (Leads → Verify emails), which sends them to MillionVerifier's API and saves the results.",
    limits: "Each check uses 1 credit. MillionVerifier can't tell who checked a list, which is why lists go through Aceva. An email checked in the last 90 days is not checked again.",
    keyLabel: "API key",
    linksUsers: false,
  },
  mailboxes: {
    id: "mailboxes",
    name: "Outreach mailboxes",
    short: "MB",
    color: "oklch(0.6 0.13 240)",
    reads: "Number of emails sent, replies and bounces, per mailbox and per domain. Only sender, receiver, date and subject; never the message text.",
    how: "A read-only mailbox login (IMAP) on the Hostinger outreach mailboxes.",
    limits: "Mainly for emails sent outside Apollo, and for watching each outreach domain's bounce rate.",
    keyLabel: "Mailbox password",
    linksUsers: true,
  },
  salesforce: {
    id: "salesforce",
    name: "Salesforce",
    short: "SF",
    color: "oklch(0.62 0.14 230)",
    reads: "Leads, opportunities and activities.",
    how: "Salesforce's API, through a separate integration user.",
    limits: "API access comes with the Enterprise edition and above; Professional and Pro Suite need a paid add-on; Starter has none.",
    keyLabel: "Integration user token",
    linksUsers: true,
    advice: "Only connect Salesforce if a client requires it. The Sales module (Leads and Pipeline) already does this job.",
  },
};

export const TOOL_ORDER: ToolId[] = ["apollo", "millionverifier", "mailboxes", "salesforce"];

export const BOUNCE_LIMIT_PCT = 3;

export const rate = (part: number, total: number) => (total > 0 ? (part / total) * 100 : 0);

export function domainStats(mailboxes: MailboxStat[]) {
  const map = new Map<string, { domain: string; sentToday: number; bouncesToday: number; sentWeek: number; bouncesWeek: number; mailboxes: number }>();
  for (const m of mailboxes) {
    const d = map.get(m.domain) ?? { domain: m.domain, sentToday: 0, bouncesToday: 0, sentWeek: 0, bouncesWeek: 0, mailboxes: 0 };
    d.sentToday += m.sentToday;
    d.bouncesToday += m.bouncesToday;
    d.sentWeek += m.sentWeek;
    d.bouncesWeek += m.bouncesWeek;
    d.mailboxes += 1;
    map.set(m.domain, d);
  }
  return [...map.values()];
}

/** Days of MillionVerifier credits left at the current rate. */
export function creditRunwayDays(c: ToolConnection) {
  if (!c.creditsLeft || !c.creditsUsedPerDay) return undefined;
  return Math.floor(c.creditsLeft / c.creditsUsedPerDay);
}

/** Alert rules from plan §21. */
export function buildAlerts(connections: ToolConnection[], mailboxes: MailboxStat[], unmatched: UnmatchedItem[], unmatchedUsers: string[]): IntegrationAlert[] {
  const alerts: IntegrationAlert[] = [];
  for (const c of connections) {
    if (c.status === "failing" && c.failingSince && Date.now() - new Date(c.failingSince).getTime() > 60 * 60_000)
      alerts.push({ id: `fail_${c.tool}`, tool: c.tool, severity: "danger", title: `${TOOL_META[c.tool].name} has been failing for over an hour`, detail: c.lastError ?? "Check the key and the tool's status page." });
    if (c.tool === "millionverifier" && c.creditsLeft !== undefined && c.creditAlertAt !== undefined && c.creditsLeft <= c.creditAlertAt * 1.5)
      alerts.push({
        id: "mv_credits",
        tool: c.tool,
        severity: c.creditsLeft <= c.creditAlertAt ? "danger" : "warning",
        title: c.creditsLeft <= c.creditAlertAt ? "MillionVerifier credits are below the alert level" : "MillionVerifier credits are running low",
        detail: `${c.creditsLeft.toLocaleString()} credits left, alert at ${c.creditAlertAt.toLocaleString()}. About ${creditRunwayDays(c) ?? "?"} days at today's rate.`,
      });
  }
  for (const m of mailboxes) {
    const pct = rate(m.bouncesToday, m.sentToday);
    if (!m.paused && pct > BOUNCE_LIMIT_PCT)
      alerts.push({ id: `bounce_${m.mailbox}`, tool: "mailboxes", severity: "danger", title: `${m.mailbox} bounced ${pct.toFixed(1)}% today`, detail: "Over 3%. Pause this mailbox before the domain's reputation is damaged." });
  }
  for (const name of unmatchedUsers) {
    const n = unmatched.filter((u) => u.userName === name).length;
    alerts.push({ id: `unmatched_${name}`, tool: "apollo", severity: "warning", title: `New Apollo user not linked: ${name}`, detail: `${n} item${n === 1 ? "" : "s"} waiting and not counted for anyone until linked to an Emp-ID.` });
  }
  return alerts;
}
