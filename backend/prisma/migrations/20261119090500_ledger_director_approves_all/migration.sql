-- Decision D26 (project owner, 18 Nov 2026): the Director (level 2) approves every journal entry of any amount, so the approval
-- tiers are gone. The CEO / Founder / Owner (level 1) approves only what the Director made, and is told (view only) about
-- large entries and capital or loan entries. The Director changes the finance settings; the Owner changes nothing.

-- 1. The amount above which the Owner is told (an entry above it, and every capital or loan entry, is reported to the Owner).
ALTER TABLE "finance_settings" ADD COLUMN "owner_notify_above" DECIMAL(14,2) NOT NULL DEFAULT 500000;
ALTER TABLE "finance_settings" DROP CONSTRAINT "finance_settings_single_row";
ALTER TABLE "finance_settings" ADD CONSTRAINT "finance_settings_single_row"
  CHECK ("id" = 1 AND "step_up_above" >= 0 AND "owner_notify_above" >= 0 AND "finance_year_start_month" BETWEEN 1 AND 12);

-- 2. Entries still waiting: the approver now depends on the maker alone (the Director, or the Owner for an entry the Director
--    made). Posted and rejected entries are immutable and keep the number they had.
UPDATE "journal_entries" e
SET "required_level" = CASE WHEN l.number >= 3 THEN 2 ELSE 1 END, "updated_at" = now()
FROM "employees" m JOIN "levels" l ON l.id = m.level_id
WHERE e.maker_id = m.id AND e.status = 'pending_approval' AND l.number >= 2;

-- 3. Permissions on an existing database (a fresh database gets the same from the seed). The Director needs to see finance
--    and export payroll and changes the finance settings; the Owner approves payroll only when the Director prepared it
--    (enforced in the service) and no longer reopens months or changes settings.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.id, p.id FROM "roles" r JOIN "permissions" p ON p.key IN ('finance.view', 'payroll.export', 'finance.authority_manage')
WHERE r.key = 'director'
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.id, p.id FROM "roles" r JOIN "permissions" p ON p.key = 'payroll.approve'
WHERE r.key = 'owner'
ON CONFLICT DO NOTHING;

DELETE FROM "role_permissions" rp USING "roles" r, "permissions" p
WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.key = 'owner' AND p.key IN ('finance.authority_manage', 'finance.reopen');

-- 4. Keep the history of the old limits in the audit log, then drop the tier table (with its CHECKs and trigger).
INSERT INTO "audit_log" ("actor_id", "action", "target_type", "target_id", "reason", "details")
SELECT NULL, 'finance.approval_limits.changed', 'settings', 'approval_limits',
  'Decision D26: the Director approves any amount; approval limits removed',
  jsonb_build_object(
    'before', (SELECT jsonb_agg(jsonb_build_object('approverLevel', approver_level, 'maxAmount', max_amount::text) ORDER BY approver_level) FROM "approval_limits"),
    'after', 'removed')
WHERE EXISTS (SELECT 1 FROM "approval_limits");

DROP TABLE "approval_limits";
DROP FUNCTION "protect_owner_tier"();

INSERT INTO "audit_log" ("actor_id", "action", "target_type", "target_id", "reason", "details")
SELECT NULL, 'roles.permissions.changed', 'role_permissions', 'd26_director_approves_all',
  'Decision D26: the Director approves every entry of any amount; the Owner approves only what the Director made',
  '{"added": {"director": ["finance.view", "payroll.export", "finance.authority_manage"], "owner": ["payroll.approve"]}, "removed": {"owner": ["finance.authority_manage", "finance.reopen"]}}'::jsonb
WHERE EXISTS (SELECT 1 FROM "roles");
