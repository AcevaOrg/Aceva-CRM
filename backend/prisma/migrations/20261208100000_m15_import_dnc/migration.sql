-- Module 15.4, the do-not-contact list and the lead import (plan section 20): "An unsubscribe or 'do not contact' request
-- is saved on the lead, and the system blocks that email from every future sequence"; leads are brought in "by uploading
-- the exported list. The system removes duplicates."
-- ADDITIVE ONLY: two new tables with their indexes, constraints and triggers, and two new NULLABLE columns on the M15.1
-- table sales_leads (dnc_at, import_batch_id; every existing row keeps NULL) with one new trigger every existing row
-- satisfies. No existing column, constraint or trigger is changed.

-- AlterTable
ALTER TABLE "sales_leads" ADD COLUMN     "dnc_at" TIMESTAMPTZ(3),
ADD COLUMN     "import_batch_id" UUID;

-- CreateTable
CREATE TABLE "sales_dnc_entries" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "email_hmac" TEXT,
    "key_id" TEXT,
    "masked_email" TEXT,
    "lead_id" UUID,
    "reason" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "created_by" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_dnc_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sales_import_batches" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "created_by" UUID NOT NULL,
    "owner_id" UUID NOT NULL,
    "source" "sales_lead_source" NOT NULL,
    "file_name" TEXT NOT NULL,
    "file_sha256" TEXT NOT NULL,
    "row_count" INTEGER NOT NULL,
    "rows" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'previewed',
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "committed_at" TIMESTAMPTZ(3),
    "result" JSONB,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sales_import_batches_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sales_dnc_entries_lead_id_idx" ON "sales_dnc_entries"("lead_id");

-- CreateIndex
CREATE INDEX "sales_dnc_entries_created_at_idx" ON "sales_dnc_entries"("created_at");

-- CreateIndex
CREATE INDEX "sales_import_batches_created_by_created_at_idx" ON "sales_import_batches"("created_by", "created_at");

-- AddForeignKey
ALTER TABLE "sales_leads" ADD CONSTRAINT "sales_leads_import_batch_id_fkey" FOREIGN KEY ("import_batch_id") REFERENCES "sales_import_batches"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_dnc_entries" ADD CONSTRAINT "sales_dnc_entries_lead_id_fkey" FOREIGN KEY ("lead_id") REFERENCES "sales_leads"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_dnc_entries" ADD CONSTRAINT "sales_dnc_entries_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_import_batches" ADD CONSTRAINT "sales_import_batches_created_by_fkey" FOREIGN KEY ("created_by") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales_import_batches" ADD CONSTRAINT "sales_import_batches_owner_id_fkey" FOREIGN KEY ("owner_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ======================================================================================================================
-- Hand-written rules (Prisma cannot express them).

-- The do-not-contact list keeps a keyed hash of the normalised email (HMAC-SHA256, hex) with the id of the key that made
-- it, and a masked form; never the email. An entry has an email hash, or a lead (a lead marked while it had no email), or
-- both. One entry per email and key. A manual entry names who added it; a tool's entry (Module 16) may have no person.
ALTER TABLE "sales_dnc_entries" ADD CONSTRAINT "sales_dnc_entries_source" CHECK ("source" IN ('manual', 'apollo', 'mailbox'));
ALTER TABLE "sales_dnc_entries" ADD CONSTRAINT "sales_dnc_entries_manual_has_person" CHECK ("source" <> 'manual' OR "created_by" IS NOT NULL);
ALTER TABLE "sales_dnc_entries" ADD CONSTRAINT "sales_dnc_entries_hash" CHECK (
  ("email_hmac" IS NULL AND "key_id" IS NULL AND "masked_email" IS NULL)
  OR ("email_hmac" ~ '^[0-9a-f]{64}$' AND "key_id" ~ '^[A-Za-z0-9_.-]{1,20}$' AND "masked_email" ~ '^.[*]{3}@[^@]+$')
);
ALTER TABLE "sales_dnc_entries" ADD CONSTRAINT "sales_dnc_entries_email_or_lead" CHECK ("email_hmac" IS NOT NULL OR "lead_id" IS NOT NULL);
ALTER TABLE "sales_dnc_entries" ADD CONSTRAINT "sales_dnc_entries_reason_length" CHECK (char_length(btrim("reason")) BETWEEN 3 AND 500);
CREATE UNIQUE INDEX "sales_dnc_entries_key_hmac_key" ON "sales_dnc_entries"("key_id", "email_hmac") WHERE "email_hmac" IS NOT NULL;

-- An entry is never changed or removed (approved decision 2), also after its lead is archived.
CREATE TRIGGER "sales_dnc_entries_insert_only" BEFORE UPDATE OR DELETE ON "sales_dnc_entries"
  FOR EACH ROW EXECUTE FUNCTION "prevent_modification"();
CREATE TRIGGER "sales_dnc_entries_no_truncate" BEFORE TRUNCATE ON "sales_dnc_entries"
  FOR EACH STATEMENT EXECUTE FUNCTION "prevent_modification"();

-- A do-not-contact request saved on a lead stays: once set, dnc_at never changes or goes back to empty.
CREATE FUNCTION "keep_sales_lead_dnc"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF OLD."dnc_at" IS NOT NULL AND NEW."dnc_at" IS DISTINCT FROM OLD."dnc_at" THEN
    RAISE EXCEPTION 'A do-not-contact request on a lead is never removed (dnc_permanent)' USING ERRCODE = 'P0001';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "sales_leads_keep_dnc" BEFORE UPDATE ON "sales_leads" FOR EACH ROW EXECUTE FUNCTION "keep_sales_lead_dnc"();

-- An import batch: a known status; committed exactly when it has a commit time and a result; the file's SHA-256; at most
-- 5,000 rows. Batches are records of who imported what and when: never deleted.
ALTER TABLE "sales_import_batches" ADD CONSTRAINT "sales_import_batches_status" CHECK ("status" IN ('previewed', 'committed', 'expired'));
ALTER TABLE "sales_import_batches" ADD CONSTRAINT "sales_import_batches_committed" CHECK (
  ("status" = 'committed') = ("committed_at" IS NOT NULL AND "result" IS NOT NULL)
);
ALTER TABLE "sales_import_batches" ADD CONSTRAINT "sales_import_batches_sha256" CHECK ("file_sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "sales_import_batches" ADD CONSTRAINT "sales_import_batches_row_count" CHECK ("row_count" BETWEEN 0 AND 5000);
ALTER TABLE "sales_import_batches" ADD CONSTRAINT "sales_import_batches_file_name" CHECK (char_length("file_name") BETWEEN 1 AND 255);
CREATE TRIGGER "sales_import_batches_no_delete" BEFORE DELETE ON "sales_import_batches" FOR EACH ROW EXECUTE FUNCTION "prevent_sales_record_delete"();
