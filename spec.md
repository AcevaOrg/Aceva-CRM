# Aceva Digital System: Frontend Specification

| | |
|---|---|
| Version | 1.0, 9 November 2026 |
| Source | `Aceva_Digital_System_Development_Plan_v2.docx` (Development Plan v2) |
| Covers | The web frontend for all 16 modules: Release 1 (M1 to M14) and Phase 2 (M15 Sales and CRM, M16 Sales tool integrations) |
| Code | [`frontend/`](frontend/) |
| Readers | Developers A, B and C, the CTO, and anyone joining the project later |

---

## 0. How to use this spec

1. **Read sections 1 to 8 once.** They define the look, the app shell, the folder layout, the data layer and the permission rules that every module shares.
2. **When you pick up a module, read its section in §9.** Each module section lists its routes, screens, the rules the screen must enforce, the empty and error states, and the API contract (types plus endpoints).
3. **The TypeScript types in `src/features/<module>/types.ts` are the API contract.** The plan says the frontend and backend agree on the data before a screen is built. This spec and those type files are that agreement. If a field changes, change the type file first, then the NestJS DTO.
4. **The frontend runs today on mock data** (`NEXT_PUBLIC_API_MODE=mock`). When a backend module is ready, its `api.ts` functions are switched to real HTTP calls one module at a time (§13). Screens do not change.

> **Module count.** The development plan v2 has **16 modules**, not 13: 14 in the first release and 2 sales modules in Phase 2. This spec covers all 16, so every module, including the original 13, is included. The two Phase 2 modules carry a "Phase 2" tag in the UI and can be hidden with a feature flag.

---

## 1. Scope and goals

### 1.1 What this frontend must do

- Give each of the five roles (CEO / Founder / Owner, Director, CTO, Finance, Sales, Engineering) a home screen built for their day (§9.12).
- Put every feature of the 16 modules on a real screen, with mock data that behaves like the real thing: lists filter, forms validate, approvals move, balances update.
- Make the hierarchy and confidentiality rules **visible**, so people understand why they can or cannot see something (§3.5).
- Be quick to learn. A new employee should check in, find their tasks and request leave in their first 5 minutes without training.
- Work on a laptop and on a phone (§3.8).

### 1.2 Out of scope for the frontend phase

- Real authentication, real sessions, real file storage, email sending, PDF rendering, scheduled jobs and the sales tool syncs. The UI for each of these exists and calls a mock service.
- Security enforcement. The frontend **hides** what a person cannot use, but the server check is the real lock (plan §5). Nothing in the frontend is trusted for security.

### 1.3 Design principles

| Principle | What it means on screen |
|---|---|
| One thing per screen | Each page answers one question: "What do I have to do today?", "Is this entry balanced?", "Who is online?" |
| Show the rule, not just the block | When an action is not allowed, say why: "You prepared this payroll, so the Director must approve it." |
| Money is exact and calm | Tabular mono digits, right-aligned, currency always shown, no red unless something is wrong |
| Nothing is lost | No hard delete buttons. "Archive", "Reverse", "Cancel with reason" instead, each with a visible history |
| Fresh or flagged | Any number that comes from a sync or a snapshot shows when it was last updated |
| Keyboard first, mouse friendly | Command palette (Ctrl K) for every page and the common actions; every action is also a visible button |

---

## 2. Company structure, access and demo personas

### 2.1 The structure (fixed)

Aceva follows one strict structure. Every person has exactly one role; the role decides the level, the reporting line and the access.

```
L1  CEO / Founder / Owner ─── one person · sees everything · approves nothing
 └─ L2  Director ──────────── the approver for the whole company · HR duty · sales manager
     ├─ L3  CTO ───────────── runs engineering
     │    └─ L5  Engineering and development employees
     ├─ L4  Sales
     └─ L4  Finance ───────── the finance person · prepares, never approves
```

| Level | Role (`RoleKey`) | Reports to | Department | Colour token |
|---|---|---|---|---|
| 1 | CEO / Founder / Owner (`ceo`) | nobody | Management | `--level-1` gold |
| 2 | Director (`director`) | CEO / Founder / Owner | Management | `--level-2` violet |
| 3 | CTO (`cto`) | Director | Engineering and development | `--level-3` cobalt |
| 4 | Sales (`sales`) | Director | Sales | `--level-4` teal |
| 4 | Finance (`finance`) | Director | Finance | `--level-4` teal |
| 5 | Engineering and development (`engineer`) | CTO | Engineering and development | `--level-5` slate |

- **CEO / Founder / Owner** is one person. They see every activity, every report and every record in the company (including exports), but they **approve nothing**, prepare nothing and change no settings. The only thing they sign off is the Director's own leave or attendance correction, because nobody approves their own request.
- **Director** is the single approver: payroll, every journal entry, the month close and reopening it, Won deals, commission, sales targets, the final step of leave, settings (including ★ sections), and levels and reporting lines. The Director also holds **HR duty** and **sales-manager duty**, and never prepares finance items, so there is always a second person.
- **Finance** (the finance person, finance duty) prepares: journal entries, payroll runs, bills and expenses, customer invoices and payments, bank reconciliation, salary advances and the month close. Finance approves nothing.
- **CTO** manages engineering: assigns and reviews engineering tasks, gives the first approval on engineers' leave and corrections, sees security alerts, and runs backups and the sales-tool connections. No access to finance, payroll (except their own payslip) or sales data.
- **Sales** see only their own leads, deals, targets and reports.
- **Engineering and development** employees see only their own work and data.

Data scope (plan §5) still applies to every list: each person sees their own data and the data of everyone below them in their reporting line, never above or beside. The CEO / Founder / Owner's line is the whole company.

### 2.2 Access matrix

| Area | CEO / Founder / Owner | Director | CTO | Finance | Sales | Engineering |
|---|---|---|---|---|---|---|
| Own tasks, attendance, leave, scorecard, payslip, messages | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| See all activity, approvals in progress, reports | ✓ (view only) | reporting line | engineers | — | — | — |
| Approvals inbox | Director's own leave only; everything else read-only | **approves** | engineers' tasks and first step of leave | — | — | — |
| Assign and review tasks | — | CTO, Sales, Finance | Engineers | — | — | — |
| People: personal details, pay, onboarding, offboarding | view | manage (HR duty) | — | — | — | — |
| Payroll | view | **approve** (step-up) | own payslip | **prepare** | own payslip | own payslip |
| Ledger, statements, spreadsheet, insights | view + export | **approve** entries, export | — | **enter**, reconcile | — | — |
| Month close | view | **approve**, reopen | — | **run** | — | — |
| Billing and subscriptions | view | view, subscriptions | — | **invoices, payments** | — | — |
| Sales: leads, pipeline, reports | view all | whole team: targets, Won deals, exports | — | — | own only | — |
| Commission | view | **approve** | — | view | own lines | — |
| Integrations | view | manage | manage | — | — | — |
| Org and reporting lines | view | **change** | view | view | view | view |
| Audit log | ✓ | ✓ | — | — | — | — |
| Settings | view | **change** (★ with step-up) | view | — | — | — |

### 2.3 Approval chains (maker-checker)

Nobody approves their own request. The Director is the approver; the CEO / Founder / Owner watches.

| Item | Chain |
|---|---|
| Leave | Engineer: CTO → Director. CTO, Sales, Finance: Director. Director: CEO / Founder / Owner |
| Attendance correction | The person's manager (the Director's own: CEO / Founder / Owner) |
| Task review | The person who assigned it (CTO for engineers; Director for CTO, Sales and Finance) |
| Deadline extension | The person who assigned the task |
| Payroll | Prepared by Finance → approved by the Director with step-up |
| Journal entry | Entered by Finance → approved by the Director (any amount). Above PKR 500,000 and all capital and loan entries also notify the CEO / Founder / Owner |
| Month close | Run by Finance → approved by the Director. Reopen: Director only, with a reason; the CEO / Founder / Owner is notified |
| Won deal | Confirmed by the Director |
| Commission line | Approved by the Director → added to payroll |
| Monthly scorecard | Released by the person's manager |

### 2.4 Demo personas (mock mode only)

The login page lists these Emp-IDs in mock mode. Any password works; the CEO / Founder / Owner, Director, CTO and Finance also get the 2FA screen (any 6 digits work). The **View as** switcher in the avatar menu changes persona without logging out. Emp-IDs are never reused, so the numbering has gaps.

| Emp-ID | Name | Level | Role | Reports to | Shows off |
|---|---|---|---|---|---|
| ACV-0001 | Hamza Qureshi | 1 | CEO / Founder / Owner | (none) | Company home, everything visible, approvals in progress (read-only) |
| ACV-0003 | Bilal Ahmed | 2 | Director (HR duty, sales manager) | ACV-0001 | Every approval: payroll, entries, month close, leave, Won deals, commission; settings |
| ACV-0004 | Omar Farooq | 3 | CTO | ACV-0003 | Engineering tasks and reviews, engineers' leave, security alerts, integrations |
| ACV-0010 | Sana Malik | 4 | Finance officer (finance duty) | ACV-0003 | Journal entries, payroll preparation, invoices, reconciliation, month close (maker side) |
| ACV-0009 | Hira Baig | 4 | Sales executive | ACV-0003 | My sales day, leads, pipeline, daily log |
| ACV-0012 | Kamran Javed | 4 | Sales executive | ACV-0003 | Owns the Won deal waiting for the Director |
| ACV-0014 | Saad Mirza | 4 | Senior sales executive | ACV-0003 | Third salesperson for team reports |
| ACV-0006 | Fahad Khan | 5 | Senior software engineer | ACV-0004 | Engineer with a heavier workload |
| ACV-0007 | Mariam Shah | 5 | Software developer | ACV-0004 | Employee home, my tasks, check-in, leave |
| ACV-0008 | Ali Raza | 5 | Software developer | ACV-0004 | Second engineer for workload and reviews |
| ACV-0011 | Danish Iqbal | 5 | UI/UX developer | ACV-0004 | Extension request waiting for the CTO |
| ACV-0013 | Nida Aslam | 5 | Software intern (part-time) | ACV-0004 | Lower weekly capacity (20 h) |

---

## 3. Design language: "Strata"

### 3.1 Concept

A company is a stack of layers: five levels of people, four classes of data, one reporting line per person. **Strata** turns that structure into the visual system:

- **A deep ink spine.** The sidebar is always dark ink, in light mode too. It reads as the solid base of the company that everything rests on.
- **Four zones, four hues.** Navigation is grouped into the four blocks of the plan's system diagram: *People and work*, *Finance*, *Sales*, *Control*. Each zone has its own hue. The active nav item, the page eyebrow and the header texture use it, so you always know which part of the company you are in.
- **Layer lines.** A faint pattern of horizontal lines in the zone colour sits behind page headers, the login panel and empty states. It is the one decorative element and is used nowhere else.
- **Seals.** Every page that shows confidential data carries a confidentiality seal in its header, colour-coded by class (§3.5.2).
- **Signal citron.** One bright accent, citron, means "live, now": the checked-in pulse, the online dot, today's date in calendars, the focus ring of the current step. It is never used for decoration.

### 3.2 Colour tokens

All colours are CSS variables in [`src/app/globals.css`](frontend/src/app/globals.css), written in OKLCH and exposed to Tailwind through `@theme inline`. Use the Tailwind names (`bg-card`, `text-muted-foreground`, `bg-zone-finance/10`); never hard-code a hex value in a component.

| Token (Tailwind name) | Light | Dark | Use |
|---|---|---|---|
| `background` | `oklch(0.984 0.003 265)` | `oklch(0.165 0.018 265)` | Page canvas |
| `foreground` | `oklch(0.21 0.025 265)` | `oklch(0.95 0.006 265)` | Body text ("ink") |
| `card` | `oklch(1 0 0)` | `oklch(0.205 0.02 265)` | Cards, tables, dialogs |
| `muted` / `muted-foreground` | `oklch(0.962 0.006 265)` / `oklch(0.52 0.02 265)` | `oklch(0.245 0.022 265)` / `oklch(0.7 0.015 265)` | Secondary surfaces, helper text |
| `border`, `input` | `oklch(0.912 0.008 265)` | `oklch(0.3 0.022 265)` | Hairlines, inputs |
| `primary` | `oklch(0.53 0.2 264)` cobalt | `oklch(0.66 0.17 264)` | Primary buttons, links, selection |
| `signal` | `oklch(0.9 0.18 118)` citron | same | Live/now indicators only |
| `sidebar` | `oklch(0.2 0.028 265)` | `oklch(0.135 0.016 265)` | The ink spine |
| `zone-work` | `oklch(0.64 0.12 178)` teal | `oklch(0.72 0.12 178)` | People and work zone |
| `zone-finance` | `oklch(0.58 0.19 292)` violet | `oklch(0.7 0.16 292)` | Finance zone |
| `zone-sales` | `oklch(0.7 0.16 52)` ember | `oklch(0.76 0.14 52)` | Sales zone |
| `zone-control` | `oklch(0.6 0.11 238)` steel | `oklch(0.7 0.1 238)` | Control zone |
| `seal-highly` | `oklch(0.59 0.21 18)` | `oklch(0.7 0.18 18)` | Highly confidential |
| `seal-confidential` | `oklch(0.72 0.15 68)` | `oklch(0.8 0.13 68)` | Confidential |
| `seal-internal` | `oklch(0.6 0.13 240)` | `oklch(0.72 0.11 240)` | Internal |
| `seal-own` | `oklch(0.62 0.14 155)` | `oklch(0.74 0.13 155)` | Own data |
| `success`, `warning`, `danger`, `info` | green, amber, red, blue | lighter variants | Status only |
| `level-1` to `level-5` | gold, violet, cobalt, teal, slate | lighter variants | Level marks |

Rules:

- Text on any tinted background uses `foreground`, never the tint. Tints are applied at 10 to 15% (`bg-zone-sales/12`) with a 1 px border at 25%.
- Status is never shown by colour alone: every status badge has a text label and an icon.
- Charts use the categorical palette `chart-1` to `chart-6` (cobalt, teal, ember, violet, steel, citron-dark) defined in the same file.

### 3.3 Typography

| Role | Font | Size / weight | Notes |
|---|---|---|---|
| UI text | Geist Sans | 14 px / 400 | Base size; 13 px in dense tables |
| Labels, nav | Geist Sans | 13 px / 500 | |
| Page title | Geist Sans | 24 px / 600, tracking -0.02em | One per page |
| Section title | Geist Sans | 16 px / 600 | |
| Eyebrow | Geist Sans | 11 px / 600, uppercase, tracking 0.08em | Zone name above the page title |
| Big numbers | Geist Sans | 28 to 36 px / 600, `tabular-nums` | KPI cards |
| Emp-IDs, entry numbers, money, codes | Geist Mono | inherits size, `tabular-nums` | Use the `<Mono>` / `<Money>` components |

Fonts come from the `geist` npm package (self-hosted, works offline).

### 3.4 Space, shape and depth

- 4 px spacing grid. Page padding 24 px on desktop, 16 px on phones.
- Radius: 8 px controls, 12 px cards, 16 px dialogs and the login card, full for pills and avatars.
- Depth: cards use a 1 px border and the soft `shadow-strata` (a 1 px top highlight plus a wide, faint drop). Popovers and dialogs use `shadow-float`. No other shadows.
- Content width: tables and boards use the full width; forms and reading pages cap at 720 px.

### 3.5 Signature patterns

These are the parts of the design that are specific to Aceva. Patterns used by several modules are shared components in `src/components/shared/`; the ones used by a single module (`BalanceMeter` in M9, `SelfCheck` in M10, `SizePicker` in M5) live in that module's `components/` folder.

#### 3.5.1 Zone eyebrow and layer lines (`PageHeader`)

Every page starts with `PageHeader`: eyebrow (zone name in zone colour), title, one-line description, the confidentiality seal if any, and the page's actions on the right. The header background carries the layer-line texture in the zone colour at 6% opacity.

#### 3.5.2 Confidentiality seal (`ConfidentialSeal`)

| Class | Icon | Label | Tooltip text |
|---|---|---|---|
| `highly` | ShieldAlert | Highly confidential | "CEO / Founder / Owner and Director only. Views and exports are logged." |
| `confidential` | Shield | Confidential | "Director and above, plus people with a duty for this data." |
| `internal` | Building2 | Internal | "Visible to employees by hierarchy." |
| `own` | UserRound | Your data | "Only you and the levels above you." |

The seal appears in page headers, on cards that mix classes (e.g. the Director's home), and in export dialogs.

#### 3.5.3 Masked values (`MaskedValue`)

Bank account numbers, CNIC numbers and other people's salaries show as `•••• 4821`. A person with permission sees an eye button. Clicking it may ask for step-up confirmation (§3.5.5), then shows the value for 30 seconds and adds a toast: "Shown for 30 s. This view is logged." People without permission see the mask with no button.

#### 3.5.4 Level mark (`LevelMark`) and Emp chip (`EmpChip`)

`LevelMark` is five thin stacked bars, with the bar for the person's level filled in the level colour, plus an optional label ("L3 · Director"). `EmpChip` is avatar + name + Emp-ID in mono, used everywhere a person is named. Hovering an `EmpChip` shows a card with designation, department, level and "reports to".

#### 3.5.5 Step-up confirmation (`StepUpDialog`)

For risky actions the plan requires the password and 2FA code again: approving payroll, posting large entries, reopening a closed month, exporting statements, viewing bank details, changing a sales tool key. The dialog names the action ("Approve November 2026 payroll · PKR 4,812,300") and asks for password + 6 digits. In mock mode any password and any 6 digits pass. Use the `useStepUp()` hook: `await stepUp({ action: '...' })` resolves only on success.

#### 3.5.6 Maker-checker relay (`ApprovalRelay`)

A horizontal chain of steps (Prepared by, Reviewed by, Approved by), each with an `EmpChip`, a state (done, waiting, skipped) and a time. If the current user is the maker, the approve button is replaced by a note: "You prepared this, so you can't approve it. It goes to Bilal Ahmed (Director)." Used by journal entries, payroll runs, leave requests, extension requests, commission lines, month close.

#### 3.5.7 Balance meter (`BalanceMeter`)

In the journal entry composer, a beam tilts toward the heavier side as debit and credit lines are typed, and shows the difference ("Credits short by PKR 1,500.00"). When equal, the beam levels, turns green and reads "Balanced". The Submit button stays disabled until balanced.

#### 3.5.8 Self-check strip (`SelfCheck`)

Each financial statement shows its built-in checks (plan §14) as a strip of pass/fail rows with the two numbers being compared. Any fail turns the strip red and disables "Mark final".

#### 3.5.9 Freshness stamp (`FreshnessStamp`)

Any number that comes from a sync, a snapshot or a nightly job shows its age: "Apollo · updated 12 min ago". After 1 hour it turns amber, after 3 hours red with "Numbers may be out of date".

#### 3.5.10 Size picker and workload bar (`SizePicker`, `WorkloadBar`)

Task size is a 5-segment control (XS, S, M, L, XL) showing points and hours. XL is selectable but blocks the Assign button with "XL tasks must be split before they are assigned". `WorkloadBar` shows open hours against weekly capacity, with the part over capacity in red hatching.

#### 3.5.11 Score dial (`ScoreDial`)

A 270° ring from 0 to 100, coloured by band: Excellent (85+, success), Good (70 to 84, primary), Needs improvement (50 to 69, warning), Poor (below 50, danger). The band name is always written under the number.

### 3.6 Motion

- 150 ms for hover and press, 200 ms for popovers and sheets, ease-out. Nothing over 300 ms.
- Three meaningful animations only: the citron pulse on "checked in" and "online", the balance meter beam, and the layer lines drifting slowly on the login panel.
- Everything respects `prefers-reduced-motion`.

### 3.7 Accessibility

- WCAG 2.2 AA contrast for text and controls in both themes.
- All interactive elements reachable by keyboard with a visible focus ring (2 px `ring` colour, 2 px offset).
- Primitives are built on Radix UI, so dialogs trap focus, menus support arrow keys, and screen-reader labels are present.
- Icons that carry meaning have an `aria-label`; decorative icons are `aria-hidden`.
- Forms: every input has a visible label; errors are announced and linked with `aria-describedby`.
- Tables: real `<table>` markup with `<th scope>`; sort state announced.

### 3.8 Responsive behaviour

| Width | Layout |
|---|---|
| 1280 px and up | Full sidebar (264 px), content up to the edge |
| 1024 to 1279 px | Sidebar collapses to a 72 px icon rail (labels on hover) |
| Below 1024 px | Sidebar becomes a slide-in sheet from the menu button; the topbar keeps check-in, bell and avatar |
| Below 640 px | Tables switch to stacked cards for key lists (tasks, leave, approvals); boards scroll horizontally per column |

The employee screens used daily (home, check-in, my tasks, leave, payslips, messages, my sales day) must be fully usable at 360 px.

---

## 4. App shell and navigation

### 4.1 Layout

```
┌──────────┬────────────────────────────────────────────────────────────┐
│  ▤ Aceva │  Breadcrumb          [ Search or jump to…  Ctrl K ]   ● 4h 12m  ◷ 27m  🔔3  ◐  (MS) │
│          ├────────────────────────────────────────────────────────────┤
│  Home    │  PEOPLE AND WORK                                [Internal] │
│  Approvals 4 │  My tasks                               [ + Assign ] │
│          │  Everything assigned to you, by deadline                   │
│ PEOPLE & WORK ├──────────────────────────────────────────────────────┤
│  Tasks   │                                                            │
│  …       │                     page content                           │
│ FINANCE  │                                                            │
│ SALES    │                                                            │
│ CONTROL  │                                                            │
│ ──────── │                                                            │
│ (MS) Mariam Shah  L5         │                                         │
└──────────┴────────────────────────────────────────────────────────────┘
```

Topbar items, left to right: breadcrumb, command palette trigger, **check-in pill** (checked-in time and elapsed; a click opens the check-in card), **session ring** (minutes left before idle logout; 10 min on finance screens), notifications bell, theme toggle, avatar menu (My account, View as… in mock mode, Sign out).

### 4.2 Navigation map

Defined once in [`src/lib/nav.ts`](frontend/src/lib/nav.ts). Each item has a route, icon, zone and the permission that makes it visible. Items the user cannot use are not rendered.

| Zone | Item | Route | Module | Visible with |
|---|---|---|---|---|
| (top) | Home | `/` | M12 dashboards | everyone |
| (top) | Approvals | `/approvals` | cross-module | anyone with an approve permission |
| People and work | Tasks | `/tasks` | M5 | `task.view_own` |
| | Attendance | `/attendance` | M7 | `attendance.self` |
| | Leave | `/leave` | M7 | `leave.request` |
| | Performance | `/performance` | M6 | `performance.view_own` |
| | People | `/people` | M3 | `people.view_directory` |
| | Payroll | `/payroll` | M8 | `payroll.view_own` (employees see only their payslips) |
| | Messages | `/messages` | M14 | `comms.use` |
| | Announcements | `/announcements` | M14 | `comms.use` |
| | Meetings | `/meetings` | M14 | `comms.use` |
| Finance | Ledger | `/finance/ledger` | M9 | `finance.view` |
| | Accounts | `/finance/accounts` | M9 | `finance.view` |
| | Clients and vendors | `/finance/parties` | M9 | `finance.view` |
| | Bills and expenses | `/finance/bills` | M9 | `finance.view` |
| | Banking | `/finance/banking` | M9 | `finance.view` |
| | Month close | `/finance/close` | M9 | `finance.close` |
| | Statements | `/finance/statements` | M10 | `statements.view` |
| | Spreadsheet | `/finance/sheet` | M11 | `sheet.view` |
| | Insights | `/finance/insights` | M11 | `insights.view` |
| | Billing | `/billing` | M13 | `billing.view` |
| | Subscriptions | `/billing/subscriptions` | M13 | `subscriptions.view` |
| Sales (Phase 2) | My sales day | `/sales` | M15 | `sales.own` |
| | Leads | `/sales/leads` | M15 | `sales.own` |
| | Pipeline | `/sales/pipeline` | M15 | `sales.own` |
| | Sales reports | `/sales/reports` | M15 | `sales.own` |
| | Targets and commission | `/sales/targets` | M15 | `sales.targets` or `sales.commission_view` |
| Control | Org and access | `/org` | M1 | `org.view` |
| | Activity | `/activity` | M4 | `activity.view_own` |
| | Audit log | `/audit` | M12 | `audit.view` |
| | Integrations | `/integrations` | M16 | `integrations.view` |
| | Settings | `/settings` | M12 | `settings.view` |
| (footer) | My account | `/account` | M2 | everyone |
| (footer) | Notifications | `/notifications` | M12 | everyone |

### 4.3 Command palette (Ctrl K / ⌘K)

Built with `cmdk`. Three groups:

1. **Go to**: every page the user can see (from `nav.ts`).
2. **Do**: Check in / Check out, Assign a task, Request leave, New journal entry, New invoice, Add a lead, Log my sales day, New message. Only actions the user is allowed to do are listed.
3. **Find**: people by name or Emp-ID, tasks by number, entries by number (mock search across the in-memory data).

Other shortcuts: `?` opens the shortcut sheet, `g h` home, `g t` tasks, `g a` approvals, `Esc` closes any sheet or dialog.

### 4.4 Notifications

Bell popover with tabs **All**, **Approvals**, **Mentions**; unread count on the bell. Each notification has an icon by type, a one-line text, time, and a link. "Mark all read". Full history at `/notifications` with filters and the email preference switches (approvals and security alerts are locked on, per plan §17). Event types: task assigned, due soon, overdue, reviewed; extension asked/answered; leave asked/answered; approval waiting; payroll ready; payslip available; scorecard released; security alert; new sales reply; sales follow-up due; sales tool connection problem; new message or mention; announcement to acknowledge; subscription renewal due; invoice overdue.

### 4.5 Approvals inbox (`/approvals`)

The plan has approvals in nine places. The inbox puts them in one list, so a manager has one place to clear every morning.

- Tabs by type with counts: All, Leave, Task reviews, Extensions, Attendance corrections, Journal entries, Payroll, Month close, Commission, Won deals, Scorecards.
- Each row: type icon, title, requester `EmpChip`, amount or dates, age, and quick buttons (Approve, Reject). Rejecting always asks for a reason.
- Rows that need step-up show a lock icon on the Approve button.
- Rows the user made themselves never appear (maker-checker); a note at the bottom says how many such items were routed up.

### 4.6 Session behaviour (UI side of M2)

- Idle timer: 30 min normal, 10 min on any `/finance`, `/payroll` or `/billing` route. At 60 s left, a dialog "Still there? You'll be signed out in 0:59" with Stay signed in / Sign out.
- Hard limit 12 h: the session ring shows it in the tooltip.
- The "still here" heartbeat (plan §8) is sent every 60 s by `useActivityHeartbeat()`; in mock mode it only updates the local active/idle state shown in the topbar.
- Each page open is reported by `useTrackScreen()` (mock: pushes to the activity store, so the Activity timeline shows your own clicks live).

---

## 5. Tech stack (frontend)

| Part | Choice | Version |
|---|---|---|
| Framework | Next.js (App Router) + React | `next 16.4.x`, `react 19.3.x` |
| Language | TypeScript (strict) | `5.9.x` |
| Styling | Tailwind CSS v4 (CSS-first config) | `4.3.x` |
| Primitives | Radix UI (single `radix-ui` package), shadcn/ui patterns, `class-variance-authority`, `tailwind-merge` | `radix-ui 1.8.x` |
| Icons | `lucide-react` | `1.x` |
| Forms | React Hook Form + Zod (`@hookform/resolvers`) | `rhf 7.x`, `zod 4.x` |
| Server state | TanStack Query | `5.x` |
| Client state | Zustand (session, persona, UI prefs) | `5.x` |
| Tables | In-house `DataTable` (`components/shared/data-table.tsx`: sort, search, paging, phone cards) for lists; AG Grid Community for the finance spreadsheet only | `ag-grid 36.x` |
| Charts | Apache ECharts (modular imports, own `<EChart>` wrapper) | `echarts 6.x` |
| Command palette | `cmdk` | `1.x` |
| Toasts | `sonner` | `2.x` |
| Dates | `date-fns` (display in Asia/Karachi via `Intl`) | `4.x` |
| Theme | `next-themes` (light, dark, system) | `0.4.x` |
| Fonts | `geist` (Geist Sans, Geist Mono) | `1.x` |
| Tests (later) | Vitest + Testing Library (units), Playwright (screens) | |

The plan's backend (NestJS, PostgreSQL, Prisma, Redis/BullMQ) is not part of this phase. The frontend talks to it through `src/lib/api/http.ts` once it exists.

---

## 6. File structure

```
Aceva-CRM/
├─ spec.md                         ← this file
├─ Aceva_Digital_System_Development_Plan_v2.docx
└─ frontend/
   ├─ README.md                    how to run, scripts, conventions in short
   ├─ package.json
   ├─ next.config.ts
   ├─ tsconfig.json                path alias  @/*  →  src/*
   ├─ postcss.config.mjs
   ├─ eslint.config.mjs
   ├─ .env.example                 NEXT_PUBLIC_API_MODE, NEXT_PUBLIC_API_URL, NEXT_PUBLIC_ENABLE_PHASE2
   ├─ public/                      logo, favicon
   └─ src/
      ├─ app/                      ROUTES ONLY. Pages are thin: read params, render a feature screen.
      │  ├─ layout.tsx             fonts, theme, providers
      │  ├─ globals.css            Strata tokens + Tailwind
      │  ├─ not-found.tsx
      │  ├─ (auth)/                public pages, split-screen layout
      │  │  ├─ login/  login/verify/  forgot-password/  reset-password/  first-login/
      │  └─ (app)/                 signed-in pages, wrapped by <AppShell>
      │     ├─ page.tsx            Home ("My day")
      │     ├─ approvals/  tasks/  attendance/  leave/  performance/  people/  payroll/
      │     ├─ messages/  announcements/  meetings/
      │     ├─ finance/ledger/  finance/accounts/  finance/parties/  finance/bills/
      │     ├─ finance/banking/  finance/close/  finance/statements/  finance/sheet/  finance/insights/
      │     ├─ billing/  sales/  org/  activity/  audit/  integrations/  settings/
      │     └─ account/  notifications/
      ├─ components/
      │  ├─ ui/                    design-system primitives. No business logic, no data fetching.
      │  ├─ layout/                AppShell, Sidebar, Topbar, PageHeader, CommandPalette, ViewAsMenu
      │  └─ shared/                business widgets used by 2+ modules: EmpChip, LevelMark,
      │                            ConfidentialSeal, MaskedValue, StepUpDialog, ApprovalRelay,
      │                            Money, StatCard, ScoreDial, EChart, DataTable, Timeline, EmptyState…
      ├─ features/                 ONE FOLDER PER MODULE. Everything module-specific lives here.
      │  ├─ access/        M1   hierarchy, roles, permissions, org chart, stand-ins
      │  ├─ auth/          M2   login, 2FA, password, sessions, devices
      │  ├─ people/        M3   employee profiles, onboarding, offboarding
      │  ├─ activity/      M4   sessions, events, timeline, alerts
      │  ├─ tasks/         M5   tasks, sizes, deadlines, extensions, workload
      │  ├─ performance/   M6   reviews, scorecards, weights, disputes
      │  ├─ attendance/    M7   check-in, corrections, leave, holidays
      │  ├─ payroll/       M8   runs, payslips, advances, tax slabs
      │  ├─ ledger/        M9   accounts, entries, parties, bills, banking, close
      │  ├─ statements/    M10  five statements, extra reports
      │  ├─ analysis/      M11  spreadsheet, insights graphs
      │  ├─ system/        M12  audit log, notifications, settings, backups
      │  ├─ home/          M12  role-based home dashboards
      │  ├─ approvals/     (cross-module) unified approvals inbox
      │  ├─ billing/       M13  customer invoices, payments, subscriptions, renewals, usage
      │  ├─ comms/         M14  messages, channels, announcements, meetings
      │  ├─ sales/         M15  leads, deals, pipeline, targets, daily log, reports, commission
      │  └─ integrations/  M16  tool connections, sync health, user linking
      │
      │     Inside every feature folder (create only what you need):
      │       components/   screens and widgets for this module only
      │       types.ts      the API contract for this module (shared with the backend DTOs)
      │       api.ts        service functions: mock today, HTTP tomorrow. One function per endpoint.
      │       hooks.ts      TanStack Query hooks wrapping api.ts (useTasks, useAssignTask…)
      │       schemas.ts    Zod schemas for forms
      │       logic.ts      pure business rules (suggested deadline, net salary…), unit-testable
      │
      ├─ mocks/                    mock mode only. Deleted module by module as the backend lands.
      │  ├─ db.ts                  the in-memory "database" (arrays seeded from seed/*)
      │  └─ seed/                  one seed file per module, dates relative to today
      ├─ lib/
      │  ├─ api/                   http.ts (fetch wrapper), mock.ts (latency + errors), query-client.ts
      │  ├─ auth/                  session store, permissions.ts (role → permission map), scope.ts
      │  ├─ nav.ts                 navigation (single source of truth)
      │  ├─ format.ts              money, numbers, Emp-ID, file size
      │  ├─ dates.ts               PKT display, working days, relative due text
      │  └─ utils.ts               cn() and small helpers
      ├─ hooks/                    app-wide hooks: useStepUp, useIdleTimer, useTrackScreen, useHotkeys
      └─ types/                    shared domain types: Employee, Level, Money, Paginated, Confidentiality
```

**Rules that keep the structure easy to follow**

1. **Routes stay thin.** A `page.tsx` reads URL params and renders one component from `features/`. No data fetching or business logic in `app/`.
2. **A feature never imports another feature's `components/`.** It may import another feature's `types.ts`, `hooks.ts` and (for cross-module flows such as "won deal → draft invoice") `api.ts`. If two modules need the same widget, move it to `components/shared/`. One exception: `features/home` (the dashboards) may import the dashboard widgets a module exports for it (`CheckInCard`, `TeamTodayCard`, `MySalesDayWidget`).
3. **Only `api.ts` touches data.** Components call hooks, hooks call `api.ts`, `api.ts` calls `mocks/db` (now) or `lib/api/http` (later).
4. **Business rules live in `logic.ts`** as pure functions, so the same rule can be unit-tested and mirrored on the server.
5. **One component per file**, file names in kebab-case (`journal-composer.tsx`), components in PascalCase (`JournalComposer`).
6. **Every module folder starts with a header comment in `types.ts`**: module number, name, plan section, owner developer.

---

## 7. Data layer

### 7.1 Flow

```
Component  →  hook (TanStack Query)  →  api.ts  →  mock adapter (now)   →  mocks/db.ts
                                                 →  http client (later) →  NestJS /api/v1
```

### 7.2 API conventions (shared with the backend)

| Item | Convention |
|---|---|
| Base URL | `NEXT_PUBLIC_API_URL`, default `/api/v1` |
| Auth | Secure HTTP-only cookie set by the server (the browser never sees a token) |
| IDs | Internal UUIDs; people see Emp-IDs (`ACV-0007`) and numbers (`TSK-0142`, `JE-2026-0311`, `INV-2026-0048`, `PR-2026-11`) |
| Money | `{ amount: string; currency: 'PKR' \| 'USD' }`. Amount is a decimal **string** with 2 decimals (never a float), matching PostgreSQL `NUMERIC(…, 2)` |
| Dates | ISO 8601 UTC strings from the API; displayed in Asia/Karachi |
| Lists | `GET /things?page=1&pageSize=25&sort=-deadline&q=…` → `{ items: T[]; total: number; page: number; pageSize: number }` |
| Errors | `{ code: string; message: string; details?: Record<string, string[]> }`. `403` shows "You don't have access" with the reason; finance `403`s are returned as `404` (plan §16) |
| Mutations | `POST` create, `PATCH` partial update, `POST /things/:id/<action>` for state changes (`/submit`, `/approve`, `/reject`, `/reverse`) |
| Audit fields | Every record has `createdAt`, `createdBy`, `updatedAt`, `updatedBy` |

### 7.3 Mock mode

- `mocks/db.ts` holds arrays seeded once per browser tab from `mocks/seed/*`. Mutations change the arrays, so the demo behaves like a real app until the page reloads.
- `lib/api/mock.ts` wraps each call with 150 to 400 ms latency, applies the hierarchy scope for the current persona (`lib/auth/scope.ts`), and can simulate errors with `?mockError=1` in the URL.
- Seed dates are relative to today, so the data never looks stale.
- Every `api.ts` function has a JSDoc line with its real endpoint, e.g. `/** GET /tasks?scope=mine */`. This list is the contract table for the backend developer.

### 7.4 Query keys

`[module, entity, params]`, e.g. `['tasks', 'list', { scope: 'team', status: 'open' }]`. Mutations invalidate by `[module]` prefix. Defined in each `hooks.ts`.

---

## 8. Permissions in the frontend

- `lib/auth/permissions.ts` defines the permission strings and the default role → permissions map. Duties add permissions.
- `useCan('payroll.approve')` returns a boolean. `<Can permission="…">` renders children only if allowed. `<RequireAccess permission="…" mode="hide|404">` wraps whole pages; finance pages use `mode="404"` so a direct link shows Not Found.
- Data scope (own + everyone below in the reporting line) is applied in the mock adapter with `inScope(viewer, empId)`, the same rule the server's scope filter uses.
- **Maker-checker in the UI**: `canApprove(item, viewer)` returns `{ ok: false, reason, routedTo }` when the viewer is the maker. The UI shows the reason instead of the button.

Permission list (mirrors M1 settings):

```
org.view  org.manage  roles.manage  standin.manage
people.view_directory  people.view_job  people.view_personal  people.view_pay  people.manage  people.manage_pay
auth.unlock_account  session.force_logout
activity.view_own  activity.view_team  activity.view_all  activity.security
task.view_own  task.assign  task.review  task.view_team
performance.view_own  performance.view_team  performance.view_all  performance.weights
attendance.self  attendance.view_team  attendance.approve_correction  leave.request  leave.approve
payroll.view_own  payroll.view  payroll.prepare  payroll.review  payroll.approve  payroll.export
finance.view  finance.entry_create  finance.entry_approve  finance.close  finance.reopen  finance.export
statements.view  statements.export  sheet.view  sheet.import  insights.view
audit.view  settings.view  settings.manage  backup.view
billing.view  billing.manage  subscriptions.view  subscriptions.manage
comms.use  comms.admin  announcements.publish
sales.own  sales.team  sales.all  sales.targets  sales.commission_view  sales.commission_approve  sales.export
integrations.view  integrations.manage
```

---

## 9. Module specifications

Each module lists: **Routes**, **Screens**, **UI rules** (business rules the screen must show or enforce), **States**, and the **Contract** (main types and endpoints; full types in `features/<module>/types.ts`).

### 9.1 M1 Hierarchy and access control · `features/access` · Zone: Control

**Routes**: `/org` with tabs `?tab=chart|departments|roles|standins`.

**Screens**

| Screen | What it shows | Who |
|---|---|---|
| Org chart | Interactive tree from the CEO / Founder / Owner down. Each node: avatar, name, Emp-ID, designation, `LevelMark`, department colour. Collapse/expand branches, search to highlight a person, zoom to fit. Clicking a node opens a side sheet with "reports to", direct reports, role and duties. | Everyone with `org.view` (people see the whole tree; data shown follows scope) |
| Change reporting line | From the side sheet: "Move under…" with a person picker and a required reason. Preview shows the branch that moves. | Director (`org.manage`); everyone else views |
| Departments and offices | Cards per department: head, headcount, offices. Add/edit department, add office. | View all; edit with `org.manage` |
| Roles and permissions | Matrix: roles as columns, permissions grouped by module as rows, ticks. Duty roles (Finance duty, HR duty, Sales manager) shown as add-ons. Filter by module. Changing a tick asks for a reason. | View with `roles.manage`; levels 1 to 3 |
| Stand-ins | Table of active and upcoming stand-ins: manager, stand-in, dates, status. "Add stand-in" dialog with date range; default fallback "next level up" shown. | Levels 1 to 4 for themselves; `standin.manage` for others |

**UI rules**: only the Director sees edit controls for levels and reporting lines; every change asks for a reason and shows "This change is saved in the audit log"; you cannot be your own stand-in; a stand-in must be at the same level or higher.

**States**: empty stand-ins → "No stand-ins set. When you're on leave your approvals go to {next level up}."

**Contract**

```ts
type Level = 1 | 2 | 3 | 4 | 5
interface OrgNode { empId: string; name: string; designation: string; level: Level; departmentId: string; reportsTo: string | null; avatarUrl?: string }
interface Department { id: string; name: string; headEmpId: string; officeIds: string[]; headcount: number }
interface Role { id: string; name: string; level?: Level; isDuty: boolean; permissions: string[] }
interface StandIn { id: string; managerEmpId: string; standInEmpId: string; from: string; to: string; reason?: string }
GET /org/tree · PATCH /org/reporting-line { empId, reportsTo, reason }
GET /departments · POST /departments · GET /offices
GET /roles · PATCH /roles/:id/permissions { permissions, reason }
GET /stand-ins · POST /stand-ins · DELETE /stand-ins/:id (ends early, kept in history)
```

### 9.2 M2 Emp-ID login and sessions · `features/auth` · Zone: (public) and My account

**Routes**: `/login`, `/login/verify`, `/forgot-password`, `/reset-password`, `/first-login`, `/account?tab=overview|security|devices|history`.

**Screens**

| Screen | Details |
|---|---|
| Login | Split layout: ink panel with drifting layer lines and the line "One company. Every layer in order." Form: Emp-ID input with a fixed `ACV-` prefix and a 4-digit field (pasting `ACV-0007` works), password with show/hide and Caps Lock warning, Sign in. Errors: "Emp-ID or password is wrong (3 tries left)", "Account locked after 5 wrong passwords. Ask your manager or the Director to unlock it.", "Too many attempts from this network. Try again in 10 minutes." Mock mode shows a "Demo accounts" panel with persona chips. |
| 2FA | Six single-digit boxes with auto-advance, paste support, 30-second code timer hint, "Use Google or Microsoft Authenticator". |
| Forgot password | Emp-ID → "If this Emp-ID has an official @acevatech.com email, we sent a link valid for 15 minutes." Second path text: "No official email? Ask the Director for a temporary password." |
| Reset / first login | New password with a live rule checklist (10+ characters, not one of your last 3 passwords, not your Emp-ID), strength meter, confirm field. First login adds step 2: the **tracking policy** in plain words, two columns "What we record" / "What we never record" (from plan §8 fair-use rules, including the connected sales tools), and an "I have read and accept" checkbox. Step 3 (CEO / Founder / Owner, Director, CTO, Finance): set up 2FA with a QR placeholder and a 6-digit check. |
| My account · Overview | Profile summary, level, duties, Emp-ID, official email. |
| My account · Security | Change password, 2FA status (required/optional), recovery note. |
| My account · Devices | Cards per active session: device, browser, city (approximate), signed-in time, last active, "This device" tag. "Sign out" per device and "Sign out all other devices". |
| My account · Login history | Own logins and logouts with how they ended (clicked, timed out, forced, password changed). |

**UI rules**: no "remember me" for finance users; 2FA is required for the CEO / Founder / Owner, Director, CTO and Finance (toggle is locked on with an explanation); signing out ends the session on every device when chosen.

**Contract**

```ts
interface LoginRequest { empId: string; password: string }
interface LoginResult { status: 'ok' | '2fa_required' | 'password_change_required' | 'locked' | 'invalid' | 'rate_limited'; attemptsLeft?: number; retryAfterSec?: number }
interface SessionInfo { id: string; device: string; browser: string; os: string; city: string; ip: string; startedAt: string; lastActiveAt: string; current: boolean }
POST /auth/login · POST /auth/2fa/verify · POST /auth/logout · POST /auth/password/forgot · POST /auth/password/reset
POST /auth/password/change · POST /auth/policy/accept · POST /auth/2fa/setup · GET /auth/me
GET /auth/sessions · DELETE /auth/sessions/:id · DELETE /auth/sessions (all others) · GET /auth/login-history
```

### 9.3 M3 Employee profiles · `features/people` · Zone: People and work

**Routes**: `/people` (directory), `/people/new` (onboarding), `/people/[empId]?tab=basic|job|personal|pay|documents|history`.

**Screens**

| Screen | Details |
|---|---|
| Directory | Grid of person cards (photo, name, Emp-ID, designation, department, online dot) with a list toggle. Filters: department, office, level, type, status. Search by name or Emp-ID. "Add employee" for the Director (HR duty). |
| Profile header | Large avatar, name, Emp-ID, designation, `LevelMark`, department, status badge (Active / On notice / Left), "Reports to" chip, quick actions (Message, Assign task, View activity) as allowed. |
| Tabs | **Basic** (everyone). **Job**: level, reports to, joining date, type, status (self + above). **Personal**: CNIC (masked), phone, address, emergency contact (self, Director, CEO / Founder / Owner). **Pay**: base salary, allowances, bank and account (masked) (self, Director, CEO / Founder / Owner), seal `highly`. **Documents**: CV, contract, CNIC copy, certificates as file cards with upload (self, Director, CEO / Founder / Owner). **History**: every field change, old → new, who, when. Tabs the viewer cannot see are not shown. |
| Edit | Inline "Edit" per section. Employee can edit phone, address, emergency contact only. Job fields: Director (HR duty). Pay fields: Director only, with step-up. |
| Onboarding wizard | 4 steps: Basic → Job (level, reports to, joining date, type) → Pay (Director only) → Review. On finish: "Emp-ID ACV-0015 created. A welcome email with a temporary password was sent to …". The Emp-ID is shown as "assigned on save". |
| Offboarding | "Set last working day" dialog (Director, HR duty): date, reason; preview of what happens on that day: login disabled, sessions ended, N open tasks move to the manager, leads move to the sales manager (sales staff), final salary goes to payroll. The record is kept. |

**Contract**

```ts
type EmploymentType = 'full_time' | 'part_time' | 'intern'
type EmploymentStatus = 'active' | 'on_notice' | 'left'
interface Employee { id: string; empId: string; name: string; photoUrl?: string; designation: string; departmentId: string; officeId: string; officialEmail: string; level: Level; reportsTo: string | null; joiningDate: string; type: EmploymentType; status: EmploymentStatus; weeklyCapacityHours: number; roleIds: string[]; duties: Duty[]; lastWorkingDay?: string }
interface PersonalDetails { cnic: string /* masked unless revealed */; phone: string; address: string; emergencyContact: { name: string; relation: string; phone: string } }
interface PayDetails { baseSalary: Money; allowances: { name: string; amount: Money }[]; bankName: string; accountNumber: string /* masked */ }
interface EmployeeDocument { id: string; kind: 'cv' | 'contract' | 'cnic' | 'certificate' | 'other'; fileName: string; sizeBytes: number; uploadedAt: string; uploadedBy: string }
interface FieldChange { field: string; oldValue: string; newValue: string; changedBy: string; changedAt: string; reason?: string }
GET /employees · GET /employees/:empId · POST /employees · PATCH /employees/:empId/{basic|job|personal|pay}
GET /employees/:empId/history · GET|POST /employees/:empId/documents · POST /employees/:empId/offboard
POST /employees/:empId/reveal { field } (logged)
```

### 9.4 M4 Employee activity tracking · `features/activity` · Zone: Control

**Routes**: `/activity?tab=online|timeline|search|reports|alerts|mine`. Employees land on `mine`.

**Screens**

| Screen | Details | Who |
|---|---|---|
| Online now | Live list: person, logged in since, current screen, Active/Idle pill (citron pulse when active), device. Counters: online, active, idle. Row menu: Force logout (step-up), Lock account. | CEO / Founder / Owner, Director, CTO (each within their reporting line) |
| Employee timeline | Pick a person and a day. Vertical timeline: login, screens opened, actions, idle spans (grey bars with duration), logout with reason. Day summary on top: first login, last logout, active hours, idle hours, actions, attendance check-in next to first login with the gap highlighted. | CTO (engineers), Director (reporting line), CEO / Founder / Owner (everyone) |
| Activity search | Filters: person, department, module, action type, date range, source (Aceva / Apollo / MillionVerifier / Mailbox). Results table with old → new value diff for changes. Export (Excel/PDF), which itself is logged. | Director+ |
| Reports | Daily and weekly tables: per person and per team login time, logout time, active hours, actions. Small bar chart of active vs idle per person. | CTO (engineers), Director, CEO / Founder / Owner |
| Security alerts | Cards: severity, rule ("Login from a new city", "Large export", "Repeated finance access attempts", "Account locked", "Outside working hours"), who, when, details. "Mark as checked" with note. Filter open/checked. | CTO, Director, CEO / Founder / Owner |
| My activity | Own login history, devices, today's active/idle time. Banner linking to the tracking policy. | Everyone |

**UI rules**: no edit or delete anywhere on this module (the UI has no such controls); sales tool events show the tool's logo chip; a "Fair use" info button explains what is never tracked.

**Contract**

```ts
type ActivitySource = 'aceva' | 'apollo' | 'millionverifier' | 'mailbox'
type ActivityAction = 'login' | 'logout' | 'login_failed' | 'screen_view' | 'create' | 'edit' | 'delete' | 'submit' | 'assign' | 'approve' | 'reject' | 'comment' | 'upload' | 'download' | 'export' | 'print' | 'sensitive_view' | 'blocked' | 'security' | 'email_sent' | 'reply' | 'bounce' | 'call' | 'email_check'
interface ActivityEvent { id: string; empId: string; at: string; source: ActivitySource; action: ActivityAction; module: string; target?: string; description: string; changes?: { field: string; from: string; to: string }[]; ip?: string; city?: string; device?: string }
interface OnlineSession { sessionId: string; empId: string; since: string; currentScreen: string; state: 'active' | 'idle'; device: string; city: string }
interface DailySummary { empId: string; date: string; firstLogin?: string; lastLogout?: string; activeMinutes: number; idleMinutes: number; actions: number; tasksTouched: number; checkIn?: string }
interface SecurityAlert { id: string; rule: string; severity: 'low' | 'medium' | 'high'; empId: string; at: string; details: string; status: 'open' | 'checked'; checkedBy?: string; note?: string }
GET /activity/online · GET /activity/events?empId&from&to&module&action&source · GET /activity/summaries?date&scope
GET /activity/alerts · POST /activity/alerts/:id/check · POST /sessions/:id/force-logout · POST /employees/:empId/lock|unlock
POST /activity/heartbeat { active: boolean } · POST /activity/screen { screen }
```

### 9.5 M5 Task management · `features/tasks` · Zone: People and work

**Routes**: `/tasks?view=mine|list|board|calendar|workload`, `/tasks/new` (opens the assign sheet over the list), `/tasks/[id]`.

**Screens**

| Screen | Details |
|---|---|
| My tasks | Grouped by deadline: Overdue, Today, This week, Later. Each row: number, title, size chip, priority, `DeadlineChip`, status, assigner. Personal to-dos appear in their own "My to-dos" group (not scored, quick-add input). |
| List | Table with filters (assignee, status, priority, size, project, due range), sort, saved filter chips. Team scope for leads. |
| Board | One column per status (Assigned, In Progress, Submitted, Under Review, Approved, Rework; On Hold and Cancelled collapsed). Cards show size, deadline, assignee. Drag to move where the rules allow (an employee can move own task Assigned → In Progress → Submitted; reviewers handle the rest). Overdue cards get a red edge, not a separate column. |
| Calendar | Month grid by deadline; today in citron; leave days of the assignee shaded; click a day to see its tasks. |
| Workload | One `WorkloadBar` per person in scope: open estimated hours vs weekly capacity (40 h default, 20 h for interns/part-time), number of open tasks, overload in red. Click a person to see their open tasks. |
| Assign task (sheet) | Fields in order: title, description, assignee (only people below you), project/client (optional), department goal (optional), priority, **size** (`SizePicker`), estimated hours (pre-filled from size, editable), start date, **deadline** (pre-filled with the suggested deadline, working days only, skips holidays), checklist, attachments, repeat (none / weekly on… / monthly on…). Live hints under the deadline and assignee: "An M task usually needs 3 working days; you set 1." (warning, can continue), "Deadline can't be in the past." (error), "This puts Ali Raza at 46 h of 40 h this week." (warning with mini `WorkloadBar`), "Mariam is on leave 12 to 13 Nov." (warning). |
| Task page | Header: number, title, status, size, priority, deadline (with "original: …" if extended), assignee and assigner chips. Main column: description, checklist with progress, attachments, comments with @mentions and file uploads. Side column: details, **status actions** for the viewer (Start, Submit, Request extension, Approve with rating, Send to rework, Put on hold, Cancel), extension history, full status history timeline. |
| Extension request | Dialog (assignee, before deadline only): new date, reason. After the deadline the button reads "Request extension (counts as late)". The assigner sees Approve/Reject in the task and in the Approvals inbox. |
| Review | Dialog: either Approve with a 1 to 5 star rating and a comment, or Rework with a required reason. |

**UI rules** (from plan §9): one owner per task; managers (Director, CTO) assign only downward; the CEO / Founder / Owner assigns nothing; XL cannot be assigned; deadline required; manager deadline change requires a reason; overdue is a flag; cancelled/on hold need a reason; status flow enforced by allowed transitions in `logic.ts`.

**Size table** (editable by the Director in Settings): XS ≤2 h, 1 pt, same day · S 2–4 h, 2 pt, 1 day · M 1–2 days, 3 pt, 3 days · L 3–5 days, 5 pt, 7 days · XL split first.

**Contract**

```ts
type TaskSize = 'XS' | 'S' | 'M' | 'L' | 'XL'
type TaskStatus = 'assigned' | 'in_progress' | 'submitted' | 'under_review' | 'approved' | 'rework' | 'on_hold' | 'cancelled'
type Priority = 'low' | 'medium' | 'high' | 'urgent'
interface Task { id: string; number: string; title: string; description: string; assignee: string; assignedBy: string; projectId?: string; goalId?: string; priority: Priority; size: TaskSize; points: number; estimatedHours: number; startDate: string; deadline: string; originalDeadline: string; status: TaskStatus; isOverdue: boolean; checklist: { id: string; text: string; done: boolean }[]; attachments: Attachment[]; repeat?: RepeatRule; personal: boolean; rating?: 1|2|3|4|5; extensionsCount: number; createdAt: string; updatedAt: string }
interface TaskComment { id: string; taskId: string; author: string; body: string; mentions: string[]; attachments: Attachment[]; at: string }
interface ExtensionRequest { id: string; taskId: string; requestedBy: string; currentDeadline: string; requestedDeadline: string; reason: string; status: 'pending' | 'approved' | 'rejected'; late: boolean; decidedBy?: string; decidedAt?: string }
interface StatusChange { from: TaskStatus | null; to: TaskStatus; by: string; at: string; reason?: string }
GET /tasks?scope=mine|team&status&assignee&due_from&due_to · GET /tasks/:id · POST /tasks · PATCH /tasks/:id
POST /tasks/:id/{start|submit|approve|rework|hold|cancel|resume} · GET|POST /tasks/:id/comments
POST /tasks/:id/extensions · POST /extensions/:id/{approve|reject} · GET /tasks/workload?scope=team
GET /settings/task-sizes · GET /holidays?year
```

### 9.6 M6 Performance and results · `features/performance` · Zone: People and work

**Routes**: `/performance?tab=mine|team|reviews|disputes`, `/performance/scorecards/[id]`.

**Screens**

| Screen | Details |
|---|---|
| My performance | Current month live figures: `ScoreDial` for the overall score plus five metric tiles (Quality, On-time, Completion, Rework (lower is better), Attendance), each 0 to 100 with a one-line "how it's calculated" tooltip. Workload shown for information. Score trend line for the last 6 months. Latest released scorecard with Acknowledge + comment, and "Dispute a rating". "Small sample" note under 5 tasks. Sales staff see the sales metrics instead (V, M, W, D, A). |
| Team | Side-by-side table of the team: overall, five metrics, band badge, trend sparkline, tasks count. No ranking numbers, sorted by name by default. Click a row for that person's scorecard. |
| Review queue | Tasks waiting for the viewer's review with Approve (rating) / Rework, same dialog as M5. |
| Scorecard page | Header: person, month, band, `ScoreDial`; metric breakdown with the formula and the weights version used; tasks included (cancelled excluded, extensions marked); reviewer remark (can add, cannot change numbers); employee acknowledgement and comment; disputes. States: Draft (reviewer only) → Released → Acknowledged. |
| Disputes | Table of disputes on task ratings with status; decision dialog for the next level. |

**Formula shown in UI**: `Score = 0.35 Q + 0.25 T + 0.20 C + 0.10 (100 − R) + 0.10 A` using the scorecard's saved weights. Bands: 85+ Excellent, 70–84 Good, 50–69 Needs improvement, <50 Poor.

**Contract**

```ts
interface MetricSet { quality: number; onTime: number; completion: number; rework: number; attendance: number; workloadHours: number }
interface Scorecard { id: string; empId: string; month: string /* 2026-10 */; kind: 'standard' | 'sales'; metrics: MetricSet | SalesMetricSet; weightsVersionId: string; score: number; band: 'excellent' | 'good' | 'needs_improvement' | 'poor'; taskCount: number; smallSample: boolean; status: 'draft' | 'released' | 'acknowledged'; reviewerRemark?: string; employeeComment?: string }
interface WeightsVersion { id: string; departmentId?: string; kind: 'standard' | 'sales'; weights: Record<string, number>; effectiveFrom: string }
interface RatingDispute { id: string; taskId: string; empId: string; reason: string; status: 'open' | 'upheld' | 'changed'; decidedBy?: string; decision?: string }
GET /performance/live?empId · GET /scorecards?empId&month&scope · GET /scorecards/:id
POST /scorecards/:id/{remark|release|acknowledge} · GET|POST /disputes · POST /disputes/:id/decide
GET /settings/score-weights · POST /settings/score-weights (new version)
```

### 9.7 M7 Attendance and leave · `features/attendance` · Zone: People and work

**Routes**: `/attendance?tab=me|team|corrections`, `/leave?tab=me|team|calendar|approvals`.

**Screens**

| Screen | Details |
|---|---|
| Check-in card (also on Home and the topbar) | Big button "Check in" with the server time; grace ring showing "On time until 09:15"; after check-in, elapsed time with citron pulse and "Check out". If office-only check-in is on and the user is remote: "Check-in is only allowed from the office network." |
| My attendance | Month calendar: each day coloured (on time, late, missed check-out, leave, holiday, weekend, absent) with check-in/out times; month totals (present, late, leave, absent); "Request correction" from any past day. |
| Team attendance | Today's board for the team: checked in (time), late, not yet in, on leave. Monthly table with the first login from M4 next to the check-in so gaps are visible. |
| Corrections | Requests with original vs requested times, reason, status; approve/reject for managers. The original is always shown. |
| My leave | Balance cards per type (casual, sick, annual, unpaid) with used/remaining bars; "Request leave" sheet: type, dates (calendar range, holidays and weekends excluded from the count), half-day option, reason; live "You'll have 4 of 10 casual days left". Request list with status and the `ApprovalRelay` (manager → Director; see §2.3). |
| Team leave calendar | Month view of who is on leave; warning chips where a task deadline falls in someone's leave. |
| Leave approvals | Same rows as the Approvals inbox, filtered to leave. |

**Contract**

```ts
type DayStatus = 'on_time' | 'late' | 'missed_checkout' | 'absent' | 'leave' | 'holiday' | 'weekend' | 'future'
interface AttendanceDay { empId: string; date: string; checkIn?: string; checkOut?: string; status: DayStatus; lateMinutes?: number; firstLogin?: string; correctionId?: string }
interface AttendanceCorrection { id: string; empId: string; date: string; original: { checkIn?: string; checkOut?: string }; requested: { checkIn?: string; checkOut?: string }; reason: string; status: 'pending' | 'approved' | 'rejected'; decidedBy?: string }
interface LeaveType { id: string; name: string; yearlyDays: number; paid: boolean; color: string }
interface LeaveBalance { leaveTypeId: string; total: number; used: number; pending: number }
interface LeaveRequest { id: string; empId: string; leaveTypeId: string; from: string; to: string; days: number; halfDay?: boolean; reason: string; status: 'pending_lead' | 'pending_director' | 'approved' | 'rejected' | 'cancelled'; chain: ApprovalStep[] }
interface Holiday { date: string; name: string }
POST /attendance/check-in · POST /attendance/check-out · GET /attendance?empId&month · GET /attendance/team?date
GET|POST /attendance/corrections · POST /attendance/corrections/:id/{approve|reject}
GET /leave/types · GET /leave/balances?empId · GET|POST /leave/requests · POST /leave/requests/:id/{approve|reject|cancel}
GET /leave/calendar?month&scope · GET /holidays?year · GET /settings/work-schedule
```

### 9.8 M8 Payroll · `features/payroll` · Zone: People and work · Seal: highly

**Routes**: `/payroll` (management: runs; employees: redirected to payslips), `/payroll/runs/[id]`, `/payroll/payslips`, `/payroll/advances`.

**Screens**

| Screen | Details |
|---|---|
| Payroll runs | One card per month with status pipeline: Attendance locked → Calculated → Prepared → Reviewed → Approved → Payslips sent → Posted to ledger → Paid. Totals (gross, deductions, tax, net) and headcount. "Start November run" button for Finance. |
| Run page | Stepper across the top with the current stage. Table of lines: employee, base, allowances, bonus (incl. commission lines from M15 marked "Commission"), unpaid leave days and deduction, tax, other deductions (advance repayments), **net**. Each row expands to show the formula: `Net = base + allowances + bonus − unpaid leave − tax − other deductions` and `Unpaid leave = base ÷ working days × unpaid days`. Variance column vs last month with flags over 10%. `ApprovalRelay`: prepared by Finance → approved by the Director (step-up). The CEO / Founder / Owner views every run. Maker can't approve. After approval: "Generate payslips", "Post to ledger" (shows the journal preview: Dr Salary expense / Cr Salary payable / Cr Tax payable), "Mark bank transfer done" (payment entry clears salary payable), "Export bank transfer sheet" (step-up, watermarked). Approved runs are read-only, with "Add adjustment to next month". |
| My payslips | Cards per month with net pay, a payslip view (earnings, deductions, net, YTD) styled like the PDF, Download PDF. Own only. |
| Advances | List of salary advances with repayment plan and remaining balance; new advance form (Finance) with monthly deduction preview. |
| Tax slabs | Lives in Settings (§9.12) but linked from here. |

**Contract**

```ts
type PayrollStage = 'draft' | 'calculated' | 'prepared' | 'reviewed' | 'approved' | 'payslips_sent' | 'posted' | 'paid'
interface PayrollRun { id: string; number: string /* PR-2026-11 */; month: string; stage: PayrollStage; workingDays: number; totals: { gross: Money; deductions: Money; tax: Money; net: Money }; headcount: number; preparedBy?: string; reviewedBy?: string; approvedBy?: string; journalEntryId?: string; chain: ApprovalStep[] }
interface PayrollLine { id: string; runId: string; empId: string; base: Money; allowances: Money; bonus: Money; commission: Money; unpaidDays: number; unpaidDeduction: Money; tax: Money; otherDeductions: Money; net: Money; lastMonthNet?: Money; notes?: string }
interface Payslip { id: string; empId: string; month: string; lines: { label: string; kind: 'earning' | 'deduction'; amount: Money }[]; net: Money; ytdNet: Money; issuedAt: string }
interface SalaryAdvance { id: string; empId: string; amount: Money; monthlyDeduction: Money; startMonth: string; remaining: Money; status: 'active' | 'repaid' }
GET /payroll/runs · POST /payroll/runs { month } · GET /payroll/runs/:id · GET /payroll/runs/:id/lines
POST /payroll/runs/:id/{lock|calculate|prepare|review|approve|send-payslips|post|mark-paid} · GET /payroll/runs/:id/bank-sheet
GET /payslips?empId · GET /payslips/:id/pdf · GET|POST /payroll/advances · GET /settings/tax-slabs
```

### 9.9 M9 Finance ledger · `features/ledger` · Zone: Finance · Seal: highly / confidential

**Routes**: `/finance/ledger`, `/finance/ledger/new`, `/finance/ledger/[id]`, `/finance/accounts`, `/finance/parties?tab=clients|vendors`, `/finance/bills`, `/finance/banking?tab=accounts|transfers|reconcile`, `/finance/close`.

**Screens**

| Screen | Details |
|---|---|
| Journal entries | Table: number, date, description, source (Manual, Invoice, Bill, Payroll, Payment, Reversal, Revaluation), project tag, total, currency, status (Draft, Pending approval, Posted, Reversed), maker. Filters, period picker, "New entry". |
| Entry composer | Header: date, description, project, currency (PKR/USD with the exchange rate shown and editable for USD), attachment (receipt). Lines grid: account (searchable picker by code or name), description, debit, credit, client/vendor, employee. Keyboard: Enter adds a line, Tab moves across. `BalanceMeter` sticky at the bottom. Required approver shown live from the amount: "Needs the Director's approval" (limits from Settings). Save draft / Submit for approval. Closed month dates are blocked with "November 2026 is closed. Ask the Director to reopen it." |
| Entry page | Lines, totals, attachments, `ApprovalRelay`, status history. Posted entries show "Reverse" (creates a reversing draft linked to this one) and never "Edit". |
| Chart of accounts | Tree in five groups (1000 Assets, 2000 Liabilities, 3000 Equity, 4000 Income, 5000 Expenses) with codes, balances, and active state. Add account (Finance, after the accountant signs off the chart). |
| Clients and vendors | Two tabs, table + side sheet with contact, currency, balance, and recent documents. |
| Bills and expenses | Table with status (unpaid/part paid/paid), due date, vendor, amount, receipt thumbnail; new bill form with receipt upload. |
| Banking | Bank accounts cards (balance masked for non-highly roles); transfers between accounts; **Reconcile**: upload a CSV bank statement, two-column matcher (statement lines vs ledger entries) with auto-match suggestions, match/unmatch, and a "missing in ledger" list with "Create entry". |
| Month close | Checklist with live status: all entries posted, bank reconciled, payroll posted, USD revalued (button to run revaluation, preview gain/loss), trial balance balanced. "Run close" (Finance) → the Director approves. Closed months list with "Reopen" (Director only, step-up, reason required, the CEO / Founder / Owner is notified). |

**Approval limits** (example, from Settings): every entry is approved by the Director; above PKR 500,000 and all capital/loan entries also notify the CEO / Founder / Owner (view only). If the approver is the maker, it goes one level up.

**Contract**

```ts
type AccountGroup = 'asset' | 'liability' | 'equity' | 'income' | 'expense'
interface Account { id: string; code: string; name: string; group: AccountGroup; parentId?: string; currency: 'PKR' | 'USD'; isBank?: boolean; isOci?: boolean; active: boolean; balance: Money }
type EntryStatus = 'draft' | 'pending_approval' | 'posted' | 'reversed'
interface JournalLine { id: string; accountId: string; description?: string; debit: string; credit: string; partyId?: string; empId?: string }
interface JournalEntry { id: string; number: string; date: string; description: string; source: 'manual' | 'invoice' | 'bill' | 'payroll' | 'payment' | 'reversal' | 'revaluation' | 'transfer'; projectId?: string; currency: 'PKR' | 'USD'; exchangeRate?: string; lines: JournalLine[]; total: Money; status: EntryStatus; requiredApproverLevel: Level; chain: ApprovalStep[]; reversalOf?: string; reversedBy?: string; attachments: Attachment[] }
interface Party { id: string; kind: 'client' | 'vendor'; name: string; email?: string; country?: string; currency: 'PKR' | 'USD'; balance: Money }
interface Bill { id: string; number: string; vendorId: string; date: string; dueDate: string; total: Money; paid: Money; status: 'unpaid' | 'part_paid' | 'paid'; receipt?: Attachment }
interface BankStatementLine { id: string; date: string; description: string; amount: string; matchedEntryId?: string; suggestion?: string }
interface FinancePeriod { month: string; status: 'open' | 'closing' | 'closed' | 'reopened'; checklist: { key: string; label: string; done: boolean }[]; closedBy?: string; approvedBy?: string }
GET /accounts · POST /accounts · GET /journal-entries · POST /journal-entries · GET /journal-entries/:id
POST /journal-entries/:id/{submit|approve|reject|reverse} · GET /parties?kind · POST /parties
GET|POST /bills · GET /bank-accounts · POST /transfers · POST /bank-statements (CSV) · POST /bank-statements/lines/:id/match
GET /periods · POST /periods/:month/{revalue|close|approve-close|reopen} · GET /exchange-rates
```

### 9.10 M10 Financial statements and reports · `features/statements` · Zone: Finance · Seal: highly

**Routes**: `/finance/statements?type=balance-sheet|income|cash-flow|equity|comprehensive|trial-balance|general-ledger|ar-aging|ap-due|profit-by-project|tax-payable&from&to&currency&compare`.

**Screens**

| Screen | Details |
|---|---|
| Statement picker | Left list: five statements, then extra reports. Toolbar: date range (with presets: this month, last month, quarter, finance year 1 Jul to 30 Jun), display currency (PKR/USD), "Compare with previous period" toggle. |
| Statement view | A clean, printable statement layout: sections, indented account lines, subtotals, totals in bold, previous period column and change %. Click any amount to open the general ledger for that account and period. **`SelfCheck` strip** on top: e.g. "Assets 12,450,000 = Liabilities + Equity 12,450,000 ✓". Status: Draft / Final / Snapshot (closed month, with a lock and the snapshot date). "Mark final" disabled if any check fails. Export PDF/Excel (step-up + watermark preview). |

**Checks**: Balance sheet A = L + E · Income statement profit = current-year profit in equity · Cash flow closing cash = cash and bank on the balance sheet · Changes in equity closing = balance-sheet equity · Comprehensive income net profit = income statement.

**Contract**

```ts
interface StatementLine { accountId?: string; code?: string; label: string; depth: number; amount: string; compareAmount?: string; isTotal?: boolean }
interface StatementCheck { label: string; left: { label: string; amount: string }; right: { label: string; amount: string }; pass: boolean }
interface Statement { type: StatementType; from: string; to: string; currency: 'PKR' | 'USD'; sections: { title: string; lines: StatementLine[] }[]; checks: StatementCheck[]; status: 'draft' | 'final' | 'snapshot'; snapshotAt?: string }
GET /statements/:type?from&to&currency&compare · POST /statements/:type/mark-final · GET /statements/:type/export?format=pdf|xlsx
GET /reports/{trial-balance|general-ledger|ar-aging|ap-due|profit-by-project|tax-payable}
```

### 9.11 M11 Spreadsheet and analysis graphs · `features/analysis` · Zone: Finance

**Routes**: `/finance/sheet`, `/finance/insights`.

**Screens**

| Screen | Details |
|---|---|
| Spreadsheet | AG Grid with ledger rows: date, entry number, account, description, client, project, employee, debit, credit, currency, status. Frozen first two columns, resizable columns, column filters, sort. Footer **totals bar** with a function picker per column (sum, average, count, min, max). Saved views dropdown ("November expenses by project") + Save view. Posted rows are read-only (lock icon); editing a posted cell opens "Create correcting draft?" which pre-fills a reversing + correct entry in the composer. Import: Excel/CSV → preview grid with error column (unknown account, debits ≠ credits, closed month), "Save N good rows as drafts". Export Excel/CSV (logged). |
| Insights | KPI row: cash in bank, this month's revenue, expenses, profit, unpaid invoices. Six ECharts: revenue vs expenses by month (bar), net profit trend (line), cash balance over time (line/area), expense breakdown (donut), unpaid invoices by age (bar), profit by project/client (horizontal bar). Shared filters: date range and currency. Clicking a bar or slice opens a side sheet with the entries behind it. |

**Contract**: reuses `JournalEntry` lines flattened as `LedgerRow`; `GET /ledger/rows?from&to&account&client&project&emp` · `GET|POST /sheet/views` · `POST /sheet/import (preview)` · `POST /sheet/import/commit` · `GET /insights/kpis` · `GET /insights/{revenue-expense|profit-trend|cash|expense-breakdown|ar-aging|profit-by-project}`.

### 9.12 M12 Audit log, backup, notifications, settings and home dashboards · `features/system`, `features/home` · Zone: Control

**Routes**: `/` (home), `/audit`, `/notifications`, `/settings?section=…`.

**Home dashboards by level** (plan §17)

| Role | Home shows |
|---|---|
| Engineering | Greeting band with date and check-in card; My tasks by deadline (next 5); leave balance; latest scorecard dial; announcements to acknowledge; upcoming meetings |
| Sales | Check-in; **My sales day**: today's targets as progress rings (leads added, emails checked, emails sent, follow-ups done), follow-ups due today, new replies (with Apollo `FreshnessStamp`), mini pipeline; my tasks, leave, scorecard |
| CTO | Check-in; engineering KPIs (people, present today, open and overdue tasks); who's in today; team workload; work waiting for my review; approvals; security alerts; who's online; backups |
| Finance | Check-in; finance KPI row; my tasks; payroll stage to prepare; billing; revenue vs expenses; leave; announcements |
| Director | Check-in; reporting-line KPIs; finance KPI row; approvals; payroll stage; revenue vs expenses; sales pipeline; billing; who's in today; the sales team's day |
| CEO / Founder / Owner | Finance KPI row (cash, revenue, expenses, profit, unpaid invoices); company KPIs; **Waiting for the Director** (every pending approval, read-only); revenue vs expenses; payroll stage; pipeline; security alerts; who's online; billing; backups |

**Audit log**: search by person, date, module, action; rows with who (EmpChip), what, record, old → new diff, when; chain integrity badge "Hash chain verified today 02:00" (green) or broken (red alert). Read-only. Export for levels 1 to 3.

**Notifications**: §4.4.

**Settings** (left section list; each change asks for a reason and shows "Logged"; sections marked ★ need the Director with step-up; the CEO / Founder / Owner can view all sections):
Company details · Working days and hours (start time, grace minutes, office-only check-in, office networks) · Holiday calendar · Leave types and yearly balances · Task sizes and suggested deadlines · Score weights (standard, per department, sales) with version history · Approval limits ★ · Currencies and exchange rates · Finance year · Chart of accounts (link to M9) · Tax slabs · Password and session rules ★ · Alert rules · Sales targets, deal stages, lost reasons and commission rules · Sales tools (link to M16) · Data retention · Backups (last nightly backup, copies kept 30 daily + 12 monthly, last restore test with result).

**Contract**

```ts
interface AuditRecord { id: string; at: string; empId: string; module: string; action: string; recordType: string; recordId: string; changes?: { field: string; from: string; to: string }[]; hash: string; prevHash: string }
interface Notification { id: string; type: NotificationType; title: string; body?: string; link?: string; at: string; read: boolean; essential: boolean }
interface NotificationPrefs { email: Record<NotificationType, boolean>; dailySummary: boolean }
interface BackupStatus { lastBackupAt: string; ok: boolean; dailyCopies: number; monthlyCopies: number; lastRestoreTest: { at: string; ok: boolean; by: string } }
GET /audit?empId&module&action&from&to · GET /audit/integrity · GET /notifications · POST /notifications/read
GET|PATCH /notifications/prefs · GET /settings/:section · PATCH /settings/:section { values, reason } · GET /backups/status
GET /dashboard/home (returns the widgets for the viewer's role)
```

### 9.13 M13 Customer billing, subscriptions and renewals · `features/billing` · Zone: Finance

**Routes**: `/billing?tab=overview|invoices|customers|payments`, `/billing/invoices/new`, `/billing/invoices/[id]`, `/billing/subscriptions?tab=register|renewals|usage`.

**Screens**

| Screen | Details |
|---|---|
| Overview | KPIs: billed this month, collected, outstanding, overdue (count and amount); upcoming due invoices; renewals due in 14 days; draft invoices created from Won deals ("From sales: 2 drafts to check"). |
| Invoices | Table with status chips (Draft, Sent, Part paid, Paid, Overdue, Cancelled), type (one-time, recurring, rental), customer, issue/due dates, amount, balance, next reminder. |
| New / edit invoice | Customer, type; for recurring/rental: period (monthly, quarterly, yearly), start, end/never; line items (description, qty, rate, tax), currency; due date calculated from terms; reminder schedule (e.g. 3 days before, on due date, 3 and 7 days after) with a live preview timeline; live invoice preview on the right styled as the PDF with Aceva's details. Save draft / Send. |
| Invoice page | Preview, status, payment history, "Record payment" (date, amount, method, reference) updating balance and status, reminder history ("Reminder 2 skipped: already paid"), link to the ledger entry. |
| Customers | Billing profiles: contact, currency, terms, total billed, outstanding, last payment. |
| Payments | All payments received with method and reference, linked invoice and ledger entry. |
| Subscription register | Cards/table for Aceva's own tools: Apollo, MillionVerifier credits, Hostinger domains and mailboxes, Namecheap (acevatech.com), Claude, ChatGPT, Salesforce (if used), hosting, APIs. Each: owner (EmpChip), plan, cost, billing period, renewal date with countdown, status (Active, Renewing soon, Cancelled, Changed). Add/edit (`subscriptions.manage`). |
| Renewals | Timeline of upcoming renewals (next 90 days) and a log of decisions (renewed, cancelled, changed). Alert settings per subscription (days before). |
| Usage | For providers with data: limit vs used bars, trend, estimated cost; providers without an API show "Manual entry" with the last value and who entered it. Unusual usage and near-limit flags. Never shows an exact cost the provider doesn't expose ("Estimated"). |

**Contract**

```ts
type InvoiceType = 'one_time' | 'recurring' | 'rental'
type InvoiceStatus = 'draft' | 'sent' | 'part_paid' | 'paid' | 'overdue' | 'cancelled'
interface Invoice { id: string; number: string; customerId: string; type: InvoiceType; period?: 'monthly' | 'quarterly' | 'yearly'; issueDate: string; dueDate: string; currency: 'PKR' | 'USD'; lines: { description: string; qty: number; rate: string; taxRate?: number }[]; subtotal: Money; tax: Money; total: Money; paid: Money; balance: Money; status: InvoiceStatus; reminders: ReminderRule[]; source?: { kind: 'deal'; dealId: string }; ledgerEntryId?: string }
interface Payment { id: string; invoiceId: string; date: string; amount: Money; method: 'bank_transfer' | 'cash' | 'cheque' | 'card_provider' | 'other'; reference?: string; ledgerEntryId?: string }
interface Subscription { id: string; vendor: string; product: string; ownerEmpId: string; plan: string; cost: Money; period: 'monthly' | 'quarterly' | 'yearly' | 'usage'; renewalDate: string; status: 'active' | 'renewing_soon' | 'cancelled' | 'changed'; alertDaysBefore: number; usage?: { metric: string; used: number; limit?: number; source: 'api' | 'manual'; updatedAt: string; estimatedCost?: Money } }
GET|POST /invoices · GET|PATCH /invoices/:id · POST /invoices/:id/{send|cancel} · POST /invoices/:id/payments
GET /customers · GET /payments · GET|POST /subscriptions · PATCH /subscriptions/:id · POST /subscriptions/:id/renewal-decision
GET /subscriptions/usage · GET /billing/overview
```

### 9.14 M14 Internal communication and collaboration · `features/comms` · Zone: People and work

**Routes**: `/messages`, `/messages/[conversationId]`, `/announcements`, `/meetings`, `/meetings/[id]`.

**Screens**

| Screen | Details |
|---|---|
| Messages (3-pane) | Left: search, Saved, then sections Channels (department and project, with `#`), Direct messages (with presence dots per company policy), unread counts. Centre: message list grouped by day, each message with avatar, name, time, body (markdown-lite), reactions, reply count ("3 replies"), edited/deleted markers ("Message deleted" with audit note), delivery/read ticks for DMs; hover actions: react, reply in thread, save, pin, link to task, edit/delete (own). Composer: text with @mention suggestions, attach file (type and size limits shown, "Scanning…" state), send on Enter. Right panel (toggle): channel details, members, pinned messages, files, linked tasks. Thread view slides over the right panel. |
| New conversation | Pick people (only those you are allowed to message) or create a channel (admins/leads): name, department/project, members, moderators. |
| Announcements | Feed of announcements (company-wide or selected teams), pinned on top; "Requires acknowledgement" ones show an Acknowledge button and, for publishers, an acknowledgement progress bar with who hasn't acknowledged. Compose (`announcements.publish`): title, body, audience, pin, require acknowledgement. |
| Meetings | Upcoming list and a week calendar; meeting card: title, time, participants (RSVP), agenda, notes and files. Create: title, date/time, duration, participants, agenda, attachments. Meeting page: agenda, notes editor (owner), attachments, linked tasks. |

**UI rules**: you only see channels you belong to; removing an employee removes access immediately (their DM shows "Account disabled"); online status is never shown as a metric; message retention notice in channel details.

**Contract**

```ts
interface Conversation { id: string; kind: 'dm' | 'group' | 'channel'; name?: string; scope?: { departmentId?: string; projectId?: string }; memberEmpIds: string[]; moderatorEmpIds: string[]; unread: number; lastMessageAt: string; pinnedMessageIds: string[] }
interface Message { id: string; conversationId: string; author: string; body: string; at: string; editedAt?: string; deleted?: boolean; parentId?: string; replyCount: number; reactions: { emoji: string; empIds: string[] }[]; mentions: string[]; attachments: Attachment[]; readBy: string[]; linkedTaskId?: string }
interface Announcement { id: string; title: string; body: string; author: string; audience: { all: boolean; departmentIds: string[] }; pinned: boolean; requiresAck: boolean; ackEmpIds: string[]; at: string }
interface Meeting { id: string; title: string; start: string; durationMin: number; organizer: string; participants: { empId: string; rsvp: 'yes' | 'no' | 'maybe' | 'pending' }[]; agenda: string; notes?: string; attachments: Attachment[] }
GET /conversations · POST /conversations · GET /conversations/:id/messages?before · POST /conversations/:id/messages
PATCH|DELETE /messages/:id · POST /messages/:id/reactions · POST /messages/:id/save · POST /messages/:id/pin
GET|POST /announcements · POST /announcements/:id/ack · GET|POST /meetings · PATCH /meetings/:id · POST /meetings/:id/rsvp
```

### 9.15 M15 Sales and CRM · `features/sales` · Zone: Sales · Phase 2

**Routes**: `/sales` (My sales day), `/sales/leads`, `/sales/leads/[id]`, `/sales/pipeline`, `/sales/deals/[id]`, `/sales/reports?tab=daily|dashboard|scorecard`, `/sales/targets?tab=targets|commission|dnc`.

**Screens**

| Screen | Details |
|---|---|
| My sales day | Today's targets as progress rings with numbers (leads added 42/40, emails checked, emails sent 35/30, follow-ups 6/8) and a per-source breakdown (Apollo auto vs self-reported); follow-ups due today (red if missed); new replies (from Apollo, with `FreshnessStamp`); my pipeline mini-board; "Log my day" button (manual daily log, about 2 minutes: LinkedIn messages, WhatsApp chats, Fiverr inquiries, phone calls, field visits, note). |
| Leads | Table: name, title, company, country, source chip, email check result (valid/invalid/catch-all/unknown/unchecked), owner, last activity, stage of open deal. Filters by source, country, check result, owner, stage. Actions: Add lead (with **live duplicate check** on email and website domain: "This lead already exists. Owner: Hira Baig (ACV-0009)." and the save button becomes "View existing"), Import CSV (preview with duplicates and invalid rows flagged), Verify emails (sends unchecked emails to MillionVerifier; shows credits cost and "checked in the last 90 days, skipped"), Export (Director as sales manager, logged and watermarked). Do-not-contact leads show a blocked badge. |
| Lead page | Header with contact details, company, owner, check result; activity timeline (emails sent, replies, calls, meetings, LinkedIn/WhatsApp, proposals, notes), each with who/when and an **Auto (Apollo)** or **Manual** tag; deals for this lead; "Log activity", "Create deal", "Mark do not contact". Other salespeople see that the lead exists and its owner, but not notes or deal values. |
| Pipeline | Kanban with stages New, Contacted, Replied, Meeting booked, Proposal sent, Negotiation, Won, Lost. Column headers show count and total value (USD/PKR toggle). Cards: company, service, value, next step and date (red if overdue), owner avatar. Dragging to **Lost** opens a required reason picker (price, no reply, chose another company, other + note) and "re-contact after N months". Dragging to **Won** by an executive sets "Waiting for manager confirmation"; the manager confirms in the deal or the Approvals inbox, which then shows the handover: client created, draft invoice in Billing, CTO notified to create project tasks. Every open deal must have a next step date; cards without one show a warning. |
| Deal page | Service, value, currency, expected close, stage history, next step editor, proposal link/upload, timeline, handover status after Won, commission line status. |
| Sales reports · Daily | Team table for a date: per salesperson leads added, emails checked (invalid), emails sent, replies, meetings booked, self-reported counts, target met/not met badge, and the sentence form from the plan ("ACV-0009, Tuesday 8 December: 42 leads added, 40 emails checked (3 invalid), …"). Manager can mark "proof requested" on self-reported days. |
| Sales reports · Dashboard | Pipeline value by stage (funnel/bar), won vs lost this month, stage conversion rates, leads by source and country, activity per person this week. |
| Sales reports · Scorecard | Sales scorecard with V, M, W, D, A metrics (0 to 100, capped), weights, and `Sales score = 0.20 V + 0.25 M + 0.30 W + 0.10 D + 0.15 A`. |
| Targets and commission | Targets grid: people × daily targets (leads added, emails checked, emails sent, follow-ups) and monthly targets (meetings, proposals, deals won value), editable by the sales manager. Commission: rules (Director), commission lines created when the first invoice is paid, approve (Director) → sent to payroll. Do-not-contact list with reason and date. |

**Contract**

```ts
type LeadSource = 'apollo' | 'fiverr' | 'linkedin' | 'referral' | 'website' | 'field' | 'walk_in'
type EmailCheck = 'valid' | 'invalid' | 'catch_all' | 'unknown' | 'unchecked'
interface Lead { id: string; name: string; title?: string; companyId: string; email?: string; phone?: string; linkedinUrl?: string; country?: string; industry?: string; source: LeadSource; ownerEmpId: string; emailCheck: EmailCheck; checkedAt?: string; doNotContact: boolean; notes?: string; lastActivityAt?: string; archived: boolean }
interface Company { id: string; name: string; website?: string; domain?: string; country?: string; industry?: string }
type DealStage = 'new' | 'contacted' | 'replied' | 'meeting_booked' | 'proposal_sent' | 'negotiation' | 'won' | 'lost'
interface Deal { id: string; number: string; leadId: string; companyId: string; service: 'website' | 'custom_software' | 'ai_automation' | 'mobile_app' | 'ecommerce'; value: Money; expectedClose: string; stage: DealStage; nextStep?: string; nextStepDate?: string; ownerEmpId: string; lostReason?: string; recontactAfter?: string; wonConfirmedBy?: string; handover?: { clientId?: string; invoiceId?: string; ctoNotified: boolean } }
interface SalesActivity { id: string; leadId?: string; dealId?: string; empId: string; kind: 'email_sent' | 'reply' | 'bounce' | 'call' | 'meeting' | 'linkedin' | 'whatsapp' | 'proposal' | 'note' | 'email_check'; at: string; source: 'apollo' | 'millionverifier' | 'mailbox' | 'manual'; externalId?: string; summary: string }
interface DailyTargets { empId: string; leadsAdded: number; emailsChecked: number; emailsSent: number; followUps: number }
interface MonthlyTargets { empId: string; month: string; meetings: number; proposals: number; wonValue: Money }
interface ManualDailyLog { empId: string; date: string; linkedin: number; whatsapp: number; fiverr: number; calls: number; fieldVisits: number; note?: string; proofRequested?: boolean }
interface DailySalesSummary { empId: string; date: string; leadsAdded: number; emailsChecked: number; invalid: number; emailsSent: number; replies: number; meetings: number; selfReported: number; targetsMet: boolean }
interface CommissionLine { id: string; dealId: string; empId: string; invoiceId: string; amount: Money; status: 'calculated' | 'approved' | 'sent_to_payroll'; approvedBy?: string }
GET|POST /leads · POST /leads/check-duplicate { email, website } · POST /leads/import (preview) · POST /leads/verify
GET /leads/:id · PATCH /leads/:id · POST /leads/:id/activities · POST /leads/:id/do-not-contact
GET|POST /deals · GET /deals/:id · POST /deals/:id/move { stage, reason?, recontactAfter? } · POST /deals/:id/confirm-won
GET /sales/my-day · GET|POST /sales/daily-logs · GET /sales/reports/daily?date · GET /sales/dashboard?month
GET|PUT /sales/targets · GET /sales/commission · POST /sales/commission/:id/approve · GET /sales/scorecards
```

### 9.16 M16 Sales tool integrations · `features/integrations` · Zone: Control · Phase 2

**Routes**: `/integrations` (health), `/integrations/[tool]` (connect / manage: `apollo`, `millionverifier`, `mailboxes`, `salesforce`).

**Screens**

| Screen | Details |
|---|---|
| Connection health | One card per tool: logo tile, status (Working, Failing since…, Paused, Not connected), last successful sync (`FreshnessStamp`), items pulled today, API calls used vs limit bar, Sync now / Pause / Change key. MillionVerifier: credits left with burn-rate ("about 9 days left at this rate") and the low-credit threshold. Mailboxes: table per mailbox and per domain with sent, replies, bounces and bounce-rate bar (red over 3%, "Pause this mailbox" suggestion). Unmatched users count with a link. Recent sync runs log (time, tool, items, result, retries 1/5/15 min). |
| Connect a tool (wizard) | 1. Choose tool (with what it reads, how, limits, from plan §21). 2. Paste API key or mailbox login → encrypted at once; afterwards only `••••abcd` shown, never the key. 3. Test connection → shows what it can read. 4. Link users: list of the tool's users (name, email) with an Emp-ID picker each; unmatched stay in a waiting list. 5. Sync interval (15 or 30 min) and turn on. Changing a key or turning off requires step-up (CTO/Director only). Salesforce shows the advice: "Only connect if a client requires it; Module 15 already does this job." |
| Unmatched activity | Items waiting because their tool user isn't linked; link to resolve. |
| Fair-use panel | What is read (work counts only), what is never read (email text, recordings, private messages); last policy version employees accepted. |

**Contract**

```ts
type ToolId = 'apollo' | 'millionverifier' | 'mailboxes' | 'salesforce'
interface ToolConnection { tool: ToolId; status: 'not_connected' | 'working' | 'failing' | 'paused'; keyLast4?: string; syncEveryMin: 15 | 30; lastSuccessAt?: string; failingSince?: string; itemsToday: number; callsUsed?: number; callsLimit?: number; creditsLeft?: number; creditAlertAt?: number }
interface ToolUserLink { tool: ToolId; externalUserId: string; name: string; email: string; empId?: string; closedAt?: string }
interface SyncRun { id: string; tool: ToolId; startedAt: string; finishedAt?: string; items: number; result: 'ok' | 'retrying' | 'failed'; attempt: number; error?: string }
interface MailboxStat { mailbox: string; domain: string; sentToday: number; repliesToday: number; bouncesToday: number; bounceRateWeek: number; paused: boolean }
GET /integrations · GET /integrations/:tool · POST /integrations/:tool/key (step-up) · POST /integrations/:tool/test
GET /integrations/:tool/users · PUT /integrations/:tool/users/:externalUserId { empId } · PATCH /integrations/:tool { syncEveryMin, status }
POST /integrations/:tool/sync-now · GET /integrations/sync-runs · GET /integrations/mailboxes · GET /integrations/unmatched
```

---

## 10. Shared component catalogue

| Component | Folder | Purpose |
|---|---|---|
| `Button`, `IconButton`, `Input`, `Textarea`, `Select`, `Checkbox`, `Switch`, `RadioGroup`, `Label`, `Badge`, `Card`, `Tabs`, `Dialog`, `Sheet`, `DropdownMenu`, `Popover`, `Tooltip`, `Avatar`, `Progress`, `Separator`, `Skeleton`, `Table`, `ScrollArea`, `SegmentedControl`, `Kbd` | `ui/` | Primitives (Radix + Tailwind, shadcn style) |
| `AppShell`, `Sidebar`, `Topbar`, `PageHeader`, `CommandPalette`, `NotificationsPopover`, `CheckInPill`, `SessionRing`, `ViewAsMenu`, `IdleDialog` | `layout/` | Shell |
| `EmpChip`, `LevelMark`, `ConfidentialSeal`, `MaskedValue`, `StepUpDialog` + `useStepUp`, `ApprovalRelay`, `Money`, `Mono`, `StatusBadge`, `DeadlineChip`, `StatCard`, `ScoreDial`, `ProgressRing`, `WorkloadBar`, `FreshnessStamp`, `Timeline`, `EmptyState`, `DataTable`, `FilterBar`, `EChart`, `MonthCalendar`, `KanbanBoard`, `ExportDialog`, `ReasonDialog`, `FileCard`, `Can`, `RequireAccess` | `shared/` | Business widgets used across modules |

Every shared component has: typed props, a loading/skeleton state where it fetches nothing itself (props only), and no direct calls to `api.ts`.

---

## 11. Conventions

- **Money**: always `<Money value={m} />` (mono, tabular, currency code, negative in parentheses on statements, `−` elsewhere). Compact form (`PKR 4.8M`) only on KPI cards, with the exact amount in the tooltip.
- **Dates**: `formatDate` → `9 Nov 2026`; `formatDateTime` → `9 Nov 2026, 09:02`; relative ("in 2 days", "3 h ago") only next to an absolute date or in a tooltip. Times shown in Pakistan time (PKT).
- **Emp-ID**: always mono, always with the name nearby.
- **Forms**: React Hook Form + Zod; validate on blur, re-validate on change after the first error; the primary button shows a spinner and is disabled while saving; success = toast + close; server errors map to fields when `details` is present.
- **Destructive or irreversible actions** (cancel task, reverse entry, reject, force logout, reopen month) use `ReasonDialog`; the reason is required.
- **Loading**: skeletons that match the final layout, never a full-page spinner after the first load.
- **Empty states**: illustration of layer lines, one sentence on why it's empty, one action.
- **Errors**: inline card with "Try again"; a 404 for anything the viewer can't access in finance.
- **Copy**: plain English, short sentences, sentence case for titles and buttons ("Request leave", not "Request Leave"); say what will happen ("Approve and post to ledger").
- **Feature flags**: `NEXT_PUBLIC_ENABLE_PHASE2=true|false` shows or hides the Sales zone and Integrations.

---

## 12. Quality checklist (per module, before its cycle demo)

- [ ] Every screen in this spec exists and is reachable from the nav or the command palette.
- [ ] Logged in as each persona in §2.2, the screen shows only what that level may see; finance pages give 404 to others.
- [ ] Loading, empty and error states exist for every list.
- [ ] Keyboard-only walkthrough works; focus is visible; dialogs trap focus.
- [ ] Light and dark themes both checked.
- [ ] 360 px width checked for daily employee screens.
- [ ] `npm run typecheck` and `npm run lint` pass; `npm run build` passes.
- [ ] `logic.ts` rules have Vitest unit tests (added in the backend-integration step at the latest).

---

## 13. Roadmap: frontend first, then features one by one

### Step F0 (now): the complete frontend on mock data

1. Project setup, Strata tokens, primitives, shell, navigation, command palette, persona switcher.
2. Shared widgets (§10).
3. Screens for all 16 modules on mock data, following §9.
4. Management walkthrough on mock data to confirm screens and wording before backend work.

### Steps F1 to F7: feature development, one module at a time

Each step connects one module to the real NestJS API and finishes its rules. It follows the plan's cycle order, so the backend and the frontend move together:

| Step | Modules connected | Plan cycle |
|---|---|---|
| F1 | M1 Access, M2 Login and sessions, M3 Profiles | Cycle 1 (9 to 11 Nov) |
| F2 | M4 Activity, M5 Tasks, M6 Performance | Cycle 2 (12 to 16 Nov) |
| F3 | M7 Attendance and leave, M8 Payroll, M9 Ledger | Cycle 3 (17 to 19 Nov) |
| F4 | M10 Statements, M11 Spreadsheet and graphs, M12 Shared services and dashboards | Cycle 4 (20 to 24 Nov) |
| F5 | M13 Billing and subscriptions, M14 Communication | Cycle 5 (25 to 27 Nov) |
| F6 | M15 Sales and CRM (part 1), M16 Integrations (hub, Apollo, MillionVerifier, mailboxes) | Cycle 6 (7 to 9 Dec) |
| F7 | M15 (targets, daily report, scorecard, commission, won → invoice), M16 alerts and failure handling | Cycle 7 (10 to 14 Dec) |

**How one module is connected (the same recipe every time)**

1. Confirm the contract: compare `features/<module>/types.ts` with the NestJS DTOs; fix differences in both.
2. Replace each function body in `features/<module>/api.ts` with the `http` call named in its JSDoc.
3. Remove the module's seed file from `mocks/seed/` and its arrays from `mocks/db.ts`.
4. Add unit tests for `logic.ts` and a Playwright test for the module's main flow (plan §24).
5. Run the §12 checklist and demo on day 3 of the cycle.

---

## 14. Open questions for management and the CTO

1. Aceva's logo and brand colours: the Strata palette uses cobalt, ink and citron until a brand guide exists. Swapping is a token change in `globals.css`.
2. Office-only check-in and office-only finance access: on or off at go-live?
3. Online/last-seen status in Messages: shown to everyone, to managers only, or off?
4. Should the Phase 2 Sales screens be visible (read-only "coming soon") at the 30 November go-live, or hidden until 15 December?
5. Message and file retention periods for M14 (needed before launch).
