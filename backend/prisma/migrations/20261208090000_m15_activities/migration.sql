-- Module 15.3, activities and follow-ups (plan section 20): every lead and deal shows every contact in time order, with
-- who did it, when, and whether it was typed in by hand or came from a connected tool (Module 16, later). A deal's next
-- step is its follow-up; a completed follow-up is an activity. Proposals are links only (no files).
-- ADDITIVE ONLY: one new enum, one new table with its indexes, constraints and triggers, and one new NULLABLE column on the
-- M15.2 table sales_deals (proposal_url; every existing row keeps NULL) with a CHECK every existing row satisfies. No
-- existing column, constraint or trigger is changed.

-- CreateEnum
CREATE TYPE "sales_activity_kind" AS ENUM ('call', 'email_sent', 'reply', 'meeting', 'linkedin', 'whatsapp', 'fiverr', 'proposal', 'note', 'follow_up');

-- AlterTable
ALTER TABLE "sales_deals" ADD COLUMN     "proposal_url" TEXT;

-- CreateTable
CREATE TABLE "sales_activities" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "lead_id" UUID NOT NULL,
    "deal_id" UUID,
    "actor_id" UUID,
    "kind" "sales_activity_kind" NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "occurred_at" TIMESTAMPTZ(3) NOT NULL,
    "summary" TEXT NOT NULL,
    "meeting_at" TIMESTAMPTZ(3),
    "proposal_url" TEXT,
    "external_id" TEXT,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_activities_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_activities_lead_id_occurred_at_idx" ON "sales_activities"("lead_id", "occurred_at");

-- CreateIndex
CREATE INDEX "sales_activities_deal_id_occurred_at_idx" ON "sales_activities"("deal_id", "occurred_at");

-- CreateIndex
CREATE INDEX "sales_activities_actor_id_occurred_at_idx" ON "sales_activities"("actor_id", "occurred_at");

-- AddForeignKey
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "sales_leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "sales_deals"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ======================================================================================================================
-- Hand-written rules (Prisma cannot express them).

-- Where an activity came from: typed in by hand, or (Module 16) a connected tool. A manual entry has no tool id; a tool
-- id is unique per tool, so a sync that runs twice never records the same email or call twice.
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_source" CHECK ("source" IN ('manual', 'apollo', 'millionverifier', 'mailbox'));
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_manual_no_external_id" CHECK ("source" <> 'manual' OR "external_id" IS NULL);
CREATE UNIQUE INDEX "sales_activities_source_external_id_key" ON "sales_activities"("source", "external_id") WHERE "external_id" IS NOT NULL;

-- What each entry may carry: a meeting date only on a meeting, a link only on a proposal (and only a web address).
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_summary_length" CHECK (char_length(btrim("summary")) BETWEEN 1 AND 1000);
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_meeting_at" CHECK ("meeting_at" IS NULL OR "kind" = 'meeting');
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_proposal_url" CHECK (
  "proposal_url" IS NULL OR ("kind" = 'proposal' AND "proposal_url" ~* '^https?://' AND char_length("proposal_url") <= 500)
);
ALTER TABLE "sales_activities" ADD CONSTRAINT "sales_activities_follow_up_has_deal" CHECK ("kind" <> 'follow_up' OR "deal_id" IS NOT NULL);
ALTER TABLE "sales_deals" ADD CONSTRAINT "sales_deals_proposal_url" CHECK (
  "proposal_url" IS NULL OR ("proposal_url" ~* '^https?://' AND char_length("proposal_url") <= 500)
);

-- An activity about a deal is always on that deal's own lead.
CREATE FUNCTION "check_sales_activity_deal"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."deal_id" IS NOT NULL AND NOT EXISTS (SELECT 1 FROM "sales_deals" d WHERE d."id" = NEW."deal_id" AND d."lead_id" = NEW."lead_id") THEN
    RAISE EXCEPTION 'An activity about a deal belongs to that deal''s lead (activity_deal_lead)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "sales_activities_deal_lead" BEFORE INSERT ON "sales_activities" FOR EACH ROW EXECUTE FUNCTION "check_sales_activity_deal"();

-- The timeline is a record: insert-only (a mistake is corrected by a new entry), like the deal history.
CREATE TRIGGER "sales_activities_insert_only" BEFORE UPDATE OR DELETE ON "sales_activities"
  FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "sales_activities_no_truncate" BEFORE TRUNCATE ON "sales_activities"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();
