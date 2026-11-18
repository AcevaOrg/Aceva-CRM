/**
 * Where the Attendance metric (A) of a scorecard comes from: "days present on time / working days" (plan section 10),
 * which Module 7 (attendance and leave, cycle 3) will provide. Until it exists the stand-in says "not available".
 *
 * THE STAND-IN NEVER INVENTS A NUMBER. It does not answer 100 for everyone (that would hand out up to 10 points nobody
 * earned) and it does not guess from logins. It answers `{ available: false }`; the score is then worked out WITHOUT
 * attendance (its weight is shared among the measured metrics, see rules/perf-score.ts), the metric is null and named
 * in `unmeasured` with the reason `attendance_not_available`, and the screens say "Not available yet". Nothing to
 * undo when Module 7 arrives: scorecards made before it keep the numbers they were made with, new ones use the figure.
 *
 * HOW MODULE 7 PLUGS IN: write a class that implements AttendanceSource (reading its attendance records) and replace
 * the provider in performance.module.ts: `{ provide: ATTENDANCE_SOURCE, useClass: Module7AttendanceSource }`. Nothing
 * else changes.
 *
 * WHAT AN IMPLEMENTATION MUST KEEP TO (the monthly job and the live figures both rely on it):
 *  - Answer `{ available: false }` when there is no figure to give (no attendance records for that person, or a month with no
 *    working days): never 100, never 0, never an average. A made-up figure would be frozen into a scorecard for ever.
 *  - Answer a plain number from 0 to 100 (a percentage, NOT a fraction: 92 means 92%), which the scorecard rounds to one decimal.
 *  - Throw only for a real fault (the attendance store cannot be read). The monthly job then counts that person as failed, makes
 *    no scorecard for them, and retries later, so a temporary fault is never stored as "not available".
 *  - Be cheap and read-only: it is asked once per person per scorecard, and once per live view.
 *  - The month is a Pakistan month ("2026-10").
 */

/** The attendance of one person in one month. */
export type AttendanceFigure =
  | {
      available: true;
      /** 0 to 100: days present on time / working days. */
      rate: number;
    }
  | { available: false };

export interface AttendanceSource {
  /**
   * The attendance rate of the person (internal employee id) for a month ("2026-10", Pakistan month): 0 to 100, or
   * `{ available: false }` when there is no figure (Module 7 not built, or the month has no working days to measure).
   */
  rateFor(employeeId: string, month: string): Promise<AttendanceFigure>;
}

/** Injection token for the attendance source. */
export const ATTENDANCE_SOURCE = Symbol('ATTENDANCE_SOURCE');

/** The stand-in until Module 7 exists: no figure for anybody. */
export class NotBuiltAttendanceSource implements AttendanceSource {
  async rateFor(): Promise<AttendanceFigure> {
    return { available: false };
  }
}
