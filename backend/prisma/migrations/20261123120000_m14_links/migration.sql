-- Module 14, links to related tasks and projects (plan section 19: "links to related tasks or projects"), using the
-- Module 5 tasks and projects: a message linked to a task, tasks linked to a meeting, and project channels tied to a
-- Module 5 project.
-- ADDITIVE ONLY: new tables, one new NULLABLE column on conversations (existing rows keep NULL), a new foreign key, a
-- new CHECK that every existing row already satisfies (NULL), indexes and triggers on the new tables. No existing
-- column, constraint, trigger or row is changed.

-- AlterTable
ALTER TABLE "conversations" ADD COLUMN     "project_id" UUID;

-- CreateTable
CREATE TABLE "message_task_links" (
    "message_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "linked_by_id" UUID NOT NULL,
    "linked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "message_task_links_pkey" PRIMARY KEY ("message_id")
);

-- CreateTable
CREATE TABLE "meeting_task_links" (
    "meeting_id" UUID NOT NULL,
    "task_id" UUID NOT NULL,
    "linked_by_id" UUID NOT NULL,
    "linked_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "meeting_task_links_pkey" PRIMARY KEY ("meeting_id","task_id")
);

-- CreateIndex
CREATE INDEX "conversations_project_id_idx" ON "conversations"("project_id");

-- CreateIndex
CREATE INDEX "message_task_links_task_id_idx" ON "message_task_links"("task_id");

-- CreateIndex
CREATE INDEX "meeting_task_links_task_id_idx" ON "meeting_task_links"("task_id");

-- AddForeignKey
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_id_fkey" FOREIGN KEY ("project_id") REFERENCES "projects"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_task_links" ADD CONSTRAINT "message_task_links_message_id_fkey" FOREIGN KEY ("message_id") REFERENCES "messages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_task_links" ADD CONSTRAINT "message_task_links_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "message_task_links" ADD CONSTRAINT "message_task_links_linked_by_id_fkey" FOREIGN KEY ("linked_by_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_task_links" ADD CONSTRAINT "meeting_task_links_meeting_id_fkey" FOREIGN KEY ("meeting_id") REFERENCES "meetings"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_task_links" ADD CONSTRAINT "meeting_task_links_task_id_fkey" FOREIGN KEY ("task_id") REFERENCES "tasks"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "meeting_task_links" ADD CONSTRAINT "meeting_task_links_linked_by_id_fkey" FOREIGN KEY ("linked_by_id") REFERENCES "employees"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ======================================================================================================================
-- Hand-written rules (Prisma cannot express them). Errors name the rule only.
-- ======================================================================================================================
-- Only a project channel belongs to a project (every existing row has NULL, so this holds for them).
ALTER TABLE "conversations" ADD CONSTRAINT "conversations_project_link" CHECK ("project_id" IS NULL OR "channel_scope" = 'project');

-- A personal to-do is private to its owner: it is never linked to a message or a meeting (that would show it to others).
CREATE FUNCTION "check_comms_task_link"() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF EXISTS (SELECT 1 FROM "tasks" t WHERE t."id" = NEW."task_id" AND t."personal") THEN
    RAISE EXCEPTION 'A personal to-do cannot be linked (message_rule)' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER "message_task_links_check" BEFORE INSERT OR UPDATE ON "message_task_links" FOR EACH ROW EXECUTE FUNCTION "check_comms_task_link"();
CREATE TRIGGER "meeting_task_links_check" BEFORE INSERT OR UPDATE ON "meeting_task_links" FOR EACH ROW EXECUTE FUNCTION "check_comms_task_link"();
