# Module 1 acceptance checklist (plan section 5)

Statuses: **Done and tested** (a test that I ran passes), **Partial**, **Open** (needs a decision), **Blocked** (needs a later module).
Backend tests are in `backend/test` and `backend/src/**.test.ts`; browser tests are in `e2e/`.

| # | Requirement | Status | Verified by |
|---|---|---|---|
| A1 | Five levels exactly (Owner, CEO, Director/CTO, Heads/Leads, Employees) | Done and tested | `database.test` (levels, CHECK 1..5), `m1-access` |
| A2 | Departments and offices | Done and tested (read, headcount, head, offices) | `m1-access` (departments), tree test |
| A3 | A "reports to" person for every employee (only the Owner has none) | Done and tested | `database.test`, `rules.test` |
| B1 | A default role for every level | Done and tested | `m1-access` |
| B2 | Individual permissions, role-permission links, Director adds duties (Finance, HR) | Done and tested | `m1-access`, `m1-changes` (duties) |
| B3 | Extensible for future modules without rewriting authorization | Done and tested | `m1-access` (new permission by data only) |
| C | Own data + below, never above or beside; at the database-query level; list and single record | Done and tested | `m1-access` (scope), e2e |
| D1 | Org chart as a tree with reporting relationships | Done and tested | `m1-access`, e2e |
| D2 | Only Owner/CEO change levels and lines; changes validated before saving (no loop, no self, no lower level, same level only where configured, no level escalation) | Done and tested | `rules.test`, `m1-changes`, e2e |
| E | Stand-in with named person and dates; routing to the stand-in; next level up without one; stand-in must be authorized | Done and tested. Interpretation: "away with no stand-in" is an away period with the stand-in left empty, because leave (M7) does not exist yet | `rules.test`, `m1-changes`, e2e |
| F1 | NestJS guard: identify employee, check permission, check scope, reject, log blocked attempts; fail closed | Done and tested | `m1-access` |
| F2 | "Identify the authenticated employee" | **Partial**: M1 uses a development-only identity header (off by default, refuses production). Real Emp-ID login arrives with M2 | `env.test`, `m1-access` |
| G1 | Reporting tree stored in PostgreSQL (with closure table) | Done and tested | `database.test`, `m1-changes` |
| G2 | Hierarchy kept in Redis | **Blocked / not implemented**: no Redis yet. `HierarchyCache` interface exists with a PostgreSQL implementation | none |
| G3 | Changes take effect everywhere at once; no stale data | Done and tested (reads go straight to PostgreSQL, so nothing can be stale) | `m1-changes`, e2e |
| H1 | Nobody approves their own request/expense/entry | Done and tested | `rules.test`, `m1-changes` |
| H2 | Approvals move up one reporting relationship at a time; tasks move down | Done and tested (follows the real chain, not level numbers) | `rules.test`, `m1-changes` |
| H3 | Every change to levels, roles, duties, lines audited with who, what and why | Done and tested (reason required; insert-only table) | `m1-changes`, `database.test` |
| I | Data stored: levels, roles, permissions, role_permissions, departments, offices, reporting lines, stand-ins | Done and tested | `database.test` |
| UI | Existing org screens connected to the real API (chart, move, level, duties, stand-ins, departments, roles read-only, changes feed) with loading/empty/error states | Done and tested in a real browser | `e2e/m1-live.spec.ts` (7 tests) |

## Open decisions for the owner

1. **Departments and offices: creating or editing them.** The plan lists them as stored data but does not say who creates them. The screen buttons exist in mock mode; in live mode they are switched off. Who should be allowed (suggest Owner/CEO), and should a department store its head, or keep deriving the head from the most senior person?
2. **Editing role permissions** (the Director's roles matrix in the mock). The plan does not require it. In live mode the matrix is read only; roles change through duties. Keep it that way?
3. **Same-level reporting** is a data table (`same_level_reporting_rules`), seeded with Director to CTO only. Confirm.
4. **Stand-in authorization rule I chose:** active, allowed to approve, at the manager's level or higher, not the manager. Confirm.

## Known limitations

- The screens still decide which buttons to show from their built-in demo roster; the server is the real lock and refuses everything else.
- The "reason" box in the screens accepts 3 characters, the server requires 5 and shows its message.
- Level-3 default role is not shown in the roles matrix (only the named Director and CTO roles are).
- Other modules, login and employee profiles remain demo (mock) data by design.
- A `pg` deprecation warning ("client.query() when already executing") appears in test output; not yet traced.
- GitHub Actions has not run on GitHub (pending), and does not yet include the browser tests.

## Update after the owner's decisions (made at the start of M2)

| Decision | Status |
|---|---|
| Owner and CEO create, edit and deactivate departments and offices | Done and tested (`backend/test/m1-structure.test.ts`, browser test) |
| Explicit `head_employee_id` for a department head, never derived; only Owner/CEO change it; audited | Done and tested. Reporting lines stay the source of truth for hierarchy and approvals (tested) |
| Role-permission editing stays read only; catalogue maintained centrally in the backend | Done (`backend/prisma/permission-catalogue.ts`) |
| Empty stand-in means no delegated approver; next eligible person upward approves; stand-in active, can approve, same or higher level, not the manager or the requester; valid dates; no overlaps or conflicts | Done and tested (conflicts: a stand-in cannot be away on the same dates, a manager cannot be away while covering for someone; people who have left are passed over) |
| Development-only identity removed once real authentication exists | Done: the header and its setting are deleted |
| PostgreSQL "client.query() already executing" warning | Investigated. It comes from Prisma's own transaction code, which sends the sub-queries of one transaction at the same time on its single connection. `pg` queues them correctly, so results are right; it is only a notice about a future `pg` version. No change made. |
| Redis hierarchy cache (M1-11) | **Still open**: not implemented. Redis is used for sessions only. |
| GitHub Actions | **Still pending**: it has never run on GitHub. |
