# Module 5 acceptance checklist (plan section 9)

Final company structure: Level 1 CEO / Founder / Owner (one person, sees everything, view only), Level 2 Director (the
only approver, also HR and sales-manager duty), Level 3 CTO (runs the developers and SQA), Level 4 Sales and Finance,
Level 5 Developer / SQA.

**Status: BUILT, NOT YET ACCEPTED.** Everything below is uncommitted work on branch `cycle2-m4-m6` (on top of the
uncommitted Module 4), waiting for the project owner's check by hand ("How to check M5 by hand" at the end). All
checks that can run on a computer ran and pass: typecheck, lint, 332 backend unit tests, 28 contract tests and every
database test (125 are new for this module). **Not run here:** the browser test `e2e/m5-live.spec.ts` (it needs a
production build of the website, which this machine has no room for) and any click-through of the screens.

Statuses: **Built, unit-tested** = the pure rule tests pass. **Built, DB tested** = a database test in `backend/test`
passes. **Deferred** = not built now, with the module that does it.

## What is built, what is deferred

**Built.** Tasks with every field of the plan; assigning only down the reporting line and only by people who hold
`task.assign`; the size table (editable by the Director, with a history, old tasks keep their points); the holiday
calendar; suggested deadlines on working days with holidays skipped; the too-short and overloaded-week warnings (soft,
confirmed by the person); past deadline and XL refused; the status machine for all ten actions with a review record
(rating 1 to 5 or a reason); extension requests and their decision (original deadline kept, extensions counted, late
flag); manager deadline changes with a reason; comments with @mentions; files through the Module 3 storage; full
history; personal to-dos (private, never scored); checklist; repeating tasks; reminders (half time, 24 hours before, at
the deadline, daily overdue notice); mails for every step; the leaver hand-over; the Module 4 "tasks touched" number from
the task tables; the approvals inbox items `task_review` and `extension`; the events Module 6 needs. The frontend works
against the server behind `isLive("m5")`.

**Deferred (not part of this module).** Projects and clients as a real module (a read-only demo list now), department
goals (a plain optional reference now), leave shown on the calendar and in the assign sheet (Module 7), in-app
notifications (Module 12), the Settings screen for the size table (Module 12; the server route exists). Details in
"Deferred" below.

## Task fields (plan section 9, "Task fields")

| # | Requirement | Status | Where | Verified by |
|---|---|---|---|---|
| F1 | Title and description | Built, DB tested | `tasks` table; `POST /tasks`; `createTaskRequestSchema` | `m5-core` (assigning) |
| F2 | Assigned to: one Emp-ID | Built, DB tested | `tasks.assignee_id`; refused when the person has left (`assignee_left`) | `m5-core` (assigning) |
| F3 | Assigned by: filled from the login | Built, DB tested | `tasks.assigned_by_id` is the session user, never sent by the client | `m5-core` (assigning) |
| F4 | Project or client, optional | Built (read-only list) | `projects` table with five demo rows; `GET /projects`; `project_not_found` when the id is wrong | `m5-core`, `m5-foundation` |
| F5 | Department goal, optional | **Deferred** (plain reference) | `tasks.goal_id` is stored as text; there is no goals module yet | `m5-core` (edit) |
| F6 | Priority low, medium, high, urgent | Built, DB tested | `task_priority` enum | `m5-core` (list filters) |
| F7 | Size XS to XL | Built, DB tested | `task_size` enum; points and hours copied from the size table at creation | `m5-core` (size table copy) |
| F8 | Estimated hours: from the size, adjustable | Built, DB tested | `tasks.estimated_hours` (0.5 to 200); the sheet fills it from the size | `m5-core` (edit: size and points never change, hours may) |
| F9 | Start date and deadline; the deadline is required | Built, unit-tested, DB tested | `tasks.start_date`, `deadline`, `original_deadline` (never changes: trigger) | `task-deadlines.test`, `m5-foundation` (constraints), `m5-core` |
| F10 | Checklist or subtasks | Built, DB tested | `task_checklist_items`; `POST /tasks/:id/checklist`, `PATCH /tasks/:id/checklist/:itemId` (the person doing the task ticks; the assigner or the person adds steps) | `m5-core` ("keeps a checklist") |
| F11 | Attachments | Built, DB tested | `task_attachments`; `POST /tasks/:id/attachments`, download, archive (never deleted); Module 3 `FileStorage`, PDF, PNG, JPEG, .docx, 10 MB, type checked by content | `m5-core` (comments and files) |
| F12 | Status | Built, unit-tested, DB tested | `task_status` enum, see "Statuses" | `task-status.test`, `m5-core` |

## Task sizes and deadline rules

| # | Requirement | Status | Where | Verified by |
|---|---|---|---|---|
| Z1 | Size table XS 2 h 1 pt same day, S 4 h 2 pt 1 day, M 16 h 3 pt 3 days, L 40 h 5 pt 7 days, XL must be split | Built, DB tested | `task_size_settings`, inserted by the migration; `GET /settings/task-sizes`. The hours are 16 and 40 (brief), the demo screens say 12 and 32 (decision 1) | `m5-foundation`, `m5-core` (size table) |
| Z2 | The Director changes sizes, hours and points; history kept; old tasks keep their points | Built, DB tested (server only) | `PATCH /settings/task-sizes/:size` (`settings.manage`, reason required, the whole table checked: XL stays "must be split", a bigger size is never smaller); `task_size_setting_changes` insert-only; `GET /settings/task-sizes/changes`. The Settings screen is still the demo screen (deferred) | `m5-core` ("only the Director changes a row", "keeps the table sensible") |
| Z3 | Suggested deadline: working days only, holidays skipped, 18:00 Pakistan time | Built, unit-tested | `rules/task-deadlines.ts` (`suggestedDeadline`, `addWorkingDays`); the sheet uses the same rule in `features/tasks/logic.ts` | `task-deadlines.test` (weekends, holidays, a Saturday start), `m5-core` ("counts working days only and skips holidays") |
| Z4 | Too-short warning ("An M task usually needs 3 working days; you set 1. Continue?") | Built, unit-tested, DB tested | `checkDeadline` gives the warning; the server answers `409 confirmation_required` with `warnings[]` until `confirmWarnings: true` is sent; the sheet shows the sentence and asks | `task-deadlines.test`, `m5-core` ("warns about a too-short deadline") |
| Z5 | A deadline in the past is not allowed; XL is not assignable | Built, unit-tested, DB tested | 400 `deadline_in_past`, `deadline_before_start`, `size_xl_not_assignable` (an XL personal to-do is allowed: it is not scored) | `task-deadlines.test`, `m5-core` ("refuses XL ...") |
| Z6 | Workload check against weekly capacity (40 h, 20 h for interns and part-time) before assigning | Built, unit-tested, DB tested | `rules/task-workload.ts`; `Employee.weeklyCapacityHours`; the same `409 confirmation_required` with the sentence "This puts Nida Aslam at 40 h of 20 h this week." | `task-workload-sizes.test`, `m5-core` ("warns when the assignee would go over") |
| Z7 | Reminders: half the time if not started; 24 hours before; at the deadline; then a daily overdue notice to the employee and the manager; the task turns red | Built, unit-tested, DB tested | `task-reminders.service.ts` (job `task.reminder`), `rules/task-reminders.ts`, `rules/auto-reminders.ts`; the red flag is the computed `isOverdue`. Re-armed when the deadline changes; removed when the task is held, handed in, approved or cancelled (and armed again when it is resumed) | `task-reminders.test`, `auto-automation.test`, `m5-automation` (reminders, 12 tests) |
| Z8 | Extension request before the deadline: reason, the assigner decides, the new deadline is saved and the original kept, on-time measured against the approved deadline, extensions counted, a request after the deadline counts as late | Built, unit-tested, DB tested | `POST /tasks/:id/extensions`, `POST /extensions/:id/{approve\|reject}`; `task_extensions`; `tasks.extensions_count`; `task.approved.onTime` is measured against the current (approved) deadline | `task-deadlines.test`, `m5-core` (extension requests, 7 tests) |
| Z9 | Manager changes the deadline: a reason is required and the change is logged | Built, unit-tested, DB tested | `PATCH /tasks/:id { deadline, reason }`; history line with both dates, audit `task.deadline.changed`, event `task.deadline_changed` | `m5-core` ("moves a deadline with a reason", "refuses a deadline change ...") |

## Statuses and the review

| # | Requirement | Status | Where | Verified by |
|---|---|---|---|---|
| ST1 | Assigned, In Progress, Submitted, Under Review, then Approved or Rework (back to In Progress) | Built, unit-tested, DB tested | `rules/task-status.ts`; `POST /tasks/:id/{start,submit,review,approve,rework}` | `task-status.test`, `m5-core` (status machine, 11 tests) |
| ST2 | On Hold or Cancelled by the assigner with a reason; a held task can also be cancelled | Built, unit-tested, DB tested | `POST /tasks/:id/{hold,resume,cancel}` | `m5-core` ("puts a task on hold ...", "a task on hold can also be cancelled") |
| ST3 | "Overdue" is a red flag, not a status | Built, unit-tested, DB tested | `isOverdue` is worked out when a task is read (open, not waiting for the reviewer, deadline passed); never stored | `m5-core` ("flags an open task past its deadline as overdue") |
| ST4 | Approve needs a rating 1 to 5 and a comment is optional; rework needs a reason; stored as a review record | Built, unit-tested, DB tested | `task_reviews` (insert-only; the database refuses an approval without a rating and a rework without a reason) | `m5-foundation` (a NULL rating is refused), `m5-core` ("an approval needs a rating ...") |
| ST5 | Nobody reviews their own task; the reviewer is the assigner, or the stand-in, or the next level up (M1 stand-in rules) | Built, DB tested | `TaskWorkflowService.reviewerOf`: assigner, else the stand-in while away, else the next level up that holds `task.review`; never the assignee, never the Owner. Two reviewers at the same moment: one decision, one 409 | `m5-core` ("nobody reviews their own task ...", "the reviewer follows M1 stand-in rules", 3 tests) |
| ST6 | Approvals module lists `task_review` and `extension` items | Built, DB tested | `task-approvals.provider.ts` registered with the shared inbox `ApprovalsInbox`; `GET /approvals`, `GET /approvals/oversight`, `POST /approvals/:id/{approve\|reject}` | `m5-core` (approvals inbox, 4 tests), `m5-foundation` |

## Screens and views served

| # | Requirement | Status | Endpoint | Verified by |
|---|---|---|---|---|
| S1 | My Tasks sorted by deadline | Built, DB tested | `GET /tasks?scope=mine` | `m5-core` ("lists My Tasks sorted by deadline ...") |
| S2 | List (filters: assignee, status, priority, size, project, due range), board, calendar | Built, DB tested | `GET /tasks?scope=team\|all&status=&priority=&size=&projectId=&assignee=&dueFrom=&dueTo=`. `scope=team` needs `task.view_team`; `scope=all` needs only `task.view_own` and returns what the caller may see | `m5-core` (same test; `scope=all` is 200 for a developer, `scope=team` is 403) |
| S3 | Team workload: open hours against weekly capacity, one bar per person | Built, DB tested | `GET /tasks/workload` (`task.view_team`) | `m5-core` ("shows the team workload ... to managers only") |
| S4 | Task page: comments, @mentions, files, full history, extensions | Built, DB tested | `GET /tasks/:id` (task, comments, extensions, history, reviewer); `GET\|POST /tasks/:id/comments` | `m5-core` (comments and files, 5 tests) |
| S5 | Repeating tasks (a weekly report every Monday) | Built, unit-tested, DB tested | The sheet's Repeat field (every week on a weekday, every month on a day 1 to 28, optional stop date); `task_repeat_rules`; job `task.repeat`; `POST /tasks/:id/repeat/stop` | `task-repeat.test`, `m5-core` (series made and stopped), `m5-automation` (repeating tasks, 8 tests) |
| S6 | Project list, holiday calendar, size table | Built, DB tested | `GET /projects`, `GET /holidays?year=`, `GET /settings/task-sizes` | `m5-core` ("everyone reads the table ...") |
| S7 | Comments with @mentions: stored, mailed | Built, DB tested | Mentions by first name, full name or Emp-ID; only people who can see the task and are active; never the writer. Event `task.comment_added`, mail "<name> mentioned you on TSK-0001" | `m5-core` ("stores a comment and its mentions"), `m5-automation` (mails) |

## Who can do what

| Who | Can | Verified by |
|---|---|---|
| Director (L2) | Assign to anyone below him (CTO, Sales, Finance, developers); review and decide extensions of tasks he assigned; change the size table; sees every work task below him | `m5-core` (assigning, who sees which tasks, size table) |
| CTO (L3) | Assign to the developers and SQA of his line; review and decide extensions of tasks he assigned; sees his line's tasks | `m5-core` |
| Sales, Finance, developers, SQA | Do their tasks (start, submit, tick steps, comment, attach files, ask for more time); add personal to-dos for themselves | `m5-core` |
| Anyone | Nobody assigns upward, sideways or to themselves; without `task.assign` nobody assigns (403) | `m5-core` ("assigning upward, sideways ... is refused") |
| CEO / Founder / Owner (L1) | Sees every work task, read only: assigns nothing, reviews nothing, no comments, no files. His own personal to-dos work like anybody's | `m5-core` ("the Owner only watches") |
| Everybody | Personal to-dos are seen by their owner alone: not by a manager, not by the Owner | `m5-core` (personal to-dos, 4 tests) |
| The next person up the line | Holds, resumes, cancels, edits, moves the deadline of, adds steps to and attaches files to a task whose assigner has left or lost `task.assign` (decision 21) | `m5-core` (tasks assigned by someone who has left, 3 tests) |

## Automation

| # | Requirement | Status | Where | Verified by |
|---|---|---|---|---|
| A1 | Reminders go by mail and as events, re-scheduled when the deadline changes, the task is held, cancelled or approved | Built, DB tested | Consumer `tasks.reminders` of the events `task.created`, `task.status_changed`, `task.deadline_changed`, `task.transferred`; mails "Half the time has passed", "Due in 24 hours", "Due now", "Overdue" through the existing mailer (Mailpit locally) | `m5-automation` |
| A2 | Repeating tasks stop at a stop date or when stopped | Built, DB tested | `task-repeat.service.ts`: one job per series and day at 00:05 Pakistan time, the next one armed after each run; the newest 3 only after downtime; start-up and hourly catch-up | `m5-automation` |
| A3 | Leaver hand-over: consume `task.transfer.requested` and move the open tasks to the manager with history entries | Built, DB tested | `task-handover.service.ts` (consumer `tasks.handover`); moves open work tasks and active series, closes what the manager cannot take, one audit entry `task.handover` | `m5-automation` (leaver hand-over, 8 tests, including the real leaving flow and a Director away with the CTO as his stand-in) |
| A4 | Fill Module 4's daily summary "tasks touched" | Built, DB tested | `task-activity.service.ts` registers `ActivitySummaryHooks.useTasksTouched`; one SQL over history, comments, ticked steps, files, extensions and reviews | `m5-automation` (tasks touched, 2 tests), `m4-time` |
| A5 | Events Module 6 needs, versioned | Built, unit-tested, DB tested | `task.approved` (rating, on time, extensions, reworks, size, points), `task.reworked`, `task.deadline_changed`, others in `docs/EVENTS.md` | `contracts.test`, `m5-core` (events read after each action) |

## Data stored

New tables: `task_size_settings`, `task_size_setting_changes` (insert-only), `projects`, `holidays`, `tasks`,
`task_checklist_items`, `task_comments` and `task_comment_mentions` (insert-only), `task_attachments`, `task_extensions`,
`task_reviews` (insert-only), `task_history` (insert-only), `task_repeat_rules`. Migration
`20261116100000_m5_tasks`: the SQL generated by `prisma migrate diff` plus hand-written sequences (task numbers `TSK-0001`
and `TODO-0001`), CHECK constraints (a personal to-do is for its owner, XL only when personal, deadline not before start,
a review needs its rating or reason), the insert-only triggers, the extension rules (one pending request per task, a later
date, decided requests never change, never deleted) and the trigger that protects number, kind, first deadline and points.
Migration `20261117100000_m5_task_indexes` adds six indexes (a person's tasks by deadline; what a person ticked, commented, attached, asked and decided in a day) for the lists and the "tasks touched" count. Finished reminder and repeat jobs (`scheduled_jobs`) older than 14 days are removed by the hourly series check.
Demo projects and holidays are seeded by `backend/prisma/seed-tasks.ts`; the size table is inserted by the migration.
No new permission keys: `task.view_own`, `task.view_team`, `task.assign`, `task.review`, `settings.view` and
`settings.manage` already existed in `frontend/src/lib/auth/permissions.ts` and `backend/prisma/permission-catalogue.ts`.
No new environment variables.

Audit actions written: `task.created`, `task.updated`, `task.start`, `task.submit`, `task.review`, `task.approve`,
`task.rework`, `task.hold`, `task.resume`, `task.cancel`, `task.deadline.changed`, `task.extension.requested`,
`task.extension.approved`, `task.extension.rejected`, `task.comment.added`, `task.attachment.added`,
`task.attachment.downloaded`, `task.attachment.archived`, `task.repeat.stopped`, `task.size_rules.changed`,
`task.handover`. A personal to-do writes none of them (decision 3).

## Decisions taken where the plan was open

| # | Decision | Why |
|---|---|---|
| 1 | The size table is M 16 h and L 40 h (the brief). The demo screens show 12 h and 32 h; live mode shows the server's table | The brief wins over the demo numbers; the Director can change them |
| 2 | Where the plan and the demo screens disagree on who does what, the demo screens (built for the final structure) win: reviewer = the assigner, then the stand-in, then the next level up, and he must hold `task.review` | Brief |
| 3 | Personal to-dos are private. They get history lines only: no audit entry, no event, no mail, no reminders. The activity timeline says "a personal to-do" and never names it or its title, and every action on one (create, edit, start, done, reopen, comment, tick a step, attach, download and remove a file) is recorded with no target at all, not even the task number. A hand-over never moves them | Managers and the Owner must not learn what is on them |
| 4 | The Owner is view only on work tasks: 403 on comments and files, no assign, no review. The screen hides those controls | Final structure |
| 5 | Wrong status for everybody gives 409 `invalid_state`; right status but wrong person gives 403 `not_allowed` (only 403 counts as a blocked attempt in Module 4) | Keeps the activity alerts meaningful |
| 6 | The server enforces the soft warnings: `409 confirmation_required` with `warnings[]` until `confirmWarnings: true`. The sheet sends the confirmation when it is already showing the warning; if the server disagrees it asks with "Continue anyway?" | Plan: "Continue?" must be the person's choice |
| 7 | From Rework the person may `submit` or `start` again; `resume` returns a held task to In progress; a held task can be cancelled | Demo screens and plan together |
| 8 | An extension is decided by whoever `reviewerOf` names and holds `task.assign`, never the requester; one pending request per task; allowed in assigned, in progress, rework and on hold; after the deadline it is allowed and marked late; a pending request on a task that was approved or cancelled stays pending but is not listed or decidable | Maker-checker |
| 9 | Review records are insert-only. Module 6 adds its own table for a changed rating after a dispute | Plan section 22: tracking tables allow adding rows only |
| 10 | A repeating series copies a template into `task_repeat_rules`; every task of it carries `repeat_rule_id` and `occurrence_on` (unique together, so a retried job never makes the same day twice); the first task is made with the series; `until` is an extra optional stop date | The demo type has only "every" and "on" |
| 11 | The daily overdue notice and the repeat job are one job per day (keys `task.reminder:<task>:overdue:<day>`, `task.repeat:<rule>:<day>`); the other reminders keep one key each | The job runner marks a job finished when its handler returns, which would wipe a handler that re-armed its own row |
| 12 | Overdue notices go to the assignee, the assigner and the assignee's manager, at 09:00 Pakistan time every day; people who left get nothing. A reminder whose job runs more than 2 hours late (20 hours for the overdue notice) is dropped, never sent late | Plan: "the employee and the manager" |
| 13 | Leaver hand-over: open work tasks and active series move to the manager (the nearest manager who has not left), but only where the work can stay in line. A task is **closed instead** (open question 4; status Cancelled, history line, event `task.status_changed` by the system) when the manager assigned it himself ("Closed on hand-over: the assigner takes over"), when the new owner is the CEO / Founder / Owner ("...the new owner only has view access"), when the new owner is not strictly below the person who assigned it ("...the new owner is not below the person who assigned it") or when nobody could ever review it for the new owner ("...nobody could review it for the new owner"). That last check looks only at the lasting seats, from the assigner's own seat up the line (a person who left or who no longer holds `task.review` is passed over; the Owner reviews only for his direct reports) and ignores who is away today: with the Director away and the CTO as his stand-in on the leaver's last day, the Director's tasks still move to the CTO, because the Director reviews them when he is back. A task that is submitted or under review is finished work: it is **kept** with the person who did it so it can still be approved (open question 1). A series stops in the same cases. After a run that changed something, the new owner gets ONE mail listing what moved, what was closed and why, what was kept and which series moved or stopped, and every other assigner of a closed task gets one mail listing his closed tasks. A failed mail is only logged, and a repeated event mails nothing | Nobody reviews their own task; the Owner owns no work; the assigner must stay above the work, so a task never climbs the line |
| 14 | A series stops by itself (history line, audit entry) when its assignee or its assigner has left, or the assigner no longer holds `task.assign`, or the assignee is no longer below the assigner. This is checked on every run, not only when the series is made. A series whose first task starts in the past stands at today: the days that are already over are not made up (a start in the future is kept) | Nobody is left to do or review it, or it would assign outside the assigner's line |
| 15 | Reassigning is allowed while the task is assigned, in progress, rework or on hold, only to someone below the assigner; it writes history and audit but no event and no mail (reminders follow the new person on their own) | Design note |
| 16 | "Tasks touched" in the daily summary is read from the task tables (work tasks only, distinct tasks per person per Pakistan day), replacing Module 4's default count of recorded actions | The number should not depend on the recorder's wording |
| 17 | Deadlines are compared on Pakistan days; a suggested deadline is 18:00 on the last working day; the working days given are the days AFTER the start day up to the deadline day (the start day itself is never counted) | One count on the server and in the sheet |
| 18 | The demo holidays are real Pakistani public holiday dates (Eid dates marked "expected") for December 2026 to August 2027; they are placeholders until the Director edits the calendar | A calendar of nothing would hide the skip-holiday rule |
| 19 | The approvals screen shows the server's task items next to the demo items of the modules that are not live yet, so nothing appears twice | Later modules will go live one by one |
| 20 | `POST /approvals/:id/{approve\|reject}` answers 201 `{ ok: true }` | It is a new resource of the shared inbox; the screen reads no status |
| 21 | The assigner's powers (hold, resume, cancel, edit, move the deadline, add a step, attach and remove files, stop a repeat) belong to the assigner while he is here and holds `task.assign`. When he has left, or no longer holds `task.assign`, the first person up the assignee's line who holds `task.assign` acts as the assigner (`GET /tasks/:id` returns `actingAssigner`, so the screens show the buttons). The real assigner stays in the history and as `assignedBy`. A stand-in for an assigner who is only away does NOT get these powers: he reviews tasks and decides extensions (decision 8), nothing more. Never the person doing the task, never for a personal to-do | Tasks assigned by someone who left could otherwise never be held, cancelled or edited |
| 22 | `GET /tasks` shows every open task, and the approved or cancelled tasks closed in the last 90 days. `closed=all` brings back the older ones; `open=true` leaves out every closed task (the profile and the leaver dialog ask for open work only). The task list screen asks for `closed=all` while its status filter shows All statuses, Approved or Cancelled | The screens expect a plain list; a company that closes tasks every day would otherwise send every task ever made |
| 23 | `startDate`, `deadline` and `requestedDeadline` must fall between 2020-01-01 and 2100-12-31 (validation error), and a deadline more than 731 days after the start is refused with `deadline_too_far` (create, edit, personal to-dos too) | A typo such as the year 20260 must not reach the working-day count |

## Deferred

| Item | To | Ready now |
|---|---|---|
| Projects and clients as a module (create, edit, profit by project) | Later finance and billing modules | `projects` table and `GET /projects` with demo rows; `tasks.project_id` |
| Department goals | Performance, goals | `tasks.goal_id` stored as text |
| Leave days shaded on the calendar and the "Mariam is on leave" warning in the assign sheet | Module 7 (attendance and leave) | The holiday calendar table is shared with attendance and payroll |
| The Settings screen for the size table and the holiday calendar (the screen still edits its own demo table) | Module 12 | `GET /settings/task-sizes`, `PATCH /settings/task-sizes/:size`, `GET /settings/task-sizes/changes`; holidays are read-only through `GET /holidays` |
| In-app notifications (bell) for reminders, mentions and decisions | Module 12 | Mail and the events `task.reminder.due`, `task.comment_added`, `task.status_changed` |
| Scorecard, on-time rate, extension counts shown | Module 6 | Events `task.approved`, `task.reworked`, `task.deadline_changed`; tables `task_reviews`, `task_extensions` |
| A task picker in Comms for people without team scope (`scope=all` returns only the tasks the person may see) | Module 14 | `GET /tasks?scope=all` |
| Board drag rules for a stand-in reviewer or an acting assigner (the board assumes the task's own assigner reviews and acts; the task page is right) | Later screen polish | The task page uses the server's `reviewer` and `actingAssigner` |
| Demo task data still read by other screens: the Attendance leave-clash count in the approvals provider (`attendance/approvals.ts`, `attendance/api.ts`), the Performance scorecard inputs (`performance/api.ts`) and the Comms message and meeting task badges (`comms/api.ts`) | Module 7 (Attendance), Module 6 (Performance), Module 14 (Comms), when they go live | The leave card's own clash line already uses the live task list; the Comms task picker (Link task dialog) is live |
| Moving an open task to a new manager when a person only changes manager (not a leaver) | Later | `TaskHandover.transfer` |
| Browser test run | Later | `e2e/m5-live.spec.ts` is written; `e2e/playwright.config.ts` has `m5` in the live list; it has not been run |

## Open questions for the project owner

1. **Hand-over of finished work.** A task that is submitted or under review when its owner leaves moves to the manager
   like any other, unless the manager could not take it (he assigned it himself, he is not below the person who assigned
   it, or nobody could ever review it for him; an absence today does not count): then it is kept with the leaver so his work can still be approved. A task
   that moves is credited to the manager when it is approved. Say if finished work should always stay with the person
   who did it.
2. **Pending extension on a task that is closed** (by hand-over, cancellation or approval) stays pending in the database.
   It is no longer listed in **Approvals**, and deciding it answers `409 invalid_state` (decision 8). The task page
   no longer shows Approve and Reject for it (the server would answer 409). Say if closing a task
   should reject or withdraw its pending request instead, so Module 6 sees no request left open.
3. **Overdue notices to the manager** are sent to the assigner and to the assignee's manager (often the same person).
   Say if only one of them is wanted.
4. **Closing tasks on hand-over.** The plan says the leaver's open tasks "move to the manager". The owner never
   confirmed what should happen when they cannot (decision 13): they are closed with a history line, the new owner and
   the assigner are told by mail, and finished work is kept for its review. Say if such tasks should go somewhere else,
   for example to the person who assigned them or to the next person up the line.

## Known limits

1. A reminder or series job that is running at the very moment its task's deadline is moved can have its re-arm
   overwritten by the job runner's final update (a few milliseconds). Not handled; the next change re-arms it.
2. The approvals inbox works out the reviewer for each waiting task one by one (a few queries each): fine for this
   company, worth caching if the task count grows large.
3. The background catch-up of repeating series is switched off with `OUTBOX_DISPATCH_INTERVAL_MS=0` (the tests do this);
   there is no separate switch.
4. Mails are not sent for personal to-dos, to the person who did the action, to people who left or to people without an
   official address.
5. A reassigned task sends no mail to its new owner (decision 15).
6. A pending extension request on a task that is already closed (approved, cancelled, or closed by hand-over) stays
   pending (open question 2). It is not listed in **Approvals** and the task page hides its Approve and Reject buttons
   (the server answers `409`).
7. The task list leaves out tasks closed more than 90 days ago unless `closed=all` is asked for (decision 22). The Board
   and Calendar views show the default window.
8. The website has no unit-test runner, so no test in the repository pins the browser's working-day counter
   (`frontend/src/lib/dates.ts` `workingDaysBetween`, used by the Assign sheet hint and by payroll's working days). It
   uses the same arithmetic as the server's counter (`backend/src/tasks/rules/task-deadlines.ts`, unit-tested); its
   equality with the old day-by-day count was checked once over thousands of random ranges in several time zones.

## For the people building Module 6 and later

- Events to consume (`docs/EVENTS.md`): `task.approved` has everything a scorecard needs (rating, `onTime`,
  `extensionsCount`, `reworkCount`, size, points, deadline and original deadline). Points are frozen on the task, never
  read from the size table again.
- Data: `task_reviews` (every approval and rework), `task_extensions`, `task_history`, `tasks.points`,
  `tasks.extensions_count`, `tasks.rework_count`.
- The shared approvals inbox: a module calls `ApprovalsInbox.register(provider)` (see `task-approvals.provider.ts`).
- Holidays: `TaskSettingsService.holidays` / `holidayDays`; Module 7 and payroll use the same table.

## Switching the screens to the live API

The Tasks screens and the Approvals inbox use the real server when Module 5 is in the live list. In
`frontend/.env.local`:

```
NEXT_PUBLIC_LIVE_MODULES=m1,m2,m3,m4,m5
NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
```

(or `NEXT_PUBLIC_API_MODE=live` for every module). Restart `npm run dev -w aceva-digital-system-web` after changing it.
Module 5 live needs Modules 1 to 3 live (people, sessions). Without `m5` the screens keep the demo data. The switch is
`isLive("m5")` in `frontend/src/features/tasks/api.ts` and `frontend/src/features/approvals/api.ts`. The Home widgets
and the Comms task picker (the Link task dialog) read the same tasks API, so they follow it. The Comms message and
meeting task badges, the Performance scorecard inputs and the Attendance leave-clash count in the approvals inbox keep
reading demo task data until their own modules go live (see Deferred).

## How to check M5 by hand

Everyone signs in with their Emp-ID and the password `Aceva12345`. The CEO / Founder / Owner, the Director and the CTO
also enter the 6-digit code from their authenticator app. Times on screen are Pakistan time. PostgreSQL and Redis run as
Windows services on this machine. Run every command from the project folder.

The SQL in these steps is typed into `psql`, the PostgreSQL prompt, on the `aceva_dev` database (the demo data):
with Docker, `docker compose exec postgres psql -U aceva_app -d aceva_dev`; with PostgreSQL as a Windows service, the
`psql` that comes with PostgreSQL, connected to `aceva_dev` as `aceva_app` (the password is in `backend/.env`). Type
`\q` to leave. Each query below is one line you paste at that prompt.

**Get ready (once)**

1. Start Mailpit: open a terminal and run `mailpit` (leave it open; the inbox is http://127.0.0.1:8025). If an API from
   an earlier check is running on port 4000, stop it with Ctrl+C: it has the old code.
2. Build the shared contracts and create the Module 5 tables: `npm run build:contracts`, then `npm run db:migrate`
   (applies `20261116100000_m5_tasks`), then `npm run db:seed` (adds the five demo projects and the holidays; safe to
   run again). Check the size table in psql:
   `SELECT size, hours, points, days FROM task_size_settings ORDER BY hours;`.
   Expected: five rows, XS 2 h 1 pt, S 4 h 2 pt, M 16 h 3 pt 3 days, L 40 h 5 pt 7 days, XL 48 h 0 pt with no days.
3. Start the API: `npm run build -w backend`, then `npm start -w backend` (http://localhost:4000).
4. In `frontend/.env.local` set `NEXT_PUBLIC_LIVE_MODULES=m1,m2,m3,m4,m5` and
   `NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1`, then `npm run dev -w aceva-digital-system-web` and open
   http://localhost:3000 (type `localhost`, not `127.0.0.1`).
5. Use two browser windows that do not share sign-ins: **Window A** = Chrome, **Window B** = a Chrome private window.

**Assigning: only down the line, with the size and deadline rules**

6. Window A: sign in as **ACV-0004** (Omar Farooq, CTO). Open **Tasks**. Expected: an **Assign task** button and the
   views My tasks, List, Board, Calendar and Workload. Click **Assign task**. In **Assign to** expect only the
   developers and SQA of his line: Fahad Khan (ACV-0006), Mariam Shah (ACV-0007), Ali Raza (ACV-0008), Danish Iqbal
   (ACV-0011) and Nida Aslam (ACV-0013). Not the Director, not Sales, not himself.
7. Create the first task: title `Hand check: login page`, assign to **Mariam Shah**, project Northwind Studio website,
   size **M** (the first time the sheet opens in a session it waits a moment with a skeleton while it reads the Director's size table and the holidays; then the hours fill in as 16 and the deadline as 3 working days ahead at 18:00), add two checklist lines
   (`Agree the details` and `Build it`), press **Assign**. Expected: it appears in the list with number TSK-0001 (or the
   next number), status Assigned, 3 pts.
8. The deadline rules. Open the sheet again (nothing is saved while you only look).
   - Change the Deadline to the next working day at 18:00 with size M. Expected: the warning "An M task usually needs 3
     working days; you set 1. You can continue." (amber). Do not assign; close the sheet.
   - Type a Deadline in the past. Expected: "A deadline can't be in the past." (red) and Assign cannot be used.
   - Choose size **XL**. Expected: "XL tasks must be split into smaller tasks before they are assigned."
   - Set the Start date to 24 December 2026 and size **S**. Expected: "Suggested: Monday ... 28 December": the 25th is
     the demo holiday and the weekend follows. Close the sheet.
9. Overload. In the sheet assign a size **L** task to **Nida Aslam** (an intern with 20 hours a week). Expected: the
   week bar turns red and the sheet warns that her week goes over 20 h (40 h of 20 h). Press **Assign** anyway.
   Open the **Workload** view. Expected: Mariam 16 h of 40 (the sheet waited for the server's size table in step 7, so her task has 16 h), Nida 40 h of 20 in red, the others 0.

**The developer's work, extensions and the review**

10. Window B: sign in as **ACV-0007** (Mariam Shah). Open **Tasks**. Expected: TSK-0001 is listed in **My tasks**;
    there is no Assign task button and no Workload view. In Mailpit (http://127.0.0.1:8025) there is a mail "New task TSK-0001:
    Hand check: login page" to mariam@acevatech.com. Open the task: **Start work**, then tick the two checklist steps.
11. Add a comment `@ACV-0004 can you look at the colours?` and attach a small PDF or PNG with **Attach file**.
    Expected: the comment shows the mention highlighted, the file is listed, and clicking it downloads the same file.
    Mailpit has "Mariam Shah mentioned you on TSK-0001" to omar@acevatech.com within a few seconds.
    Access rule: still as Mariam, open **Tasks** and then **Performance**. As the Director, search Mariam's records in the
    Module 4 activity views for blocked attempts: there is no "Tried to open Tasks (no permission)" record, because the
    screens do not ask for manager-only data (the team list, the workload) and the Assign task sheet is only loaded for
    people who hold `task.assign`.
12. Click **Request more time**, choose a date three days later, give a reason, send. Expected: the button now reads
    "Extension requested". Window A (Omar): open TSK-0001. Expected: an "Extension requested" card with Approve and
    Reject, and the same item in **Approvals** (type "Extension"). Click **Approve**. Expected: the deadline is the new
    date and the original deadline is still shown next to it; Mailpit has "Extension approved: TSK-0001" for Mariam.
13. Window B: **Submit for review**. Expected: status Submitted; Mailpit has "Waiting for your review: TSK-0001" to
    omar@acevatech.com. Mariam has no Approve button on her own task.
14. Access rule: Window A, sign out and sign in as **ACV-0003** (Bilal Ahmed, Director), open TSK-0001. Expected: he
    sees the task (everyone above Mariam does) but has no Approve or Send to rework button: the reviewer is Omar, who
    assigned it. Then sign in as **ACV-0001** (Hamza Qureshi, the CEO / Founder / Owner): he sees TSK-0001 in **Tasks**
    but there is no Assign task button, and on the task page no comment box, no Attach file and no action buttons.
15. Sign in as ACV-0004 again. Open **Approvals**. Expected: "TSK-0001" waits as a review with a rating prompt.
    Choose 4 stars and approve (the inbox has no comment box). Expected: the task is Approved. Mailpit has "Approved:
    TSK-0001" to Mariam with the rating. Open the task: **History** lists every step with who did it and when, and the
    review. To approve with a comment as well, use **Approve with rating** on the task page instead: its **Comment
    (optional)** box is the only place for it.
16. Rework: as ACV-0004 assign a second task `Hand check: reports` to Mariam (size S). As Mariam start and submit it. As
    Omar click **Send to rework**, give a reason. Expected: Mariam sees "Sent back for rework" with the reason and a
    **Start rework** button; Mailpit has "Sent back for rework". Leave this task as it is for step 23. Also assign a
    third task `Hand check: spare` to Mariam (size S) for the next two steps.

**Manager controls**

17. As Omar open `Hand check: spare` and click **Change deadline**: a reason is required. Expected: the new deadline
    shows, "original" keeps the first date, History has a line with both dates and the reason.
18. On the same task **Put on hold** with a reason: status On hold, Mailpit "Put on hold: ...". **Resume**: back to In
    progress. Then **Cancel task** with a reason: status Cancelled, Mailpit "Cancelled: ...". A cancelled task has no
    more actions.

**Personal to-dos**

19. Window B (Mariam): in **My tasks**, **My to-dos**, add `Buy a new charger`. Tick it done. Expected: it is done at
    once, with no review and no rating. Window A (Omar): open
    http://localhost:4000/api/v1/tasks?scope=all&includePersonal=true. Expected: no task numbered TODO-... in the
    answer; the same for the Director and the Owner. Only Mariam's own list shows it.

**Reminders (the job runner checks every 30 seconds)**

20. As Omar assign Mariam a size **XS** task `Hand check: reminders`: Start date today, Deadline **5 minutes from now**.
    Do not start it. Wait about five minutes. Expected: Mailpit gets "Due now: TSK-..." to mariam@acevatech.com, and
    in the list the task turns red with "Overdue". Create another XS task with the Deadline set to **24 hours and 3
    minutes from now**: after about three minutes Mailpit has "Due in 24 hours: TSK-...". The daily "Overdue:" mail
    goes out at 09:00 Pakistan time every morning after the deadline, to Mariam and to Omar (who assigned it and is
    her manager).

**Repeating tasks**

21. As Omar assign Mariam a size S task `Hand check: weekly report` with Repeat **Every week** on Monday (or any day)
    and a stop date three months ahead. Expected: the task page says it repeats weekly until that date and shows
    **Stop repeating**. Look at the series:
    `SELECT every, active, last_occurrence_on FROM task_repeat_rules;` in psql
    (one row, active) and
    `SELECT dedupe_key, run_at, status FROM scheduled_jobs WHERE type = 'task.repeat';`
    (one pending job `task.repeat:<id>:<next Monday>`, due at 00:05 Pakistan time, which is 19:05 the evening before in
    UTC). Click **Stop repeating** with a reason. Expected: "This task will not repeat any more"; the same two
    queries now show `active = false` and no pending job.

**Nothing can be edited or deleted**

22. In psql: `UPDATE task_reviews SET rating = 1;` and `DELETE FROM task_history;`. Expected: both refused ("... is insert-only:
    rows cannot be changed or removed"). `SELECT * FROM task_size_setting_changes;` returns no rows (the size table has not been changed; changing it is covered by the database tests).

**Stand-in reviewer (Module 1 rule)**

23. As Omar open **Org and access**, tab **Stand-ins**, add a stand-in (**I'm away: add a stand-in**): the Director,
    from today to the day after tomorrow. As Mariam open the task of step 16 (`Hand check: reports`), **Start rework**
    and **Submit for review**. Expected: the Director (the stand-in) now has "Approve with rating" on it and it waits in
    the Director's **Approvals**; Omar no longer has the button. End the away period (the **Stand-ins** list) and the
    review is Omar's again.

**The leaver hand-over (do this last: it ends a demo person's employment)**

24. As the Director (ACV-0003) assign `Hand check: leaver task` to **Danish Iqbal** (ACV-0011). As Omar (ACV-0004) assign
    `Hand check: closed on leaving` to Danish too. As the Director open People, Danish Iqbal, **Last working day**.
    Expected: the dialog says there are 2 open tasks. Set yesterday as the last working day and save. Expected, as
    Omar in **Tasks**: `Hand check: leaver task` now belongs to Omar, with a History line "Employee left"; `Hand check:
    closed on leaving` is Cancelled with "Closed on hand-over: the assigner takes over" (Omar assigned it, so he cannot
    review it himself). Danish can no longer sign in. To get him back: `npm run db:reset -w backend`, `npm run db:seed`,
    then `DEMO_PASSWORD=Aceva12345 npm run db:seed:passwords -w backend`, and run steps 2 to 3 again if you want the
    demo data of this module.

**Optional, only on a database you are going to reset: tasks of someone who left**

25. A series stops when the assignee leaves the assigner's line. As Omar assign Mariam a size S task `Hand check: moved
    series` repeating every week. In **Org and access** move Mariam to report to the Director. In psql run
    `UPDATE scheduled_jobs SET run_at = now() WHERE type = 'task.repeat' AND status = 'pending';` and wait up to 30
    seconds (the job runner checks every 30 seconds). Expected: `SELECT active FROM task_repeat_rules WHERE title = 'Hand
    check: moved series';` shows `false`, and the History of the task says the series was stopped because the person
    doing it is no longer in the reporting line of the person who set it up. Move Mariam back under Omar afterwards.
26. Acting assigner. As the Director open People, Omar Farooq, **Last working day**, set yesterday and save (this ends
    the demo CTO: restore as in step 24). Open `Hand check: reports` (assigned by Omar to Mariam). Expected: the Director
    now has **Put on hold**, **Change deadline** and **Cancel task** on it, and the review is his. Click **Cancel task**
    with a reason. Expected: status Cancelled; the History line names the Director, and the task still shows Omar as
    **Assigned by**.

**Database tests**

27. With PostgreSQL and Redis running: `npm run build:contracts`, then `npm test -w backend -- m5-` (the three Module 5
    files: `m5-foundation`, `m5-core`, `m5-automation`), or `npm test` for everything. They use the `aceva_test`
    database (rebuilt for every run) and send no real mail. Each Module 5 file takes about 25 to 40 seconds.

## Verification run for this build

Run after the review fixes (all on this machine, with PostgreSQL 17 and Redis running):

- `npm run typecheck` (contracts, backend, frontend): 0 errors.
- `npm run lint`: 0 errors, 9 warnings (the same 9 as before Module 5, none in Module 5 files).
- Backend unit tests (`backend/src/**/*.test.ts`, no database): 23 files, 332 tests, all passing; 152 of them are
  Module 5 tests (140 in the seven rule files `src/tasks/rules/*.test.ts`, 12 in `task-workflow.service.test.ts`).
- Contract tests (`npm run test -w @aceva/contracts`): 28 tests, all passing (12 new for the task contracts).
- Database tests: `m5-foundation` 22, `m5-core` 68, `m5-automation` 38, all passing. The full `npm test` (contracts and
  every backend test of Modules 1 to 5, the unit tests included): 28 contract tests and 43 backend test files with 800
  tests, all passing.
- Not run: `e2e/m5-live.spec.ts` (it lists and parses, 8 tests; running it needs the production website build) and the
  screens in a browser.
- Found and fixed during the integration run: the stand-in test used a reason that was too short; the mention test
  expected the wrong order; two automation tests counted rows left by earlier tests; a repeating series stopped from the
  task page did not remove its waiting job (the job key changed to one per day); the sheet counted the working days
  differently from the server when the start day is a weekend; and `m3-leaving.test.ts` assumed a fixed three days and an
  hour, which crossed midnight in Pakistan when it ran after 23:00 there.
  The "Last working day" dialog now shows the number of open tasks that will move when Module 5 is live, and the Module 3
  browser test accepts either wording.
