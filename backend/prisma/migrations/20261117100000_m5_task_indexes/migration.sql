-- Module 5: indexes for the lists and for the nightly "tasks touched" count of the activity summary
-- (a person's tasks by deadline; what a person commented, ticked, attached, asked and decided in a day).

-- CreateIndex
CREATE INDEX "tasks_assignee_id_deadline_idx" ON "tasks"("assignee_id", "deadline");

-- CreateIndex
CREATE INDEX "task_checklist_items_done_by_done_at_idx" ON "task_checklist_items"("done_by", "done_at");

-- CreateIndex
CREATE INDEX "task_comments_author_id_created_at_idx" ON "task_comments"("author_id", "created_at");

-- CreateIndex
CREATE INDEX "task_attachments_uploaded_by_id_created_at_idx" ON "task_attachments"("uploaded_by_id", "created_at");

-- CreateIndex
CREATE INDEX "task_extensions_requested_by_id_created_at_idx" ON "task_extensions"("requested_by_id", "created_at");

-- CreateIndex
CREATE INDEX "task_extensions_decided_by_id_decided_at_idx" ON "task_extensions"("decided_by_id", "decided_at");
