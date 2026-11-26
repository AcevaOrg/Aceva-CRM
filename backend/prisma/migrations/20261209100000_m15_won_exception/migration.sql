-- Module 15.5 follow-up, the exceptional Won decision (approved management decision): when the person who asked for Won
-- has left and Module 15.5 moved the deal to someone else, nobody may be able to decide the request (B1 covers only deals a
-- Director owns; nobody decides their own deal). The Owner role may then confirm it or send it back, with a reason and
-- step-up re-authentication, through a separate route; each decision is kept in an insert-only record.
-- ADDITIVE: one new permission granted to the Owner role (with its audit row), one new table with its indexes, constraints
-- and triggers, and the function behind the B1 trigger sales_deals_won_confirmer replaced with the same rules plus one
-- narrow, record-bound exception. No table, column, constraint, trigger or row is removed or changed otherwise.

-- CreateTable
CREATE TABLE "sales_won_exceptions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deal_id" UUID NOT NULL,
    "decision" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "basis" TEXT NOT NULL,
    "decided_by_id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    "requested_at" TIMESTAMPTZ(3) NOT NULL,
    "owner_at_request_id" UUID NOT NULL,
    "current_owner_id" UUID NOT NULL,
    "details" JSONB NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_won_exceptions_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_won_exceptions_deal_id_created_at_idx" ON "sales_won_exceptions"("deal_id", "created_at");

-- AddForeignKey
ALTER TABLE "sales_won_exceptions" ADD CONSTRAINT "sales_won_exceptions_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "sales_deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_won_exceptions" ADD CONSTRAINT "sales_won_exceptions_decided_by_id_fkey" FOREIGN KEY ("decided_by_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_won_exceptions" ADD CONSTRAINT "sales_won_exceptions_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_won_exceptions" ADD CONSTRAINT "sales_won_exceptions_owner_at_request_id_fkey" FOREIGN KEY ("owner_at_request_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_won_exceptions" ADD CONSTRAINT "sales_won_exceptions_current_owner_id_fkey" FOREIGN KEY ("current_owner_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ======================================================================================================================
-- Hand-written rules (Prisma cannot express them).

-- 1. The permission, granted to the Owner role only (approved decision 1). The Owner gains no sales-management right.
INSERT INTO "permissions" ("key", "module", "description")
VALUES ('sales.won_decide_exception', 'sales', 'Decide a pending Won request whose requester has left and that no sales manager can decide (M15.5 exception)')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.id, p.id FROM "roles" r JOIN "permissions" p ON p.key = 'sales.won_decide_exception'
WHERE r.key = 'owner'
ON CONFLICT DO NOTHING;

INSERT INTO "audit_log" ("actor_id", "action", "target_type", "target_id", "reason", "details")
SELECT NULL, 'roles.permissions.changed', 'role_permissions', 'm15_won_exception',
  'M15.5 exception: the Owner may confirm or send back a pending Won request whose requester has left and that no sales manager can decide',
  '{"added": {"owner": ["sales.won_decide_exception"]}}'::jsonb
WHERE EXISTS (SELECT 1 FROM "roles");

-- 2. The record of each exceptional decision: what was decided, why, by whom, and the original request. The decider is
--    never the current owner nor the person who asked. A deal is confirmed this way at most once. Insert-only.
ALTER TABLE "sales_won_exceptions" ADD CONSTRAINT "sales_won_exceptions_decision" CHECK ("decision" IN ('confirm', 'send_back'));
ALTER TABLE "sales_won_exceptions" ADD CONSTRAINT "sales_won_exceptions_basis" CHECK ("basis" IN ('requester_left_no_confirmer'));
ALTER TABLE "sales_won_exceptions" ADD CONSTRAINT "sales_won_exceptions_reason_length" CHECK (char_length(btrim("reason")) BETWEEN 5 AND 500);
ALTER TABLE "sales_won_exceptions" ADD CONSTRAINT "sales_won_exceptions_not_self" CHECK ("decided_by_id" <> "current_owner_id" AND "decided_by_id" <> "requester_id");
CREATE UNIQUE INDEX "sales_won_exceptions_one_confirm_key" ON "sales_won_exceptions"("deal_id") WHERE "decision" = 'confirm';
CREATE TRIGGER "sales_won_exceptions_insert_only" BEFORE UPDATE OR DELETE ON "sales_won_exceptions"
  FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "sales_won_exceptions_no_truncate" BEFORE TRUNCATE ON "sales_won_exceptions"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

-- 3. The B1 guard, with one narrow addition. Every existing rule stays exactly as it was: a Level 1 confirmer (the CEO /
--    Founder / Owner) confirms only a deal a Level 2 employee (the Director) owns. The only addition: a Level 1 confirmer may
--    also confirm a deal that has a matching exceptional record written IN THE SAME TRANSACTION, for that exact deal, that
--    exact confirmer, its current owner, and the decision "confirm". A direct or unrelated Level 1 confirmation is still
--    refused (owner_confirms_director_deals_only). The trigger itself is unchanged; only its function body gains this check.
CREATE OR REPLACE FUNCTION "check_sales_won_confirmer"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  confirmer_level integer;
  owner_level integer;
BEGIN
  IF NEW."won_status" = 'confirmed' AND (TG_OP = 'INSERT' OR OLD."won_status" IS DISTINCT FROM 'confirmed') THEN
    SELECT l."number" INTO confirmer_level FROM "employees" e JOIN "levels" l ON l."id" = e."level_id" WHERE e."id" = NEW."won_confirmed_by_id";
    SELECT l."number" INTO owner_level FROM "employees" e JOIN "levels" l ON l."id" = e."level_id" WHERE e."id" = NEW."owner_id";
    IF confirmer_level = 1 AND owner_level IS DISTINCT FROM 2 AND NOT EXISTS (
      SELECT 1 FROM "sales_won_exceptions" x
      WHERE x."deal_id" = NEW."id"
        AND x."decided_by_id" = NEW."won_confirmed_by_id"
        AND x."current_owner_id" = NEW."owner_id"
        AND x."decision" = 'confirm'
        AND x."xmin"::text = (pg_current_xact_id()::text::numeric % 4294967296)::text
    ) THEN
      RAISE EXCEPTION 'The Owner confirms only Won deals the Director owns (owner_confirms_director_deals_only)' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
