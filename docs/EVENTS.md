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

## Module 3 status of the leaving events

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
| `finance.period.reopened` | M9 | The Director or the Owner reopen a closed month (D25) | `month`, `byEmpId`, `reason` |

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

## Cycle 3: Modules 13 to 15, version 1 (defined in the shared foundation; produced when each module is built)

| Type | From | When | Payload |
|---|---|---|---|
| `sales.deal.won_confirmed` | M15 | A Won deal is confirmed (the Director until there is a sales manager) | `dealNumber`, `ownerEmpId`, `confirmedByEmpId` |
| `billing.invoice.issued` | M13 | An invoice is issued (its ledger entry waits for approval in M9) | `invoiceNumber`, `dueDate`, `sourceDealNumber` |
| `billing.invoice.paid` | M13 | An invoice is fully paid | `invoiceNumber`, `paidOn`, `sourceDealNumber`, `firstForClient` |
| `billing.invoice.overdue` | M13 | An invoice passes its due date unpaid | `invoiceNumber`, `dueDate`, `daysOverdue` |
| `billing.subscription.renewal_due` | M13 | A subscription or domain renews soon | `subscriptionNumber`, `renewsOn`, `ownerEmpId` |
| `sales.commission.approved` | M15 | The Director approves a commission line | `dealNumber`, `empId`, `approvedByEmpId`, `payrollMonth` |
| `comms.mention` | M14 | Someone is mentioned (never the message text) | `conversationId`, `messageId`, `mentionedEmpId`, `byEmpId` |
| `comms.announcement.published` | M14 | An announcement is published | `announcementId`, `byEmpId`, `requiresAck` |
