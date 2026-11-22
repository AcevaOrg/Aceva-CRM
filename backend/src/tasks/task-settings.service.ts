import { Injectable, NotFoundException } from '@nestjs/common';
import { TASK_SIZES, type HolidayView, type ProjectView, type SizeRuleChangeView, type SizeRuleView, type TaskSizeName, type UpdateSizeRuleRequest } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { pakistanDay } from '../activity/rules/activity-time';
import { Clock } from '../common/clock';
import { noteActivity } from '../common/request-context';
import { PrismaService } from '../prisma/prisma.service';
import { dateOnly, invalid } from './task-access';
import { toHolidayView, toProjectView, toSizeRuleChangeView, toSizeRuleView } from './task-data';
import { checkDeadline, type DeadlineCheckInput, type TaskIssue } from './rules/task-deadlines';
import { applySizeUpdate, checkSizeTable, ruleFor, sizeChanges, type SizeRule } from './rules/task-sizes';

/** The columns of a size row that the history keeps. */
const rowValues = (r: SizeRule) => ({ meaning: r.meaning, hours: r.hours, hoursLabel: r.hoursLabel, points: r.points, days: r.days });

/**
 * Reference data and settings for tasks: the size table (editable by the Director with a history), the company holiday
 * calendar and the (minimal, read-only) projects. Pure rules are in rules/task-sizes.ts and rules/task-deadlines.ts.
 */
@Injectable()
export class TaskSettingsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  /** GET /projects: active projects (archived_at is null), by name. Any logged-in person. */
  async projects(_actor: Actor): Promise<ProjectView[]> {
    const rows = await this.prisma.project.findMany({ where: { archivedAt: null }, orderBy: { name: 'asc' } });
    return rows.map(toProjectView);
  }

  /**
   * GET /holidays?year=: the company holidays of that year (default: the current Pakistan year) that are not archived,
   * by date. Any logged-in person.
   */
  async holidays(_actor: Actor, year?: number): Promise<HolidayView[]> {
    const y = year ?? Number(pakistanDay(this.clock.now()).slice(0, 4));
    const rows = await this.prisma.holiday.findMany({
      where: { archivedAt: null, date: { gte: dateOnly(`${y}-01-01`), lte: dateOnly(`${y}-12-31`) } },
      orderBy: { date: 'asc' },
    });
    return rows.map(toHolidayView);
  }

  /**
   * Every non-archived holiday date (YYYY-MM-DD) from `from` to `to`, as a Set. Used by the task rules (suggested deadline,
   * too-short warning). Read it fresh each time (the Director may add holidays).
   */
  async holidayDays(from: string, to: string): Promise<Set<string>> {
    const rows = await this.prisma.holiday.findMany({ where: { archivedAt: null, date: { gte: dateOnly(from), lte: dateOnly(to) } }, select: { date: true } });
    return new Set(rows.map((r) => r.date.toISOString().slice(0, 10)));
  }

  /** GET /settings/task-sizes: the five rows, in the order XS, S, M, L, XL (task_size_settings; use toSizeRuleView). */
  async sizeRules(): Promise<SizeRuleView[]> {
    const rows = await this.prisma.taskSizeSetting.findMany();
    return rows.map(toSizeRuleView).sort((a, b) => TASK_SIZES.indexOf(a.size) - TASK_SIZES.indexOf(b.size));
  }

  /**
   * The deadline rules for a task: hard errors (past, before the start, XL) and the soft "too short" warning, using the
   * size table as it is now and the holiday calendar between the start and the deadline. Shared by creating a task and
   * by a manager moving a deadline.
   */
  async deadlineCheck(input: Omit<DeadlineCheckInput, 'now' | 'neededDays' | 'holidays'>): Promise<{ errors: TaskIssue[]; warnings: TaskIssue[]; rule: SizeRule }> {
    const rule = ruleFor(await this.sizeRules(), input.size);
    const from = pakistanDay(input.start);
    const to = Number.isNaN(input.deadline.getTime()) ? from : pakistanDay(input.deadline);
    const holidays = await this.holidayDays(from, to < from ? from : to);
    const { errors, warnings } = checkDeadline({ ...input, now: this.clock.now(), neededDays: rule.days, holidays });
    return { errors, warnings, rule };
  }

  /**
   * PATCH /settings/task-sizes/:size (permission settings.manage, the Director). Apply with rules/task-sizes.ts
   * applySizeUpdate, refuse with 400 (code "invalid_size_table", message from the first issue) when checkSizeTable finds
   * an issue (XL must stay "must be split"; a bigger size never gets less than a smaller one). In ONE transaction update
   * the row (updatedBy = actor.id), insert a task_size_setting_changes row (before, after, reason, changedBy) and an audit
   * entry "task.size_rules.changed" with { before, after } details. Existing tasks are NOT touched (they keep the points
   * and hours they were created with). Returns the new row.
   */
  async updateSizeRule(actor: Actor, size: TaskSizeName, body: UpdateSizeRuleRequest, client: RequestInfo): Promise<SizeRuleView> {
    const { reason, ...patch } = body;
    if (size === 'XL' && patch.days !== undefined) throw invalid('invalid_size_table', 'XL tasks must be split: they cannot have suggested days.');

    const result = await this.prisma.$transaction(async (tx) => {
      // One change at a time: the table is checked as a whole, so two edits must not interleave.
      await tx.$queryRaw`SELECT id FROM task_size_settings FOR UPDATE`;
      const rows = (await tx.taskSizeSetting.findMany()).map(toSizeRuleView);
      const before = rows.find((r) => r.size === size);
      if (!before) throw new NotFoundException({ statusCode: 404, code: 'not_found', message: 'Size not found' });
      const after = applySizeUpdate(before, patch);
      if (sizeChanges(before, after).length === 0) throw invalid('nothing_changed', 'Those values are already set.');
      const issues = checkSizeTable(rows.map((r) => (r.size === size ? after : r)));
      if (issues.length > 0) throw invalid('invalid_size_table', issues[0].message);

      const saved = await tx.taskSizeSetting.update({
        where: { size },
        data: { meaning: after.meaning, hours: after.hours, hoursLabel: after.hoursLabel, points: after.points, days: after.days, updatedBy: actor.id },
      });
      await tx.taskSizeSettingChange.create({ data: { size, before: rowValues(before), after: rowValues(after), reason, changedBy: actor.id } });
      await this.audit.record(
        { actorId: actor.id, action: 'task.size_rules.changed', targetType: 'task_size', targetId: size, reason, details: { before: rowValues(before), after: rowValues(after) }, ...client },
        tx,
      );
      return toSizeRuleView(saved);
    });
    noteActivity({ target: size, description: `Changed the ${size} task size rule` });
    return result;
  }

  /** GET /settings/task-sizes/changes: the history of changes to the size table, newest first (at most 200), with the Emp-ID of whoever changed it. */
  async sizeRuleChanges(): Promise<SizeRuleChangeView[]> {
    const rows = await this.prisma.taskSizeSettingChange.findMany({ orderBy: [{ changedAt: 'desc' }, { id: 'asc' }], take: 200 });
    const people = await this.prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.changedBy))] } }, select: { id: true, empId: true } });
    const empIdOf = new Map(people.map((p) => [p.id, p.empId]));
    return rows.map((r) => toSizeRuleChangeView(r, empIdOf.get(r.changedBy) ?? 'system'));
  }
}
