import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { type OutboxEvent, SALES_OPEN_STAGES, type SalesReassignmentIssueView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import { PermissionService } from '../access/permission.service';
import { Clock } from '../common/clock';
import { OutboxConsumerRunner } from '../events/outbox-consumer-runner.service';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { SALES_MANAGE, SALES_OWN, SalesAccessService } from './sales-access.service';
import { forbidden } from './sales-errors';
import { person } from './sales-views';

type Tx = Prisma.TransactionClient;

export const SALES_OFFBOARDING_CONSUMER = 'sales-offboarding';
const SALES_MANAGER_DUTY = 'sales_manager';
/** The CEO / Founder / Owner only views sales (approved A-3): never given leads automatically, whatever they hold. */
const OWNER_ROLE = 'owner';

export interface ReassignOutcome {
  /** Who received the leads and deals (null when nothing was moved). */
  to: string | null;
  rule: 'sales_manager_duty' | 'leaver_manager' | null;
  leads: number;
  deals: number;
  /** A new case for management was opened (nobody could receive them). */
  issueOpened: boolean;
}

/**
 * Module 15.5: a salesperson's leads and deals when they leave (plan section 20: "Leads belong to Aceva, not to the
 * salesperson. When someone leaves, their leads and deals move to the sales manager on their last working day (Module 3)").
 *
 * Module 3 is the authority on leaving: at 00:00 Pakistan time after the last working day it sets the person to "left",
 * ends their duties and emits employee.offboarded {empId, lastWorkingDay, managerEmpId} in one transaction. This reader
 * ("sales-offboarding", on the shared outbox reader) moves, in the reader's own transaction:
 *  - every lead of the leaver that is not archived, and every open deal of theirs, a deal waiting for its Won
 *    confirmation too (its request, requester and history are kept as they are; the B1 rule then applies to the new
 *    owner unchanged). Won and Lost deals keep their owner (they are final: a database trigger);
 *  - to the one active holder of the sales_manager duty; when there is none or more than one, to the leaver's manager
 *    named by the event, only if that person is active, owns and manages sales leads (sales.own and the sales-manager
 *    permission sales.targets) and is not the CEO / Owner, who only views sales; otherwise nothing is moved and a case is
 *    opened for management (GET /sales/reassignment-issues), never an arbitrary person (approved decision 7, corrected).
 * Each move writes the deal history (owner_changed, no person: the system), the audit log, and a summary.
 *
 * Safe to repeat: a per-leaver transaction lock, and only rows still owned by the leaver are moved, so a second delivery,
 * a retry, or the nightly check running at the same moment moves nothing twice. The reader never replays events from
 * before it existed, and an event can end up "dead" after its retries: the nightly check (sweep, 02:00 Pakistan time)
 * therefore looks for anyone who has left and still owns leads or open deals, and retries open cases.
 */
@Injectable()
export class SalesOffboardingService implements OnModuleInit {
  private readonly logger = new Logger('SalesOffboarding');

  constructor(
    private readonly prisma: PrismaService,
    private readonly runner: OutboxConsumerRunner,
    private readonly permissions: PermissionService,
    private readonly access: SalesAccessService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.runner.register({ name: SALES_OFFBOARDING_CONSUMER, types: ['employee.offboarded'], handle: (event, tx) => this.onOffboarded(event, tx) });
  }

  async onOffboarded(event: OutboxEvent, tx: Tx): Promise<void> {
    if (event.type !== 'employee.offboarded') return;
    const outcome = await this.reassign(tx, event.payload.empId, event.payload.managerEmpId, { eventId: event.id });
    if (outcome.to) this.logger.log(`${event.payload.empId} left: ${outcome.leads} lead(s) and ${outcome.deals} deal(s) moved to ${outcome.to}`);
    else if (outcome.issueOpened) this.logger.warn(`${event.payload.empId} left: nobody can receive their leads; waiting for management`);
  }

  /** Moves what the leaver still owns (inside the caller's transaction). */
  async reassign(tx: Tx, leaverEmpId: string, managerEmpId: string | null, source: { eventId?: string; job?: string }): Promise<ReassignOutcome> {
    const none: ReassignOutcome = { to: null, rule: null, leads: 0, deals: 0, issueOpened: false };
    const leaver = await tx.employee.findUnique({ where: { empId: leaverEmpId }, select: { id: true, empId: true, status: true } });
    if (!leaver) return none;
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sales_offboard:${leaver.id}`}, 0))`;
    const status = await tx.employee.findUniqueOrThrow({ where: { id: leaver.id }, select: { status: true } });
    if (status.status !== 'left') return none; // only someone Module 3 has processed as left

    const leads = await tx.salesLead.findMany({ where: { ownerId: leaver.id, archivedAt: null }, select: { id: true } });
    const deals = await tx.salesDeal.findMany({ where: { ownerId: leaver.id, stage: { in: [...SALES_OPEN_STAGES] }, archivedAt: null }, select: { id: true, number: true, stage: true, wonStatus: true } });
    if (!leads.length && !deals.length) {
      await this.resolveOpen(tx, leaver.id, null);
      return none;
    }
    const choice = await this.recipient(tx, leaver.id, managerEmpId);
    if (!choice.to) {
      const opened = await this.openIssue(tx, leaver, source, choice.detail, { leads: leads.length, deals: deals.length, managerEmpId });
      return { ...none, issueOpened: opened };
    }
    const to = choice.to;
    // Only rows the leaver still owns (a second run, or a manual move meanwhile, finds nothing here).
    const movedLeads = leads.length
      ? await tx.salesLead.updateMany({ where: { id: { in: leads.map((l) => l.id) }, ownerId: leaver.id, archivedAt: null }, data: { ownerId: to.id, version: { increment: 1 }, updatedBy: null } })
      : { count: 0 };
    let movedDeals: typeof deals = [];
    if (deals.length) {
      // Owner only: a pending Won request (won_status, requester, time) and the stage stay exactly as they are.
      const { count } = await tx.salesDeal.updateMany({
        where: { id: { in: deals.map((d) => d.id) }, ownerId: leaver.id, stage: { in: [...SALES_OPEN_STAGES] }, archivedAt: null },
        data: { ownerId: to.id, version: { increment: 1 }, updatedBy: null },
      });
      movedDeals = count === deals.length ? deals : await tx.salesDeal.findMany({ where: { id: { in: deals.map((d) => d.id) }, ownerId: to.id }, select: { id: true, number: true, stage: true, wonStatus: true } });
      await tx.salesDealHistory.createMany({
        data: movedDeals.map((d) => ({ dealId: d.id, event: 'owner_changed' as const, fromStage: d.stage, toStage: d.stage, actorId: null, reason: 'employee_left', note: `${leaver.empId} to ${to.empId} (left the company)` })),
      });
    }
    for (const l of leads) {
      await this.audit.record({ actorId: null, action: 'sales.lead.reassigned', targetType: 'sales_lead', targetId: l.id, reason: 'employee_left', details: { from: leaver.empId, to: to.empId, by: 'offboarding', rule: choice.rule } }, tx);
    }
    await this.audit.record(
      {
        actorId: null,
        action: 'sales.offboarding.reassigned',
        targetType: 'employee',
        targetId: leaver.empId,
        reason: 'employee_left',
        details: { to: to.empId, rule: choice.rule, leads: movedLeads.count, deals: movedDeals.map((d) => d.number), pendingWon: movedDeals.filter((d) => d.wonStatus === 'pending').map((d) => d.number), eventId: source.eventId ?? null, job: source.job ?? null },
      },
      tx,
    );
    await this.resolveOpen(tx, leaver.id, to.id);
    return { to: to.empId, rule: choice.rule, leads: movedLeads.count, deals: movedDeals.length, issueOpened: false };
  }

  /**
   * The nightly safety net: everyone who has left and still owns leads or open deals (an event that was lost or failed,
   * or someone who left before this reader existed), and every open case (a sales manager may exist by now).
   */
  async sweep(job: string): Promise<{ checked: number; moved: number }> {
    const leavers = await this.prisma.$queryRaw<Array<{ id: string; empId: string }>>`
      SELECT e.id, e.emp_id AS "empId" FROM employees e
      WHERE e.status = 'left' AND (
        EXISTS (SELECT 1 FROM sales_leads l WHERE l.owner_id = e.id AND l.archived_at IS NULL)
        OR EXISTS (SELECT 1 FROM sales_deals d WHERE d.owner_id = e.id AND d.archived_at IS NULL AND d.stage::text = ANY(${[...SALES_OPEN_STAGES]}::text[]))
        OR EXISTS (SELECT 1 FROM sales_reassignment_issues i WHERE i.employee_id = e.id AND i.resolved_at IS NULL))
      ORDER BY e.emp_id`;
    let moved = 0;
    for (const l of leavers) {
      const left = await this.prisma.employmentHistory.findFirst({ where: { employeeId: l.id, eventType: 'left' }, orderBy: { createdAt: 'desc' }, select: { details: true } });
      const managerEmpId = ((left?.details ?? {}) as { managerEmpId?: string | null }).managerEmpId ?? null;
      try {
        const outcome = await this.prisma.$transaction((tx) => this.reassign(tx, l.empId, managerEmpId, { job }));
        if (outcome.to) moved++;
      } catch (error) {
        this.logger.error(`Nightly check could not move what ${l.empId} owns: ${(error as Error).message}`);
      }
    }
    return { checked: leavers.length, moved };
  }

  /** GET /sales/reassignment-issues: open cases, with what the leaver still owns now (sales.team or sales.all). */
  async issues(actor: Actor): Promise<SalesReassignmentIssueView[]> {
    const a = await this.access.of(actor);
    if (!a.team && !a.all) forbidden('not_allowed', 'Only the sales manager sees leads waiting for an owner');
    const rows = await this.prisma.salesReassignmentIssue.findMany({ where: { resolvedAt: null }, include: { employee: { select: { id: true, empId: true, fullName: true } } }, orderBy: { createdAt: 'asc' } });
    const out: SalesReassignmentIssueView[] = [];
    for (const r of rows) {
      const [openLeads, openDeals] = await Promise.all([
        this.prisma.salesLead.count({ where: { ownerId: r.employee.id, archivedAt: null } }),
        this.prisma.salesDeal.count({ where: { ownerId: r.employee.id, archivedAt: null, stage: { in: [...SALES_OPEN_STAGES] } } }),
      ]);
      out.push({ id: r.id, employee: person(r.employee), reason: 'no_recipient', detail: String((r.details as { detail?: string }).detail ?? ''), openLeads, openDeals, createdAt: r.createdAt.toISOString() });
    }
    return out;
  }

  // --------------------------------------------------------------------------------------------------------- helpers

  /** Who receives the leaver's leads (approved decision 7), or why nobody can. */
  private async recipient(tx: Tx, leaverId: string, managerEmpId: string | null): Promise<{ to: { id: string; empId: string } | null; rule: ReassignOutcome['rule']; detail: string }> {
    const holders = await tx.$queryRaw<Array<{ id: string; empId: string }>>`
      SELECT DISTINCT e.id, e.emp_id AS "empId" FROM employee_duties ed
      JOIN duties d ON d.id = ed.duty_id JOIN employees e ON e.id = ed.employee_id
      WHERE d.key = ${SALES_MANAGER_DUTY} AND ed.ended_at IS NULL AND e.status = 'active' AND e.id <> ${leaverId}::uuid
      ORDER BY e.emp_id`;
    if (holders.length === 1) return { to: holders[0], rule: 'sales_manager_duty', detail: '' };
    const dutyText = holders.length === 0 ? 'Nobody holds the sales manager duty' : `${holders.length} people hold the sales manager duty (${holders.map((h) => h.empId).join(', ')})`;
    if (!managerEmpId) return { to: null, rule: null, detail: `${dutyText}, and the leaver had no manager to receive them` };
    const manager = await tx.employee.findUnique({ where: { empId: managerEmpId }, select: { id: true, empId: true, status: true, role: { select: { key: true } } } });
    if (!manager || manager.id === leaverId) return { to: null, rule: null, detail: `${dutyText}, and the leaver's manager ${managerEmpId} was not found` };
    if (manager.status !== 'active') return { to: null, rule: null, detail: `${dutyText}, and the leaver's manager ${managerEmpId} is not active (${manager.status})` };
    // Never the CEO / Owner (view-only for sales), nor anyone else who does not both own and manage sales leads.
    if (manager.role.key === OWNER_ROLE) return { to: null, rule: null, detail: `${dutyText}, and the leaver's manager ${managerEmpId} is the CEO / Owner, who only views sales` };
    const { permissions } = await this.permissions.getEffectiveAccess(manager.id, tx);
    if (!permissions.has(SALES_OWN) || !permissions.has(SALES_MANAGE)) return { to: null, rule: null, detail: `${dutyText}, and the leaver's manager ${managerEmpId} does not manage sales leads` };
    return { to: { id: manager.id, empId: manager.empId }, rule: 'leaver_manager', detail: '' };
  }

  /** One open case per leaver; a second failure for the same leaver adds nothing. Returns whether a case was opened. */
  private async openIssue(tx: Tx, leaver: { id: string; empId: string }, source: { eventId?: string; job?: string }, detail: string, counts: Record<string, unknown>): Promise<boolean> {
    const open = await tx.salesReassignmentIssue.findFirst({ where: { employeeId: leaver.id, resolvedAt: null }, select: { id: true } });
    if (open) return false;
    const issue = await tx.salesReassignmentIssue.create({ data: { employeeId: leaver.id, eventId: source.eventId ?? null, reason: 'no_recipient', details: { detail, ...counts, job: source.job ?? null } as Prisma.InputJsonValue }, select: { id: true } });
    await this.audit.record({ actorId: null, action: 'sales.offboarding.no_recipient', targetType: 'employee', targetId: leaver.empId, reason: 'no_recipient', details: { issue: issue.id, detail, ...counts } as Prisma.InputJsonValue }, tx);
    return true;
  }

  private async resolveOpen(tx: Tx, leaverId: string, toId: string | null): Promise<void> {
    await tx.salesReassignmentIssue.updateMany({ where: { employeeId: leaverId, resolvedAt: null }, data: { resolvedAt: this.clock.now(), resolvedToId: toId } });
  }
}
