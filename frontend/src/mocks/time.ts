/** Seed dates are relative to today so the demo never looks stale (spec §7.3). */

function at(d: Date, time: string) {
  const [h, m] = time.split(":").map(Number);
  d.setHours(h, m, 0, 0);
  return d;
}

/** ISO string for today + n calendar days at HH:mm local time. */
export function daysFromNow(days: number, time = "09:00") {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return at(d, time).toISOString();
}

/** ISO string n minutes ago. */
export function minutesAgo(min: number) {
  return new Date(Date.now() - min * 60_000).toISOString();
}

/** ISO string for the nth working day from today (negative = past), skipping Sat/Sun. */
export function workdaysFromNow(n: number, time = "09:00") {
  const d = new Date();
  const step = n >= 0 ? 1 : -1;
  let left = Math.abs(n);
  while (left > 0) {
    d.setDate(d.getDate() + step);
    const day = d.getDay();
    if (day !== 0 && day !== 6) left--;
  }
  return at(d, time).toISOString();
}

/** "2026-10" for n months from now. */
export function monthFromNow(n: number) {
  const d = new Date();
  d.setDate(15);
  d.setMonth(d.getMonth() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}`;
}

export function dayOfMonth(monthOffset: number, day: number, time = "09:00") {
  const d = new Date();
  d.setDate(1);
  d.setMonth(d.getMonth() + monthOffset);
  d.setDate(day);
  return at(d, time).toISOString();
}
