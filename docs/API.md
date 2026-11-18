# Aceva API

Base URL (development): `http://localhost:4000/api/v1`
Interactive documentation (Swagger UI): `http://localhost:4000/api/docs`
Machine-readable OpenAPI JSON: `http://localhost:4000/api/docs-json`

Request and response shapes are defined once, in `packages/contracts/src` (Zod schemas), and shared with the website.

Every answer carries an `X-Request-Id` header (the same id is stored with the request's audit log rows and activity
records; quote it when reporting a problem).

**Company structure used by these rules** (final): Level 1 CEO / Founder / Owner (role key `owner`, one person; sees
everything, approves and manages nothing), Level 2 Director (`director`, the only approver and the org administrator,
holds the HR and sales-manager duties), Level 3 CTO (`cto`), Level 4 Sales (`sales`) and Finance (`finance`, with the
Finance duty), Level 5 Developer / SQA (`employee`). Everybody reports to a strictly higher level; no same-level line
is configured.

## How requests are protected

- **Login gives an HttpOnly session cookie** (`aceva_session`, SameSite=Lax, Secure in production). Page scripts cannot read it.
- **Every request is checked on the server**: session still valid (30 minutes idle, 10 on finance screens, 12 hours in total),
  login finished (password changed, 2FA done), permission, and hierarchy scope. Failures are `401` (not logged in) or `403`
  (not allowed) and every refusal is written to the audit log.
- **Requests that change data** (anything but GET) must carry the header `X-CSRF-Token` (given at login and by `GET /auth/me`),
  and, when the browser sends an `Origin`, it must be the Aceva website.
- A route with no declared access rule is refused (fail closed).
- Errors: `{ statusCode, code, message }`. Validation failures also carry `issues: [{ path, message }]`; reporting-line and
  level failures carry `violations: [{ code, message }]`. Unfinished logins return `403` with `code: "auth_incomplete"` and `stage`.
- People are identified by Emp-ID (`ACV-0001`) in URLs and responses, never by internal UUID. Times are ISO 8601 in UTC.

## GET /health

No login needed. `{ "status": "ok", "database": "up", "time": "...", "version": "0.1.0" }`

## M2: login and sessions

| Method and path | Who | What it does |
|---|---|---|
| `POST /auth/login` | public | Body `{ empId, password, rememberMe? }`. Answer `{ status, retryAfterSec?, csrfToken? }` with `status` one of `ok`, `password_change_required`, `2fa_required`, `2fa_setup_required`, `locked`, `invalid`, `rate_limited`. Sets the session cookie unless refused. Unknown Emp-ID and wrong password look the same. |
| `POST /auth/logout` | logged in | Ends this session now (all stores). Optional body, strict (any other field or value gives 400): `{ reason: "idle_timeout", financeScreen?: boolean }`, sent by the browser when its idle timer ran out with the tab open. The server records the session as `idle_timeout` (Module 4 shows "Timed out") only if it was idle for at least the limit minus 2 minutes (28 minutes, or 8 on a finance screen; the browser's own limits are 30 and 10 minutes). Otherwise it is a normal clicked logout. An idle logout does not count as activity (it does not move last-active). No body is a plain logout. Like every change, it needs `X-CSRF-Token` |
| `GET /auth/me` | logged in, even if unfinished | Who I am, `stage`, permissions, `twoFactorRequired`, `csrfToken`, `rememberAllowed` |
| `POST /auth/2fa/setup` | logged in, even if unfinished | Starts authenticator set-up. Returns `{ secret, otpauthUrl }` once; the secret is stored encrypted |
| `POST /auth/2fa/verify` | logged in, even if unfinished | Body `{ code }` (6 digits). The first correct code confirms the set-up. 5 wrong codes end the session. A code works once. |
| `POST /auth/2fa/disable` | logged in | Body `{ password, code }`. Only where 2FA is optional |
| `GET /auth/2fa` | logged in | `{ required, enabled, enabledAt? }` |
| `POST /auth/password/change` | logged in, even if unfinished | Body `{ currentPassword?, newPassword }` (min 10 characters, not one of the last 3). Ends every session on every device and starts a fresh one here |
| `POST /auth/password/forgot` | public | Body `{ empId }`. Always `{ sent: true }`. Emails a one-time link (15 minutes) to the official acevatech.com address, if there is one |
| `POST /auth/password/reset` | public | Body `{ token, newPassword }`. The link works once; ends every session |
| `GET /auth/sessions` | logged in | My devices |
| `DELETE /auth/sessions/:id` | logged in | Log out one of my other devices (someone else's session looks like it does not exist) |
| `DELETE /auth/sessions` | logged in | Log out all my other devices |
| `GET /auth/login-history` | logged in | My recent logins and failed attempts |
| `POST /auth/step-up` | logged in | **Confirm again.** Body `{ password, code? }`. The server checks the password and, for people with an authenticator, the current code (a code works once). Wrong answers get one message; 5 wrong in 15 minutes end the session. A correct answer allows risky actions for 5 minutes in this session only (`validForSec: 300`). Needed for bank-account reveal, salary reveal and pay edits (otherwise 403 `step_up_required`) |
| `POST /auth/employees/:empId/unlock` | `auth.unlock_account`, above them in the line or HR duty; the CEO / Founder / Owner only for his direct report (the Director) | Unlock a locked account |
| `POST /auth/employees/:empId/force-logout` | `session.force_logout`, below the caller | Ends every session on every device at once |
| `POST /auth/employees/:empId/reset-2fa` | `auth.reset_two_factor`: the Director (below them in the line), HR duty (lower rank), the CEO / Founder / Owner (only his direct report, the Director). Never yourself, same level or upward | Body `{ reason }`. Lost authenticator phone: deletes the old secret, ends every session, and the person must enrol a new authenticator at next login. Audited (`auth.2fa.reset`, with the rule used: `director`, `hr_duty` or `owner_direct_report`). |
| `POST /auth/employees/:empId/temporary-password` | `auth.set_temporary_password` (Director, HR duty) | For people with no official email only. The password is shown once and must be changed at next login |

Limits: 5 wrong passwords lock the account (a higher level or HR unlocks it). From one internet address, failures are
slowed after 5 in 5 minutes and blocked after 15 in 15 minutes. "Remember me" never applies to Finance users.

## M1: hierarchy and access control

| Method and path | Who | What it does |
|---|---|---|
| `GET /access/me` | logged in | My level, role, duties and effective permissions (role + duty) |
| `GET /access/roles`, `/access/duties`, `/access/permissions` | `org.view` | Roles with permissions; extra duties; the permission catalogue (read only) |
| `GET /org/tree` | `org.view` | The organisation chart as a tree |
| `GET /org/team`, `GET /org/team/:empId` | logged in / scope: me or below | Me and everyone below me (filter runs in the database); one person, refused when above or beside me |
| `PATCH /org/employees/:empId/level` | `org.manage` (the Director), below the caller | `{ level: 2..5, roleKey?, reason }`. Validated against the reporting lines; nobody can assign a level at or above their own, so the Director assigns Levels 3 to 5 |
| `PATCH /org/employees/:empId/reporting-line` | `org.manage`, below the caller | `{ reportsToEmpId, reason }`. The Director only. No loops, no self, no reporting to the same or a lower level (no same-level pair is configured) |
| `POST /org/employees/:empId/duties`, `DELETE .../duties/:dutyKey` | `duty.assign` (Director), below the caller | `{ dutyKey, reason }` / `{ reason }` |
| `GET /org/departments` | `org.view` | Departments (with their explicit head) and offices with headcount |
| `POST /org/departments`, `PATCH /org/departments/:code`, `POST /org/departments/:code/deactivate` | `org.manage` (the Director) | `{ name, headEmpId?, reason }`, `{ name?, headEmpId?, reason }`, `{ reason }`. Heads are chosen explicitly and audited; deactivating needs an empty department |
| `POST /org/offices`, `PATCH /org/offices/:code`, `POST /org/offices/:code/deactivate` | `org.manage` | `{ name, city?, reason }` and similar |
| `GET /org/changes` | `audit.view` | Recent access changes, from the audit log |
| `POST /stand-ins`, `GET /stand-ins`, `DELETE /stand-ins/:id` | `standin.manage` / logged in | `{ standInEmpId?, startsOn, endsOn, reason? }`. No stand-in means approvals go up the chain. Overlaps and conflicts are refused |
| `GET /approvals/route/:empId?date=&afterSeat=` | scope: me or below | Who approves this person's request on a date (real reporting chain, stand-ins, people who left are passed over). The CEO / Founder / Owner approves only for his direct report (the Director); for anyone further down his seat is skipped (`direct_reports_only`) and the request waits for the Director |
| `GET /approvals/can-approve/:empId` | scope: below me | May I approve right now? Never my own |
| `GET /access/can-assign-task/:empId` | logged in | Tasks only move down my reporting line |

Every change writes an audit record (who, what, before and after, and the reason) in the same database transaction.

## M3: employee profiles, joining and leaving

| Method and path | Who | What it does |
|---|---|---|
| `GET /employees?q=` | everyone logged in | Staff directory: Basic fields only (Emp-ID, name, designation, department, office, official email, `hasPhoto`). People who have left are not listed |
| `GET /employees/:empId` | everyone logged in | The profile with only the sections the caller may see (`basic` always; `job`: self, above, Director/HR; `personal` and `documents`: self, HR, Director and above; `pay`: self, the Director, the CEO / Founder / Owner (view only), finance duty; `history`). `access` says what the caller may edit. CNIC and bank account are masked. **Salary amounts are never in the profile or the history**: `pay` has only `salaryOnFile`, the bank name and the masked account; the amounts come from the reveal below |
| `PATCH /employees/:empId/basic` | Director or HR, for people of lower rank | Name, designation, department/office (codes), official email. Old values go to the history |
| `PATCH /employees/:empId/job` | Director or HR for joining date, type, capacity; **the Director only** for `level` and `reportsToEmpId` (through the Module 1 rules) | Needs `reason`. Status cannot be changed here (use the leaving workflow) |
| `PATCH /employees/:empId/personal` | the employee (phone, home address, emergency contact) or Director/HR (also CNIC) | History keeps old values; CNIC is stored encrypted |
| `PATCH /employees/:empId/pay` | Director only, never their own | Needs `reason`. Base salary, allowances total, bank name, account number (encrypted) |
| `POST /employees/:empId/reveal` | whoever may see that section | Body `{ field: cnic\|account\|salary }`. Returns `{ value }` (salary: `{ value, allowances }`). **Every reveal is permission-checked and audited** (the value is never logged) |
| `POST /employees` | `people.manage` (HR duty) or `org.manage` (the Director) | Joining workflow. **HR only STARTS a hire** (Level 4 or 5): the answer is `{ status: 'pending_approval', requestId }`; no employee, Emp-ID, login or email exists yet. **The Director creates directly** (Levels 3-5, never at or above their own level): `{ status: 'created', empId, welcomeEmailSent }`. Pay may be included only by the Director. The CEO / Founder / Owner hires nobody (403) |
| `GET /hire-requests?status=` | the Director, HR, the CEO / Founder / Owner (view only) | Requests (no personal or pay details) |
| `POST /hire-requests/:id/approve` | `people.approve_hire`: **the Director**, for every request except the Director's own; a request the Director made is decided by the **Owner** (only that kind). Never your own (`403 self_approval`); the Director on the Director's own request `403 owner_decides`; the Owner on anyone else's request `403 owner_decides_director_only`; below the Director, never a hire at your own level or above (`403 level_not_allowed`) | Body `{ level?, reportsToEmpId? }` (they may correct the proposal; the reporting rules apply). Now the Emp-ID is generated, the login is created and the welcome email with a temporary password is sent. A request is decided once |
| `POST /hire-requests/:id/reject` | `org.manage` | Body `{ reason }` |
| `GET /employees/unresolved-reports` | the Director, HR, the CEO / Founder / Owner (view only) | People who still report to someone who left. Nothing moves them automatically; the Director uses `PATCH /employees/:empId/job` with `reportsToEmpId` |
| `POST /employees/:empId/resend-welcome` | `people.manage`, above the person | New temporary password and email, only before the first login |
| `GET/POST /employees/:empId/documents`, `GET .../documents/:id/download`, `DELETE .../documents/:id` | self, HR, Director and above (employees add their own CV, CNIC copy, certificates; HR/Director add contracts) | Private storage. PDF, PNG, JPEG, .docx by real content, 10 MB. Download is permission-checked and logged; "delete" archives |
| `POST/GET /employees/:empId/photo` | upload: self or Director/HR; view: everyone | JPEG or PNG, 2 MB |
| `POST /employees/:empId/offboard` | Director or HR, for people of lower rank | Body `{ lastWorkingDay, reason }`. **The person keeps access through the whole last working day; access ends at 00:00 Pakistan time on the next day.** A last working day that is already over is processed at once; otherwise a scheduled job runs at that moment. Calling it again moves the date |
| `DELETE /employees/:empId/offboard` | same | Body `{ reason }`. Cancels a leaving date that has not been processed |

When access ends the system: sets the status to `left`, disables the login and ends every session, ends duties and
stand-in cover, clears a department head, writes the history, and queues the events `employee.offboarded`,
`task.transfer.requested` and `payroll.final_settlement.requested`. **Reporting lines are not changed**: the leaver's direct
reports are listed until the Director assigns a new manager. The record is never deleted.

## M4: activity tracking

Tracking data is insert-only (database triggers): there is no request that edits or deletes it. Days are Pakistan days
(`YYYY-MM-DD`, UTC+5); times are ISO 8601 in UTC. Shapes: `packages/contracts/src/activity.ts` (the same as
`frontend/src/features/activity/types.ts`).

| Method and path | Who | What it does |
|---|---|---|
| `POST /activity/heartbeat` | logged in | Body `{ active: boolean }` only (was the mouse or keyboard used in the last minute). Sent every 60 s while the app is open. Only `active: true` keeps the session from timing out. Answer `{ ok, recorded }` (`recorded: false` when ignored: more than 6 a minute per session) |
| `POST /activity/screen` | logged in | Body `{ screen, path? }` (label, page path starting with `/`). One record per screen opened. A finance screen opened without its permission is recorded as a **blocked attempt**; for a blocked finance screen the record's target and description use the server's module of the page (for example Ledger), not the label the browser sent (the browser label is kept only in `details.screen`). At most 60 a minute per session |
| `POST /activity/export` | logged in | Body `{ rows, format: xlsx\|pdf\|csv, module?, dataset? }`. The screens build the file; this records that the export happened. Exports of finance or employee data with at least `largeExportRows` rows (default 500) raise an alert. One large-export alert per person, per kind of data (finance, employee) and hour: later large exports in that hour are only logged; the alert mail follows the alert. At most 10 exports a minute per session and 20 per person are recorded; a refused call still answers 200 with `{ ok: true, recorded: false }`, and a recorded one answers `{ ok: true, recorded: true }` |
| `GET /activity/me` | logged in | My activity: `today` (worked out live), my records of the last 14 days, this session's screens and heartbeats |
| `GET /activity/events?empId&departmentId&module&action&source&from&to` | `activity.view_own` | Activity search, newest first, at most 2000 rows. **The Director and the CEO / Founder / Owner** (`activity.view_all` and `audit.view`) search themselves and everyone below them; everyone else gets only their own records. `changes` holds the old and new values, joined from the audit log rows of the same request. `departmentId` is a department code (`dep-eng`); empty filters mean "any" |
| `GET /activity/online` | `activity.view_all` (the CEO / Founder / Owner, the Director, the CTO) | Sessions signed in now of the people **below** me: since, current screen, `active` (use in the last 5 minutes) or `idle`, device, city, `newDevice` |
| `GET /activity/summaries?from&to&scope=team` | `activity.view_team` or `activity.view_all` | Daily summaries of the people below me, at most 31 days: first login, last logout, active and idle minutes, actions, tasks touched, check-in, idle spans. Stored nightly rows; today (and any day whose job has not run) worked out live. Others get 403 |
| `GET /activity/timeline?empId&date` | my own; someone below me with `activity.view_team` or `activity.view_all` | `{ summary?, events }`, events in time order. Without `activity.view_all` only the summary (`events: null`). Someone above or beside me: 403 |
| `GET /activity/alerts?status=open\|checked\|all` | `activity.security` (the CEO / Founder / Owner, the Director, the CTO) | Every open alert (never cut off) plus the newest 500 checked alerts, newest first. `status=open` returns every open alert; `status=checked` the newest 500 checked ones |
| `POST /activity/alerts/:id/check` | `activity.security` and `session.force_logout` (the Director, the CTO) | Body `{ note }` (3 to 500 characters). Never an alert about yourself; a manager above the person checks it (the CTO checks alerts about the Director, the Director those about the CEO / Founder / Owner). Once only (409 `already_checked`). The alert itself never changes; the check is a row of its own |
| `POST /sessions/:id/force-logout` | `session.force_logout` (the Director, the CTO), the session of someone **below** me, confirm-again in the last 5 minutes | Body `{ reason }`. Ends that one session at once. 403 `step_up_required` without the confirm-again; 409 `session_ended` if it already ended. The person sees the reason in My activity |
| `POST /employees/:empId/lock` | `session.force_logout` and `auth.unlock_account` (the Director, the CTO), someone **below** me, confirm-again | Body `{ reason }`. Locks the account and ends every session (`{ ok, ended }`); 409 `already_locked` |
| `POST /employees/:empId/unlock` | `auth.unlock_account`, confirm-again; then Module 2's rule (someone above them in the line, HR duty, the CEO / Founder / Owner for his direct report only) | Body `{ reason? }`. Same as `POST /auth/employees/:empId/unlock`, plus the confirm-again |
| `GET /accounts/locked` | logged in | Locked accounts of me and the people below me; all of them with `activity.security`. `{ empId, at, by (Emp-ID or "system"), reason }` |

**Recorded automatically for every module** (no code in the module): every successful POST, PUT, PATCH and DELETE; every
GET ending in `/download`, `/export` or `/print`; every handler marked `@SensitiveView` (the M3 reveal of CNIC, bank
account and salary is one); every refused attempt (403, from the access check or a service). Never request bodies or query
strings. Logins, logouts and the person's own security changes come from the Module 2 events instead.

**Alerts** (mailed to the Director and the CTO; stored in `security_alerts`): account locked after 5 wrong passwords
(medium); sign-in from a new device (medium) or a new city (high); sign-in outside working hours (low, default 20:00 to
07:00 Pakistan time); large export of finance or employee data (medium; one alert per person, kind of data and hour); many salary, bank or payslip records opened in one
hour (medium, default 5); repeated attempts to open finance screens (high, default 3 in 15 minutes). The thresholds are the
`alert-rules` settings section (see `docs/M4-ACCEPTANCE.md`).

## M5: tasks, size and deadline

Shapes: `packages/contracts/src/tasks.ts` and `packages/contracts/src/approvals.ts` (the same as the frontend's
`features/tasks/types.ts` and `features/approvals/types.ts`). Days are Pakistan days; times are ISO 8601 in UTC. A
task is shown by its UUID or its number (`TSK-0001`; a personal to-do is `TODO-0001`). Every answer about a task
the caller may not see is `404 not_found`, so a personal to-do of someone else looks like it does not exist.

**Who may do what.** The rules are in the services, per task, because one person can be the assignee on one task and
the reviewer on another. Nobody assigns upward, sideways or to themselves. The CEO / Founder / Owner (Level 1) is view
only on work tasks: a comment is refused with `403 forbidden`, and a file or any status action with `403 not_allowed`
(he is neither the assignee nor the assigner). A personal to-do belongs to its owner
alone. Wrong status for everybody is `409 invalid_state`; the right status with the wrong person is `403 not_allowed`
(only `403` counts as a blocked attempt in the Module 4 activity log).

### Tasks

| Method and path | Who | What it does |
|---|---|---|
| `GET /tasks?scope=mine\|team\|all&assignee=&status=&priority=&size=&projectId=&dueFrom=&dueTo=&includePersonal=&open=&closed=` | `task.view_own`; `scope=team` needs `task.view_team` (403 otherwise). `scope=mine` and `scope=all` need only `task.view_own` | Tasks I may see, sorted by deadline. `scope=mine` is My Tasks; `scope=all` is open to everyone and returns only the tasks they may see. `includePersonal=true` adds only my own to-dos. Dates are Pakistan days, both included. `open=true` leaves out every approved or cancelled task (open work only). `closed=recent` (the default) leaves out approved and cancelled tasks that were closed more than 90 days ago; `closed=all` brings them back. Open tasks are always all there |
| `GET /tasks/workload` | `task.view_team` | One row per person below me: `{ empId, openHours, capacity, openTasks }` (open estimated hours against weekly capacity) |
| `GET /tasks/:id` | `task.view_own`, and visible to me | `{ task, comments, extensions, history, reviewer }`. `reviewer` is the Emp-ID who reviews this task now (the assigner, a stand-in, or the next level up); `null` for a personal to-do. `actingAssigner` is the Emp-ID who may hold, resume, cancel, edit, move the deadline of, add steps to, attach files to and stop the repeat of this task now: the assigner while he is here and holds `task.assign`, otherwise the first person up the line who holds `task.assign`; `null` for a personal to-do. `task.isOverdue` is computed, never stored |
| `POST /tasks` | logged in; `task.assign` for a work task | Body `createTaskRequestSchema`: `title`, `description?`, `assignee` (Emp-ID below me; omit for a personal to-do), `projectId?`, `goalId?`, `priority`, `size` (XS to L; XL is refused), `estimatedHours`, `startDate`, `deadline` (required, not in the past, not before the start, not more than 731 days after it; start and deadline must fall between 2020-01-01 and 2100-12-31), `checklist?`, `repeat?` (`{ every: week\|month, on, until? }`), `personal?`, `confirmWarnings?`. Answers `201` with the task, or `409 confirmation_required` (below) |
| `PATCH /tasks/:id` | the assigner, or the person acting as assigner (see `actingAssigner` above); a personal to-do: its owner, without a reason | Edits an open task: `title`, `description`, `priority`, `projectId`, `goalId`, `estimatedHours`, `assignee` (hands it to someone else below me; allowed while assigned, in progress, rework or on hold), `deadline` + `reason` (a manager change, the original deadline is kept; the same date range and two-year limit as at creation), `confirmWarnings?`. The size and its points never change. A body with nothing to change is refused by validation (`400`, with `issues`) |
| `POST /tasks/:id/start` | the assignee | Assigned or Rework to In progress (`200`) |
| `POST /tasks/:id/submit` | the assignee | In progress or Rework to Submitted (`200`) |
| `POST /tasks/:id/review` | the reviewer | Submitted to Under review: the reviewer picks the work up (`200`) |
| `POST /tasks/:id/approve` | the reviewer, never for their own task | Body `{ rating: 1..5, comment? }`. Submitted or Under review to Approved; writes a review record and event `task.approved` (`200`) |
| `POST /tasks/:id/rework` | the reviewer | Body `{ reason }` (at least 3 characters). Submitted or Under review to Rework; event `task.reworked` (`200`) |
| `POST /tasks/:id/hold` | the assigner (or the person acting as assigner) | Body `{ reason }`. Any open status except On hold to On hold (`200`) |
| `POST /tasks/:id/resume` | the assigner (or the person acting as assigner) | Body `{ reason? }`. On hold to In progress (`200`) |
| `POST /tasks/:id/cancel` | the assigner (or the person acting as assigner); a personal to-do: its owner | Body `{ reason }`. Any open status to Cancelled (`200`) |
| `POST /tasks/:id/done` | personal to-do only, its owner | Marks a to-do done. No review, no rating, not scored (`200`) |
| `POST /tasks/:id/reopen` | personal to-do only, its owner | Done back to Assigned (`200`) |
| `POST /tasks/:id/extensions` | the assignee | Body `{ requestedDeadline, reason }` (`requestedDeadline` between 2020-01-01 and 2100-12-31, and within 731 days of the start: `deadline_too_far`). Asks for more time in assigned, in progress, rework or on hold. A request after the deadline is allowed and marked `late`. Answers `201` with the request |
| `POST /extensions/:id/approve` | the assigner (who may review this task), never the person who asked | Body `{ reason? }`. The new deadline is saved, the original kept, the event `task.deadline_changed` with `kind: extension_approved` (`200`) |
| `POST /extensions/:id/reject` | the same | Body `{ reason }` (`200`) |
| `POST /tasks/:id/repeat/stop` | the assigner (or the person acting as assigner) | Body `{ reason? }`. Stops the repeating series of this task; the tasks already made stay (`200`) |
| `POST /tasks/:id/checklist` | the assigner (or the person acting as assigner) or the assignee | Body `{ text }`. Adds a step (`201`) |
| `PATCH /tasks/:id/checklist/:itemId` | the assignee | Ticks or unticks a step (`200`) |
| `GET /tasks/:id/comments` | visible to me | Comments, oldest first |
| `POST /tasks/:id/comments` | visible to me, except the Owner | JSON `{ body }`, or multipart with `body` and a `file` (the field is named `file`). `@Firstname`, `@Full Name` and `@ACV-0007` mention people who can see the task; the mentions are stored and mailed. Answers `201` |
| `POST /tasks/:id/attachments` | the assignee, or the assigner (or the person acting as assigner) (multipart, field `file`) | PDF, PNG, JPEG or .docx by its real content, 10 MB. Stored privately through Module 3's file storage (`FILE_STORAGE_ROOT`). Answers `201` |
| `GET /tasks/:id/attachments/:attachmentId/download` | visible to me | The file, as an attachment. Permission is checked each time and every download is logged |
| `DELETE /tasks/:id/attachments/:attachmentId` | the person who added the file, or the assigner (or the person acting as assigner) | Archives the file (kept, never deleted) |

### Projects, holidays, size table

| Method and path | Who | What it does |
|---|---|---|
| `GET /projects` | `task.view_own` | Projects and clients a task can link to (read only for now) |
| `GET /holidays?year=` | logged in | The company holiday calendar for the year (default: this year). Served by Module 7 (attendance); Module 5 screens use it too |
| `GET /settings/task-sizes` | `task.view_own` | The size table: XS to XL, meaning, hours, points, suggested working days (XL has none: it must be split) |
| `GET /settings/task-sizes/changes` | `settings.view` | Who changed which size row, when, and why |
| `PATCH /settings/task-sizes/:size` | `settings.manage` (the Director) | Body: any of `meaning`, `hours`, `hoursLabel`, `points`, `days`, plus `reason` (at least 5 characters). The whole table is checked. Old tasks keep the points and hours they were made with |

### Approvals inbox (Module 5 items)

| Method and path | Who | What it does |
|---|---|---|
| `GET /approvals` | logged in | Everything waiting for my decision, oldest first. Task items: `task_review` (a submitted task I review) and `extension` (a request I decide). Each item has `id` (`task_review:<task id>` or `extension:<extension id>`), `title`, `subtitle`, `requester`, `href` (`/tasks/<id>`) and `createdAt` |
| `GET /approvals/oversight` | logged in; empty unless I may see all activity | Read only: the same kinds of items waiting for people below me. Each item has `waitingFor` (the Emp-ID who must decide) |
| `POST /approvals/:id/approve` | logged in | `task_review`: body `{ rating: 1..5, comment? }` (required: `rating_required`). `extension`: body `{ reason? }`. Answers `201 { "ok": true }` (a new resource of the inbox; the screen reads no status) |
| `POST /approvals/:id/reject` | logged in | `task_review`: send to rework, body `{ reason }` (required). `extension`: body `{ reason }`. Answers `201 { "ok": true }` |

A `task_review` item has `needsRating: true`, `approveLabel: "Approve"` and `rejectLabel: "Send to rework"`. An
`extension` item has no rating and no labels; its subtitle shows the old and new deadline and the reason, with
"asked after the deadline (counts as late)" when `late` is true. The task's own status buttons and this inbox do the
same work: both go through the same rules.

### Warnings that need a confirmation (409)

Creating a task (`POST /tasks`) and moving its deadline (`PATCH /tasks/:id` with `deadline`) can give two soft
warnings. The server answers **`409 confirmation_required`** and creates or changes nothing until the same request is
sent again with `"confirmWarnings": true`:

```json
{
  "statusCode": 409,
  "code": "confirmation_required",
  "message": "An M task usually needs 3 working days; you set 1. Continue?",
  "warnings": [
    { "code": "deadline_too_short", "message": "An M task usually needs 3 working days; you set 1. Continue?", "details": { "size": "M", "neededDays": 3, "givenDays": 1 } },
    { "code": "overloaded", "message": "This puts Nida Aslam at 40 h of 20 h this week.", "details": { "empId": "ACV-0013", "openHours": 16, "addedHours": 24, "capacity": 20 } }
  ]
}
```

`deadline_too_short` means the deadline is shorter than the size normally needs. `overloaded` means the new task would
put the assignee over their weekly capacity (`Employee.weeklyCapacityHours`, 40 by default). The `details` values
are examples.

### Error codes (Module 5)

The body is always `{ statusCode, code, message }`; validation failures also carry `issues`. Where a rule fails, `code` is the rule's name.

| Status | Codes | Meaning |
|---|---|---|
| `400` | `deadline_in_past`, `deadline_before_start`, `deadline_too_far` (the deadline is more than 731 days after the start; also for edits and personal to-dos), `deadline_required`, `deadline_unchanged` (the new deadline is the current one), `size_xl_not_assignable`, `reason_required`, `rating_required`, `assignee_left` (the assignee has left the company), `project_not_found`, `personal_fields` (a personal to-do may only change its title, description, priority and deadline), `not_for_personal` (asking for more time on a personal to-do: change its deadline yourself), `invalid_size_table`, `nothing_changed` (the size row already has these values), `extension_not_later` (the requested date is not after the current deadline), `repeat_until_before_start`, `no_file`, `file_type_not_allowed`, `invalid_item` (approvals: not an inbox item id) | Broken input or a rule refused the change |
| `403` | `forbidden` | Assigning to someone who is not below me; the CEO / Founder / Owner commenting on a work task; approvals: the item is not waiting for me, or it is my own request |
| `403` | `not_allowed` | The status allows this action, but not for this person: for example the assignee approving, the assigner submitting, someone other than the assignee ticking a step, someone other than the assignee or assigner attaching a file (the Owner included), or someone other than the assigner stopping a series |
| `404` | `not_found` | Task not visible to me (also someone else's personal to-do), or the checklist step, file, extension request, size row or approval item does not exist |
| `413` | (no `code`; Nest's `Payload Too Large`) | A task file over 10 MB. The file is not stored |
| `409` | `confirmation_required` | Soft warnings (see above); send again with `confirmWarnings: true` |
| `409` | `invalid_state` | This action is not possible in this status for anybody (for example approving a task that is not under review). A task waiting for its review also cannot be handed to someone else. Asking for or deciding more time on a task that is closed (approved, done, cancelled, or closed by hand-over) |
| `409` | `task_closed` | The task is approved, done, cancelled or closed: no edits, deadline change, checklist change or file added |
| `409` | `extension_pending` | A request for more time is already waiting for an answer (one pending request per task) |
| `409` | `already_decided` | This extension request was already approved or rejected |
| `409` | `extension_outdated` | The deadline has moved past this request since it was made: reject it and ask again |
| `409` | `deadline_changed` | The deadline was changed by someone else in the meantime: reload the task and try again |
| `409` | `not_repeating` | This task does not belong to a repeating series |
| `409` | `already_stopped` | The repeating series was already stopped |

**The assigner's powers.** Hold, resume, cancel, edit, move the deadline, add a step, attach or remove a file and stop
a repeat belong to the assigner while he is here and holds `task.assign`. Once the assigner has left, or no longer holds
`task.assign`, the first person up the assignee's line who holds `task.assign` may do the same (`403 not_allowed`
for everyone else, as before). The real assigner stays in the history and as `assignedBy`. A stand-in for an assigner
who is only away does not get these powers; he reviews tasks and decides extensions, nothing more. Dates in create,
edit and extension requests (`startDate`, `deadline`, `requestedDeadline`) must be between 2020-01-01 and 2100-12-31
(`400` validation with `issues`), and a deadline more than 731 days after the start is refused with `deadline_too_far`.

**Repeating tasks.** A series is made by the `task.repeat` job at 00:05 Pakistan time on each occurrence day (see
`docs/EVENTS.md`). The series stops at its stop date (`until`) or when it is stopped. `repeat.on` is a weekday 1 (Monday)
to 7 (Sunday) for a weekly series and a day of the month 1 to 28 for a monthly one.

**Mails.** The mails that go with these routes are sent through the normal mailer (Mailpit locally): a new task, the
reminders, a mention, a task handed in (to the assigner), an approval (with the rating), a rework, a hold, a
cancellation, an extension asked and decided. Never to the person who did the action, never for a personal to-do, and
never to people who have left or who have no official address. Reassigning a task sends no mail and emits no event.

## M6: performance and results

Shapes: `packages/contracts/src/performance.ts` (the same as `frontend/src/features/performance/types.ts`). Months are
Pakistan months (`2026-10`). Times are ISO 8601 in UTC.

**Weights.** The server stores whole percents that add up to exactly 100, by metric key. Standard keys: `quality`,
`onTime`, `completion`, `rework`, `attendance`. Sales keys: `activity`, `meetings`, `won`, `dataQuality`, `attendance`.
The two starting versions (company-wide, `createdBy` null) are Standard v1 (Q 35, T 25, C 20, R 10, A 10) and Sales v1
(V 20, M 25, W 30, D 10, A 15); the migration inserts them. A new version is inserted, never edited. The version in force
for a person is read by `effectiveFrom`, then `versionNo`, for their kind; a department's own set wins for that
department's people. The Settings screen uses the percents as they are; the performance screens divide by 100 in
`frontend/src/features/performance/live.ts` (`percentsToFractions`).

**Scorecards are not changed by requests.** The monthly job writes a scorecard with its metrics, score, band, weights
version and task snapshot in one transaction. The service never writes those columns again, and the database trigger
`scorecards_protect` refuses any change to them, with one exception: the recompute after a decided `changed` dispute, which
must raise `recomputeCount` by exactly 1 while changed disputes outnumber recomputes. That recompute uses the weights
version the scorecard was made with. Remarks, releases, acknowledgements and disputes are rows of their own. Remarks are an
insert-only history; there is no private note.

**Visibility.**
- A scorecard the caller may not see: `404 not_found`.
- A person the caller may not see (`GET /performance/live`, `GET /scorecards`): `403` with the message "You can only see
  your own results and your team's."
- An unknown Emp-ID: `404` with the message "Person not found".
- An employee's own draft: `404` for get, remark, release, acknowledge and raise. The employee is never told a draft
  exists. People above the employee see drafts.
- `GET /scorecards?latest=1` answers a list of at most one scorecard (never a null body).
- `GET /performance/team` is sorted by name, never by score.
- `own_scorecard` (`403`): nobody releases their own scorecard.
- A scorecard or dispute that exists but that the caller may not see answers `404` and is also recorded as a blocked attempt in
  the activity records (`GET /scorecards/:id`, `POST /scorecards/:id/{remark|release|acknowledge}`, `POST /disputes` with someone
  else's `scorecardId`, `POST /disputes/:id/decide`). An id that does not exist, and the employee's own draft, are not
  recorded. (Module 5's task routes do not do this: `loadVisibleTask` answers 404 without a record, see
  `docs/M5-ACCEPTANCE.md` decision 5.)

**Routes.** The 12 routes of the M6 controllers (`backend/src/performance/performance.controller.ts`) are below. The
approvals inbox also carries the M6 items (see "Approvals (M6 items)").

| Method and path | Who | What it does |
|---|---|---|
| `GET /performance/live?empId=` | `performance.view_own`; me, or someone below me | This month's figures for a person (default: me): metrics, score, band, `unmeasured`, weights version, the last 6 closed months and this month as a trend, the tasks and the open-task workload (information only) |
| `GET /performance/team` | `performance.view_team` | One row per person below me, sorted by name |
| `GET /scorecards?empId=&latest=&month=&limit=` | `performance.view_own`; scope as above | A person's scorecards, newest month first. The employee sees released and acknowledged ones only; people above also see drafts |
| `GET /scorecards/:id` | `performance.view_own`; 404 when not visible | One scorecard with the weights version it was made with, its disputes and its remark history (`comments`, oldest first). `reviewerRemark` is the newest remark |
| `POST /scorecards/:id/remark` | the reviewer (never the employee; an employee's own draft is `404`) | Body `{ remark }` (3 to 1000 characters). Adds a remark; never changes the numbers. Answers `200` |
| `POST /scorecards/:id/release` | the reviewer (the person's manager, or the next level up who reviews work when the manager has left or does not review work); never your own | Body `{ remark? }` (optional, 3 to 1000 characters). Draft to released; the employee is mailed. Answers `200` |
| `POST /scorecards/:id/acknowledge` | the person the scorecard is about, on a released scorecard | Body `{ comment? }`. Answers `200` |
| `GET /disputes?status=open\|upheld\|changed` | `performance.view_own` | Disputes I raised, that I must decide, or that belong to people below me |
| `POST /disputes` | the employee, on their own released scorecard | Body `{ scorecardId, taskNumber, reason }` (`taskNumber` like `TSK-0142`; `reason` at least 10 characters). One open dispute per task. The decider is fixed now and mailed. Answers `201` |
| `POST /disputes/:id/decide` | the decider (never the employee) | Body `{ change, decision, newRating? }`. `change: false` keeps the rating (upheld). `change: true` needs `newRating` (1 to 5, not the current one) and recomputes the scorecard with its own weights version. `decision` is at least 3 characters. The employee is mailed. Answers `200` |
| `GET /settings/score-weights?kind=&departmentId=` | `settings.view` | Every version, newest first (the company-wide ones and each department's own) |
| `POST /settings/score-weights` | `performance.weights` (the Director) | Body `{ kind, departmentId?, weights, reason }`. Saves a NEW version (without `departmentId`: the company-wide set; with it: that department's own). `reason` at least 3 characters. Audited. Answers `201` with the new version |

A weights version has `id`, `kind`, `label` (`Standard v2`, `Sales v1`; a department's set is named `Standard v1` and the
department is named next to it), `versionNo`, `departmentId` and `departmentName` (absent for the company-wide set),
`weights`, `note`, `effectiveFrom` and `createdBy` (the Emp-ID of the Director who saved it; `null` for the two starting
versions). Old scorecards keep the version they were made with.

`GET /performance/live` and `GET /scorecards/:id` return `weights` in a slimmer form: `id`, `label`, `kind`, `departmentId`,
`departmentName`, `weights` (whole percents), `versionNo` and `effectiveFrom` only. `createdBy` and `note` (the Director's
reason for the version) are only in `GET /settings/score-weights` (`settings.view`), so an employee reading their own
scorecard never sees who saved a set or why.

**Figures that cannot be measured are not invented.** A metric nobody can measure is `null` and named in `unmeasured`
with a reason: `attendance_not_available` (until Module 7), `sales_not_available` (until Module 15), or
`nothing_to_measure` (no rated task). The score uses only the measured metrics, with their weights scaled to 100. When
nothing is measurable the score is `null` and the band is `null`. A sales scorecard has no sales numbers and no score
until Module 15. Attendance from Module 7 must be a percentage from 0 to 100.

### Approvals (M6 items)

`GET /approvals` (and `/approvals/oversight`) also lists two M6 kinds, with the Module 5 ones:

- `scorecard`: id `scorecard:<scorecard id>`. A draft waiting for its reviewer. Approve releases it (the reason, when
  given, is the remark that goes with it). Reject adds a remark and keeps the draft (body `{ reason }`, required:
  `reason_required`). Labels: "Release" and "Add remark, keep draft".
- `dispute`: id `dispute:<dispute id>`. Approve changes the rating: body `{ rating, reason? }` (`rating` 1 to 5, required:
  `rating_required`; the reason is the decision text). Reject keeps the rating. Labels: "Change rating" and "Keep rating".

`POST /approvals/:id/approve` and `POST /approvals/:id/reject` answer `201 { "ok": true }`, like the Module 5 items. The
same rules as the scorecard and dispute routes apply (the service decides; a wrong person gets `403`).

### Error codes (Module 6)

The body is always `{ statusCode, code, message }`. Validation failures also carry `issues`.

| Status | Codes | Meaning |
|---|---|---|
| `400` | `weights_sum` | The weights do not add up to exactly 100 |
| `400` | `weights_keys` | The keys are not exactly the metrics of the kind |
| `400` | `weights_whole` | A weight is not a whole number |
| `400` | `weights_range` | A weight is outside 0 to 100 |
| `400` | `department_not_found` | The department does not exist or is archived |
| `400` | `not_rated` | Only a rated task on this scorecard can be disputed |
| `400` | `no_decider` | The scorecard has no reviewer, so nobody can decide a dispute on it |
| `400` | `decision_required` | The decision text is missing (at least 3 characters) |
| `400` | `rating_required` | A rating of 1 to 5 is needed (a dispute approval) |
| `400` | `rating_unchanged` | The new rating is the current one: keep the rating instead |
| `400` | `reason_required` | A reason or remark is required (for example a scorecard rejected from the inbox) |
| `403` | `forbidden` | The caller may not see the person (see the message) |
| `403` | `not_reviewer` | Only the reviewer adds a remark or releases a scorecard |
| `403` | `own_scorecard` | Nobody releases their own scorecard |
| `403` | `not_owner` | Only the person the scorecard is about acknowledges it or disputes a rating on it |
| `403` | `not_decider` | Only the decider (the level above the reviewer) decides this dispute |
| `403` | `own_dispute` | You cannot decide your own dispute |
| `404` | `not_found` | The scorecard, dispute, person, or approval item does not exist or is not visible to the caller |
| `409` | `invalid_state` | This action is not possible in this status (for example releasing a scorecard that is not a draft) |
| `409` | `already_disputed` | This rating already has an open dispute |
| `409` | `already_decided` | This dispute was already decided |
| `409` | `version_conflict` | Someone saved the weights at the same moment: reload and try again |

### Audit actions (Module 6)

Written by the core in the same transaction as the change (the recorder adds the request details as usual). Every scorecard
entry (`scorecard.drafted`, `scorecard.remark`, `scorecard.released` including the system release, `scorecard.acknowledged`)
uses the one target `<Emp-ID> <month>` (for example `ACV-0006 2026-10`), so a search by target returns a scorecard's whole
history; the scorecard id is in the details.

| Action | Target | Details |
|---|---|---|
| `settings.score_weights.created` | `settings` / `score-weights` | `before` (the set it replaces, for a department's first set the company-wide set), `after`, `kind`, `departmentId`, `versionNo` |
| `scorecard.drafted` | `scorecard`, `<Emp-ID> <month>` | Written by the monthly job with no person as the actor; the scorecard id is in the details |
| `scorecard.remark` | `scorecard`, `<Emp-ID> <month>` | The details hold only `{ scorecardId, length }`; the remark text itself is in `scorecard_comments` |
| `scorecard.released` | `scorecard`, `<Emp-ID> <month>` | Released by the reviewer, or by the system (no reviewer above reviews work) |
| `scorecard.acknowledged` | `scorecard`, `<Emp-ID> <month>` | The acknowledgement |
| `scorecard.dispute.raised` | `dispute`, the task number | The dispute |
| `scorecard.dispute.decided` | `dispute`, the task number | Upheld or changed, with the ratings before and after |

## M7: attendance and leave

Times always come from the server clock (Pakistan time, UTC+5); a time sent by the browser is ignored. People are named by
Emp-ID in URLs. A month that payroll has locked refuses every change (`409 period_locked`, also enforced by the database).

| Method and path | Who | What it does |
|---|---|---|
| `GET /attendance/today` | `attendance.self` | Server time, schedule, own check-in/out, `checkInAllowedHere` |
| `POST /attendance/check-in`, `POST /attendance/check-out` | `attendance.self` | Once per day each (`409 already_checked_in` / `already_checked_out` / `not_checked_in`). Late after start + grace. Office-only rule when management turns it on (`403 outside_office_network`) |
| `GET /attendance/me?month=`, `GET /attendance/employees/:empId?month=` | self; others need `attendance.view_team` and the person below the caller | Month view: on time, late, missed check-out, leave, holiday, absent |
| `GET /attendance/team?date=`, `GET /attendance/team/summary?month=` | `attendance.view_team` | People below the caller only |
| `GET/POST /attendance/corrections`, `GET /attendance/corrections/:id` | `attendance.self` (`?scope=team` needs view_team or approve_correction) | Ask for a correction of a past day; one pending per day. The original times are always kept |
| `POST /attendance/corrections/:id/approve`, `/reject`, `/cancel` | the routed approver (`attendance.approve_correction`): the Director for everyone below the Director (D23), otherwise the person's manager; cancel by the requester | Never your own (`403 self_approval`); the Director's stand-in may decide while the Director is away |
| `GET /leave/types`, `GET /leave/balances/:empId?year=`, `GET /leave/preview`, `GET /leave/calendar?month=` | logged in / `leave.request`, self or below | Balance = entitlement - approved - pending. The preview shows the day count and the approval chain |
| `GET/POST /leave/requests`, `GET /leave/requests/:id` | `leave.request` | Working days only (weekends and holidays are not counted); half days; inside one leave year; never more than the balance; no overlap |
| `POST /leave/requests/:id/approve`, `/reject`, `/cancel` | the routed approver (`leave.approve`); cancel by the requester before the first day | One step, the Director, for everyone below the Director (D24; the Director's stand-in while away, who must hold `leave.approve`); the Director's own leave goes to the Owner. If nobody can approve right now the request is refused (`409 no_approver`), never approved by default; only the Owner's own leave is recorded without an approver |
| `GET /holidays`, `POST/PATCH /holidays`, `POST /holidays/:id/archive` | read: logged in; change: `settings.manage` | One holiday calendar for every module |
| `GET/POST /settings/work-schedule`, `GET/POST /settings/office-networks`, `POST /settings/office-networks/:id/archive`, `GET/POST /settings/leave-entitlements` | `settings.manage` (reading the schedule: logged in) | A new schedule starts today or later; entitlements only for people below the setter, never your own |
| `POST /leave/types`, `PATCH /leave/types/:id`, `POST /leave/types/:id/archive` | `settings.manage` | Paid or unpaid cannot change once leave of that type exists (`409 leave_type_in_use`); archive it and add a new type |

## M8: payroll

Every payroll management route is a finance screen: 10-minute idle limit, and a refused permission answers **404**.
Amounts are exact decimals sent as strings (`"59900.00"`). The calculation reads the Module 7 month summary through
`AttendancePayrollPort` and creates ledger entries only through Module 9's `LedgerPostingPort`.

| Method and path | Who | What it does |
|---|---|---|
| `GET /payroll/runs`, `GET /payroll/runs/:id`, `GET /payroll/runs/:id/lines` | `payroll.view` | Runs (newest first) with totals, the ledger entry number and status, warnings (`missingPay`, `pendingAdjustments`). Viewing lines is audited (no amounts in the log) |
| `POST /payroll/runs` `{month}` | `payroll.prepare` | `PR-YYYY-MM`, one per month, current month or earlier |
| `POST /payroll/runs/:id/calculate` | `payroll.prepare` | Locks the month in attendance, reads the month summary, rewrites the lines. Needs a tax slab version (`409 tax_slabs_missing`); a negative net is refused |
| `POST /payroll/runs/:id/items`, `DELETE /payroll/runs/:id/items/:itemId` | `payroll.prepare` | Bonus or deduction lines while the run is editable |
| `POST /payroll/runs/:id/prepare`, then `/approve` | Finance (`payroll.prepare`), then **the Director** (`payroll.approve`, with "confirm again"; one step since D25). The Owner holds `payroll.approve` only for a run **the Director prepared** (`403 owner_approves_director_only` otherwise; D26). `/review` is kept, but nobody holds `payroll.review`; a run reviewed before D25 is approved by someone other than its reviewer | Maker-checker: the preparer can never approve (`403 maker_checker`). Approval **locks the month in attendance** (calculating does not), creates the payslips, records advance repayments and creates the salary entry, **which waits for normal ledger approval** (P7, D5) |
| `POST /payroll/runs/:id/return {reason}` | `payroll.approve` (the Director; the Owner only for a Director-prepared run) | Back to calculated |
| `POST /payroll/runs/:id/repost-salary-entry` | `payroll.prepare` | Only after the ledger **rejected** the run's salary entry: creates a new one with the same lines (purpose `salary-2`, `salary-3`, ...) and the approved run points at it |
| `POST /payroll/runs/:id/return` `{reason}` | reviewer or approver | Back to "calculated", with the note |
| `POST /payroll/runs/:id/mark-paid` `{bankAccountId, paidOn}` | `payroll.prepare` | Approved runs only, not dated in the future. Creates the payment entry (Dr salary payable, Cr bank), which also needs ledger approval. The run counts as **paid only when that entry is posted** (`paid` in the run view); while it waits `409 already_paid`, and after a rejection the transfer can be recorded again (purpose `payment-2`, ...) |
| `GET /payroll/runs/:id/bank-sheet` | `payroll.export` + "confirm again" | CSV marked highly confidential with full account numbers; audited with the run number and row count only |
| `GET/POST /payroll/adjustments` | view / prepare | A correction to an approved month lands in a later run (an approved run never changes) |
| `GET /payroll/advances`, `POST /payroll/advances`, `GET /payroll/advances/me` | view / prepare / own | An advance is paid through a ledger entry and deducted only once that entry is posted |
| `GET /payslips/me`, `GET /payslips/me/:month` | `payroll.view_own` | Own payslips, with the year to date |
| `GET /payslips/employees/:empId` | `payroll.view` only (a finance screen: anyone else, the employee included, gets 404; employees use `/payslips/me`) | One person's payslips; audited |
| `GET /payslips/:id`, `GET /payslips/:id/document` | logged in: your own payslip, or anyone with `payroll.view` (audited) | Someone else's payslip answers 404 (the refusal is audited). The document is printable HTML (D15) |
| `GET /settings/tax-slabs`, `POST /settings/tax-slabs` | view: payroll or settings viewers; add: `settings.manage` | Versioned slabs entered by the accountant (none are seeded) |

## M9: finance ledger

Every route is a finance screen (10-minute idle limit; a refused permission answers **404**) and needs `finance.view`
plus the permission shown. Posted entries are never edited or deleted (database trigger): a mistake is corrected by a
reversing entry. Debits must equal credits (`unbalanced_entry`, also checked by the database at commit). Nothing can be
posted into a closed month (`409 period_closed`), and no new entry is made while a month waits for its close approval (`409 period_closing`). Reports are under `/ledger/reports/*` so they do not clash with
Module 10's `/reports`.

| Method and path | Who | What it does |
|---|---|---|
| `GET /journal-entries` (filters `status`, `month`, `source`, `accountId`, `partyId`, `projectId`, `awaitingMe`, `q`), `GET /journal-entries/:id` | `finance.view` | |
| `POST /journal-entries`, `PATCH /journal-entries/:id`, `POST /journal-entries/:id/submit` | `finance.entry_create` (the maker's own draft) | |
| `POST /journal-entries/:id/approve`, `/reject {reason}` | `finance.entry_approve`: **the Director approves every entry, whatever the amount** (D26). An entry is approved at exactly its level, so the Owner approves only entries the Director made (level 1) | Never the maker (`403 self_approval`); any other level `403 approval_limit`; "confirm again" above `finance_settings.step_up_above`. Large entries (above `finance_settings.owner_notify_above`) and capital or loan entries are reported to the Owner (audit action `finance.entry.owner_notified`); the Owner only views them |
| `POST /journal-entries/:id/reverse {reason, date?}` | `finance.entry_create` | A draft with the lines swapped, which follows normal approval. One live reversal per entry (database index); a rejected reversal does not block a new one |
| `GET /accounts`, `POST /accounts`, `PATCH /accounts/:id` | view / `finance.entry_create` | Chart of accounts in five groups; system roles map automatic postings to accounts. New equity accounts need Owner approval by default (only the Owner may create one without it, `403 owner_only`); a sub-account of an account that needs Owner approval (for example under 2500 Loans) always needs it too (`409 owner_approval_inherited`, also enforced by the database). `PATCH` can add the rule but never remove it (`403 owner_only`) |
| ~~`PUT /accounts/:id/owner-approval`~~ | removed (D26) | The "Owner approves" flag now means "report to the Owner". It is on for equity accounts and loan sub-accounts, can only be added (`403 owner_flag_locked` when removing it or creating an unflagged equity account), and the database still refuses a removal without an Owner audit row |
| `GET /bank-accounts`, `POST /bank-accounts`, `PUT /bank-accounts/:id/details` | view / entry_create / entry_create | Account numbers are encrypted and masked |
| `POST /bank-accounts/:id/reveal` | `finance.view` + "confirm again" | Shows the full number once; audited without the number |
| `GET /parties`, `GET /parties/:id`, `POST /parties`, `PATCH /parties/:id`; `GET /finance-projects`, `POST /finance-projects`, `PATCH /finance-projects/:id`; `GET/POST /exchange-rates` | reads: view; changes: entry_create | Parties and projects are archived, never deleted. One USD rate per day (`409 rate_exists`) |
| `GET /invoices`, `GET /invoices/:id`, `GET /invoices/:id/document`, `POST /invoices`; `GET /bills`, `GET /bills/:id`, `POST /bills` | reads: view; create: entry_create | Status is calculated from posted payments. The invoice document is printable HTML |
| `POST /bills/:id/receipt`, `POST /receipts/journal-entries/:id`, `GET /receipts/:id` | attach: entry_create; download: view | A receipt is attached to a bill or to a journal entry. PDF, PNG or JPEG by real content, 10 MB, private storage; downloads audited |
| `GET /payments`, `GET /payments/:id`, `POST /payments`; `GET/POST /transfers` | reads: view; create: entry_create | No overpayment; the payment currency must match |
| `GET/POST /bank-statements`, `POST /bank-statements/auto-match`, `POST /bank-statements/lines/:id/match`, `/unmatch`, `/create-entry` | view / entry_create | CSV import (a file is imported once), suggestions, matching |
| `GET /periods`, `GET /periods/:month` | view | Live checklist: entries posted, bank reconciled, payroll posted, USD revalued, trial balance |
| `GET /periods/:month/revaluation?rate` | view | USD revaluation preview (default: the saved month-end rate) |
| `POST /periods/:month/revaluation-preview {rate}`, `POST /periods/:month/revalue` | view + entry_create | Preview with a rate; create the month-end revaluation entry (once per month; it waits for approval) |
| `POST /periods/:month/close`, then `/approve-close` or `/reject-close` | finance duty (`finance.close`), then **the Director** (`finance.close_approve`, D25), never the person who ran it | The checklist is checked again at approval |
| `POST /periods/:month/reopen {reason}` | **the Director** (`finance.reopen`, D25) + "confirm again" | Logged, audited and sent to the outbox; the Owner only views |
| `GET /settings/finance` | `finance.view` | `{ stepUpAbove, ownerNotifyAbove, financeYearStartMonth }`. `GET /settings/approval-limits` no longer exists (there are no approval tiers) |
| `PUT /settings/finance` `{stepUpAbove, ownerNotifyAbove, financeYearStartMonth, reason}` | **the Director** (`finance.authority_manage`, D26) + a reason and "confirm again" (audited) | The Owner and Finance cannot change it (404). Migration `20261119090500_ledger_director_approves_all` removed the `approval_limits` table |
| `GET /ledger/reports/{trial-balance, general-ledger, ar-aging, ap-due, profit-by-project, profit-by-client}` | `finance.view` | |
| `GET /ledger/export?from&to` | `finance.export` + "confirm again" | CSV with a watermark line; formula injection blocked; audited |

## Event contracts

Events for other modules are written to the `outbox_events` table in the same transaction as the change, and delivered by
the outbox dispatcher to the modules that consume them. The full contract (what, when, how to consume) is in
`docs/EVENTS.md`.
