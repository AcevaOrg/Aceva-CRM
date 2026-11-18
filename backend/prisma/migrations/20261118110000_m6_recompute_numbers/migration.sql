-- ===========================================================================
-- Module 6, hardening of the scorecard recompute rule.
--
-- Until now the trigger "scorecards_protect" let the numbers of a scorecard (metrics, score, band) take ANY value when
-- recompute_count rose by exactly 1 while a "changed" dispute was still to be applied. The decided dispute already stores
-- the result it came to (rating_disputes.score_after and metrics_after), so the database can ask for more: the new
-- numbers must be exactly a result that a "changed" dispute of this scorecard recorded. A service bug, or anyone who
-- writes to the table by hand, can no longer put other numbers in place of a dispute's result. A recompute that moves
-- nothing (the new rating gives the same score and metrics) is still allowed: the numbers then equal the recorded result.
-- (Which of the scorecard's changed disputes is the one still to be applied is not looked at: the counter rule above pairs
-- every recompute with one decision, and this only ties the numbers to what decisions recorded. The decision times come
-- from the application clock, so they are not trusted to say which is newest.)
--
-- Everything else in the function is exactly as in 20261118100000_m6_performance. (CREATE OR REPLACE keeps the trigger
-- "scorecards_protect", which already points at this function.)
-- ===========================================================================

CREATE OR REPLACE FUNCTION "protect_scorecard"() RETURNS trigger
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

  -- The numbers: only together with one more recompute, only while a decided "changed" dispute is still to be applied, and
  -- only to a result a decision recorded.
  IF NEW."recompute_count" IS DISTINCT FROM OLD."recompute_count" THEN
    SELECT count(*) INTO changed_disputes FROM "rating_disputes" WHERE "scorecard_id" = OLD."id" AND "status" = 'changed';
    IF NEW."recompute_count" <> OLD."recompute_count" + 1 OR NEW."recompute_count" > changed_disputes THEN
      RAISE EXCEPTION 'A scorecard is recomputed only after a dispute decision that changed a rating, once per decision'
        USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    -- The numbers must be a result that a decided "changed" dispute of this scorecard recorded (score_after, metrics_after).
    IF NOT EXISTS (
      SELECT 1
      FROM "rating_disputes" d
      WHERE d."scorecard_id" = OLD."id"
        AND d."status" = 'changed'
        AND d."score_after" IS NOT DISTINCT FROM NEW."score"
        AND d."metrics_after" IS NOT DISTINCT FROM NEW."metrics"
    ) THEN
      RAISE EXCEPTION 'The recomputed numbers of a scorecard must be the result a dispute decision recorded'
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
