# Module 13: customer billing, subscriptions and renewal management

Plan section 18, built in Cycle 3 after the shared foundation (docs/CYCLE3-FOUNDATION.md). It follows the approved M13
defaults of the 17 Nov audit: one invoice system (Module 9's), an invoice reaches the ledger only when it is issued, no sales
tax (D13), reminders to the client and the assigned staff member at 3 days before, on the due date, 3 days after and
7 days after, the finance duty person creates invoices and records payments.

## 1. One invoice and payment system: Module 9 writes the money

| Piece | Where |
|---|---|
| Invoices, lines, payments, allocations, ledger entries | Module 9 tables (`invoices`, `invoice_lines`, `payments`, `payment_allocations`, `journal_entries`) |
| Invoice life cycle (draft, issue, cancel, restore) | `backend/src/finance/invoice-lifecycle.service.ts` (Module 9, exported to Module 13) |
| Payments | Module 9 `FinanceDocumentsService.createPayment` (now with a retry key) |
| Everything around them | `backend/src/billing` (Module 13) |

- **Draft:** a temporary `DRAFT-XXXXXXXX` number and **no ledger entry** (a database CHECK). It can be edited.
- **Issue:**
  - The invoice gets the next `INV-YYYY-NNNN` number, so issued numbers have no gaps; a cancelled draft never used one.
  - Its due date becomes the issue date plus the terms.
  - Its ledger entry (Dr accounts receivable / Cr income) is created and **submitted**. Like every entry, it waits for approval by a different person at the level its amount needs (D25: the Director up to PKR 5,000,000). Issuing never posts money by itself.
  - From then on, a database trigger refuses any change to the amounts, lines, client, dates or number, and refuses deleting the invoice.
- **Paid, part paid, overdue:** calculated, never stored. Only **posted** payments count. A payment that is recorded but waits for approval is shown as "waiting for approval".
- **Cancel:**

  | The invoice | What cancelling does |
  |---|---|
  | A draft | Simply cancelled |
  | Issued, entry **posted** | A **reversing entry** (lines swapped, the same PKR amounts) is created and submitted; it waits for approval. Asks to confirm again. |
  | Issued, entry still **waiting** for approval | Refused (`409 entry_pending`). The approver rejects that entry instead. |
  | Payments recorded against it | Refused (`409 has_payments`) |

  - If the reversing entry is rejected, the invoice can be **restored** (the receivable never left the ledger) or cancelled again.
- **Module 9's own screens are unchanged:**
  - `POST /invoices` still creates and submits at once (those rows are `issued`).
  - `GET /invoices` does not list Module 13 drafts.
  - Rows that existed before this migration are `issued`.

## 2. Recurring and rental invoices

- Creating a recurring or rental invoice makes its first draft and a **rule**:
  - the period: monthly, quarterly or yearly
  - the start, and an optional end
  - the lines, terms, reminder days and assigned person
- **The daily run** creates one draft per period, unique per rule and period start, and tells the assigned person (`invoice_draft_ready`).
  - Periods are counted from the rule's first day, so month ends do not drift (31 Jan, 28 Feb, 31 Mar).
  - A rule ends by itself after its last period, or when someone stops it (with a reason).
- **Default:** recurring invoices are created as **drafts** for the finance duty person to check and issue. Nothing is issued automatically.

## 3. Reminders and customer emails

| Reminder day | Client (email) | Assigned staff member (in the app, and by email if they keep that choice) |
|---|---|---|
| 3 days before | Reminder | `invoice_due` |
| Due date | Reminder | `invoice_due` |
| 3 and 7 days after | Reminder | `invoice_overdue` |

- **One row per invoice, day and audience** (`invoice_reminders`, unique). A day already past at issue time is recorded as skipped.
- **The daily run (09:00 Pakistan time) sends only what is due:**
  - **Never** for a paid or cancelled invoice, or one whose payment is recorded and waits for approval. It checks again right before each email goes out.
  - When several reminders are due at once (missed days), only the latest one goes out; the others are recorded as replaced.
  - A reminder more than 2 days late is skipped, never sent late.
  - Once an invoice is paid (its payment posted), all its remaining reminders are stopped.
- **Client emails** (`billing_customer_emails`, unique per dedupe key) are sent by a worker with retries. A send interrupted half-way becomes `unknown` and is never resent.
- **The invoice email waits for approval** (review decision 1, 18 Nov):
  - Issuing does **not** email the client.
  - Only when the Director **approves** the invoice's ledger entry does the billing reader of `ledger.entry.posted` queue the invoice email, once. The dedupe key `invoice:<id>` is unique, and the reader handles each event exactly once, so a retried event queues nothing more.
  - An entry that is waiting or **rejected** never produces that event, so it never emails.
  - If customer emails are off at approval, nothing is queued; "Email to client" can send it by hand later, still only for an approved entry (`409 entry_not_approved` otherwise).
  - Client reminders also wait for the approval.
  - The sender checks again right before every client email that the entry is posted.
  - Invoices made directly through Module 9 (`POST /invoices`) are not emailed.
  - Audit: `billing.invoice.email_queued` with `trigger: entry_approved` or `by_hand`.
- **Staff reminders** use the notification core (dedupe key `reminder:<id>`), so a retry never notifies twice.

### Before customer emails can be switched on

Customer emails are **off**, and the server refuses to switch them on until these are entered in the billing settings
(module `billing`, the Director, with "confirm again"). Nothing is invented; these values are needed from management:

| Needed | Why |
|---|---|
| **Sending address**: a real Aceva mailbox (for example a billing address on the company domain), with working SMTP for it in production | The From of invoice and reminder emails |
| **Company legal name** | Printed on invoices and in emails |
| Company address, email, phone (optional, recommended) | Printed when set |
| Tax numbers (NTN / STRN) if they are to be printed | Printed when set |
| Payment details (bank name, account title, IBAN) | Printed under "Pay to" when set |
| Reply-to address (optional) | Where client replies go |

The SMTP server itself is configured in the environment (`SMTP_*`), as for password resets. The production mail account
must be allowed to send as the chosen sending address.

## 4. Payments and payment history

- `POST /billing/invoices/:id/payments` records a **Module 9 payment** received:
  - its fields are the bank account, date, amount, method and reference
  - it is allocated to the invoice
  - its entry waits for approval
- **Retry-safe:** the client sends a `requestKey`, unique on `payments`. Sending it again returns the same payment.
- **Never more than is still open:** Module 9 locks the invoice and checks the open amount.
- **No payment-card details:** only the method and a reference are kept. A reference that contains a valid card number is refused.
- **The client's payment history:** `GET /billing/payments`, the customer list (total billed, outstanding, last payment), and each invoice's payments with their entry status.
- **When a payment entry is posted:** the billing outbox reader sends `billing.invoice.paid` **once per invoice** (`paid_event_at`), with `firstForClient` for Module 15's commission.

## 5. Subscriptions, renewals, usage and costs

| Piece | Where |
|---|---|
| Register: vendor, product, category, responsible person, plan, cost, period, renewal date, alert days, seats | `subscriptions` (`SUB-YYYY-NNNN`) |
| Renewal alerts and decisions (renewed, changed, cancelled), insert-only | `subscription_renewal_events` (one alert per subscription and renewal date: unique index) |
| Usage readings, typed in, insert-only | `usage_snapshots` |
| Monthly cost records | `subscription_costs` (one per month) |

- **Who:** the Director manages (`subscriptions.manage`). Finance, the CEO and the Owner view. Everyone else gets "not found".
- **Renewal alerts:** the daily run alerts the responsible person once, inside the alert window (`renewal_due` notification and `billing.subscription.renewal_due` event).
- **Decisions:** renewing moves the renewal date one period on, or to a chosen date. Changing records the old and new plan and cost. Cancelling needs a note.
- **Readings:** typed in, because no provider is connected. A reading at 80 % or more of the limit, or an unusual rise (more than 1.5 times the earlier average), tells the responsible person once (`usage_alert`). A cost on a reading is always shown as **Estimated**.
- **Monthly costs:** a cost record is **Estimated** unless it is backed by a Module 9 bill or the provider's invoice reference (a database CHECK). Changing one is audited with the old and new amount. Nothing here posts money: paying a provider is a Module 9 bill.

## 6. Connection point for Module 15 (not Module 15 itself)

- `sales.deal.won_confirmed` (refined with M13; nothing produces it yet) carries:
  - the deal number, the owner and who confirmed it
  - the client (`partyId`, or name, email and country)
  - the service, the value and the currency
- **One handover per deal** (`deal_handovers`, unique deal number) and at most one draft (`invoices.source_deal_number`, unique), so a repeated event does nothing.
- **Choosing the client** (review decision 5, 18 Nov):

  | The deal's client | What happens |
  |---|---|
  | The Module 9 client the event names (an active client) | It is used |
  | Exactly **one** active client with **exactly** that name (no case or spelling tolerance) | It is used |
  | **Several** clients with exactly that name | No draft and no guess. The handover is `needs_client`; Finance is told and chooses the client on the billing overview (`POST /billing/deal-handovers/:id/resolve`). The draft is then made once, and the choice is audited. |
  | **No** match | A new client marked **needs review**. Its invoice cannot be issued (`409 client_needs_review`) until Finance confirms the client (`POST /billing/customers/:id/confirm`, audited). |
- **Module 15 only has to write the event.** No Module 15 table, route or screen was built.

## 7. Routes, permissions and safety

| Route | Permission | Notes |
|---|---|---|
| `GET /billing/overview`, `GET /billing/invoices[?partyId&status]`, `GET /billing/invoices/:id`, `GET /billing/payments`, `GET /billing/customers`, `GET /billing/recurring`, `GET /billing/invoices/:id/document` | `billing.view` | |
| `POST /billing/invoices`, `PATCH /billing/invoices/:id`, `POST …/issue`, `POST …/email`, `POST …/cancel`, `POST …/restore`, `POST /billing/recurring/:id/stop` | `billing.view` + `billing.manage` | Cancelling an issued invoice asks to confirm again |
| `POST …/payments`, `POST /billing/customers`, `PATCH /billing/customers/:id` | + `finance.entry_create` | Module 9 writes |
| `GET /billing/deal-handovers[?status]` | `billing.view` | Won deals; default: the ones waiting for their client |
| `POST /billing/deal-handovers/:id/resolve {partyId}`, `POST /billing/customers/:id/confirm` | `billing.view` + `billing.manage` | Choose the client of an ambiguous Won deal; confirm a client created from a deal |
| `GET /billing/invoices/export` | `billing.view` + `finance.export` | Confirm again, watermarked, logged |
| `GET /billing/subscriptions`, `GET …/renewal-events`, `GET …/:id` | `subscriptions.view` | |
| `POST /billing/subscriptions`, `PATCH …/:id`, `POST …/:id/renewal-decision`, `POST …/:id/usage`, `PUT …/:id/costs/:month` | + `subscriptions.manage` | |
| `GET/PUT /settings/modules/billing` | view `billing.view`, change `settings.manage` | Confirm again; audited with old and new value |

- **Finance screens on the server:**
  - without the permission the answer is 404
  - the **10-minute finance idle limit** applies to every `/billing` route
  - every refusal is audited
- **No self-approval:** the person who issues an invoice or records a payment is the entry's maker and can never approve it (Module 9).
- **Audit:** every change is in the audit log, inside the same transaction:
  - invoice: `finance.invoice.*`
  - payment: `finance.payment.received`
  - customer, recurring rule and subscription: `billing.*`
  - settings: `settings.module.changed`
  - exports: `billing.invoices.exported`
- **The database refuses on its own:**
  - a draft with an entry
  - an issued invoice with a DRAFT number
  - changing an issued invoice
  - deleting invoices
  - an actual cost without backing
  - changing renewal or usage history
- **Retries create nothing twice:**

  | Thing | What makes it unique |
  |---|---|
  | Invoice create and payment | The request key |
  | Won deal | The deal number |
  | Recurring draft | The rule and period |
  | Reminder | The invoice, day and audience |
  | Email | Its dedupe key |
  | Renewal alert | The subscription and renewal date |
  | Notification | The recipient and dedupe key |
  | Paid and overdue events | `paid_event_at` and `overdue_event_at` |

## 8. Settings (module `billing`)

| Setting | Default | Notes |
|---|---|---|
| Company: legal name, address, email, phone, tax numbers, payment details | empty | Management enters the real values |
| Customer emails: on, sending address, reply-to | off, empty, empty | Cannot be switched on without the sending address and legal name |
| Reminder days | -3, 0, 3, 7 | The approved timing |
| Default payment terms | 14 days | Configurable **development default**, not confirmed accounting policy (review decision 3) |
| Default income account | `4100` (Service income, from the seeded chart) | Configurable **development default**, not confirmed accounting policy; the accountant confirms |

## 9. Migration `20261119090000_m13_billing`

**Additive only:**
- **New columns:**
  - on `invoices`: status, type, terms, period, rule, reminder days, assigned person, source deal, request key, issue, email and cancel details, event markers
  - on `payments`: the request key
- 9 new tables (including `deal_handovers`), new columns on `billing_profiles` for clients that need review, and a `subscription_seq` sequence
- CHECK constraints and triggers on the new data, and the issued-invoice freeze

Existing invoices become `issued`, which is what they already are. No existing row, column or constraint is changed or removed.

## 10. Not built here

- **Online card collection:** no payment provider; only method and reference.
- **Provider usage APIs:** Phase 2, Module 16. Everything is typed in and labelled that way.
- **Credit notes and partial cancellation:** deferred (review decision 4). An invoice with payments cannot be cancelled.
- **Recurring invoices are never issued automatically:** each period's invoice is a draft that Finance reviews and issues (review decision 2).
- **A PDF file:** the printable HTML invoice follows decision D15 (no PDF library).
- **The daily summary email.**
- **Sales tax lines:** D13 says no tax.
