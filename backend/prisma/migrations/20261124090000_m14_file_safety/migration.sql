-- Module 14 file safety (review of the file sharing part): an index for the per-person upload limit, and a record that
-- the bytes of a file that was uploaded but never sent were discarded after the grace period.
-- ADDITIVE ONLY: one new NULLABLE column on comms_files (every existing row keeps NULL), a new index, a new CHECK that
-- every existing row satisfies, and a new trigger. No existing column, constraint, trigger or function is changed.

-- AlterTable
ALTER TABLE "comms_files" ADD COLUMN     "discarded_at" TIMESTAMPTZ(3);

-- CreateIndex
CREATE INDEX "comms_files_uploader_id_created_at_idx" ON "comms_files"("uploader_id", "created_at");

-- ======================================================================================================================
-- Hand-written rules (Prisma cannot express them). Errors name the rule only ("(attachment_rule)").
-- ======================================================================================================================
-- Only a conversation file that was never attached to a message can be discarded (a meeting file belongs to its meeting
-- from the start). Every existing row has NULL, so this holds for them.
ALTER TABLE "comms_files" ADD CONSTRAINT "comms_files_discard_unsent" CHECK ("discarded_at" IS NULL OR ("message_id" IS NULL AND "meeting_id" IS NULL));

-- A discarded file is never attached afterwards, and a discard is never undone or moved. Together with the CHECK above
-- this decides a race between "send the message with this file" and "discard the unsent file" at the database: whichever
-- commits first wins, the other one changes nothing (the application then refuses the send or skips the file).
CREATE FUNCTION "protect_comms_file_discard"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."discarded_at" IS NOT NULL THEN
      RAISE EXCEPTION 'A new file is not discarded (attachment_rule)' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF OLD."discarded_at" IS NOT NULL AND (NEW."discarded_at" IS DISTINCT FROM OLD."discarded_at" OR NEW."message_id" IS NOT NULL) THEN
    RAISE EXCEPTION 'A discarded file stays discarded and unattached (attachment_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "comms_files_discard_protect" BEFORE INSERT OR UPDATE ON "comms_files" FOR EACH ROW EXECUTE FUNCTION "protect_comms_file_discard"();
