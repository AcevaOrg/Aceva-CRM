/**
 * Seed: sessions, events, daily summaries and security alerts (Module 4).
 * Today's events are relative to "now"; earlier days use working days back.
 */
import type { AccountLock, ActivityEvent, DailySummary, OnlineSession, SecurityAlert } from "@/features/activity/types";
import type { Employee, RoleKey } from "@/types";
import { isoDay } from "@/lib/dates";
import { EMPLOYEES } from "./people";
import { minutesAgo, workdaysFromNow } from "../time";

/** Small deterministic random so the demo looks the same on every reload. */
function rng(seed: number) {
  let s = seed % 2147483647 || 1;
  return () => (s = (s * 16807) % 2147483647) / 2147483647;
}

/** Screens each role opens (one person per role in Management, so this is keyed by role, not department). */
const SCREENS: Record<RoleKey, string[]> = {
  owner: ["Home", "Insights", "Statements", "Payroll", "Activity", "Sales reports"],
  ceo: ["Home", "Insights", "Statements", "Payroll", "Activity", "Approvals"],
  lead: ["Home", "Task board", "Messages", "Leave", "Attendance"],
  director: ["Home", "Approvals", "People", "Payroll", "Ledger", "Leave"],
  cto: ["Task board", "Approvals", "Activity", "Integrations", "Backups", "Messages"],
  finance: ["Ledger", "Journal entry", "Banking", "Payroll", "Statements", "Bills and expenses"],
  sales: ["My sales day", "Leads", "Pipeline", "Sales reports", "Messages"],
  developer: ["My tasks", "Task board", "Messages", "Attendance", "Leave", "Performance"],
};

/**
 * What each role does. The CEO / Founder / Owner only views and exports; the Director approves (and does HR and
 * sales-manager work); Finance prepares and submits; the CTO assigns, reviews and gives the first leave step.
 */
const ACTIONS: Record<RoleKey, [ActivityEvent["action"], string, string][]> = {
  owner: [
    ["export", "Statements", "Exported the income statement (PDF)"],
    ["download", "Insights", "Downloaded the monthly insights report"],
    ["print", "Payroll", "Printed the October payroll summary"],
  ],
  ceo: [
    ["export", "Statements", "Exported the income statement (PDF)"],
    ["approve", "Leave", "Signed off the Director's leave request"],
  ],
  lead: [
    ["comment", "Tasks", "Commented on TSK-0120"],
    ["edit", "Leave", "Reviewed a team leave request"],
  ],
  director: [
    ["approve", "Approvals", "Approved journal entry JE-2026-0309"],
    ["approve", "Leave", "Approved leave request #58 (final step)"],
    ["comment", "Approvals", "Added a remark to Hira Baig's October scorecard"],
    ["edit", "People", "Updated the emergency contact of ACV-0013"],
    ["create", "Announcements", "Published “Go-live on 30 November”"],
  ],
  cto: [
    ["approve", "Tasks", "Approved task TSK-0141 with 4 stars"],
    ["approve", "Leave", "Approved leave request #61 (first step, sent to the Director)"],
    ["comment", "Tasks", "Commented on TSK-0120"],
    ["create", "Tasks", "Assigned TSK-0144 to Mariam Shah"],
  ],
  finance: [
    ["create", "Ledger", "Created draft entry JE-2026-0314"],
    ["submit", "Ledger", "Submitted JE-2026-0311 to the Director for approval"],
    ["edit", "Banking", "Matched 12 bank statement lines"],
    ["create", "Bills and expenses", "Recorded bill BILL-0087 (office internet)"],
  ],
  sales: [
    ["create", "Sales", "Added lead Olivia Grant (Harbor & Co)"],
    ["edit", "Sales", "Moved deal DL-0017 to Meeting booked"],
    ["comment", "Sales", "Logged a call with Northwind Studio"],
  ],
  developer: [
    ["submit", "Tasks", "Submitted task TSK-0122 for review"],
    ["comment", "Tasks", "Commented on TSK-0120"],
    ["edit", "Tasks", "Ticked a checklist item on TSK-0125"],
    ["upload", "Tasks", "Uploaded screenshot.png to TSK-0122"],
  ],
};

const DEVICES = ["Chrome on Windows", "Edge on Windows", "Chrome on macOS", "Chrome on Android"];
const CITIES = ["Karachi", "Dadu", "Hyderabad", "Karachi"];

/** Same rule as requires2fa (lib/auth/viewer): CEO / Founder / Owner, Director, CTO and Finance. */
const uses2fa = (e: Employee) => e.level <= 3 || e.duties.includes("finance");

const activeStaff = () => EMPLOYEES.filter((e) => e.status === "active");

/** Not in today: the CEO / Founder / Owner, the part-time intern, and Kamran (locked out). */
const ABSENT_TODAY = ["ACV-0001", "ACV-0013", "ACV-0012"];

function ts(dayBack: number, minutesFromStart: number, startMinutesAgo: number) {
  if (dayBack === 0) return minutesAgo(Math.max(1, startMinutesAgo - minutesFromStart));
  const base = new Date(workdaysFromNow(-dayBack, "09:00"));
  return new Date(base.getTime() + (minutesFromStart - 10) * 60_000).toISOString();
}

export function seedEvents(): ActivityEvent[] {
  const out: ActivityEvent[] = [];
  let n = 0;
  const push = (e: Omit<ActivityEvent, "id">) => out.push({ id: `ev_${++n}`, ...e });

  activeStaff().forEach((emp, ei) => {
    for (let d = 0; d < 7; d++) {
      if (d === 0 && ABSENT_TODAY.includes(emp.empId)) continue; // not in today
      const r = rng(ei * 97 + d * 13 + 7);
      const start = d === 0 ? 260 + Math.floor(r() * 120) : 0;
      // Ali Raza checked in at 09:05 yesterday but only logged in at 10:40 (demo of the check-in gap).
      const shift = emp.empId === "ACV-0008" && d === 1 ? 100 : 0;
      const device = DEVICES[ei % 3];
      const city = CITIES[ei % CITIES.length];
      const ip = `39.45.12.${20 + ei}`;
      push({ empId: emp.empId, at: ts(d, Math.floor(r() * 18) + shift, start), source: "aceva", action: "login", module: "Login", description: `Signed in${uses2fa(emp) ? " with 2FA" : ""}`, ip, city, device });
      const screens = SCREENS[emp.role];
      const acts = ACTIONS[emp.role];
      let t = 22 + shift;
      for (let i = 0; i < 7; i++) {
        t += 18 + Math.floor(r() * 40);
        if (d === 0 && t > start - 2) break;
        if (i % 2 === 0) {
          const s = screens[Math.floor(r() * screens.length)];
          push({ empId: emp.empId, at: ts(d, t, start), source: "aceva", action: "screen_view", module: s, description: `Opened ${s}` });
        } else {
          const [action, module, description] = acts[Math.floor(r() * acts.length)];
          push({ empId: emp.empId, at: ts(d, t, start), source: "aceva", action, module, description });
        }
      }
      if (emp.departmentId === "dep-sales") {
        const sent = 20 + Math.floor(r() * 20);
        push({ empId: emp.empId, at: ts(d, 140, start), source: "millionverifier", action: "email_check", module: "Sales", description: `Checked ${sent + 5} emails (${2 + Math.floor(r() * 3)} invalid)` });
        push({ empId: emp.empId, at: ts(d, 175, start), source: "apollo", action: "email_sent", module: "Sales", description: `${sent} emails sent through Apollo sequence “UK agencies”` });
        push({ empId: emp.empId, at: ts(d, 230, start), source: "apollo", action: "reply", module: "Sales", description: `${1 + Math.floor(r() * 3)} replies received` });
        push({ empId: emp.empId, at: ts(d, 240, start), source: "mailbox", action: "bounce", module: "Sales", description: `1 bounce on hira@getaceva.co` });
      }
      if (d > 0) {
        const late = r() > 0.75;
        const end = new Date(workdaysFromNow(-d, late ? "13:40" : "18:05"));
        push({ empId: emp.empId, at: end.toISOString(), source: "aceva", action: "logout", module: "Login", description: late ? "Timed out after 30 minutes idle" : "Signed out", how: late ? "timed_out" : "clicked" });
      }
    }
  });

  // Notable events the demo relies on.
  push({ empId: "ACV-0008", at: minutesAgo(56), source: "aceva", action: "security", module: "Login", description: "New device: Android phone, Lahore", city: "Lahore", device: "Chrome on Android", ip: "182.185.4.77" });
  push({ empId: "ACV-0008", at: minutesAgo(31), source: "aceva", action: "blocked", module: "Statements", description: "Tried to open the balance sheet (no permission)" });
  push({ empId: "ACV-0008", at: minutesAgo(29), source: "aceva", action: "blocked", module: "Payroll", description: "Tried to open the payroll run PR-2026-10 (no permission)" });
  push({ empId: "ACV-0003", at: workdaysFromNow(-1, "11:20"), source: "aceva", action: "sensitive_view", module: "Payroll", target: "ACV-0011", description: "Viewed payslip of ACV-0011" });
  // Exports of finance data are for the CEO / Founder / Owner and the Director; Finance prepares and submits.
  push({ empId: "ACV-0003", at: workdaysFromNow(-1, "15:05"), source: "aceva", action: "export", module: "Statements", description: "Exported the general ledger (1,240 rows, Excel)" });
  push({ empId: "ACV-0010", at: workdaysFromNow(-1, "14:20"), source: "aceva", action: "submit", module: "Payroll", description: "Prepared the November payroll run and sent it to the Director for approval" });
  push({
    empId: "ACV-0006",
    at: minutesAgo(140),
    source: "aceva",
    action: "edit",
    module: "Tasks",
    target: "TSK-0131",
    description: "Changed the deadline of TSK-0131 (reason: client moved the review)",
    changes: [{ field: "Deadline", from: "12 Nov", to: "15 Nov" }],
  });
  push({ empId: "ACV-0012", at: minutesAgo(141), source: "aceva", action: "login_failed", module: "Login", description: "Account locked after 5 wrong passwords", city: "Karachi", device: "Chrome on Windows" });

  return out.sort((a, b) => b.at.localeCompare(a.at));
}

/** Today's first login per person, taken from the event log so every screen agrees. */
function todayLogin(events: ActivityEvent[], empId: string) {
  const today = isoDay(new Date());
  return events.filter((e) => e.empId === empId && e.action === "login" && isoDay(e.at) === today).map((e) => e.at).sort()[0];
}

export function seedOnline(events: ActivityEvent[]): OnlineSession[] {
  return activeStaff()
    .filter((e) => !ABSENT_TODAY.includes(e.empId))
    .map((e: Employee, i) => {
      const screens = SCREENS[e.role];
      return {
        sessionId: `on_${e.empId}`,
        empId: e.empId,
        since: todayLogin(events, e.empId) ?? minutesAgo(200),
        currentScreen: screens[i % screens.length],
        state: i % 4 === 2 ? ("idle" as const) : ("active" as const),
        device: e.empId === "ACV-0008" ? "Chrome on Android" : DEVICES[i % 3],
        city: e.empId === "ACV-0008" ? "Lahore" : CITIES[i % CITIES.length],
        newDevice: e.empId === "ACV-0008",
      };
    });
}

/**
 * The nightly summary per person and day, built from the event log (plan §8 "Daily summary"):
 * first login, last logout, active and idle time, actions, compared with the attendance check-in.
 */
export function seedSummaries(events: ActivityEvent[]): DailySummary[] {
  const out: DailySummary[] = [];
  const byKey = new Map<string, ActivityEvent[]>();
  events.forEach((e) => {
    const k = `${e.empId}|${isoDay(e.at)}`;
    (byKey.get(k) ?? byKey.set(k, []).get(k)!).push(e);
  });
  activeStaff().forEach((e, ei) => {
    for (let d = 0; d < 7; d++) {
      const r = rng(ei * 31 + d * 5 + 3);
      const day = d === 0 ? new Date() : new Date(workdaysFromNow(-d, "09:00"));
      const list = byKey.get(`${e.empId}|${isoDay(day)}`) ?? [];
      const firstLogin = list.filter((x) => x.action === "login").map((x) => x.at).sort()[0];
      if (!firstLogin) continue;
      const lastLogout = list.filter((x) => x.action === "logout").map((x) => x.at).sort().pop();
      const startMs = new Date(firstLogin).getTime();
      const endMs = lastLogout ? new Date(lastLogout).getTime() : Date.now();
      const total = Math.max(1, Math.round((endMs - startMs) / 60_000));
      const idle = Math.min(25 + Math.floor(r() * 70), Math.round(total * 0.3));
      const idleStart = startMs + Math.min(125, Math.round(total * 0.4)) * 60_000;
      const gap = e.empId === "ACV-0008" && d === 1;
      const checkIn = new Date(day);
      if (gap) checkIn.setHours(9, 5, 0, 0);
      else checkIn.setTime(startMs - (3 + Math.floor(r() * 3)) * 60_000);
      out.push({
        empId: e.empId,
        date: isoDay(day),
        firstLogin,
        lastLogout,
        activeMinutes: Math.max(0, total - idle),
        idleMinutes: idle,
        actions: list.filter((x) => !["login", "logout", "screen_view"].includes(x.action)).length + 8 + Math.floor(r() * 25),
        tasksTouched: 1 + Math.floor(r() * 5),
        checkIn: checkIn.toISOString(),
        idleSpans: idle > 0 ? [{ from: new Date(idleStart).toISOString(), to: new Date(idleStart + idle * 60_000).toISOString() }] : [],
      });
    }
  });
  return out;
}

export function seedAlerts(): SecurityAlert[] {
  return [
    { id: "al_1", rule: "Repeated attempts to open finance screens", severity: "high", kind: "finance_attempts", empId: "ACV-0008", at: minutesAgo(29), details: "Tried the balance sheet and payroll run PR-2026-10 within 3 minutes. Both were blocked.", status: "open" },
    { id: "al_2", rule: "Login from a new city", severity: "high", kind: "new_device", empId: "ACV-0008", at: minutesAgo(56), details: "Signed in from Lahore on a new Android phone (182.185.4.77). Usual city: Karachi.", status: "open" },
    { id: "al_3", rule: "Account locked after 5 wrong passwords", severity: "medium", kind: "account_locked", empId: "ACV-0012", at: minutesAgo(141), details: "5 wrong passwords from Chrome on Windows, Karachi. The account stays locked until the Director (their manager) unlocks it.", status: "open" },
    { id: "al_4", rule: "Large export of finance data", severity: "medium", kind: "large_export", empId: "ACV-0003", at: workdaysFromNow(-1, "15:05"), details: "General ledger exported to Excel: 1,240 rows.", status: "checked", checkedBy: "ACV-0004", checkedAt: workdaysFromNow(-1, "16:10"), note: "The Director's copy for the October close review." },
    { id: "al_5", rule: "Login outside working hours", severity: "low", kind: "outside_hours", empId: "ACV-0009", at: workdaysFromNow(-2, "23:10"), details: "Signed in at 23:10 from Karachi.", status: "checked", checkedBy: "ACV-0003", checkedAt: workdaysFromNow(-1, "09:30"), note: "Replying to a UK lead in their working hours." },
    { id: "al_6", rule: "Many salary records opened in a short time", severity: "medium", kind: "salary_views", empId: "ACV-0003", at: workdaysFromNow(-3, "11:24"), details: "9 payslips opened in 5 minutes.", status: "checked", checkedBy: "ACV-0004", checkedAt: workdaysFromNow(-3, "12:00"), note: "The Director reviewing the payroll run before approval." },
  ];
}

export function seedLocks(): AccountLock[] {
  return [{ empId: "ACV-0012", at: minutesAgo(141), by: "system", reason: "5 wrong passwords" }];
}
