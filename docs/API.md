# Aceva API

Base URL (development): `http://localhost:4000/api/v1`
Interactive documentation (Swagger UI): `http://localhost:4000/api/docs`
Machine-readable OpenAPI JSON: `http://localhost:4000/api/docs-json`

Request and response shapes are defined once, in `packages/contracts/src` (Zod schemas), and shared with the website.

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
| `POST /auth/logout` | logged in | Ends this session now (all stores) |
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
| `POST /auth/employees/:empId/unlock` | `auth.unlock_account`, above them in the line or HR duty | Unlock a locked account |
| `POST /auth/employees/:empId/force-logout` | `session.force_logout`, below the caller | Ends every session on every device at once |
| `POST /auth/employees/:empId/reset-2fa` | `auth.reset_two_factor`: Owner/CEO (anyone below), Director (below them in the line), HR duty (below them in the line). Never yourself, same level or upward | Body `{ reason }`. Lost authenticator phone: deletes the old secret, ends every session, and the person must enrol a new authenticator at next login. Audited (`auth.2fa.reset`). |
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
| `PATCH /org/employees/:empId/level` | `org.manage` (Owner, CEO), below the caller | `{ level: 2..5, roleKey?, reason }`. Validated against the reporting lines; nobody can assign a level at or above their own |
| `PATCH /org/employees/:empId/reporting-line` | `org.manage`, below the caller | `{ reportsToEmpId, reason }`. No loops, no self, no reporting to a lower level, same-level only where configured |
| `POST /org/employees/:empId/duties`, `DELETE .../duties/:dutyKey` | `duty.assign` (Director), below the caller | `{ dutyKey, reason }` / `{ reason }` |
| `GET /org/departments` | `org.view` | Departments (with their explicit head) and offices with headcount |
| `POST /org/departments`, `PATCH /org/departments/:code`, `POST /org/departments/:code/deactivate` | `org.manage` (Owner, CEO) | `{ name, headEmpId?, reason }`, `{ name?, headEmpId?, reason }`, `{ reason }`. Heads are chosen explicitly and audited; deactivating needs an empty department |
| `POST /org/offices`, `PATCH /org/offices/:code`, `POST /org/offices/:code/deactivate` | `org.manage` | `{ name, city?, reason }` and similar |
| `GET /org/changes` | `audit.view` | Recent access changes, from the audit log |
| `POST /stand-ins`, `GET /stand-ins`, `DELETE /stand-ins/:id` | `standin.manage` / logged in | `{ standInEmpId?, startsOn, endsOn, reason? }`. No stand-in means approvals go up the chain. Overlaps and conflicts are refused |
| `GET /approvals/route/:empId?date=&afterSeat=` | scope: me or below | Who approves this person's request on a date (real reporting chain, stand-ins, people who left are passed over) |
| `GET /approvals/can-approve/:empId` | scope: below me | May I approve right now? Never my own |
| `GET /access/can-assign-task/:empId` | logged in | Tasks only move down my reporting line |

Every change writes an audit record (who, what, before and after, and the reason) in the same database transaction.

## M3: employee profiles, joining and leaving

| Method and path | Who | What it does |
|---|---|---|
| `GET /employees?q=` | everyone logged in | Staff directory: Basic fields only (Emp-ID, name, designation, department, office, official email, `hasPhoto`). People who have left are not listed |
| `GET /employees/:empId` | everyone logged in | The profile with only the sections the caller may see (`basic` always; `job`: self, above, Director/HR; `personal` and `documents`: self, HR, Director and above; `pay`: self, Director, CEO, Owner, finance duty; `history`). `access` says what the caller may edit. CNIC and bank account are masked. **Salary amounts are never in the profile or the history**: `pay` has only `salaryOnFile`, the bank name and the masked account; the amounts come from the reveal below |
| `PATCH /employees/:empId/basic` | Director or HR, for people of lower rank | Name, designation, department/office (codes), official email. Old values go to the history |
| `PATCH /employees/:empId/job` | Director or HR for joining date, type, capacity; **Owner or CEO only** for `level` and `reportsToEmpId` (through the Module 1 rules) | Needs `reason`. Status cannot be changed here (use the leaving workflow) |
| `PATCH /employees/:empId/personal` | the employee (phone, home address, emergency contact) or Director/HR (also CNIC) | History keeps old values; CNIC is stored encrypted |
| `PATCH /employees/:empId/pay` | Director only, never their own | Needs `reason`. Base salary, allowances total, bank name, account number (encrypted) |
| `POST /employees/:empId/reveal` | whoever may see that section | Body `{ field: cnic\|account\|salary }`. Returns `{ value }` (salary: `{ value, allowances }`). **Every reveal is permission-checked and audited** (the value is never logged) |
| `POST /employees` | `people.manage` (Director, HR duty) or `org.manage` (Owner, CEO) | Joining workflow. **Director/HR only START a hire** (Level 4 or 5): the answer is `{ status: 'pending_approval', requestId }`; no employee, Emp-ID, login or email exists yet. **Owner/CEO create directly** (Levels 3-5): `{ status: 'created', empId, welcomeEmailSent }`. Pay may be included only by the Director |
| `GET /hire-requests?status=` | Owner, CEO, Director, HR | Requests (no personal or pay details) |
| `POST /hire-requests/:id/approve` | `people.approve_hire`: **the Director** (D25); a request the Director made is decided by the CEO, and the Owner may decide any. Never your own (`403 self_approval`); the CEO on someone else's request `403 director_approves`; the Director never places a hire at Level 3 or above (`403 level_not_allowed`) | Body `{ level?, reportsToEmpId? }` (they may correct the proposal; the reporting rules apply). Now the Emp-ID is generated, the login is created and the welcome email with a temporary password is sent. A request is decided once |
| `POST /hire-requests/:id/reject` | `org.manage` | Body `{ reason }` |
| `GET /employees/unresolved-reports` | Owner, CEO, Director, HR | People who still report to someone who left. Nothing moves them automatically; the Owner or CEO use `PATCH /employees/:empId/job` with `reportsToEmpId` |
| `POST /employees/:empId/resend-welcome` | `people.manage`, above the person | New temporary password and email, only before the first login |
| `GET/POST /employees/:empId/documents`, `GET .../documents/:id/download`, `DELETE .../documents/:id` | self, HR, Director and above (employees add their own CV, CNIC copy, certificates; HR/Director add contracts) | Private storage. PDF, PNG, JPEG, .docx by real content, 10 MB. Download is permission-checked and logged; "delete" archives |
| `POST/GET /employees/:empId/photo` | upload: self or Director/HR; view: everyone | JPEG or PNG, 2 MB |
| `POST /employees/:empId/offboard` | Director or HR, for people of lower rank | Body `{ lastWorkingDay, reason }`. **The person keeps access through the whole last working day; access ends at 00:00 Pakistan time on the next day.** A last working day that is already over is processed at once; otherwise a scheduled job runs at that moment. Calling it again moves the date |
| `DELETE /employees/:empId/offboard` | same | Body `{ reason }`. Cancels a leaving date that has not been processed |

When access ends the system: sets the status to `left`, disables the login and ends every session, ends duties and
stand-in cover, clears a department head, writes the history, and queues the events `employee.offboarded`,
`task.transfer.requested` and `payroll.final_settlement.requested`. **Reporting lines are not changed**: the leaver's direct
reports are listed until the Owner or CEO assign a new manager. The record is never deleted.

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
| `POST /leave/requests/:id/approve`, `/reject`, `/cancel` | the routed approver (`leave.approve`); cancel by the requester before the first day | One step, the Director, for everyone below the Director (D24; the Director's stand-in while away); the Director's own leave goes to the CEO |
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
| `POST /payroll/runs/:id/prepare`, then `/approve` | Finance (`payroll.prepare`), then **the Director** (`payroll.approve`, with "confirm again"; one step since D25, the CEO only views). `/review` is kept, but nobody holds `payroll.review` since D25; a run reviewed before D25 is approved by someone other than its reviewer | Maker-checker: the preparer can never approve (`403 maker_checker`). Approval creates the payslips, records advance repayments and creates the salary entry, **which waits for normal ledger approval** (P7, D5) |
| `POST /payroll/runs/:id/return` `{reason}` | reviewer or approver | Back to "calculated", with the note |
| `POST /payroll/runs/:id/mark-paid` `{bankAccountId, paidOn}` | `payroll.prepare` | Once, approved runs only, not dated in the future. Creates the payment entry (Dr salary payable, Cr bank), which also needs ledger approval |
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
| `POST /journal-entries/:id/approve`, `/reject {reason}` | `finance.entry_approve` at the tier the PKR amount needs (`approval_limits`; development defaults since D25: Director up to 5,000,000, Owner above and for every capital or loan entry; no CEO tier). An entry is approved at exactly its level or by the Owner, so the CEO approves only entries the Director made (level 2) | Never the maker (`403 self_approval`); any other level `403 approval_limit`; "confirm again" above `finance_settings.step_up_above` |
| `POST /journal-entries/:id/reverse {reason, date?}` | `finance.entry_create` | A draft with the lines swapped, which follows normal approval. One live reversal per entry (database index); a rejected reversal does not block a new one |
| `GET /accounts`, `POST /accounts`, `PATCH /accounts/:id` | view / `finance.entry_create` | Chart of accounts in five groups; system roles map automatic postings to accounts. New equity accounts need Owner approval by default (only the Owner may create one without it, `403 owner_only`); a sub-account of an account that needs Owner approval (for example under 2500 Loans) always needs it too (`409 owner_approval_inherited`, also enforced by the database). `PATCH` can add the rule but never remove it (`403 owner_only`) |
| `PUT /accounts/:id/owner-approval {required, reason}` | **Owner only** (`finance.authority_manage`, decision D22) + "confirm again" | Adds or removes the "Owner approves" rule. Removing it from a sub-account whose parent needs it is refused (`409 owner_approval_inherited`). The database accepts a removal only together with the Owner's audit row in the same transaction |
| `GET /bank-accounts`, `POST /bank-accounts`, `PUT /bank-accounts/:id/details` | view / entry_create / entry_create | Account numbers are encrypted and masked |
| `POST /bank-accounts/:id/reveal` | `finance.view` + "confirm again" | Shows the full number once; audited without the number |
| `GET /parties`, `GET /parties/:id`, `POST /parties`, `PATCH /parties/:id`; `GET /projects`, `POST /projects`, `PATCH /projects/:id`; `GET/POST /exchange-rates` | reads: view; changes: entry_create | Parties and projects are archived, never deleted. One USD rate per day (`409 rate_exists`) |
| `GET /invoices`, `GET /invoices/:id`, `GET /invoices/:id/document`, `POST /invoices`; `GET /bills`, `GET /bills/:id`, `POST /bills` | reads: view; create: entry_create | Status is calculated from posted payments. The invoice document is printable HTML |
| `POST /bills/:id/receipt`, `POST /receipts/journal-entries/:id`, `GET /receipts/:id` | attach: entry_create; download: view | A receipt is attached to a bill or to a journal entry. PDF, PNG or JPEG by real content, 10 MB, private storage; downloads audited |
| `GET /payments`, `GET /payments/:id`, `POST /payments`; `GET/POST /transfers` | reads: view; create: entry_create | No overpayment; the payment currency must match |
| `GET/POST /bank-statements`, `POST /bank-statements/auto-match`, `POST /bank-statements/lines/:id/match`, `/unmatch`, `/create-entry` | view / entry_create | CSV import (a file is imported once), suggestions, matching |
| `GET /periods`, `GET /periods/:month` | view | Live checklist: entries posted, bank reconciled, payroll posted, USD revalued, trial balance |
| `GET /periods/:month/revaluation?rate` | view | USD revaluation preview (default: the saved month-end rate) |
| `POST /periods/:month/revaluation-preview {rate}`, `POST /periods/:month/revalue` | view + entry_create | Preview with a rate; create the month-end revaluation entry (once per month; it waits for approval) |
| `POST /periods/:month/close`, then `/approve-close` or `/reject-close` | finance duty (`finance.close`), then **the Director** (`finance.close_approve`, D25), never the person who ran it | The checklist is checked again at approval |
| `POST /periods/:month/reopen {reason}` | **the Director or the Owner** (`finance.reopen`, D25) + "confirm again" | Logged, audited and sent to the outbox |
| `GET /settings/approval-limits`, `GET /settings/finance` | `finance.view` | |
| `PUT /settings/approval-limits`, `PUT /settings/finance` | **Owner only** (`finance.authority_manage`, decision D22; also checked in the service) + a reason and "confirm again" (audited) | Nobody else, the Director included, can change an approval limit or the confirm-again amount (404). The unlimited tier is always the Owner (level 1), and the Owner tier is never removed (also enforced by the database) |
| `GET /ledger/reports/{trial-balance, general-ledger, ar-aging, ap-due, profit-by-project, profit-by-client}` | `finance.view` | |
| `GET /ledger/export?from&to` | `finance.export` + "confirm again" | CSV with a watermark line; formula injection blocked; audited |

## Cycle 3 foundation: notifications and module settings

| Endpoint | Who | Notes |
|---|---|---|
| `GET /notifications?unread=` | everyone logged in | The caller's own, newest first (the latest 100): `{ id, empId, type, title, body, link, at, read, essential }` |
| `POST /notifications/read {ids?}` | everyone logged in | Marks the caller's own read (no ids = all); other people's ids are not matched. `{ updated }` |
| `GET /notifications/prefs`, `PATCH /notifications/prefs` | everyone logged in | `{ email: { [type]: boolean }, dailySummary }`. Turning off an essential type: `400 essential_notification` |
| `GET /settings/modules/:module` | the module's view permission (default `settings.view`) | `{ module, value, version, updatedAt, updatedByEmpId }`; version 0 = defaults. Unknown module or no permission: 404 |
| `PUT /settings/modules/:module {value, version, reason}` | the module's manage permission (`notifications`: `settings.manage`) | Checked by the module's schema (`400 invalid_settings`), stale version `409 stale_version`, audited with old and new value |

## Module 13: customer billing and subscriptions

Every `/billing` route is a finance screen: without the permission the answer is 404, and the 10-minute finance idle limit
applies. Invoices and payments are Module 9's (one system); full table of routes and rules: docs/M13-BILLING.md.

| Endpoint | Who | Notes |
|---|---|---|
| `GET /billing/overview` | `billing.view` | Billed and collected this month, outstanding, overdue, due in 14 days, drafts from Won deals (PKR) |
| `GET /billing/invoices?partyId&status`, `GET /billing/invoices/:id` | `billing.view` | Status calculated: draft, issued, part_paid, paid (posted payments only), overdue, cancelled. Detail: client, payments, reminders, emails, recurring rule |
| `POST /billing/invoices` | `billing.manage` | A draft, no ledger entry; `requestKey` makes a retry return the same draft; recurring and rental create their rule |
| `PATCH /billing/invoices/:id` | `billing.manage` | Drafts only (`409 invoice_locked` / `invalid_transition` otherwise) |
| `POST /billing/invoices/:id/issue {issueDate?, exchangeRate?}` | `billing.manage` | INV number, entry submitted for approval, reminders scheduled. Not emailed: the client email is queued once the entry is approved. A client created from a Won deal must be confirmed first (`409 client_needs_review`) |
| `POST /billing/invoices/:id/cancel {reason}` | `billing.manage` | Draft: cancelled. Posted: reversing entry for approval (step-up). `409 entry_pending`, `409 has_payments` |
| `POST /billing/invoices/:id/restore`, `POST /billing/invoices/:id/email` | `billing.manage` | Restore after a rejected reversal; email once, only after approval (`409 entry_not_approved`, `customer_emails_off`, `already_emailed`) |
| `GET /billing/deal-handovers?status`, `POST /billing/deal-handovers/:id/resolve {partyId}` | view / `billing.manage` | Won deals whose client name matched several clients: Finance chooses the client, then the draft is made once |
| `POST /billing/customers/:id/confirm` | `billing.manage` | Confirm a client created automatically from a Won deal |
| `POST /billing/invoices/:id/payments {requestKey, bankAccountId, date, amount, method, reference?}` | `billing.manage` + `finance.entry_create` | A Module 9 payment waiting for approval; card numbers refused |
| `GET /billing/invoices/:id/document` | `billing.view` | Printable HTML with the company details from the settings |
| `GET /billing/invoices/export` | `billing.view` + `finance.export` | CSV; step-up, watermark, audit |
| `GET /billing/payments`, `GET/POST /billing/customers`, `PATCH /billing/customers/:id` | view / `billing.manage` | A client is a Module 9 party with billing details |
| `GET /billing/recurring`, `POST /billing/recurring/:id/stop {reason}` | view / `billing.manage` | Recurring and rental rules |
| `GET /billing/subscriptions`, `GET /billing/subscriptions/renewal-events`, `GET /billing/subscriptions/:id` | `subscriptions.view` | Register with status, latest readings, usage flag, costs |
| `POST /billing/subscriptions`, `PATCH /billing/subscriptions/:id` | `subscriptions.manage` | PATCH: details only (plan, cost, period and renewal date change by a decision) |
| `POST /billing/subscriptions/:id/renewal-decision {decision, note?, nextRenewalDate?, newPlan?, newCost?, newPeriod?}` | `subscriptions.manage` | renewed, changed or cancelled (a note is required) |
| `POST /billing/subscriptions/:id/usage {readingDate, used, limit?, estimatedCost?}` | `subscriptions.manage` | Typed in; a cost on it is an estimate |
| `PUT /billing/subscriptions/:id/costs/:month {amount, currency, estimated, billId?, reference?}` | `subscriptions.manage` | Actual only with a bill or provider reference |
| `GET/PUT /settings/modules/billing` | view `billing.view`, change `settings.manage` (step-up) | Company details, customer emails, reminder days, default terms and income account |

## Module 14, part 1: conversations and messages

Every route needs `comms.use` (everyone). Inside a conversation, what you may do depends on being a member and your role
there, checked on every request. **A conversation you are not a member of is "not found" (404)**, for every route below,
also for managers and admins (DMs and groups are open to their members only). Department channel members are the
department's current employees and its head (read from the employee records at each request) plus people added by hand.
**History starts when you join:** a member sees only messages sent after they became a member. For people added by hand
that is the conversation's message number when they were added (again); for department channels it is recorded by
database triggers when someone is hired into or moved into the department, or made its head (table
`department_channel_access`). Earlier messages are "not found" for them in every route, search, saved messages, unread
counts, previews and receipts. People already in a department when its channel is created see it from the start.
Message text is plain text (at most 4,000 characters, never HTML); it is never written to the audit log, the outbox or the
application log, and database errors on these routes are answered and logged as codes only.

| Endpoint | Who | Notes |
|---|---|---|
| `GET /comms/conversations?cursor&limit` | member | My conversations, most recently active first, with my unread count and the last message |
| `POST /comms/conversations` | DM, group: anyone; channel: `comms.admin` | `{kind:'dm', empId}` (an existing DM is returned with 200), `{kind:'group', name?, memberEmpIds}` (at most 50 people; the creator moderates), `{kind:'channel', scope:'department', departmentId, name, topic?, moderatorEmpIds?}` or `{kind:'channel', scope:'project', projectName, projectCode?, name, memberEmpIds, moderatorEmpIds?}` |
| `GET /comms/conversations/:id` | member; a `comms.admin` also for any channel (no messages) | Members (with `source` added or department), my read position, receipts (DMs and groups only), pins, `can` |
| `PATCH /comms/conversations/:id {name?, topic?, projectName?, projectCode?}` | group moderators; channel moderators and `comms.admin` | |
| `POST /comms/conversations/:id/archive {reason}` | group moderators; channels: `comms.admin` | Read-only afterwards (`409 conversation_archived`) |
| `POST /comms/conversations/:id/members {empIds}` | group moderators; channel moderators and `comms.admin` | Current employees only (`400 unknown_or_inactive_employee`) |
| `DELETE /comms/conversations/:id/members/:empId` | same; your own Emp-ID = leave | `409 department_member`: department channel members stay while they are in the department. Writes `comms.member.removed` |
| `PUT` / `DELETE /comms/conversations/:id/moderators/:empId` | channels: `comms.admin`; groups: moderators | |
| `POST /comms/conversations/:id/read {seq}`, `POST .../delivered {seq}` | member | Positions only move forward; read counts as delivered |
| `GET /comms/conversations/:id/messages?before=N` or `?after=N`, `&limit` | member | By sequence number (unique per conversation, no gaps). Deleted messages stay as placeholders |
| `POST /comms/conversations/:id/messages {clientKey, body, parentId?}` | member, not archived | 201, or 200 with `created:false` for a retry with the same `clientKey`; `409 client_key_reused` when that key was used for something else; replies only to a top-level message (`400 invalid_reply_target`); `@ACV-0006` mentions members only (`400 mention_not_member`); at most 30 a minute (`429 rate_limited`) |
| `GET /comms/conversations/:id/pins` | member | |
| `GET /comms/messages/:id/thread?after&limit` | member | The message and its replies |
| `PATCH /comms/messages/:id {body}` | the author, within 24 hours | `409 edit_window_closed`; the older text is kept, never shown |
| `DELETE /comms/messages/:id` | the author, any time | A placeholder stays; the text is kept as an older version |
| `POST /comms/messages/:id/remove {reason}` | moderators (and `comms.admin` members of a channel) | Audited with the reason, never the text |
| `PUT` / `DELETE /comms/messages/:id/reactions/:emoji` | member | Once per person and emoji |
| `PUT` / `DELETE /comms/messages/:id/pin` | DMs and groups: members; channels: moderators | Once per message; audited |
| `PUT` / `DELETE /comms/messages/:id/save` | member | Private to you |
| `GET /comms/search?q&conversationId&cursor&limit` | member | PostgreSQL full-text search, only in conversations you can see now |
| `GET /comms/saved?cursor&limit` | anyone | Your saved messages from conversations you can still see |
| `GET /comms/admin/channels?cursor&limit` | `comms.admin` | Every channel with member count and moderators, never messages |


## Event contracts

Events for other modules are written to the `outbox_events` table in the same transaction as the change. The full
contract (what, when, how to read them) is in `docs/EVENTS.md`.
