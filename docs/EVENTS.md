# Event contracts (outbox)

How one module tells other modules what happened, without those modules having to exist yet, and how the receiving
module (the "consumer") gets the event.

## How it works

1. When something happens (a login, a logout, an employee leaving...), the module writes **one row** to `outbox_events`,
   in the **same database transaction** as the change itself (or straight after it for logins). The row exists if and
   only if the change happened.
2. Every event is checked against its **schema** (`packages/contracts/src/events.ts`) before it is saved. A malformed event
   cannot be stored.
3. The **outbox dispatcher** (`backend/src/events/outbox-dispatcher.service.ts`, Module 4) hands each event to every
   consumer registered for its `type` and `version`, then sets `processed_at`. Events that nobody consumes yet simply wait
   in the table (for example the Module 3 leaving events until Modules 5 and 8 exist).

## The envelope

| Column | Meaning |
|---|---|
| `id` | Unique event id (UUID). Consumers use it to ignore duplicates |
| `type` | For example `auth.login` |
| `version` | Integer. A breaking change to a payload means a NEW version (2); version 1 is never edited |
| `actor` | The Emp-ID of whoever caused it, or `system` |
| `payload` | JSON, shaped by the schema of that `type` and `version` |
| `occurred_at` | When it happened (UTC) |
| `processed_at` | Set by the dispatcher when every consumer of the event has handled it (null = not yet, or nobody consumes it) |
| `attempts`, `next_attempt_at`, `last_error` | Delivery tries so far, when the next try is due, and the last failure (Module 4) |
| `locked_until`, `locked_by` | Which server is handling it right now (a claim that runs out after 2 minutes if that server dies) |

`outbox_deliveries` has one row per (event, consumer) once that consumer has handled the event.

Payloads contain Emp-IDs (never internal UUIDs) and never contain passwords, tokens, cookies, CSRF tokens, 2FA secrets or
pay figures. A test checks this.

## Module 2 to Module 4 (activity tracking), version 1

| Event | When | Payload |
|---|---|---|
| `auth.login` | A password was accepted and a session created | `empId`, `sessionId`, `ip`, `userAgent` |
| `auth.login_failed` | A wrong password, a locked or disabled account, a wrong authenticator code, or a refused (rate-limited) attempt | `empIdAttempted` (what was typed), `empId` (set only if it matched a real person), `reason` (`invalid_credentials`, `locked`, `rate_limited`, `two_factor_failed`, `disabled`), `ip`, `userAgent` |
| `auth.logout` | A session ended, whatever the cause | `empId`, `sessionId`, `reason` (`user`, `idle_timeout`, `max_duration`, `password_changed`, `forced`, `employee_left`, `user_other_device`, `too_many_wrong_codes`) |
| `auth.security` | A security change on an account that is not a login or logout | `empId` (whose account), `kind` (`password_changed`, `password_reset`, `two_factor_enabled`, `two_factor_disabled`, `two_factor_reset`, `account_locked`, `account_unlocked`, `temporary_password_set`), `byEmpId` (the administrator, or null when the person or the system did it: 5 wrong passwords lock the account) |

Every login, every failed login and every logout produces exactly one event. Sessions that time out while nobody is making
requests are ended by a once-a-minute sweeper, which also produces the `auth.logout` event. `idle_timeout` is also written
by a request that finds the session past its limit, and by `POST /auth/logout` when the browser reports its idle timer and
the session really was idle that long (the limit minus a 2-minute tolerance: 28 minutes normally, 8 on a finance screen).
A claim made too early ends the session with reason `user`. `user` means logged out in that same session.
`user_other_device` means the session was ended from another device in "My devices"; Module 4 does not count it as a
signal from that session. `too_many_wrong_codes` means 5 wrong authenticator or step-up codes ended the session. `auth.security` is written by
`AuthService` for: the lock after 5 wrong passwords (`byEmpId` null), a lock by an administrator (Module 4 control),
unlocks, password changes and resets, a temporary password (set by the Director or HR, or the resend of a welcome email),
two-step login switched on, off or reset.

**Consumer (Module 4, `activity.auth`):** turns each event into one activity record (`activity_events`, dedupe key
`outbox:<event id>`), and raises the alerts that follow from it: a sign-in from a new device or a new city, a sign-in outside
working hours, the account locking itself after 5 wrong passwords. A failed login whose Emp-ID matched nobody has no
activity record (activity belongs to a person); Module 2's `login_attempts` keeps it.

## Module 4 internal, version 1

| Event | When | Payload | Consumer |
|---|---|---|---|
| `activity.flagged` | The activity recorder saved a record an alert rule must look at: a refused finance attempt, a salary/bank/payslip view, an export. Written in the same transaction as the record. A salary, bank or payslip view of the person's own Emp-ID is not flagged (the recorder passes `target` and `empId` to `flagFor`); the alert rule counts only other people's records either way | `eventId`, `empId`, `kind` (`finance_blocked`, `salary_view`, `export`), `at`, `module`, `rows` (exports only) | `activity.alert-rules`: large exports, many salary records in an hour, repeated finance attempts in 15 minutes |
| `activity.alert.raised` | A security alert was stored (same transaction) | `alertId`, `kind`, `severity`, `empId` | `activity.alert-mail`: emails the Director and the CTO. Module 12 (notifications) can consume it too |

## Module 3 to Modules 5, 8 and 12 (produced by M3), version 1

| Event | Intended consumer | Payload |
|---|---|---|
| `employee.offboarded` | M8, M12 (no consumer yet) | `empId`, `lastWorkingDay`, `managerEmpId` |
| `task.transfer.requested` | M5 task management (`tasks.handover`, consumed now) | `fromEmpId`, `toEmpId`, `reason: "employee_left"` |
| `payroll.final_settlement.requested` | M8 payroll (no consumer yet) | `empId`, `lastWorkingDay` |

`employee.offboarded`, `task.transfer.requested` and `payroll.final_settlement.requested` are written to the outbox when an
employee's last working day is processed (`backend/src/people/offboarding.service.ts`). `task.transfer.requested` is consumed
by Module 5 (see below): it moves the leaver's open work tasks and active repeating series to the manager. The other two
wait in `outbox_events` (unprocessed) until their consumers are registered (Module 8, Module 12).

## Module 5 (tasks, size and deadline), version 1

Tasks are written in the same transaction as the change. Only **work tasks** emit events: a personal to-do emits nothing
at all (not created, not status, not deadline), and reassigning a task emits nothing (it writes history and the audit
entry, but no event and no mail). Payloads are in `packages/contracts/src/events.ts`; every one carries `taskId` and
`number` (`TSK-0001`).

| Event | When it is written (emission point) | Payload | Consumers |
|---|---|---|---|
| `task.created` | A work task is created (`POST /tasks`, actor = the assigner), or a repeating series makes its task (actor `system`). `repeatRuleId` is set for a series task | `assignee`, `assignedBy`, `personal` (false), `size`, `points`, `estimatedHours`, `startDate`, `deadline`, `repeatRuleId` | `tasks.reminders`, `tasks.repeat`, `tasks.mail` (new task) |
| `task.status_changed` | Every status action on a work task: start, submit, review, approve, rework, hold, cancel, resume. `reason` is set for rework, hold and cancel, and carries the comment for approve. Also the hand-over close (actor `system`; reason "Closed on hand-over: ..." with one of four endings: the assigner takes over, the new owner only has view access, the new owner is not below the person who assigned it, nobody could review it for the new owner) | `assignee`, `assignedBy`, `from`, `to`, `reason` | `tasks.reminders`, `tasks.mail` (handed in, approved, rework, hold, cancel) |
| `task.approved` | Approve, with the rating. `deadline` is the approved deadline; `onTime` means handed in at or before the deadline in force, except that an approved extension that was asked for AFTER the deadline (`task_extensions.late`) does not rescue the task: it is judged against the deadline that was in force when the first such request was made | `assignee`, `reviewer`, `rating` (1 to 5), `size`, `points`, `estimatedHours`, `deadline`, `originalDeadline`, `startedAt`, `submittedAt`, `onTime`, `extensionsCount`, `reworkCount` | none yet (Module 6) |
| `task.reworked` | Rework (sent back with a reason) | `assignee`, `reviewer`, `reason`, `reworkCount` (this one included) | none yet (Module 6) |
| `task.deadline_changed` | The manager changes the deadline (`kind: manager_change`, with the reason), or an extension is approved (`kind: extension_approved`). Reminders are re-armed | `assignee`, `assignedBy`, `from`, `to`, `kind`, `reason` | `tasks.reminders` |
| `task.extension_requested` | The assignee asks for more time. `late: true` when asked after the deadline | `extensionId`, `assignee`, `assignedBy`, `currentDeadline`, `requestedDeadline`, `late` | `tasks.mail` (asked) |
| `task.extension_decided` | The assigner approves or rejects the request. `newDeadline` is set only when approved | `extensionId`, `requestedBy`, `decidedBy`, `decision` (`approved` or `rejected`), `newDeadline`, `late` | `tasks.mail` (decided) |
| `task.comment_added` | A comment is saved on a work task. `mentions` are the Emp-IDs it @mentioned | `commentId`, `assignee`, `assignedBy`, `mentions` | `tasks.mail` (mention mail) |
| `task.transferred` | The hand-over moves an open task to the manager (actor `system`, reason `employee_left`) | `fromEmpId`, `toEmpId`, `reason` | `tasks.reminders` (the new person gets the reminders) |
| `task.reminder.due` | A reminder job finds its reminder due. Written once per task, kind and Pakistan day, so a retried job never writes a second | `kind` (`half_time`, `day_before`, `deadline`, `overdue`), `recipients` (Emp-IDs), `deadline`, `day` | `tasks.mail` (the reminder mails) |

No new event types come with the hand-over rules: a task that is closed because the new owner is not below the assigner, or would have no reviewer, writes the same `task.status_changed` as the other hand-over closes. The mails the hand-over sends (one to the new owner listing what moved, was closed or was kept, and one to every other assigner of a closed task) are not events.

**Consumers of Module 5 events** (the names never change; each handler is idempotent):

| Consumer | Consumes | Does |
|---|---|---|
| `tasks.reminders` | `task.created`, `task.status_changed`, `task.deadline_changed`, `task.transferred` | Arms, re-arms or removes the reminder jobs of the task |
| `tasks.repeat` | `task.created` | Arms the next job of a repeating series |
| `tasks.handover` | `task.transfer.requested` (Module 3) | Moves or closes the leaver's open work tasks and series |
| `tasks.mail` | `task.created`, `task.status_changed`, `task.comment_added`, `task.extension_requested`, `task.extension_decided`, `task.reminder.due` | Sends the mails through the mailer |

**Mails (`tasks.mail`)**: a new task; the reminders (half the time passed, due in 24 hours, due now, overdue); a mention; a
task handed in (to the assigner); an approval (with the rating); a rework; a hold; a cancellation; an extension asked and
decided. Never to the person who did the action, never for a personal to-do, never to a person who has left, and never to
someone without an official address. Locally the mails arrive in Mailpit (http://127.0.0.1:8025).

### Scheduled work (job runner, no BullMQ)

The job runner checks its jobs every 30 seconds. Every job has a unique key (the dedupe key). Arming the same key again
re-arms that one job; it never adds a second.

| Job | Key | When | What it does |
|---|---|---|---|
| Half-time, 24-hours-before and deadline reminders | `task.reminder:<taskId>:half_time`, `task.reminder:<taskId>:day_before`, `task.reminder:<taskId>:deadline` | Half the time between start and deadline, if not started; 24 hours before the deadline; at the deadline | Writes `task.reminder.due` (recipient: the person doing the task) |
| Daily overdue notice | `task.reminder:<taskId>:overdue:<Pakistan day>` | 09:00 Pakistan time each day after the deadline | Writes `task.reminder.due` (kind `overdue`) to the assignee, the assigner and the assignee's manager. People who have left get nothing. One job per day, because the job runner marks a job finished when its handler returns: the handler then arms the next day's job |
| Repeating task | `task.repeat:<ruleId>:<occurrence day>` | 00:05 Pakistan time on the occurrence day | Makes the task (writes `task.created`, actor `system`) and arms the next day. Start-up and an hourly check arm any series that has no job; after downtime at most the newest 3 tasks are made. Stops at its stop date or when it is stopped, or when its assignee or assigner has left, or the assigner no longer holds `task.assign`, or the assignee is no longer below the assigner (checked on every run). The hourly check also removes finished reminder and repeat jobs older than 14 days |

A reminder whose job runs **more than 2 hours** after its planned time is **dropped**, never sent late (the daily overdue
notice: more than 20 hours). Before a reminder is sent the job asks again whether it still applies (the task may be on
hold, approved, cancelled or moved), so a stale job sends nothing. The reminders and the repeating tasks need the API
running with `OUTBOX_DISPATCH_INTERVAL_MS` above 0 (the default 5000; `0` switches them off, as the tests do).

### Module 4 daily summary: "tasks touched"

The "tasks touched" number in the daily summary (`GET /activity/summaries`) is now read from the task tables: a task
counts for a person when they wrote a history line, a comment, ticked a step, added a file, asked for more time or
decided a request, or reviewed it. Work tasks only, one count per distinct task per person per Pakistan day. It no longer
counts recorded actions.

## Module 6 (performance and results), version 1

Written in the same transaction as the change. Payloads are in `packages/contracts/src/events.ts`. The scorecard events
carry `scorecardId`, `empId` and `month` (a Pakistan month); the ones that are about a whole scorecard also carry `kind`
(`standard` or `sales`). No mail carries a score.

| Event | When it is written | Payload | Consumers |
|---|---|---|---|
| `scorecard.drafted` | The monthly job made a draft scorecard (actor `system`) | `scorecardId`, `empId`, `month`, `kind`, `reviewer` (null for the Director), `score` (null when nothing is measurable), `taskCount`, `smallSample` | none (no consumer) |
| `scorecard.released` | The reviewer released a draft (actor = the reviewer, `releasedBy` the same, `automatic` false). Or the monthly job released the Director's scorecard (actor `system`, `releasedBy` null, `automatic` true) | `scorecardId`, `empId`, `month`, `kind`, `releasedBy`, `automatic`, `hasRemark` | `performance.mail` (mails the employee) |
| `scorecard.acknowledged` | The employee acknowledged a released scorecard (actor = the employee) | `scorecardId`, `empId`, `month`, `kind`, `reviewer`, `hasComment` | none yet |
| `scorecard.dispute_raised` | The employee disputed a task rating on their released scorecard (actor = the employee) | `disputeId`, `scorecardId`, `empId`, `month`, `taskId`, `taskNumber`, `ratingAtRaise`, `decider` | `performance.mail` (mails the decider) |
| `scorecard.dispute_decided` | The decider upheld or changed the rating (actor = the decider) | `disputeId`, `scorecardId`, `empId`, `month`, `taskNumber`, `decision` (`upheld` or `changed`), `decidedBy`, `ratingBefore`, `ratingAfter` (null when upheld), `scoreBefore`, `scoreAfter` (set when changed, null when upheld or nothing was measurable) | `performance.mail` (mails the employee) |
| `score_weights.created` | The Director saved a new version of the weights (actor = the Director) | `versionId`, `kind`, `departmentId` (null = the company-wide set), `versionNo`, `weights` (whole percents by key), `previousVersionId` (the set this one replaced) | none (no consumer) |

**Consumer `performance.mail`** (the only one): mails the employee when a scorecard is released and when a dispute is
decided, and mails the decider when a dispute is raised. Nobody is mailed a score.

**The reviewer's "drafts are waiting" mail is not an event.** The monthly job sends it itself, directly, once per reviewer
who got new drafts in that run, with a link to `${APP_URL}/approvals`. It is best effort: a mail error is logged and never
fails the job.

### The monthly scorecard job

| Job | Key | When | What it does |
|---|---|---|---|
| Monthly scorecards | `scorecard.monthly:<YYYY-MM>` (type `scorecard.monthly`, payload `{"month":"YYYY-MM"}`) | 00:10 Pakistan time on the 1st of the next month | Makes one draft scorecard for each person scored for the month that just closed (the weights version in force for their kind and department). The Director's is released at once by the system |

- **Who is scored:** everyone who has not left, has a manager and joined before the month ended. The Owner (CEO / Founder) is
  not scored. A person who left before the job runs gets no scorecard.
- **Idempotent:** one scorecard per person and month. A re-run, a retry, or two servers running the job make nothing twice
  and overwrite nothing. A person whose scorecard fails is counted and the job is retried; the retry skips the people
  already done.
- **Scheduling:** on start-up and every hour the server makes sure the job of the month that just closed (due at once if its
  moment has passed, which catches up after downtime) and the job of the current month exist. Older months are never made
  up. Scheduling is off when `OUTBOX_DISPATCH_INTERVAL_MS` is `0` (the tests do that).
- **After a failure:** a job that failed 5 attempts stays `failed`. The only trace is an error line in the server log (each
  earlier failed attempt is a warning); nothing else alerts anyone. To run it again for the month that just closed or the current month, delete its `scheduled_jobs` row
  (dedupe key `scorecard.monthly:<month>`) and the hourly check makes it again. The hourly check creates no job for an older
  month, so for one of those, delete the failed row and insert a new `scheduled_jobs` row by hand (type `scorecard.monthly`,
  the same dedupe key, `run_at` now, payload `{"month":"YYYY-MM"}`). A re-run skips the people already done.
- **First start after this module is deployed:** the month that just closed is made at once. Drafts appear for everyone
  except the Owner, the CTO and the Director get a digest mail (in Mailpit locally), and the Director's own scorecard is
  released.
- **To run the current month by hand** (for a check):
  `UPDATE scheduled_jobs SET run_at = now() WHERE dedupe_key = 'scorecard.monthly:2026-11';` (the job runs within 30 seconds;
  a month that has not started is refused). That run uses up the month's one job: its row ends `succeeded` and is never
  re-armed, so no job runs for that month on the 1st. Anyone who joins, or whose task is approved, after the hand-run gets
  no scorecard for that month. Use it for a check only. This cannot be undone: scorecards are never deleted (see
  `docs/SETUP.md` for starting over).

### Audit actions (Module 6)

The same actions are listed in `docs/API.md` ("M6: performance and results"): `settings.score_weights.created`,
`scorecard.drafted` (no person as the actor), `scorecard.remark`, `scorecard.released`, `scorecard.acknowledged`,
`scorecard.dispute.raised` and `scorecard.dispute.decided`.

**Known limitation.** The decider of a dispute is fixed when the dispute is raised (the database never lets it change). If
that person leaves while the dispute is open, no one else can decide it in this module. Whether the leaver hand-over should
re-route open disputes is for the user to decide.

## Consuming events (for the people building Modules 5, 6 and later)

Do not read `outbox_events` yourself. Register a consumer on the shared dispatcher (it is global, from `CommonModule`):

```ts
@Injectable()
export class TaskTransferConsumer implements OnModuleInit {
  constructor(private readonly dispatcher: OutboxDispatcher, private readonly tasks: TasksService) {}

  onModuleInit(): void {
    this.dispatcher.register({
      name: 'tasks.transfer',                                 // unique, never renamed (deliveries are kept per name)
      handles: [{ type: 'task.transfer.requested', version: 1 }],
      handle: async (event, stored) => {
        if (event.type !== 'task.transfer.requested') return;  // narrows the payload type
        await this.tasks.transferOpenTasks(event.payload.fromEmpId, event.payload.toEmpId, `outbox:${stored.id}`);
      },
    });
  }
}
```

Rules (also in the code comment of `OutboxConsumer`):

- **Idempotent.** A server can crash after your consumer finished but before the delivery was recorded, so the same event
  can arrive twice. Write with a unique key (`dedupe_key = "outbox:<event id>"` and `createMany({ skipDuplicates: true })`,
  or check before writing).
- **Throw to retry.** A thrown error means "try again later": 10 s, 30 s, 2 min, 10 min, 30 min, 1 h, 2 h, 6 h, 12 h, at most
  10 tries; the error is kept in `last_error`. Consumers that already succeeded for that event are not called again.
- **No strict order** between events: they are claimed oldest first, but two servers may handle neighbours at once.
- Several server copies can run the dispatcher: each batch is claimed with `FOR UPDATE SKIP LOCKED` and a 2-minute lease.
- It polls every `OUTBOX_DISPATCH_INTERVAL_MS` (default 5000). Tests set it to 0 and call `OutboxDispatcher.tick()`.
- **Time limit.** Every consumer call has 20 s (`OUTBOX_CONSUMER_TIMEOUT_MS` in `backend/src/events/outbox-rules.ts`). After
  that the try counts as failed ("timed out") and the dispatcher moves on, but the call is **not cancelled**: it may still
  run and finish later. So handlers must be idempotent and safe to repeat while an earlier call may still be running.
- **Slow consumers are paused.** A consumer whose call fails after 5 s or more (a timeout, a slow mail server) is paused for
  60 s on that server. Its events wait, without counting a failed try, while the other consumers and events carry on. Then
  one call is tried again.
- **Lease and shutdown.** The 2-minute lease of the claimed events is renewed while a batch runs. On shutdown the dispatcher
  finishes the event it is handling and hands the rest of its claimed batch back untried.
- A consumer added later receives every event of its type that is still unprocessed (for example the Module 3 leaving
  events, which have no consumer today). An event that other consumers already processed is not delivered again.

Adding a consumer never needs a change to the module that writes the event.

`employee.offboarded`, `task.transfer.requested` and `payroll.final_settlement.requested` are written to the outbox when
an employee's last working day is processed (see `backend/src/people/offboarding.service.ts`).

- `payroll.final_settlement.requested` **is now consumed by Module 8** (`backend/src/payroll/final-settlement.service.ts`):
  it takes the rows with `FOR UPDATE SKIP LOCKED` at every payroll calculation and every 60 seconds, inserts one
  `final_settlements` row per leaver (`ON CONFLICT DO NOTHING`, so an event is never handled twice) and marks the event
  processed. The leaver's line in the run for the month of their last working day is flagged for review (decision D11).
- `employee.offboarded` and `task.transfer.requested` still wait for Module 5 (Tasks) and Module 12.

## Modules 7, 8 and 9, version 1

None of these carry an amount, a salary, a bank number or an employee UUID: people are named by Emp-ID only.

| Event | Producer | When | Payload |
|---|---|---|---|
| `leave.requested` | M7 | A leave request is sent | `requestNumber`, `empId`, `approverEmpId` (null when nobody is above), `from`, `to` |
| `leave.decided` | M7 | A request is approved, rejected or cancelled (since D24 leave has one step, so `forwarded` is no longer sent) | `requestNumber`, `empId`, `decision` (approved, rejected, cancelled, forwarded), `byEmpId`, `nextApproverEmpId` |
| `attendance.correction.decided` | M7 | A correction is approved or rejected | `correctionId`, `empId`, `date`, `decision`, `byEmpId` |
| `payroll.run.ready` | M8 | A run is prepared, waiting for the Director's approval (since D25 `reviewed` is no longer sent) | `runNumber`, `month`, `stage` (prepared, reviewed) |
| `payroll.run.approved` | M8 | The Director approves a run (D25) | `runNumber`, `month`, `approvedByEmpId` |
| `payslip.issued` | M8 | One per employee when a run is approved | `empId`, `month` |
| `ledger.entry.posted` | M9 | A journal entry is posted | `entryNumber`, `source`, `entryDate` |
| `finance.period.reopened` | M9 | The Director reopens a closed month (D25) | `month`, `byEmpId`, `reason` |

Since the Cycle 3 foundation the notification core reads `leave.requested`, `leave.decided`, `attendance.correction.decided`,
`payroll.run.ready`, `payslip.issued` and `finance.period.reopened` (reader `notifications`) and turns them into in-app
notifications and emails (this supersedes D16). See docs/CYCLE3-FOUNDATION.md.
The schemas are in `packages/contracts/src/events.ts`; `OutboxService.emit` refuses a payload that does not match.

## Cycle 3: several readers per event

Readers registered with `OutboxConsumerRunner` record their progress in `outbox_consumptions` (one row per reader and
event, unique), not in `processed_at`, so each reader handles each event exactly once and several readers can read the
same event. `processed_at` stays with the final-settlement reader. A new reader only sees events written after it was
first registered. Details: docs/CYCLE3-FOUNDATION.md.

| Reader | Reads |
|---|---|
| `notifications` | `leave.requested`, `leave.decided`, `attendance.correction.decided`, `payroll.run.ready`, `payslip.issued`, `finance.period.reopened` |
| Final settlements (M8, uses `processed_at`) | `payroll.final_settlement.requested` |
| `billing` (M13) | `ledger.entry.posted` (an approved invoice entry queues its client email once; a posted payment makes an invoice paid: `billing.invoice.paid` once), `sales.deal.won_confirmed` (one handover per deal: a draft for the exact, unique client, or Finance chooses when several clients share the name) |

## Cycle 3: Modules 13 to 15, version 1 (defined in the shared foundation; produced when each module is built)

| Type | From | When | Payload |
|---|---|---|---|
| `sales.deal.won_confirmed` | M15 | A Won deal is confirmed (the Director until there is a sales manager) | `dealNumber`, `ownerEmpId`, `confirmedByEmpId`, `client` (`partyId` or `name`, `email`, `country`), `service`, `value`, `currency` (refined with M13; still produced by nobody until M15) |
| `billing.invoice.issued` | M13 (produced) | An invoice is issued (its ledger entry waits for approval in M9) | `invoiceNumber`, `dueDate`, `sourceDealNumber` |
| `billing.invoice.paid` | M13 (produced) | An invoice is fully paid (its last payment is posted), once per invoice | `invoiceNumber`, `paidOn`, `sourceDealNumber`, `firstForClient` |
| `billing.invoice.overdue` | M13 (produced) | An invoice passes its due date unpaid, once per invoice (daily run) | `invoiceNumber`, `dueDate`, `daysOverdue` |
| `billing.subscription.renewal_due` | M13 (produced) | A subscription or domain enters its alert window, once per renewal date | `subscriptionNumber`, `renewsOn`, `ownerEmpId` |
| `sales.commission.approved` | M15 | The Director approves a commission line | `dealNumber`, `empId`, `approvedByEmpId`, `payrollMonth` |
| `comms.mention` | M14 (produced from M14.1) | Someone is mentioned with an `@ACV-0000` token, when the message is sent or an edit adds the mention (never the message text; never for mentioning yourself). Read by `comms-notifications` (`message_mention`) | `conversationId`, `messageId`, `mentionedEmpId`, `byEmpId` |
| `comms.message.created` | M14 (produced from M14.1) | A message is saved (once per message: a retry with the same `clientKey` writes nothing). Read by `comms-realtime` (M14.2): the live-delivery safety net re-sends the message's live signal when the first one was lost; and by `comms-notifications`: `message_reply` to the author answered, `message_new` to the other members of a DM or group (one per conversation until read) | `conversationId`, `conversationKind`, `messageId`, `seq`, `authorEmpId`, `parentMessageId`, `mentionedEmpIds` (never the text) |
| `comms.message.changed` | M14 (M14.2) | A saved message changed: `edited`, `deleted` (by its author), `removed` (by a moderator), `reaction` (added or taken back), `pinned`, `unpinned`, `file_scanned` (an attached file finished its malware check), `task_link` (linked to a Module 5 task, or unlinked). Written in the same transaction as the change. Read by `comms-realtime`, which re-sends the live update when the first one was lost | `conversationId`, `messageId`, `change` (never the text) |
| `comms.member.removed` | M14 (produced from M14.1) | Someone stops being a member of a conversation: removed by a moderator or admin (`removed`) or left (`left`). Not written when a department channel member is moved out of the department (that membership is worked out from the employee records at every request). `employee_left` is reserved for the offboarding part of M14 | `conversationId`, `empId`, `byEmpId`, `reason` |
| `comms.announcement.published` | M14 | An announcement is published. Read by `comms-notifications`: everyone it is for (except its author) gets an `announcement` notification with the title only | `announcementId`, `byEmpId`, `requiresAck` |
| `comms.meeting.invited` | M14 | People are invited to a meeting, when it is created or later. Read by `comms-notifications` (`meeting_invited`) | `meetingId`, `empIds`, `byEmpId` (never the agenda or notes) |
| `comms.meeting.cancelled` | M14 | The organizer cancels a meeting. Read by `comms-notifications` (`meeting_cancelled` to everyone invited) | `meetingId`, `byEmpId` (never the reason) |
