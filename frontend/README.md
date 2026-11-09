# Aceva Digital System: web frontend

Next.js 16 (App Router) + TypeScript + Tailwind CSS v4, running on mock data until each NestJS module is ready.
The full specification is in [`../spec.md`](../spec.md). Read §3 (design), §6 (folders) and §7 (data layer) before you start.

## Run it

```bash
cd frontend
npm install          # the npm cache is set to D:\npm-cache in .npmrc (C: is nearly full)
cp .env.example .env.local
npm run dev          # http://localhost:3000
```

| Script | What it does |
|---|---|
| `npm run dev` | Dev server with hot reload |
| `npm run build` / `npm start` | Production build and server |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (Next.js rules) |

### Environment

| Variable | Default | Meaning |
|---|---|---|
| `NEXT_PUBLIC_API_MODE` | `mock` | `mock` uses `src/mocks`; `live` calls the NestJS API |
| `NEXT_PUBLIC_API_URL` | `/api/v1` | Base URL of the API in live mode |
| `NEXT_PUBLIC_ENABLE_PHASE2` | `true` | Show the Sales zone and Integrations (M15, M16) |

## Demo personas (mock mode)

The login page lists every persona; one click signs in. Levels 1–3 and the finance duty person also see the 2FA screen (any 6 digits).

- Switch persona without signing out: avatar menu → **View as…**
- Open any page directly as a persona: add `?as=ACV-0007` to the URL, e.g. `http://localhost:3000/approvals?as=ACV-0006`
- See every screen's error state: add `?mockError=1`

| Emp-ID | Who | Good for |
|---|---|---|
| ACV-0001 | Owner | Everything, settings, reopen month |
| ACV-0002 | CEO | Payroll and journal approvals, company home |
| ACV-0003 | Director (acts as sales manager) | Pay fields, finance review, commission |
| ACV-0004 | CTO | Activity, security alerts, integrations |
| ACV-0005 | HR lead | Onboarding, personal details |
| ACV-0006 | Engineering team lead | Assigning tasks, reviews, workload |
| ACV-0007 | Developer | The employee experience |
| ACV-0009 | Sales executive | My sales day, leads, pipeline |
| ACV-0010 | Accounts officer (finance duty) | Journal entries, payroll prep (maker side) |
| ACV-0014 | Sales team lead | Targets, confirming Won deals |

## Where things are

```
src/app/           routes only: (auth) public pages, (app) signed-in pages
src/components/ui/ design-system primitives (Button, Dialog, Tabs …)
src/components/layout/  AppShell, Sidebar, Topbar, PageHeader, CommandPalette
src/components/shared/  business widgets used by many modules (EmpChip, Money, MaskedValue, ApprovalRelay, DataTable, EChart …)
src/features/<module>/  one folder per module: types.ts (API contract), api.ts, hooks.ts, logic.ts, components/
src/mocks/         in-memory data for mock mode (seed/ per module, db.ts table registry)
src/lib/           auth (permissions, scope, session), nav.ts, format.ts, dates.ts, api clients
src/hooks/         app-wide hooks (useUrlState, useHotkeys, useSessionTimers, useDirectory)
```

| Module | Folder | Routes |
|---|---|---|
| M1 Hierarchy and access | `features/access` | `/org` |
| M2 Login and sessions | `features/auth` | `/login`, `/login/verify`, `/first-login`, `/forgot-password`, `/reset-password`, `/account` |
| M3 Employee profiles | `features/people` | `/people`, `/people/new`, `/people/[empId]` |
| M4 Activity tracking | `features/activity` | `/activity` |
| M5 Tasks | `features/tasks` | `/tasks`, `/tasks/[id]` |
| M6 Performance | `features/performance` | `/performance`, `/performance/scorecards/[id]` |
| M7 Attendance and leave | `features/attendance` | `/attendance`, `/leave` |
| M8 Payroll | `features/payroll` | `/payroll`, `/payroll/runs/[id]`, `/payroll/payslips`, `/payroll/advances` |
| M9 Ledger | `features/ledger` | `/finance/ledger`, `/finance/accounts`, `/finance/parties`, `/finance/bills`, `/finance/banking`, `/finance/close` |
| M10 Statements | `features/statements` | `/finance/statements` |
| M11 Spreadsheet and graphs | `features/analysis` | `/finance/sheet`, `/finance/insights` |
| M12 Shared services | `features/system`, `features/home` | `/`, `/audit`, `/notifications`, `/settings` |
| M13 Billing and subscriptions | `features/billing` | `/billing`, `/billing/invoices/*`, `/billing/subscriptions` |
| M14 Communication | `features/comms` | `/messages`, `/announcements`, `/meetings` |
| M15 Sales and CRM | `features/sales` | `/sales`, `/sales/leads`, `/sales/pipeline`, `/sales/reports`, `/sales/targets` |
| M16 Sales tool integrations | `features/integrations` | `/integrations` |
| Approvals inbox (all modules) | `features/approvals` | `/approvals` |

## Adding a screen (the short version)

1. Add or extend the types in `features/<module>/types.ts`. Agree them with the backend developer first.
2. Add the service function in `api.ts` with a JSDoc line naming the real endpoint, e.g. `/** GET /tasks?scope=mine */`.
3. Wrap it in a hook in `hooks.ts` (query key `[module, entity, params]`; mutations invalidate `[module]`).
4. Build the screen in `features/<module>/components/` with the shared kit; start with `<PageHeader>`.
5. Add a thin `app/(app)/<route>/page.tsx` that renders it, and a nav entry in `lib/nav.ts` if it needs one.
6. If the module has approvals, return them from `features/<module>/approvals.ts`; the inbox picks them up.

## Connecting a module to the real API

See spec §13. For each function in `features/<module>/api.ts`, replace the `mock(...)` body with the `http` call from its JSDoc, delete the module's seed file, then run `npm run typecheck` and the module's screens. Components and hooks don't change.
