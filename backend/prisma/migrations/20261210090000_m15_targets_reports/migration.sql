-- Module 15.6, targets, the manual daily log and the nightly daily sales report (plan section 20): "the sales manager sets
-- targets for each person for every working day ... and for each month", "Manual daily log ... marked self-reported",
-- "Daily sales report: built automatically every night for each salesperson ... compared with that day's targets".
-- ADDITIVE ONLY: five new tables with their indexes, constraints and triggers. No existing table, column, constraint or
-- trigger is changed.

-- CreateTable
CREATE TABLE "sales_daily_targets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "effective_from" DATE NOT NULL,
    "leads_added" INTEGER,
    "emails_checked" INTEGER,
    "emails_sent" INTEGER,
    "follow_ups_done" INTEGER,
    "set_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_daily_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_monthly_targets" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "month" TEXT NOT NULL,
    "meetings_booked" INTEGER,
    "proposals_sent" INTEGER,
    "won_amount" DECIMAL(14,2),
    "won_currency" "currency",
    "set_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_monthly_targets_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_daily_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "version" INTEGER NOT NULL,
    "linkedin" INTEGER NOT NULL,
    "whatsapp" INTEGER NOT NULL,
    "fiverr" INTEGER NOT NULL,
    "calls" INTEGER NOT NULL,
    "field_visits" INTEGER NOT NULL,
    "note" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_daily_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_daily_reports" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "generated_at" TIMESTAMPTZ(3) NOT NULL,
    "job" TEXT NOT NULL,
    "targets" JSONB,
    "metrics" JSONB NOT NULL,
    "met" BOOLEAN,
    "log_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_daily_reports_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_proof_requests" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "day" DATE NOT NULL,
    "log_id" UUID NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'open',
    "note" TEXT NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "answer" TEXT,
    "answered_at" TIMESTAMPTZ(3),
    "close_note" TEXT,
    "closed_by_id" UUID,
    "closed_at" TIMESTAMPTZ(3),

    CONSTRAINT "sales_proof_requests_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_daily_targets_employee_id_effective_from_created_at_idx" ON "sales_daily_targets"("employee_id", "effective_from", "created_at");

-- CreateIndex
CREATE INDEX "sales_monthly_targets_employee_id_month_created_at_idx" ON "sales_monthly_targets"("employee_id", "month", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sales_daily_logs_employee_id_day_version_key" ON "sales_daily_logs"("employee_id", "day", "version");

-- CreateIndex
CREATE INDEX "sales_daily_reports_day_idx" ON "sales_daily_reports"("day");

-- CreateIndex
CREATE UNIQUE INDEX "sales_daily_reports_employee_id_day_key" ON "sales_daily_reports"("employee_id", "day");

-- CreateIndex
CREATE INDEX "sales_proof_requests_employee_id_day_idx" ON "sales_proof_requests"("employee_id", "day");

-- CreateIndex
CREATE INDEX "sales_proof_requests_status_idx" ON "sales_proof_requests"("status");

-- AddForeignKey
ALTER TABLE "sales_daily_targets" ADD CONSTRAINT "sales_daily_targets_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_daily_targets" ADD CONSTRAINT "sales_daily_targets_set_by_id_fkey" FOREIGN KEY ("set_by_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_monthly_targets" ADD CONSTRAINT "sales_monthly_targets_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_monthly_targets" ADD CONSTRAINT "sales_monthly_targets_set_by_id_fkey" FOREIGN KEY ("set_by_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_daily_logs" ADD CONSTRAINT "sales_daily_logs_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_daily_reports" ADD CONSTRAINT "sales_daily_reports_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_daily_reports" ADD CONSTRAINT "sales_daily_reports_log_id_fkey" FOREIGN KEY ("log_id") REFERENCES "sales_daily_logs"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_proof_requests" ADD CONSTRAINT "sales_proof_requests_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_proof_requests" ADD CONSTRAINT "sales_proof_requests_log_id_fkey" FOREIGN KEY ("log_id") REFERENCES "sales_daily_logs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_proof_requests" ADD CONSTRAINT "sales_proof_requests_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_proof_requests" ADD CONSTRAINT "sales_proof_requests_closed_by_id_fkey" FOREIGN KEY ("closed_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ======================================================================================================================
-- Hand-written rules (Prisma cannot express them).

-- Targets: whole numbers from 0 to 10,000 (null = no target); a deals-won target has both an amount (more than zero) and
-- a currency, or neither; a month looks like 2026-12. Targets are versioned records: insert-only (a change is a new row).
ALTER TABLE "sales_daily_targets" ADD CONSTRAINT "sales_daily_targets_values" CHECK (
  ("leads_added" IS NULL OR "leads_added" BETWEEN 0 AND 10000) AND ("emails_checked" IS NULL OR "emails_checked" BETWEEN 0 AND 10000)
  AND ("emails_sent" IS NULL OR "emails_sent" BETWEEN 0 AND 10000) AND ("follow_ups_done" IS NULL OR "follow_ups_done" BETWEEN 0 AND 10000)
);
ALTER TABLE "sales_monthly_targets" ADD CONSTRAINT "sales_monthly_targets_values" CHECK (
  ("meetings_booked" IS NULL OR "meetings_booked" BETWEEN 0 AND 10000) AND ("proposals_sent" IS NULL OR "proposals_sent" BETWEEN 0 AND 10000)
);
ALTER TABLE "sales_monthly_targets" ADD CONSTRAINT "sales_monthly_targets_won" CHECK (
  ("won_amount" IS NULL) = ("won_currency" IS NULL) AND ("won_amount" IS NULL OR "won_amount" > 0)
);
ALTER TABLE "sales_monthly_targets" ADD CONSTRAINT "sales_monthly_targets_month" CHECK ("month" ~ '^\d{4}-(0[1-9]|1[0-2])$');
CREATE TRIGGER "sales_daily_targets_insert_only" BEFORE UPDATE OR DELETE ON "sales_daily_targets" FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "sales_daily_targets_no_truncate" BEFORE TRUNCATE ON "sales_daily_targets" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "sales_monthly_targets_insert_only" BEFORE UPDATE OR DELETE ON "sales_monthly_targets" FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "sales_monthly_targets_no_truncate" BEFORE TRUNCATE ON "sales_monthly_targets" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

-- The daily log: counts from 0 to 1,000, versions from 1, a short note. Every save is a new version (insert-only), and no
-- version can be added once that day's report exists (the report keeps the version it used).
ALTER TABLE "sales_daily_logs" ADD CONSTRAINT "sales_daily_logs_values" CHECK (
  "version" >= 1 AND "linkedin" BETWEEN 0 AND 1000 AND "whatsapp" BETWEEN 0 AND 1000 AND "fiverr" BETWEEN 0 AND 1000
  AND "calls" BETWEEN 0 AND 1000 AND "field_visits" BETWEEN 0 AND 1000 AND ("note" IS NULL OR char_length("note") <= 1000)
);
CREATE FUNCTION "check_sales_daily_log_open"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "sales_daily_reports" r WHERE r."employee_id" = NEW."employee_id" AND r."day" = NEW."day") THEN
    RAISE EXCEPTION 'The daily log of a day whose report exists cannot change (log_locked)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "sales_daily_logs_open" BEFORE INSERT ON "sales_daily_logs" FOR EACH ROW EXECUTE FUNCTION "check_sales_daily_log_open"();
CREATE TRIGGER "sales_daily_logs_insert_only" BEFORE UPDATE OR DELETE ON "sales_daily_logs" FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "sales_daily_logs_no_truncate" BEFORE TRUNCATE ON "sales_daily_logs" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

-- The nightly report is a record of what was measured: one per person and day (unique index), never changed or removed.
CREATE TRIGGER "sales_daily_reports_insert_only" BEFORE UPDATE OR DELETE ON "sales_daily_reports" FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "sales_daily_reports_no_truncate" BEFORE TRUNCATE ON "sales_daily_reports" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

-- Proof requests: open, then answered, then closed (or closed straight away). At most one not closed per person and day.
-- Only the answer and the closing are ever added; nothing else changes, a closed request is final, none is deleted.
ALTER TABLE "sales_proof_requests" ADD CONSTRAINT "sales_proof_requests_status" CHECK ("status" IN ('open', 'answered', 'closed'));
ALTER TABLE "sales_proof_requests" ADD CONSTRAINT "sales_proof_requests_note" CHECK (char_length(btrim("note")) BETWEEN 5 AND 500);
ALTER TABLE "sales_proof_requests" ADD CONSTRAINT "sales_proof_requests_answer" CHECK (
  ("answer" IS NULL) = ("answered_at" IS NULL) AND ("answer" IS NULL OR char_length(btrim("answer")) BETWEEN 3 AND 1000)
);
ALTER TABLE "sales_proof_requests" ADD CONSTRAINT "sales_proof_requests_closed" CHECK (
  ("status" = 'closed') = ("closed_at" IS NOT NULL AND "closed_by_id" IS NOT NULL AND "close_note" IS NOT NULL)
);
ALTER TABLE "sales_proof_requests" ADD CONSTRAINT "sales_proof_requests_answered" CHECK ("status" <> 'answered' OR "answer" IS NOT NULL);
CREATE UNIQUE INDEX "sales_proof_requests_one_active_key" ON "sales_proof_requests"("employee_id", "day") WHERE "status" <> 'closed';
CREATE FUNCTION "protect_sales_proof_request"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."status" = 'closed'
     OR NEW."employee_id" IS DISTINCT FROM OLD."employee_id" OR NEW."day" IS DISTINCT FROM OLD."day"
     OR NEW."log_id" IS DISTINCT FROM OLD."log_id" OR NEW."note" IS DISTINCT FROM OLD."note"
     OR NEW."requested_by_id" IS DISTINCT FROM OLD."requested_by_id" OR NEW."requested_at" IS DISTINCT FROM OLD."requested_at"
     OR (OLD."answer" IS NOT NULL AND (NEW."answer" IS DISTINCT FROM OLD."answer" OR NEW."answered_at" IS DISTINCT FROM OLD."answered_at"))
     OR (OLD."status" = 'answered' AND NEW."status" = 'open') THEN
    RAISE EXCEPTION 'A proof request only moves forward: answered once, closed once (proof_request_final)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "sales_proof_requests_protect" BEFORE UPDATE ON "sales_proof_requests" FOR EACH ROW EXECUTE FUNCTION "protect_sales_proof_request"();
CREATE TRIGGER "sales_proof_requests_no_delete" BEFORE DELETE ON "sales_proof_requests" FOR EACH ROW EXECUTE FUNCTION "prevent_sales_record_delete"();
