-- Module 15.2, Won confirmation of a deal the Director owns (management decision B1, approved as an M1 permission change).
-- Nobody approves their own request, so a deal the Director owns cannot be confirmed by the Director; the CEO / Founder /
-- Owner confirms it, and ONLY such a deal (the same rule as decision D26: the Owner decides only a payroll run the
-- Director prepared). The Owner gains no general right to confirm Won deals.
-- ADDITIVE ONLY: one new permission granted to the Owner role, one audit row, one new trigger on the M15.2 table
-- sales_deals. No existing row, column, constraint or trigger is changed or removed.

-- 1. The permission, granted to the Owner role only.
INSERT INTO "permissions" ("key", "module", "description")
VALUES ('sales.won_confirm_director', 'sales', 'Confirm a Won deal that the Director owns, and only such a deal (decision B1)')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.id, p.id FROM "roles" r JOIN "permissions" p ON p.key = 'sales.won_confirm_director'
WHERE r.key = 'owner'
ON CONFLICT DO NOTHING;

INSERT INTO "audit_log" ("actor_id", "action", "target_type", "target_id", "reason", "details")
SELECT NULL, 'roles.permissions.changed', 'role_permissions', 'm15_owner_confirms_director_deals',
  'Decision B1: the Owner confirms Won deals the Director owns, because nobody approves their own deal',
  '{"added": {"owner": ["sales.won_confirm_director"]}}'::jsonb
WHERE EXISTS (SELECT 1 FROM "roles");

-- 2. In the database as well: a Level 1 confirmer (the CEO / Founder / Owner) confirms only a deal owned by a Level 2
--    employee (the Director). Nobody confirms their own deal or their own request (CHECK sales_deals_no_self_confirmation).
CREATE FUNCTION "check_sales_won_confirmer"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  confirmer_level integer;
  owner_level integer;
BEGIN
  IF NEW."won_status" = 'confirmed' AND (TG_OP = 'INSERT' OR OLD."won_status" IS DISTINCT FROM 'confirmed') THEN
    SELECT l."number" INTO confirmer_level FROM "employees" e JOIN "levels" l ON l."id" = e."level_id" WHERE e."id" = NEW."won_confirmed_by_id";
    SELECT l."number" INTO owner_level FROM "employees" e JOIN "levels" l ON l."id" = e."level_id" WHERE e."id" = NEW."owner_id";
    IF confirmer_level = 1 AND owner_level IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'The Owner confirms only Won deals the Director owns (owner_confirms_director_deals_only)' USING ERRCODE = 'P0001';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "sales_deals_won_confirmer" BEFORE INSERT OR UPDATE ON "sales_deals"
  FOR EACH ROW EXECUTE FUNCTION "check_sales_won_confirmer"();
