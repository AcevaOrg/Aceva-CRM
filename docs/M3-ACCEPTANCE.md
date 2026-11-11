# Module 3 acceptance checklist (plan section 7)

**Status: the three browser-testing gaps and the confirm-again dialog are closed and verified. NOT accepted:** acceptance is
yours to give. The remaining limits are listed at the end.

Statuses: **Done and tested** = a test I ran passes. **Partial** = built, with a stated gap. **Open** = not done.
Backend tests: `backend/test/m3-*.test.ts` and `backend/test/m2-reset-2fa.test.ts`. Browser tests (real Chromium, real
backend, PostgreSQL, Redis, Mailpit): `e2e/m3-live.spec.ts`.

**Last verified results (this round):** backend `npm test`: 307 backend tests in 18 files and 6 contract tests passing.
Browser suite: **30 of 30 passing** (M1 8, M2 8, M3 14). Typechecks clean, frontend lint 0 errors, frontend production build succeeds.

## This round: the items you asked to close

| # | Item | Status | Verified by |
|---|---|---|---|
| R1 | Pay edit form: editing, permissions, audit history | Done and tested. The Director opens "Edit pay", confirms again (real password and authenticator code), the form is prefilled from a logged reveal, saves with a reason. History shows the field, who and why, with both amounts hidden (`••••••`); the table keeps them encrypted; `employee.pay.updated` is in the audit log; the new amount is really saved. Refused: HR, CEO, Owner, Finance, a colleague (all 403, with confirm-again done first so it is the permission being tested); HR has no Pay tab; the CEO sees "View only" and no edit button | e2e test 9, `m3-profiles`, `m3-step-up` |
| R2 | Job edit form: job-field editing, manager reassignment, unauthorized attempts | Done and tested. HR edits type and capacity in the form (no level or manager control is shown to HR); the CEO reassigns the manager in the form; history shows both changes with who and why. Direct attempts refused (403): HR and the Director changing level or manager, a colleague, Finance, the employee themself; the CEO's invalid line is refused (400) and nothing changes. **Fix found by this test:** Owner and CEO had no Job form for people below them although the server allows them to reassign; they now get it (and not for themselves, upward or sideways) | e2e test 10, `m3-profiles` (access rule), `m3-leaving` |
| R3 | Document archiving: UI action, permissions, archived-file access | Done and tested. The person archives in the screen with a required reason; HR archives another; the card disappears and stays gone after a reload; the record and file are kept on disk; the audit entry has the reason. Colleagues, the CTO and Finance are refused (403) for archiving and for downloading; nobody (Director, HR, the person) can list or download an archived file (404) | e2e test 11, `m3-documents` |
| R4 | Confirm-again dialog | **Removed the fake check; now verified by the server.** `POST /auth/step-up` checks the password (Argon2) and, for people with an authenticator, a current code (a code works once). A wrong password or wrong/arbitrary code is refused with one message that does not say which part was wrong, the dialog stays open and nothing is confirmed. 5 wrong answers in 15 minutes end the session. A correct answer is stored on that session for 5 minutes (in PostgreSQL). **The server enforces it** for bank-account reveal, salary reveal and pay edits (403 `step_up_required` otherwise). Audited (`auth.step_up`, `auth.step_up.failed`) | `m3-step-up` (9 tests: refusal without it, wrong password, wrong code, missing code, replay, 5-minute expiry, per-session scope, password-only users, lockout), e2e test 8 |
| R5 | Does cancelling a leaving date need a screen? | **No. The plan does not call for cancelling.** Plan section 7 (Leaving) says only: "HR sets the last working day. On that day the system disables the login…". Moving a date is covered by setting it again (the dialog already does that). I built `DELETE /employees/:id/offboard` earlier; it is an **extra beyond the plan**, tested in `m3-leaving`, and has no screen on purpose | plan text, `m3-leaving` |

Notes on R4 and the plan: plan section 6 lists "viewing bank details" (and approving payroll, large entries, reopening a month,
exporting statements) as actions that "ask for the password and 2FA code again". I enforce it for bank details, and also for
salary reveal and pay edits, which is **stricter than the plan's list** because the screen already asked for it. The CNIC reveal
does not require it (the plan does not list it). People without an authenticator (Level 4-5 without Finance duty) confirm with
the password only.

## Your earlier decisions (all still verified)

| # | Decision | Status | Verified by |
|---|---|---|---|
| D1 | Access ends at 00:00 Pakistan time on the day AFTER the last working day | Done and tested | `m3-leaving`, e2e |
| D2 | Only Owner/CEO change level and reporting line; Director/HR edit permitted job fields within their scope | Done and tested | `m3-profiles`, `m3-joining`, e2e test 10 |
| D3 | Director/HR may initiate Level 4-5 hires; only Owner/CEO authorize level and line | Done and tested | `m3-joining`, e2e tests 1-2 |
| D4 | Salary amounts are not sent before an authorized, audited reveal (now also behind confirm-again) | Done and tested | `m3-profiles`, `m3-step-up`, e2e |
| D5 | Reporting lines do not change when someone leaves; unresolved reports are shown; Owner/CEO reassign | Done and tested | `m3-leaving`, e2e test 13 |
| D6 | Browser tests: wizard, editing, upload/download, photo, 2FA reset dialog | Done and tested | `e2e/m3-live.spec.ts` |

## Profiles, changes, joining, leaving (plan section 7)

| # | Requirement | Status | Verified by |
|---|---|---|---|
| P1-P6 | Five sections, who sees what, encrypted CNIC and bank account, logged reveal | Done and tested | `m3-profiles`, `m3-documents`, e2e |
| P5 | Documents in private storage | Done and tested against a local private folder (the browser tests use a throw-away folder). AWS S3/R2 plug in behind `FileStorage` and are **not tested** | `m3-documents`, e2e |
| C1-C5 | Changes by role, history with old and new values, rules enforced on the server | Done and tested, now including the pay and job forms in the browser | `m3-profiles`, e2e |
| J1-J2 | Emp-ID generated, welcome email with temporary password, changed at first login | Done and tested end to end (wizard, approval, Mailpit email, first login) | `m3-joining`, e2e |
| L1-L3 | Last working day, job on the day, disable login and sessions, record kept; retries and crash recovery | Done and tested | `m3-leaving`, e2e |
| L4 | Transfer open tasks to the manager | **Open by design**: only the event `task.transfer.requested` is written. Module 5 does not exist | `m3-leaving` |
| L5 | Send the final salary to payroll | **Open by design**: only `payroll.final_settlement.requested` is written. Module 8 does not exist | `m3-leaving` |
| K | Lost authenticator reset | Done and tested, including the dialog | `m2-reset-2fa`, e2e |

## What the browser tests cover (`e2e/m3-live.spec.ts`, 14 tests)

1. Director fills the joining wizard and sends it for approval (no employee, no email yet).
2. Director sees the request but cannot approve; the CEO approves in the screen; the Emp-ID is created; the Mailpit email arrives.
3. The new employee signs in with the temporary password and must choose their own.
4. The employee edits their own phone, address and emergency contact; the old value is in History.
5. The employee uploads a CV (a fake PDF is refused with a visible message), downloads it (same bytes), sets a photo; a colleague sees the photo and only the Basic tab.
6. The Director sees pay with no amount in the page, reveals it after confirming again (logged); HR has no Pay tab.
7. The Director edits a designation; History shows old and new.
8. **Confirm-again:** wrong password refused, right password with arbitrary digits refused, the dialog stays open and shows nothing, the server refuses a reveal from that session, the right password and real code work; failures and success are in the audit log.
9. **Pay edit form** (see R1).
10. **Job edit form** (see R2).
11. **Document archiving** (see R3).
12. The Director resets the authenticator in the dialog (reason required); the person is signed out and must enrol again; a colleague is refused.
13. HR sets today as the last working day (still on notice, can still sign in); the Director sets yesterday for Finance; the unresolved-reports panel lists the Finance team, nothing is moved, the Director cannot reassign, the CEO can.
14. A last working day of today is still on notice.

## Known gaps and honest limits

1. The confirm-again dialog is a shared screen. In live mode (`m2` live) it now always asks the server. In mock mode (modules
   that are still mock) it still accepts any 6 digits, as before; those modules have no server yet.
2. The plan's other confirm-again actions (approving payroll, large entries, reopening a month, exporting statements) belong to
   later modules and do not exist yet.
3. Owner and CEO can hire directly through the API, but the **wizard screen only opens for people with the Director/HR permission**;
   Owner/CEO approve requests in the People screen instead.
4. The People list in live mode shows joining date and type from the old demo roster when the person is in it, otherwise
   neutral defaults; each profile shows the real values to those allowed to see the Job section. "Who is online" dots are empty live.
5. The server stores one allowances total; the screen shows it as one line. The document kind "Other" is refused live.
6. Files are stored in a private folder on this computer and streamed through the API (no expiring links yet).
7. Reassigning a manager through the Job form lists only the people the screen's older "fixed structure" rule allows (for a
   Level 5 person: Level 3 people). The server accepts any valid line under the Module 1 rules; the screen is narrower.
8. **Separate outstanding items, not part of M3:**
   - **Redis hierarchy caching (M1-11) is not implemented** (the hierarchy cache is PostgreSQL only).
   - **GitHub Actions has never run** (the workflow is written but unverified).

## Intermittent failures: what I found

* **Browser: login redirecting back to /login.** Root cause fixed earlier (a page load cancelled by a fast navigation cleared
  the login on screen). It did not recur in the final runs.
* **Browser: one M2 test waited for a page load that a redirect cancelled** ("My devices"). A test-synchronisation race, not
  a product fault; the check now polls the URL. I also had two overlapping launches of the browser suite once, which made the
  second fail to start ("another next build is already running"); I stopped the stray run and ran one clean suite.
* **Backend: three files failing to load in one `npm test` run.** Not reproduced in the many full runs since (all passing).
  Cause unknown. If it happens again, the `FAIL ... [file]` lines show the load error.
* The test errors seen this round that were in my tests, not the product: clicking the dialog's close (X) instead of Confirm,
  locators matching two elements, and an assertion that ignored a second person from the demo roster.
