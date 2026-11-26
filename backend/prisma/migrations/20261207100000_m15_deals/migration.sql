-- Module 15.2, deals and the pipeline (plan section 20): a deal is one sales opportunity with a company, in one of eight
-- stages; Lost needs a reason and a re-contact date; Won is asked for by the salesperson and confirmed by the sales
-- manager (never by the owner or the person who asked); every stage change and Won decision is kept.
-- ADDITIVE ONLY: four new enums, a sequence, two new tables, their indexes, constraints and triggers. Nothing existing is
-- changed (the foreign keys point at sales_leads, sales_companies and employees; none of them is altered).

-- CreateSequence (deal numbers DL-YYYY-NNNN)
CREATE SEQUENCE "sales_deal_seq" AS bigint START WITH 1 INCREMENT BY 1 MINVALUE 1 NO CYCLE;

-- CreateEnum
CREATE TYPE "sales_deal_stage" AS ENUM ('new', 'contacted', 'replied', 'meeting_booked', 'proposal_sent', 'negotiation', 'won', 'lost');

-- CreateEnum
CREATE TYPE "sales_deal_service" AS ENUM ('website', 'custom_software', 'ai_automation', 'mobile_app', 'ecommerce');

-- CreateEnum
CREATE TYPE "sales_won_status" AS ENUM ('none', 'pending', 'confirmed');

-- CreateEnum
CREATE TYPE "sales_deal_event" AS ENUM ('created', 'stage_changed', 'won_requested', 'won_rejected', 'won_confirmed', 'owner_changed');

-- CreateTable
CREATE TABLE "sales_deals" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "number" TEXT NOT NULL DEFAULT ((('DL-'::text || to_char(now(), 'YYYY'::text)) || '-'::text) || lpad((nextval('sales_deal_seq'::regclass))::text, 4, '0'::text)),
    "lead_id" UUID NOT NULL,
    "company_id" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "service" "sales_deal_service" NOT NULL,
    "value" DECIMAL(12,2) NOT NULL,
    "currency" "currency" NOT NULL,
    "expected_close" DATE NOT NULL,
    "stage" "sales_deal_stage" NOT NULL DEFAULT 'new',
    "next_step" TEXT,
    "next_step_date" DATE,
    "lost_reason" TEXT,
    "lost_note" TEXT,
    "recontact_after" DATE,
    "won_status" "sales_won_status" NOT NULL DEFAULT 'none',
    "won_requested_at" TIMESTAMPTZ(3),
    "won_requested_by_id" UUID,
    "won_confirmed_at" TIMESTAMPTZ(3),
    "won_confirmed_by_id" UUID,
    "closed_at" TIMESTAMPTZ(3),
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "sales_deals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_deal_history" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "deal_id" UUID NOT NULL,
    "event" "sales_deal_event" NOT NULL,
    "from_stage" "sales_deal_stage",
    "to_stage" "sales_deal_stage" NOT NULL,
    "actor_id" UUID,
    "reason" TEXT,
    "note" TEXT,
    "at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_deal_history_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_deals_number_key" ON "sales_deals"("number");

-- CreateIndex
CREATE INDEX "sales_deals_owner_id_stage_idx" ON "sales_deals"("owner_id", "stage");

-- CreateIndex
CREATE INDEX "sales_deals_lead_id_idx" ON "sales_deals"("lead_id");

-- CreateIndex
CREATE INDEX "sales_deals_company_id_idx" ON "sales_deals"("company_id");

-- CreateIndex
CREATE INDEX "sales_deals_stage_idx" ON "sales_deals"("stage");

-- CreateIndex
CREATE INDEX "sales_deal_history_deal_id_at_idx" ON "sales_deal_history"("deal_id", "at");

-- AddForeignKey
ALTER TABLE "sales_deals" ADD CONSTRAINT "sales_deals_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "sales_leads"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_deals" ADD CONSTRAINT "sales_deals_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "sales_companies"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_deals" ADD CONSTRAINT "sales_deals_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_deals" ADD CONSTRAINT "sales_deals_won_requested_by_id_fkey" FOREIGN KEY ("won_requested_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_deals" ADD CONSTRAINT "sales_deals_won_confirmed_by_id_fkey" FOREIGN KEY ("won_confirmed_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_deal_history" ADD CONSTRAINT "sales_deal_history_deal_id_fkey" FOREIGN KEY ("deal_id") REFERENCES "sales_deals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_deal_history" ADD CONSTRAINT "sales_deal_history_actor_id_fkey" FOREIGN KEY ("actor_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- ======================================================================================================================
-- Hand-written rules (Prisma cannot express them).

-- Plan section 20 in the database, so a bug can never store a deal that breaks it:
--  * every open deal has a next step with a date;
--  * Lost has a reason and the date after which the lead may be contacted again;
--  * Won is always a confirmed Won; a pending Won request sits in an open stage, with who asked and when;
--  * nobody confirms their own Won deal: the confirmer is neither the owner nor the person who asked.
ALTER TABLE "sales_deals" ADD CONSTRAINT "sales_deals_value_not_negative" CHECK ("value" >= 0);
ALTER TABLE "sales_deals" ADD CONSTRAINT "sales_deals_version_positive" CHECK ("version" >= 1);
ALTER TABLE "sales_deals" ADD CONSTRAINT "sales_deals_number_format" CHECK ("number" ~ '^DL-[0-9]{4}-[0-9]{4,}$');
ALTER TABLE "sales_deals" ADD CONSTRAINT "sales_deals_open_next_step" CHECK (
  "stage" IN ('won', 'lost')
  OR ("next_step" IS NOT NULL AND char_length(btrim("next_step")) >= 2 AND "next_step_date" IS NOT NULL)
);
ALTER TABLE "sales_deals" ADD CONSTRAINT "sales_deals_lost_record" CHECK (
  "stage" <> 'lost' OR ("lost_reason" IS NOT NULL AND "recontact_after" IS NOT NULL AND "closed_at" IS NOT NULL)
);
ALTER TABLE "sales_deals" ADD CONSTRAINT "sales_deals_won_record" CHECK (
  ("stage" = 'won') = ("won_status" = 'confirmed')
  AND ("won_status" <> 'confirmed' OR ("won_confirmed_at" IS NOT NULL AND "won_confirmed_by_id" IS NOT NULL AND "closed_at" IS NOT NULL))
  AND ("won_status" <> 'pending' OR ("stage" NOT IN ('won', 'lost') AND "won_requested_at" IS NOT NULL AND "won_requested_by_id" IS NOT NULL))
);
ALTER TABLE "sales_deals" ADD CONSTRAINT "sales_deals_no_self_confirmation" CHECK (
  "won_confirmed_by_id" IS NULL
  OR ("won_confirmed_by_id" <> "owner_id" AND "won_confirmed_by_id" IS DISTINCT FROM "won_requested_by_id")
);
ALTER TABLE "sales_deal_history" ADD CONSTRAINT "sales_deal_history_stage_change" CHECK (
  "event" <> 'stage_changed' OR ("from_stage" IS NOT NULL AND "from_stage" <> "to_stage")
);

-- Won and Lost are final (plan section 20): a closed deal keeps its stage, value, outcome and owner for ever (commission,
-- M15.7, reads them). Only its version, updated_* and archived_at may still change. The number never changes.
CREATE FUNCTION "protect_sales_deal"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW."number" <> OLD."number" THEN
    RAISE EXCEPTION 'A deal number never changes' USING ERRCODE = 'P0001';
  END IF;
  IF OLD."stage" IN ('won', 'lost') AND (
       NEW."stage" IS DISTINCT FROM OLD."stage" OR NEW."value" IS DISTINCT FROM OLD."value"
    OR NEW."currency" IS DISTINCT FROM OLD."currency" OR NEW."service" IS DISTINCT FROM OLD."service"
    OR NEW."owner_id" IS DISTINCT FROM OLD."owner_id" OR NEW."lead_id" IS DISTINCT FROM OLD."lead_id"
    OR NEW."company_id" IS DISTINCT FROM OLD."company_id" OR NEW."lost_reason" IS DISTINCT FROM OLD."lost_reason"
    OR NEW."recontact_after" IS DISTINCT FROM OLD."recontact_after" OR NEW."won_status" IS DISTINCT FROM OLD."won_status"
    OR NEW."won_confirmed_by_id" IS DISTINCT FROM OLD."won_confirmed_by_id" OR NEW."won_confirmed_at" IS DISTINCT FROM OLD."won_confirmed_at"
    OR NEW."closed_at" IS DISTINCT FROM OLD."closed_at"
  ) THEN
    RAISE EXCEPTION 'A Won or Lost deal is final (deal_closed)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "sales_deals_protect" BEFORE UPDATE ON "sales_deals" FOR EACH ROW EXECUTE FUNCTION "protect_sales_deal"();

-- Nothing important is hard-deleted (plan section 22). The function comes from the M15.1 migration.
CREATE TRIGGER "sales_deals_no_delete" BEFORE DELETE ON "sales_deals" FOR EACH ROW EXECUTE FUNCTION "prevent_sales_record_delete"();

-- The stage history is a record: insert-only, like the audit log.
CREATE TRIGGER "sales_deal_history_insert_only" BEFORE UPDATE OR DELETE ON "sales_deal_history"
  FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "sales_deal_history_no_truncate" BEFORE TRUNCATE ON "sales_deal_history"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();
