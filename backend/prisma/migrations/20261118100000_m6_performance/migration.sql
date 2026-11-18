-- Module 6: performance and results (plan section 10): score weight versions, monthly scorecards with their task
-- snapshot and remarks, rating disputes. Generated with prisma migrate diff; the hand-written part follows.

-- CreateEnum
CREATE TYPE "scorecard_kind" AS ENUM ('standard', 'sales');

-- CreateEnum
CREATE TYPE "scorecard_status" AS ENUM ('draft', 'released', 'acknowledged');

-- CreateEnum
CREATE TYPE "scorecard_band" AS ENUM ('excellent', 'good', 'needs_improvement', 'poor');

-- CreateEnum
CREATE TYPE "scorecard_task_status" AS ENUM ('approved', 'submitted', 'open', 'cancelled');

-- CreateEnum
CREATE TYPE "scorecard_comment_kind" AS ENUM ('reviewer_remark', 'employee_comment');

-- CreateEnum
CREATE TYPE "dispute_status" AS ENUM ('open', 'upheld', 'changed');

-- CreateTable
CREATE TABLE "score_weight_versions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" "scorecard_kind" NOT NULL,
    "department_id" UUID,
    "version_no" INTEGER NOT NULL,
    "weights" JSONB NOT NULL,
    "note" TEXT,
    "effective_from" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,

    CONSTRAINT "score_weight_versions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scorecards" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "employee_id" UUID NOT NULL,
    "month" VARCHAR(7) NOT NULL,
    "kind" "scorecard_kind" NOT NULL,
    "weights_version_id" UUID NOT NULL,
    "metrics" JSONB NOT NULL,
    "sales_detail" JSONB,
    "unmeasured" JSONB NOT NULL DEFAULT '[]',
    "score" DECIMAL(4,1),
    "band" "scorecard_band",
    "task_count" INTEGER NOT NULL,
    "small_sample" BOOLEAN NOT NULL,
    "status" "scorecard_status" NOT NULL DEFAULT 'draft',
    "reviewer_id" UUID,
    "released_at" TIMESTAMPTZ(3),
    "released_by" UUID,
    "acknowledged_at" TIMESTAMPTZ(3),
    "recompute_count" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scorecards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scorecard_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scorecard_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "position" INTEGER NOT NULL,
    "number" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "size" "task_size" NOT NULL,
    "points" INTEGER NOT NULL,
    "rating" INTEGER,
    "on_time" BOOLEAN NOT NULL,
    "reworked" BOOLEAN NOT NULL,
    "extensions" INTEGER NOT NULL,
    "status" "scorecard_task_status" NOT NULL,
    "counted" BOOLEAN NOT NULL,
    "deadline" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "scorecard_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "scorecard_comments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scorecard_id" UUID NOT NULL,
    "kind" "scorecard_comment_kind" NOT NULL,
    "author_id" UUID NOT NULL,
    "body" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "scorecard_comments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "rating_disputes" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "scorecard_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "reason" TEXT NOT NULL,
    "rating_at_raise" INTEGER NOT NULL,
    "decider_id" UUID NOT NULL,
    "status" "dispute_status" NOT NULL DEFAULT 'open',
    "decided_by" UUID,
    "decision" TEXT,
    "new_rating" INTEGER,
    "decided_at" TIMESTAMPTZ(3),
    "score_before" DECIMAL(4,1),
    "score_after" DECIMAL(4,1),
    "metrics_before" JSONB,
    "metrics_after" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "rating_disputes_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "score_weight_versions_kind_department_id_effective_from_idx" ON "score_weight_versions"("kind", "department_id", "effective_from");

-- CreateIndex
CREATE INDEX "scorecards_reviewer_id_status_idx" ON "scorecards"("reviewer_id", "status");

-- CreateIndex
CREATE INDEX "scorecards_status_month_idx" ON "scorecards"("status", "month");

-- CreateIndex
CREATE INDEX "scorecards_month_idx" ON "scorecards"("month");

-- CreateIndex
CREATE UNIQUE INDEX "scorecards_employee_id_month_key" ON "scorecards"("employee_id", "month");

-- CreateIndex
CREATE INDEX "scorecard_tasks_task_id_idx" ON "scorecard_tasks"("task_id");

-- CreateIndex
CREATE UNIQUE INDEX "scorecard_tasks_scorecard_id_task_id_key" ON "scorecard_tasks"("scorecard_id", "task_id");

-- CreateIndex
CREATE INDEX "scorecard_comments_scorecard_id_created_at_idx" ON "scorecard_comments"("scorecard_id", "created_at");

-- CreateIndex
CREATE INDEX "rating_disputes_scorecard_id_status_idx" ON "rating_disputes"("scorecard_id", "status");

-- CreateIndex
CREATE INDEX "rating_disputes_decider_id_status_created_at_idx" ON "rating_disputes"("decider_id", "status", "created_at");

-- CreateIndex
CREATE INDEX "rating_disputes_employee_id_created_at_idx" ON "rating_disputes"("employee_id", "created_at");

-- CreateIndex
CREATE INDEX "rating_disputes_status_created_at_idx" ON "rating_disputes"("status", "created_at");

-- AddForeignKey
ALTER TABLE "score_weight_versions" ADD CONSTRAINT "score_weight_versions_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "score_weight_versions" ADD CONSTRAINT "score_weight_versions_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_reviewer_id_fkey" FOREIGN KEY ("reviewer_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_released_by_fkey" FOREIGN KEY ("released_by") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_weights_version_id_fkey" FOREIGN KEY ("weights_version_id") REFERENCES "score_weight_versions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecard_tasks" ADD CONSTRAINT "scorecard_tasks_scorecard_id_fkey" FOREIGN KEY ("scorecard_id") REFERENCES "scorecards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecard_tasks" ADD CONSTRAINT "scorecard_tasks_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecard_comments" ADD CONSTRAINT "scorecard_comments_scorecard_id_fkey" FOREIGN KEY ("scorecard_id") REFERENCES "scorecards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "scorecard_comments" ADD CONSTRAINT "scorecard_comments_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rating_disputes" ADD CONSTRAINT "rating_disputes_scorecard_id_fkey" FOREIGN KEY ("scorecard_id") REFERENCES "scorecards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rating_disputes" ADD CONSTRAINT "rating_disputes_scorecard_id_task_id_fkey" FOREIGN KEY ("scorecard_id", "task_id") REFERENCES "scorecard_tasks"("scorecard_id", "task_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rating_disputes" ADD CONSTRAINT "rating_disputes_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rating_disputes" ADD CONSTRAINT "rating_disputes_decider_id_fkey" FOREIGN KEY ("decider_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "rating_disputes" ADD CONSTRAINT "rating_disputes_decided_by_fkey" FOREIGN KEY ("decided_by") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ===========================================================================
-- Hand-written part (Module 6): rules Prisma cannot express.
--
-- THE RULE FOR SCORECARD NUMBERS (plan section 10: "nobody can change the numbers"):
--   * scorecards.metrics / score / band, the weights version, the task count, the sales figures, the unmeasured list, the
--     reviewer and the person and month are frozen by the trigger "scorecards_protect".
--   * The ONE exception is the recompute after a dispute decision that CHANGED a rating. It is allowed only in an UPDATE
--     that raises scorecards.recompute_count by exactly 1, and only while the scorecard has more "changed" disputes
--     (rating_disputes.status = 'changed') than recomputes. So every change of the numbers is paired with a decided
--     dispute (which records the old and new rating, who decided, why, and the score before and after), and a dispute can
--     be applied once. Nobody, including the application, can change the numbers any other way.
--   * The list of tasks a scorecard was made from (scorecard_tasks) is insert-only: a dispute never edits it, the changed
--     rating lives on the dispute.
-- ===========================================================================

-- ---- Score weights: whole percentages that add up to exactly 100 --------------------------------------------------

CREATE FUNCTION "score_weights_valid"("p_kind" "scorecard_kind", "p_weights" jsonb) RETURNS boolean
LANGUAGE sql IMMUTABLE AS $$
  SELECT jsonb_typeof("p_weights") = 'object'
    AND "p_weights" ?& (CASE WHEN "p_kind" = 'standard'
                             THEN ARRAY['quality', 'onTime', 'completion', 'rework', 'attendance']
                             ELSE ARRAY['activity', 'meetings', 'won', 'dataQuality', 'attendance'] END)
    AND (SELECT count(*) FROM jsonb_object_keys("p_weights")) = 5
    AND (SELECT COALESCE(bool_and(
                CASE WHEN jsonb_typeof(e.value) = 'number'
                     THEN (e.value #>> '{}')::numeric = trunc((e.value #>> '{}')::numeric)
                          AND (e.value #>> '{}')::numeric BETWEEN 0 AND 100
                     ELSE false END), false)
           FROM jsonb_each("p_weights") AS e)
    AND (SELECT COALESCE(sum(CASE WHEN jsonb_typeof(e.value) = 'number' THEN (e.value #>> '{}')::numeric ELSE 0 END), 0)
           FROM jsonb_each("p_weights") AS e) = 100
$$;

ALTER TABLE "score_weight_versions" ADD CONSTRAINT "score_weight_versions_weights" CHECK ("version_no" >= 1 AND "score_weights_valid"("kind", "weights"));

-- One version number per kind and department (the company-wide set has no department).
CREATE UNIQUE INDEX "score_weight_versions_company_version" ON "score_weight_versions" ("kind", "version_no") WHERE "department_id" IS NULL;
CREATE UNIQUE INDEX "score_weight_versions_department_version" ON "score_weight_versions" ("kind", "department_id", "version_no") WHERE "department_id" IS NOT NULL;

-- ---- CHECK constraints --------------------------------------------------------------------------------------------

ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_month_format" CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$');
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_numbers" CHECK (
  "task_count" >= 0 AND "recompute_count" >= 0
  AND ("score" IS NULL OR ("score" >= 0 AND "score" <= 100))
  AND jsonb_typeof("metrics") = 'object' AND jsonb_typeof("unmeasured") = 'array'
);
-- The band always matches the score (85 / 70 / 50), and there is no band without a score (and no score without a band).
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_band_matches_score" CHECK (
  ("score" IS NULL AND "band" IS NULL)
  OR ("score" IS NOT NULL AND "band" IS NOT NULL AND (
       ("score" >= 85 AND "band" = 'excellent')
    OR ("score" >= 70 AND "score" < 85 AND "band" = 'good')
    OR ("score" >= 50 AND "score" < 70 AND "band" = 'needs_improvement')
    OR ("score" < 50 AND "band" = 'poor')))
);
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_status_dates" CHECK (
  ("status" = 'draft' AND "released_at" IS NULL AND "acknowledged_at" IS NULL)
  OR ("status" = 'released' AND "released_at" IS NOT NULL AND "acknowledged_at" IS NULL)
  OR ("status" = 'acknowledged' AND "released_at" IS NOT NULL AND "acknowledged_at" IS NOT NULL)
);
-- Nobody reviews or releases their own scorecard.
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_not_own_review" CHECK (
  ("reviewer_id" IS NULL OR "reviewer_id" <> "employee_id") AND ("released_by" IS NULL OR "released_by" <> "employee_id")
);
-- Only a scorecard that has no reviewer is released by the system (released_by null).
ALTER TABLE "scorecards" ADD CONSTRAINT "scorecards_system_release" CHECK ("released_at" IS NULL OR "released_by" IS NOT NULL OR "reviewer_id" IS NULL);

ALTER TABLE "scorecard_tasks" ADD CONSTRAINT "scorecard_tasks_values" CHECK (
  "position" >= 0 AND "points" >= 0 AND "extensions" >= 0 AND length(btrim("number")) > 0
  AND ("rating" IS NULL OR "rating" BETWEEN 1 AND 5)
);

ALTER TABLE "scorecard_comments" ADD CONSTRAINT "scorecard_comments_body" CHECK (length(btrim("body")) > 0 AND length("body") <= 2000);

-- A dispute: a reason, a rating that was given, a decider who is not the employee; once decided it says who and why,
-- and a changed rating is a different rating from 1 to 5.
ALTER TABLE "rating_disputes" ADD CONSTRAINT "rating_disputes_values" CHECK (
  length(btrim("reason")) > 0 AND "rating_at_raise" BETWEEN 1 AND 5 AND "decider_id" <> "employee_id"
  AND ("decided_by" IS NULL OR "decided_by" <> "employee_id")
);
ALTER TABLE "rating_disputes" ADD CONSTRAINT "rating_disputes_decision" CHECK (
  ("status" = 'open' AND "decided_by" IS NULL AND "decided_at" IS NULL AND "decision" IS NULL AND "new_rating" IS NULL
     AND "score_before" IS NULL AND "score_after" IS NULL AND "metrics_before" IS NULL AND "metrics_after" IS NULL)
  OR ("status" = 'upheld' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL AND length(btrim(coalesce("decision", ''))) > 0
     AND "new_rating" IS NULL)
  OR ("status" = 'changed' AND "decided_by" IS NOT NULL AND "decided_at" IS NOT NULL AND length(btrim(coalesce("decision", ''))) > 0
     AND "new_rating" IS NOT NULL AND "new_rating" BETWEEN 1 AND 5 AND "new_rating" <> "rating_at_raise")
);

-- One OPEN dispute per task of a scorecard.
CREATE UNIQUE INDEX "rating_disputes_one_open_per_task" ON "rating_disputes" ("scorecard_id", "task_id") WHERE "status" = 'open';

-- ---- Insert-only tables (plan section 22), using prevent_modification() from the first migration -----------------

CREATE TRIGGER "score_weight_versions_insert_only" BEFORE UPDATE OR DELETE ON "score_weight_versions"
  FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "score_weight_versions_no_truncate" BEFORE TRUNCATE ON "score_weight_versions"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

CREATE TRIGGER "scorecard_tasks_insert_only" BEFORE UPDATE OR DELETE ON "scorecard_tasks"
  FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "scorecard_tasks_no_truncate" BEFORE TRUNCATE ON "scorecard_tasks"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

CREATE TRIGGER "scorecard_comments_insert_only" BEFORE UPDATE OR DELETE ON "scorecard_comments"
  FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "scorecard_comments_no_truncate" BEFORE TRUNCATE ON "scorecard_comments"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

-- ---- Scorecards: the numbers never change, except by the recompute after a dispute decision -----------------------

CREATE FUNCTION "protect_scorecard"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  changed_disputes integer;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Scorecards are never deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- Who and which month, the weights it was made with, the tasks it counted, the sales figures and the reviewer: for ever.
  IF NEW."employee_id" IS DISTINCT FROM OLD."employee_id"
     OR NEW."month" IS DISTINCT FROM OLD."month"
     OR NEW."kind" IS DISTINCT FROM OLD."kind"
     OR NEW."weights_version_id" IS DISTINCT FROM OLD."weights_version_id"
     OR NEW."task_count" IS DISTINCT FROM OLD."task_count"
     OR NEW."small_sample" IS DISTINCT FROM OLD."small_sample"
     OR NEW."sales_detail" IS DISTINCT FROM OLD."sales_detail"
     OR NEW."unmeasured" IS DISTINCT FROM OLD."unmeasured"
     OR NEW."reviewer_id" IS DISTINCT FROM OLD."reviewer_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'A scorecard keeps its person, month, weights version, task count, sales figures and reviewer'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- The numbers: only together with one more recompute, and only while a decided "changed" dispute is still to be applied.
  IF NEW."recompute_count" IS DISTINCT FROM OLD."recompute_count" THEN
    SELECT count(*) INTO changed_disputes FROM "rating_disputes" WHERE "scorecard_id" = OLD."id" AND "status" = 'changed';
    IF NEW."recompute_count" <> OLD."recompute_count" + 1 OR NEW."recompute_count" > changed_disputes THEN
      RAISE EXCEPTION 'A scorecard is recomputed only after a dispute decision that changed a rating, once per decision'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  ELSIF NEW."metrics" IS DISTINCT FROM OLD."metrics" OR NEW."score" IS DISTINCT FROM OLD."score" OR NEW."band" IS DISTINCT FROM OLD."band" THEN
    RAISE EXCEPTION 'The numbers of a scorecard cannot be changed (only the recompute after a dispute decision may)'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;

  -- The status only moves forward: draft, released, acknowledged.
  IF NEW."status" IS DISTINCT FROM OLD."status"
     AND NOT ((OLD."status" = 'draft' AND NEW."status" = 'released') OR (OLD."status" = 'released' AND NEW."status" = 'acknowledged')) THEN
    RAISE EXCEPTION 'A scorecard moves from draft to released to acknowledged, never back'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."released_at" IS NOT NULL
     AND (NEW."released_at" IS DISTINCT FROM OLD."released_at" OR NEW."released_by" IS DISTINCT FROM OLD."released_by") THEN
    RAISE EXCEPTION 'The release of a scorecard cannot be changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."acknowledged_at" IS NOT NULL AND NEW."acknowledged_at" IS DISTINCT FROM OLD."acknowledged_at" THEN
    RAISE EXCEPTION 'The acknowledgement of a scorecard cannot be changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "scorecards_protect" BEFORE UPDATE OR DELETE ON "scorecards"
  FOR EACH ROW EXECUTE FUNCTION "protect_scorecard"();
CREATE TRIGGER "scorecards_no_truncate" BEFORE TRUNCATE ON "scorecards"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

-- ---- Rating disputes: only the person the scorecard is about, only after release; a decision is final ----------------

CREATE FUNCTION "check_rating_dispute_insert"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  card_employee uuid;
  card_status "scorecard_status";
BEGIN
  SELECT "employee_id", "status" INTO card_employee, card_status FROM "scorecards" WHERE "id" = NEW."scorecard_id";
  IF card_employee IS DISTINCT FROM NEW."employee_id" THEN
    RAISE EXCEPTION 'A rating can only be disputed by the person the scorecard is about'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF card_status = 'draft' THEN
    RAISE EXCEPTION 'A rating can only be disputed after the scorecard is released'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."status" <> 'open' THEN
    RAISE EXCEPTION 'A new dispute starts open'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "rating_disputes_check_insert" BEFORE INSERT ON "rating_disputes"
  FOR EACH ROW EXECUTE FUNCTION "check_rating_dispute_insert"();

CREATE FUNCTION "protect_rating_dispute"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Rating disputes are never deleted'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."status" <> 'open' THEN
    RAISE EXCEPTION 'A decided rating dispute cannot be changed'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."scorecard_id" IS DISTINCT FROM OLD."scorecard_id"
     OR NEW."task_id" IS DISTINCT FROM OLD."task_id"
     OR NEW."employee_id" IS DISTINCT FROM OLD."employee_id"
     OR NEW."reason" IS DISTINCT FROM OLD."reason"
     OR NEW."rating_at_raise" IS DISTINCT FROM OLD."rating_at_raise"
     OR NEW."decider_id" IS DISTINCT FROM OLD."decider_id"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'A rating dispute cannot be edited, only decided'
      USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "rating_disputes_protect" BEFORE UPDATE OR DELETE ON "rating_disputes"
  FOR EACH ROW EXECUTE FUNCTION "protect_rating_dispute"();
CREATE TRIGGER "rating_disputes_no_truncate" BEFORE TRUNCATE ON "rating_disputes"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

-- ---- The starting weights of plan section 10 and section 20 (the Director saves new versions in Settings) ----------

INSERT INTO "score_weight_versions" ("kind", "department_id", "version_no", "weights", "note") VALUES
  ('standard', NULL, 1, '{"quality": 35, "onTime": 25, "completion": 20, "rework": 10, "attendance": 10}', 'Starting weights (plan section 10)'),
  ('sales', NULL, 1, '{"activity": 20, "meetings": 25, "won": 30, "dataQuality": 10, "attendance": 15}', 'Starting sales weights (plan section 20)');
