-- Decision D25 (management, 17 Nov 2026): every approval below the Owner is the Director's; the CEO only views, and signs
-- off only the Director's own requests. DATA ONLY: no table, column, constraint or trigger changes. On an empty database
-- (a fresh install) every statement is a no-op; the seed then creates the same state from permission-catalogue.ts.

-- 1. New permission: approve or reject a hire request (it was org.manage, the Owner and the CEO).
INSERT INTO "permissions" ("key", "module", "description")
VALUES ('people.approve_hire', 'people', 'people: approve hire')
ON CONFLICT ("key") DO NOTHING;

-- 2. The Director gains payroll approval (one step; the separate review is gone), the month close, reopening a month and
--    hire requests. The Owner keeps everything it had and also decides hire requests.
INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.id, p.id FROM "roles" r JOIN "permissions" p
  ON p.key IN ('payroll.approve', 'finance.close_approve', 'finance.reopen', 'people.approve_hire')
WHERE r.key = 'director'
ON CONFLICT DO NOTHING;

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT r.id, p.id FROM "roles" r JOIN "permissions" p ON p.key = 'people.approve_hire'
WHERE r.key IN ('owner', 'ceo')
ON CONFLICT DO NOTHING;

DELETE FROM "role_permissions" rp USING "roles" r, "permissions" p
WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.key = 'director' AND p.key = 'payroll.review';

-- 3. The CEO stops approving payroll, the month close and reopening. It keeps leave, corrections, journal entries and hire
--    requests only for what the Director asked for (enforced in code: routing, level 2 entries, the hire rule).
DELETE FROM "role_permissions" rp USING "roles" r, "permissions" p
WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.key = 'ceo'
  AND p.key IN ('payroll.approve', 'finance.close_approve', 'finance.reopen');

INSERT INTO "audit_log" ("actor_id", "action", "target_type", "target_id", "reason", "details")
SELECT NULL, 'roles.permissions.changed', 'role_permissions', 'd25_director_approves',
  'Decision D25: the Director approves everything below the Owner; the CEO only views and signs off the Director''s own requests',
  '{"added": {"director": ["payroll.approve", "finance.close_approve", "finance.reopen", "people.approve_hire"], "owner": ["people.approve_hire"], "ceo": ["people.approve_hire"]}, "removed": {"director": ["payroll.review"], "ceo": ["payroll.approve", "finance.close_approve", "finance.reopen"]}}'::jsonb
WHERE EXISTS (SELECT 1 FROM "roles");

-- 4. Finance limits: only while they are still the plan's example values (a value the Owner set is never overwritten).
--    The Director approves up to PKR 5,000,000 and the Owner above that; the CEO tier goes. Entries waiting at the CEO's
--    old tier move to the Director, except entries the Director made, which stay with the CEO.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "approval_limits" WHERE "approver_level" = 3 AND "max_amount" = 50000)
     AND EXISTS (SELECT 1 FROM "approval_limits" WHERE "approver_level" = 2 AND "max_amount" = 500000) THEN
    DELETE FROM "approval_limits" WHERE "approver_level" = 2;
    UPDATE "approval_limits" SET "max_amount" = 5000000, "label" = 'Director (default limit, D25)', "updated_at" = now() WHERE "approver_level" = 3;
    UPDATE "approval_limits" SET "label" = 'Owner (above the Director limit; all capital and loan entries)', "updated_at" = now() WHERE "approver_level" = 1;
    UPDATE "journal_entries" e SET "required_level" = 3, "updated_at" = now()
    FROM "employees" m JOIN "levels" l ON l.id = m.level_id
    WHERE e.maker_id = m.id AND e.status = 'pending_approval' AND e.required_level = 2 AND l.number > 3;
    INSERT INTO "audit_log" ("actor_id", "action", "target_type", "target_id", "reason", "details")
    VALUES (NULL, 'finance.approval_limits.changed', 'settings', 'approval_limits',
      'Decision D25: the Director approves up to PKR 5,000,000, the Owner above; no CEO tier',
      '{"before": [{"approverLevel": 3, "maxAmount": "50000"}, {"approverLevel": 2, "maxAmount": "500000"}, {"approverLevel": 1, "maxAmount": null}], "after": [{"approverLevel": 3, "maxAmount": "5000000"}, {"approverLevel": 1, "maxAmount": null}]}'::jsonb);
  END IF;
END $$;
