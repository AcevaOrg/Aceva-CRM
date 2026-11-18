-- Rejected payroll entries can be replaced (review fixes for Module 8, bugs 2 and 3).
-- An approved payroll run still never changes, with one exception: its salary entry or its payment entry may be
-- replaced when the entry it points to was REJECTED in the ledger. A posted or pending entry is still locked.
-- The replacement is written in the same transaction as the application's new entry (the app checks the rest).

CREATE OR REPLACE FUNCTION "protect_payroll_run"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'payroll runs are never deleted' USING ERRCODE = 'P0001';
  END IF;
  IF OLD.stage = 'approved' THEN
    IF NEW.stage <> OLD.stage OR NEW.month <> OLD.month OR NEW.number <> OLD.number
       OR NEW.working_days IS DISTINCT FROM OLD.working_days OR NEW.tax_slab_set_id IS DISTINCT FROM OLD.tax_slab_set_id
       OR NEW.prepared_by IS DISTINCT FROM OLD.prepared_by OR NEW.reviewed_by IS DISTINCT FROM OLD.reviewed_by
       OR NEW.approved_by IS DISTINCT FROM OLD.approved_by OR NEW.approved_at IS DISTINCT FROM OLD.approved_at THEN
      RAISE EXCEPTION 'an approved payroll run cannot be changed; use an adjustment in a later month' USING ERRCODE = 'P0001';
    END IF;
    -- The salary entry may be replaced only after the ledger rejected it.
    IF NEW.journal_entry_id IS DISTINCT FROM OLD.journal_entry_id
       AND NOT (OLD.journal_entry_id IS NOT NULL AND EXISTS (SELECT 1 FROM "journal_entries" e WHERE e.id = OLD.journal_entry_id AND e.status = 'rejected')) THEN
      RAISE EXCEPTION 'an approved payroll run cannot be changed: its salary entry can only be replaced after the ledger rejected it' USING ERRCODE = 'P0001';
    END IF;
    -- The payment record is added once, and may be replaced only after the ledger rejected the previous one.
    IF OLD.payment_entry_id IS NOT NULL AND NEW.payment_entry_id IS DISTINCT FROM OLD.payment_entry_id
       AND NOT EXISTS (SELECT 1 FROM "journal_entries" e WHERE e.id = OLD.payment_entry_id AND e.status = 'rejected') THEN
      RAISE EXCEPTION 'an approved payroll run cannot be changed: its payment entry can only be replaced after the ledger rejected it' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
