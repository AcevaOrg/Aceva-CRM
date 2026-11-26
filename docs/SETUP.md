# Local setup

This works on Windows, macOS and Linux. The backend needs three services: **PostgreSQL 17** (the data), **Redis 7** (the
fast copy of every session) and **Mailpit** (catches the emails the app sends, so nothing reaches a real inbox).
Choose one way to run them:

- **Option A (recommended): Docker.** One command starts all three, already configured.
- **Option B: install them yourself**, if you cannot or do not want to use Docker.

Commands below are run from the **repository root** unless they say otherwise. They work in PowerShell, Git Bash and
macOS/Linux terminals; where PowerShell needs a different command it is shown too.

## Needed once (both options)

1. **Node.js 22 or newer** and **Git**.
2. Install the packages (frontend, backend and the shared contracts together): `npm install`
3. Create the backend settings file from the example. Never commit `backend/.env`.
   - Git Bash, macOS, Linux: `cp backend/.env.example backend/.env`
   - PowerShell: `Copy-Item backend/.env.example backend/.env`
4. Put a real encryption key in `backend/.env` instead of `DATA_ENCRYPTION_KEY=CHANGE_ME` (the API refuses to start
   without one). Create a key with:
   `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`

## Option A: with Docker

1. Install Docker Desktop (Windows, macOS) or Docker Engine with the Compose plugin (Linux).
2. Start the services: `docker compose up -d`
   - PostgreSQL 17 on `127.0.0.1:5432`: user `aceva_app`, databases `aceva_dev`, `aceva_test` and `aceva_shadow`
     (the extra two are created by `docker/postgres/init/01-create-databases.sql` the first time).
   - Redis 7 on `127.0.0.1:6379`, with a password.
   - Mailpit: SMTP on `127.0.0.1:1025`, inbox at http://127.0.0.1:8025
   - Every port listens on this computer only. The passwords in `docker-compose.yml` are local placeholders and are
     the same as in `backend/.env.example`, so the copied `.env` works as it is (apart from the encryption key).
   - In the container `aceva_app` is the database administrator. That is fine on your own computer; in production the
     app uses a limited user.
3. Create the tables and load the demo data:
   `npm run db:migrate` then `npm run db:seed`
4. Give the demo people a login (development only; it refuses to run in production). Choose a password of at least
   10 characters:
   - Git Bash, macOS, Linux: `DEMO_PASSWORD=choose-a-password npm run db:seed:passwords -w backend`
   - PowerShell: `$env:DEMO_PASSWORD = "choose-a-password"; npm run db:seed:passwords -w backend`
5. Run the API and the website (see "Everyday commands" below).

Stop the services with `docker compose down` (the data is kept). `docker compose down -v` also deletes the databases.

## Option B: without Docker

Install the three services with your operating system's normal installer or package manager, then make
`backend/.env` point at them.

1. **PostgreSQL 17.** As the PostgreSQL administrator, create a limited user and the three databases:
   ```sql
   CREATE USER aceva_app WITH PASSWORD 'choose-a-password';
   CREATE DATABASE aceva_dev OWNER aceva_app;
   CREATE DATABASE aceva_test OWNER aceva_app;
   CREATE DATABASE aceva_shadow OWNER aceva_app;
   ```
   Put the same password in `DATABASE_URL`, `SHADOW_DATABASE_URL` and `TEST_DATABASE_URL` in `backend/.env`.
   The test database's name must contain `test` (the tests refuse any other database).
2. **Redis 7** (or a Redis-compatible server), listening on this computer only. With a password, use
   `REDIS_URL=redis://:your-password@127.0.0.1:6379`; without one, `REDIS_URL=redis://127.0.0.1:6379`.
   Redis has no official Windows build: on Windows run it in WSL, or use a Redis-compatible Windows build.
3. **Mailpit**: download it from its releases page and start `mailpit`. Its defaults (SMTP on port 1025, inbox at
   http://127.0.0.1:8025) match `backend/.env.example`.
4. Then follow steps 3 to 5 of Option A (migrate, seed, demo logins, run).

## Everyday commands (repository root)
| What | Command |
|---|---|
| Start the local services (Option A) | `docker compose up -d` |
| Create/update tables | `npm run db:migrate` |
| Load demo people | `npm run db:seed` |
| Give the demo people a login | set `DEMO_PASSWORD` (at least 10 characters), then `npm run db:seed:passwords -w backend`. Development only; refuses production |
| Rebuild your local database from scratch (deletes its data) | `npm run db:reset -w backend`, then `npm run db:seed` and the demo logins again |
| Type check, lint | `npm run typecheck`, `npm run lint` |
| Build the shared contracts (after pulling changes) | `npm run build -w @aceva/contracts`. Backend and frontend read `@aceva/contracts` from its git-ignored `dist` folder |
| Unit and database tests (use the approved disposable test database in `TEST_DATABASE_URL`, rebuilt each run; need PostgreSQL and Redis; see "Test database guard" below) | `npm test` |
| Browser tests (real backend and frontend on ports 4100 and 3100; need PostgreSQL, Redis and Mailpit) | once: `npx playwright install chromium`; then `npm run test:e2e` |
| Build everything | `npm run build` |
| Run the API | `npm run build -w backend` then `npm start -w backend` (http://localhost:4000/api/docs) |
| Run the website against the real API | in `frontend/.env.local`: `NEXT_PUBLIC_API_MODE=live`, `NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1` and `NEXT_PUBLIC_LIVE_MODULES=m1,m2,m3,m4,m5,m6,m7,m8,m9,m12,m13,m14`, then `npm run dev -w aceva-digital-system-web`. Without these the website runs on in-browser demo data: nothing is shared between people and Messages opens no live connection. See "Local real-time development" below |
| Only the Module 4 database tests | `npm run build:contracts`, then `npm test -w backend -- m4-` |
| Only the Module 5 database tests | `npm run build:contracts`, then `npm test -w backend -- m5-` |
| Only the Module 6 database tests | `npm run build:contracts`, then `npm test -w backend -- m6-` |
| Only the Module 7, 8 or 9 database tests | `npm run build:contracts`, then `npm test -w backend -- m7-`, `m8-` or `m9-` |

Open the website at http://localhost:3000, not http://127.0.0.1:3000: the API accepts only the `localhost` address for the website.

**A database made before the final company structure** (it still has the separate CEO role, the Level 3 Director or
the "Department Head / Team Lead" role) is refused by `npm run db:seed` with a message saying so. Rebuild it once with
`npm run db:reset -w backend`, then run `npm run db:seed` and the demo logins again.

The database tests (`aceva_test`) switch off the background work (the outbox dispatcher and the summary schedule) for every
test file (`backend/test/global-setup.ts`, `switchOffBackgroundWork`), so no test finds background jobs or summary jobs
left in `aceva_test`.

**Test database guard.** The backend tests and the browser tests EMPTY AND REBUILD the database in `TEST_DATABASE_URL`
(the whole `public` schema). `backend/test/helpers/db-guard.ts` refuses that before anything is touched unless:
- the database name is **exactly** an approved disposable test database: `aceva_m15_test`, or a name listed in
  `ACEVA_APPROVED_TEST_DATABASES` (comma-separated; CI lists its throw-away `aceva_test` container);
- it is not `aceva_dev`, `aceva_shadow` or `aceva_realtime_dev` (always refused, even when listed);
- the host is this computer (`localhost`, `127.0.0.1`, `::1`), and the database is not chosen in the query string.
The reset checks a second time after connecting (`SELECT current_database()` must be the approved name). There is no
fallback: a database that is not approved stops the run. Create the disposable database once, as the PostgreSQL
superuser (the app user may not create databases):
`createdb -h 127.0.0.1 -p 5432 -U postgres -O aceva_app aceva_m15_test`, then point `TEST_DATABASE_URL` in
`backend/.env` at it. Optional: `TEST_REDIS_PREFIX=aceva:m15test:` keeps the run's Redis keys apart.

Browser downloads for the tests go to Playwright's default folder. To keep them on another drive, set
`PLAYWRIGHT_BROWSERS_PATH` to a folder of your choice before `npx playwright install chromium` and before the tests.
If your system drive is short of space, move npm's download cache in your user-level npm config
(`npm config set cache <folder> --location=user`), never in the repository.

## Local real-time development (Messages between two people)

To try Module 14 for real (two people chatting live), the website, the API, PostgreSQL, Redis and Mailpit must all run,
on a database with every migration. Use a database of its own, for example `aceva_realtime_dev`, so `aceva_dev`,
`aceva_test` and `aceva_shadow` are never touched (`aceva_test` is rebuilt by the tests).

1. **Database.** As the PostgreSQL administrator (the app user `aceva_app` may not create databases):
   `psql -U postgres -h localhost -c "CREATE DATABASE aceva_realtime_dev OWNER aceva_app;"`
2. **`backend/.env`** (from `backend/.env.example`; git-ignored, never committed). Point `DATABASE_URL` at the new
   database; keep `SHADOW_DATABASE_URL` and `TEST_DATABASE_URL` as they are. The other values that matter here:
   `PORT=4000`, `CORS_ORIGIN=http://localhost:3000` and `APP_URL=http://localhost:3000` (the API and the live
   connection accept only this origin), `REDIS_URL` with your Redis password, `DATA_ENCRYPTION_KEY` (a random key, see
   "Needed once"), `SMTP_HOST=127.0.0.1` and `SMTP_PORT=1025` (Mailpit), `FILE_STORAGE_ROOT`. Optional: `CLAMD_HOST` /
   `CLAMD_PORT` (without a running ClamAV, shared files stay "Scanning..." and cannot be opened; messages work). There
   are no other secrets: sessions are random tokens kept in PostgreSQL and Redis.
3. **Tables and demo people** (all three use `DATABASE_URL` from `backend/.env`):
   `npm run db:migrate`, then `npm run db:seed`, then the demo logins (`DEMO_PASSWORD`, at least 10 characters, set in
   your shell or in `backend/.env`): `npm run db:seed:passwords -w backend`. Never `db:reset` a database you want to keep.
4. **`frontend/.env.local`** (git-ignored; only public values, everything `NEXT_PUBLIC_` is visible in the browser):
   ```
   NEXT_PUBLIC_API_MODE=live
   NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1
   NEXT_PUBLIC_LIVE_MODULES=m1,m2,m3,m4,m5,m6,m7,m8,m9,m12,m13,m14
   ```
   The API address must be absolute: a relative `/api/v1` would send the live connection to the website's own server,
   which has none. Restart `npm run dev` after changing this file (the values are built into the page).
5. **Start**, each in its own terminal: Redis and Mailpit (already running if you use Docker or the services above);
   the API: `npm run build -w backend`, then `npm start -w backend` (check http://localhost:4000/api/v1/health); the
   website: `npm run dev -w aceva-digital-system-web`.
6. **Open http://localhost:3000** (not http://127.0.0.1:3000: the live connection is refused from any other origin).
   Sign in as two people in two separate browser profiles or a normal and a private window (the session is one
   cookie per browser profile), for example ACV-0006 Fahad Khan and ACV-0007 Mariam Shah (developers: no authenticator
   needed), with the demo password. Open the same conversation on both: messages appear on the other screen at once.

## Signing in to the demo
Everyone in the demo roster signs in with their Emp-ID (for example `ACV-0009`) and the `DEMO_PASSWORD` you chose. The
CEO / Founder / Owner, the Director, the CTO and the Finance person are asked to set up an authenticator app (Google or
Microsoft Authenticator) on first login: scan the QR code on screen, then enter the 6-digit code.

The company structure is final: **ACV-0001** Hamza Qureshi is the CEO / Founder / Owner (Level 1; sees everything,
approves nothing except the Director's own leave and attendance corrections), **ACV-0003** Bilal Ahmed is the Director
(Level 2; the only approver and the org administrator, also HR and sales-manager duty), **ACV-0004** Omar Farooq is the
CTO (Level 3), Sales and the Finance person (ACV-0010 Sana Malik) are Level 4 under the Director, and the developers and
SQA are Level 5 under the CTO. There is no separate CEO role and no separate HR officer; the automated tests add a
test-only HR officer to the test database only.

## Module 4 (activity tracking) settings

Three optional lines in `backend/.env` (all have safe defaults; see `backend/.env.example`):

| Variable | Default | What it does |
|---|---|---|
| `GEOIP_RANGES` | empty (every city "unknown") | The approximate city of an internet address, from a **local** list: `range/prefix=City; ...`. No outside service is ever called. To see a city when you sign in on this computer, use `GEOIP_RANGES=127.0.0.0/8=Karachi` (it also covers the IPv6 loopback `::1`). Restart the API after changing it |
| `OUTBOX_DISPATCH_INTERVAL_MS` | `5000` | How often events are turned into activity records, alerts and alert emails. `0` switches it off (the tests do this) |
| `ACTIVITY_SUMMARY_SCHEDULE` | `on` | Builds the nightly activity summaries at 00:15 Pakistan time and catches up the last 7 days after the API was off |

Alert emails go to the Director's and the CTO's official addresses through the normal mailer, so locally they arrive in
Mailpit (http://127.0.0.1:8025). If Mailpit is not running, the alert is still stored and shown; the email is retried. SMTP
sends time out after about 10 to 15 seconds (connection 10 s, greeting 10 s, socket 15 s); a mail server that does not
answer is given up on and the email is retried after 10 s, 30 s, 2 min and so on, without holding up logins or alerts.

The alert thresholds and the "outside working hours" window are the `alert-rules` section of the `system_settings` table.
There is no settings screen yet (Module 12); without a row the defaults apply (outside hours 20:00 to 07:00 Pakistan time,
large export 500 rows, 5 salary records an hour, 3 finance attempts in 15 minutes). `docs/M4-ACCEPTANCE.md` shows how to
change them with SQL for a check by hand.

The database sessions must run in UTC. The API sets this itself on every database connection, so a PostgreSQL in another
time zone (for example Pakistan time, `Asia/Karachi`) works without changes. `SHOW timezone;` in `psql` shows the
server's own setting, which the API does not use.

## Module 5 (tasks, size and deadline) setup

No new environment variables. Module 5 uses the settings above (`FILE_STORAGE_ROOT`, `OUTBOX_DISPATCH_INTERVAL_MS`).

1. After pulling the changes, from the repository root:
   - `npm run build:contracts` (the shared task and approval shapes)
   - `npm run db:migrate` (applies `20261116100000_m5_tasks`: the task tables and the size table, and `20261117100000_m5_task_indexes`: six indexes for the task lists and the "tasks touched" count)
   - `npm run db:seed` (demo projects and holidays; a holiday is a placeholder until the Director edits the calendar)
2. Show the tasks on the website against the real API: in `frontend/.env.local` set
   `NEXT_PUBLIC_LIVE_MODULES=m1,m2,m3,m4,m5` (and `NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1`), then restart the
   website's dev server. The `m5` flag switches the tasks screens and the approvals inbox; without it they show demo data.
3. Reminders and repeating tasks run inside the API. They need the API running with `OUTBOX_DISPATCH_INTERVAL_MS` above 0
   (the default 5000). With 0 they are switched off. The job runner checks its jobs every 30 seconds, so a reminder can
   be up to half a minute late. Mails from the reminders and the other task events arrive in Mailpit
   (http://127.0.0.1:8025).
4. Task files (PDF, PNG, JPEG, .docx, 10 MB) are kept in the same private folder as the employee documents,
   `FILE_STORAGE_ROOT`. Nothing is kept in the repository.
5. The Module 5 database tests (they use `aceva_test`, so run them only when no other test run is going): `npm run build:contracts`, then `npm test -w backend -- m5-`.
   If a clock-moving test fails only late in the evening, check it first: a test that moves the fake clock by a fixed number
   of hours can cross midnight in Pakistan time (after 23:00 Pakistan time), which changes the day it expects.

## Module 6 (performance and results) setup

No new environment variables. Module 6 uses `OUTBOX_DISPATCH_INTERVAL_MS` (the monthly job and the mails) and `APP_URL`
(the links in the mails). Nothing is needed in `backend/.env`.

1. After pulling the changes, from the repository root:
   - `npm run build:contracts` (the shared performance shapes)
   - `npm run db:migrate` (applies `20261118100000_m6_performance`: the scorecard, dispute and weights tables, and the
     starting weight versions, and `20261118110000_m6_recompute_numbers`: the scorecard trigger now also requires the new
     numbers after a decided dispute to equal the result recorded on that dispute. It also applies the Module 5
     migrations if they are still pending)
   - `npm run db:seed` (the demo roster; nothing else is needed for Module 6)
2. Show the performance screens on the website against the real API: in `frontend/.env.local` set
   `NEXT_PUBLIC_LIVE_MODULES=m1,m2,m3,m4,m5,m6` (and `NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1`), then restart the
   website's dev server. `m6` switches the performance screens and the score weights in Settings. Module 6 needs Modules 1
   to 3 and Module 5 live as well (the approvals inbox is live when `m5` or `m6` is in the list). Setting
   `NEXT_PUBLIC_API_MODE=live` switches every module at once. Without `m6` the screens show demo data. `m5` without `m6`
   is supported: the scorecards and disputes in the approvals inbox stay on the demo data (the real October drafts the API
   creates at start-up do not appear in the inbox until `m6` is switched on). `m6` without `m5` leaves the task items
   of the inbox on demo data.
3. The monthly scorecard job runs inside the API, like the task reminders. It needs the API running with
   `OUTBOX_DISPATCH_INTERVAL_MS` above 0 (the default 5000). On the first start after this module is deployed, the month
   that just closed is made at once: drafts for everyone except the Owner, a digest mail to the CTO and the Director (in
   Mailpit, http://127.0.0.1:8025), and the Director's own scorecard released. Reviewers also get a "drafts are waiting"
   mail, which links to the approvals inbox.
4. To run the **current** month by hand (for a check), use SQL in `psql` or any database tool:
   `UPDATE scheduled_jobs SET run_at = now() WHERE dedupe_key = 'scorecard.monthly:2026-11';`
   The job runs within 30 seconds. A month that has not started is refused. The run uses up that month's one job: it is
   marked `succeeded` and never runs again, so no job runs for that month on the 1st. Anyone who joins, or whose task is
   approved, after the hand-run gets no scorecard for that month. Use it for a check only.
   **This cannot be undone.** Scorecards are never deleted, so after a hand-run of the current month the only way back to
   a clean state is a rebuilt database: `npm run db:reset -w backend`, then `npm run db:seed`, then the demo logins again
   (`npm run db:seed:passwords -w backend`).
5. The Module 6 database tests (they use `aceva_test`, so run them only when no other test run is going):
   `npm run build:contracts`, then `npm test -w backend -- m6-`.
   The Node warning "Calling client.query() when the client is already executing a query" in the test output comes from
   Prisma's PostgreSQL adapter. It also appears in the Module 1 to 5 tests and is harmless.

## Cycle 3 migrations (notifications, Module 13 billing, Module 14 messaging)

The order on a new or a main-built database is: Modules 1 to 3, M4, M5, `20261118090000_cycle3_foundation`, M6,
M7 to M9 (`20261119090000` to `20261119090500`), `20261119110000_m13_billing`, `20261120090000_m14_messaging`.
`npm run db:migrate` applies whatever is pending, also a migration older than ones already applied.
The later Module 14 parts add, in this order: `20261123090000_m14_announcements`, `20261123100000_m14_meetings`,
`20261123110000_m14_files`, `20261123120000_m14_links` and `20261124090000_m14_file_safety`. All are additive: new
types, tables, indexes, constraints, functions and triggers, plus two new nullable columns on tables of the same module
(`conversations.project_id`, `comms_files.discarded_at`), whose new CHECKs every existing row already satisfies.

**Backup and rollback (production).** Prisma has no "down" migrations, so the supported way back is the backup:
1. Before `npx prisma migrate deploy`, take a full backup of the database (`pg_dump -Fc -f before-m14.dump <db>`) and
   keep it until the release is accepted.
2. If a migration fails part-way, `npx prisma migrate status` shows it as failed and later ones do not run. Restore the
   backup (simplest), or remove by hand what the failed migration had created and run
   `npx prisma migrate resolve --rolled-back <name>` before deploying again.
3. To undo the Module 14 parts after they applied, restore the backup taken in step 1. Nothing in other modules' tables
   is changed by them, but anything written to the new tables (announcements, meetings, files, links) after the
   deployment is lost with the restore, and the shared files of those days stay in `FILE_STORAGE_ROOT` without records.
   Deleting rows from `_prisma_migrations` or dropping objects by hand is not a supported rollback.
4. Never run these steps against a database you cannot restore (locally: aceva_test is rebuilt by the tests; aceva_dev
   is rebuilt with `npm run db:reset -w backend`).

- `20261118090000_cycle3_foundation` keeps its original name (it needs only the employees and the event outbox).
- The billing migration was first named `20261119090000_m13_billing`. After Modules 7 to 9 moved to `20261119090000`,
  that name would run before the Module 9 tables it changes (invoices, payments, parties), so it is now
  `20261119110000_m13_billing`. Its SQL is unchanged (checksum `490c44fc923b...`). **Only** a database that already
  applied the old name needs one step before `npm run db:migrate`, which records the same migration under its new name
  without running it again:
  `npx prisma migrate resolve --applied 20261119110000_m13_billing` (in `backend/`, with `DATABASE_URL` set to that
  database). The old name stays in its history as an applied migration and is harmless.
- A database built from the Cycle 3 branch before Modules 4 to 6 were merged also has the old Module 7 to 9 names
  (`20261112190000_...` to `20261117090000_...`). Main renamed those and moved the holidays table from Module 7 into
  Module 5, so `20261116100000_m5_tasks` fails there with "relation holidays already exists". The step above does not fix
  that; such a database has to be upgraded by hand or rebuilt (`npm run db:reset -w backend`).

## Module 14 file scanning (ClamAV)

Every file shared in Module 14 (messages and meetings) is checked by ClamAV before anyone can open it. The backend talks
to the ClamAV daemon (`clamd`) over TCP with its standard `INSTREAM` command: `CLAMD_HOST` (default `127.0.0.1`),
`CLAMD_PORT` (default `3310`), `CLAMD_TIMEOUT_MS` (default `60000`). No npm package is involved.

- **Fail closed.** Every upload is checked in memory before it is stored. A file with malware is blocked for good: its
  bytes are never written, the record and the finding stay, audited. While clamd cannot be reached, the upload is kept
  but stays "Scanning..." and can never be downloaded until a check says clean.
- **Retries and recovery.** The scan job (`comms.file.scan`) tries again after 1 minute, then follows the job runner's
  limit of **five attempts** (back-offs of 1 minute, 5 minutes, 30 minutes and 2 hours, about 2.6 hours in all); after
  the fifth failure the job is marked failed. A sweep that runs every 15 minutes on each server
  (`CommsFileMaintenance`, only with background workers on) arms the job again, at most once every **6 hours** per file,
  for as long as the file is still unchecked. So a long outage never leaves a file forgotten, and the file stays closed
  the whole time.
- **Files never sent.** A file uploaded to a conversation but not sent within **24 hours** is discarded by the same
  sweep: its record is marked (never deleted) and then its bytes are removed. A file attached to a message, and a meeting
  file, is never touched; a send racing the discard is decided by the database (one of them wins, the other changes
  nothing).
- **Upload limit.** 10 uploads a minute and 60 an hour per person (`429 rate_limited` with `retryAfterSec`), like the
  limit of 30 messages a minute.
- **Memory.** clamd keeps its signatures in memory (about 1 GB). Start it when you work on or test file sharing.
- **With Docker:** `docker compose --profile scanner up -d clamav` (image `clamav/clamav:1.5.5`, the official Cisco Talos
  image). It uses the image's own healthcheck (`clamdcheck.sh`: clamd must answer PING on 3310) with the image's 6-minute
  start period, because the first start downloads the signatures; `docker compose ps` shows `healthy` once it answers.
  The backend does not need to wait for it: until clamd answers, uploads stay unopenable and are checked again (fail
  closed). **Not runtime-tested here** (Docker is not installed on the development machine); the image tag and the
  healthcheck were checked against Docker Hub and the image's Dockerfile.
- **Without Docker (Windows):** download the official portable `clamav-<version>.win.x64.zip` from clamav.net (check its
  `.sig` against the Talos key), unzip it, then with a `freshclam.conf` (`DatabaseDirectory <folder>`,
  `DatabaseMirror database.clamav.net`) run `freshclam.exe --config-file=freshclam.conf` once, and with a `clamd.conf`
  (`DatabaseDirectory <folder>`, `TCPSocket 3310`, `TCPAddr 127.0.0.1`) run `clamd.exe --config-file=clamd.conf --foreground`.
- **Tests.** `backend/test/m14-clamav.test.ts` and the Playwright file tests in `e2e/m14-collab.spec.ts` and
  `e2e/m14-review.spec.ts` need clamd running (like PostgreSQL and Redis). They use the harmless EICAR test sample,
  assembled at run time so no source file contains it. The scanner-outage test in `e2e/m14-review.spec.ts` stops and
  starts clamd itself: set `CLAMD_EXE` (path to `clamd.exe`) and `CLAMD_CONF` (its `clamd.conf`) when running it. The
  other backend file tests use a controllable stand-in scanner.

## HTTPS (production requirement)

Plan section 19 asks for HTTPS. Locally everything runs over plain HTTP on 127.0.0.1 (no certificates are set up in this
repository). In production the website, the API and the live connection (`/socket.io`) must be served over HTTPS only,
by the hosting or a reverse proxy in front of the servers; the session cookie is only safe there. This is a deployment
step, not something the code switches on.

## Not used locally (on purpose)
MinIO or any other object storage: uploaded files are kept in the private folder `FILE_STORAGE_ROOT`
(`backend/.local-storage` by default, ignored by Git).
