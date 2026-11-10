# Aceva API (foundation)

Base URL (development): `http://localhost:4000/api/v1`
Interactive documentation (Swagger UI): `http://localhost:4000/api/docs`
Machine-readable OpenAPI JSON: `http://localhost:4000/api/docs-json`

Only the health endpoint exists at this stage. M1, M2 and M3 endpoints are added in their own
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
