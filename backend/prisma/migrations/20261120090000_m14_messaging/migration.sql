-- Module 14, part 1 (M14.1): conversations and messages (plan section 19).
-- ADDITIVE ONLY: new enums, new tables, indexes, CHECK constraints and triggers on the new tables. No existing table,
-- column, row or constraint is changed or removed.

-- CreateEnum
CREATE TYPE "conversation_kind" AS ENUM ('dm', 'group', 'channel');

-- CreateEnum
CREATE TYPE "channel_scope" AS ENUM ('department', 'project');

-- CreateEnum
CREATE TYPE "conversation_role" AS ENUM ('member', 'moderator');

-- CreateEnum
CREATE TYPE "message_revision_kind" AS ENUM ('edited', 'deleted', 'removed');

-- CreateTable
CREATE TABLE "conversations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "kind" "conversation_kind" NOT NULL,
    "channel_scope" "channel_scope",
    "name" TEXT,
    "topic" TEXT,
    "department_id" UUID,
    "project_name" TEXT,
    "project_code" TEXT,
    "dm_key" TEXT,
    "last_seq" INTEGER NOT NULL DEFAULT 0,
    "last_message_at" TIMESTAMPTZ(3),
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "archived_at" TIMESTAMPTZ(3),
    "archived_by_id" UUID,

    CONSTRAINT "conversations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_members" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "role" "conversation_role" NOT NULL DEFAULT 'member',
    "added_by_id" UUID,
    "joined_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "left_at" TIMESTAMPTZ(3),
    "removed_by_id" UUID,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_members_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "conversation_reads" (
    "conversation_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "last_delivered_seq" INTEGER NOT NULL DEFAULT 0,
    "last_read_seq" INTEGER NOT NULL DEFAULT 0,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "conversation_reads_pkey" PRIMARY KEY ("conversation_id","employee_id")
);

-- CreateTable
CREATE TABLE "messages" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "conversation_id" UUID NOT NULL,
    "seq" INTEGER NOT NULL,
    "author_id" UUID NOT NULL,
    "parent_id" UUID,
    "body" TEXT NOT NULL,
    "client_key" UUID NOT NULL,
    "request_hash" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "edited_at" TIMESTAMPTZ(3),
    "revision" INTEGER NOT NULL DEFAULT 0,
    "deleted_at" TIMESTAMPTZ(3),
    "deleted_by_id" UUID,
    "deleted_as" "message_revision_kind",

    CONSTRAINT "messages_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_revisions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "message_id" UUID NOT NULL,
    "revision" INTEGER NOT NULL,
    "kind" "message_revision_kind" NOT NULL,
    "body" TEXT NOT NULL,
    "changed_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "message_mentions" (
    "message_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_mentions_pkey" PRIMARY KEY ("message_id","employee_id")
);

-- CreateTable
CREATE TABLE "message_reactions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "message_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "emoji" TEXT NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_reactions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "saved_messages" (
    "employee_id" UUID NOT NULL,
    "message_id" UUID NOT NULL,
    "saved_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "saved_messages_pkey" PRIMARY KEY ("employee_id","message_id")
);

-- CreateTable
CREATE TABLE "pinned_messages" (
    "message_id" UUID NOT NULL,
    "conversation_id" UUID NOT NULL,
    "pinned_by_id" UUID NOT NULL,
    "pinned_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "pinned_messages_pkey" PRIMARY KEY ("message_id")
);

-- CreateIndex
CREATE UNIQUE INDEX "conversations_dm_key_key" ON "conversations"("dm_key");

-- CreateIndex
CREATE INDEX "conversations_department_id_idx" ON "conversations"("department_id");

-- CreateIndex
CREATE INDEX "conversations_kind_idx" ON "conversations"("kind");

-- CreateIndex
CREATE INDEX "conversation_members_employee_id_idx" ON "conversation_members"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "conversation_members_conversation_id_employee_id_key" ON "conversation_members"("conversation_id", "employee_id");

-- CreateIndex
CREATE INDEX "conversation_reads_employee_id_idx" ON "conversation_reads"("employee_id");

-- CreateIndex
CREATE INDEX "messages_conversation_id_parent_id_seq_idx" ON "messages"("conversation_id", "parent_id", "seq");

-- CreateIndex
CREATE INDEX "messages_author_id_created_at_idx" ON "messages"("author_id", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "messages_conversation_id_seq_key" ON "messages"("conversation_id", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "messages_author_id_client_key_key" ON "messages"("author_id", "client_key");

-- CreateIndex
CREATE UNIQUE INDEX "message_revisions_message_id_revision_key" ON "message_revisions"("message_id", "revision");

-- CreateIndex
CREATE INDEX "message_mentions_employee_id_idx" ON "message_mentions"("employee_id");

-- CreateIndex
CREATE UNIQUE INDEX "message_reactions_message_id_employee_id_emoji_key" ON "message_reactions"("message_id", "employee_id", "emoji");

-- CreateIndex
CREATE INDEX "saved_messages_employee_id_saved_at_idx" ON "saved_messages"("employee_id", "saved_at");

-- CreateIndex
CREATE INDEX "pinned_messages_conversation_id_idx" ON "pinned_messages"("conversation_id");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "messages" ADD CONSTRAINT "messages_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "messages"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_revisions" ADD CONSTRAINT "message_revisions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_mentions" ADD CONSTRAINT "message_mentions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_messages" ADD CONSTRAINT "saved_messages_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "saved_messages" ADD CONSTRAINT "saved_messages_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pinned_messages" ADD CONSTRAINT "pinned_messages_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ======================================================================================================================
-- Hand-written rules (Prisma cannot express them).
--
-- PRIVACY: a CHECK or NOT NULL failure makes PostgreSQL report "Failing row contains (...)", which would copy a
-- message's text into the database log and the application's error. So the messages and message_revisions tables have
-- NO CHECK constraints: their rules live in BEFORE triggers that run first and raise errors naming the rule only
-- ("(message_rule)"), never a value. Unique and foreign-key errors name only ids and keys.
-- ======================================================================================================================

-- ---- Conversations --------------------------------------------------------------------------------------------------
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_has_scope" CHECK (("kind" = 'channel') = ("channel_scope" IS NOT NULL));
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_dm_has_key" CHECK (("kind" = 'dm') = ("dm_key" IS NOT NULL));
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_department_scope" CHECK (CASE WHEN "channel_scope" = 'department' THEN "department_id" IS NOT NULL ELSE "department_id" IS NULL END);
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_scope" CHECK (CASE WHEN "channel_scope" = 'project' THEN "project_name" IS NOT NULL ELSE "project_name" IS NULL AND "project_code" IS NULL END);
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_channel_named" CHECK ("kind" <> 'channel' OR "name" IS NOT NULL);
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_dm_unnamed" CHECK ("kind" <> 'dm' OR ("name" IS NULL AND "topic" IS NULL));
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_name_length" CHECK ("name" IS NULL OR char_length(btrim("name")) BETWEEN 1 AND 80);
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_topic_length" CHECK ("topic" IS NULL OR char_length("topic") <= 300);
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_length" CHECK (("project_name" IS NULL OR char_length(btrim("project_name")) BETWEEN 1 AND 120) AND ("project_code" IS NULL OR char_length(btrim("project_code")) BETWEEN 1 AND 40));
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_last_seq" CHECK ("last_seq" >= 0);
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_archived_by" CHECK (("archived_at" IS NULL) = ("archived_by_id" IS NULL));

-- What a conversation is never changes; its counter only goes up; it is never deleted.
CREATE FUNCTION "protect_conversation"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Conversations are never deleted (conversation_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."kind" IS DISTINCT FROM OLD."kind" OR NEW."channel_scope" IS DISTINCT FROM OLD."channel_scope"
     OR NEW."dm_key" IS DISTINCT FROM OLD."dm_key" OR NEW."department_id" IS DISTINCT FROM OLD."department_id"
     OR NEW."created_by_id" IS DISTINCT FROM OLD."created_by_id" OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'The kind, scope and creator of a conversation never change (conversation_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."last_seq" < OLD."last_seq" THEN
    RAISE EXCEPTION 'Message numbers never go back (conversation_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "conversations_protect" BEFORE UPDATE OR DELETE ON "conversations" FOR EACH ROW EXECUTE FUNCTION "protect_conversation"();

-- ---- Members and read positions -------------------------------------------------------------------------------------
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_left" CHECK ("left_at" IS NULL OR "left_at" >= "joined_at");

CREATE FUNCTION "prevent_delete"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Rows of % are never deleted', TG_TABLE_NAME USING ERRCODE = 'integrity_constraint_violation';
END $$;
CREATE TRIGGER "conversation_members_no_delete" BEFORE DELETE ON "conversation_members" FOR EACH ROW EXECUTE FUNCTION "prevent_delete"();

ALTER TABLE "conversation_reads" ADD CONSTRAINT "conversation_reads_seq" CHECK ("last_read_seq" >= 0 AND "last_delivered_seq" >= "last_read_seq");

-- ---- Messages -------------------------------------------------------------------------------------------------------
CREATE FUNCTION "protect_message"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  parent_conversation uuid;
  parent_parent uuid;
  allocated integer;
BEGIN
  -- These errors name the rule only. They must never include the row (its text is private).
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Messages are never deleted (message_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."conversation_id" IS NULL OR NEW."seq" IS NULL OR NEW."author_id" IS NULL OR NEW."client_key" IS NULL
     OR NEW."request_hash" IS NULL OR NEW."created_at" IS NULL OR NEW."revision" IS NULL OR NEW."body" IS NULL THEN
    RAISE EXCEPTION 'A message is missing a required value (message_rule)' USING ERRCODE = 'not_null_violation';
  END IF;
  IF char_length(NEW."body") > 4000 THEN
    RAISE EXCEPTION 'A message can be at most 4000 characters (message_rule)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."seq" < 1 OR NEW."revision" < 0 THEN
    RAISE EXCEPTION 'Invalid message number or revision (message_rule)' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW."deleted_at" IS NULL THEN
    IF btrim(NEW."body") = '' THEN
      RAISE EXCEPTION 'A message cannot be empty (message_rule)' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."deleted_as" IS NOT NULL OR NEW."deleted_by_id" IS NOT NULL THEN
      RAISE EXCEPTION 'Only a deleted message has a deletion record (message_rule)' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    IF NEW."body" <> '' OR NEW."deleted_by_id" IS NULL OR NEW."deleted_as" IS NULL OR NEW."deleted_as" = 'edited' THEN
      RAISE EXCEPTION 'A deleted message keeps only an empty placeholder (message_rule)' USING ERRCODE = 'check_violation';
    END IF;
  END IF;

  IF TG_OP = 'INSERT' THEN
    IF NEW."deleted_at" IS NOT NULL OR NEW."edited_at" IS NOT NULL OR NEW."revision" <> 0 THEN
      RAISE EXCEPTION 'A new message starts as its first version (message_rule)' USING ERRCODE = 'check_violation';
    END IF;
    SELECT "last_seq" INTO allocated FROM "conversations" WHERE "id" = NEW."conversation_id";
    IF allocated IS NULL OR NEW."seq" > allocated THEN
      RAISE EXCEPTION 'A message number must be given out by its conversation (message_rule)' USING ERRCODE = 'check_violation';
    END IF;
    IF NEW."parent_id" IS NOT NULL THEN
      SELECT "conversation_id", "parent_id" INTO parent_conversation, parent_parent FROM "messages" WHERE "id" = NEW."parent_id";
      IF parent_conversation IS DISTINCT FROM NEW."conversation_id" OR parent_parent IS NOT NULL THEN
        RAISE EXCEPTION 'A reply must answer a top-level message of the same conversation (message_rule)' USING ERRCODE = 'check_violation';
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- UPDATE: only the text (with its older version kept) and the deletion can change.
  IF NEW."conversation_id" IS DISTINCT FROM OLD."conversation_id" OR NEW."seq" IS DISTINCT FROM OLD."seq"
     OR NEW."author_id" IS DISTINCT FROM OLD."author_id" OR NEW."parent_id" IS DISTINCT FROM OLD."parent_id"
     OR NEW."client_key" IS DISTINCT FROM OLD."client_key" OR NEW."request_hash" IS DISTINCT FROM OLD."request_hash"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'Only the text of a message can change (message_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF OLD."deleted_at" IS NOT NULL THEN
    RAISE EXCEPTION 'A deleted message cannot be changed (message_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."body" IS DISTINCT FROM OLD."body" AND NEW."revision" <> OLD."revision" + 1 THEN
    RAISE EXCEPTION 'The older version of a message must be kept (message_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."revision" <> OLD."revision" AND NOT EXISTS (SELECT 1 FROM "message_revisions" WHERE "message_id" = NEW."id" AND "revision" = NEW."revision") THEN
    RAISE EXCEPTION 'The older version of a message must be kept (message_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "messages_protect" BEFORE INSERT OR UPDATE OR DELETE ON "messages" FOR EACH ROW EXECUTE FUNCTION "protect_message"();

-- Older versions: insert-only, same privacy rule for errors.
CREATE FUNCTION "protect_message_revision"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Older versions of messages are insert-only (message_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."message_id" IS NULL OR NEW."revision" IS NULL OR NEW."kind" IS NULL OR NEW."body" IS NULL OR NEW."changed_by_id" IS NULL OR NEW."created_at" IS NULL THEN
    RAISE EXCEPTION 'An older version is missing a required value (message_rule)' USING ERRCODE = 'not_null_violation';
  END IF;
  IF char_length(NEW."body") > 4000 OR NEW."revision" < 1 THEN
    RAISE EXCEPTION 'Invalid older version (message_rule)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "message_revisions_protect" BEFORE INSERT OR UPDATE OR DELETE ON "message_revisions" FOR EACH ROW EXECUTE FUNCTION "protect_message_revision"();

-- Full-text search (PostgreSQL only, no other search engine). "simple" = no language-specific word stemming, because
-- messages mix English and Roman Urdu. A deleted message has an empty body, so it is never found.
CREATE INDEX "messages_search_idx" ON "messages" USING GIN (to_tsvector('simple', "body"));

-- ---- Reactions and pins ---------------------------------------------------------------------------------------------
ALTER TABLE "message_reactions" ADD CONSTRAINT "message_reactions_emoji" CHECK (char_length("emoji") BETWEEN 1 AND 16);

-- A pin belongs to the conversation of its message.
CREATE FUNCTION "check_pinned_message"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM "messages" WHERE "id" = NEW."message_id" AND "conversation_id" = NEW."conversation_id") THEN
    RAISE EXCEPTION 'A pinned message must belong to the conversation (message_rule)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "pinned_messages_check" BEFORE INSERT OR UPDATE ON "pinned_messages" FOR EACH ROW EXECUTE FUNCTION "check_pinned_message"();

-- ======================================================================================================================
-- Message history starts when a person becomes a member (M14.1 review): generated part, then the rules.
-- ======================================================================================================================
-- AlterTable
ALTER TABLE "conversation_members" ADD COLUMN     "joined_seq" INTEGER NOT NULL DEFAULT 0;

-- CreateTable
CREATE TABLE "department_channel_access" (
    "conversation_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "from_seq" INTEGER NOT NULL,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "department_channel_access_pkey" PRIMARY KEY ("conversation_id","employee_id")
);

-- CreateIndex
CREATE INDEX "department_channel_access_employee_id_idx" ON "department_channel_access"("employee_id");

-- AddForeignKey
ALTER TABLE "department_channel_access" ADD CONSTRAINT "department_channel_access_conversation_id_fkey" FOREIGN KEY ("conversation_id") REFERENCES "conversations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "department_channel_access" ADD CONSTRAINT "department_channel_access_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ---- History starts when you join (review decision on M14.1) ---------------------------------------------------------
-- A person sees only messages sent after they became a member. For people added by hand that is
-- conversation_members.joined_seq (set by the application under the conversation's row lock). For department channel
-- members it is department_channel_access.from_seq, written HERE by triggers on the employee and department records, so
-- a hire, a transfer or a new department head is covered whichever code path (or script) makes the change. Message
-- numbers are used, not times, so the database clock and the application clock are never compared.
ALTER TABLE "conversation_members" ADD CONSTRAINT "conversation_members_joined_seq" CHECK ("joined_seq" >= 0);
ALTER TABLE "department_channel_access" ADD CONSTRAINT "department_channel_access_from_seq" CHECK ("from_seq" >= 0);

-- Someone hired into, or moved into, a department starts at each of its channels' current message number. The head of
-- that department was already a member (through being its head) and keeps their history.
--
-- Concurrency: each channel row is LOCKED (in id order) before its number is read. A message being sent holds that row's
-- lock until it commits, so this waits for it and then reads the number including it (the message counts as history).
-- While this transaction holds the locks no new message can be numbered, so every message after from_seq is committed
-- after the person joined. Sends take only KEY SHARE locks on employee rows (foreign keys), which do not conflict with
-- the department change, so the two cannot deadlock.
CREATE FUNCTION "comms_department_member_joined"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  channel record;
BEGIN
  IF TG_OP = 'UPDATE' AND NEW."department_id" IS NOT DISTINCT FROM OLD."department_id" THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM "departments" d WHERE d."id" = NEW."department_id" AND d."head_employee_id" = NEW."id") THEN
    RETURN NEW;
  END IF;
  FOR channel IN
    SELECT c."id", c."last_seq" FROM "conversations" c
    WHERE c."channel_scope" = 'department' AND c."department_id" = NEW."department_id"
    ORDER BY c."id" FOR UPDATE
  LOOP
    INSERT INTO "department_channel_access" ("conversation_id", "employee_id", "from_seq", "updated_at")
    VALUES (channel."id", NEW."id", channel."last_seq", now())
    ON CONFLICT ("conversation_id", "employee_id") DO UPDATE SET "from_seq" = EXCLUDED."from_seq", "updated_at" = EXCLUDED."updated_at";
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER "employees_comms_department_joined" AFTER INSERT OR UPDATE OF "department_id" ON "employees"
  FOR EACH ROW EXECUTE FUNCTION "comms_department_member_joined"();

-- A new department head starts at the current message number, unless they already work in that department.
-- (Same locking as above.)
CREATE FUNCTION "comms_department_head_joined"() RETURNS trigger LANGUAGE plpgsql AS $$
DECLARE
  channel record;
BEGIN
  IF NEW."head_employee_id" IS NULL OR (TG_OP = 'UPDATE' AND NEW."head_employee_id" IS NOT DISTINCT FROM OLD."head_employee_id") THEN
    RETURN NEW;
  END IF;
  IF EXISTS (SELECT 1 FROM "employees" e WHERE e."id" = NEW."head_employee_id" AND e."department_id" = NEW."id") THEN
    RETURN NEW;
  END IF;
  FOR channel IN
    SELECT c."id", c."last_seq" FROM "conversations" c
    WHERE c."channel_scope" = 'department' AND c."department_id" = NEW."id"
    ORDER BY c."id" FOR UPDATE
  LOOP
    INSERT INTO "department_channel_access" ("conversation_id", "employee_id", "from_seq", "updated_at")
    VALUES (channel."id", NEW."head_employee_id", channel."last_seq", now())
    ON CONFLICT ("conversation_id", "employee_id") DO UPDATE SET "from_seq" = EXCLUDED."from_seq", "updated_at" = EXCLUDED."updated_at";
  END LOOP;
  RETURN NEW;
END $$;
CREATE TRIGGER "departments_comms_head_joined" AFTER INSERT OR UPDATE OF "head_employee_id" ON "departments"
  FOR EACH ROW EXECUTE FUNCTION "comms_department_head_joined"();
