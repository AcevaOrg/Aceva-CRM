import { Injectable } from '@nestjs/common';
import type { SaveScoreWeightsRequest, ScoreWeightsQuery, ScoreWeightsVersionView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import type { RequestInfo } from '../access/decorators';
import { AuditService } from '../access/audit.service';
import { Clock } from '../common/clock';
import { noteActivity } from '../common/request-context';
import type { Prisma } from '../generated/prisma/client';
import { OutboxService } from '../events/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { invalid, isUniqueViolation, conflict, PERF_AUDIT, toWeightsView, weightsCreatedPayload, weightsOf, WEIGHTS_INCLUDE } from './performance-data';
import { nextVersionNo } from './rules/core-view';
import { validateWeights } from './rules/perf-score';

/** Newest first: the version in force is the first one. */
const NEWEST_FIRST = [{ effectiveFrom: 'desc' as const }, { versionNo: 'desc' as const }];

/**
 * Module 6, score weight versions. The rule for a valid set is rules/perf-score.ts `validateWeights` (the database repeats it);
 * mappers and payloads are in performance-data.ts.
 *
 * WEIGHT UNITS (decided in the foundation): the server keeps and serves WHOLE PERCENTS that add up to exactly 100 (35, 25,
 * 20, 10, 10). The system Settings screen uses them as they are; the performance screens divide by 100 in their live branch.
 * A version is never edited (the table is insert-only): a change is a NEW version, and scorecards already made keep theirs.
 * Each department may have its own set; it wins for the people of that department. Without a department the version is the
 * company-wide set of its kind.
 */
@Injectable()
export class ScoreWeightsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  /** GET /settings/score-weights?kind=&departmentId= : every version (optionally of one kind or one department), newest first. */
  async list(_actor: Actor, query: ScoreWeightsQuery): Promise<ScoreWeightsVersionView[]> {
    const where: Prisma.ScoreWeightVersionWhereInput = {};
    if (query.kind) where.kind = query.kind;
    if (query.departmentId) where.departmentId = query.departmentId;
    const rows = await this.prisma.scoreWeightVersion.findMany({ where, orderBy: NEWEST_FIRST, include: WEIGHTS_INCLUDE });
    return rows.map(toWeightsView);
  }

  /**
   * POST /settings/score-weights { kind, departmentId?, weights, reason } (201): the Director saves a NEW version.
   * The numbers must be exactly the metrics of the kind, whole percents from 0 to 100 that add up to exactly 100. The version
   * number counts per kind and department; two saves at the same moment are served one after the other (advisory lock), and the
   * unique index in the database is the last guard. Audited with the old and new weights (the Settings "recent changes" panel
   * shows it) and announced as `score_weights.created`.
   */
  async save(actor: Actor, body: SaveScoreWeightsRequest, client: RequestInfo): Promise<ScoreWeightsVersionView> {
    const checked = validateWeights(body.kind, body.weights);
    if (!checked.ok) throw invalid(checked.code, checked.message);

    const departmentId = body.departmentId ?? null;
    if (departmentId) {
      const department = await this.prisma.department.findFirst({ where: { id: departmentId, archivedAt: null }, select: { id: true } });
      if (!department) throw invalid('department_not_found', 'That department does not exist or is archived.');
    }
    const scopeKey = `score_weights:${body.kind}:${departmentId ?? 'company'}`;

    let created: { id: string };
    try {
      created = await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${scopeKey}::text))`;
        // The moment is taken AFTER the lock: of two saves at the same time the one that gets the higher number is also the newer.
        const now = this.clock.now();
        const sameScope = await tx.scoreWeightVersion.findMany({ where: { kind: body.kind, departmentId }, select: { versionNo: true } });
        // The set that was in force until now: this scope's newest, or for a department's first own set the company-wide one.
        const previous =
          (await tx.scoreWeightVersion.findFirst({ where: { kind: body.kind, departmentId }, orderBy: NEWEST_FIRST })) ??
          (departmentId ? await tx.scoreWeightVersion.findFirst({ where: { kind: body.kind, departmentId: null }, orderBy: NEWEST_FIRST }) : null);

        const row = await tx.scoreWeightVersion.create({
          data: {
            kind: body.kind,
            departmentId,
            versionNo: nextVersionNo(sameScope.map((v) => v.versionNo)),
            weights: body.weights as Prisma.InputJsonValue,
            note: body.reason,
            createdById: actor.id,
            effectiveFrom: now,
            createdAt: now,
          },
          include: WEIGHTS_INCLUDE,
        });
        await this.audit.record(
          {
            actorId: actor.id,
            action: PERF_AUDIT.weightsCreated,
            targetType: 'settings',
            targetId: 'score-weights',
            reason: body.reason,
            details: { before: previous ? weightsOf(previous) : {}, after: weightsOf(row), kind: row.kind, departmentId, versionNo: row.versionNo },
            ...client,
          },
          tx,
        );
        await this.outbox.emit({ type: 'score_weights.created', actor: actor.empId, payload: weightsCreatedPayload(row, previous?.id ?? null) }, tx);
        return { id: row.id };
      });
    } catch (error) {
      // The advisory lock makes this rare; the unique (kind, department, version) index still guards a race on another server.
      if (isUniqueViolation(error)) throw conflict('version_conflict', 'Someone saved the weights at the same moment. Reload and try again.');
      throw error;
    }

    noteActivity({ target: 'score weights', description: `Saved new ${body.kind === 'sales' ? 'sales' : 'standard'} score weights` });
    const saved = await this.prisma.scoreWeightVersion.findUniqueOrThrow({ where: { id: created.id }, include: WEIGHTS_INCLUDE });
    return toWeightsView(saved);
  }
}
