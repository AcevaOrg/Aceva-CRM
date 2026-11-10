# Aceva API (foundation)

Base URL (development): `http://localhost:4000/api/v1`
Interactive documentation (Swagger UI): `http://localhost:4000/api/docs`
Machine-readable OpenAPI JSON: `http://localhost:4000/api/docs-json`

The health endpoint and the M1 endpoints exist so far. M2 and M3 endpoints are added in their own
milestones and appear in Swagger automatically. The planned wire contracts for the frontend are in
`spec.md` section 4 and will be moved into `packages/contracts` as each module is built.

## GET /health

Checks that the API is running and can reach PostgreSQL. No login needed.

Response `200`:

```json
{ "status": "ok", "database": "up", "time": "2026-11-10T10:00:00.000Z", "version": "0.1.0" }
```

| Field | Meaning |
|---|---|
| `status` | `ok` when the database answers, `degraded` when it does not |
| `database` | `up` or `down` |
| `time` | Server time in UTC (ISO 8601) |
| `version` | API version |

The schema lives in `packages/contracts/src/health.ts` (`healthResponseSchema`).

## Identity until M2 (development only)

M2 (Emp-ID login and sessions) is not built yet. Until it is, the server can be told who is calling with the
header `X-Dev-Emp-Id: ACV-0003`, **only** when `DEV_IDENTITY_ENABLED=true`. This is not security (anyone can send
the header). It is off by default and the API refuses to start with it on in production. M2 replaces it with the
session cookie, and no M1 code changes.

Every route below is checked by the server-side access guard: no identity gives `401`, a missing permission or an
out-of-scope person gives `403`, and every rejection is written to the audit log. A route that declares no access
rule at all is refused (fail closed).

## M1: hierarchy and access control

| Method and path | Who | What it does |
|---|---|---|
| `GET /access/me` | any logged-in employee | My level, role, duties, effective permissions (role + duties) and whether 2FA is mandatory |
| `GET /access/roles`, `/access/duties`, `/access/permissions` | `org.view` | Roles with permissions; extra duties; the permission catalogue |
| `GET /org/tree` | `org.view` | The organisation chart as a tree (directory-level fields only) |
| `GET /org/team` | any logged-in employee | Me plus everyone below me. The scope filter runs in the database query |
| `GET /org/team/:empId` | scope: me or below me | One person. Above, beside or other branches: `403` and logged |
| `PATCH /org/employees/:empId/level` | `org.manage` (Owner, CEO), person below the caller | Body `{ level: 2..5, roleKey?, reason }`. Validated against the reporting lines. A caller cannot assign a level at or above their own |
| `PATCH /org/employees/:empId/reporting-line` | `org.manage` (Owner, CEO), person below the caller | Body `{ reportsToEmpId, reason }`. No loops, no self, no reporting to a lower level, same-level only where configured |
| `POST /org/employees/:empId/duties` | `duty.assign` (Director), person below the caller | Body `{ dutyKey, reason }`. Gives Finance or HR duty |
| `DELETE /org/employees/:empId/duties/:dutyKey` | `duty.assign` | Body `{ reason }`. Ends the duty (record kept) |
| `POST /stand-ins` | `standin.manage` | Body `{ standInEmpId?, startsOn, endsOn, reason? }`. I am away; approvals go to the stand-in, or one level up when none is named |
| `GET /stand-ins` | any logged-in employee | Away periods of people in my reporting line, and ones where I am the stand-in |
| `DELETE /stand-ins/:id` | `standin.manage` | Body `{ reason }`. The manager, or Owner/CEO for people below them |
| `GET /approvals/route/:empId?date=&afterSeat=` | scope: me or below me | Who approves this person's request on a date. `afterSeat` moves one reporting relationship further up |
| `GET /approvals/can-approve/:empId` | scope: below me | May I approve right now? Never my own; only the routed approver |
| `GET /access/can-assign-task/:empId` | any logged-in employee | `{ allowed }`: tasks only move down my reporting line |

Validation failures for reporting lines and levels return `400` with `{ message, violations: [{ code, message }] }`,
where `code` is one of `self`, `cycle`, `manager_below_employee`, `same_level_not_allowed`, `manager_left`,
`employee_left`, `owner_has_no_manager`.

Every change writes an audit record (who, what, before and after, and the reason) in the same database transaction.

## Conventions for all endpoints

- All routes start with `/api/v1`.
- Request bodies, queries and params are validated with the shared Zod schemas. A bad request returns
  `400` with `{ "statusCode": 400, "message": "Validation failed", "issues": [{ "path": "...", "message": "..." }] }`.
- People are identified by Emp-ID (`ACV-0001`) in URLs and responses, never by internal UUID.
- Times are ISO 8601 in UTC.

## Event contracts (outbox)

Events for other modules are defined in `packages/contracts/src/events.ts` and stored in the
`outbox_events` table in the same transaction as the change. Consumers are built in later cycles.

| Event | Version | Producer | Intended consumer |
|---|---|---|---|
| `auth.login` | 1 | M2 | M4 activity tracking |
| `auth.login_failed` | 1 | M2 | M4 activity tracking |
| `auth.logout` | 1 | M2 | M4 activity tracking |
| `employee.offboarded` | 1 | M3 | M5 / M8 / M12 |
| `task.transfer.requested` | 1 | M3 | M5 task management |
| `payroll.final_settlement.requested` | 1 | M3 | M8 payroll |

A breaking change to a payload creates a new version (for example version 2); version 1 is never edited.
