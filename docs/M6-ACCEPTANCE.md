# Module 6 acceptance checklist (plan section 10)

Final company structure: Level 1 CEO / Founder / Owner (one person, sees everything, view only), Level 2 Director (the
only approver, also HR and sales-manager duty), Level 3 CTO (runs the developers and SQA), Level 4 Sales and Finance,
Level 5 Developer / SQA.

**Status: BUILT, NOT YET ACCEPTED.** Everything below is uncommitted work on branch `cycle2-m4-m6` (on top of the
uncommitted Modules 4 and 5), waiting for the project owner's check by hand ("How to check M6 by hand" at the end). All
checks that can run on a computer ran and pass: typecheck, lint, 37 contract tests and every backend test, including all
database tests of Modules 1 to 6 (1100 backend tests; 195 unit tests and 103 database tests are new for this module). The
hand-check scenario below was also run once end to end through the real task workflow (assign, hand in, send back,
approve, release, acknowledge, dispute, new weights, decision) and gave exactly the numbers the steps expect. **Not run
here:** the browser test `e2e/m6-live.spec.ts` (it needs a production build of the website, which this machine has no room
for) and any click-through of the screens.

Statuses: **Built, unit-tested** = the pure rule tests pass. **Built, DB tested** = a database test in `backend/test`
passes. **Deferred** = not built now, with the module that does it.

## What is built, what is deferred

**Built.** Score weight versions (whole percents, exactly 100, never edited, a new version each time the Director saves,
optional set per department, the two starting sets); monthly scorecards made by a job on the 1st for everybody who is
scored, with a snapshot of the tasks they were made from; the figures worked out by one calculator that the live view, the
monthly job and the dispute recompute all use; the reviewer's remark and release, the employee's acknowledgement and
comment; rating disputes, decided by the level above the rater, with a recompute that uses the weights version the
scorecard was made with; the rule that nobody can change a scorecard's numbers (the service never writes them and a
database trigger refuses it, with one exception: the recompute after a decided dispute); live figures for the current
month with a six-month trend; the team table (by name, never ranked); the approvals inbox items `scorecard` and `dispute`;
six events, audit entries and the mails; stand-ins for attendance and sales that never invent a number. The frontend works
against the server behind `isLive("m6")`.

**Deferred (not part of this module).** Real attendance figures (Module 7, cycle 3) and real sales figures (Module 15):
the scorecard says "not available yet" until then. In-app notifications (Module 12): mail and events for now. A department
picker for the weights on the Settings screen (the server already supports department sets). Re-routing an open dispute
when its decider leaves. Details in "Deferred" below.

## Checking results: the review of each task (plan section 10)

| # | Requirement | Status | Where | Verified by |
|---|---|---|---|---|
| R1 | The employee submits the work on the task page | Built in Module 5 | `POST /tasks/:id/submit` | `m5-core` |
| R2 | The reviewer approves with a rating 1 to 5 and a comment, or sends back with a reason; one of the two is required | Built in Module 5 | `task_reviews` (insert-only; the database refuses an approval without a rating) | `m5-core` |
| R3 | An approved rating goes straight into the employee's figures | Built, DB tested | `PerformanceCalculator` reads the newest approved review of each task; `GET /performance/live` shows it at once | `m6-core` ("live figures": the hand-worked month gives 85, Excellent), `m6-automation` |

## The metrics and the score (plan section 10)

| # | Requirement | Status | Where | Verified by |
|---|---|---|---|---|
| M1 | Quality: average rating weighted by task points, 5 stars = 100 | Built, unit-tested, DB tested | `rules/perf-tasks.ts` `taskMetrics` | `perf-tasks.test` (21), `perf-figures.test`, `m6-core` |
| M2 | On-time: submitted by the approved deadline / submitted. An extension approved before the deadline is not late (the deadline in force counts); an approved extension that was asked for AFTER the deadline (`task_extensions.late`) does not rescue the task: it is judged against the deadline in force when the first such request was made | Built, unit-tested, DB tested | `taskMetrics`; `timelinessDeadline` in `tasks/rules/task-deadlines.ts` (shared with Module 5's `task.approved` `onTime`); the task row keeps the approved deadline and the original | `perf-tasks.test`, `task-deadlines.test`, `m6-automation` ("works the plan's numbers out", June: a late extension keeps a late task late) |
| M3 | Completion: points of approved tasks / points of tasks due in the month | Built, unit-tested, DB tested | `taskMetrics` | `perf-tasks.test`, `m6-core` |
| M4 | Rework: tasks sent back / tasks submitted (lower is better) | Built, unit-tested, DB tested | `taskMetrics` | `perf-tasks.test`, `m6-core` |
| M5 | Attendance (from Module 7) | **Deferred** (stand-in) | `attendance-source.ts`: `AttendanceSource`, stand-in `NotBuiltAttendanceSource` answers "not available" | `auto-sources.test`, `m6-automation` ("never invented", "a real source plugs in") |
| M6 | Workload: open task hours now, information only, not scored | Built, DB tested | `PerformanceCalculator` (standard scorecards only) | `m6-core` ("live figures": 8 h) |
| M7 | Score = 0.35 Q + 0.25 T + 0.20 C + 0.10 (100 - R) + 0.10 A with the version's weights; Excellent 85+, Good 70 to 84, Needs improvement 50 to 69, Poor below 50 | Built, unit-tested | `rules/perf-score.ts` (`computeScore`, `roundScore`, `bandOf`, the edges 85, 70, 50). The score is one sum of metric x whole-percent weight, divided once and rounded half up once (`roundScore`), so an exact tie (44.95, 83.35) always goes up. The frontend's `logic.ts` works it out the same way (same whole percents, same rounding), and the unit tests copy its outputs for the same fixtures, check the exact ties and compare 20,000 random sets with an exact integer calculation | `perf-score.test` (40) |
| M8 | Small sample note under 5 tasks | Built, unit-tested | `SMALL_SAMPLE = 5` in `perf-score.ts`; `smallSample` on every scorecard and live view | `perf-score.test`, `m6-core` |
| M9 | Cancelled tasks do not count; they are listed on the scorecard, marked "not counted" | Built, unit-tested, DB tested | `countsForMetrics` in `perf-tasks.ts`; `scorecard_tasks.counted` | `perf-tasks.test`, `m6-automation` |

## Monthly scorecard (plan section 10)

| # | Requirement | Status | Where | Verified by |
|---|---|---|---|---|
| S1 | On the 1st of the month a job creates a draft scorecard for each employee for the month before, with the weights version in force for their kind and department | Built, DB tested | `scorecard-monthly.service.ts`: job `scorecard.monthly`, key `scorecard.monthly:<month>`, 00:10 Pakistan time on the 1st; made sure on start-up and every hour (catches up after downtime) | `m6-automation` (scheduling, the October run, the November run with department sets) |
| S2 | Idempotent: a re-run, a retry or two servers never duplicate or overwrite | Built, DB tested | One scorecard per person and month (unique key); the run skips whoever has one | `m6-automation` ("running a month again never duplicates", two runs at the same moment) |
| S3 | The Director's scorecard is released straight away | Built, DB tested | No reviewer (the Owner reviews nothing), so the job creates it released by the system and emits `scorecard.released` with `automatic: true` | `m6-automation`, `m6-core` |
| S4 | The reviewer is mailed that drafts are waiting | Built, DB tested | One mail per reviewer per run, linking to the approvals inbox (best effort: a mail error never fails the job) | `m6-automation` (mails), `auto-mail.test` |
| S5 | The next level up reviews it and can add a remark; they cannot change the numbers | Built, DB tested | `POST /scorecards/:id/remark`, `POST /scorecards/:id/release` (only the reviewer); the numbers are frozen in the service and by the trigger `scorecards_protect` (see "The rule for the numbers") | `m6-core` (remarks, release), `m6-foundation` ("THE NUMBERS NEVER CHANGE", 11 tests) |
| S6 | The scorecard is released to the employee, who can acknowledge it with a comment | Built, DB tested | `POST /scorecards/:id/acknowledge`; the employee never sees a draft | `m6-core` |
| S7 | A task rating can be disputed; the dispute goes to the next level for a decision | Built, DB tested | `POST /disputes`, `POST /disputes/:id/decide`; decider = the nearest person above the one who gave the rating who reviews work and is not the employee (the Director for a rating the Director gave) | `m6-core` (disputes, 9 tests), `m6-foundation` |
| S8 | A decision keeps or changes the rating; a change recomputes that scorecard with the weights it was created with; the old rating is kept; audited | Built, DB tested | `disputes.service.ts` `decide`, one transaction: dispute first, then the scorecard (numbers and `recompute_count + 1`), then a new approved task review. The decided dispute is the rating-change history (old and new rating, who, why, score before and after) | `m6-core` ("CHANGED ...": 80.0 Good to 85.0 Excellent; a scorecard made with v1 recomputes with v1: 84.4 to 96.1, while the current set would give 95.6) |
| S9 | The scorecard shows the weights version it was made with | Built, DB tested | `GET /scorecards/:id` returns the version; the screen shows "Standard v1 weights" and the formula | `m6-core` |

## Fairness rules, weights and who sees what

| # | Requirement | Status | Where | Verified by |
|---|---|---|---|---|
| F1 | When the Director changes the weights, old scorecards keep theirs | Built, DB tested | `score_weight_versions` is insert-only; a scorecard holds its `weights_version_id` (frozen by the trigger) | `m6-foundation`, `m6-core` ("a scorecard keeps the version it was made with") |
| F2 | Only the Director saves weights; settings viewers can list them; sum exactly 100; audited | Built, DB tested | `POST /settings/score-weights` (`performance.weights`), `GET /settings/score-weights` (`settings.view`); whole percents, the keys of the kind, 0 to 100, sum 100; audit `settings.score_weights.created` with before and after; event `score_weights.created` | `m6-core` (weights, 9 tests), `perf-score.test` |
| F3 | Each department can have its own set | Built, DB tested (server only) | Optional `departmentId` on a version; the version in force for a person is their department's newest set, else the company-wide newest set | `m6-core`, `m6-automation` |
| F4 | Sales staff are scored with the sales weights (V, M, W, D, A) from Module 15 | **Deferred** (stand-in) | Sales scorecards exist (kind `sales`, sales weights) but have no sales figures and no score until `SalesSource` is real | `auto-sources.test`, `m6-automation`, `m6-core` ("a sales scorecard invents nothing") |
| F5 | Visibility: the employee sees their own (released); a manager sees their reporting line; the CTO sees Development and SQA only; the Director everyone below; the CEO / Founder / Owner everyone, view only | Built, DB tested | `PerformanceDirectory`, `ScopeService`; a scorecard the caller may not see is 404, a person they may not see (`live`) is 403. A scorecard or dispute that exists but that the caller may not see (`GET /scorecards/:id`, remark, release, acknowledge, `POST /disputes` with someone else's scorecard, `POST /disputes/:id/decide`) is 404 and is also recorded as a blocked attempt; a missing id and the employee's own draft are not recorded. Module 5's `loadVisibleTask` does not record these (`docs/M5-ACCEPTANCE.md` decision 5) | `m6-core` (visibility; blocked attempts) |
| F6 | No ranking anywhere: the team table is sorted by name | Built, DB tested | `GET /performance/team` sorts by name (case-insensitive, Emp-ID as tie-break); the screen's "This month" column cannot be sorted | `m6-core` ("sorted by name ... although Mariam has the highest score") |
| F7 | Nobody releases their own scorecard | Built, DB tested | Service check (`own_scorecard`) and a database CHECK | `m6-core`, `m6-foundation` |

## Live figures, screens and approvals

| # | Requirement | Status | Endpoint | Verified by |
|---|---|---|---|---|
| L1 | Current month live figures, same rules, last 6 closed months plus this month as the trend | Built, DB tested | `GET /performance/live?empId=` | `m6-core` (live, 3 tests) |
| L2 | My performance, Team, Review queue, Scorecard page, Disputes | Built (screens on the server behind `isLive("m6")`) | `GET /scorecards?empId=&latest=&month=&limit=`, `GET /scorecards/:id`, `GET /performance/team`, `GET /disputes` | `m6-core`; `e2e/m6-live.spec.ts` written, not run |
| L3 | Approvals inbox: "scorecard" (approve = release, reject = add a remark and keep the draft) and "dispute" (approve = change the rating, reject = keep it) | Built, DB tested | `PerformanceApprovalsProvider` on the shared inbox; ids `scorecard:<id>`, `dispute:<id>`; `GET /approvals`, `GET /approvals/oversight`, `POST /approvals/:id/{approve\|reject}` | `m6-core` (inbox, 5 tests), `performance-approvals.provider.test` |
| L4 | Events and mails: scorecard drafted, released, acknowledged, dispute raised and decided, weights version created; mail the employee on release and the decider on a dispute | Built, DB tested | Six events written in the same transaction as the change (`docs/EVENTS.md`); consumer `performance.mail` | `contracts.test`, `performance-data.test`, `m6-core`, `m6-automation` (mails, mail server down) |

All endpoints answer in the usual error shape. Status codes: `POST /scorecards/:id/{remark|release|acknowledge}` and
`POST /disputes/:id/decide` answer 200; `POST /disputes` and `POST /settings/score-weights` answer 201;
`POST /approvals/:id/{approve|reject}` answer 201. Errors: 400 `weights_sum`, `weights_keys`, `weights_whole`,
`weights_range`, `department_not_found`, `not_rated`, `no_decider`, `decision_required`, `rating_required`,
`rating_unchanged`, `reason_required`; 403 `forbidden`, `not_reviewer`, `own_scorecard`, `not_owner`, `not_decider`,
`own_dispute`; 404 `not_found`; 409 `invalid_state`, `already_disputed`, `already_decided`, `version_conflict`.

## Who can do what

| Who | Can | Verified by |
|---|---|---|
| Employee (developer, SQA, Sales, Finance) | See their own live figures and released scorecards (never a draft); acknowledge; dispute a rated task of a released scorecard; see their disputes | `m6-core` |
| CTO (L3) | See Development and SQA (drafts too); remark and release their scorecards; see the team table of his line; decide a dispute only when he is the decider; view the weights. Never Sales or Finance | `m6-core` |
| Director (L2) | See everyone below; remark and release the CTO's, Sales' and Finance's scorecards; decide disputes of ratings the CTO or he gave; the only one who saves weights | `m6-core` |
| CEO / Founder / Owner (L1) | See everything, view only: no remark, no release, no decision, no weights. Not scored himself | `m6-core` ("the Owner sees everyone, view only", the inbox) |
| Nobody | Change the numbers of a scorecard (except the recompute after a decided dispute), edit or delete a weights version, a scorecard, a remark or a decided dispute | `m6-foundation`, `m6-core` |

## The rule for the numbers (decision D6, documented as asked)

Nobody types a score in and nobody edits one. It is enforced twice. The services never write metrics, score, band, the
weights version, the task count or the sales figures. The trigger `scorecards_protect` refuses it even for a direct
database write: it freezes the person, month, kind, weights version, task count, small-sample flag, sales figures,
unmeasured list, reviewer and creation time, and lets the numbers change only together with `recompute_count` rising by
exactly 1, only while the scorecard has more decided `changed` disputes than recomputes, and only to numbers that equal the
`score_after` and `metrics_after` recorded on a changed dispute of that scorecard (migration
`20261118110000_m6_recompute_numbers`). So every change of the numbers is paired with exactly one decided dispute and
matches that dispute's recorded result, and a dispute is applied once. The counter can move only together with numbers equal
to a recorded dispute result (a recompute that moves nothing records the old numbers). In the
decision transaction the order is therefore: lock the scorecard, update the dispute to `changed`, then update the
scorecard. The status only moves forward (draft, released, acknowledged); release and acknowledgement are set once. The
tasks a scorecard was made from (`scorecard_tasks`), the remarks and comments (`scorecard_comments`) and the weights
versions are insert-only; a scorecard and a dispute are never deleted.

## Data stored

New tables: `score_weight_versions`, `scorecards`, `scorecard_tasks`, `scorecard_comments`, `rating_disputes`; six enums.
Migration `20261118100000_m6_performance`: the SQL generated by `prisma migrate diff` plus hand-written parts (the check
function `score_weights_valid`, CHECKs for bands, statuses and own-review, the insert-only triggers, `scorecards_protect`,
the dispute triggers, one open dispute per task, and the two starting weight sets: standard Q35 T25 C20 R10 A10, sales
V20 M25 W30 D10 A15, version 1, no author). Migration `20261118110000_m6_recompute_numbers` replaces `protect_scorecard` so
the recompute must equal the recorded result of a changed dispute. `prisma migrate diff` from the migrations to the schema
shows no difference.
No new permission keys (`performance.view_own`, `performance.view_team`, `performance.view_all`, `performance.weights`,
`task.review`, `settings.view` already existed and match in `frontend/src/lib/auth/permissions.ts` and
`backend/prisma/permission-catalogue.ts`). No new environment variables. Insert-only means the retention question of
Module 4 applies here too: nothing is deleted now and there is no clean-up job.

Audit actions written: `settings.score_weights.created` (target `settings` / `score-weights`, details before, after, kind,
department, version number), `scorecard.drafted` (actor nobody), `scorecard.remark`, `scorecard.released` (also
the system release), `scorecard.acknowledged`: all four use the target `<Emp-ID> <month>` (for example `ACV-0006 2026-10`),
with the scorecard id in the details; the `scorecard.remark` details hold only `{ scorecardId, length }` (the remark text is
in `scorecard_comments`). `scorecard.dispute.raised`, `scorecard.dispute.decided` (target the task number). Module 4's recorder also records the requests ("Performance") without any code here.

## Decisions taken where the plan was open

| # | Decision | Why |
|---|---|---|
| D1 | **Weights are whole percents on the server** (35, 25 ... exact sum 100, insert-only). The Settings screen uses them as they are; the performance screens work in fractions, so their live branch divides by 100 in one place (`frontend/src/features/performance/live.ts`, `percentsToFractions`). A version also carries `label` ("Standard v2"), `versionNo`, `createdBy` (Emp-ID, or none for the two starting sets, shown as "System"), `note`, `effectiveFrom`, optional department. `createdBy` and `note` (the Director's reason) are only in the Settings list (`GET /settings/score-weights`, `settings.view`); the live view and the scorecard detail carry the slimmer `PerformanceWeightsView` without them, so an employee never sees who saved a set or why | The two screens used different units against the same endpoint; whole percents make the sum check exact |
| D2 | **Nothing is invented.** A metric nobody can measure (attendance until Module 7; sales until Module 15; no rated task yet) is empty and named in `unmeasured` with a reason. The score is worked out from the measured metrics only, sharing the missing weights among them (score = sum of points / sum of the measured weights), so nobody gains or loses points for a missing figure; with everything measured it is exactly the plan's formula. Nothing measurable means no score and no band, shown as "No score yet". Sales staff get a sales scorecard every month with no sales numbers and no score. The mock's hash-based fake sales numbers were not copied. A scorecard keeps its numbers for ever, so scorecards made before Module 7 keep "attendance not available" | The brief: never fabricate; the safest stand-in is "not available", not 100 |
| D3 | **Which tasks belong to a month**: the person's own work tasks (never a personal to-do) whose current approved deadline falls in the month, Pakistan time, in exactly one month (no carry-over). A task counts unless cancelled; an open task counts once its deadline passed or it was sent back. On time = last hand-in at or before the deadline in force, except that an approved extension asked for after the deadline (`task_extensions.late`) counts as late: the task is judged against the deadline in force when the first such request was made. A task handed in but not yet reviewed when the monthly job runs (00:10 Pakistan time on the 1st) is stored as `submitted` with no rating: it counts as handed in for On time and Rework and in the points due for Completion, earns no points and no rating, is never updated afterwards, and cannot be disputed (it is not rated). Reviewers should clear the review queue before the 1st | One clear rule; an extension approved in time is not late |
| D4 | **Small sample** = fewer than 5 counted tasks, standard scorecards only | The plan |
| D5 | **Reviewer** = the nearest person above who has not left and holds `task.review`: the manager, or further up when the manager left or does not review work (CTO for Development and SQA; Director for the CTO, Sales and Finance). The Director's manager is the Owner, who reviews nothing, so the Director's scorecard has no reviewer and is released by the system when it is created. The system releases a scorecard only when nobody in the whole line above reviews work (in practice the Director); the screens' `scorecardReviewer` walks up the line the same way. The reviewer shown on a draft is the reviewer now, so a leaver's drafts move up; the stored one is kept as history. **Decider** = the nearest person above the one who gave the rating who reviews work and is not the employee; the Director for a rating the Director gave | Final structure; the screens' `scorecardReviewer` and `disputeDecider` |
| D6 | **The numbers rule** is the one in the section above. There is no separate `rating_changes` table: a decided dispute is the history. A changed rating also adds a new approved task review (the decider as reviewer), so the Module 5 task page shows the new rating and the old reviews stay untouched | "Keep the old one, never overwrite silently" |
| D7 | The recompute uses the weights version the scorecard was made with, never the current one | The plan: old scorecards keep their weights |
| D8 | **Visibility answers**: a scorecard the caller may not see is 404; a person they may not see (live, list) is 403 "You can only see your own results and your team's."; an unknown Emp-ID is 404. The employee's own draft is 404 for get, remark, release, acknowledge and dispute (never told it exists). Acknowledging a scorecard you may see but that is not yours is 403 `not_owner`; `own_scorecard` is reached on one's own released scorecard. People above see drafts, view only | The screens' behaviour; a draft is for the reviewer |
| D9 | **Remarks** are an insert-only history. After release the employee's comment history shows every remark, including those added while it was a draft; `reviewerRemark` is the newest. There is no private note. Releasing with a remark adds it to the history; releasing without one adds nothing | "Add a remark" and "release" are separate acts |
| D10 | **Weights in force**: read by `effectiveFrom`, then version number; a department's own set wins for its people. A department's first set is "Standard v1" of that department and the audit "before" shows the company-wide set it replaces. Saves take an advisory lock per kind and department, so two saves at once get different numbers and the higher number is the newer | Exact and race-free |
| D11 | **The monthly job** runs `ScorecardMonthly.run(month)`: it scores everybody who has not left, has a manager and joined before the month ended (the Owner is not scored; a leaver gets none). One transaction per person: scorecard, task snapshot, audit entry, events. A task handed in but not yet reviewed at that moment is stored as `submitted` with no rating and never updated (see D3 and Known limits 6). One person failing does not stop the others; the run throws at the end so the job runner retries and the retry skips whoever is done. A job that failed all 5 attempts stays `failed` and is logged as an error (nothing else alerts anyone): delete its `scheduled_jobs` row and the hourly check makes it again (for the month that just closed or the current month; for an older month insert a row by hand, see `docs/EVENTS.md`). On start-up and every hour the server makes sure the job of the month that just closed (due now if its moment passed) and of the current month (due on the 1st) exist; older months are never made up. Off when `OUTBOX_DISPATCH_INTERVAL_MS` is 0. `run` accepts the current month (for the hand check) and refuses a month that has not started | Catches up after downtime without making history up |
| D12 | **Mails**: the reviewer's "drafts are waiting" mail is sent directly by the job (one per reviewer per run, best effort, not an event); the release mail (employee), the dispute mail (decider) and the decision mail (employee) go through the outbox consumer `performance.mail`, so a mail server that is down makes the event retry. No mail carries the score | A mail can be forwarded; the screen shows the score |
| D13 | **Disputes**: one open dispute per task; a decided task can be disputed again; only on a released or acknowledged standard scorecard that has a reviewer; the reason needs 10 characters on the server (the screen asks for 20); a decision needs a note, and a change a different rating from 1 to 5 | Plan section 10 |
| D14 | **Approvals inbox**: the items are for people who hold `task.review`. "Reject" on a scorecard means add a remark and keep the draft (the reason is the remark, so it is required, and can be repeated); "approve" on a dispute means change the rating (a rating is required), "reject" keeps it. Inbox decisions without a note use "Rating changed after review." and "Rating kept." | Same words as the mock screens |
| D15 | **Trend** = the last 6 closed months that have a score, then this month live (at most 7 points); the employee's own trend leaves out drafts. `GET /scorecards?latest=1` answers a list of at most one (never a null body) | Matches the screens |
| D16 | **Frontend**: the live branch maps the server's views to the screens' types in `live.ts` (`mapWeights` takes the slim weights of the live view and the scorecard detail as well as the Settings items); metrics, score and band can be empty and the screens say "Not available yet" and "No score yet"; sales staff see "Sales figures arrive with the Sales module"; the Settings editors edit the company-wide set (department sets appear in the history with their department's name); the mock "recent changes" panel is hidden live (the version history is the record) | Small screen changes the live API needs |
| D17 | Switching: the approvals inbox is live when Module 5 or Module 6 is live. The live inbox shows the server's items only for the types of the modules that are live (`task_review` and `extension` for m5, `scorecard` and `dispute` for m6); every other type, including the types of a module that is not live, stays on the demo data. m5 without m6, m6 without m5 and both together are all supported, and m6 without m5 no longer shows the task items twice. Module 6 live still needs Modules 1 to 3 live | Avoids duplicates and keeps each module switchable on its own |
| D18 | The Home "My performance" widget and the Settings save of weights follow the same live switch; saving weights also refreshes the performance cards | Consistency |

## Deferred

| Item | To | Ready now |
|---|---|---|
| Real attendance (A) | Module 7 (cycle 3) | `AttendanceSource` in `attendance-source.ts`; replace the provider in `performance.module.ts` with `{ provide: ATTENDANCE_SOURCE, useClass: ... }`. It must answer a percentage 0 to 100, never 100 or 0 for "no data" (answer `{ available: false }`), and throw only for a real fault (the job then makes no scorecard for that person and retries, so a fault is never stored as "not available") |
| Real sales figures (V, M, W, D) and the sales score | Module 15 | `SalesSource` in `sales-source.ts`, same rules; the pure engine already works the sales score out from real figures (`auto-sources.test`, `m6-automation`) |
| In-app notifications (a bell) | Module 12 | The events and the mails |
| A department picker for the weights on the Settings screen | Module 12 | The server accepts `departmentId`; department sets are listed in the history |
| Re-routing an open dispute when its decider leaves | A decision with the project owner | The decider is fixed when the dispute is raised (the database never lets it change), so if that person leaves while it is open nobody else can decide it, the Owner included. A follow-up in the leaver hand-over would need a trigger exception |
| Retention clean-up of old scorecards | The Module 4 retention decision | Nothing is deleted; every table has an index on its time column |
| Browser test `e2e/m6-live.spec.ts` | Run on a machine with room for the production build | Written (6 tests, one of them for the 3-character rule of the remark box; it is skipped when no draft is waiting for the CTO), the web server in `e2e/playwright.config.ts` has `m6` switched on |

## Known limits

1. Running the current month by hand (step 16) uses up that month's job: its row ends `succeeded` and is never re-armed, so
   no job runs for that month on the 1st. The month's scorecards stay as they were at the hand-run; anyone who joins, or
   whose task is approved, after it gets no scorecard for that month, and nothing catches up. A scorecard can never be
   deleted. To start the demo over: `npm run db:reset -w backend`, then `npm run db:seed` and the demo logins.
2. A retry after a partial failure can mail a reviewer a second digest with the new total of waiting drafts.
3. A person without a manager gets no scorecard. The reviewer is the nearest person above who has not left and holds
   `task.review` (the manager, or further up when the manager left or does not review work); the system releases a
   scorecard only when nobody in the whole line above reviews work (in practice only the Director).
4. The test output shows one Node warning "Calling client.query() when the client is already executing a query"
   (deprecated in pg 9). It comes from Prisma's PostgreSQL adapter, appears in Module 1 to 5 test files too, and is
   harmless today.
5. The Settings weights editors do not pick a department (see Deferred).
6. A task handed in but not yet reviewed when the monthly job runs (00:10 Pakistan time on the 1st) is stored as `submitted`
   with no rating and stays so: it counts as handed in for On time and Rework and in the points due for Completion, earns no
   points, is never updated, and cannot be disputed. Reviewers should clear the review queue before the 1st. **Open question
   for the owner:** run the job later (for example the 3rd working day) or leave tasks still in review out of Completion.
   Covered by the June test in `m6-automation`.
7. A monthly job that failed all 5 attempts is only visible as an error line in the server log and as a `failed` row in
   `scheduled_jobs`; nothing alerts anyone, and it is not re-armed by itself (see D11 for the manual recovery). Automatic
   re-arming of a failed previous-month job was left out unless the owner wants it.

## For the people building Modules 7 and 15

- **Attendance and sales**: implement `AttendanceSource` / `SalesSource` (see Deferred) and replace the provider. Nothing
  else changes: scorecards made earlier keep their numbers, new ones use the figure.
- **Events** (`docs/EVENTS.md`): `scorecard.drafted`, `scorecard.released`, `scorecard.acknowledged`,
  `scorecard.dispute_raised`, `scorecard.dispute_decided`, `score_weights.created`. Consumer routing for the mails is in
  `performance-consumers.service.ts` (`performance.mail`; the name never changes).
- **The one calculator**: `PerformanceCalculator.compute(person, month, now)` is the only place a month is worked out; the
  live view, the monthly job and the dispute recompute all call it. Never re-write a metric elsewhere.
- **Run the job for a month by hand** (tests, repairs): `ScorecardMonthly.run(month)`, or a `scheduled_jobs` row of type
  `scorecard.monthly` with payload `{"month":"2026-11"}` and `run_at` in the past.

## Switching the screens to the live API

The Performance screens, the score weights in Settings, the Home "My performance" widget and the scorecard and dispute
items of the Approvals inbox use the real server when Module 6 is in the live list. In `frontend/.env.local`:

```
NEXT_PUBLIC_LIVE_MODULES=m1,m2,m3,m4,m5,m6
NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
```

(or `NEXT_PUBLIC_API_MODE=live` for every module). Restart `npm run dev -w aceva-digital-system-web` after changing it.
Module 6 live needs Modules 1 to 3 (people, sessions) and Module 5 (tasks and the inbox) live. Without `m6` the screens keep
the demo data. The switch is `isLive("m6")` in `frontend/src/features/performance/api.ts`,
`frontend/src/features/system/api.ts` and `frontend/src/features/approvals/api.ts`.

## How to check M6 by hand

Everyone signs in with their Emp-ID and the password `Aceva12345`. The CEO / Founder / Owner, the Director and the CTO
also enter the 6-digit code from their authenticator app. Times on screen are Pakistan time. PostgreSQL and Redis run as
Windows services on this machine. Run every command from the project folder. The SQL in these steps is typed into
`psql`, the PostgreSQL prompt, on the `aceva_dev` database (the demo data): with Docker,
`docker compose exec postgres psql -U aceva_app -d aceva_dev`; with PostgreSQL as a Windows service, the `psql` that
comes with PostgreSQL, connected to `aceva_dev` as `aceva_app` (the password is in `backend/.env`). Any database tool
works too. The dates below are for November 2026: the month that just closed is October 2026 (`2026-10`) and the
current month is `2026-11`.

**Get ready (once)**

1. Start Mailpit: open a terminal and run `mailpit` (leave it open; the inbox is http://127.0.0.1:8025). If an API from an
   earlier check is running on port 4000, stop it with Ctrl+C: it has the old code.
2. Build the shared contracts and create the tables: `npm run build:contracts`, then `npm run db:migrate`. It applies every
   migration that is not applied yet: the Module 5 ones (`20261116100000_m5_tasks`, `20261117100000_m5_task_indexes`) if
   Module 5 was not set up on this database, and `20261118100000_m6_performance`. Then `npm run db:seed` (demo projects and
   holidays; safe to run again).
3. Check the starting weights:
   in psql `SELECT kind, version_no, weights::text AS weights FROM score_weight_versions ORDER BY kind, version_no;`.
   Expected: two rows. `standard` 1 with `{"onTime": 25, "rework": 10, "quality": 35, "attendance": 10, "completion": 20}`
   and `sales` 1 with `{"won": 30, "activity": 20, "meetings": 25, "attendance": 15, "dataQuality": 10}`.
4. Start the API: `npm run build -w backend`, then `npm start -w backend` (http://localhost:4000).
5. In `frontend/.env.local` set `NEXT_PUBLIC_LIVE_MODULES=m1,m2,m3,m4,m5,m6` and
   `NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1`, then `npm run dev -w aceva-digital-system-web` and open
   http://localhost:3000 (type `localhost`, not `127.0.0.1`).
6. Use two browser windows that do not share sign-ins: **Window A** = Chrome, kept for **ACV-0004** (Omar Farooq, CTO)
   through the whole check; **Window B** = a Chrome private window, used for the other people: sign out and sign in as the
   step says.

**The first run of the monthly job: nothing is made up**

7. About 30 seconds after the API started, the server made the scorecards of the month that just closed. Run:
   in psql `SELECT e.emp_id, s.month, s.kind, s.status, s.score, s.band, s.task_count AS tasks, w.version_no AS weights_v FROM scorecards s JOIN employees e ON e.id = s.employee_id JOIN score_weight_versions w ON w.id = s.weights_version_id ORDER BY s.month, e.emp_id;`.
   Expected: 11 rows, all `2026-10`: every demo person except ACV-0001 (the Owner is not scored). ACV-0003 (the Director)
   is `released`, the other ten are `draft`. ACV-0009, ACV-0012 and ACV-0014 are `sales`, the rest `standard`. `score` and
   `band` are `null` for everybody (no task fell in October, and a score is never made up), `tasks` 0, `weights_v` 1.
   Then in psql `SELECT dedupe_key, status, attempts, run_at FROM scheduled_jobs WHERE type = 'scorecard.monthly' ORDER BY dedupe_key;`.
   Expected: `scorecard.monthly:2026-10` `succeeded` with 1 attempt, and `scorecard.monthly:2026-11` `pending` with `run_at`
   2026-11-30 19:10 UTC, which is 00:10 on 1 December in Pakistan.
8. Mailpit: three new mails. `5 draft scorecards to review: October 2026` to omar@acevatech.com (his five developers),
   `5 draft scorecards to review: October 2026` to bilal@acevatech.com (the CTO, Sales and Finance) and
   `Your October 2026 scorecard is ready` to bilal@acevatech.com (the Director's own was released by the system). Open one:
   it names the month, links to the website and holds no score.
9. Window B: sign in as **ACV-0006** (Fahad Khan, developer). Open **Performance**. Expected: only the tabs **My
   performance** and **Disputes** (no Team, no Review queue). An empty dial with "No score yet"; the tiles Quality, On-time,
   Completion and Rework say "Not available yet" (nothing to measure), Attendance says "Not available yet" and
   "Attendance arrives with the Attendance module". "Latest scorecard" says **No scorecard yet**: his October draft exists,
   but an employee never sees a draft. Access rule: open http://localhost:4000/api/v1/scorecards?empId=ACV-0006. Expected:
   `[]`.
10. Window B: sign out, sign in as **ACV-0003** (Bilal Ahmed, Director). Open **Performance**. Expected: "October 2026
    scorecard, Released ... automatically (nobody above reviews work)", "No score yet", an **Acknowledge** button and no
    "Dispute a rating" button.

**Rate some work (Module 5), so there is something to score**

11. Window A: sign in as **ACV-0004**. Open **Tasks**, **Assign task**. Create three tasks for **Fahad Khan** (ACV-0006), size
    **S**: `M6 check A`, `M6 check B`, `M6 check C`. Keep the suggested deadline (next working day, 18:00). The deadline
    decides the month a task counts in, so these steps assume it falls in the current month: on the last working day of a
    month set the deadline to a few hours from now instead and confirm the "too short" warning.
12. Window B: sign out, sign in as **ACV-0006**. Open **Tasks**, and for each of the three tasks press **Start work**, then
    **Submit for review**.
13. Window A: open `M6 check C` and **Send to rework** with the reason `Please redo the footer`. Window B (Fahad): on that
    task **Start rework**, then **Submit for review** again.
14. Window A: open **Approvals**. Approve `M6 check A` with **4 stars**, `M6 check B` with **4 stars** and `M6 check C`
    with **2 stars**.
15. Window B (Fahad): open **Performance**, **My performance**. Expected: the dial shows **83**, band **Good**, "Standard v1
    weights" and "Small sample: under 5 tasks". Quality 66.7, On-time 100, Completion 100, Rework 33.3 (lower is better),
    Attendance "Not available yet". The formula line uses the four measured metrics only: attendance is left out and its
    weight is shared among the others. "Workload right now: 0 h". The working: 0.35 x 66.7 + 0.25 x 100 + 0.20 x 100 + 0.10
    x (100 - 33.3) = 75.0, divided by the 0.90 of the measured weights = 83.4. The formula chips show each metric's points to
    two decimals (25.94 + 27.78 + 22.22 + 7.41 = 83.35) and the total is rounded to one decimal (83.4), as the note beside the
    total says.

**Run the current month by hand**

16. Instead of waiting for 1 December, run the job of the current month now:
    in psql `UPDATE scheduled_jobs SET run_at = now() WHERE type = 'scorecard.monthly' AND dedupe_key = 'scorecard.monthly:' || to_char(now() AT TIME ZONE 'Asia/Karachi', 'YYYY-MM');`.
    Expected: `UPDATE (1 rows)`. Within about 30 seconds run the step 7 query again. Expected: 11 more rows for the current
    month; Fahad's (ACV-0006) is `draft` with `score` 83.4, `band` good, `tasks` 3; everybody else has no score. The Director's
    is `released`. Mailpit has the same three kinds of mail for the new month. (This takes the figures as they are now and
    the month's job is used up, see Known limits 1.)

**The reviewer: team table, remark, release**

17. Window A (Omar): open **Performance**, tab **Team**. Expected: Ali Raza, Danish Iqbal, Fahad Khan, Mariam Shah and Nida
    Aslam, in name order; nobody from Sales or Finance; no rank anywhere; the **This month** column header cannot be
    sorted. Fahad's row shows 83, Good, "small sample".
18. Click Fahad's row. Expected: the page "November 2026 scorecard", status **Draft**, "Standard v1 weights", the dial 83
    (Good), the formula, the **Tasks counted** table with the three tasks (4, 4 and 2 stars, a **Rework** badge on the third),
    the small-sample note, and a **History** that says "Draft created by the system" and "Waiting for the reviewer to
    release". The formula chips show the points to two decimals (25.94 + 27.78 + 22.22 + 7.41 = 83.35) and the total rounded
    to one decimal (83.4). There is a **Release** button and a **Reviewer remark** box, but nothing on the page edits a
    number.
19. Type the remark `Good month. Please keep the checklists up to date.` and press **Save remark**. Expected: "Remark saved"
    and a "Reviewer remark added" line in the History. Typing 1 or 2 characters (for example `ok`) leaves **Save remark**,
    **Save and release** and **Release** disabled and shows "At least 3 characters."; clear the box or write 3 or more
    characters to continue.
20. Access rule: Window B: sign out, sign in as **ACV-0003** (Director) and open Fahad's November scorecard (**Performance**,
    **Team**, Fahad Khan). Expected: he sees it but only "View only. Omar Farooq releases it": no Release button and no
    remark box. The Director reviews the CTO, Sales and Finance, not the developers.
21. Window A (Omar): open **Approvals**. Expected: scorecard items such as "October 2026 scorecard, no score yet" for each
    developer and "November 2026 scorecard, 83 (Good)" for Fahad, with the buttons **Release** and **Add remark, keep
    draft**. On Ali Raza's October item press **Add remark, keep draft**, write `Nothing to score in October`, confirm.
    Expected: "Remark added, the scorecard stays a draft", and the item stays (it is still a draft). Press **Release** on
    it. Expected: "Scorecard released", and it leaves the inbox.
22. On Fahad's November scorecard (**Performance**, **Team**, Fahad Khan) press **Release**. Expected: "Scorecard released",
    the status **Released**, and the History says "Released to the employee" with Omar Farooq. Mailpit: `Your November 2026
    scorecard is ready` to fahad@acevatech.com; the mail has a link and no score.
23. Access rule: still as Omar, **Performance**, **My performance**, "All my scorecards". Expected: none yet. His own
    November scorecard is a draft waiting for the Director, and nobody sees their own draft.

**The employee: acknowledge and dispute**

24. Window B: sign out, sign in as **ACV-0006** (Fahad). Open **Performance**, **My performance**. Expected: "Latest
    scorecard": "November 2026 scorecard, Released ... by Omar Farooq", the dial 83 (Good), "3 tasks counted", Omar's remark in
    quotes, and the buttons **Acknowledge**, **Dispute a rating** and **Open scorecard**.
25. Press **Acknowledge**, comment `Thank you, noted.`, confirm. Expected: "Scorecard acknowledged"; the status is
    **Acknowledged** and "Your comment: Thank you, noted." shows.
26. Press **Dispute a rating**, choose `M6 check C` (2 stars), reason `The footer was redone the same day you asked, so 2
    stars is too low.` and **Send dispute**. Expected: "Dispute sent". Open the scorecard: the row of that task shows
    **Disputed** instead of a Dispute button, so it cannot be disputed twice while open. Mailpit: `Rating disputed:
    TSK-...` to bilal@acevatech.com. The decider is the Director, not the CTO: the level above the one who gave the rating.
27. Access rule: Window A (Omar): **Performance**, tab **Disputes**. Expected: he sees the dispute (he is above Fahad) but
    has no **Decide** button, because he gave the rating.

**Weights: a new version, old scorecards keep theirs**

28. Window A (Omar): open **Settings**, section **Score weights**. Expected: the weights and the **Version history** are
    readable (Standard v1, sales v1, by "System"), the fields are disabled and there is no save button. Only the Director
    saves weights.
29. Window B: sign out, sign in as **ACV-0003** (Director). **Settings**, **Score weights**, standard set. Type 29.5 in
    Quality: "Use whole numbers." Type 31 in Quality: "Weights must add up to 100%." Now set Quality **30**, On-time **30**
    (Completion 20, Rework 10, Attendance 10) and press **Save as new version**, reason `Deadlines matter more`. Expected:
    "New weights version saved"; the history lists **Standard v2** first, `30 / 30 / 20 / 10 / 10`, by Bilal Ahmed, and
    **Standard v1** is still there, `35 / 25 / 20 / 10 / 10`, by System. The audit entry: in psql `SELECT occurred_at, action, target_id FROM audit_log WHERE action LIKE 'scorecard.%' OR action LIKE 'settings.score_weights%' ORDER BY occurred_at;`.
30. Open Fahad's November scorecard as the Director (**Performance**, **Team**, Fahad Khan). Expected: still **Standard v1
    weights** and 83: an old scorecard keeps the weights it was made with. Fahad's own **My performance** (live, this month so
    far) now says **Standard v2 weights** and shows 85 (85.2 with the new weights). Fahad's live view and scorecard carry only
    the weights themselves: not who saved the version and not the Director's reason (`note`), which are only in Settings.

**The Director decides the dispute**

31. Window B (Director): **Performance**, tab **Disputes**, the dispute of `M6 check C`, **Decide**. Choose **Change rating**,
    new rating **4 stars**, decision `You are right: it was redone the same day.`, **Save decision**. Expected: "Rating
    changed; the scorecard was recalculated". The dispute shows the badge "Rating changed" on the Disputes tab, and the scorecard card shows "Changed to 4★" and "Score recalculated: 83.4 to 88.5".
32. Open Fahad's November scorecard. Expected: the dial shows **89** (88.5), band **Excellent**; the third task shows 4 stars
    and "was 2 stars (changed after a dispute)"; "Recalculated once after a rating dispute was decided"; the card "Disputes
    on this scorecard" shows the decision and the two scores; the weights are still **Standard v1** (with Standard v2 it would
    have been 89.6). Mailpit: `Rating changed: TSK-...` to fahad@acevatech.com. The task page of `M6 check C` shows 4 stars.
    The history of the change: in psql `SELECT e.emp_id, t.number, d.rating_at_raise AS was, d.new_rating AS now, d.status, d.score_before, d.score_after FROM rating_disputes d JOIN employees e ON e.id = d.employee_id JOIN tasks t ON t.id = d.task_id ORDER BY d.created_at;`.
33. Keep a rating: as Fahad open the scorecard and press **Dispute** on the row of `M6 check B` (4 stars), with another
    reason of at least 20 characters. As the Director open **Approvals**, the item "Rating dispute: M6 check B (4 stars)",
    press **Keep rating** and give a reason. Expected: "Rating kept"; the dispute shows "Rating kept" and the scorecard still
    reads 88.5 (nothing was recalculated). (To change a rating from the inbox instead, press **Change rating**, pick the
    stars and **Approve with N stars**; that route uses the standard decision text "Rating changed after review.")

**The rules in the database**

34. Nobody can change the numbers. Run in psql `UPDATE scorecards SET score = 99 WHERE month = '2026-11';`.
    Expected: `ERROR: The numbers of a scorecard cannot be changed (only the recompute after a dispute decision may)`. Then
    `... sql "DELETE FROM scorecards WHERE month = '2026-11'"`: `ERROR: Scorecards are never deleted`. Then
    `... sql "UPDATE score_weight_versions SET note = 'x'"`: `ERROR: Table score_weight_versions is insert-only: rows cannot
    be changed or removed`. There is no edit or delete control anywhere on the Performance screens.
35. Access rules on the server. Window B: sign in as **ACV-0006** (Fahad) and open these addresses one after another:
    http://localhost:4000/api/v1/performance/live?empId=ACV-0004, http://localhost:4000/api/v1/performance/team and
    http://localhost:4000/api/v1/settings/score-weights. Expected: `403` each time (a colleague above him, a team table he does
    not have, the weights he may not read).

**Who sees whose results**

36. Window A (Omar): open http://localhost:4000/api/v1/performance/live?empId=ACV-0009. Expected: `403`: Sales is not in the
    CTO's line. Window B: sign in as **ACV-0003** (Director), **Performance**, **Team**: everyone below him is listed in name
    order. Open **Hira Baig** (Sales). Expected: "Sales figures arrive with the Sales module. Until then there are no sales
    numbers here and no sales score." and no score; he is her reviewer, so **Approvals** also lists her draft with **Release**.
37. Window B: sign out, sign in as **ACV-0001** (Hamza Qureshi, the Owner). **Performance**, **Team**: all eleven people, in
    name order. Open Fahad's scorecard and Bilal's. Expected: view only, no Release button and no remark box on any of them,
    and Bilal's says "Released automatically".

**Running a month again changes nothing**

38. Stop the API (Ctrl+C) and start it again (`npm start -w backend`). Wait a minute, then run
    in psql `SELECT month, count(*) AS scorecards, max(recompute_count) AS recomputes FROM scorecards GROUP BY month ORDER BY month;`.
    Expected: 11 scorecards for `2026-10` and 11 for `2026-11`, `recomputes` 0 and 1: a restart makes no second set and
    does not touch Fahad's scorecard.

**Database tests**

39. With PostgreSQL and Redis running: `npm run build:contracts`, then `npm test -w backend -- m6-` (the three Module 6 files:
    `m6-foundation` 34 tests, `m6-core` 46, `m6-automation` 23), or `npm test` for everything. The tests use the `aceva_test`
    database (rebuilt for every run) and send no real email. Unit tests only (no database): from `backend/`, `npx vitest
    run src/performance`.
40. To start the demo data over afterwards: `npm run db:reset -w backend`, then `npm run db:seed` and the demo logins (see
    `docs/SETUP.md`). Scorecards can never be deleted by hand.

## Verification run for this build

- `npm run typecheck` (contracts, backend, frontend): 0 errors.
- `npm run lint`: 0 errors, 9 warnings (the same 9 as before Module 6, none in Module 6 files).
- `npm test` (contracts tests, then every backend test with PostgreSQL 17 and Redis): contracts 37 passed (9 new);
  backend 58 files, 1100 tests, all passed. New for Module 6: 195 unit tests (12 files in `backend/src/performance`:
  `perf-score` 40, `perf-tasks` 21, `perf-month` 15, `perf-figures` 17, `perf-people` 28, `performance-data` 19,
  `core-view` 9, `core-approvals` 9, `performance-approvals.provider` 6, `auto-mail` 11, `auto-monthly` 14,
  `auto-sources` 6) and 103 database tests (`m6-foundation` 34, `m6-core` 46, `m6-automation` 23). The Module 1 to 5 tests
  still pass.
- `npx prisma migrate diff --from-migrations prisma/migrations --to-schema prisma/schema.prisma`: no difference. The new
  migration is applied from scratch to `aceva_test` by every database test run.
- The hand-check scenario (steps 11 to 32) was run once as a throwaway database test through the real task workflow and
  the real endpoints, then deleted: 83.4 (Good) before the dispute, 88.5 (Excellent) after it with weights v1, 89.6 with
  v2 live, the decider the Director. Every request the Performance and Home screens make answered 200 for the Owner, the
  Director, the CTO, a developer, Sales and Finance (403 only where a person has no right: the weights and the team table
  for a developer, Sales and Finance).
- Not run: `e2e/m6-live.spec.ts`, any click-through of the screens, the frontend production build.
