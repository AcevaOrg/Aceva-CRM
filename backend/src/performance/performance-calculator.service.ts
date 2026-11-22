import { Inject, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { ATTENDANCE_SOURCE, type AttendanceSource } from './attendance-source';
import { WEIGHTS_INCLUDE, weightsOf, type Db, type WeightsRow } from './performance-data';
import { buildFigures, type MonthFigures } from './rules/perf-figures';
import { monthWindow } from './rules/perf-month';
import type { ScorecardKind } from './rules/perf-score';
import { openHours } from '../tasks/rules/task-workload';
import { toScorecardTask, type TaskRowFacts } from './rules/perf-tasks';
import { SALES_SOURCE, type SalesSource } from './sales-source';

/** The person the figures are about. */
export interface ScoreSubject {
  /** Internal employee id. */
  id: string;
  empId: string;
  departmentId: string;
  roleKey: string;
}

export interface ComputedMonth {
  weights: WeightsRow;
  figures: MonthFigures;
}

/**
 * THE one place that works out a person's figures for a month: the live figures (this month so far), the monthly job (a
 * closed month, stored as a draft scorecard) and the dispute recompute all use it, so they can never disagree. It loads
 * the facts (the person's tasks due in the month, their approved ratings, open hours), asks the attendance and sales
 * sources (stand-ins until Modules 7 and 15 exist; they never invent a number) and hands everything to the pure rules
 * (rules/perf-figures.ts buildFigures). It writes nothing.
 *
 * Which tasks belong to a month: the person's own work tasks (never a personal to-do) whose current approved deadline falls
 * in the month (Pakistan time). Sales staff are scored on the sales figures only: they have no tasks here.
 *
 * On time is measured against the deadline in force when the work was handed in: an extension approved before the deadline moves
 * it (not late); one asked for after the deadline counts as late (task_extensions.late), so the deadline that was in force at that
 * request is the one measured. A task still waiting for review when the month is measured is stored as waiting (no rating).
 */
@Injectable()
export class PerformanceCalculator {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(ATTENDANCE_SOURCE) private readonly attendance: AttendanceSource,
    @Inject(SALES_SOURCE) private readonly sales: SalesSource,
  ) {}

  /** Sales staff (role "sales") are scored with the sales weights and metrics; everyone else with the standard ones. */
  kindOf(roleKey: string): ScorecardKind {
    return roleKey === 'sales' ? 'sales' : 'standard';
  }

  /**
   * The weights version in force for a kind and a department: that department's newest set when it has one, else the
   * company-wide newest set. Never missing: the migration inserts the starting versions.
   */
  async currentWeights(kind: ScorecardKind, departmentId: string | null, db: Db = this.prisma): Promise<WeightsRow> {
    const order = [{ effectiveFrom: 'desc' as const }, { versionNo: 'desc' as const }];
    if (departmentId) {
      const own = await db.scoreWeightVersion.findFirst({ where: { kind, departmentId }, orderBy: order, include: WEIGHTS_INCLUDE });
      if (own) return own;
    }
    return db.scoreWeightVersion.findFirstOrThrow({ where: { kind, departmentId: null }, orderBy: order, include: WEIGHTS_INCLUDE });
  }

  /** A weights version by id (the one a scorecard was made with). */
  weightsById(id: string, db: Db = this.prisma): Promise<WeightsRow> {
    return db.scoreWeightVersion.findUniqueOrThrow({ where: { id }, include: WEIGHTS_INCLUDE });
  }

  /** Estimated hours of the person's open work tasks right now (information only, never scored). */
  async openHoursOf(employeeId: string, db: Db = this.prisma): Promise<number> {
    const rows = await db.task.findMany({ where: { assigneeId: employeeId, personal: false, status: { notIn: ['approved', 'cancelled'] } }, select: { status: true, personal: true, estimatedHours: true } });
    return openHours(rows.map((r) => ({ status: r.status, personal: r.personal, estimatedHours: Number(r.estimatedHours) })));
  }

  /**
   * The figures of `subject` for `month` ("2026-10"), measured at `now` (which open tasks are already due). `options.weights`
   * fixes the weights version (the dispute recompute uses the scorecard's own); by default the version in force now.
   */
  async compute(subject: ScoreSubject, month: string, now: Date, options: { weights?: WeightsRow; db?: Db } = {}): Promise<ComputedMonth> {
    const db = options.db ?? this.prisma;
    const kind = this.kindOf(subject.roleKey);
    const weights = options.weights ?? (await this.currentWeights(kind, subject.departmentId, db));
    const attendance = await this.attendance.rateFor(subject.id, month);
    const attendanceRate = attendance.available ? attendance.rate : null;

    if (kind === 'sales') {
      const sales = await this.sales.figuresFor(subject.id, month);
      const figures = buildFigures({ kind, tasks: [], now, attendance: attendanceRate, sales: sales.available ? sales.detail : null, workloadHours: 0, weights: weightsOf(weights) });
      return { weights, figures };
    }

    const { start, end } = monthWindow(month);
    const rows = await db.task.findMany({
      where: { assigneeId: subject.id, personal: false, deadline: { gte: start, lt: end } },
      select: {
        id: true,
        number: true,
        title: true,
        size: true,
        points: true,
        status: true,
        deadline: true,
        submittedAt: true,
        reworkCount: true,
        extensionsCount: true,
        // Approved extensions asked for AFTER the deadline count as late: the deadline that was in force then is the one to meet.
        extensions: { where: { status: 'approved', late: true }, select: { currentDeadline: true } },
        reviews: { where: { decision: 'approved' }, orderBy: { createdAt: 'desc' }, take: 1, select: { rating: true } },
      },
      orderBy: [{ deadline: 'asc' }, { number: 'asc' }],
    });
    const facts: TaskRowFacts[] = rows.map((r) => ({
      taskId: r.id,
      number: r.number,
      title: r.title,
      size: r.size,
      points: r.points,
      status: r.status,
      deadline: r.deadline,
      submittedAt: r.submittedAt,
      reworkCount: r.reworkCount,
      extensionsCount: r.extensionsCount,
      lateExtensionDeadlines: r.extensions.map((x) => x.currentDeadline),
      // The rating counts only while the task is approved (an approval is what puts a rating into the figures).
      rating: r.status === 'approved' ? (r.reviews[0]?.rating ?? null) : null,
    }));
    const figures = buildFigures({
      kind,
      tasks: facts.map((f) => toScorecardTask(f, now)),
      now,
      attendance: attendanceRate,
      sales: null,
      workloadHours: await this.openHoursOf(subject.id, db),
      weights: weightsOf(weights),
    });
    return { weights, figures };
  }
}
