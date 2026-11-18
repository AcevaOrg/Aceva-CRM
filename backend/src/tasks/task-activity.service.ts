import { Injectable, OnModuleInit } from '@nestjs/common';
import { ActivitySummaryHooks, type SummaryHookQuery } from '../activity/activity-summary.service';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Fills Module 4's daily-summary "tasks touched" hook (plan section 8: "number of actions and tasks touched"). Module 4
 * counts the different tasks a person acted on from their recorded actions in the Tasks module by default; this replaces
 * that with the real count, taken from the task tables themselves, so the number does not depend on the recorder's words.
 *
 * A person "touched" a task in [start, end) when any of these carries their id and a time in that window: a history line
 * (task_history.by_id), a comment, a checklist step they ticked, a file they added, an extension request or its decision,
 * or a review. Different tasks are counted once each; personal to-dos are not counted (they are not work to report). One
 * query for all the people of the summary. Work the system did (a hand-over, a repeating series) has no person and is not
 * counted for anybody. People who touched nothing are left out of the map (the summary reads a missing person as 0).
 */
@Injectable()
export class TaskActivity implements OnModuleInit {
  constructor(
    private readonly hooks: ActivitySummaryHooks,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.hooks.useTasksTouched((query) => this.touched(query));
  }

  /** Employee id -> how many different work tasks that person touched in the window. */
  async touched({ employeeIds, start, end }: SummaryHookQuery): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (!employeeIds.length) return counts;
    const rows = await this.prisma.$queryRaw<Array<{ employee_id: string; n: number }>>`
      SELECT touch.person::text AS employee_id, count(DISTINCT touch.task_id)::int AS n
      FROM (
        SELECT by_id AS person, task_id FROM task_history
          WHERE by_id = ANY(${employeeIds}::uuid[]) AND at >= ${start}::timestamptz AND at < ${end}::timestamptz
        UNION ALL
        SELECT author_id, task_id FROM task_comments
          WHERE author_id = ANY(${employeeIds}::uuid[]) AND created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz
        UNION ALL
        SELECT done_by, task_id FROM task_checklist_items
          WHERE done_by = ANY(${employeeIds}::uuid[]) AND done_at >= ${start}::timestamptz AND done_at < ${end}::timestamptz
        UNION ALL
        SELECT uploaded_by_id, task_id FROM task_attachments
          WHERE uploaded_by_id = ANY(${employeeIds}::uuid[]) AND created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz
        UNION ALL
        SELECT requested_by_id, task_id FROM task_extensions
          WHERE requested_by_id = ANY(${employeeIds}::uuid[]) AND created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz
        UNION ALL
        SELECT decided_by_id, task_id FROM task_extensions
          WHERE decided_by_id = ANY(${employeeIds}::uuid[]) AND decided_at >= ${start}::timestamptz AND decided_at < ${end}::timestamptz
        UNION ALL
        SELECT reviewer_id, task_id FROM task_reviews
          WHERE reviewer_id = ANY(${employeeIds}::uuid[]) AND created_at >= ${start}::timestamptz AND created_at < ${end}::timestamptz
      ) AS touch
      JOIN tasks ON tasks.id = touch.task_id AND NOT tasks.personal
      GROUP BY touch.person`;
    for (const row of rows) counts.set(row.employee_id, Number(row.n));
    return counts;
  }
}
