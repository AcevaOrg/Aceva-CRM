# Module 4 acceptance checklist (plan section 8)

Final company structure: Level 1 CEO / Founder / Owner (one person, sees everything, view only), Level 2 Director (the
only approver, also HR and sales-manager duty), Level 3 CTO (runs the developers and SQA), Level 4 Sales and Finance,
Level 5 Developer / SQA.

**Status: BUILT, NOT YET ACCEPTED.** Everything below is uncommitted work on branch `cycle2-m4-m6`, waiting for the
project owner's check by hand ("How to check M4 by hand" at the end). The pure unit tests and the contract tests were run
and pass. **The four database test files (`backend/test/m4-*.test.ts`) were written but have not been run yet**: there
was no PostgreSQL or Redis on the machine where they were written. Run them with the command at the end.

Statuses: **Built, unit-tested** = the pure rule tests that ran pass. **Built, DB test written** = covered by a database
test that still has to be run. **Deferred** = not built now, with the module that does it.

## What is built, what is deferred

**Built.** Activity records for logins, failed logins, logouts (with how the session ended) and security changes, from the
Module 2 events; active and idle time from a 60-second "still here" signal; screens opened; a global action recorder that
logs every change, sensitive view, download/export/print and refused attempt of every module without the module doing
anything; "Changes" with old and new values from the audit log; saving off the request path into insert-only tables;
the nightly daily summary; six security alert rules with email to the Director and the CTO and "mark as checked" with a
note (maker-checker); force sign-out, lock and unlock; export logging; the visibility rules; a generic outbox dispatcher
and the alert settings. The frontend Activity screens work against the server behind `isLive("m4")`.

**Deferred (not part of this module).** Sales-tool activity (Module 16), the retention clean-up (needs a decision),
"tasks touched" from Module 5 and the attendance check-in from Module 7 (hooks are ready), the settings screen for the
alert rules (Module 12), in-app notifications (Module 12; the event is ready). Details in "Deferred" below.

## What is tracked (plan section 8, "What is tracked")

| # | Requirement | Status | Where | Verified by |
|---|---|---|---|---|
| T1 | Login: time, Emp-ID, success or fail, 2FA used, internet address, approximate city, device, browser | Built, DB test written | `activity-consumers.service.ts` (from `auth.login` / `auth.login_failed`); the city is set on the session by `SessionService.create` through `CityLocator`; "with two-step login" is added when the session passed 2FA | `m4-alerts` ("a login, a wrong password and a clicked logout", "two-step login says so") |
| T2 | Logout: time and how (clicked, timed out, forced by admin, password changed) | Built, unit-tested, DB test written | `logoutHow()` maps Module 2's reasons: `user` and `user_other_device` (ended from My devices) clicked; `idle_timeout` and `max_duration` timed out; `password_changed`; `forced`, `employee_left` and `too_many_wrong_codes` forced. The words: "Signed out from another device", "Signed out after too many wrong codes", "Timed out after 30 minutes without activity (10 on a finance screen)", and "Signed out by an administrator" for a plain `forced`. A timeout with the tab open is recorded as "Timed out": the browser sends `{ reason: "idle_timeout" }` on `POST /auth/logout`, and the server believes it only when the session's last-active time is old enough (idle for at least the limit minus 2 minutes: 28 minutes, or 8 on a finance screen). The finance-screen 10-minute limit is the browser's; the server accepts the claim at 8 minutes or more idle. A claim made too early ends the session as a clicked logout | `activity-classify.test`, `m4-alerts` (clicked, forced), `m4-logout-reason` (timed out, too-early claims, body refused), `session-limits.test` (the tolerance) |
| T3 | Session time: total, active, idle | Built, unit-tested, DB test written | `rules/activity-time.ts` (pure), `activity-summary.service.ts` | `activity-time.test` (21 cases: gaps, overlapping sessions, midnight, closed laptop...), `m4-time` (14 active / 6 idle from real heartbeats) |
| T4 | Screens opened | Built, DB test written | `POST /activity/screen`, `frontend/src/lib/telemetry.ts` | `m4-recording`, `m4-time` |
| T5 | Actions: create, edit, delete, submit, assign, approve, reject, comment, upload, download, export, print | Built, unit-tested, DB test written | `action-recorder.interceptor.ts` (global) and `rules/activity-classify.ts` | `activity-classify.test` (known routes and future ones), `m4-recording` |
| T6 | Changes: old and new value of every edited field | Built, unit-tested, DB test written | Joined from `audit_log` by request id (decision D1) | `activity-classify.test`, `m4-recording` ("Name: Human Resources -> People Operations"; pay shows field names only) |
| T7 | Sensitive views (salary, payslip, bank details, finance statement) even when nothing changed | Built, DB test written | `@SensitiveView` decorator; the M3 reveal (CNIC, bank account, salary) is connected | `m4-recording` |
| T8 | Blocked attempts | Built, DB test written | `blocked-attempt.filter.ts` (every 403, also from the AccessGuard) and finance screens opened without permission | `m4-recording` |
| T9 | Security events (password change, 2FA on or off, lock, unlock, new device) | Built, DB test written | New event `auth.security` from `AuthService` (every M2 admin path: lock after 5 wrong passwords, lock by an administrator, unlock, password change and reset, temporary password including the resend of a welcome email, 2FA on, off and reset). New device: alert A2 | `m4-alerts` |
| T10 | Sales tool activity, marked with the tool's name | **Deferred to Module 16** | `activity_events.source` exists (`aceva` or a tool name, checked by the database); the actions `email_sent`, `reply`, `bounce`, `call`, `email_check` exist | `m4-recording` (source format check) |

## How it works (plan section 8)

| # | Requirement | Status | Where | Verified by |
|---|---|---|---|---|
| H1 | Login and logout come from Module 2's session records | Built, DB test written | Consumer `activity.auth` on the outbox dispatcher | `m4-alerts` |
| H2 | "Still here" every 60 s with only "mouse or keyboard used"; 5 minutes without use is idle; when the signals stop, the last signal is the logout time | Built, unit-tested, DB test written | `POST /activity/heartbeat` (`{ active }` only, strict); `rules/activity-time.ts` | `contracts.test` (nothing but a boolean), `activity-time.test`, `m4-time` |
| H3 | One small event each time a screen opens | Built, DB test written | `trackScreen()` posts `{ screen, path }` | `m4-recording` |
| H4 | A recorder on the server logs every change and every sensitive view; developers do not have to remember | Built, DB test written | Global `APP_INTERCEPTOR` + global `APP_FILTER` in `activity.module.ts` | `m4-recording` |
| H5 | Saved in the background so the app stays fast; tables only allow adding rows, nobody can edit or delete | Built, DB test written | `ActivityRecorder` (buffer written every second, decision D2); insert-only triggers on `activity_events`, `activity_heartbeats`, `activity_daily_summaries`, `security_alerts`, `security_alert_checks` | `m4-recording` (update, delete and truncate refused on all five; no edit or delete route) |
| H6 | Nightly summary per employee: first login, last logout, active and idle hours, actions, tasks touched, attendance check-in | Built, DB test written (tasks touched and check-in through hooks) | `activity-summary.service.ts`: job `activity.daily_summary` at 00:15 Pakistan time, one per day, catching up 7 days | `m4-time` (built once, never changed; scheduler; hooks) |
| H7 | Alert rules check new events and notify the Director and the CTO | Built, DB test written | `activity-alerts.service.ts`, consumers `activity.alert-rules` and `activity.alert-mail` | `m4-recording`, `m4-alerts` (Mailpit-style memory mailer) |

## Admin screens and controls

| # | Requirement | Status | Endpoint | Verified by |
|---|---|---|---|---|
| S1 | Who is online now: name, since, current screen, active or idle, device | Built, DB test written | `GET /activity/online` | `m4-time` |
| S2 | Employee timeline: one person, one day, in order, with idle spans | Built, DB test written | `GET /activity/timeline` | `m4-time` |
| S3 | Activity search by person, department, module, action, date range (and source); export logged. The Module filter lists every module the server records (Org and Home included), so Org changes are found by choosing Org | Built, DB test written | `GET /activity/events`, `POST /activity/export` | `m4-recording`, `m4-time` |
| S4 | Daily and weekly reports | Built, DB test written | `GET /activity/summaries` (the screen adds up days) | `m4-time` |
| S5 | Security alerts, marked as checked by the reviewer | Built, DB test written | `GET /activity/alerts`, `POST /activity/alerts/:id/check` | `m4-alerts` |
| S6 | Controls: force logout of a session, lock or unlock an account | Built, DB test written | `POST /sessions/:id/force-logout`, `POST /employees/:empId/lock`, `POST /employees/:empId/unlock`, `GET /accounts/locked` | `m4-alerts` |

## Alerts the system raises

| # | Rule | Severity | Default | Status | Verified by |
|---|---|---|---|---|---|
| A1 | Account locked after 5 wrong passwords | medium | | Built, DB test written | `m4-alerts` |
| A2 | Login from a new device / from a new city | medium / high | on / on | Built, unit-tested, DB test written | `alert-rules.test`, `m4-alerts` |
| A3 | Login outside working hours (from settings) | low | 20:00 to 07:00 Pakistan time | Built, unit-tested, DB test written | `alert-rules.test`, `m4-alerts` |
| A4 | Large export of finance or employee data (one alert per person, kind of data and hour; later large exports in that hour are only logged); many salary records opened in a short time (your own salary or bank number is not counted) | medium | 500 rows; 5 in one hour | Built, DB test written | `m4-recording`, `m4-alerts` |
| A5 | Repeated attempts to open finance screens without permission | high | 3 in 15 minutes | Built, DB test written | `m4-recording` |

Every alert is stored once (a unique key per triggering event or time window), mailed to every active Director and CTO
with an official email, and shown to the CEO / Founder / Owner, the Director and the CTO. Only fresh activity (24 hours)
raises alerts, so switching Module 4 on over a backlog of old Module 2 events records them without alerting.

## Who can see tracking data (adapted to the final structure)

| Who | Sees | Status | Verified by |
|---|---|---|---|
| Everyone (`activity.view_own`) | Own login history, devices and activity (My activity, own search results, own timeline) | Built, DB test written | `m4-alerts`, `m4-time` |
| A manager with `activity.view_team` | The daily summary of the people below (reports; the timeline shows the summary only) | Built, unit-tested (no such role exists in the final structure) | `activity-access.test` |
| The CTO | Online, timelines and reports of the developers and SQA below him (full timeline); every security alert (`activity.security`); controls for his people. No company-wide search (same as the screens) | Built, unit-tested, DB test written | `activity-access.test`, `m4-time`, `m4-alerts` |
| The Director | Everyone below him (the whole company except the CEO / Founder / Owner): online, timelines, reports, search; every alert; controls | Built, DB test written | `m4-time`, `m4-alerts` |
| The CEO / Founder / Owner | Everything (his line is the whole company), read only: he cannot check alerts, sign anyone out or lock anyone | Built, DB test written | `m4-time`, `m4-alerts`, `m4-recording` |
| Nobody | Edits or deletes tracking data | Built, DB test written | `m4-recording` |

## Fair-use rules

| # | Rule | Status |
|---|---|---|
| F1 | No screen or keystroke recording: the heartbeat is one boolean, the screen signal a label and a path (the server refuses anything else) | Built, tested (`contracts.test`, `m4-recording`, `m4-time`) |
| F2 | Location is the approximate city from the internet address only, never GPS: a local list (`GEOIP_RANGES`), no outside service | Built, unit-tested (`alert-rules.test`) |
| F3 | The recorder never stores request bodies, query strings, passwords, codes or pay figures | Built, DB test written (`m4-recording`) |
| F4 | Employees accept the tracking policy at first login | Shown and ticked in the first-login wizard (Module 2, `features/auth/policy`), but **not yet stored or enforced on the server** (no `POST /auth/policy/accept`). Deferred, see the Deferred table |

## Retention (plan section 8: sessions and screens 1 year, actions 3 years, finance-linked at least 10 years)

**Deferred: needs a decision with the project owner.** The tracking tables are insert-only by design (a trigger refuses
every delete), so nothing is deleted now and there is no clean-up job. What is ready for a clean-up later: every tracking
table has an index on its time column (`activity_events.occurred_at`, `activity_heartbeats.at`,
`activity_daily_summaries.day`, `security_alerts.occurred_at`, `security_alert_checks.checked_at`), so a delete by age does
not have to scan the table. `activity_events.finance_linked` marks records linked to finance (finance modules, payroll,
salary, bank and payslip views, finance exports and refused finance attempts) and is indexed with the time. The M4
migration has two of these indexes: `activity_heartbeats_at_idx` and `security_alert_checks_checked_at_idx`. The migration
`20261113100000_m4_activity_tracking` has never been applied anywhere, so it was edited in place and no new migration was
added. Anyone who already applied the older version must create the two indexes by hand:
`CREATE INDEX activity_heartbeats_at_idx ON activity_heartbeats (at);` and
`CREATE INDEX security_alert_checks_checked_at_idx ON security_alert_checks (checked_at);`. The database test
`backend/test/m4-time.test.ts` (the "M4 retention" test, which reads `pg_indexes`) fails if one of them is missing. A
clean-up would need a migration that lets one database role remove rows older than the policy (and a record of each
clean-up), which is exactly what the insert-only rule forbids today, hence the decision.

## Data stored

`activity_events`, `activity_heartbeats`, `activity_daily_summaries`, `security_alerts`, `security_alert_checks` (all
insert-only), `system_settings` (settings by section, read-only for now), `outbox_deliveries` and new columns on
`outbox_events` (dispatcher), `audit_log.request_id` index. Migration `20261113100000_m4_activity_tracking`.

## Decisions taken where the plan was open

| # | Decision | Why |
|---|---|---|
| D1 | "Changes" are **joined** from `audit_log`, not copied: every request gets an id (`X-Request-Id`), the audit rows and the activity record of that request share it, and search turns `details.before/after` into field changes. Module 3 keeps sensitive old values only in its own encrypted profile history, so for profiles the change shows the field names ("Base salary: changed"), never the values | No duplication of the legal record; no sensitive values copied into tracking data. New modules get the diff for free by writing `{ before, after }` in their audit details |
| D2 | Saving is an in-memory buffer written every second in one transaction (with the alert events). A hard crash can lose up to about a second of activity records; a normal shutdown (Ctrl+C, `docker stop`, a restart) writes the buffer first, because `main.ts` calls `app.enableShutdownHooks()`. On shutdown the outbox dispatcher finishes the event it is handling and hands the rest of its claimed batch back untried | The plan asks for "a queue saved in the background"; the job runner would add a database write per request anyway. The audit log stays the complete legal record of changes |
| D3 | A blocked attempt is any 403 except "finish logging in", "confirm again first", a stale page (CSRF), another website, and the login screen's own refusals. A finance module that answers 404 instead of 403 calls `noteActivity({ blocked: true })`. A finance screen opened without its permission (the website shows "not found") is a blocked attempt too | Those 403s are not "trying to see something you may not see" |
| D4 | The Director's "everyone" is everyone below him; the CTO has no company-wide search (as the existing screens decide: `logic.ts`) | The scope rule of plan section 5: never above |
| D5 | Force sign-out and lock: the Director and the CTO (`session.force_logout`, plus `auth.unlock_account` for a lock), only for people below them, after a confirm-again. Unlock is Module 2's unlock unchanged (above in the line, HR duty, the CEO / Founder / Owner for his direct report only) plus a confirm-again. On the activity screens only the Director and the CTO get the lock and unlock buttons (small screen change, `canLockAccounts` in `logic.ts`); the Owner's one unlock right stays on the Director's profile | The brief: the CEO / Founder / Owner is view only; reuse Module 2 |
| D6 | Working hours: a minimal `system_settings` table, read through `SettingsService` with the defaults in the code (`alert-rules`: `outsideFrom` 20:00, `outsideTo` 07:00, as on the Settings mock screen). Non-working days are not counted as "outside working hours". Module 12 builds the screen and the audited change | No settings table existed |
| D7 | City: a local list of address ranges in `GEOIP_RANGES`; the IPv6 loopback `::1` counts as `127.0.0.1` so a check on this computer can show a city | No outside GeoIP calls |
| D8 | Only a heartbeat with `active: true` keeps the session from timing out (`@CountsAsActivityWhen`); the screens that refresh themselves (`GET /activity/online`, `GET /activity/me`) do not keep a session alive either | Otherwise an open, unused tab would never time out |
| D9 | Time rules: a heartbeat describes the minute before it; a quiet stretch of 5 minutes or more is idle from its first minute, a shorter pause is active; two sessions at once are counted once; a session over midnight is split; the end of a session is its last signal; only a logout clicked in that session (end reason `user`) counts as a signal, while a session ended from another device (`user_other_device`) ends at its last signal, like a timeout | Plan section 8, written as pure functions |
| D10 | "Actions" in the summary = creates, edits, deletes, submits, assigns, approvals, rejections, comments, uploads, downloads, exports, prints, sensitive views, and an administrator's own security actions. Logins, logouts, screens, refused attempts and Module 2's security events about the person are not actions | Counts what the person did |
| D11 | A failed login with an Emp-ID that matches nobody is not an activity record (activity belongs to a person); Module 2's `login_attempts` keeps it | `activity_events.employee_id` is required |
| D12 | Alert mail goes to every active Director and CTO with an official email, also for an alert about one of them (the other one checks it). Delivery is "at least once" | The plan: "notify the Director and CTO" |
| D13 | Limits: search returns at most 2000 rows; summaries at most 31 days; My activity shows 14 days (200 records); at most 6 heartbeats and 60 screens a minute per session, and 10 export records a minute per session and 20 per person (more are ignored: heartbeats, screens and exports answer `recorded: false`); the alerts list returns every open alert plus the newest 500 checked ones, and the screen says so when the checked list is cut | Keeps the screens fast; stops a broken page flooding the tables |
| D14 | A sign-in from a new city has the alert kind `new_device` with the rule "Login from a new city" | The screens' alert kinds (`types.ts`) have no separate city kind |
| D15 | Live, "My activity" does not add the heartbeats on top of `today` (the server already counts them); the mock still does | Small screen change, `my-activity-panel.tsx` |
| D16 | The resend of a welcome email (a new temporary password) also writes `auth.security` (`temporary_password_set`) | "Confirm every M2 admin path emits a matching event" |
| D17 | Module 4 has no approval items (checking an alert is a review with a note, not an approval) and adds no permission keys: it uses `activity.view_own`, `activity.view_team`, `activity.view_all`, `activity.security`, `session.force_logout`, `auth.unlock_account` and `audit.view`, already the same on the server and in the screens | The screens have no `approvals.ts` for activity |
| D18 | The CTO's "security events" are the Security alerts screen (spec 9.4): every security alert, and nothing else. Security records that are not alerts, about people outside his line, are visible only to the Director and the CEO / Founder / Owner | Working reading of the brief. **Needs the project owner's sign-off** before it is accepted |
| D19 | A GET request is recorded as a download only when it is not an export or a print: a GET whose last path part is `export` or `print` is recorded as an export or a print | Fix found in review (`actionFor` in `rules/activity-classify.ts`) |

## Deferred

| Item | To | Ready now |
|---|---|---|
| Sales tool activity (emails sent, replies, bounces, calls, email checks) | Module 16 | `source` column and check, the five actions, `ActivityRecorder.record({ source: 'apollo', ... })` |
| Retention clean-up | A decision with the project owner (see Retention) | Indexes, `finance_linked` |
| Tasks touched | Module 5 | `ActivitySummaryHooks.useTasksTouched(...)`; until then the number of different tasks acted on in the Tasks module (0 today) |
| Attendance check-in next to the first login | Module 7 | `ActivitySummaryHooks.useCheckIns(...)`; the screen already shows the gap |
| Settings screen for the alert rules and working hours; in-app notifications (bell) for alerts | Module 12 | `system_settings` + `SettingsService`; event `activity.alert.raised` |
| Finance, payroll and statements routes | Modules 8 to 10 | Recorded automatically; they mark sensitive reads with `@SensitiveView` and call `noteActivity({ blocked: true })` when they answer 404 to someone without permission. **Every export must be reported with its row count**: `POST /activity/export { rows, format, module, dataset }` from the screen, or `noteActivity({ details: { rows } })` on a server export route. The shared ExportDialog does not report exports yet (Activity search does) |
| Tracking-policy acceptance stored and enforced on the server (`POST /auth/policy/accept`); the first-login wizard only shows and ticks it (F4) | Module 2 follow-up, with Module 12 | The tick box in `features/auth/policy` |
| Browser (Playwright) test for Module 4 | Later | Not written: it could not run here |
| The People list's "online" dots in live mode | Module 14 (presence) | `GET /activity/online` exists but is for managers only |

## Known limits

1. Up to about one second of activity records can be lost if the server process is killed (decision D2).
2. The heartbeat, screen and export limits, and the pause of a slow consumer, are kept in memory by each server copy.
3. The number of rows of an export is reported by the browser; the server cannot see the file. Activity search reports its
   exports; the shared ExportDialog does not yet (see Deferred).
4. Days before Module 4 was switched on have Module 2 sessions but no heartbeats, so their summaries show mostly idle time.
5. A count rule (salary views, finance attempts) raises at most one alert per person and time window; attempts that
   straddle two windows can raise two.
6. The API runs every database session in UTC itself, so PostgreSQL may run in another time zone; see `docs/SETUP.md`.

## For the people building Modules 5 and 6

- **Exports**: report every export with its row count, through `POST /activity/export { rows, format, module, dataset }`
  from the screen, or `noteActivity({ details: { rows } })` on a server export route. Without the row count an export is
  recorded but cannot raise the large-export alert.
- **Nothing to do for activity tracking**: every POST/PUT/PATCH/DELETE of your controllers is recorded with a sentence
  worked out from the route ("Approved TSK-0142 in Tasks"). Write `{ before, after }` in your audit `details` and activity
  search shows the old and new values.
- Better words: call `noteActivity({ target: 'TSK-0142', description: 'Approved task TSK-0142' })` (from
  `common/request-context.ts`) in the service, or put `@RecordActivity({ action: 'submit', describe: 'Submitted task :id' })`
  on the handler. A GET that shows sensitive data gets `@SensitiveView({ category: 'payslip' })`. A route that records
  itself gets `@NotRecorded()`. Decorators: `backend/src/activity/activity.decorators.ts`.
- Recording something outside a request: import `ActivityModule`, inject `ActivityRecorder`, call `record({...})`.
- Tasks touched: in your module's `onModuleInit`, `hooks.useTasksTouched(async ({ employeeIds, start, end }) => new Map(...))`.
- Events: register a consumer on `OutboxDispatcher` (docs/EVENTS.md, "Consuming events"). The leaving events
  `task.transfer.requested` and `employee.offboarded` are waiting unprocessed for Module 5.
- Scheduled work: `JobRunner` is global; `register(type, handler)` in `onModuleInit`; `scheduleOnce()` for one job per period.

## Switching the screens to the live API

The Activity screens use the real server when Module 4 is in the live list. In `frontend/.env.local`:

```
NEXT_PUBLIC_LIVE_MODULES=m1,m2,m3,m4
NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
```

(or `NEXT_PUBLIC_API_MODE=live` for every module). Restart `npm run dev -w aceva-digital-system-web` after changing it.
Module 4 live needs Module 2 live (the session). Without `m4` the screens keep the demo data, and the heartbeat behaves as
before (Module 2 only). The switch is `isLive("m4")` in `frontend/src/features/activity/api.ts` and `frontend/src/lib/telemetry.ts`.

## How to check M4 by hand

Use the demo password you chose (`DEMO_PASSWORD`). The CEO / Founder / Owner, the Director and the CTO also enter the code
from their authenticator app. Times on screen are Pakistan time.

**Get ready (once)**

1. Start the services: `docker compose up -d`. Mailpit's inbox is http://127.0.0.1:8025.
2. Create the new tables: `npm run db:migrate` (it applies `20261113100000_m4_activity_tracking`). On a brand-new
   database also run `npm run db:seed` and the demo logins (`docs/SETUP.md`, step 4). If this migration was applied
   before its two indexes were added (see Retention), create them by hand with the SQL in Retention.
3. In `backend/.env` add the line `GEOIP_RANGES=127.0.0.0/8=Karachi` (sign-ins from this computer then show "Karachi").
4. After pulling these changes, build the shared contracts: `npm run build -w @aceva/contracts` (backend and frontend
   read `@aceva/contracts` from its git-ignored `dist` folder). Then start the API: `npm run build -w backend`, then
   `npm start -w backend`.
5. In `frontend/.env.local` set `NEXT_PUBLIC_LIVE_MODULES=m1,m2,m3,m4` and
   `NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1`, then `npm run dev -w aceva-digital-system-web` and open
   http://localhost:3000. Type `localhost`, not `127.0.0.1`: the API accepts only the `localhost` address for the website.
6. Use two browser windows that do not share sign-ins: **Window A** = Chrome, **Window B** = a Chrome private
   (incognito) window. Step 15 also uses Microsoft Edge.

Note: between 20:00 and 07:00 Pakistan time every sign-in also raises a low "Login outside working hours" alert. That is
correct (step 13 shows the rule on purpose).

**A developer sees only their own activity**

7. Window A: sign in as **ACV-0007** (Mariam Shah, developer). Open Tasks, then People, then Activity.
   Expected: only the **My activity** tab. "This session, live" lists Activity, People, Tasks and Home, newest first.
   "Today" shows the first login of the day (if you signed in earlier today, that earlier time) and "Last logout: Still signed in". Move the mouse for two minutes and reload:
   "Active today" grows; the "Recent logins" card lists this sign-in with "Karachi".
8. Access rule: in Window A open http://localhost:4000/api/v1/activity/online and
   http://localhost:4000/api/v1/activity/alerts. Expected: both answer `403` ("You do not have access to this").
9. Still in Window A, type these addresses one after another: http://localhost:3000/finance/ledger,
   http://localhost:3000/finance/statements, http://localhost:3000/finance/banking. Expected: "Not found" each time (a
   developer has no finance access).

**The CTO sees his developers and the security alerts**

10. Window B: sign in as **ACV-0004** (Omar Farooq, CTO). Open Activity. Expected tabs: Online now, Timeline, Reports,
    Alerts, My activity (no Search). **Online now** lists Mariam Shah with "Signed in since", current screen "Banking",
    Active, "Chrome ... on Windows · Karachi". Sales people (ACV-0009, ACV-0012, ACV-0014) are not listed. To see this,
    sign in **ACV-0009** (Hira, Sales) in a third window first (for example Microsoft Edge): the CTO does not list her,
    the Director and the Owner do. Online now lists only people who are signed in at that moment.
11. **Alerts** tab: an open, High alert "Repeated attempts to open finance screens" for Mariam Shah: "3 blocked attempts
    to open finance screens (Ledger, Statements, Banking) within 15 minutes." In Mailpit there are two emails "Security
    alert: Repeated attempts to open finance screens (ACV-0007)", to omar@acevatech.com and bilal@acevatech.com. (Between 20:00 and 07:00 Pakistan time the inbox also holds the "Login outside working hours" mails, two for each sign-in, so it has more than two emails then.)
    Click **Mark as checked**, write a note, confirm. Expected: the card leaves the **Open** list; under **Checked** it
    shows "Checked by Omar Farooq" and your note.
12. **Timeline** tab: choose Mariam Shah and today. Expected: her login, the screens she opened, the refused attempts of
    steps 8 and 9 ("Tried to open Activity (no permission)" twice, "Tried to open Ledger / Statements / Banking (no
    permission)"), and the day summary on top (first login, active and idle time, actions 0).
    **Reports** tab: Mariam Shah's row (and any other developer who signed in today) with first login and active/idle hours.

**Outside working hours and large exports (the rules come from settings)**

13. Between 20:00 and 07:00 Pakistan time the default rule already raises "Login outside working hours" on every sign-in,
    so first show that the saved settings are used. Open a database prompt: `docker compose exec postgres psql -U aceva_app -d aceva_dev`
    and paste (this window does not include the current time; if it is 02:00 to 03:00 now, use 04:00 and 05:00):
    ```sql
    INSERT INTO system_settings (section, values)
    VALUES ('alert-rules', '{"outsideFrom": "02:00", "outsideTo": "03:00", "largeExportRows": 5}')
    ON CONFLICT (section) DO UPDATE SET values = EXCLUDED.values, updated_at = now();
    ```
    Window A: sign out and sign in again as ACV-0007. Expected: no "Login outside working hours" alert in the CTO's
    **Alerts** tab (reload). Then make every hour count as outside working hours: paste the same SQL again with
    `"outsideFrom": "00:00", "outsideTo": "23:59"` in place of 02:00 and 03:00. Window A: sign out and sign in again as
    ACV-0007. Within a few seconds the CTO's **Alerts** tab (reload) shows a Low alert "Login outside working hours:
    Signed in at HH:MM (Pakistan time) from Karachi, Chrome ... on Windows."
    Without Docker or psql, run `node .claude/cycle2-build/local-db.mjs test-rules` instead of that SQL (it sets the same
    window and the 5-row limit). Step 14 has the matching `reset-rules`.

**The Director: search, changes, export, maker-checker**

14. Window B: sign out, sign in as **ACV-0003** (Bilal Ahmed, Director). Open **Org and access**, tab **Departments and
    offices**, and use **Change head** on Human Resources: choose Omar Farooq, give a reason, save. Open Activity,
    **Search**, leave the Module filter on **Any module** and today's date. Expected: many rows (everyone's sign-ins and
    screens from the steps above, so well over 5).
    Click **Export**, choose Excel. Expected: after a reload the search shows "Exported N rows of Activity search results
    (XLSX)" with N of at least 5, and (because step 13 set the limit to 5 rows) the **Alerts** tab shows "Large export of
    employee data" about the Director, with "This alert is about you, so the CTO checks it" instead of the button.
    Now choose **Org** in the Module filter (the filter lists every module the server records, Org and Home included).
    Expected: a row "Changed department dep-hr" with "Head: ACV-0003 → ACV-0004".
    Before you put the defaults back, click **Export** once more, within the same hour as the first export, and choose Excel
    again. The export is recorded, but there is no second alert and no second mail: one large-export alert per person,
    kind of data and hour.
    Then, in psql, put the defaults back: `DELETE FROM system_settings WHERE section = 'alert-rules';` and type `\q`.
    Without Docker or psql, run `node .claude/cycle2-build/local-db.mjs reset-rules` instead.

**New device and new city**

15. Sign in as ACV-0007 in **Microsoft Edge**. Expected (Window B, Director, Alerts, reload): "Login from a new device"
    (Medium) for Mariam Shah. Then stop the API (Ctrl+C: a normal shutdown writes the last second of activity and the alert events first), change the line in `backend/.env` to `GEOIP_RANGES=127.0.0.0/8=Lahore`,
    start the API again, and sign in as ACV-0007 in Edge again (sign out first). Expected: "Login from a new city"
    (High): "Signed in from Lahore ... Usual: Karachi." Put `Karachi` back in `backend/.env` and restart the API.

**Controls: force sign-out, lock after 5 wrong passwords, unlock**

16. Start clean: sign out of Microsoft Edge (the session step 15 left open) and sign out of Window A and Window B. Then
    Window A: sign in as ACV-0007 in Chrome, so Mariam has one session. Window B: sign in as ACV-0004 (CTO), Activity,
    **Online now**, the menu on
    Mariam Shah's row, **Force sign-out**: give a reason, confirm with your password and code. Expected: "Mariam Shah was
    signed out"; Window A goes to the login page within a minute (or on the next click). Sign in again as ACV-0007 and
    go straight to Activity. Expected: the "Today" list on My activity shows "Signed out by ACV-0004 (Omar Farooq): <your
    reason>" and "Signed out by an administrator".
17. Window A: sign out. Do this step once only. Everyone on this computer shares one internet address, and five wrong
    passwords from it within 5 minutes slow down its next sign-ins (up to 5 seconds each); 15 failures in 15 minutes block
    its sign-ins for up to 15 minutes. If you repeat the step, wait 15 minutes first. At the login screen enter
    **ACV-0011** with a wrong password five times. Expected: "locked". The
    CTO's **Alerts** tab shows "Account locked after 5 wrong passwords" (Medium) for Danish Iqbal with an **Unlock
    account** button, and Mailpit has the two emails. Click **Unlock account** and confirm. Expected: "Account unlocked";
    ACV-0011 can sign in with the right password.

**The CEO / Founder / Owner only watches**

18. Window B: sign in as **ACV-0001** (Hamza Qureshi). First sign in **ACV-0009** in the third window, as in step 10 (her
    session may have timed out). Activity shows Online now (everyone who is signed in, including Sales), Timeline,
    Search, Reports and Alerts. Expected: on Online now "View only. The Director and the CTO sign people out or lock
    accounts, for people below them", and no Force sign-out or Lock account in the row menu; on Alerts "View only. To be checked by ..." and no
    Mark as checked button.

**Nothing can be edited or deleted**

19. In psql (step 13): `DELETE FROM activity_events;` Expected: `ERROR: Table activity_events is insert-only: rows cannot
    be changed or removed`. There is no edit or delete control anywhere on the Activity screens.

**Database tests (written, not run yet)**

20. With PostgreSQL and Redis running: `npm run build:contracts`, then `npm test -w backend -- m4-` (only the four
    Module 4 files: `m4-recording`, `m4-alerts`, `m4-time`, `m4-logout-reason`), or `npm test` for everything. The tests use the `aceva_test`
    database (rebuilt for every run) and send no real email.

## Verification run for this build

Run after the review fixes (all 17 verified review findings fixed or documented):

- `npm run typecheck` (contracts, backend, frontend): 0 errors.
- `npm run lint`: 0 errors, 9 warnings (the same 9 as before Module 4, none in Module 4 files).
- Pure unit tests (`backend/src/**/*.test.ts`, no database): 14 files, 173 tests, all passing. They include the
  recorder (`activity-recorder.service.test.ts`: retries, drops and order of records; the interceptor never breaks or
  slows a request), the alert mail retry (`activity-consumers.service.test.ts`), the shared outbox dispatcher
  (`events/outbox-dispatcher.service.test.ts`: slow-consumer protection, lease renewal, hand-back on shutdown) and the
  check that every server module label is offered in the Module filter.
- Contract tests (`npm run test -w @aceva/contracts`): 16 tests, all passing.
- Database tests: written, **not run yet** (they need PostgreSQL and Redis): `backend/test/m4-recording.test.ts`,
  `m4-alerts.test.ts`, `m4-time.test.ts` (including the retention index check), `m4-logout-reason.test.ts`, and
  `backend/test/m2-sessions.test.ts`, which now also checks the two new end reasons (`user_other_device`,
  `too_many_wrong_codes`).
- The migration's generated part was checked against a fresh `prisma migrate diff` from the previous schema: identical.
