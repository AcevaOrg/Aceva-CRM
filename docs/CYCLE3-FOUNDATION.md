# Cycle 3 shared foundation (before Modules 13, 14 and 15)

Approved scope: several readers per outbox event, the minimal Module 12 notification core, the module-owned settings
pattern, and the shared contracts and event types. Nothing of Modules 13, 14 or 15 is built here, no WebSocket library
is installed, and nothing is ever deleted automatically (retention is not decided yet).

## 1. Outbox readers (several per event, each exactly once)

| Piece | Where |
|---|---|
| Runner | `backend/src/events/outbox-consumer-runner.service.ts` (`OutboxConsumerRunner`, global through `CommonModule`) |
| Progress | `outbox_consumers` (one row per reader, with the moment it started) and `outbox_consumptions` (one row per reader and event, unique) |

- A reader registers `{ name, types, handle(event, tx) }`. `handle` runs inside the transaction that records the event as
  processed for that reader, so its database writes are committed exactly once or not at all.
- Two runs racing for the same event: the second waits on the unique key, then sees the first one's row and skips it.
- A failing handler is rolled back and tried again later: after 30 s, 2 min, 10 min, then 1 hour, 5 attempts in all. After that the event is `dead`: it stays visible and is not tried again.
- An event that does not match its contract is recorded as `skipped` and never handled.
- A new reader sees only events written after it was first registered, so switching a reader on never replays the past.
  On `aceva_dev` this means the existing events are **not** turned into notifications.
- `outbox_events.processed_at` is untouched: it still belongs to the one reader that predates this (final settlements).
- Emails and other side effects outside the database are never sent from `handle`. They are queued there and sent by a worker.

## 2. Minimal Module 12 notification core

| Piece | Where |
|---|---|
| In-app notifications, email choices | `notifications`, `notification_preferences`; `NotificationService` (exported for Modules 13 to 15) |
| Email delivery | `notification_deliveries`; `NotificationDeliveryService` (SMTP through the existing `Mailer`) |
| Events turned into notifications | `NotificationEventsConsumer`, reader name `notifications` |
| API | `GET /notifications`, `POST /notifications/read`, `GET /notifications/prefs` and `PATCH /notifications/prefs` (each person only reaches their own) |
| Screens | The existing bell and notifications screen, live when `NEXT_PUBLIC_LIVE_MODULES` contains `m12` |

| Event (existing) | Notification | Recipient |
|---|---|---|
| `leave.requested` | `leave_requested` (essential) | The routed approver |
| `leave.decided` approved or rejected | `leave_answered` | The requester (a forwarded request notifies the next approver; a cancellation nobody) |
| `attendance.correction.decided` | `correction_answered` | The requester |
| `payroll.run.ready` | `payroll_ready` (essential) | Everyone holding `payroll.approve` (since D25, the Director) |
| `payslip.issued` | `payslip_available` | The employee |
| `finance.period.reopened` | `security_alert` (essential) | The Owner, CEO and Director |

Nobody is notified about their own action. The only exception is a payslip: the Director still gets their own after approving payroll.

**No duplicates:**
- A notification is unique per recipient and `<event id>:<type>`.
- Each notification has at most one email delivery (unique per notification and channel).
- So a retried event, or a reader that crashes and runs again, creates nothing twice.

**Delivery:**
- Each delivery is claimed with `FOR UPDATE SKIP LOCKED`.
- A failed send is retried after 1 min, 5 min, 30 min, then 2 hours, 5 attempts in all.
- A send interrupted half-way (still `sending` after 10 minutes) becomes `unknown` and is **not** sent again, because the email may already have gone out.
- A person who has left, or has no official email, gets no email (`skipped`, with the reason).

**Essential types:**
- `approval_waiting`, `payroll_ready`, `leave_requested`, `extension_requested` and `security_alert` are always shown and always emailed.
- The API refuses to turn them off (`400 essential_notification`).
- A database CHECK refuses storing them as turned off.
- The email sender never consults preferences for them.

**Content:**
- Emails carry the title, a short text and a link into the app (`APP_URL`). There are no amounts, passwords or tokens.
- The email body is never logged.

**Background workers:**
- The reader runs every 10 seconds and the email sender every 15 seconds.
- `BACKGROUND_WORKERS=on|off` controls this. The default is on, except under `NODE_ENV=test`, where tests run each step themselves. The browser tests switch it on.

**Not built (Module 12 proper):**
- The daily summary email (the preference is stored).
- Notifications for Modules 4, 5 and 6 events, which don't exist yet.

This supersedes decision D16 ("nothing is emailed yet").

## 3. Module-owned settings

| Piece | Where |
|---|---|
| Service and API | `ModuleSettingsService` and `GET/PUT /settings/modules/:module` (`backend/src/settings`) |
| Storage | `module_settings` (one row per module, JSON value, version) |

- A module registers `{ module, schema, defaults, viewPermission?, managePermission, stepUp? }`.
- The value is always checked against the module's schema, on reads too.
- Version 0 means the defaults. A change sends back the version it read, and a stale version is refused with `409 stale_version`.
- Every change needs the module's permission (and "confirm again" when the module asks for it). It is audited with its reason, the old value and the new value, in the same transaction.
- No secrets belong here, because they would appear in the audit log.
- First user: `notifications`, with `{ emailEnabled }`, changed with `settings.manage`. Off means notification emails wait: nothing is dropped, and they go out once it is switched back on. Approvals stay visible in the app throughout.

## 4. Contracts

| Kind | Added |
|---|---|
| Contract files | `packages/contracts/src/notifications.ts` and `settings.ts` |
| Event types (defined now, produced when each module is built) | `sales.deal.won_confirmed`, `billing.invoice.issued`, `billing.invoice.paid`, `billing.invoice.overdue`, `billing.subscription.renewal_due`, `sales.commission.approved`, `comms.mention`, `comms.announcement.published` (all version 1) |

Nothing produces the new event types yet, so their payloads can still be refined when their module is built.

## 5. Migration `20261118090000_cycle3_foundation`

**Additive only:**
- 6 new tables and 2 new enums
- Foreign keys from the new tables only
- 5 CHECK constraints on the new tables

No existing table, column, row or constraint changes. The Prisma schema gets back-relations on `Employee` and `OutboxEvent`; these change no column.

## 6. Known issue: time zone (for separate investigation; behaviour unchanged)

Found while building this foundation; it predates it. **Nothing about it was changed here**, by decision of 18 Nov 2026.

- The PostgreSQL session time zone is `Asia/Karachi` (database default) and the Prisma PostgreSQL adapter
  (`@prisma/adapter-pg`) ignores time-zone offsets. A timestamp written through Prisma is therefore stored 5 hours earlier
  than the real moment, and a value made by the database itself (`now()`, `DEFAULT CURRENT_TIMESTAMP`) reads back 5 hours
  late.
- The application is consistent with itself because almost every timestamp goes through Prisma; tools that read the
  database directly see times 5 hours off.
- Rule until it is investigated: new code never mixes the database's own clock with Prisma-written times (the outbox
  readers compare Prisma-written values only; raw SQL passes the times explicitly).
- Any fix (for example UTC for the connection plus a one-time correction of existing rows) changes how existing rows read
  and needs its own approval, migration plan and backup.
