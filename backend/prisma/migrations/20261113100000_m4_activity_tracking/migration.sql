-- CreateEnum
CREATE TYPE "activity_action" AS ENUM ('login', 'logout', 'login_failed', 'screen_view', 'create', 'edit', 'delete', 'submit', 'assign', 'approve', 'reject', 'comment', 'upload', 'download', 'export', 'print', 'sensitive_view', 'blocked', 'security', 'email_sent', 'reply', 'bounce', 'call', 'email_check');

-- CreateEnum
CREATE TYPE "alert_kind" AS ENUM ('account_locked', 'new_device', 'outside_hours', 'large_export', 'salary_views', 'finance_attempts');

-- CreateEnum
CREATE TYPE "alert_severity" AS ENUM ('low', 'medium', 'high');

-- AlterTable
ALTER TABLE "outbox_events" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "last_error" TEXT,
ADD COLUMN     "locked_by" TEXT,
ADD COLUMN     "locked_until" TIMESTAMPTZ(3),
ADD COLUMN     "next_attempt_at" TIMESTAMPTZ(3);

-- CreateTable
CREATE TABLE "outbox_deliveries" (
    "event_id" UUID NOT NULL,
    "consumer" TEXT NOT NULL,
    "delivered_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_deliveries_pkey" PRIMARY KEY ("event_id","consumer")
);

-- CreateTable
CREATE TABLE "system_settings" (
    "section" TEXT NOT NULL,
    "values" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "system_settings_pkey" PRIMARY KEY ("section")
);

-- CreateTable
CREATE TABLE "activity_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "employee_id" UUID NOT NULL,
    "session_id" UUID,
    "source" TEXT NOT NULL DEFAULT 'aceva',
    "action" "activity_action" NOT NULL,
    "module" TEXT NOT NULL,
    "target" TEXT,
    "description" TEXT NOT NULL,
    "ip" TEXT,
    "city" TEXT,
    "device" TEXT,
    "request_id" UUID,
    "dedupe_key" TEXT,
    "finance_linked" BOOLEAN NOT NULL DEFAULT false,
    "details" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_heartbeats" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "session_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "at" TIMESTAMPTZ(3) NOT NULL,
    "active" BOOLEAN NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_heartbeats_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "activity_daily_summaries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "first_login_at" TIMESTAMPTZ(3),
    "last_logout_at" TIMESTAMPTZ(3),
    "active_minutes" INTEGER NOT NULL,
    "idle_minutes" INTEGER NOT NULL,
    "actions" INTEGER NOT NULL,
    "tasks_touched" INTEGER NOT NULL DEFAULT 0,
    "check_in_at" TIMESTAMPTZ(3),
    "idle_spans" JSONB NOT NULL DEFAULT '[]',
    "sessions" INTEGER NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "activity_daily_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_alerts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" "alert_kind" NOT NULL,
    "rule" TEXT NOT NULL,
    "severity" "alert_severity" NOT NULL,
    "employee_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "details" TEXT NOT NULL,
    "data" JSONB,
    "dedupe_key" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_alerts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_alert_checks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "alert_id" UUID NOT NULL,
    "checked_by" UUID NOT NULL,
    "note" TEXT NOT NULL,
    "checked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "security_alert_checks_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "activity_events_dedupe_key_key" ON "activity_events"("dedupe_key");

-- CreateIndex
CREATE INDEX "activity_events_employee_id_occurred_at_idx" ON "activity_events"("employee_id", "occurred_at");

-- CreateIndex
CREATE INDEX "activity_events_occurred_at_idx" ON "activity_events"("occurred_at");

-- CreateIndex
CREATE INDEX "activity_events_session_id_occurred_at_idx" ON "activity_events"("session_id", "occurred_at");

-- CreateIndex
CREATE INDEX "activity_events_action_occurred_at_idx" ON "activity_events"("action", "occurred_at");

-- CreateIndex
CREATE INDEX "activity_events_request_id_idx" ON "activity_events"("request_id");

-- CreateIndex
CREATE INDEX "activity_events_finance_linked_occurred_at_idx" ON "activity_events"("finance_linked", "occurred_at");

-- CreateIndex
CREATE INDEX "activity_heartbeats_session_id_at_idx" ON "activity_heartbeats"("session_id", "at");

-- CreateIndex
CREATE INDEX "activity_heartbeats_employee_id_at_idx" ON "activity_heartbeats"("employee_id", "at");

-- CreateIndex
CREATE INDEX "activity_heartbeats_at_idx" ON "activity_heartbeats"("at");

-- CreateIndex
CREATE INDEX "activity_daily_summaries_day_idx" ON "activity_daily_summaries"("day");

-- CreateIndex
CREATE UNIQUE INDEX "activity_daily_summaries_employee_id_day_key" ON "activity_daily_summaries"("employee_id", "day");

-- CreateIndex
CREATE UNIQUE INDEX "security_alerts_dedupe_key_key" ON "security_alerts"("dedupe_key");

-- CreateIndex
CREATE INDEX "security_alerts_occurred_at_idx" ON "security_alerts"("occurred_at");

-- CreateIndex
CREATE INDEX "security_alerts_employee_id_kind_occurred_at_idx" ON "security_alerts"("employee_id", "kind", "occurred_at");

-- CreateIndex
CREATE UNIQUE INDEX "security_alert_checks_alert_id_key" ON "security_alert_checks"("alert_id");

-- CreateIndex
CREATE INDEX "security_alert_checks_checked_at_idx" ON "security_alert_checks"("checked_at");

-- CreateIndex
CREATE INDEX "audit_log_request_id_idx" ON "audit_log"("request_id");

-- AddForeignKey
ALTER TABLE "outbox_deliveries" ADD CONSTRAINT "outbox_deliveries_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "outbox_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_heartbeats" ADD CONSTRAINT "activity_heartbeats_session_id_fkey" FOREIGN KEY ("session_id") REFERENCES "sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_heartbeats" ADD CONSTRAINT "activity_heartbeats_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity_daily_summaries" ADD CONSTRAINT "activity_daily_summaries_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_alerts" ADD CONSTRAINT "security_alerts_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_alert_checks" ADD CONSTRAINT "security_alert_checks_alert_id_fkey" FOREIGN KEY ("alert_id") REFERENCES "security_alerts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_alert_checks" ADD CONSTRAINT "security_alert_checks_checked_by_fkey" FOREIGN KEY ("checked_by") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written part (Module 4): rules Prisma cannot express.
-- ===========================================================================

-- ---- CHECK constraints ----------------------------------------------------

-- "aceva" or a connected sales tool's name (Module 16): lower-case letters, digits and underscores.
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_source_format" CHECK ("source" ~ '^[a-z][a-z0-9_]{1,30}$');
ALTER TABLE "activity_events" ADD CONSTRAINT "activity_events_module_present" CHECK (length("module") BETWEEN 1 AND 80);

-- A day has 1440 minutes.
ALTER TABLE "activity_daily_summaries" ADD CONSTRAINT "activity_daily_summaries_minutes" CHECK (
  "active_minutes" >= 0 AND "idle_minutes" >= 0 AND "active_minutes" + "idle_minutes" <= 1440
  AND "actions" >= 0 AND "tasks_touched" >= 0 AND "sessions" >= 0
);

ALTER TABLE "security_alert_checks" ADD CONSTRAINT "security_alert_checks_note_present" CHECK (length(btrim("note")) > 0);

ALTER TABLE "outbox_events" ADD CONSTRAINT "outbox_events_attempts" CHECK ("attempts" >= 0);

-- ---- Index for the outbox dispatcher: only the rows still waiting are scanned ----
CREATE INDEX "outbox_events_pending_idx" ON "outbox_events" ("occurred_at") WHERE "processed_at" IS NULL;

-- ---- Tracking data is insert-only (plan section 8: "Nobody, at any level, can edit or delete tracking data") ----
-- Uses the prevent_modification() function from the first migration. Checking an alert adds a row to
-- security_alert_checks; it never changes the alert.

CREATE TRIGGER "activity_events_insert_only" BEFORE UPDATE OR DELETE ON "activity_events"
  FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "activity_events_no_truncate" BEFORE TRUNCATE ON "activity_events"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

CREATE TRIGGER "activity_heartbeats_insert_only" BEFORE UPDATE OR DELETE ON "activity_heartbeats"
  FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "activity_heartbeats_no_truncate" BEFORE TRUNCATE ON "activity_heartbeats"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

CREATE TRIGGER "activity_daily_summaries_insert_only" BEFORE UPDATE OR DELETE ON "activity_daily_summaries"
  FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "activity_daily_summaries_no_truncate" BEFORE TRUNCATE ON "activity_daily_summaries"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

CREATE TRIGGER "security_alerts_insert_only" BEFORE UPDATE OR DELETE ON "security_alerts"
  FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "security_alerts_no_truncate" BEFORE TRUNCATE ON "security_alerts"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

CREATE TRIGGER "security_alert_checks_insert_only" BEFORE UPDATE OR DELETE ON "security_alert_checks"
  FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "security_alert_checks_no_truncate" BEFORE TRUNCATE ON "security_alert_checks"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();
