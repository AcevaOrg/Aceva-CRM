# Local setup (Windows, no Docker)

## Needed once
1. **Node.js 22 or newer** (24 is installed on this machine).
2. **PostgreSQL 17** installed as a Windows service. Install location used here: `E:\PostgreSQL\17`, data `E:\PostgreSQL\data`.
3. Three databases owned by a limited user (not a superuser): `aceva_dev`, `aceva_test`, `aceva_shadow`, user `aceva_app`.
4. `npm install` in the repository root (installs frontend, backend and shared contracts together).
5. `backend/.env`: copy `backend/.env.example` and fill in the database password. Never commit `.env`.
6. For the browser tests: `set PLAYWRIGHT_BROWSERS_PATH=E:\playwright-browsers` then `npx playwright install chromium`.

## Everyday commands (repository root)
| What | Command |
|---|---|
| Create/update tables | `npm run db:migrate` |
| Load demo people | `npm run db:seed` |
| Type check, lint | `npm run typecheck`, `npm run lint` |
| Unit and database tests (uses `aceva_test`, rebuilt each run) | `npm test` |
| Browser tests (real backend + frontend on ports 4100 and 3100) | `npm run test:e2e` |
| Build everything | `npm run build` |
| Run the API | `npm run build -w backend` then `npm start -w backend` (http://localhost:4000/api/docs) |
| Run the website with the real Module 1 | in `frontend/.env.local`: `NEXT_PUBLIC_LIVE_MODULES=m1`, `NEXT_PUBLIC_DEV_IDENTITY=true`, `NEXT_PUBLIC_API_URL=http://localhost:4000/api/v1`, then `npm run dev -w aceva-digital-system-web` |

The API reads `DEV_IDENTITY_ENABLED=true` (in `backend/.env`) only in development, until M2 login exists.

## Not installed (on purpose)
Docker, Redis, MinIO, Mailpit. Redis and Mailpit are added when M2 needs them.
