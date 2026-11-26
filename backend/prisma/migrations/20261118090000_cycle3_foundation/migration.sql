-- Cycle 3 shared foundation (additive only: new tables and types; no existing table, row or constraint is changed).
--  * outbox_consumers / outbox_consumptions: several modules can each read the same outbox event exactly once.
--    The existing processed_at column on outbox_events stays with its one existing reader (final settlements).
--  * notifications, notification_preferences, notification_deliveries: the minimal Module 12 notification core.
--  * module_settings: settings owned by one module, validated by that module, versioned and audited.

-- CreateEnum
CREATE TYPE "outbox_consumption_status" AS ENUM ('done', 'failed', 'dead', 'skipped');

-- CreateEnum
CREATE TYPE "notification_delivery_status" AS ENUM ('pending', 'sending', 'sent', 'failed', 'skipped', 'unknown');

-- CreateTable
CREATE TABLE "outbox_consumers" (
    "name" TEXT NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_consumers_pkey" PRIMARY KEY ("name")
);

-- CreateTable
CREATE TABLE "outbox_consumptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "consumer" TEXT NOT NULL,
    "event_id" UUID NOT NULL,
    "status" "outbox_consumption_status" NOT NULL,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "last_error" TEXT,
    "next_attempt_at" TIMESTAMPTZ(3),
    "processed_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "outbox_consumptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "recipient_id" UUID NOT NULL,
    "type" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "link" TEXT,
    "essential" BOOLEAN NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "source_event_id" UUID,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "notification_preferences" (
    "employee_id" UUID NOT NULL,
    "email_off" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "daily_summary" BOOLEAN NOT NULL DEFAULT true,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_preferences_pkey" PRIMARY KEY ("employee_id")
);

-- CreateTable
CREATE TABLE "notification_deliveries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "notification_id" UUID NOT NULL,
    "channel" TEXT NOT NULL DEFAULT 'email',
    "status" "notification_delivery_status" NOT NULL DEFAULT 'pending',
    "note" TEXT,
    "to_address" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "claimed_at" TIMESTAMPTZ(3),
    "sent_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "notification_deliveries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "module_settings" (
    "module" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "module_settings_pkey" PRIMARY KEY ("module")
);

-- CreateIndex
CREATE INDEX "outbox_consumptions_consumer_status_next_attempt_at_idx" ON "outbox_consumptions"("consumer", "status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "outbox_consumptions_consumer_event_id_key" ON "outbox_consumptions"("consumer", "event_id");

-- CreateIndex
CREATE INDEX "notifications_recipient_id_created_at_idx" ON "notifications"("recipient_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "notifications_recipient_id_dedupe_key_key" ON "notifications"("recipient_id", "dedupe_key");

-- CreateIndex
CREATE INDEX "notification_deliveries_status_next_attempt_at_idx" ON "notification_deliveries"("status", "next_attempt_at");

-- CreateIndex
CREATE UNIQUE INDEX "notification_deliveries_notification_id_channel_key" ON "notification_deliveries"("notification_id", "channel");

-- AddForeignKey
ALTER TABLE "outbox_consumptions" ADD CONSTRAINT "outbox_consumptions_consumer_fkey" FOREIGN KEY ("consumer") REFERENCES "outbox_consumers"("name") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "outbox_consumptions" ADD CONSTRAINT "outbox_consumptions_event_id_fkey" FOREIGN KEY ("event_id") REFERENCES "outbox_events"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_recipient_id_fkey" FOREIGN KEY ("recipient_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_notification_id_fkey" FOREIGN KEY ("notification_id") REFERENCES "notifications"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---- Hand-written rules (Prisma cannot express them) ----------------------------------------------------------
-- Approvals and security alerts can never have their email turned off (plan section 17). Keep this list equal to
-- ESSENTIAL_NOTIFICATION_TYPES in packages/contracts/src/notifications.ts.
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_essential_always_emailed"
  CHECK (NOT ("email_off" && ARRAY['approval_waiting', 'payroll_ready', 'leave_requested', 'extension_requested', 'security_alert']::TEXT[]));
-- A notification links only to a path inside the app, never to an external address.
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_link_is_app_path" CHECK ("link" IS NULL OR "link" ~ '^/([^/]|$)');
ALTER TABLE "outbox_consumptions" ADD CONSTRAINT "outbox_consumptions_attempts" CHECK ("attempts" >= 0);
ALTER TABLE "notification_deliveries" ADD CONSTRAINT "notification_deliveries_attempts" CHECK ("attempts" >= 0);
ALTER TABLE "module_settings" ADD CONSTRAINT "module_settings_version" CHECK ("version" >= 1);
