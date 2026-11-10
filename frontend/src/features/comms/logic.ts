/**
 * Pure communication rules (plan §19). Mirrored on the server; unit-test these.
 */
import { isSameDay, isToday, isYesterday } from "date-fns";
import type { Employee } from "@/types";
import { isTopLevelRole } from "@/types";
import { formatWeekdayLong } from "@/lib/dates";
import type { Message } from "./types";

/** File sharing limits (plan §19: file-type and size limits). */
export const FILE_LIMIT_BYTES = 25 * 1024 * 1024;
export const ALLOWED_EXTENSIONS = ["pdf", "docx", "xlsx", "pptx", "csv", "txt", "png", "jpg", "jpeg", "webp", "zip"];

export function checkFile(name: string, size: number): string | null {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  if (!ALLOWED_EXTENSIONS.includes(ext)) return `“.${ext || "?"}” files can't be shared. Allowed: ${ALLOWED_EXTENSIONS.join(", ")}.`;
  if (size > FILE_LIMIT_BYTES) return "Files must be 25 MB or smaller.";
  return null;
}

export const QUICK_REACTIONS = ["👍", "🎉", "✅", "👀", "🙏", "😂"];

/** Messages older than this are deleted by policy (placeholder until management decides, spec §14). */
export const RETENTION_TEXT = "Messages and files are kept for 2 years (placeholder until the Director confirms the retention period).";

export function dayLabel(iso: string) {
  const d = new Date(iso);
  if (isToday(d)) return "Today";
  if (isYesterday(d)) return "Yesterday";
  return formatWeekdayLong(d);
}

/** Group top-level messages by day for the list. */
export function groupByDay(messages: Message[]) {
  const groups: { day: string; label: string; items: Message[] }[] = [];
  for (const m of messages) {
    const last = groups[groups.length - 1];
    if (last && isSameDay(new Date(last.items[0].at), new Date(m.at))) last.items.push(m);
    else groups.push({ day: m.at, label: dayLabel(m.at), items: [m] });
  }
  return groups;
}

/** Consecutive messages by the same person within 5 minutes are shown compactly. */
export function isContinuation(prev: Message | undefined, m: Message) {
  return !!prev && prev.author === m.author && !prev.deleted && new Date(m.at).getTime() - new Date(prev.at).getTime() < 5 * 60_000;
}

/** "@Mariam" → the employee whose first name matches (case-insensitive). */
export function parseMentions(body: string, people: Pick<Employee, "empId" | "name">[]) {
  const names = Array.from(body.matchAll(/@([A-Za-z]+)/g)).map((m) => m[1].toLowerCase());
  return people.filter((p) => names.includes(p.name.split(" ")[0].toLowerCase())).map((p) => p.empId);
}

/** Split a body into text and mention parts for rendering. */
export function splitMentions(body: string) {
  return body.split(/(@[A-Za-z]+)/g).filter(Boolean);
}

/**
 * People who manage others day to day: the Director and the CTO.
 * The CEO / Founder / Owner oversees everything but manages nothing; Sales, Finance and Development don't manage.
 */
export function managesPeople(e: Pick<Employee, "role">) {
  return e.role === "director" || e.role === "cto";
}

/**
 * Who can create channels, and pin in any channel: comms admins (comms.admin) and managers (Director, CTO).
 * The CEO / Founder / Owner reads and posts in the channels he belongs to, but doesn't create or moderate them.
 */
export function canCreateChannel(e: Pick<Employee, "role">, isAdmin: boolean) {
  return isAdmin || managesPeople(e);
}

/** Who sees every announcement, including team-only ones: the CEO / Founder / Owner (oversight) and the Director. */
export function seesAllAnnouncements(e: Pick<Employee, "role">) {
  return isTopLevelRole(e.role) || e.role === "director";
}

/** Meetings not cancelled and not yet finished, soonest first. */
export function upcomingMeetings<T extends { start: string; durationMin: number; cancelled?: boolean }>(list: T[], now: number) {
  return list.filter((m) => !m.cancelled && new Date(m.start).getTime() + m.durationMin * 60_000 > now).sort((a, b) => a.start.localeCompare(b.start));
}

export function initialsOfChannel(name: string) {
  return name.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase();
}
