-- Runs once, the first time the PostgreSQL container starts with an empty data volume (docker-compose.yml).
-- aceva_dev is created by POSTGRES_DB. These are the other two databases the backend uses, owned by the same user.

-- Automated tests (npm test, npm run test:e2e). Emptied and rebuilt on every run; the name must contain "test".
CREATE DATABASE aceva_test OWNER aceva_app;

-- Used only by "prisma migrate dev" to check new migrations in a throwaway database.
CREATE DATABASE aceva_shadow OWNER aceva_app;
