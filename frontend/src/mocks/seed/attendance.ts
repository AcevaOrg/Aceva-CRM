/**
 * Seed: attendance history, corrections, leave types, balances and requests (Module 7).
 * Deterministic per Emp-ID + date, and relative to today so it never looks stale.
 * Aceva structure: CEO / Founder / Owner (ACV-0001) → Director (ACV-0003) → CTO (ACV-0004), Sales, Finance (ACV-0010)
 * → Engineering (report to the CTO). Leave chains come from buildLeaveChain: Engineering CTO → Director;
 * CTO, Sales and Finance: Director; Director: CEO / Founder / Owner (the only CEO sign-off).
 */
import type { AttendanceCorrection, AttendanceDay, LeaveRequest, LeaveType } from "@/features/attendance/types";
import { buildLeaveChain, lateMinutes, leaveDays } from "@/features/attendance/logic";
import { isoDay, isWorkingDay } from "@/lib/dates";
import type { ApprovalStep } from "@/types";
import { HOLIDAY_DATES } from "./calendar";
import { EMPLOYEES } from "./people";
import { minutesAgo, workdaysFromNow } from "../time";

/** Stable pseudo-random number in [0, 1) for a key. */
export function hash01(key: string) {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  h ^= h >>> 13;
  h = Math.imul(h, 2246822507);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

const LATE_PROB: Record<string, number> = { "ACV-0008": 0.22, "ACV-0014": 0.18, "ACV-0012": 0.15, "ACV-0013": 0.12, "ACV-0007": 0.05, "ACV-0004": 0.03 };

function at(day: Date, minutesFromMidnight: number) {
  const d = new Date(day);
  d.setHours(0, 0, 0, 0);
  d.setMinutes(minutesFromMidnight);
  return d.toISOString();
}

const DAYS_BACK = 75;

export function seedAttendance(): AttendanceDay[] {
  const out: AttendanceDay[] = [];
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  for (const e of EMPLOYEES) {
    const joined = new Date(e.joiningDate);
    for (let back = 1; back <= DAYS_BACK; back++) {
      const day = new Date(today);
      day.setDate(day.getDate() - back);
      if (day < joined || !isWorkingDay(day, HOLIDAY_DATES)) continue;
      const date = isoDay(day);
      const r = hash01(`${e.empId}|${date}`);
      const r2 = hash01(`${date}|late|${e.empId}`);
      const r3 = hash01(`${e.empId}|in|${date}`);
      const r4 = hash01(`${e.empId}|out|${date}`);
      const r5 = hash01(`${e.empId}|login|${date}`);
      if (r < 0.012) {
        out.push({ empId: e.empId, date, status: "absent" });
        continue;
      }
      const late = r2 < (LATE_PROB[e.empId] ?? 0.08);
      const inMin = late ? 9 * 60 + 16 + Math.floor(r3 * 40) : 8 * 60 + 40 + Math.floor(r3 * 34);
      const checkIn = at(day, inMin);
      const missed = r >= 0.012 && r < 0.04;
      const checkOut = missed ? at(day, 18 * 60) : at(day, 17 * 60 + 55 + Math.floor(r4 * 50));
      const gap = r5 > 0.94 ? 45 + Math.floor(r5 * 40) : Math.floor(r5 * 14) - 3;
      const lm = lateMinutes(checkIn);
      out.push({
        empId: e.empId,
        date,
        checkIn,
        checkOut,
        firstLogin: at(day, inMin + gap),
        status: missed ? "missed_checkout" : lm > 0 ? "late" : "on_time",
        lateMinutes: lm || undefined,
      });
    }
  }
  // Fixed records that the correction seeds refer to.
  const fix = (empId: string, wd: number, patch: Partial<AttendanceDay>) => {
    const date = isoDay(workdaysFromNow(wd));
    const rec = out.find((d) => d.empId === empId && d.date === date);
    if (rec) Object.assign(rec, patch);
    else out.push({ empId, date, status: "absent", ...patch });
  };
  const d2 = workdaysFromNow(-2);
  fix("ACV-0007", -2, { status: "missed_checkout", checkIn: at(new Date(d2), 8 * 60 + 56), checkOut: at(new Date(d2), 18 * 60), lateMinutes: undefined, correctionId: "cor_1" });
  const d4 = workdaysFromNow(-4);
  fix("ACV-0008", -4, { status: "on_time", checkIn: at(new Date(d4), 9 * 60 + 5), checkOut: at(new Date(d4), 18 * 60 + 12), lateMinutes: undefined, correctionId: "cor_2" });
  fix("ACV-0011", -1, { status: "absent", checkIn: undefined, checkOut: undefined, firstLogin: at(new Date(workdaysFromNow(-1)), 9 * 60 + 4), lateMinutes: undefined, correctionId: "cor_3" });
  const d3 = workdaysFromNow(-3);
  fix("ACV-0003", -3, { status: "missed_checkout", checkIn: at(new Date(d3), 9 * 60 + 2), checkOut: at(new Date(d3), 18 * 60), lateMinutes: undefined, correctionId: "cor_4" });
  const d6 = workdaysFromNow(-6);
  fix("ACV-0010", -6, { status: "on_time", checkIn: at(new Date(d6), 8 * 60 + 58), checkOut: at(new Date(d6), 18 * 60 + 5), firstLogin: at(new Date(d6), 9 * 60), lateMinutes: undefined, correctionId: "cor_5" });
  return out;
}

/** Today's state for people other than the viewer (the viewer's own day comes from the session). */
export const TODAY_PLAN: Record<string, { inAt?: string; loginGap?: number; outAt?: string }> = {
  "ACV-0001": {},
  "ACV-0003": { inAt: "09:06", loginGap: 1 },
  "ACV-0004": { inAt: "08:41", loginGap: 3 },
  "ACV-0006": { inAt: "08:49", loginGap: 2 },
  "ACV-0007": { inAt: "08:57", loginGap: 4 },
  "ACV-0008": { inAt: "09:24", loginGap: 52 },
  "ACV-0009": { inAt: "09:05", loginGap: 1 },
  "ACV-0010": { inAt: "08:58", loginGap: 6 },
  "ACV-0011": { inAt: "08:51", loginGap: 3 },
  "ACV-0012": {},
  "ACV-0013": {},
  "ACV-0014": { inAt: "09:31", loginGap: 2 },
};

export function seedCorrections(): AttendanceCorrection[] {
  const day = (wd: number, hm: string) => workdaysFromNow(wd, hm);
  return [
    {
      id: "cor_1",
      empId: "ACV-0007",
      date: isoDay(workdaysFromNow(-2)),
      original: { checkIn: day(-2, "08:56"), checkOut: day(-2, "18:00") },
      requested: { checkIn: day(-2, "08:56"), checkOut: day(-2, "18:25") },
      reason: "Forgot to check out. I left at 18:25 after the release call.",
      status: "pending",
      at: minutesAgo(60 * 20),
    },
    {
      id: "cor_2",
      empId: "ACV-0008",
      date: isoDay(workdaysFromNow(-4)),
      original: { checkIn: day(-4, "09:32"), checkOut: day(-4, "18:12") },
      requested: { checkIn: day(-4, "09:05"), checkOut: day(-4, "18:12") },
      reason: "Internet was down at home; I was on the stand-up call from 09:00 on my phone.",
      status: "approved",
      // Ali Raza reports to the CTO, who approves his corrections.
      decidedBy: "ACV-0004",
      decidedAt: minutesAgo(60 * 70),
      decisionNote: "Confirmed, I saw you on the call.",
      at: minutesAgo(60 * 90),
    },
    {
      id: "cor_3",
      empId: "ACV-0011",
      date: isoDay(workdaysFromNow(-1)),
      original: {},
      requested: { checkIn: day(-1, "09:00"), checkOut: day(-1, "18:10") },
      reason: "I forgot to check in. I was in the Karachi office all day (login at 09:04).",
      status: "pending",
      at: minutesAgo(60 * 3),
    },
    {
      // The Director's own correction: the only kind the CEO / Founder / Owner approves.
      id: "cor_4",
      empId: "ACV-0003",
      date: isoDay(workdaysFromNow(-3)),
      original: { checkIn: day(-3, "09:02"), checkOut: day(-3, "18:00") },
      requested: { checkIn: day(-3, "09:02"), checkOut: day(-3, "19:40") },
      reason: "Forgot to check out after the evening client review in the Dadu office.",
      status: "pending",
      at: minutesAgo(60 * 6),
    },
    {
      id: "cor_5",
      empId: "ACV-0010",
      date: isoDay(workdaysFromNow(-6)),
      original: { checkIn: day(-6, "09:41"), checkOut: day(-6, "18:05") },
      requested: { checkIn: day(-6, "08:58"), checkOut: day(-6, "18:05") },
      reason: "The office tablet was down in the morning; I was at the bank for the salary transfer file from 08:58.",
      status: "approved",
      // Sana Malik (Finance) reports to the Director, who approves her corrections.
      decidedBy: "ACV-0003",
      decidedAt: minutesAgo(60 * 24 * 5),
      decisionNote: "Confirmed with the bank visit log.",
      at: minutesAgo(60 * 24 * 6),
    },
  ];
}

export const LEAVE_TYPES: LeaveType[] = [
  { id: "lt-casual", name: "Casual", yearlyDays: 10, paid: true, color: "var(--chart-1)" },
  { id: "lt-sick", name: "Sick", yearlyDays: 8, paid: true, color: "var(--chart-3)" },
  { id: "lt-annual", name: "Annual", yearlyDays: 14, paid: true, color: "var(--chart-2)" },
  { id: "lt-unpaid", name: "Unpaid", yearlyDays: 0, paid: false, color: "var(--chart-5)" },
];

/** Days already used this year before the requests below (seeded history). */
export function seedBaseUsed(): { empId: string; leaveTypeId: string; used: number }[] {
  return EMPLOYEES.flatMap((e) => [
    { empId: e.empId, leaveTypeId: "lt-casual", used: 2 + Math.floor(hash01(`${e.empId}casual`) * 4) },
    { empId: e.empId, leaveTypeId: "lt-sick", used: Math.floor(hash01(`${e.empId}sick`) * 4) },
    { empId: e.empId, leaveTypeId: "lt-annual", used: Math.floor(hash01(`${e.empId}annual`) * 7) },
    { empId: e.empId, leaveTypeId: "lt-unpaid", used: e.empId === "ACV-0013" ? 1 : 0 },
  ]);
}

type ReqSeed = [empId: string, type: string, fromWd: number, toWd: number, status: LeaveRequest["status"], reason: string, minAgo: number, opts?: { halfDay?: boolean; note?: string }];

const REQS: ReqSeed[] = [
  // Engineering: CTO first, then the Director.
  ["ACV-0008", "lt-casual", 3, 4, "pending_manager", "Family wedding in Hyderabad.", 25],
  ["ACV-0013", "lt-sick", 1, 1, "pending_manager", "Doctor's appointment, fever since last night.", 200],
  ["ACV-0006", "lt-annual", 15, 16, "pending_director", "Brother's wedding in Multan.", 60 * 30],
  // Sales and Finance: the Director only (sales manager duty, and the Finance person reports to the Director).
  ["ACV-0012", "lt-casual", 2, 2, "pending_manager", "Moving to a new flat.", 60 * 26],
  ["ACV-0010", "lt-annual", 18, 19, "pending_manager", "Visiting family in Lahore.", 60 * 4],
  // CTO: the Director only.
  ["ACV-0004", "lt-annual", 12, 14, "pending_manager", "Annual family trip to Skardu.", 60 * 5],
  // Director: the CEO / Founder / Owner (the only request the CEO approves).
  ["ACV-0003", "lt-casual", 7, 7, "pending_manager", "Property paperwork at the land office.", 60 * 8],
  ["ACV-0007", "lt-annual", 8, 10, "approved", "Sister's graduation and a short trip.", 60 * 72],
  ["ACV-0011", "lt-casual", -6, -6, "approved", "Personal errand.", 60 * 24 * 9],
  ["ACV-0009", "lt-annual", -12, -11, "approved", "Eid travel with family.", 60 * 24 * 16],
  ["ACV-0007", "lt-casual", -15, -15, "rejected", "Day off after the release.", 60 * 24 * 20, { note: "Release week. Please pick a day next week." }],
  ["ACV-0013", "lt-unpaid", -20, -20, "approved", "University exam.", 60 * 24 * 26],
  ["ACV-0006", "lt-casual", 5, 5, "approved", "Personal work at the bank.", 60 * 24 * 2, { halfDay: true }],
  ["ACV-0010", "lt-sick", -9, -9, "approved", "Fever and a doctor's visit.", 60 * 24 * 14],
];

export function seedLeaveRequests(): LeaveRequest[] {
  return REQS.map(([empId, leaveTypeId, fromWd, toWd, status, reason, minAgo, opts], i) => {
    const from = isoDay(workdaysFromNow(fromWd));
    const to = isoDay(workdaysFromNow(toWd));
    const chain: ApprovalStep[] = buildLeaveChain(empId, EMPLOYEES).map((s, idx): ApprovalStep => {
      const decidedAt = minutesAgo(Math.max(5, minAgo - 60 * (idx + 1)));
      if (status === "approved") return { ...s, state: "done", at: decidedAt };
      if (status === "rejected") return idx === 0 ? { ...s, state: "rejected", at: decidedAt, note: opts?.note } : { ...s, state: "skipped" };
      if (status === "pending_director") return idx === 0 ? { ...s, state: "done", at: decidedAt } : { ...s, state: "waiting" };
      return idx === 0 ? { ...s, state: "waiting" } : s;
    });
    return {
      id: `lv_${i + 1}`,
      number: `LV-${String(410 + i).padStart(4, "0")}`,
      empId,
      leaveTypeId,
      from,
      to,
      days: leaveDays(from, to, HOLIDAY_DATES, opts?.halfDay),
      halfDay: opts?.halfDay,
      reason,
      status,
      chain,
      at: minutesAgo(minAgo),
    };
  });
}
