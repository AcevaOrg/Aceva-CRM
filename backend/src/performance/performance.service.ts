import { Injectable } from '@nestjs/common';
import type { LivePerformanceView, LiveQuery, ScorecardTaskView, TeamPerformanceRowView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { ScopeService } from '../access/scope.service';
import { Clock } from '../common/clock';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PerformanceCalculator, type ScoreSubject } from './performance-calculator.service';
import { PerformanceDirectory } from './performance-directory.service';
import { SCORECARD_INCLUDE, toMetricsView, toPerformanceWeightsView } from './performance-data';
import { sortByName } from './rules/core-view';
import type { FigureTask } from './rules/perf-figures';
import { buildTrend, monthOf, type ClosedScore } from './rules/perf-month';
import { ScorecardsService } from './scorecards.service';

/** A task of the live month as the screens show it (there is no snapshot yet, and no dispute can have changed a rating). */
function toLiveTaskView(t: FigureTask): ScorecardTaskView {
  return {
    taskId: t.taskId,
    number: t.number,
    title: t.title,
    size: t.size,
    points: t.points,
    rating: t.rating ?? undefined,
    onTime: t.onTime,
    reworked: t.reworked,
    extensions: t.extensions,
    status: t.status,
    deadline: t.deadline.toISOString(),
    counted: t.counted,
  };
}

/**
 * Module 6, live figures and the team table. Both routes only READ. The numbers come from PerformanceCalculator (the one place
 * that works out a month: the monthly job and the dispute recompute use it too), so a live figure and the scorecard that is
 * made from it later can never disagree. Nothing is invented: a metric nobody can measure is null and named in `unmeasured`.
 */
@Injectable()
export class PerformanceService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly directory: PerformanceDirectory,
    private readonly calculator: PerformanceCalculator,
    private readonly scorecards: ScorecardsService,
    private readonly clock: Clock,
  ) {}

  /**
   * GET /performance/live?empId= : this month so far for one person (default: the caller). The caller sees themselves, or a
   * person below them in the reporting line (403 for anyone else, 404 for an Emp-ID nobody has). The trend is the last 6 closed
   * months that have a score, then this month; the employee's own trend leaves out drafts (their manager has not released them).
   */
  async live(actor: Actor, query: LiveQuery): Promise<LivePerformanceView> {
    const person = await this.scorecards.resolvePerson(actor, query.empId);
    const now = this.clock.now();
    const month = monthOf(now);
    const { weights, figures } = await this.calculator.compute(person, month, now);
    const closed = await this.prisma.scorecard.findMany({ where: { employeeId: person.id, month: { lt: month } }, select: { month: true, score: true, status: true }, orderBy: { month: 'desc' }, take: 24 });
    const trend = buildTrend(
      closed.map((c): ClosedScore => ({ month: c.month, score: c.score === null ? null : Number(c.score), status: c.status })),
      { liveMonth: month, liveScore: figures.score, includeDrafts: !person.isOwn },
    );
    return {
      empId: person.empId,
      month,
      kind: figures.kind,
      metrics: toMetricsView(figures.kind, figures.metrics as unknown as Prisma.JsonValue),
      salesDetail: figures.salesDetail ?? undefined,
      unmeasured: figures.unmeasured,
      weights: toPerformanceWeightsView(weights),
      score: figures.score,
      band: figures.band,
      taskCount: figures.taskCount,
      smallSample: figures.smallSample,
      trend,
      tasks: figures.tasks.map(toLiveTaskView),
    };
  }

  /**
   * GET /performance/team (performance.view_team): one row per ACTIVE person below the caller (the CTO therefore sees Development
   * and SQA only, never Sales or Finance; the Director everyone below him; the CEO / Founder / Owner everyone), SORTED BY NAME.
   * NEVER sorted or ranked by score. Each row: the newest scorecard INCLUDING a draft (the caller is above the person), this
   * month's live score, and the trend (drafts included).
   */
  async team(actor: Actor): Promise<TeamPerformanceRowView[]> {
    const below = await this.prisma.employee.findMany({
      where: { AND: [this.scope.employeeWhere(actor.id, 'below'), { status: { not: 'left' } }] },
      select: { id: true, empId: true, fullName: true, departmentId: true, role: { select: { key: true } } },
    });
    if (below.length === 0) return [];
    const people = sortByName(below);
    const now = this.clock.now();
    const month = monthOf(now);

    // Every scorecard of these people, light columns only: the newest one of each, and the closed months for the trend.
    const cards = await this.prisma.scorecard.findMany({
      where: { employeeId: { in: people.map((p) => p.id) } },
      select: { id: true, employeeId: true, month: true, score: true, status: true },
      orderBy: { month: 'desc' },
    });
    const latestIds = new Map<string, string>();
    for (const c of cards) if (!latestIds.has(c.employeeId)) latestIds.set(c.employeeId, c.id); // newest month first
    const latestRows = await this.prisma.scorecard.findMany({ where: { id: { in: [...latestIds.values()] } }, include: SCORECARD_INCLUDE });
    const latestById = new Map(latestRows.map((r) => [r.id, r]));
    const directoryPeople = latestRows.some((r) => r.status === 'draft') ? await this.directory.people() : undefined;

    const rows: TeamPerformanceRowView[] = [];
    for (const person of people) {
      const subject: ScoreSubject = { id: person.id, empId: person.empId, departmentId: person.departmentId, roleKey: person.role.key };
      const { figures } = await this.calculator.compute(subject, month, now);
      const closed: ClosedScore[] = cards.filter((c) => c.employeeId === person.id).map((c) => ({ month: c.month, score: c.score === null ? null : Number(c.score), status: c.status }));
      const latestRow = latestById.get(latestIds.get(person.id) ?? '');
      rows.push({
        empId: person.empId,
        kind: figures.kind,
        latest: latestRow ? await this.scorecards.viewOf(latestRow, directoryPeople) : null,
        live: { score: figures.score, band: figures.band, smallSample: figures.smallSample },
        trend: buildTrend(closed, { liveMonth: month, liveScore: figures.score, includeDrafts: true }),
      });
    }
    return rows;
  }
}
