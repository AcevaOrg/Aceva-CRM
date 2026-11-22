import { Injectable, NotFoundException, OnModuleInit } from '@nestjs/common';
import type { ApprovalItemView, ApprovalTypeName, DecideApprovalRequest } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import type { RequestInfo } from '../access/decorators';
import { PermissionService } from '../access/permission.service';
import { ScopeService } from '../access/scope.service';
import { pakistanDay } from '../activity/rules/activity-time';
import { ApprovalsInbox, type ApprovalProvider } from '../approvals/approvals-inbox.service';
import { Clock } from '../common/clock';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { dateOnly, formatPkDay } from './task-access';
import { TaskWorkflowService } from './task-workflow.service';

/** The statuses in which a task waits for its reviewer, and those in which an extension request can still be answered. */
const REVIEW_STATUSES = ['submitted', 'under_review'] as const;
const EXTENSION_STATUSES = ['assigned', 'in_progress', 'rework', 'on_hold'] as const;

const REVIEW_INCLUDE = { assignee: { select: { empId: true, fullName: true } } } satisfies Prisma.TaskInclude;
const EXTENSION_ROW_INCLUDE = { requestedBy: { select: { empId: true } }, task: { select: { id: true, number: true, title: true } } } satisfies Prisma.TaskExtensionInclude;

type ReviewRow = Prisma.TaskGetPayload<{ include: typeof REVIEW_INCLUDE }>;
type ExtensionRow = Prisma.TaskExtensionGetPayload<{ include: typeof EXTENSION_ROW_INCLUDE }>;

/**
 * Module 5's part of the approvals inbox: "task_review" and "extension" items, matching frontend/src/features/tasks/approvals.ts
 * (same ids, titles, subtitles, labels). Registered with ApprovalsInbox in onModuleInit. The inbox only finds the provider;
 * `decide` hands the decision to TaskWorkflowService, which checks again that the actor is the person who may decide
 * (reviewerOf / the assigner), so a decision from the inbox and one from the task page follow exactly the same rules.
 *
 * Who an item is for: the task's reviewer now (TaskWorkflowService.reviewerOf: the assigner, their stand-in while they are
 * away, or the next level up) and nobody else. The query only narrows the candidates (tasks the person assigned, tasks of a
 * manager they cover, tasks of people below them); reviewerOf decides.
 */
@Injectable()
export class TaskApprovalsProvider implements ApprovalProvider, OnModuleInit {
  readonly key = 'tasks';
  readonly types: readonly ApprovalTypeName[] = ['task_review', 'extension'];

  constructor(
    private readonly inbox: ApprovalsInbox,
    private readonly prisma: PrismaService,
    private readonly workflow: TaskWorkflowService,
    private readonly scope: ScopeService,
    private readonly permissions: PermissionService,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.inbox.register(this);
  }

  /** Task reviews and pending extensions waiting for this person. Sorted by the inbox. */
  async list(actor: Actor): Promise<ApprovalItemView[]> {
    const candidates = await this.candidatesFor(actor);
    const items: ApprovalItemView[] = [];
    for (const task of await this.reviewTasks(candidates)) {
      if ((await this.workflow.reviewerOf(task.id)) === actor.empId) items.push(this.reviewItem(task));
    }
    // Extension requests are decided by someone who assigns tasks (the Director and the CTO), as the rule in the workflow says.
    if (await this.permissions.can(actor.id, 'task.assign')) {
      for (const ext of await this.pendingExtensions(candidates)) {
        if ((await this.workflow.reviewerOf(ext.task.id)) === actor.empId) items.push(this.extensionItem(ext));
      }
    }
    return items;
  }

  /**
   * Read only: the same kinds of items waiting for people BELOW the actor (the Director sees what waits for the CTO; the
   * CEO / Founder / Owner sees everything). Each item has waitingFor = the Emp-ID who must decide.
   */
  async oversight(actor: Actor): Promise<ApprovalItemView[]> {
    const below = new Set((await this.prisma.employee.findMany({ where: this.scope.employeeWhere(actor.id, 'below'), select: { empId: true } })).map((p) => p.empId));
    const candidates: Prisma.TaskWhereInput = { assignee: this.scope.employeeWhere(actor.id, 'below') };
    const items: ApprovalItemView[] = [];
    for (const task of await this.reviewTasks(candidates)) {
      const reviewer = await this.workflow.reviewerOf(task.id);
      if (reviewer && below.has(reviewer)) items.push({ ...this.reviewItem(task), waitingFor: reviewer });
    }
    for (const ext of await this.pendingExtensions(candidates)) {
      const reviewer = await this.workflow.reviewerOf(ext.task.id);
      if (reviewer && below.has(reviewer)) items.push({ ...this.extensionItem(ext), waitingFor: reviewer });
    }
    return items;
  }

  /** How many extension requests the actor made that are waiting on someone else (a person asks nothing else in Module 5). */
  routedUp(actor: Actor): Promise<number> {
    return this.prisma.taskExtension.count({ where: { requestedById: actor.id, status: 'pending', task: { personal: false, status: { in: [...EXTENSION_STATUSES] } } } });
  }

  async decide(actor: Actor, item: { type: ApprovalTypeName; refId: string }, decision: 'approve' | 'reject', input: DecideApprovalRequest, client: RequestInfo): Promise<void> {
    if (item.type === 'task_review') {
      // Approve = approve with a rating; reject = send to rework with a reason (both checked again by the workflow).
      if (decision === 'approve') await this.workflow.perform(actor, item.refId, 'approve', { rating: input.rating, comment: input.comment }, client);
      else await this.workflow.perform(actor, item.refId, 'rework', { reason: input.reason }, client);
      return;
    }
    if (item.type === 'extension') {
      await this.workflow.decideExtension(actor, item.refId, decision, input.reason, client);
      return;
    }
    throw new NotFoundException({ statusCode: 404, code: 'not_found', message: 'Approval item not found' });
  }

  // ------------------------------------------------------------------------------------------------ helpers

  /** Tasks whose reviewer could be this person: ones they assigned, ones of a manager they cover today, ones of people below them. */
  private async candidatesFor(actor: Actor): Promise<Prisma.TaskWhereInput> {
    const today = dateOnly(pakistanDay(this.clock.now()));
    const covered = await this.prisma.standIn.findMany({ where: { standInId: actor.id, revokedAt: null, startsOn: { lte: today }, endsOn: { gte: today } }, select: { managerId: true } });
    return { OR: [{ assignedById: actor.id }, { assignedById: { in: covered.map((c) => c.managerId) } }, { assignee: this.scope.employeeWhere(actor.id, 'below') }] };
  }

  private reviewTasks(candidates: Prisma.TaskWhereInput): Promise<ReviewRow[]> {
    return this.prisma.task.findMany({
      where: { AND: [{ personal: false, status: { in: [...REVIEW_STATUSES] } }, candidates] },
      include: REVIEW_INCLUDE,
      orderBy: [{ submittedAt: 'asc' }, { number: 'asc' }],
    });
  }

  private pendingExtensions(candidates: Prisma.TaskWhereInput): Promise<ExtensionRow[]> {
    return this.prisma.taskExtension.findMany({
      where: { status: 'pending', task: { AND: [{ personal: false, status: { in: [...EXTENSION_STATUSES] } }, candidates] } },
      include: EXTENSION_ROW_INCLUDE,
      orderBy: { createdAt: 'asc' },
    });
  }

  private reviewItem(t: ReviewRow): ApprovalItemView {
    return {
      id: `task_review:${t.id}`,
      type: 'task_review',
      refId: t.id,
      refNumber: t.number,
      title: t.title,
      subtitle: `${t.size} task · ${t.points} pts · submitted by ${t.assignee.fullName}`,
      requester: t.assignee.empId,
      createdAt: (t.submittedAt ?? t.updatedAt).toISOString(),
      href: `/tasks/${t.id}`,
      needsRating: true,
      approveLabel: 'Approve',
      rejectLabel: 'Send to rework',
    };
  }

  private extensionItem(e: ExtensionRow): ApprovalItemView {
    return {
      id: `extension:${e.id}`,
      type: 'extension',
      refId: e.id,
      refNumber: e.task.number,
      title: `More time for “${e.task.title}”`,
      subtitle: `${formatPkDay(e.currentDeadline)} → ${formatPkDay(e.requestedDeadline)} · “${e.reason}”${e.late ? ' · asked after the deadline (counts as late)' : ''}`,
      requester: e.requestedBy.empId,
      from: e.currentDeadline.toISOString(),
      to: e.requestedDeadline.toISOString(),
      createdAt: e.createdAt.toISOString(),
      href: `/tasks/${e.task.id}`,
    };
  }
}
