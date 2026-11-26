-- Module 15.7: sales commission (plan section 20 "Commission"; the approved M15.7 scope).
--
-- ADDITIVE only: new tables (the baseline, eligibility snapshots, versioned rules, one commission line per Won deal, the
-- line history), their enums, checks and triggers, and two new permissions with their grants (logged). No existing table
-- changes. Payroll (Module 8) and the ledger (Module 9) are not touched: the payroll link is a separate, reviewed M8 change.

CREATE TYPE "sales_commission_status" AS ENUM ('waiting_rate', 'calculated', 'approved', 'rejected', 'held', 'included');

CREATE TYPE "sales_commission_hold_reason" AS ENUM ('earner_left', 'manual');

CREATE TYPE "sales_commission_leaver_decision" AS ENUM ('pay', 'forfeit');

CREATE TYPE "sales_commission_eligibility_basis" AS ENUM ('won_confirmation', 'legacy_baseline');

CREATE TYPE "sales_commission_line_source" AS ENUM ('event', 'reconciliation');

CREATE TYPE "sales_commission_event_kind" AS ENUM ('waiting_rate', 'calculated', 'approved', 'rejected', 'held', 'leaver_decided', 'included');

CREATE TABLE "sales_commission_baseline" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "baseline_at" TIMESTAMPTZ(3) NOT NULL,
    "business_day" DATE NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_commission_baseline_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sales_commission_eligibility" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deal_id" UUID NOT NULL,
    "earner_id" UUID NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "basis" "sales_commission_eligibility_basis" NOT NULL,
    "evaluated_at" TIMESTAMPTZ(3) NOT NULL,
    "department_code" TEXT NOT NULL,
    "role_key" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_commission_eligibility_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sales_commission_rules" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "version" INTEGER NOT NULL,
    "rate_percent" DECIMAL(5,2) NOT NULL,
    "effective_from" DATE NOT NULL,
    "reason" TEXT NOT NULL,
    "set_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_commission_rules_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sales_commission_lines" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deal_id" UUID NOT NULL,
    "invoice_id" UUID NOT NULL,
    "paid_event_id" UUID,
    "source" "sales_commission_line_source" NOT NULL,
    "eligibility_id" UUID NOT NULL,
    "earner_id" UUID NOT NULL,
    "won_owner_id" UUID NOT NULL,
    "invoice_currency" "currency" NOT NULL,
    "collected_base" DECIMAL(14,2) NOT NULL,
    "base_pkr" DECIMAL(14,2) NOT NULL,
    "fully_paid_at" TIMESTAMPTZ(3) NOT NULL,
    "paid_on" DATE NOT NULL,
    "rule_id" UUID,
    "rule_version" INTEGER,
    "rate_percent" DECIMAL(5,2),
    "amount" DECIMAL(14,2),
    "currency" "currency" NOT NULL DEFAULT 'PKR',
    "status" "sales_commission_status" NOT NULL,
    "calculated_at" TIMESTAMPTZ(3),
    "hold_reason" "sales_commission_hold_reason",
    "hold_note" TEXT,
    "held_by_id" UUID,
    "held_at" TIMESTAMPTZ(3),
    "approved_by_id" UUID,
    "approved_at" TIMESTAMPTZ(3),
    "payroll_month" TEXT,
    "rejected_by_id" UUID,
    "rejected_at" TIMESTAMPTZ(3),
    "reject_reason" TEXT,
    "leaver_decision" "sales_commission_leaver_decision",
    "leaver_decided_by_id" UUID,
    "leaver_decided_at" TIMESTAMPTZ(3),
    "leaver_reason" TEXT,
    "included_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_commission_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "sales_commission_line_events" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "line_id" UUID NOT NULL,
    "event" "sales_commission_event_kind" NOT NULL,
    "from_status" "sales_commission_status",
    "to_status" "sales_commission_status" NOT NULL,
    "actor_id" UUID,
    "reason" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_commission_line_events_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "sales_commission_eligibility_deal_id_key" ON "sales_commission_eligibility"("deal_id");

CREATE UNIQUE INDEX "sales_commission_rules_version_key" ON "sales_commission_rules"("version");

CREATE INDEX "sales_commission_rules_effective_from_idx" ON "sales_commission_rules"("effective_from");

CREATE UNIQUE INDEX "sales_commission_lines_deal_id_key" ON "sales_commission_lines"("deal_id");

CREATE UNIQUE INDEX "sales_commission_lines_invoice_id_key" ON "sales_commission_lines"("invoice_id");

CREATE UNIQUE INDEX "sales_commission_lines_paid_event_id_key" ON "sales_commission_lines"("paid_event_id");

CREATE UNIQUE INDEX "sales_commission_lines_eligibility_id_key" ON "sales_commission_lines"("eligibility_id");

CREATE INDEX "sales_commission_lines_earner_id_status_idx" ON "sales_commission_lines"("earner_id", "status");

CREATE INDEX "sales_commission_lines_status_idx" ON "sales_commission_lines"("status");

CREATE INDEX "sales_commission_line_events_line_id_at_idx" ON "sales_commission_line_events"("line_id", "at");

ALTER TABLE "sales_commission_eligibility" ADD CONSTRAINT "sales_commission_eligibility_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "sales_deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales_commission_eligibility" ADD CONSTRAINT "sales_commission_eligibility_earner_id_fkey" FOREIGN KEY ("earner_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales_commission_rules" ADD CONSTRAINT "sales_commission_rules_set_by_id_fkey" FOREIGN KEY ("set_by_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales_commission_lines" ADD CONSTRAINT "sales_commission_lines_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "sales_deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales_commission_lines" ADD CONSTRAINT "sales_commission_lines_invoice_id_fkey" FOREIGN KEY ("invoice_id") REFERENCES "invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales_commission_lines" ADD CONSTRAINT "sales_commission_lines_earner_id_fkey" FOREIGN KEY ("earner_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales_commission_lines" ADD CONSTRAINT "sales_commission_lines_won_owner_id_fkey" FOREIGN KEY ("won_owner_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales_commission_lines" ADD CONSTRAINT "sales_commission_lines_rule_id_fkey" FOREIGN KEY ("rule_id") REFERENCES "sales_commission_rules"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sales_commission_lines" ADD CONSTRAINT "sales_commission_lines_eligibility_id_fkey" FOREIGN KEY ("eligibility_id") REFERENCES "sales_commission_eligibility"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales_commission_lines" ADD CONSTRAINT "sales_commission_lines_held_by_id_fkey" FOREIGN KEY ("held_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sales_commission_lines" ADD CONSTRAINT "sales_commission_lines_approved_by_id_fkey" FOREIGN KEY ("approved_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sales_commission_lines" ADD CONSTRAINT "sales_commission_lines_rejected_by_id_fkey" FOREIGN KEY ("rejected_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sales_commission_lines" ADD CONSTRAINT "sales_commission_lines_leaver_decided_by_id_fkey" FOREIGN KEY ("leaver_decided_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "sales_commission_line_events" ADD CONSTRAINT "sales_commission_line_events_line_id_fkey" FOREIGN KEY ("line_id") REFERENCES "sales_commission_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "sales_commission_line_events" ADD CONSTRAINT "sales_commission_line_events_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ======================================================================================================================
-- Hand-written rules (Prisma cannot express them).

-- 1. Rules: a rate from 0.01 to 100 percent, a reason; insert-only (a change is a new version).
ALTER TABLE "sales_commission_rules"
  ADD CONSTRAINT "sales_commission_rules_rate_check" CHECK ("rate_percent" > 0 AND "rate_percent" <= 100),
  ADD CONSTRAINT "sales_commission_rules_version_check" CHECK ("version" >= 1),
  ADD CONSTRAINT "sales_commission_rules_reason_check" CHECK (length(btrim("reason")) >= 5);
CREATE TRIGGER "sales_commission_rules_insert_only" BEFORE UPDATE OR DELETE ON "sales_commission_rules" FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "sales_commission_rules_no_truncate" BEFORE TRUNCATE ON "sales_commission_rules" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

-- 2. Lines: the money is consistent with itself, in PKR, and nobody decides their own line.
ALTER TABLE "sales_commission_lines"
  ADD CONSTRAINT "sales_commission_lines_currency_check" CHECK ("currency" = 'PKR'),
  ADD CONSTRAINT "sales_commission_lines_base_check" CHECK ("collected_base" > 0 AND "base_pkr" > 0),
  ADD CONSTRAINT "sales_commission_lines_pkr_base_check" CHECK ("invoice_currency" <> 'PKR' OR "base_pkr" = "collected_base"),
  -- ownership is frozen at Won confirmation and there is no split commission
  ADD CONSTRAINT "sales_commission_lines_earner_check" CHECK ("earner_id" = "won_owner_id"),
  -- the rate, its version and the amount are all set or all empty; empty only while waiting for a rate
  ADD CONSTRAINT "sales_commission_lines_rate_set_check" CHECK (
    ("rule_id" IS NULL) = ("rule_version" IS NULL) AND ("rule_id" IS NULL) = ("rate_percent" IS NULL)
    AND ("rule_id" IS NULL) = ("amount" IS NULL) AND ("rule_id" IS NULL) = ("calculated_at" IS NULL)),
  ADD CONSTRAINT "sales_commission_lines_waiting_check" CHECK (("status" = 'waiting_rate') = ("amount" IS NULL)),
  -- the formula itself: PKR base x rate / 100, rounded half up to 2 decimals (round() on a positive numeric)
  ADD CONSTRAINT "sales_commission_lines_amount_check" CHECK ("amount" IS NULL OR "amount" = round("base_pkr" * "rate_percent" / 100, 2)),
  ADD CONSTRAINT "sales_commission_lines_held_check" CHECK ("status" <> 'held' OR ("hold_reason" IS NOT NULL AND "held_at" IS NOT NULL)),
  ADD CONSTRAINT "sales_commission_lines_manual_hold_check" CHECK ("hold_reason" IS DISTINCT FROM 'manual' OR ("held_by_id" IS NOT NULL AND length(btrim(coalesce("hold_note", ''))) >= 5)),
  ADD CONSTRAINT "sales_commission_lines_approved_check" CHECK ("status" NOT IN ('approved', 'included') OR ("approved_by_id" IS NOT NULL AND "approved_at" IS NOT NULL AND "payroll_month" IS NOT NULL)),
  ADD CONSTRAINT "sales_commission_lines_rejected_check" CHECK ("status" <> 'rejected' OR ("rejected_at" IS NOT NULL AND length(btrim(coalesce("reject_reason", ''))) >= 5)),
  ADD CONSTRAINT "sales_commission_lines_included_check" CHECK (("status" = 'included') = ("included_at" IS NOT NULL)),
  ADD CONSTRAINT "sales_commission_lines_leaver_check" CHECK (
    ("leaver_decision" IS NULL) = ("leaver_decided_by_id" IS NULL) AND ("leaver_decision" IS NULL) = ("leaver_decided_at" IS NULL)
    AND ("leaver_decision" IS NULL OR length(btrim(coalesce("leaver_reason", ''))) >= 5)),
  ADD CONSTRAINT "sales_commission_lines_payroll_month_check" CHECK ("payroll_month" IS NULL OR "payroll_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  ADD CONSTRAINT "sales_commission_lines_not_self_check" CHECK (
    "approved_by_id" IS DISTINCT FROM "earner_id" AND "rejected_by_id" IS DISTINCT FROM "earner_id"
    AND "held_by_id" IS DISTINCT FROM "earner_id" AND "leaver_decided_by_id" IS DISTINCT FROM "earner_id"),
  ADD CONSTRAINT "sales_commission_lines_version_check" CHECK ("version" >= 1);

-- 3. A line names the rule version and rate it used, exactly.
CREATE OR REPLACE FUNCTION "check_sales_commission_line_rule"() RETURNS trigger AS $$
DECLARE r record;
BEGIN
  IF NEW."rule_id" IS NOT NULL THEN
    SELECT "version", "rate_percent" INTO r FROM "sales_commission_rules" WHERE "id" = NEW."rule_id";
    IF r."version" IS DISTINCT FROM NEW."rule_version" OR r."rate_percent" IS DISTINCT FROM NEW."rate_percent" THEN
      RAISE EXCEPTION 'commission_rule_mismatch: the line must carry the version and rate of its rule' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "sales_commission_lines_rule" BEFORE INSERT OR UPDATE ON "sales_commission_lines" FOR EACH ROW EXECUTE FUNCTION "check_sales_commission_line_rule"();

-- 4. What a line is never changes; the rate and amount are set once (from waiting_rate); statuses only move forward;
--    approved values stay frozen; rejected and included lines are final. Every change raises the version by one.
CREATE OR REPLACE FUNCTION "protect_sales_commission_line"() RETURNS trigger AS $$
BEGIN
  IF NEW."deal_id" <> OLD."deal_id" OR NEW."invoice_id" <> OLD."invoice_id" OR NEW."paid_event_id" IS DISTINCT FROM OLD."paid_event_id"
     OR NEW."source" <> OLD."source" OR NEW."eligibility_id" <> OLD."eligibility_id" OR NEW."fully_paid_at" <> OLD."fully_paid_at"
     OR NEW."earner_id" <> OLD."earner_id" OR NEW."won_owner_id" <> OLD."won_owner_id" OR NEW."invoice_currency" <> OLD."invoice_currency"
     OR NEW."collected_base" <> OLD."collected_base" OR NEW."base_pkr" <> OLD."base_pkr" OR NEW."paid_on" <> OLD."paid_on"
     OR NEW."currency" <> OLD."currency" OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'commission_line_frozen: what a commission line is cannot change' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" <> 'waiting_rate' AND (
       NEW."rule_id" IS DISTINCT FROM OLD."rule_id" OR NEW."rule_version" IS DISTINCT FROM OLD."rule_version"
       OR NEW."rate_percent" IS DISTINCT FROM OLD."rate_percent" OR NEW."amount" IS DISTINCT FROM OLD."amount"
       OR NEW."calculated_at" IS DISTINCT FROM OLD."calculated_at") THEN
    RAISE EXCEPTION 'commission_amount_frozen: a calculated commission never changes' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."status" IN ('rejected', 'included') THEN
    RAISE EXCEPTION 'commission_line_final: a % commission line is final', OLD."status" USING ERRCODE = 'check_violation';
  END IF;
  IF NOT (
       (OLD."status" = 'waiting_rate' AND NEW."status" IN ('calculated', 'held'))
    OR (OLD."status" = 'calculated' AND NEW."status" IN ('approved', 'rejected', 'held'))
    OR (OLD."status" = 'held' AND NEW."status" IN ('approved', 'rejected'))
    OR (OLD."status" = 'approved' AND NEW."status" IN ('held', 'rejected', 'included'))) THEN
    RAISE EXCEPTION 'commission_invalid_transition: % to %', OLD."status", NEW."status" USING ERRCODE = 'check_violation';
  END IF;
  -- a leaver-held line is decided by the Owner only (the final-settlement decision), and that decision is recorded once
  IF OLD."status" = 'held' AND OLD."hold_reason" = 'earner_left' AND NEW."leaver_decision" IS NULL THEN
    RAISE EXCEPTION 'commission_leaver_decision_needed: a line held because the earner left needs the final-settlement decision' USING ERRCODE = 'check_violation';
  END IF;
  IF OLD."leaver_decision" IS NOT NULL AND (NEW."leaver_decision" IS DISTINCT FROM OLD."leaver_decision"
       OR NEW."leaver_decided_by_id" IS DISTINCT FROM OLD."leaver_decided_by_id" OR NEW."leaver_decided_at" IS DISTINCT FROM OLD."leaver_decided_at"
       OR NEW."leaver_reason" IS DISTINCT FROM OLD."leaver_reason") THEN
    RAISE EXCEPTION 'commission_leaver_decision_final: the final-settlement decision is recorded once' USING ERRCODE = 'check_violation';
  END IF;
  -- the approval (who, when, payroll month) is written only by the move into approved, and kept as it is afterwards
  IF NEW."status" <> 'approved' OR OLD."status" = 'approved' THEN
    IF NEW."approved_by_id" IS DISTINCT FROM OLD."approved_by_id" OR NEW."approved_at" IS DISTINCT FROM OLD."approved_at"
       OR NEW."payroll_month" IS DISTINCT FROM OLD."payroll_month" THEN
      RAISE EXCEPTION 'commission_approval_frozen: an approval is recorded once, when the line is approved' USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'commission_version: every change raises the version by one' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "sales_commission_lines_protect" BEFORE UPDATE ON "sales_commission_lines" FOR EACH ROW EXECUTE FUNCTION "protect_sales_commission_line"();
CREATE TRIGGER "sales_commission_lines_no_delete" BEFORE DELETE ON "sales_commission_lines" FOR EACH ROW EXECUTE FUNCTION "prevent_sales_record_delete"();
CREATE TRIGGER "sales_commission_lines_no_truncate" BEFORE TRUNCATE ON "sales_commission_lines" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

-- 5. The history of every line is insert-only.
CREATE TRIGGER "sales_commission_line_events_insert_only" BEFORE UPDATE OR DELETE ON "sales_commission_line_events" FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "sales_commission_line_events_no_truncate" BEFORE TRUNCATE ON "sales_commission_line_events" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

-- 7. The baseline: one row, never changed; its business day is its Pakistan day.
ALTER TABLE "sales_commission_baseline"
  ADD CONSTRAINT "sales_commission_baseline_single_check" CHECK ("id" = 1),
  ADD CONSTRAINT "sales_commission_baseline_day_check" CHECK ("business_day" = ("baseline_at" AT TIME ZONE 'Asia/Karachi')::date);
CREATE TRIGGER "sales_commission_baseline_insert_only" BEFORE UPDATE OR DELETE ON "sales_commission_baseline" FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "sales_commission_baseline_no_truncate" BEFORE TRUNCATE ON "sales_commission_baseline" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

-- 8. Rules: none before the baseline; the first starts exactly on the baseline's business day; none starts before it.
CREATE OR REPLACE FUNCTION "check_sales_commission_rule"() RETURNS trigger AS $$
DECLARE b date;
BEGIN
  SELECT "business_day" INTO b FROM "sales_commission_baseline" WHERE "id" = 1;
  IF b IS NULL THEN
    RAISE EXCEPTION 'commission_baseline_missing: no commission rule before the M15.7 baseline is recorded' USING ERRCODE = 'check_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "sales_commission_rules") AND NEW."effective_from" <> b THEN
    RAISE EXCEPTION 'commission_first_rule_day: the first rule starts on the baseline day (%)', b USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."effective_from" < b THEN
    RAISE EXCEPTION 'commission_rule_before_baseline: a rule never starts before the baseline day (%)', b USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "sales_commission_rules_check" BEFORE INSERT ON "sales_commission_rules" FOR EACH ROW EXECUTE FUNCTION "check_sales_commission_rule"();

-- 9. Eligibility snapshots: insert-only; only for a confirmed Won deal, for its owner.
CREATE OR REPLACE FUNCTION "check_sales_commission_eligibility"() RETURNS trigger AS $$
DECLARE d record;
BEGIN
  SELECT "won_status", "owner_id" INTO d FROM "sales_deals" WHERE "id" = NEW."deal_id";
  IF d."won_status" IS DISTINCT FROM 'confirmed' OR d."owner_id" IS DISTINCT FROM NEW."earner_id" THEN
    RAISE EXCEPTION 'commission_eligibility_deal: a snapshot is only for a confirmed Won deal and its owner' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "sales_commission_eligibility_check" BEFORE INSERT ON "sales_commission_eligibility" FOR EACH ROW EXECUTE FUNCTION "check_sales_commission_eligibility"();
CREATE TRIGGER "sales_commission_eligibility_insert_only" BEFORE UPDATE OR DELETE ON "sales_commission_eligibility" FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "sales_commission_eligibility_no_truncate" BEFORE TRUNCATE ON "sales_commission_eligibility" FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

-- 10. A line: from an event or the reconciliation; its business day is the posting day; fully paid at or after the
--     baseline; for an eligible snapshot of the same deal and earner.
ALTER TABLE "sales_commission_lines"
  ADD CONSTRAINT "sales_commission_lines_source_check" CHECK (("source" = 'event') = ("paid_event_id" IS NOT NULL)),
  ADD CONSTRAINT "sales_commission_lines_paid_day_check" CHECK ("paid_on" = ("fully_paid_at" AT TIME ZONE 'Asia/Karachi')::date);
CREATE OR REPLACE FUNCTION "check_sales_commission_line_insert"() RETURNS trigger AS $$
DECLARE b timestamptz; e record;
BEGIN
  SELECT "baseline_at" INTO b FROM "sales_commission_baseline" WHERE "id" = 1;
  IF b IS NULL OR NEW."fully_paid_at" < b THEN
    RAISE EXCEPTION 'commission_before_baseline: only an invoice fully paid at or after the M15.7 baseline earns commission' USING ERRCODE = 'check_violation';
  END IF;
  SELECT "deal_id", "earner_id", "eligible" INTO e FROM "sales_commission_eligibility" WHERE "id" = NEW."eligibility_id";
  IF e."eligible" IS DISTINCT FROM true OR e."deal_id" IS DISTINCT FROM NEW."deal_id" OR e."earner_id" IS DISTINCT FROM NEW."earner_id" THEN
    RAISE EXCEPTION 'commission_not_eligible: the line needs the eligible snapshot of the same deal and earner' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
CREATE TRIGGER "sales_commission_lines_insert_check" BEFORE INSERT ON "sales_commission_lines" FOR EACH ROW EXECUTE FUNCTION "check_sales_commission_line_insert"();

-- 6. The two approved permissions: the Owner approves the Director's own commission and decides leaver-held commission;
--    the Director and the Finance duty hold or reject a line. Each grant is logged.
INSERT INTO "permissions" ("key", "module", "description") VALUES
  ('sales.commission_approve_director', 'sales', 'Approve or reject the Director''s own commission and decide commission held because the earner left (M15.7)'),
  ('sales.commission_hold', 'sales', 'Hold or reject a commission line, for example after a refund or a payment reversal (M15.7)')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.id, p.id FROM "roles" r JOIN "permissions" p ON p.key = 'sales.commission_approve_director' WHERE r.key = 'owner'
ON CONFLICT DO NOTHING;
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.id, p.id FROM "roles" r JOIN "permissions" p ON p.key = 'sales.commission_hold' WHERE r.key = 'director'
ON CONFLICT DO NOTHING;
INSERT INTO "duty_permissions" ("duty_id", "permission_id")
SELECT d.id, p.id FROM "duties" d JOIN "permissions" p ON p.key = 'sales.commission_hold' WHERE d.key = 'finance'
ON CONFLICT DO NOTHING;

INSERT INTO "audit_log" ("actor_id", "action", "target_type", "target_id", "reason", "details")
SELECT NULL, 'roles.permissions.changed', 'role_permissions', 'm15_commission',
  'M15.7: the Owner approves the Director''s own commission and decides leaver-held commission; the Director and the Finance duty hold or reject commission lines',
  '{"added": {"owner": ["sales.commission_approve_director"], "director": ["sales.commission_hold"], "duty:finance": ["sales.commission_hold"]}}'::jsonb
WHERE EXISTS (SELECT 1 FROM "roles");
