-- Module 15.5, leads and deals when a salesperson leaves, and archiving inactive leads (plan section 20): "Leads belong to
-- Aceva, not to the salesperson. When someone leaves, their leads and deals move to the sales manager on their last
-- working day (Module 3)." and "Leads with no activity for 12 months are archived and their contact details removed."
-- ADDITIVE ONLY: two new tables with their indexes, constraints and triggers. No existing table, column, constraint or
-- trigger is changed (archiving uses the existing sales_leads.archived_at).

-- CreateTable
CREATE TABLE "sales_lead_archives" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lead_id" UUID NOT NULL,
    "archived_at" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "inactive_months" INTEGER NOT NULL,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL,
    "cleared_fields" TEXT[],
    "archived_by" UUID,
    "job" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_lead_archives_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_reassignment_issues" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "event_id" UUID,
    "reason" TEXT NOT NULL,
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolved_at" TIMESTAMPTZ(3),
    "resolved_to_id" UUID,

    CONSTRAINT "sales_reassignment_issues_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_lead_archives_lead_id_archived_at_idx" ON "sales_lead_archives"("lead_id", "archived_at");

-- CreateIndex
CREATE INDEX "sales_reassignment_issues_employee_id_idx" ON "sales_reassignment_issues"("employee_id");

-- AddForeignKey
ALTER TABLE "sales_lead_archives" ADD CONSTRAINT "sales_lead_archives_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "sales_leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_lead_archives" ADD CONSTRAINT "sales_lead_archives_archived_by_fkey" FOREIGN KEY ("archived_by") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_reassignment_issues" ADD CONSTRAINT "sales_reassignment_issues_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_reassignment_issues" ADD CONSTRAINT "sales_reassignment_issues_resolved_to_id_fkey" FOREIGN KEY ("resolved_to_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ======================================================================================================================
-- Hand-written rules (Prisma cannot express them).

-- An archive record names its reason (M15.5: no activity), the period in force, the details removed, and who archived
-- it: a person, or the nightly job (then the job run is named). It is a record: insert-only, like the audit log.
ALTER TABLE "sales_lead_archives" ADD CONSTRAINT "sales_lead_archives_reason" CHECK ("reason" IN ('inactive'));
ALTER TABLE "sales_lead_archives" ADD CONSTRAINT "sales_lead_archives_months" CHECK ("inactive_months" BETWEEN 1 AND 120);
ALTER TABLE "sales_lead_archives" ADD CONSTRAINT "sales_lead_archives_cleared_fields" CHECK ("cleared_fields" IS NOT NULL);
ALTER TABLE "sales_lead_archives" ADD CONSTRAINT "sales_lead_archives_by" CHECK ("archived_by" IS NOT NULL OR "job" IS NOT NULL);
CREATE TRIGGER "sales_lead_archives_insert_only" BEFORE UPDATE OR DELETE ON "sales_lead_archives"
  FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "sales_lead_archives_no_truncate" BEFORE TRUNCATE ON "sales_lead_archives"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

-- A leaver whose leads could not be moved: one open case per leaver at a time; it is only ever marked resolved (once),
-- nothing else changes, and it is never deleted.
ALTER TABLE "sales_reassignment_issues" ADD CONSTRAINT "sales_reassignment_issues_reason" CHECK ("reason" IN ('no_recipient'));
ALTER TABLE "sales_reassignment_issues" ADD CONSTRAINT "sales_reassignment_issues_resolved_to" CHECK ("resolved_to_id" IS NULL OR "resolved_at" IS NOT NULL);
CREATE UNIQUE INDEX "sales_reassignment_issues_open_key" ON "sales_reassignment_issues"("employee_id") WHERE "resolved_at" IS NULL;
CREATE FUNCTION "protect_sales_reassignment_issue"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."employee_id" IS DISTINCT FROM OLD."employee_id" OR NEW."event_id" IS DISTINCT FROM OLD."event_id"
     OR NEW."reason" IS DISTINCT FROM OLD."reason" OR NEW."details" IS DISTINCT FROM OLD."details"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" OR OLD."resolved_at" IS NOT NULL THEN
    RAISE EXCEPTION 'A reassignment issue is only ever marked resolved, once (reassignment_issue_final)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "sales_reassignment_issues_protect" BEFORE UPDATE ON "sales_reassignment_issues" FOR EACH ROW EXECUTE FUNCTION "protect_sales_reassignment_issue"();
CREATE TRIGGER "sales_reassignment_issues_no_delete" BEFORE DELETE ON "sales_reassignment_issues" FOR EACH ROW EXECUTE FUNCTION "prevent_sales_record_delete"();
