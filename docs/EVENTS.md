# Event contracts (outbox)

How Module 2 (and later Module 3) tell other modules what happened, without those modules existing yet.

## How it works

1. When something happens (a login, a logout...), the module writes **one row** to `outbox_events`, in the **same database
   transaction** as the change itself (or straight after it for logins). The row exists if and only if the change happened.
2. Every event is checked against its **schema** (`packages/contracts/src/events.ts`) before it is saved. A malformed event
   cannot be stored.
3. A **consumer** (Module 4 for the auth events) reads the rows it cares about and sets `processed_at`. Consumers are NOT part
   of Cycle 1: nothing reads these events yet, and nothing here pretends otherwise.

## The envelope

| Column | Meaning |
|---|---|
| `id` | Unique event id (UUID). Consumers use it to ignore duplicates |
| `type` | For example `auth.login` |
| `version` | Integer. A breaking change to a payload means a NEW version (2); version 1 is never edited |
| `actor` | The Emp-ID of whoever caused it, or `system` |
| `payload` | JSON, shaped by the schema of that `type` and `version` |
| `occurred_at` | When it happened (UTC) |
| `processed_at` | Set by the consumer when it has handled the event (null = not yet) |

Payloads contain Emp-IDs (never internal UUIDs) and never contain passwords, tokens, cookies, CSRF tokens, 2FA secrets or
pay figures. A test checks this.

## Module 2 to Module 4 (activity tracking), version 1

| Event | When | Payload |
|---|---|---|
| `auth.login` | A password was accepted and a session created | `empId`, `sessionId`, `ip`, `userAgent` |
| `auth.login_failed` | A wrong password, a locked or disabled account, a wrong authenticator code, or a refused (rate-limited) attempt | `empIdAttempted` (what was typed), `empId` (set only if it matched a real person), `reason` (`invalid_credentials`, `locked`, `rate_limited`, `two_factor_failed`, `disabled`), `ip`, `userAgent` |
| `auth.logout` | A session ended, whatever the cause | `empId`, `sessionId`, `reason` (`user`, `idle_timeout`, `max_duration`, `password_changed`, `forced`, `employee_left`) |

Every login, every failed login and every logout produces exactly one event. Sessions that time out while nobody is making
requests are ended by a once-a-minute sweeper, which also produces the `auth.logout` event.

## Module 3 to Modules 5 and 8 (defined now, produced by M3), version 1

| Event | Intended consumer | Payload |
|---|---|---|
| `employee.offboarded` | M5, M8, M12 | `empId`, `lastWorkingDay`, `managerEmpId` |
| `task.transfer.requested` | M5 task management | `fromEmpId`, `toEmpId`, `reason: "employee_left"` |
| `payroll.final_settlement.requested` | M8 payroll | `empId`, `lastWorkingDay` |

## Reading events (for the people building a consumer)

```sql
-- take a batch without two workers taking the same rows
SELECT * FROM outbox_events
WHERE type IN ('auth.login', 'auth.login_failed', 'auth.logout') AND processed_at IS NULL
ORDER BY occurred_at
LIMIT 100
FOR UPDATE SKIP LOCKED;
-- ...handle them (ignoring an id already handled), then:
UPDATE outbox_events SET processed_at = now() WHERE id = ANY($1);
```

A consumer must check `version` and ignore versions it does not know. Adding a consumer never needs a change to Module 2.
