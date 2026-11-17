# Modules 7, 8 and 9: discrepancies, development defaults and decisions still needed

The official development plan is the source of truth. Where `spec.md`, the permission catalogue or earlier code disagreed with it,
the plan was followed and the difference is recorded here. Values marked **development default** are not company policy: they make
the system usable and testable until management or the accountant give the real values. All of them are data (settings rows), not code.

## 1. Discrepancies resolved in favour of the plan

| # | Topic | Plan says | Was (catalogue / spec / frontend) | Now |
|---|---|---|---|---|
| P1 | Payroll approval (s.12) | Finance prepares, the Director reviews, the **CEO approves** with password and 2FA again; the preparer never approves | Director had `payroll.approve`; CEO and Owner had none; spec 2.3 and `payroll/logic.ts` said "approved by the Director" | CEO has `payroll.approve`; Director keeps `payroll.review`, loses `payroll.approve` (migration + catalogue + frontend map) |
| P2 | Journal entry approval (s.13) | A different person approves at the level the amount needs (example: Director up to 50,000, CEO up to 500,000, Owner above and all share capital and loan entries); if the approver made it, one level up | Only the Director had `finance.entry_approve`; spec: "Director approves any amount" | Tiers in `approval_limits` (plan's example values as development defaults); CEO and Owner have `finance.entry_approve`; capital and loan accounts are flagged `requires_owner_approval` |
| P3 | Month close (s.13) | Finance duty runs the close, the **CEO approves**; only the **Owner or CEO** reopen, with a reason, logged and alerted | Director had `finance.close` and `finance.reopen`; spec: Director approves and reopens | New permission `finance.close_approve` (CEO); `finance.reopen` for Owner and CEO; Director loses `finance.close` and `finance.reopen` |
| P4 | Leave approval (s.11) | Team lead, then the Director; approvals move up one level at a time | Level-4 role had no `leave.approve` / `attendance.approve_correction` / `attendance.view_team`; the Owner had no `leave.approve` (the Director's own leave could never be approved, as the demo has no CEO) | Level-4 default role and the Owner get those permissions; the server routes through the real reporting chain (Module 1) |
| P5 | Finance links (s.16) | "For anyone else ... direct links return not found" | The guard answered 403 | Routes marked `@FinanceScreen()` answer 404 to a refused permission or scope (still audited) |
| P6 | Holiday calendar (s.9, s.11, s.17) | Listed under M5, M7 and M12 | Mock data only | One `holidays` table owned by M7; M5, M8 and M12 read it |
| P7 | Payroll ledger entry (s.12 vs s.13) | s.12: "the approved payroll is posted to the ledger"; s.13: entries the system creates from payroll "start as a Draft" and go to Pending approval | (not built) | The salary entry is created on payroll approval and **waits for normal ledger approval** (the stricter reading; no rule is bypassed). **Needs confirmation (D5)** |

The changes to role permissions are applied to existing databases by migration `20261112190000_m7_m9_foundation` (with an audit-log
row) and to new databases by `backend/prisma/permission-catalogue.ts`.

## 2. Development defaults in use (`backend/prisma/seed-cycle3.ts`; development and test databases only)

| Setting | Development default | Who decides |
|---|---|---|
| Working hours | 09:00 to 18:00, Monday to Friday | Management (settings) |
| Grace period | 15 minutes (the plan's own example) | Management |
| Office-only check-in | Off; no office networks configured | Management (spec open question 2) |
| Leave types and yearly days | Casual 10, Sick 8, Annual 14, Unpaid (no limit, unpaid) | Management |
| Leave year | Calendar year | Management |
| Approval limits | Director up to PKR 5,000,000; Owner above and all capital and loan entries; no CEO tier (decision D25, replacing the plan's example table) | The Owner (D22) |
| "Large entry" needing confirm-again | Above PKR 50,000 | Management |
| Finance year | Starts in July (Pakistan's normal tax year, plan s.14) | Accountant |
| Chart of accounts | A development chart in the five groups with system roles (salary expense, salary payable, tax payable, payroll deductions, employee advances, receivable, payable, FX gain/loss) | **Accountant (blocking for real data)** |
| Tax slabs | **None seeded**; payroll refuses to calculate without a slab version | **Accountant** |

## 3. Decisions still needed (implementation continues around them)

| # | Decision | Current behaviour until decided |
|---|---|---|
| D5 | Does the payroll salary entry need a second (ledger) approval after the CEO's payroll approval, and who approves it when the total is above the CEO limit? | It waits in Pending approval and follows the tiers (P7) |
| D6 | Do absences without leave, late arrivals or missed check-outs affect pay? | No: the plan deducts only unpaid leave; the other facts are shown on the payroll line for information |
| D8 | Leave policy details: carry-over, pro-rata for joiners, negative balances, cancelling approved leave, leave spanning two leave years | No carry-over or pro-rata; a request cannot exceed the remaining balance; a request must stay inside one leave year |
| D9 | Tax: which pay is taxable, and the monthly method | Taxable = base + allowances + bonus − unpaid leave; monthly tax = yearly tax on (monthly taxable × 12) ÷ 12, rounded to paisa |
| D10 | Salary structure: one allowances total (M3) or itemised allowances; who approves salary advances; maximum advance | `employee_pay` (M3) stays the only source of base and allowances; an advance is paid through a ledger entry that needs normal approval |
| D11 | Pro-rata pay for people joining or leaving during the month; what a final settlement contains | No pro-rata; the line is flagged for review; final settlement = the leaver's normal line in the month of their last working day, flagged |
| D12 | The accountant's chart of accounts and which accounts the system roles map to | Development chart (above) |
| D13 | Invoices: Module 9 vs Module 13 split, numbering, Aceva's details on the invoice, sales tax | M9 stores invoices (`INV-YYYY-NNNN`) with lines and a ledger entry; no tax lines; M13 adds recurring billing later |
| D14 | Projects for tagging | A small `finance_projects` list owned by M9 until a projects module exists |
| D15 | PDF and Excel libraries (payslip PDF, invoice PDF, Excel bank sheet) | No new dependency added: payslips and invoices are served as printable HTML documents; the bank transfer sheet is CSV |
| D16 | Notifications before Module 12 | Outbox events only (leave asked/answered, payroll ready, payslip available, period reopened); nothing is emailed yet |
| D17 | Tamper-proof hash chain for finance logs (s.16) | Not built in this cycle (finance history tables are insert-only by trigger) |
| D18 | Payroll screens on the 10-minute finance idle limit | Yes for payroll management routes; own payslips use the normal limit |
| D20 | Source of USD exchange rates; revaluation accounts | Rates are entered by the finance duty person per day; gain or loss goes to the `fx_gain_loss` account |

## 4. Rules chosen during implementation (development defaults; confirm or change)

These follow the plan where it is explicit. Where it is silent, the most cautious reading was taken. Each one is a
setting or a single place in the code.

**Module 7 (attendance and leave)**

| Topic | Current rule |
|---|---|
| Nobody above (the Owner) | The Owner's own leave is recorded as approved at once, without a decision row, and audited as `leave.recorded_without_approver`. An attendance correction from the Owner is refused (`no_approver`) |
| Cancelling approved leave | Only the requester, and only before its first day (D8) |
| Past dates | Leave may start no earlier than the 1st of the current month, and never touch a locked month |
| Balance | Calendar leave year; remaining = entitlement - approved - pending; a request stays inside one year |
| Absent | Only working days before today without check-in or approved leave. A check-in on a weekend or holiday is shown but does not count as present |
| Missed check-out | Closed by the job at the end of hours (or 23:59 for a check-in after hours); a missed check-out later fixed by an approved correction is no longer counted |
| Entitlements | Set only for people below the setter, never for oneself |
| Holidays and schedules | Adding or archiving a holiday in a locked month is refused; a new schedule starts today or later, one per start day |
| Routed approver without the permission | If the manager in the reporting line lacks `leave.approve` (for example a manager with the sales role), the request waits; nothing skips upward automatically |

**Module 8 (payroll)**

| Topic | Current rule |
|---|---|
| Tax (D9) | Taxable = gross; monthly tax = yearly tax on (monthly taxable x 12) / 12, rounded only at the monthly step |
| Unpaid deduction | base x unpaid days / working days, rounded to paisa once |
| Tax slab version | The latest version effective on or before the month's last day; the list must end with an open slab |
| When a run can start | For the current month or earlier; calculation does not wait for the last working day |
| Advances (D10) | Paid through a ledger entry that needs normal approval and is dated the day it is created; deducted only after that entry is posted; who approves an advance beyond that, and the maximum, are undecided |
| Bank sheet | Uses the bank details on file when it is downloaded (not a snapshot taken at approval) |
| Sending a run back | The reviewer or the approver, from prepared or reviewed, with a reason |
| Payroll vs ledger confirm-again | The CEO confirms again to approve the run; posting the salary entry above the confirm-again amount asks again in Module 9 (two separate decisions, see D5) |
| Final settlement arriving late | A settlement event that arrives after its month's run is approved is recorded but not settled by any run (needs a rule, D11) |

**Module 9 (finance ledger)**

| Topic | Current rule |
|---|---|
| Chart of accounts changes | `finance.entry_create`; the accountant owns the real chart (D12) |
| Revaluation rate | The rate given, else the latest saved rate in the month. "No USD balances" means both the USD and PKR balances are zero |
| Checklist "bank reconciled" | Done when no statement was imported for the month (the detail text says so) |
| Checklist "payroll posted" | Needs a posted payroll entry dated in that month |
| Aging | Days since the issue date |
| Currency | A PKR entry may not touch a USD account (except system revaluations and reversals); a payment's currency must equal the invoice or bill currency; a cross-currency transfer is a USD entry at the effective rate |
| Drafts | Only the maker edits or submits their own draft |
| Statement CSV | Dates YYYY-MM-DD only; at most 5,000 rows and 2 MB |
| Close approval | The checklist is checked again; no confirm-again (the plan does not list it) |
| Reversals | One live reversal per entry; a rejected reversal does not block a new one (migration `20261112230000_m7_m9_integration_rules`) |

## 5. Known gaps after this cycle

- Payslips and invoices are printable HTML, not PDF; the bank sheet is CSV, not Excel (D15).
- Invoice header: "Aceva" with a "to be confirmed" note (D13). No foreign-exchange difference is posted when a USD invoice
  or bill is paid at a different rate; only USD bank accounts are revalued.
- The frontend approval inbox interface is synchronous, so the live attendance, payroll and ledger inboxes keep a small
  cache refreshed in the background (an async inbox interface is a recommended follow-up).
- Stale calculation is not detected: if pay data changes after a run is calculated, Finance must recalculate (approval
  refuses only when advances changed: `409 advances_changed`).
- Not built: the hash chain for finance logs (D17), the Module 10 statement snapshot at close, the Module 5 deadline
  clash warnings on leave.
- Mock mode (frontend without the backend) still has no CEO persona, so a mock payroll run stops at "reviewed", and mock
  journal approvals follow the old Director-only rule. Live mode follows the server.

## 6. Security review fixes (integration stage)

An independent review of the M7 to M9 backend found no IDOR, XSS or data leak. The rule gaps it found are fixed:

| Finding | Fix |
|---|---|
| The Finance person could remove the "Owner approves" flag from a capital or loan account, or create an equity account without it | Equity accounts created through the API carry the flag by default; only the Owner may create one without it or remove the flag (`403 owner_only`); approval checks the flag again, so an account flagged after an entry was submitted still needs the Owner. In the development chart, 3100 Share capital, 3200 Owner capital and 2500 Loans carry the flag; **3300 Retained earnings does not** (it holds accumulated profit, not share capital or a loan; plan s.13 names only share capital and loan entries). The accountant confirms this with the real chart (D12) |
| One person with `settings.manage` could give level 3 unlimited approval or raise the confirm-again amount without confirming | The unlimited tier must be the Owner (level 1); changing approval limits or finance settings needs "confirm again" |
| A direct database write could unlock a payroll month, reopen or close a finance month, post an entry without an approver or skip "pending approval", or move a draft out of a closed month | Database rules in migration `20261112230000_m7_m9_integration_rules`: payroll month locks are never changed or removed; a month closes or reopens only with the matching workflow event in the same transaction; entries start as drafts and follow draft, then pending approval, then posted or rejected; a posted entry always has an approver; the old date of a moved draft is checked too |
| The payroll reviewer could also be the approver if one person held both permissions | Refused by the service (`403 maker_checker`) and by a database CHECK |
| Two runs approved at the same moment could both take the same advance balance | The advance rows are locked inside the approval transaction |
| Changing a leave type from paid to unpaid would silently change locked months | Refused once leave of that type exists (`409 leave_type_in_use`): archive it and add a new type |
| A new entry could be made while a month waits for its close approval and be stranded | Refused while the month is closing (`409 period_closing`) |

Kept as a documented development default: the Owner's own leave is recorded without an approver (nobody is above the Owner).

## 7. New decision needed

| # | Decision | Current behaviour until decided |
|---|---|---|
| D22 | Who changes approval limits, finance settings and the "Owner approves" account flag? | **Resolved (Owner only).** See section 8 |
| D23 | Who approves attendance corrections, and does the CEO see attendance and leave? | **Resolved (management decision, 17 Nov 2026).** See section 9 |
| D24 | Who approves leave while the company has no managers or team leads? | **Resolved (management decision, 17 Nov 2026).** See section 10 |
| D25 | Who approves payroll, journal entries, the month close and hire requests, now that the CEO only views? | **Resolved (management decision, 17 Nov 2026).** See section 11 |

## 8. Decision D22 implemented: the Owner holds finance authority

| Rule | Where it is enforced |
|---|---|
| Only the Owner changes approval limits and finance-wide security settings (the confirm-again amount, the finance year) | Permission `finance.authority_manage` (Owner role only; migration `20261113100000_m9_owner_authority` and the catalogue), checked again in the service (`403 owner_only`), with server-checked "confirm again". The Director no longer reaches these changes (404), so they cannot raise their own limit |
| Unlimited approval always belongs to the Owner | Service validation, a database CHECK (`max_amount IS NULL` exactly for level 1) and a trigger that never lets the Owner tier be deleted |
| Only the Owner removes the "Owner approves" rule | `PUT /accounts/:id/owner-approval` (Owner only, confirm again, logged). `PATCH /accounts/:id` can add the rule but never remove it. The database accepts a removal only with an audit row `finance.account.owner_approval_removed` for that account, made by a level-1 employee, in the same transaction |
| A sub-account of an account that needs Owner approval (for example under 2500 Loans) needs it too | Service (`409 owner_approval_inherited`) and database (insert and update refused; flagging an account flags its sub-accounts at any depth; the parent row is locked while a sub-account is checked, so a sub-account created at the same moment cannot slip through). The migration also flags any existing sub-account of a flagged account (it only adds the rule). Removing it from a sub-account is refused while the parent needs it |

Limits of the database rule: a person with direct write access to the database could still forge an Owner audit row. That
access is outside the application (it is the database administrator's) and the audit log itself is insert-only.
The Owner has no screen yet for the Owner-approval rule on accounts (the API route exists); the approval-limits settings
page is editable by the Owner only.

## 9. Decision D23 implemented: the Director approves attendance corrections; the CEO sees attendance and leave

Management changed plan section 11 ("corrections go to the manager"): corrections now go to the Director, like the final step of leave.

| Rule | Where it is enforced |
|---|---|
| A correction of anyone below the Director is decided by the Director, whatever their own manager (the CTO, a team lead). The manager sees it in the team list, view only | `RoutingHelper.directorRoute` (Module 1 route from the seat just below the Director), used when the request is made, listed and decided (`403 not_routed_approver` for anyone else) |
| While the Director is away, the Director's stand-in decides; away without a stand-in, it moves up to the CEO | Module 1 routing (`ApprovalsService.route`), the same as step 2 of leave |
| The Director's own correction goes to the CEO; the CEO's goes to the Owner; nobody decides their own | Unchanged Module 1 routing for people not below the Director |
| With no active Director, corrections go to the person's routed manager again | `correctionRoute` falls back to the plain route |
| Leave: see decision D24 (section 10), the same single Director step | `LeaveService.plan` |
| The CEO sees, from their own account, everyone below them (the Director and the whole company under the Director): who is in or late today, each month's attendance, the leave calendar (who is on leave and when), leave requests and balances, and team corrections (view only). The CEO keeps approving only the Director's own leave and corrections, and anything that moves up to them | Existing permissions (`attendance.view_team`, `leave.approve`, `attendance.approve_correction`) and the reporting-line scope; no permission or schema change. Covered by `m7-corrections.test.ts` and `m7-leave.test.ts` |

No migration: this is routing logic only. The frontend mock (`correctionApprover`) follows the same rule; it does not model stand-ins.

## 10. Decision D24 implemented: the Director approves all leave directly

Management: "For now we do not have any manager, so the Director approves leave", the CTO's team included. This replaces
plan section 11 ("team lead, then the Director") and row P4: leave is one step, decided by the same person as an
attendance correction (D23).

| Rule | Where it is enforced |
|---|---|
| Leave of anyone below the Director (Development under the CTO, the CTO, Sales, Finance) is decided by the Director in one step. Their own manager sees it, view only | `LeaveService.plan` uses `RoutingHelper.directorRoute`; `needsDirector` is always false, so nothing is forwarded (`leave.forwarded` is no longer written; `leave.decided` keeps its fields, with `nextApproverEmpId: null`) |
| While the Director is away, the Director's stand-in decides; away without a stand-in, it moves up to the CEO | Module 1 routing |
| The Director's own leave goes to the CEO; the CEO's goes to the Owner; the Owner's is recorded without an approver (unchanged development default) | Module 1 routing for people not below the Director |
| A request made before D24 that already passed step 1 (`pending_director`) is decided by the Director as step 2 | `LeaveService.currentStep` |
| The CEO keeps seeing all leave (calendar, requests, balances) and approves only the Director's own | Unchanged permissions and scope (D23) |

No schema, permission or contract change and no migration: `pending_director` and the `forwarded` event value stay in the
schema for requests made before D24. To bring a manager step back later (when team leads exist), `LeaveService.plan` would
route step 1 to the manager again; that is a code change, not a setting.

## 11. Decision D25 implemented: the Director approves everything; the CEO only views

Management: "Any kind of approval should be accepted by the approval of the Director. The CEO can just view the
activities." The CEO still signs off what the Director asked for themselves, since nobody approves their own request.
This replaces plan section 12 ("the Director reviews, the CEO approves" payroll, decision P1), the CEO's part of
section 13 (month close, reopening, the CEO approval tier) and decision M3-3 ("the Owner or CEO authorize a hire").

| Rule | Where it is enforced |
|---|---|
| Payroll: Finance prepares, the Director approves in one step, with "confirm again". Nobody holds `payroll.review`; the preparer never approves. A run reviewed before D25 is approved by someone other than its reviewer (database rule) or sent back | `PayrollRunsService.approve` (from `prepared`, or `reviewed`); role permissions |
| Journal entries: the Director approves up to PKR 5,000,000 (default; the Owner sets it), the Owner above that and every capital or loan entry. No CEO tier. An entry the Director made goes one level up to the CEO, the only entries the CEO approves. Unlimited approval stays with the Owner (security review, finding 2) | `approval_limits` (seed, migration); `levelCovers`: exactly the required level or the Owner; the "waiting for me" list uses the same rule |
| Month close: the finance duty person runs it, the Director approves or sends it back. A closed month is reopened by the Director or the Owner, with "confirm again" | `finance.close_approve`, `finance.reopen` moved from the CEO to the Director |
| Hire requests: the Director decides (new permission `people.approve_hire`); a request the Director made is decided by the CEO; the Owner may decide any; nobody decides their own; the Director never places a hire at Level 3 or above | `JoiningService.assertMayDecide` |
| Leave and attendance corrections: unchanged from D23 and D24 (the Director; the Director's own go to the CEO) | `RoutingHelper.directorRoute` |
| Not approvals, so unchanged: the CEO and the Owner still hire directly and change levels and reporting lines (`org.manage`), manage stand-ins, unlock accounts, sign people out and reset authenticators | Role permissions |

Migration `20261117090000_d25_director_approves` is data only (no table, constraint or trigger change): it adds the
permission, moves the role permissions, and replaces the approval limits only while they are still the plan's example
values (an Owner-set value is never overwritten); entries waiting at the old CEO tier move to the Director unless the
Director made them. On aceva_dev it moves the role permissions only (it has no limits, entries, runs or hire requests
yet). The payroll stage `reviewed` and the `/review` endpoint stay for runs reviewed before D25.
