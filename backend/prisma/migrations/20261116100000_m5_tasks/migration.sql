-- CreateEnum
CREATE TYPE "task_size" AS ENUM ('XS', 'S', 'M', 'L', 'XL');

-- CreateEnum
CREATE TYPE "task_status" AS ENUM ('assigned', 'in_progress', 'submitted', 'under_review', 'approved', 'rework', 'on_hold', 'cancelled');

-- CreateEnum
CREATE TYPE "task_priority" AS ENUM ('low', 'medium', 'high', 'urgent');

-- CreateEnum
CREATE TYPE "extension_status" AS ENUM ('pending', 'approved', 'rejected');

-- CreateEnum
CREATE TYPE "review_decision" AS ENUM ('approved', 'rework');

-- CreateEnum
CREATE TYPE "repeat_unit" AS ENUM ('week', 'month');

-- CreateEnum
CREATE TYPE "task_history_kind" AS ENUM ('created', 'status', 'deadline_changed', 'extension_requested', 'extension_approved', 'extension_rejected', 'reassigned', 'transferred', 'edited', 'repeat_stopped');

-- CreateTable
CREATE TABLE "task_size_settings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "size" "task_size" NOT NULL,
    "meaning" TEXT NOT NULL,
    "hours" DECIMAL(6,2) NOT NULL,
    "hours_label" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "days" INTEGER,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "task_size_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_size_setting_changes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "size" "task_size" NOT NULL,
    "before" JSONB NOT NULL,
    "after" JSONB NOT NULL,
    "reason" TEXT NOT NULL,
    "changed_by" UUID NOT NULL,
    "changed_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_size_setting_changes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "projects" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "client" TEXT,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "projects_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "holidays" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "date" DATE NOT NULL,
    "name" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "holidays_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "assignee_id" UUID NOT NULL,
    "assigned_by_id" UUID NOT NULL,
    "project_id" UUID,
    "goal_id" TEXT,
    "priority" "task_priority" NOT NULL DEFAULT 'medium',
    "size" "task_size" NOT NULL,
    "points" INTEGER NOT NULL,
    "estimated_hours" DECIMAL(6,2) NOT NULL,
    "start_date" TIMESTAMPTZ(3) NOT NULL,
    "deadline" TIMESTAMPTZ(3) NOT NULL,
    "original_deadline" TIMESTAMPTZ(3) NOT NULL,
    "status" "task_status" NOT NULL DEFAULT 'assigned',
    "personal" BOOLEAN NOT NULL DEFAULT false,
    "started_at" TIMESTAMPTZ(3),
    "submitted_at" TIMESTAMPTZ(3),
    "closed_at" TIMESTAMPTZ(3),
    "extensions_count" INTEGER NOT NULL DEFAULT 0,
    "rework_count" INTEGER NOT NULL DEFAULT 0,
    "repeat_rule_id" UUID,
    "occurrence_on" DATE,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_checklist_items" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "text" TEXT NOT NULL,
    "done" BOOLEAN NOT NULL DEFAULT false,
    "done_at" TIMESTAMPTZ(3),
    "done_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "task_checklist_items_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_comment_mentions" (
    "comment_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_comment_mentions_pkey" PRIMARY KEY ("comment_id","employee_id")
);

-- CreateTable
CREATE TABLE "task_attachments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL,
    "comment_id" UUID,
    "uploaded_by_id" UUID NOT NULL,
    "storage_key" TEXT NOT NULL,
    "original_filename" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "task_attachments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_extensions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL,
    "requested_by_id" UUID NOT NULL,
    "current_deadline" TIMESTAMPTZ(3) NOT NULL,
    "requested_deadline" TIMESTAMPTZ(3) NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "extension_status" NOT NULL DEFAULT 'pending',
    "late" BOOLEAN NOT NULL DEFAULT false,
    "decided_by_id" UUID,
    "decided_at" TIMESTAMPTZ(3),
    "decision_reason" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_extensions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_reviews" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL,
    "reviewer_id" UUID NOT NULL,
    "decision" "review_decision" NOT NULL,
    "rating" INTEGER,
    "comment" TEXT,
    "reason" TEXT,
    "submitted_at" TIMESTAMPTZ(3),
    "deadline_at_review" TIMESTAMPTZ(3) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "task_id" UUID NOT NULL,
    "kind" "task_history_kind" NOT NULL DEFAULT 'status',
    "from_status" "task_status",
    "to_status" "task_status" NOT NULL,
    "by_id" UUID,
    "reason" TEXT,
    "details" JSONB,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "task_history_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "task_repeat_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "every" "repeat_unit" NOT NULL,
    "on" INTEGER NOT NULL,
    "until" DATE,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "stopped_at" TIMESTAMPTZ(3),
    "stopped_by" UUID,
    "last_occurrence_on" DATE,
    "title" TEXT NOT NULL,
    "description" TEXT NOT NULL DEFAULT '',
    "assignee_id" UUID NOT NULL,
    "assigned_by_id" UUID NOT NULL,
    "project_id" UUID,
    "priority" "task_priority" NOT NULL,
    "size" "task_size" NOT NULL,
    "estimated_hours" DECIMAL(6,2) NOT NULL,
    "start_time" TEXT NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "checklist" JSONB NOT NULL DEFAULT '[]',
    "personal" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "task_repeat_rules_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "task_size_settings_size_key" ON "task_size_settings"("size");

-- CreateIndex
CREATE INDEX "task_size_setting_changes_changed_at_idx" ON "task_size_setting_changes"("changed_at");

-- CreateIndex
CREATE INDEX "task_size_setting_changes_size_changed_at_idx" ON "task_size_setting_changes"("size", "changed_at");

-- CreateIndex
CREATE UNIQUE INDEX "projects_code_key" ON "projects"("code");

-- CreateIndex
CREATE INDEX "holidays_date_idx" ON "holidays"("date");

-- One holiday per date among the active rows.
CREATE UNIQUE INDEX "holidays_active_date" ON "holidays" ("date") WHERE "archived_at" IS NULL;

-- CreateIndex
CREATE UNIQUE INDEX "tasks_number_key" ON "tasks"("number");

-- CreateIndex
CREATE INDEX "tasks_assignee_id_status_idx" ON "tasks"("assignee_id", "status");

-- CreateIndex
CREATE INDEX "tasks_assigned_by_id_status_idx" ON "tasks"("assigned_by_id", "status");

-- CreateIndex
CREATE INDEX "tasks_status_deadline_idx" ON "tasks"("status", "deadline");

-- CreateIndex
CREATE INDEX "tasks_deadline_idx" ON "tasks"("deadline");

-- CreateIndex
CREATE INDEX "tasks_project_id_idx" ON "tasks"("project_id");

-- CreateIndex
CREATE UNIQUE INDEX "tasks_repeat_rule_id_occurrence_on_key" ON "tasks"("repeat_rule_id", "occurrence_on");

-- CreateIndex
CREATE UNIQUE INDEX "task_checklist_items_task_id_position_key" ON "task_checklist_items"("task_id", "position");

-- CreateIndex
CREATE INDEX "task_comments_task_id_created_at_idx" ON "task_comments"("task_id", "created_at");

-- CreateIndex
CREATE INDEX "task_comment_mentions_employee_id_idx" ON "task_comment_mentions"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "task_attachments_storage_key_key" ON "task_attachments"("storage_key");

-- CreateIndex
CREATE INDEX "task_attachments_task_id_idx" ON "task_attachments"("task_id");

-- CreateIndex
CREATE INDEX "task_attachments_comment_id_idx" ON "task_attachments"("comment_id");

-- CreateIndex
CREATE INDEX "task_extensions_task_id_created_at_idx" ON "task_extensions"("task_id", "created_at");

-- CreateIndex
CREATE INDEX "task_extensions_status_created_at_idx" ON "task_extensions"("status", "created_at");

-- CreateIndex
CREATE INDEX "task_reviews_task_id_created_at_idx" ON "task_reviews"("task_id", "created_at");

-- CreateIndex
CREATE INDEX "task_reviews_reviewer_id_created_at_idx" ON "task_reviews"("reviewer_id", "created_at");

-- CreateIndex
CREATE INDEX "task_history_task_id_at_idx" ON "task_history"("task_id", "at");

-- CreateIndex
CREATE INDEX "task_history_by_id_at_idx" ON "task_history"("by_id", "at");

-- CreateIndex
CREATE INDEX "task_history_at_idx" ON "task_history"("at");

-- CreateIndex
CREATE INDEX "task_repeat_rules_active_every_idx" ON "task_repeat_rules"("active", "every");

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_id_fkey" FOREIGN KEY ("assignee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assigned_by_id_fkey" FOREIGN KEY ("assigned_by_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_repeat_rule_id_fkey" FOREIGN KEY ("repeat_rule_id") REFERENCES "task_repeat_rules"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comment_mentions" ADD CONSTRAINT "task_comment_mentions_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "task_comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_comment_mentions" ADD CONSTRAINT "task_comment_mentions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_comment_id_fkey" FOREIGN KEY ("comment_id") REFERENCES "task_comments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_uploaded_by_id_fkey" FOREIGN KEY ("uploaded_by_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_extensions" ADD CONSTRAINT "task_extensions_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_extensions" ADD CONSTRAINT "task_extensions_requested_by_id_fkey" FOREIGN KEY ("requested_by_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_extensions" ADD CONSTRAINT "task_extensions_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_reviews" ADD CONSTRAINT "task_reviews_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_reviews" ADD CONSTRAINT "task_reviews_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_history" ADD CONSTRAINT "task_history_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_history" ADD CONSTRAINT "task_history_by_id_fkey" FOREIGN KEY ("by_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "task_repeat_rules" ADD CONSTRAINT "task_repeat_rules_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ===========================================================================
-- Hand-written part (Module 5): rules Prisma cannot express.
-- ===========================================================================

-- ---- Task numbers: TSK-0001 for work tasks, TODO-0001 for personal to-dos (the service takes the next value) --------

CREATE SEQUENCE "task_number_seq" START 1;
CREATE SEQUENCE "todo_number_seq" START 1;

-- ---- CHECK constraints ----------------------------------------------------

ALTER TABLE "task_size_settings" ADD CONSTRAINT "task_size_settings_values" CHECK (
  "hours" > 0 AND "hours" <= 500 AND "points" >= 0 AND "points" <= 100
  AND length(btrim("meaning")) > 0 AND length(btrim("hours_label")) > 0
  AND (("size" = 'XL' AND "days" IS NULL) OR ("size" <> 'XL' AND "days" IS NOT NULL AND "days" >= 0 AND "days" <= 60))
);

ALTER TABLE "task_size_setting_changes" ADD CONSTRAINT "task_size_setting_changes_reason_present" CHECK (length(btrim("reason")) > 0);

ALTER TABLE "tasks" ADD CONSTRAINT "tasks_title_present" CHECK (length(btrim("title")) > 0);
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_number_format" CHECK (
  ("personal" AND "number" ~ '^TODO-[0-9]{4,}$') OR (NOT "personal" AND "number" ~ '^TSK-[0-9]{4,}$')
);
-- XL must be split before it is assigned (a personal to-do is never scored, so its size does not matter).
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_xl_not_assignable" CHECK ("size" <> 'XL' OR "personal");
-- A personal to-do belongs to the person who made it.
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_personal_own" CHECK (NOT "personal" OR "assignee_id" = "assigned_by_id");
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_numbers" CHECK (
  "points" >= 0 AND "estimated_hours" > 0 AND "estimated_hours" <= 500 AND "extensions_count" >= 0 AND "rework_count" >= 0
);
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_deadline_not_before_start" CHECK ("deadline" >= "start_date" AND "original_deadline" >= "start_date");
-- A task of a repeating series (the first one included) always knows which day it stands for.
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_occurrence_with_rule" CHECK (("repeat_rule_id" IS NULL AND "occurrence_on" IS NULL) OR ("repeat_rule_id" IS NOT NULL AND "occurrence_on" IS NOT NULL));

ALTER TABLE "task_checklist_items" ADD CONSTRAINT "task_checklist_items_text_present" CHECK (length(btrim("text")) > 0 AND "position" >= 0);
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_body" CHECK (length(btrim("body")) > 0 AND length("body") <= 5000);
ALTER TABLE "task_attachments" ADD CONSTRAINT "task_attachments_size" CHECK ("size_bytes" >= 0);

-- An extension asks for MORE time, is decided by someone else, and a rejection says why.
ALTER TABLE "task_extensions" ADD CONSTRAINT "task_extensions_reason_present" CHECK (length(btrim("reason")) > 0);
ALTER TABLE "task_extensions" ADD CONSTRAINT "task_extensions_later_deadline" CHECK ("requested_deadline" > "current_deadline");
ALTER TABLE "task_extensions" ADD CONSTRAINT "task_extensions_decision" CHECK (
  ("status" = 'pending' AND "decided_by_id" IS NULL AND "decided_at" IS NULL)
  OR ("status" <> 'pending' AND "decided_by_id" IS NOT NULL AND "decided_at" IS NOT NULL)
);
ALTER TABLE "task_extensions" ADD CONSTRAINT "task_extensions_rejection_reason" CHECK ("status" <> 'rejected' OR length(btrim(coalesce("decision_reason", ''))) > 0);
ALTER TABLE "task_extensions" ADD CONSTRAINT "task_extensions_not_own_decision" CHECK ("decided_by_id" IS NULL OR "decided_by_id" <> "requested_by_id");

-- Approve needs a rating 1 to 5; rework needs a reason (plan section 9).
ALTER TABLE "task_reviews" ADD CONSTRAINT "task_reviews_decision" CHECK (
  ("decision" = 'approved' AND "rating" IS NOT NULL AND "rating" BETWEEN 1 AND 5 AND "reason" IS NULL)
  OR ("decision" = 'rework' AND "rating" IS NULL AND length(btrim(coalesce("reason", ''))) > 0)
);

ALTER TABLE "task_repeat_rules" ADD CONSTRAINT "task_repeat_rules_day" CHECK (
  ("every" = 'week' AND "on" BETWEEN 1 AND 7) OR ("every" = 'month' AND "on" BETWEEN 1 AND 28)
);
ALTER TABLE "task_repeat_rules" ADD CONSTRAINT "task_repeat_rules_time" CHECK (
  "start_time" ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' AND "duration_minutes" > 0 AND "estimated_hours" > 0 AND length(btrim("title")) > 0
);

-- ---- Only one pending extension request per task ---------------------------

CREATE UNIQUE INDEX "task_extensions_one_pending_per_task" ON "task_extensions" ("task_id") WHERE "status" = 'pending';

-- ---- Index for the daily and reminder jobs: only open tasks are scanned ---------------------------------------------

CREATE INDEX "tasks_open_deadline_idx" ON "tasks" ("deadline") WHERE "status" NOT IN ('approved', 'cancelled');

-- ---- History is insert-only (plan section 22: "Audit and tracking tables allow adding rows only") ------------------
-- Uses the prevent_modification() function from the first migration. A later rating change adds a row (Module 6); a
-- correction to a task adds a history line. Nothing here is ever edited or removed.

CREATE TRIGGER "task_history_insert_only" BEFORE UPDATE OR DELETE ON "task_history"
  FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "task_history_no_truncate" BEFORE TRUNCATE ON "task_history"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

CREATE TRIGGER "task_reviews_insert_only" BEFORE UPDATE OR DELETE ON "task_reviews"
  FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "task_reviews_no_truncate" BEFORE TRUNCATE ON "task_reviews"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

CREATE TRIGGER "task_size_setting_changes_insert_only" BEFORE UPDATE OR DELETE ON "task_size_setting_changes"
  FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "task_size_setting_changes_no_truncate" BEFORE TRUNCATE ON "task_size_setting_changes"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

CREATE TRIGGER "task_comments_insert_only" BEFORE UPDATE OR DELETE ON "task_comments"
  FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "task_comments_no_truncate" BEFORE TRUNCATE ON "task_comments"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

CREATE TRIGGER "task_comment_mentions_insert_only" BEFORE UPDATE OR DELETE ON "task_comment_mentions"
  FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "task_comment_mentions_no_truncate" BEFORE TRUNCATE ON "task_comment_mentions"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

-- ---- A decided extension request never changes; a pending one only gets decided -------------------------------------

CREATE FUNCTION "protect_task_extension"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Extension requests are never deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'pending' THEN
    RAISE EXCEPTION 'A decided extension request cannot be changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."task_id" IS DISTINCT FROM OLD."task_id"
     OR NEW."requested_by_id" IS DISTINCT FROM OLD."requested_by_id"
     OR NEW."current_deadline" IS DISTINCT FROM OLD."current_deadline"
     OR NEW."requested_deadline" IS DISTINCT FROM OLD."requested_deadline"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."late" IS DISTINCT FROM OLD."late"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'An extension request cannot be edited, only decided'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "task_extensions_protect" BEFORE UPDATE OR DELETE ON "task_extensions"
  FOR EACH ROW EXECUTE FUNCTION "protect_task_extension"();

-- ---- A task keeps its number, kind, first deadline and points for ever ----------------------------------------------
-- (old tasks keep the points they were created with, even after the Director changes the size table)

CREATE FUNCTION "protect_task_record"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."number" IS DISTINCT FROM OLD."number"
     OR NEW."personal" IS DISTINCT FROM OLD."personal"
     OR NEW."original_deadline" IS DISTINCT FROM OLD."original_deadline"
     OR NEW."points" IS DISTINCT FROM OLD."points"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'A task keeps its number, kind, first deadline and points'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "tasks_protect" BEFORE UPDATE ON "tasks"
  FOR EACH ROW EXECUTE FUNCTION "protect_task_record"();

-- ---- The size table of plan section 9 (the Director can change it in Settings; changes are kept in task_size_setting_changes) --

INSERT INTO "task_size_settings" ("size", "meaning", "hours", "hours_label", "points", "days") VALUES
  ('XS', 'Very small, such as fixing a typo', 2, 'Up to 2 h', 1, 0),
  ('S', 'Small', 4, '2 to 4 h', 2, 1),
  ('M', 'Medium', 16, '1 to 2 days', 3, 3),
  ('L', 'Large', 40, '3 to 5 days', 5, 7),
  ('XL', 'Very large', 48, 'More than 1 week', 0, NULL);
