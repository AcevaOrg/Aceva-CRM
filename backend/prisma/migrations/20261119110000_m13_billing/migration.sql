-- Module 13: customer billing, subscriptions and renewal management (plan section 18).
-- ADDITIVE ONLY: new columns on invoices and payments (existing invoices become "issued", which is what they already
-- are: each has its ledger entry), new tables, CHECK constraints and triggers on the new data. No existing row, column
-- or constraint is changed or removed.

CREATE SEQUENCE "subscription_seq" AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 NO CYCLE;

-- CreateEnum
CREATE TYPE "invoice_status" AS ENUM ('draft', 'issued', 'cancelled');

-- CreateEnum
CREATE TYPE "invoice_kind" AS ENUM ('one_time', 'recurring', 'rental');

-- CreateEnum
CREATE TYPE "billing_period" AS ENUM ('monthly', 'quarterly', 'yearly');

-- CreateEnum
CREATE TYPE "recurring_rule_status" AS ENUM ('active', 'ended');

-- CreateEnum
CREATE TYPE "reminder_audience" AS ENUM ('customer', 'staff');

-- CreateEnum
CREATE TYPE "reminder_status" AS ENUM ('scheduled', 'sent', 'skipped');

-- CreateEnum
CREATE TYPE "customer_email_status" AS ENUM ('pending', 'sending', 'sent', 'failed', 'skipped', 'unknown');

-- CreateEnum
CREATE TYPE "subscription_status" AS ENUM ('active', 'cancelled');

-- CreateEnum
CREATE TYPE "subscription_period" AS ENUM ('monthly', 'quarterly', 'yearly', 'usage');

-- CreateEnum
CREATE TYPE "renewal_event_kind" AS ENUM ('alert', 'renewed', 'changed', 'cancelled');

-- AlterTable
ALTER TABLE "invoices" ADD COLUMN     "assigned_to_id" UUID,
ADD COLUMN     "cancel_entry_id" UUID,
ADD COLUMN     "cancel_reason" TEXT,
ADD COLUMN     "cancelled_by" UUID,
ADD COLUMN     "emailed_at" TIMESTAMPTZ(3),
ADD COLUMN     "issued_at" TIMESTAMPTZ(3),
ADD COLUMN     "issued_by" UUID,
ADD COLUMN     "kind" "invoice_kind" NOT NULL DEFAULT 'one_time',
ADD COLUMN     "overdue_event_at" TIMESTAMPTZ(3),
ADD COLUMN     "paid_event_at" TIMESTAMPTZ(3),
ADD COLUMN     "period_end" DATE,
ADD COLUMN     "period_start" DATE,
ADD COLUMN     "recurring_rule_id" UUID,
ADD COLUMN     "reminder_offsets" INTEGER[] DEFAULT ARRAY[]::INTEGER[],
ADD COLUMN     "request_key" TEXT,
ADD COLUMN     "source_deal_number" TEXT,
ADD COLUMN     "source_deal_owner_id" UUID,
ADD COLUMN     "status" "invoice_status" NOT NULL DEFAULT 'issued',
ADD COLUMN     "terms_days" INTEGER;

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "request_key" TEXT;

-- CreateTable
CREATE TABLE "billing_profiles" (
    "party_id" UUID NOT NULL,
    "contact_name" TEXT,
    "terms_days" INTEGER NOT NULL,
    "tax_id" TEXT,
    "notes" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "billing_profiles_pkey" PRIMARY KEY ("party_id")
);

-- CreateTable
CREATE TABLE "recurring_billing_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "party_id" UUID NOT NULL,
    "kind" "invoice_kind" NOT NULL,
    "period" "billing_period" NOT NULL,
    "currency" "currency" NOT NULL,
    "lines" JSONB NOT NULL,
    "terms_days" INTEGER NOT NULL,
    "reminder_offsets" INTEGER[],
    "assigned_to_id" UUID,
    "notes" TEXT,
    "start_date" DATE NOT NULL,
    "end_date" DATE,
    "next_period_start" DATE NOT NULL,
    "status" "recurring_rule_status" NOT NULL DEFAULT 'active',
    "ended_at" TIMESTAMPTZ(3),
    "ended_by" UUID,
    "end_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "recurring_billing_rules_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "invoice_reminders" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_id" UUID NOT NULL,
    "offset_days" INTEGER NOT NULL,
    "audience" "reminder_audience" NOT NULL,
    "scheduled_for" DATE NOT NULL,
    "status" "reminder_status" NOT NULL DEFAULT 'scheduled',
    "reason" TEXT,
    "sent_at" TIMESTAMPTZ(3),
    "notification_id" UUID,
    "customer_email_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invoice_reminders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "billing_customer_emails" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "invoice_id" UUID NOT NULL,
    "kind" TEXT NOT NULL,
    "reminder_offset" INTEGER,
    "to_address" TEXT NOT NULL,
    "dedupe_key" TEXT NOT NULL,
    "status" "customer_email_status" NOT NULL DEFAULT 'pending',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "next_attempt_at" TIMESTAMPTZ(3) NOT NULL,
    "sent_at" TIMESTAMPTZ(3),
    "last_error" TEXT,
    "note" TEXT,
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "billing_customer_emails_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscriptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "number" TEXT NOT NULL DEFAULT ((('SUB-'::text || to_char(now(), 'YYYY'::text)) || '-'::text) || lpad((nextval('subscription_seq'::regclass))::text, 4, '0'::text)),
    "vendor" TEXT NOT NULL,
    "product" TEXT NOT NULL,
    "category" TEXT NOT NULL,
    "owner_id" UUID NOT NULL,
    "plan" TEXT NOT NULL,
    "cost" DECIMAL(14,2) NOT NULL,
    "currency" "currency" NOT NULL,
    "period" "subscription_period" NOT NULL,
    "renewal_date" DATE NOT NULL,
    "alert_days_before" INTEGER NOT NULL,
    "seats" INTEGER,
    "usage_metric" TEXT,
    "usage_unit" TEXT,
    "usage_limit" DECIMAL(18,4),
    "notes" TEXT,
    "status" "subscription_status" NOT NULL DEFAULT 'active',
    "cancelled_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "subscriptions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_renewal_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subscription_id" UUID NOT NULL,
    "kind" "renewal_event_kind" NOT NULL,
    "renewal_date" DATE NOT NULL,
    "new_renewal_date" DATE,
    "old_cost" DECIMAL(14,2),
    "new_cost" DECIMAL(14,2),
    "old_plan" TEXT,
    "new_plan" TEXT,
    "note" TEXT,
    "actor_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "subscription_renewal_events_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "usage_snapshots" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subscription_id" UUID NOT NULL,
    "reading_date" DATE NOT NULL,
    "used" DECIMAL(18,4) NOT NULL,
    "limit" DECIMAL(18,4),
    "estimated_cost" DECIMAL(14,2),
    "source" TEXT NOT NULL DEFAULT 'manual',
    "note" TEXT,
    "entered_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "usage_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "subscription_costs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "subscription_id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency" "currency" NOT NULL,
    "estimated" BOOLEAN NOT NULL,
    "bill_id" UUID,
    "reference" TEXT,
    "note" TEXT,
    "entered_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "subscription_costs_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "recurring_billing_rules_status_next_period_start_idx" ON "recurring_billing_rules"("status", "next_period_start");

-- CreateIndex
CREATE INDEX "invoice_reminders_status_scheduled_for_idx" ON "invoice_reminders"("status", "scheduled_for");

-- CreateIndex
CREATE UNIQUE INDEX "invoice_reminders_invoice_id_offset_days_audience_key" ON "invoice_reminders"("invoice_id", "offset_days", "audience");

-- CreateIndex
CREATE UNIQUE INDEX "billing_customer_emails_dedupe_key_key" ON "billing_customer_emails"("dedupe_key");

-- CreateIndex
CREATE INDEX "billing_customer_emails_status_next_attempt_at_idx" ON "billing_customer_emails"("status", "next_attempt_at");

-- CreateIndex
CREATE INDEX "billing_customer_emails_invoice_id_idx" ON "billing_customer_emails"("invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "subscriptions_number_key" ON "subscriptions"("number");

-- CreateIndex
CREATE INDEX "subscriptions_status_renewal_date_idx" ON "subscriptions"("status", "renewal_date");

-- CreateIndex
CREATE INDEX "subscription_renewal_events_subscription_id_idx" ON "subscription_renewal_events"("subscription_id");

-- CreateIndex
CREATE INDEX "usage_snapshots_subscription_id_reading_date_idx" ON "usage_snapshots"("subscription_id", "reading_date");

-- CreateIndex
CREATE UNIQUE INDEX "subscription_costs_subscription_id_month_key" ON "subscription_costs"("subscription_id", "month");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_source_deal_number_key" ON "invoices"("source_deal_number");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_request_key_key" ON "invoices"("request_key");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_cancel_entry_id_key" ON "invoices"("cancel_entry_id");

-- CreateIndex
CREATE INDEX "invoices_status_due_date_idx" ON "invoices"("status", "due_date");

-- CreateIndex
CREATE UNIQUE INDEX "invoices_recurring_rule_id_period_start_key" ON "invoices"("recurring_rule_id", "period_start");

-- CreateIndex
CREATE UNIQUE INDEX "payments_request_key_key" ON "payments"("request_key");

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_recurring_rule_id_fkey" FOREIGN KEY ("recurring_rule_id") REFERENCES "recurring_billing_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_profiles" ADD CONSTRAINT "billing_profiles_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_billing_rules" ADD CONSTRAINT "recurring_billing_rules_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "recurring_billing_rules" ADD CONSTRAINT "recurring_billing_rules_assigned_to_id_fkey" FOREIGN KEY ("assigned_to_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "invoice_reminders" ADD CONSTRAINT "invoice_reminders_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "billing_customer_emails" ADD CONSTRAINT "billing_customer_emails_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_renewal_events" ADD CONSTRAINT "subscription_renewal_events_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "usage_snapshots" ADD CONSTRAINT "usage_snapshots_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "subscription_costs" ADD CONSTRAINT "subscription_costs_subscription_id_fkey" FOREIGN KEY ("subscription_id") REFERENCES "subscriptions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---- Module 13 rules (hand-written; the database refuses these even if application code has a bug) ----------------

-- A draft has no ledger entry and a temporary DRAFT- number; an issued invoice has its real INV- number (a cancelled
-- draft keeps its DRAFT- number, so issued numbers have no gaps).
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_draft_has_no_entry" CHECK ("status" <> 'draft' OR ("journal_entry_id" IS NULL AND "number" LIKE 'DRAFT-%'));
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_real_number_once_issued" CHECK ("status" <> 'issued' OR "number" NOT LIKE 'DRAFT-%');
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_cancelled_has_time" CHECK ("status" <> 'cancelled' OR "cancelled_at" IS NOT NULL);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_terms_days" CHECK ("terms_days" IS NULL OR "terms_days" BETWEEN 0 AND 365);
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_period" CHECK ("period_start" IS NULL OR "period_end" IS NULL OR "period_end" >= "period_start");

-- Once an invoice has its ledger entry, what the entry was made from never changes, and it is never deleted.
CREATE FUNCTION "protect_issued_invoice"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Invoices are never deleted; cancel it instead (invoice_issued)';
  END IF;
  IF OLD."status" <> 'draft' AND NEW."status" = 'draft' THEN
    RAISE EXCEPTION 'An issued invoice cannot become a draft again (invoice_issued)';
  END IF;
  IF OLD."journal_entry_id" IS NOT NULL AND (
       NEW."journal_entry_id" IS DISTINCT FROM OLD."journal_entry_id"
    OR NEW."number" IS DISTINCT FROM OLD."number"
    OR NEW."party_id" IS DISTINCT FROM OLD."party_id"
    OR NEW."issue_date" IS DISTINCT FROM OLD."issue_date"
    OR NEW."due_date" IS DISTINCT FROM OLD."due_date"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."exchange_rate" IS DISTINCT FROM OLD."exchange_rate"
    OR NEW."total" IS DISTINCT FROM OLD."total") THEN
    RAISE EXCEPTION 'An issued invoice cannot be changed; cancel it instead (invoice_issued)';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "invoices_protect_issued" BEFORE UPDATE OR DELETE ON "invoices" FOR EACH ROW EXECUTE FUNCTION "protect_issued_invoice"();

CREATE FUNCTION "protect_issued_invoice_lines"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  entry uuid;
BEGIN
  SELECT "journal_entry_id" INTO entry FROM "invoices" WHERE "id" = COALESCE(NEW."invoice_id", OLD."invoice_id");
  IF entry IS NOT NULL THEN
    RAISE EXCEPTION 'The lines of an issued invoice cannot be changed (invoice_issued)';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW."invoice_id" IS DISTINCT FROM OLD."invoice_id" THEN
    RAISE EXCEPTION 'A line cannot move to another invoice (invoice_issued)';
  END IF;
  RETURN COALESCE(NEW, OLD);
END $$;
CREATE TRIGGER "invoice_lines_protect_issued" BEFORE INSERT OR UPDATE OR DELETE ON "invoice_lines" FOR EACH ROW EXECUTE FUNCTION "protect_issued_invoice_lines"();

ALTER TABLE "billing_profiles" ADD CONSTRAINT "billing_profiles_terms_days" CHECK ("terms_days" BETWEEN 0 AND 365);

ALTER TABLE "recurring_billing_rules" ADD CONSTRAINT "recurring_rules_kind" CHECK ("kind" <> 'one_time');
ALTER TABLE "recurring_billing_rules" ADD CONSTRAINT "recurring_rules_terms_days" CHECK ("terms_days" BETWEEN 0 AND 365);
ALTER TABLE "recurring_billing_rules" ADD CONSTRAINT "recurring_rules_dates" CHECK ("end_date" IS NULL OR "end_date" >= "start_date");

ALTER TABLE "invoice_reminders" ADD CONSTRAINT "invoice_reminders_offset" CHECK ("offset_days" BETWEEN -60 AND 120);

ALTER TABLE "billing_customer_emails" ADD CONSTRAINT "billing_customer_emails_kind" CHECK ("kind" IN ('invoice', 'reminder'));
ALTER TABLE "billing_customer_emails" ADD CONSTRAINT "billing_customer_emails_attempts" CHECK ("attempts" >= 0);

ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_category" CHECK ("category" IN ('sales_tools', 'domains_email', 'ai', 'hosting', 'api', 'dev_tools', 'crm'));
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_cost" CHECK ("cost" >= 0);
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_alert_days" CHECK ("alert_days_before" BETWEEN 0 AND 365);
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_seats" CHECK ("seats" IS NULL OR "seats" >= 0);
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_usage_limit" CHECK ("usage_limit" IS NULL OR "usage_limit" > 0);
ALTER TABLE "subscriptions" ADD CONSTRAINT "subscriptions_cancelled_has_time" CHECK ("status" <> 'cancelled' OR "cancelled_at" IS NOT NULL);

-- One renewal alert per subscription and renewal date (a re-run of the daily job adds nothing).
CREATE UNIQUE INDEX "subscription_renewal_events_one_alert" ON "subscription_renewal_events" ("subscription_id", "renewal_date") WHERE "kind" = 'alert';

ALTER TABLE "usage_snapshots" ADD CONSTRAINT "usage_snapshots_used" CHECK ("used" >= 0);
ALTER TABLE "usage_snapshots" ADD CONSTRAINT "usage_snapshots_limit" CHECK ("limit" IS NULL OR "limit" > 0);
ALTER TABLE "usage_snapshots" ADD CONSTRAINT "usage_snapshots_cost" CHECK ("estimated_cost" IS NULL OR "estimated_cost" >= 0);
-- No provider is connected yet: every reading is typed in. ("api" is kept for a later provider connection.)
ALTER TABLE "usage_snapshots" ADD CONSTRAINT "usage_snapshots_source" CHECK ("source" IN ('manual', 'api'));

ALTER TABLE "subscription_costs" ADD CONSTRAINT "subscription_costs_month" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "subscription_costs" ADD CONSTRAINT "subscription_costs_amount" CHECK ("amount" >= 0);
-- A cost is only "actual" when it is backed by a Module 9 bill or the provider's own invoice reference.
ALTER TABLE "subscription_costs" ADD CONSTRAINT "subscription_costs_actual_is_backed" CHECK ("estimated" OR "bill_id" IS NOT NULL OR "reference" IS NOT NULL);

-- History is insert-only.
CREATE TRIGGER "subscription_renewal_events_insert_only" BEFORE UPDATE OR DELETE ON "subscription_renewal_events" FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "usage_snapshots_insert_only" BEFORE UPDATE OR DELETE ON "usage_snapshots" FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();

-- ---- Won-deal handover (review decision 5): exact, unique client name only; ambiguous names wait for Finance ----------
-- CreateEnum
CREATE TYPE "deal_handover_status" AS ENUM ('drafted', 'needs_client');

-- AlterTable
ALTER TABLE "billing_profiles" ADD COLUMN     "created_from_deal" TEXT,
ADD COLUMN     "needs_review" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "deal_handovers" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deal_number" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "deal_handover_status" NOT NULL,
    "candidate_party_ids" UUID[],
    "invoice_id" UUID,
    "source_event_id" UUID,
    "resolved_by" UUID,
    "resolved_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "deal_handovers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "deal_handovers_deal_number_key" ON "deal_handovers"("deal_number");

-- CreateIndex
CREATE UNIQUE INDEX "deal_handovers_invoice_id_key" ON "deal_handovers"("invoice_id");

-- CreateIndex
CREATE INDEX "deal_handovers_status_idx" ON "deal_handovers"("status");

-- drafted = its draft invoice exists; needs_client = two or more clients have exactly that name and Finance chooses.
ALTER TABLE "deal_handovers" ADD CONSTRAINT "deal_handovers_state" CHECK (
  ("status" = 'drafted' AND "invoice_id" IS NOT NULL)
  OR ("status" = 'needs_client' AND "invoice_id" IS NULL AND cardinality("candidate_party_ids") >= 2));
