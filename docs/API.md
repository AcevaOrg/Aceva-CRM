# Aceva API

Base URL (development): `http://localhost:4000/api/v1`
Interactive documentation (Swagger UI): `http://localhost:4000/api/docs`
Machine-readable OpenAPI JSON: `http://localhost:4000/api/docs-json`

Request and response shapes are defined once, in `packages/contracts/src` (Zod schemas), and shared with the website.

## How requests are protected

- **Login gives an HttpOnly session cookie** (`aceva_session`, SameSite=Lax, Secure in production). Page scripts cannot read it.
- **Every request is checked on the server**: session still valid (30 minutes idle, 10 on finance screens, 12 hours in total),
  login finished (password changed, 2FA done), permission, and hierarchy scope. Failures are `401` (not logged in) or `403`
  (not allowed) and every refusal is written to the audit log.
- **Requests that change data** (anything but GET) must carry the header `X-CSRF-Token` (given at login and by `GET /auth/me`),
  and, when the browser sends an `Origin`, it must be the Aceva website.
- A route with no declared access rule is refused (fail closed).
- Errors: `{ statusCode, code, message }`. Validation failures also carry `issues: [{ path, message }]`; reporting-line and
  level failures carry `violations: [{ code, message }]`. Unfinished logins return `403` with `code: "auth_incomplete"` and `stage`.
- People are identified by Emp-ID (`ACV-0001`) in URLs and responses, never by internal UUID. Times are ISO 8601 in UTC.

## GET /health

No login needed. `{ "status": "ok", "database": "up", "time": "...", "version": "0.1.0" }`

## M2: login and sessions

| Method and path | Who | What it does |
|---|---|---|
| `POST /auth/login` | public | Body `{ empId, password, rememberMe? }`. Answer `{ status, retryAfterSec?, csrfToken? }` with `status` one of `ok`, `password_change_required`, `2fa_required`, `2fa_setup_required`, `locked`, `invalid`, `rate_limited`. Sets the session cookie unless refused. Unknown Emp-ID and wrong password look the same. |
| `POST /auth/logout` | logged in | Ends this session now (all stores) |
| `GET /auth/me` | logged in, even if unfinished | Who I am, `stage`, permissions, `twoFactorRequired`, `csrfToken`, `rememberAllowed` |
| `POST /auth/2fa/setup` | logged in, even if unfinished | Starts authenticator set-up. Returns `{ secret, otpauthUrl }` once; the secret is stored encrypted |
| `POST /auth/2fa/verify` | logged in, even if unfinished | Body `{ code }` (6 digits). The first correct code confirms the set-up. 5 wrong codes end the session. A code works once. |
| `POST /auth/2fa/disable` | logged in | Body `{ password, code }`. Only where 2FA is optional |
| `GET /auth/2fa` | logged in | `{ required, enabled, enabledAt? }` |
| `POST /auth/password/change` | logged in, even if unfinished | Body `{ currentPassword?, newPassword }` (min 10 characters, not one of the last 3). Ends every session on every device and starts a fresh one here |
| `POST /auth/password/forgot` | public | Body `{ empId }`. Always `{ sent: true }`. Emails a one-time link (15 minutes) to the official acevatech.com address, if there is one |
| `POST /auth/password/reset` | public | Body `{ token, newPassword }`. The link works once; ends every session |
| `GET /auth/sessions` | logged in | My devices |
| `DELETE /auth/sessions/:id` | logged in | Log out one of my other devices (someone else's session looks like it does not exist) |
| `DELETE /auth/sessions` | logged in | Log out all my other devices |
| `GET /auth/login-history` | logged in | My recent logins and failed attempts |
| `POST /auth/employees/:empId/unlock` | `auth.unlock_account`, above them in the line or HR duty | Unlock a locked account |
| `POST /auth/employees/:empId/force-logout` | `session.force_logout`, below the caller | Ends every session on every device at once |
| `POST /auth/employees/:empId/temporary-password` | `auth.set_temporary_password` (Director, HR duty) | For people with no official email only. The password is shown once and must be changed at next login |

Limits: 5 wrong passwords lock the account (a higher level or HR unlocks it). From one internet address, failures are
slowed after 5 in 5 minutes and blocked after 15 in 15 minutes. "Remember me" never applies to Finance users.

## M1: hierarchy and access control

| Method and path | Who | What it does |
|---|---|---|
| `GET /access/me` | logged in | My level, role, duties and effective permissions (role + duty) |
| `GET /access/roles`, `/access/duties`, `/access/permissions` | `org.view` | Roles with permissions; extra duties; the permission catalogue (read only) |
| `GET /org/tree` | `org.view` | The organisation chart as a tree |
| `GET /org/team`, `GET /org/team/:empId` | logged in / scope: me or below | Me and everyone below me (filter runs in the database); one person, refused when above or beside me |
| `PATCH /org/employees/:empId/level` | `org.manage` (Owner, CEO), below the caller | `{ level: 2..5, roleKey?, reason }`. Validated against the reporting lines; nobody can assign a level at or above their own |
| `PATCH /org/employees/:empId/reporting-line` | `org.manage`, below the caller | `{ reportsToEmpId, reason }`. No loops, no self, no reporting to a lower level, same-level only where configured |
| `POST /org/employees/:empId/duties`, `DELETE .../duties/:dutyKey` | `duty.assign` (Director), below the caller | `{ dutyKey, reason }` / `{ reason }` |
| `GET /org/departments` | `org.view` | Departments (with their explicit head) and offices with headcount |
| `POST /org/departments`, `PATCH /org/departments/:code`, `POST /org/departments/:code/deactivate` | `org.manage` (Owner, CEO) | `{ name, headEmpId?, reason }`, `{ name?, headEmpId?, reason }`, `{ reason }`. Heads are chosen explicitly and audited; deactivating needs an empty department |
| `POST /org/offices`, `PATCH /org/offices/:code`, `POST /org/offices/:code/deactivate` | `org.manage` | `{ name, city?, reason }` and similar |
| `GET /org/changes` | `audit.view` | Recent access changes, from the audit log |
| `POST /stand-ins`, `GET /stand-ins`, `DELETE /stand-ins/:id` | `standin.manage` / logged in | `{ standInEmpId?, startsOn, endsOn, reason? }`. No stand-in means approvals go up the chain. Overlaps and conflicts are refused |
| `GET /approvals/route/:empId?date=&afterSeat=` | scope: me or below | Who approves this person's request on a date (real reporting chain, stand-ins, people who left are passed over) |
| `GET /approvals/can-approve/:empId` | scope: below me | May I approve right now? Never my own |
| `GET /access/can-assign-task/:empId` | logged in | Tasks only move down my reporting line |

Every change writes an audit record (who, what, before and after, and the reason) in the same database transaction.

## Event contracts

Events for other modules are written to the `outbox_events` table in the same transaction as the change. The full
contract (what, when, how to read them) is in `docs/EVENTS.md`.
