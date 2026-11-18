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
| `task.approved` | Approve, with the rating. `deadline` is the approved deadline; `onTime` means handed in at or before it | `assignee`, `reviewer`, `rating` (1 to 5), `size`, `points`, `estimatedHours`, `deadline`, `originalDeadline`, `startedAt`, `submittedAt`, `onTime`, `extensionsCount`, `reworkCount` | none yet (Module 6) |
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
