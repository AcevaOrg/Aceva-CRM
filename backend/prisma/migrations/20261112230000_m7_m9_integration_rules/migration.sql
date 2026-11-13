-- Modules 7 to 9, integration fixes (additive; no data is changed or removed).

-- 1. A rejected reversal draft must not block a new reversal of the same entry.
--    Before: reversal_of_id was fully unique, so one rejected reversal blocked the entry for ever.
--    Now: at most one reversal that is NOT rejected per entry (a partial unique index), plus a plain index for lookups.
DROP INDEX "journal_entries_reversal_of_id_key";

CREATE INDEX "journal_entries_reversal_of_id_idx" ON "journal_entries"("reversal_of_id");

CREATE UNIQUE INDEX "journal_entries_one_live_reversal" ON "journal_entries" ("reversal_of_id")
  WHERE "reversal_of_id" IS NOT NULL AND "status" <> 'rejected';

-- 2. A leave request can never be INSERTED into a month locked for payroll (the update and delete rules already existed;
--    a direct insert of an approved leave into a locked month was still possible). Same marker as the other lock rules.
CREATE FUNCTION "protect_leave_request_insert"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM attendance_periods p
             WHERE p.month BETWEEN to_char(NEW.from_date, 'YYYY-MM') AND to_char(NEW.to_date, 'YYYY-MM')) THEN
    RAISE EXCEPTION 'leave cannot be added to a locked month (period_locked)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

CREATE TRIGGER "leave_requests_protect_insert" BEFORE INSERT ON "leave_requests"
  FOR EACH ROW EXECUTE FUNCTION "protect_leave_request_insert"();

-- 3. Security review hardening: direct database writes must not get around the workflow rules.

-- 3a. A payroll month lock is never removed or changed (every lock rule depends on this row).
CREATE FUNCTION "protect_attendance_period"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'a payroll month lock is never removed or changed (period_locked)' USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER "attendance_periods_protect" BEFORE UPDATE OR DELETE ON "attendance_periods"
  FOR EACH ROW EXECUTE FUNCTION "protect_attendance_period"();

-- 3b. A month becomes closed only together with a "close_approved" event, and a closed month opens again only together
--     with a "reopened" event, written in the SAME transaction (checked at commit). The events table is insert-only.
CREATE FUNCTION "check_finance_period_change"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  needed text;
BEGIN
  IF NEW.status = 'closed' AND (TG_OP = 'INSERT' OR OLD.status <> 'closed') THEN
    needed := 'close_approved';
  ELSIF TG_OP = 'UPDATE' AND OLD.status = 'closed' AND NEW.status <> 'closed' THEN
    needed := 'reopened';
  ELSE
    RETURN NULL;
  END IF;
  IF NOT EXISTS (
    SELECT 1 FROM finance_period_events e
    WHERE e.month = NEW.month AND e.action = needed
      AND e.xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text
  ) THEN
    RAISE EXCEPTION 'a month is closed or reopened only through the approval workflow (no % event)', needed USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "finance_periods_workflow" AFTER INSERT OR UPDATE ON "finance_periods"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_finance_period_change"();

-- 3c. Journal entries: a posted entry always has an approver; an entry is posted only from "pending approval"; a draft
--     dated in a closed month cannot be moved out of it either (OLD date checked as well as the NEW one).
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_posted_has_approver" CHECK ("status" <> 'posted' OR "approved_by" IS NOT NULL);

CREATE OR REPLACE FUNCTION "protect_journal_entry"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'journal entries are never deleted; reverse a posted entry instead' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'INSERT' AND NEW.status <> 'draft' THEN
    RAISE EXCEPTION 'a journal entry starts as a draft (invalid_transition)' USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status IN ('posted', 'rejected') THEN
    RAISE EXCEPTION 'a % journal entry can never be edited (reverse it instead)', OLD.status USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.status <> OLD.status AND NOT (
       (OLD.status = 'draft' AND NEW.status = 'pending_approval')
    OR (OLD.status = 'pending_approval' AND NEW.status IN ('posted', 'rejected'))) THEN
    RAISE EXCEPTION 'a journal entry cannot go from % to % (invalid_transition)', OLD.status, NEW.status USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND OLD.status = 'pending_approval' AND (
       NEW.entry_date <> OLD.entry_date OR NEW.currency <> OLD.currency OR NEW.exchange_rate <> OLD.exchange_rate
       OR NEW.total_base <> OLD.total_base OR NEW.maker_id <> OLD.maker_id OR NEW.source <> OLD.source) THEN
    RAISE EXCEPTION 'an entry waiting for approval cannot be edited; reject it first' USING ERRCODE = 'P0001';
  END IF;
  IF EXISTS (SELECT 1 FROM finance_periods p WHERE p.month = to_char(NEW.entry_date, 'YYYY-MM') AND p.status = 'closed') THEN
    RAISE EXCEPTION '% is closed (period_closed)', to_char(NEW.entry_date, 'YYYY-MM') USING ERRCODE = 'P0001';
  END IF;
  IF TG_OP = 'UPDATE' AND NEW.entry_date <> OLD.entry_date
     AND EXISTS (SELECT 1 FROM finance_periods p WHERE p.month = to_char(OLD.entry_date, 'YYYY-MM') AND p.status = 'closed') THEN
    RAISE EXCEPTION '% is closed (period_closed)', to_char(OLD.entry_date, 'YYYY-MM') USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;

-- 3d. Payroll: the reviewer and the approver are always two different people (as well as never the preparer).
ALTER TABLE "payroll_runs" ADD CONSTRAINT "payroll_runs_reviewer_not_approver"
  CHECK ("reviewed_by" IS NULL OR "approved_by" IS NULL OR "reviewed_by" <> "approved_by");
