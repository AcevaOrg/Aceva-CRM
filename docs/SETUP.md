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
| Unit and database tests (use `aceva_test`, rebuilt each run; need PostgreSQL and Redis) | `npm test` |
| Browser tests (real backend and frontend on ports 4100 and 3100; need PostgreSQL, Redis and Mailpit) | once: `npx playwright install chromium`; then `npm run test:e2e` |
| Build everything | `npm run build` |
| Run the API | `npm run build -w backend` then `npm start -w backend` (http://localhost:4000/api/docs) |
| Run the website against the real API | in `frontend/.env.local`: `NEXT_PUBLIC_LIVE_MODULES=m1,m2,m3` and `NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1`, then `npm run dev -w aceva-digital-system-web` |

**A database made before the final company structure** (it still has the separate CEO role, the Level 3 Director or
the "Department Head / Team Lead" role) is refused by `npm run db:seed` with a message saying so. Rebuild it once with
`npm run db:reset -w backend`, then run `npm run db:seed` and the demo logins again.

Browser downloads for the tests go to Playwright's default folder. To keep them on another drive, set
`PLAYWRIGHT_BROWSERS_PATH` to a folder of your choice before `npx playwright install chromium` and before the tests.
If your system drive is short of space, move npm's download cache in your user-level npm config
(`npm config set cache <folder> --location=user`), never in the repository.

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

## Not used locally (on purpose)
MinIO or any other object storage: uploaded files are kept in the private folder `FILE_STORAGE_ROOT`
(`backend/.local-storage` by default, ignored by Git).
