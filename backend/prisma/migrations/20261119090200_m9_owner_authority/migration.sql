-- Module 9, decision D22 (additive; no existing row is changed or removed).
-- Only the Owner changes approval limits and finance-wide security settings, and only the Owner removes the
-- "Owner approves" rule from an account. Unlimited approval always belongs to the Owner. A sub-account of an account that
-- needs Owner approval (for example under 2500 Loans) always needs it too.

-- 1. The permission, granted to the Owner role only.
INSERT INTO "permissions" ("key", "module", "description")
VALUES ('finance.authority_manage', 'finance', 'Change approval limits, finance security settings and the Owner-approval rule (Owner only, decision D22)')
ON CONFLICT ("key") DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.id, p.id FROM "roles" r JOIN "permissions" p ON p.key = 'finance.authority_manage'
WHERE r.key = 'owner'
ON CONFLICT DO NOTHING;

INSERT INTO "audit_log" ("actor_id", "action", "target_type", "target_id", "reason", "details")
SELECT NULL, 'roles.permissions.changed', 'role_permissions', 'm9_owner_authority',
  'Decision D22: only the Owner changes approval limits, finance security settings and the Owner-approval rule',
  '{"added": {"owner": ["finance.authority_manage"]}}'::jsonb
WHERE EXISTS (SELECT 1 FROM "roles");

-- 2. Unlimited approval belongs to the Owner tier (level 1) and only to it, and the Owner tier is never removed.
ALTER TABLE "approval_limits" ADD CONSTRAINT "approval_limits_unlimited_is_owner" CHECK (("max_amount" IS NULL) = ("approver_level" = 1));

CREATE FUNCTION "protect_owner_tier"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.approver_level = 1 THEN
    RAISE EXCEPTION 'the Owner approval tier is never removed (owner_only)' USING ERRCODE = 'P0001';
  END IF;
  RETURN OLD;
END $$;
CREATE TRIGGER "approval_limits_keep_owner" BEFORE DELETE ON "approval_limits"
  FOR EACH ROW EXECUTE FUNCTION "protect_owner_tier"();

-- 3. A sub-account of an account that needs Owner approval needs it too (inherited, cannot be switched off),
--    and flagging an account flags its sub-accounts.
-- 3a. Accounts that already exist: every sub-account (at any depth) of an account that needs Owner approval gets it.
--     This only ADDS the rule (it never removes one); on a database without such accounts it changes nothing.
WITH RECURSIVE flagged AS (
  SELECT id FROM ledger_accounts WHERE requires_owner_approval
  UNION
  SELECT c.id FROM ledger_accounts c JOIN flagged f ON c.parent_id = f.id
)
UPDATE ledger_accounts SET requires_owner_approval = true
WHERE id IN (SELECT id FROM flagged) AND NOT requires_owner_approval;

-- 3b. From now on. The parent row is read FOR SHARE, so a sub-account created while its parent is being flagged waits
--     for that change and sees it (no race leaves an unflagged sub-account under a flagged parent).
CREATE FUNCTION "inherit_owner_approval"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_flag boolean;
BEGIN
  IF NEW.parent_id IS NULL OR NEW.requires_owner_approval THEN
    RETURN NEW;
  END IF;
  SELECT p.requires_owner_approval INTO parent_flag FROM ledger_accounts p WHERE p.id = NEW.parent_id FOR SHARE;
  IF parent_flag THEN
    RAISE EXCEPTION 'account % is under an account that needs Owner approval, so it needs it too (owner_approval_inherited)', NEW.code USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "ledger_accounts_inherit_owner_approval" BEFORE INSERT OR UPDATE ON "ledger_accounts"
  FOR EACH ROW EXECUTE FUNCTION "inherit_owner_approval"();

CREATE FUNCTION "cascade_owner_approval"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  UPDATE ledger_accounts SET requires_owner_approval = true WHERE parent_id = NEW.id AND NOT requires_owner_approval;
  RETURN NULL;
END $$;
CREATE TRIGGER "ledger_accounts_cascade_owner_approval" AFTER UPDATE OF "requires_owner_approval" ON "ledger_accounts"
  FOR EACH ROW WHEN (NEW.requires_owner_approval AND NOT OLD.requires_owner_approval) EXECUTE FUNCTION "cascade_owner_approval"();

-- 4. Removing the rule needs the Owner: an audit row "finance.account.owner_approval_removed" for that account, made by
--    an Owner (level 1), in the SAME transaction (checked at commit). The audit log is insert-only.
CREATE FUNCTION "check_owner_approval_removal"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.requires_owner_approval AND NOT NEW.requires_owner_approval AND NOT EXISTS (
    SELECT 1 FROM audit_log a
    JOIN employees e ON e.id = a.actor_id
    JOIN levels l ON l.id = e.level_id
    WHERE a.action = 'finance.account.owner_approval_removed' AND a.target_id = NEW.code AND l.number = 1
      AND a.xmin::text = (pg_current_xact_id()::text::bigint % 4294967296)::text
  ) THEN
    RAISE EXCEPTION 'only the Owner removes the Owner-approval rule from account % (owner_only)', NEW.code USING ERRCODE = 'P0001';
  END IF;
  RETURN NULL;
END $$;
CREATE CONSTRAINT TRIGGER "ledger_accounts_owner_approval_removal" AFTER UPDATE ON "ledger_accounts"
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION "check_owner_approval_removal"();
