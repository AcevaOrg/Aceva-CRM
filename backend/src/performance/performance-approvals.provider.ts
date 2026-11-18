import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { ApprovalItemView, ApprovalTypeName, DecideApprovalRequest } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import type { RequestInfo } from '../access/decorators';
import { PermissionService } from '../access/permission.service';
import { ScopeService } from '../access/scope.service';
import { ApprovalsInbox, type ApprovalProvider } from '../approvals/approvals-inbox.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { DisputesService } from './disputes.service';
import { DISPUTE_INCLUDE, invalid, num, type DisputeRow } from './performance-data';
import { PerformanceDirectory, type DirectoryPerson } from './performance-directory.service';
import { disputeItemSubtitle, disputeItemTitle, planApproval, scorecardItemSubtitle, scorecardItemTitle } from './rules/core-approvals';
import type { Band } from './rules/perf-score';
import { ScorecardsService } from './scorecards.service';

/** The columns of a draft scorecard an inbox item needs. */
const DRAFT_SELECT = {
  id: true,
  month: true,
  kind: true,
  score: true,
  band: true,
  taskCount: true,
  smallSample: true,
  createdAt: true,
  employee: { select: { empId: true } },
} satisfies Prisma.ScorecardSelect;
type DraftRow = Prisma.ScorecardGetPayload<{ select: typeof DRAFT_SELECT }>;

/**
 * Module 6's part of the approvals inbox: "scorecard" and "dispute" items, matching frontend/src/features/performance/approvals.ts
 * (same ids, titles, subtitles, labels). Registered with ApprovalsInbox in onModuleInit. The inbox only finds the provider;
 * `decide` hands the decision to ScorecardsService / DisputesService, which check again that the actor is the person who may
 * decide, so a decision from the inbox and one from the scorecard page follow exactly the same rules.
 *
 * Items are only for a person who reviews work (task.review: the Director and the CTO); the CEO / Founder / Owner gets none (he
 * only watches, in the oversight list):
 *  - scorecard: a DRAFT whose reviewer NOW is the actor (directory.reviewerOf: the manager, or the next level up when the manager has
 *    left or does not review work) and whose person is not the actor.
 *  - dispute: an OPEN dispute whose decider is the actor and whose employee is not the actor.
 */
@Injectable()
export class PerformanceApprovalsProvider implements ApprovalProvider, OnModuleInit {
  readonly key = 'performance';
  readonly types: readonly ApprovalTypeName[] = ['scorecard', 'dispute'];

  constructor(
    private readonly inbox: ApprovalsInbox,
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
    private readonly permissions: PermissionService,
    private readonly directory: PerformanceDirectory,
    private readonly scorecards: ScorecardsService,
    private readonly disputes: DisputesService,
  ) {}

  onModuleInit(): void {
    this.inbox.register(this);
  }

  /** Draft scorecards and open disputes waiting for this person. Sorted by the inbox (oldest first). */
  async list(actor: Actor): Promise<ApprovalItemView[]> {
    if (!(await this.permissions.can(actor.id, 'task.review'))) return [];
    const people = await this.directory.people();
    const items: ApprovalItemView[] = [];
    for (const card of await this.draftsBelow(actor)) {
      const reviewer = await this.directory.reviewerOf(card.employee.empId, people);
      if (reviewer?.empId === actor.empId) items.push(this.scorecardItem(card, people));
    }
    const disputes = await this.prisma.ratingDispute.findMany({ where: { status: 'open', deciderId: actor.id, employeeId: { not: actor.id } }, include: DISPUTE_INCLUDE, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    for (const d of disputes) items.push(this.disputeItem(d));
    return items;
  }

  /**
   * Read only: the same items waiting for people BELOW the actor (the Director sees what waits for the CTO; the CEO / Founder /
   * Owner sees everything), each with waitingFor = the Emp-ID who must decide. Never an item the actor could decide himself
   * (those are in `list`).
   */
  async oversight(actor: Actor): Promise<ApprovalItemView[]> {
    const below = await this.prisma.employee.findMany({ where: this.scope.employeeWhere(actor.id, 'below'), select: { id: true, empId: true } });
    const belowEmpIds = new Set(below.map((p) => p.empId));
    const people = await this.directory.people();
    const items: ApprovalItemView[] = [];
    for (const card of await this.draftsBelow(actor)) {
      const reviewer = await this.directory.reviewerOf(card.employee.empId, people);
      if (reviewer && reviewer.empId !== actor.empId && belowEmpIds.has(reviewer.empId)) items.push({ ...this.scorecardItem(card, people), waitingFor: reviewer.empId });
    }
    const disputes = await this.prisma.ratingDispute.findMany({
      where: { status: 'open', deciderId: { in: below.map((p) => p.id), not: actor.id } },
      include: DISPUTE_INCLUDE,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    for (const d of disputes) items.push({ ...this.disputeItem(d), waitingFor: d.decider.empId });
    return items;
  }

  /**
   * POST /approvals/:id/{approve|reject}.
   *  - scorecard approve = release (the reason, when given, is the remark that goes with it). Reject = add a remark and KEEP the
   *    draft: the reason is the remark and is required (400 `reason_required`).
   *  - dispute approve = change the rating: `rating` (1 to 5) is required (400 `rating_required`), the reason is the decision text
   *    (default "Rating changed after review."). Reject = keep the rating: the reason is the decision text (default "Rating kept.").
   * Both services re-check who may decide and answer 403 / 409 / 400 as on the scorecard page.
   */
  async decide(actor: Actor, item: { type: ApprovalTypeName; refId: string }, decision: 'approve' | 'reject', input: DecideApprovalRequest, client: RequestInfo): Promise<void> {
    if (item.type !== 'scorecard' && item.type !== 'dispute') throw new NotFoundException({ statusCode: 404, code: 'not_found', message: 'Approval item not found' });
    const plan = planApproval(item.type, decision, { reason: input.reason, rating: input.rating });
    if (!plan.ok) throw invalid(plan.code, plan.message);
    switch (plan.action) {
      case 'release':
        await this.scorecards.release(actor, item.refId, plan.remark, client);
        return;
      case 'remark':
        await this.scorecards.addRemark(actor, item.refId, plan.remark, client);
        return;
      case 'change_rating':
        await this.disputes.decide(actor, item.refId, { change: true, decision: plan.decision, newRating: plan.newRating }, client);
        return;
      case 'keep_rating':
        await this.disputes.decide(actor, item.refId, { change: false, decision: plan.decision }, client);
        return;
    }
  }

  // ------------------------------------------------------------------------------------------------ helpers

  /** Draft scorecards of people below the actor: the candidates (the reviewer, being above the person, is always one of these people's seniors). */
  private draftsBelow(actor: Actor): Promise<DraftRow[]> {
    return this.prisma.scorecard.findMany({
      where: { status: 'draft', employee: this.scope.employeeWhere(actor.id, 'below') },
      select: DRAFT_SELECT,
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
  }

  private scorecardItem(card: DraftRow, people: DirectoryPerson[]): ApprovalItemView {
    const name = people.find((p) => p.empId === card.employee.empId)?.fullName ?? card.employee.empId;
    return {
      id: `scorecard:${card.id}`,
      type: 'scorecard',
      refId: card.id,
      title: scorecardItemTitle(card.month, card.score === null ? null : num(card.score), card.band as Band | null),
      subtitle: scorecardItemSubtitle({ name, kind: card.kind, taskCount: card.taskCount, smallSample: card.smallSample }),
      requester: card.employee.empId,
      createdAt: card.createdAt.toISOString(),
      href: `/performance/scorecards/${card.id}`,
      approveLabel: 'Release',
      rejectLabel: 'Add remark, keep draft',
    };
  }

  private disputeItem(d: DisputeRow): ApprovalItemView {
    return {
      id: `dispute:${d.id}`,
      type: 'dispute',
      refId: d.id,
      refNumber: d.scorecardTask.number,
      title: disputeItemTitle(d.scorecardTask.title, d.ratingAtRaise),
      subtitle: disputeItemSubtitle(d.reason),
      requester: d.employee.empId,
      createdAt: d.createdAt.toISOString(),
      href: `/performance/scorecards/${d.scorecardId}`,
      needsRating: true,
      approveLabel: 'Change rating',
      rejectLabel: 'Keep rating',
    };
  }
}
