# Local setup (Windows, no Docker)

## Needed once
1. **Node.js 22 or newer** (24 is installed on this machine).
2. **PostgreSQL 17** installed as a Windows service (here: `E:\PostgreSQL\17`, data `E:\PostgreSQL\data`).
3. Three databases owned by a limited user (not a superuser): `aceva_dev`, `aceva_test`, `aceva_shadow`; user `aceva_app`.
4. **Redis** (holds the fast copy of every session). Here: a portable Redis 8 for Windows in `E:\tools\redis` (a community build,
   for development only). For production use a managed Redis (for example Upstash) or a server install.
5. **Mailpit** (catches the emails the app sends; open http://127.0.0.1:8025 to read them). Here: `E:\tools\mailpit\mailpit.exe`.
6. `npm install` in the repository root (installs frontend, backend and shared contracts together).
7. `backend/.env`: copy `backend/.env.example` and fill it in. Never commit `.env`. It needs the database URLs, `REDIS_URL`, and a
   `DATA_ENCRYPTION_KEY` (create one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`).
8. For the browser tests: `set PLAYWRIGHT_BROWSERS_PATH=E:\playwright-browsers`, then `npx playwright install chromium`.

## Start the local services (each time you restart Windows)
Run in PowerShell: `E:\tools\start-dev-services.ps1`. It starts Redis (password from `E:\PostgreSQL\secrets\redis.txt`) and Mailpit,
both listening on this computer only. PostgreSQL starts by itself as a Windows service.

## Everyday commands (repository root)
| What | Command |
|---|---|
| Create/update tables | `npm run db:migrate` |
| Load demo people | `npm run db:seed` |
| Give the demo people a login | set `DEMO_PASSWORD` (at least 10 characters), then `npm run db:seed:passwords`. Development only; refuses production |
| Type check, lint | `npm run typecheck`, `npm run lint` |
| Unit and database tests (use `aceva_test`, rebuilt each run; need PostgreSQL and Redis) | `npm test` |
| Browser tests (real backend and frontend on ports 4100 and 3100; need PostgreSQL, Redis and Mailpit) | `npm run test:e2e` |
| Build everything | `npm run build` |
| Run the API | `npm run build -w backend` then `npm start -w backend` (http://localhost:4000/api/docs) |
| Run the website against the real API | in `frontend/.env.local`: `NEXT_PUBLIC_LIVE_MODULES=m1,m2,m3,m7,m9` and `NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1`, then `npm run dev -w aceva-digital-system-web` |

## Signing in to the demo
Everyone in the demo roster signs in with their Emp-ID (for example `ACV-0009`) and the `DEMO_PASSWORD` you chose. The Owner,
Director, CTO and the Finance person are asked to set up an authenticator app (Google or Microsoft Authenticator) on first login:
scan the QR code on screen, then enter the 6-digit code.

The demo roster has no CEO and no separate HR officer (the Director holds the HR duty). Level 2 (CEO) is still an official level and
role. A CEO is added through the joining workflow when the company has one. The automated tests add a test-only CEO and HR officer
to the test database only.

The npm download cache is kept on `E:` through your user-level npm config (`npm config set cache E:
pm-cache --location=user`),
not in the repository.

## Not installed (on purpose)
Docker and MinIO. Redis and Mailpit are installed as plain Windows programs (no admin rights, no services).
