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

## Module 3 to Modules 5 and 8 (defined now, produced by M3), version 1

| Event | Intended consumer | Payload |
|---|---|---|
| `employee.offboarded` | M5, M8, M12 | `empId`, `lastWorkingDay`, `managerEmpId` |
| `task.transfer.requested` | M5 task management | `fromEmpId`, `toEmpId`, `reason: "employee_left"` |
| `payroll.final_settlement.requested` | M8 payroll | `empId`, `lastWorkingDay` |

`employee.offboarded`, `task.transfer.requested` and `payroll.final_settlement.requested` are written to the outbox when an
employee's last working day is processed (`backend/src/people/offboarding.service.ts`). **No module consumes them yet**:
they wait in `outbox_events` (unprocessed) until Module 5 and Module 8 register their consumers, and are delivered then.

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
