-- Module 14, file sharing (plan section 19): files shared in conversations (attached to messages) and added to meetings,
-- with type and size limits, malware scanning (ClamAV), private storage and permission-checked downloads.
-- ADDITIVE ONLY: a new enum, a new table, indexes, constraints and a trigger on the new table. Nothing existing is changed.

-- CreateEnum
CREATE TYPE "comms_file_scan" AS ENUM ('scanning', 'clean', 'blocked');

-- CreateTable
CREATE TABLE "comms_files" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID,
    "message_id" UUID,
    "meeting_id" UUID,
    "uploader_id" UUID NOT NULL,
    "file_name" TEXT NOT NULL,
    "mime_type" TEXT NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "storage_key" TEXT NOT NULL,
    "scan_status" "comms_file_scan" NOT NULL DEFAULT 'scanning',
    "scan_signature" TEXT,
    "scanned_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "comms_files_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "comms_files_storage_key_key" ON "comms_files"("storage_key");

-- CreateIndex
CREATE INDEX "comms_files_message_id_idx" ON "comms_files"("message_id");

-- CreateIndex
CREATE INDEX "comms_files_meeting_id_idx" ON "comms_files"("meeting_id");

-- CreateIndex
CREATE INDEX "comms_files_conversation_id_idx" ON "comms_files"("conversation_id");

-- CreateIndex
CREATE INDEX "comms_files_scan_status_idx" ON "comms_files"("scan_status");

-- AddForeignKey
ALTER TABLE "comms_files" ADD CONSTRAINT "comms_files_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comms_files" ADD CONSTRAINT "comms_files_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comms_files" ADD CONSTRAINT "comms_files_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "comms_files" ADD CONSTRAINT "comms_files_uploader_id_fkey" FOREIGN KEY ("uploader_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ======================================================================================================================
-- Hand-written rules (Prisma cannot express them). Errors name the rule only ("(attachment_rule)").
-- ======================================================================================================================
ALTER TABLE "comms_files" ADD CONSTRAINT "comms_files_owner" CHECK (("conversation_id" IS NULL) <> ("meeting_id" IS NULL));
ALTER TABLE "comms_files" ADD CONSTRAINT "comms_files_message_in_conversation" CHECK ("message_id" IS NULL OR "conversation_id" IS NOT NULL);
ALTER TABLE "comms_files" ADD CONSTRAINT "comms_files_size" CHECK ("size_bytes" BETWEEN 1 AND 10485760);
ALTER TABLE "comms_files" ADD CONSTRAINT "comms_files_sha256" CHECK ("sha256" ~ '^[0-9a-f]{64}$');
ALTER TABLE "comms_files" ADD CONSTRAINT "comms_files_scanned" CHECK (("scan_status" = 'scanning') = ("scanned_at" IS NULL));
ALTER TABLE "comms_files" ADD CONSTRAINT "comms_files_signature" CHECK (("scan_status" = 'blocked') = ("scan_signature" IS NOT NULL));

-- A file record is never deleted. What was uploaded (who, where, the name, the type, the size, the hash, where the bytes
-- are) never changes. It is attached to one message at most once, and only to a message of its own conversation. Its
-- scan moves forward only: scanning, then clean or blocked, never back.
CREATE FUNCTION "protect_comms_file"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Shared files are never deleted (attachment_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF char_length(btrim(NEW."file_name")) NOT BETWEEN 1 AND 120 THEN
    RAISE EXCEPTION 'Invalid file name (attachment_rule)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."message_id" IS NOT NULL AND (TG_OP = 'INSERT' OR OLD."message_id" IS NULL)
     AND NOT EXISTS (SELECT 1 FROM "messages" m WHERE m."id" = NEW."message_id" AND m."conversation_id" = NEW."conversation_id") THEN
    RAISE EXCEPTION 'A file is attached to a message of its own conversation (attachment_rule)' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'INSERT' THEN
    IF NEW."scan_status" <> 'scanning' OR NEW."message_id" IS NOT NULL THEN
      RAISE EXCEPTION 'A new file starts unscanned and unattached (attachment_rule)' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."conversation_id" IS DISTINCT FROM OLD."conversation_id" OR NEW."meeting_id" IS DISTINCT FROM OLD."meeting_id"
     OR NEW."uploader_id" IS DISTINCT FROM OLD."uploader_id" OR NEW."file_name" IS DISTINCT FROM OLD."file_name"
     OR NEW."mime_type" IS DISTINCT FROM OLD."mime_type" OR NEW."size_bytes" IS DISTINCT FROM OLD."size_bytes"
     OR NEW."sha256" IS DISTINCT FROM OLD."sha256" OR NEW."storage_key" IS DISTINCT FROM OLD."storage_key"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'What was uploaded never changes (attachment_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."message_id" IS NOT NULL AND NEW."message_id" IS DISTINCT FROM OLD."message_id" THEN
    RAISE EXCEPTION 'A file stays with its message (attachment_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."scan_status" <> 'scanning' AND (NEW."scan_status" IS DISTINCT FROM OLD."scan_status" OR NEW."scanned_at" IS DISTINCT FROM OLD."scanned_at"
     OR NEW."scan_signature" IS DISTINCT FROM OLD."scan_signature") THEN
    RAISE EXCEPTION 'A finished scan never changes (attachment_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "comms_files_protect" BEFORE INSERT OR UPDATE OR DELETE ON "comms_files" FOR EACH ROW EXECUTE FUNCTION "protect_comms_file"();
