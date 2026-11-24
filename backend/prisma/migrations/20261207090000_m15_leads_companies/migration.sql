-- Module 15.1, leads and companies (plan section 20): one record per person and one per company, each lead with one owner,
-- and no duplicates: the email and the company's website domain are checked before a lead is saved.
-- ADDITIVE ONLY: two new enums, two new tables, their indexes, constraints and triggers. Nothing existing is changed
-- (the foreign keys point at employees and parties; neither table is altered).

-- CreateEnum
CREATE TYPE "sales_lead_source" AS ENUM ('apollo', 'fiverr', 'linkedin', 'referral', 'website', 'field', 'walk_in');

-- CreateEnum
CREATE TYPE "sales_email_check" AS ENUM ('unchecked', 'valid', 'invalid', 'catch_all', 'unknown');

-- CreateTable
CREATE TABLE "sales_companies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "name" TEXT NOT NULL,
    "website" TEXT,
    "domain" TEXT,
    "country" TEXT,
    "industry" TEXT,
    "party_id" UUID,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "sales_companies_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_leads" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "full_name" TEXT NOT NULL,
    "job_title" TEXT,
    "company_id" UUID,
    "email" TEXT,
    "email_normalized" TEXT,
    "phone" TEXT,
    "linkedin_url" TEXT,
    "country" TEXT,
    "industry" TEXT,
    "source" "sales_lead_source" NOT NULL,
    "owner_id" UUID NOT NULL,
    "email_check" "sales_email_check" NOT NULL DEFAULT 'unchecked',
    "email_checked_at" TIMESTAMPTZ(3),
    "notes" TEXT,
    "last_activity_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "version" INTEGER NOT NULL DEFAULT 1,
    "archived_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_by" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_by" UUID,

    CONSTRAINT "sales_leads_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_companies_name_idx" ON "sales_companies"("name");

-- CreateIndex
CREATE INDEX "sales_leads_owner_id_idx" ON "sales_leads"("owner_id");

-- CreateIndex
CREATE INDEX "sales_leads_company_id_idx" ON "sales_leads"("company_id");

-- CreateIndex
CREATE INDEX "sales_leads_last_activity_at_idx" ON "sales_leads"("last_activity_at");

-- AddForeignKey
ALTER TABLE "sales_companies" ADD CONSTRAINT "sales_companies_party_id_fkey" FOREIGN KEY ("party_id") REFERENCES "parties"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_company_id_fkey" FOREIGN KEY ("company_id") REFERENCES "sales_companies"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ======================================================================================================================
-- Hand-written rules (Prisma cannot express them).

-- No duplicates (plan section 20, "One owner, no duplicates"). The database is the real lock: two people saving the same
-- email or the same company domain at the same moment get exactly one row. Archived rows (M15.5) no longer count.
CREATE UNIQUE INDEX "sales_leads_email_active_key" ON "sales_leads"("email_normalized")
  WHERE "archived_at" IS NULL AND "email_normalized" IS NOT NULL;
CREATE UNIQUE INDEX "sales_companies_domain_active_key" ON "sales_companies"("domain")
  WHERE "archived_at" IS NULL AND "domain" IS NOT NULL;

-- The normalised values always follow the stored ones.
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_email_normalized" CHECK (
  ("email" IS NULL AND "email_normalized" IS NULL)
  OR ("email" IS NOT NULL AND "email_normalized" = lower(btrim("email")))
);
ALTER TABLE "sales_companies" ADD CONSTRAINT "sales_companies_domain_normalized" CHECK (
  "domain" IS NULL OR ("domain" = lower("domain") AND "domain" !~ '^www\.' AND char_length("domain") BETWEEN 1 AND 253)
);

-- Required text is never blank; versions start at 1.
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_full_name_length" CHECK (char_length(btrim("full_name")) BETWEEN 1 AND 200);
ALTER TABLE "sales_companies" ADD CONSTRAINT "sales_companies_name_length" CHECK (char_length(btrim("name")) BETWEEN 1 AND 200);
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_version_positive" CHECK ("version" >= 1);
ALTER TABLE "sales_companies" ADD CONSTRAINT "sales_companies_version_positive" CHECK ("version" >= 1);

-- Nothing important is hard-deleted (plan section 22): leads and companies are archived, never removed.
CREATE FUNCTION "prevent_sales_record_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Sales records in % are never deleted (they are archived instead)', TG_TABLE_NAME USING ERRCODE = 'P0001';
END $$;
CREATE TRIGGER "sales_leads_no_delete" BEFORE DELETE ON "sales_leads" FOR EACH ROW EXECUTE FUNCTION "prevent_sales_record_delete"();
CREATE TRIGGER "sales_companies_no_delete" BEFORE DELETE ON "sales_companies" FOR EACH ROW EXECUTE FUNCTION "prevent_sales_record_delete"();
