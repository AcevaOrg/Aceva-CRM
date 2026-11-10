# Module 3 acceptance checklist (plan section 7)

Statuses: **Done and tested** = a test I ran passes. **Partial** = built, with a stated gap. **Open** = not done.
Backend tests are in `backend/test/m3-*.test.ts` and `backend/test/m2-reset-2fa.test.ts`; browser tests are in
`e2e/m3-live.spec.ts`. They need PostgreSQL and Redis; the browser tests also need Mailpit.

## Profiles (plan: five sections, who sees what)

| # | Requirement | Status | Verified by |
|---|---|---|---|
| P1 | Basic (name, photo, Emp-ID, designation, department, office, official email) visible to everyone | Done and tested (photo upload and view through the API; **no photo upload screen yet**) | `m3-profiles`, `m3-documents` |
| P2 | Job (level, reports to, joining date, type, status) visible to the employee and the levels above | Done and tested (also visible to Director/HR) | `m3-profiles` (matrix by role), e2e |
| P3 | Personal (CNIC, phone, address, emergency contact) visible to the employee, HR, Director and above | Done and tested | `m3-profiles`, e2e |
| P4 | Pay visible to the employee (own only), Director, CEO, Owner, finance duty person | Done and tested | `m3-profiles` (HR, CTO, peers never see it) |
| P5 | Documents (CV, contract, CNIC copy, certificates) in private storage; visible to the employee, HR, Director and above | Done and tested (local private folder; AWS S3/R2 plug in behind `FileStorage` later and are **not tested**) | `m3-documents` |
| P6 | CNIC and bank account encrypted at rest, masked in screens, revealing is logged | Done and tested | `m3-profiles` (reveal audited, value never logged; ciphertext in tables) |

## Changes

| # | Requirement | Status | Verified by |
|---|---|---|---|
| C1 | The employee updates phone, address, emergency contact only | Done and tested on the server (sent directly, not only through forms) | `m3-profiles` |
| C2 | Director or HR change job fields | Done and tested. Rule I applied: only for people of strictly lower rank or below them in the line, never themselves. **Level and reporting line stay Owner/CEO only** (Module 1 rule), even from the job form | `m3-profiles` |
| C3 | Only the Director changes pay | Done and tested (HR, CEO, Finance and the Director's own pay refused) | `m3-profiles` |
| C4 | Every change keeps the old value (who, when, old, new, reason) | Done and tested; sensitive old/new values are stored encrypted and shown masked | `m3-profiles`, e2e (history screen) |
| C5 | Rules enforced on the server | Done and tested | `m3-profiles` (every refusal), e2e (forbidden direct calls) |

## Joining

| # | Requirement | Status | Verified by |
|---|---|---|---|
| J1 | Director/HR fills the profile; the system generates the Emp-ID | Done and tested (database sequence; 6 simultaneous hires; never reused). Rule I applied: Director/HR hire at Levels 4-5 only | `m3-joining` |
| J2 | Welcome email with a temporary password to the official email | Done and tested (Mailpit in the browser test). If the mail fails the employee is still created, the failure is audited and a resend is available | `m3-joining`, e2e |
| J3 | Must change the password at first login (Module 2) | Done and tested end to end | `m3-joining`, e2e |
| J4 | Pay only if the Director enters it; other hires get `payPending` | Done and tested | `m3-joining` |

## Leaving

| # | Requirement | Status | Verified by |
|---|---|---|---|
| L1 | HR/Director set the last working day | Done and tested (also move and cancel) | `m3-leaving` |
| L2 | On that date: disable login, end all sessions | Done and tested (immediate and scheduled, with a movable clock) | `m3-leaving`, e2e |
| L3 | Never delete the record | Done and tested | `m3-leaving` |
| L4 | Scheduled job with retries and failure handling (decision D4) | Done and tested: PostgreSQL job table, one run when several servers tick, backoff, `failed` after 5 attempts with the error kept, stale-lock recovery | `m3-leaving` |
| L5 | Transfer open tasks to the manager | **Open (by design)**: only the versioned event `task.transfer.requested` is written to the outbox. Module 5 does not exist, so nothing moves tasks | `m3-leaving` (event written and valid) |
| L6 | Send final salary to payroll | **Open (by design)**: only `payroll.final_settlement.requested` is written. Module 8 does not exist | `m3-leaving` |
| L7 | Also done on the day | Duties and stand-in cover end; a head of department is cleared; the leaver is removed from the directory | `m3-leaving` |

## Lost authenticator (2FA reset)

Done and tested, see `docs/M2-ACCEPTANCE.md` row K and `m2-reset-2fa`.

## Known gaps and decisions for you

1. **Timing of "on that date".** The job runs at 00:00 Pakistan time at the START of the last working day, so access ends
   when that day begins. If you want access to end at the END of the last working day, it is a one-line change. Please decide.
2. **Direct reports of a leaver** are not moved automatically (the plan does not say who they report to). The response and
   the audit entry list them; the Owner or CEO moves them with the Module 1 screens. One test of this is skipped when the
   demo roster has no suitable manager, so the listing itself is only lightly tested.
3. **Browser coverage.** Browser-tested: first login with the emailed temporary password, who sees which tabs, history
   old/new values, leaving through the dialog. **Not browser-tested**: the joining wizard (the hire is created through the
   API in the test), the edit forms, document upload/download buttons, the 2FA reset dialog, the photo. They typecheck and
   their API is tested, but I have not clicked through them.
4. **Not built in the screens:** photo upload, archive document, cancel leaving date, "Other" document kind (rejected live),
   live "who is online" dots (empty in live mode).
5. **Salary:** the amount is sent to anyone allowed to see Pay; the "show" button logs a reveal but does not withhold it.
6. **Allowances:** the server keeps one allowances total; the screen shows it as one line.
7. **Live directory defaults:** in live mode the list shows joining date/type from the old mock roster when the person
   is in it, otherwise neutral defaults; the profile always shows the real values to people allowed to see the Job section.
8. **Files** are stored in a private folder on this computer (`FILE_STORAGE_ROOT`). They are streamed through the API (no
   public URL, no expiring links yet).
9. Still outstanding from before: Redis hierarchy cache (M1-11), GitHub Actions never run, the one-off M2 browser login
   failure, the one-off `npm test` run where three files failed to load (not reproduced).
