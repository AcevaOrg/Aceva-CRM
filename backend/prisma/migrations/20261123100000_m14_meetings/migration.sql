-- Module 14, meetings (plan section 19): create a meeting, invite participants, set the date and time, share an agenda,
-- keep notes; invitees answer yes, no or maybe. Calendar integration is not part of this (it needs management approval).
-- ADDITIVE ONLY: a new enum, new tables, indexes, constraints and triggers on the new tables. Nothing existing is changed.

-- CreateEnum
CREATE TYPE "meeting_rsvp" AS ENUM ('pending', 'yes', 'no', 'maybe');

-- CreateTable
CREATE TABLE "meetings" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "starts_at" TIMESTAMPTZ(3) NOT NULL,
    "duration_min" INTEGER NOT NULL,
    "location" TEXT NOT NULL,
    "agenda" TEXT NOT NULL DEFAULT '',
    "notes" TEXT,
    "notes_updated_at" TIMESTAMPTZ(3),
    "notes_updated_by_id" UUID,
    "organizer_id" UUID NOT NULL,
    "cancelled_at" TIMESTAMPTZ(3),
    "cancelled_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meetings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "meeting_participants" (
    "meeting_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "rsvp" "meeting_rsvp" NOT NULL DEFAULT 'pending',
    "responded_at" TIMESTAMPTZ(3),
    "invited_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "invited_by_id" UUID NOT NULL,

    CONSTRAINT "meeting_participants_pkey" PRIMARY KEY ("meeting_id","employee_id")
);

-- CreateIndex
CREATE INDEX "meetings_organizer_id_starts_at_idx" ON "meetings"("organizer_id", "starts_at");

-- CreateIndex
CREATE INDEX "meetings_starts_at_idx" ON "meetings"("starts_at");

-- CreateIndex
CREATE INDEX "meeting_participants_employee_id_idx" ON "meeting_participants"("employee_id");

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_notes_updated_by_id_fkey" FOREIGN KEY ("notes_updated_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_organizer_id_fkey" FOREIGN KEY ("organizer_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_cancelled_by_id_fkey" FOREIGN KEY ("cancelled_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_participants" ADD CONSTRAINT "meeting_participants_invited_by_id_fkey" FOREIGN KEY ("invited_by_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ======================================================================================================================
-- Hand-written rules (Prisma cannot express them).
--
-- PRIVACY: the agenda and the notes can hold private matters, so (as for messages) the text rules live in a BEFORE
-- trigger whose errors name the rule only ("(meeting_rule)"). A CHECK failure would copy the whole row into the database
-- log ("Failing row contains ..."). The CHECKs below are only on columns without free text.
-- ======================================================================================================================
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_duration" CHECK ("duration_min" BETWEEN 5 AND 480);
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_cancelled_by" CHECK (("cancelled_at" IS NULL) = ("cancelled_by_id" IS NULL));
ALTER TABLE "meetings" ADD CONSTRAINT "meetings_notes_by" CHECK (("notes_updated_at" IS NULL) = ("notes_updated_by_id" IS NULL));

CREATE FUNCTION "protect_meeting"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Meetings are never deleted (meeting_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF char_length(btrim(NEW."title")) NOT BETWEEN 1 AND 150 OR char_length(btrim(NEW."location")) NOT BETWEEN 1 AND 150
     OR char_length(NEW."agenda") > 5000 OR char_length(COALESCE(NEW."notes", '')) > 20000 THEN
    RAISE EXCEPTION 'A meeting text is empty or too long (meeting_rule)' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' THEN
    IF NEW."organizer_id" IS DISTINCT FROM OLD."organizer_id" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'The organizer of a meeting never changes (meeting_rule)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
    IF OLD."cancelled_at" IS NOT NULL THEN
      RAISE EXCEPTION 'A cancelled meeting cannot be changed (meeting_rule)' USING ERRCODE = 'integrity_constraint_violation';
    END IF;
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "meetings_protect" BEFORE INSERT OR UPDATE OR DELETE ON "meetings" FOR EACH ROW EXECUTE FUNCTION "protect_meeting"();

-- Invitations are never withdrawn; only the answer changes, and never once the meeting is cancelled. The organizer is not
-- an invitee of their own meeting.
CREATE FUNCTION "protect_meeting_participant"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Meeting invitations are never deleted (meeting_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "meetings" m WHERE m."id" = NEW."meeting_id" AND (m."cancelled_at" IS NOT NULL OR m."organizer_id" = NEW."employee_id")) THEN
    RAISE EXCEPTION 'Not for a cancelled meeting or its organizer (meeting_rule)' USING ERRCODE = 'check_violation';
  END IF;
  IF TG_OP = 'UPDATE' AND (NEW."meeting_id" IS DISTINCT FROM OLD."meeting_id" OR NEW."employee_id" IS DISTINCT FROM OLD."employee_id"
     OR NEW."invited_at" IS DISTINCT FROM OLD."invited_at" OR NEW."invited_by_id" IS DISTINCT FROM OLD."invited_by_id") THEN
    RAISE EXCEPTION 'Only the answer to an invitation changes (meeting_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "meeting_participants_protect" BEFORE INSERT OR UPDATE OR DELETE ON "meeting_participants" FOR EACH ROW EXECUTE FUNCTION "protect_meeting_participant"();
