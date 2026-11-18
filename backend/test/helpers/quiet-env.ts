/**
 * Module 4 starts background work by itself when the app boots: the outbox dispatcher polls every few seconds, and the
 * daily summary service schedules seven summary jobs for the last seven days. Tests deliver outbox events and build
 * summaries themselves (OutboxDispatcher.tick(), ActivitySummaryService.buildDay()), so nothing may run, or be left in
 * the tables, while a test looks at them. Called by test/global-setup.ts (forked test workers inherit the variables),
 * by createTestApp() and by every test that builds AppModule itself.
 */
export function switchOffBackgroundWork(): void {
  process.env.OUTBOX_DISPATCH_INTERVAL_MS = '0';
  process.env.ACTIVITY_SUMMARY_SCHEDULE = 'off';
}
