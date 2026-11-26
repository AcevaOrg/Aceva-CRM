-- Module 14, announcements (plan section 19): company-wide or for chosen departments, optionally pinned, optionally
-- asking each person to acknowledge them.
-- ADDITIVE ONLY: new tables, indexes, constraints and triggers on the new tables. Nothing existing is changed.

-- CreateTable
CREATE TABLE "announcements" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "author_id" UUID NOT NULL,
    "audience_all" BOOLEAN NOT NULL,
    "requires_ack" BOOLEAN NOT NULL,
    "pinned" BOOLEAN NOT NULL DEFAULT false,
    "pinned_at" TIMESTAMPTZ(3),
    "pinned_by_id" UUID,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcements_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "announcement_departments" (
    "announcement_id" UUID NOT NULL,
    "department_id" UUID NOT NULL,

    CONSTRAINT "announcement_departments_pkey" PRIMARY KEY ("announcement_id","department_id")
);

-- CreateTable
CREATE TABLE "announcement_acks" (
    "announcement_id" UUID NOT NULL,
    "employee_id" UUID NOT NULL,
    "acked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "announcement_acks_pkey" PRIMARY KEY ("announcement_id","employee_id")
);

-- CreateIndex
CREATE INDEX "announcements_created_at_idx" ON "announcements"("created_at");

-- CreateIndex
CREATE INDEX "announcement_departments_department_id_idx" ON "announcement_departments"("department_id");

-- CreateIndex
CREATE INDEX "announcement_acks_employee_id_idx" ON "announcement_acks"("employee_id");

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_author_id_fkey" FOREIGN KEY ("author_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_pinned_by_id_fkey" FOREIGN KEY ("pinned_by_id") REFERENCES "employees"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_departments" ADD CONSTRAINT "announcement_departments_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_departments" ADD CONSTRAINT "announcement_departments_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_acks" ADD CONSTRAINT "announcement_acks_announcement_id_fkey" FOREIGN KEY ("announcement_id") REFERENCES "announcements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "announcement_acks" ADD CONSTRAINT "announcement_acks_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ======================================================================================================================
-- Hand-written rules (Prisma cannot express them).
-- ======================================================================================================================
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_title_length" CHECK (char_length(btrim("title")) BETWEEN 1 AND 150);
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_body_length" CHECK (char_length(btrim("body")) BETWEEN 1 AND 5000);
ALTER TABLE "announcements" ADD CONSTRAINT "announcements_pin_record" CHECK ("pinned" = ("pinned_at" IS NOT NULL));

-- An announcement is never deleted, and what was announced (text, author, audience, acknowledgement rule, time) never
-- changes: only whether it is pinned.
CREATE FUNCTION "protect_announcement"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Announcements are never deleted (announcement_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NEW."title" IS DISTINCT FROM OLD."title" OR NEW."body" IS DISTINCT FROM OLD."body" OR NEW."author_id" IS DISTINCT FROM OLD."author_id"
     OR NEW."audience_all" IS DISTINCT FROM OLD."audience_all" OR NEW."requires_ack" IS DISTINCT FROM OLD."requires_ack"
     OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
    RAISE EXCEPTION 'Only the pin of an announcement can change (announcement_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "announcements_protect" BEFORE UPDATE OR DELETE ON "announcements" FOR EACH ROW EXECUTE FUNCTION "protect_announcement"();

-- The audience is fixed when it is published.
CREATE FUNCTION "protect_announcement_department"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'The audience of an announcement never changes (announcement_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF EXISTS (SELECT 1 FROM "announcements" a WHERE a."id" = NEW."announcement_id" AND a."audience_all") THEN
    RAISE EXCEPTION 'An announcement for everyone has no departments (announcement_rule)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "announcement_departments_protect" BEFORE INSERT OR UPDATE OR DELETE ON "announcement_departments" FOR EACH ROW EXECUTE FUNCTION "protect_announcement_department"();

-- Acknowledgements are insert-only, and only for an announcement that asks for them.
CREATE FUNCTION "protect_announcement_ack"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'Acknowledgements are insert-only (announcement_rule)' USING ERRCODE = 'integrity_constraint_violation';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM "announcements" a WHERE a."id" = NEW."announcement_id" AND a."requires_ack") THEN
    RAISE EXCEPTION 'This announcement does not ask for acknowledgement (announcement_rule)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "announcement_acks_protect" BEFORE INSERT OR UPDATE OR DELETE ON "announcement_acks" FOR EACH ROW EXECUTE FUNCTION "protect_announcement_ack"();
