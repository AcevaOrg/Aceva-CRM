import { Injectable } from '@nestjs/common';
import {
  type SalesDailyLogView,
  type SalesLogField,
  type SalesProofRequestView,
  type SalesProofStatus,
  type SubmitSalesDailyLogRequest,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { Clock } from '../common/clock';
import { addDays, dayOf, dbDate, pkDate } from '../common/pakistan-time';
import { noteActivity } from '../common/request-context';
import type { Prisma } from '../generated/prisma/client';
import { NotificationService } from '../notifications/notification.service';
import { PrismaService } from '../prisma/prisma.service';
import { SalesAccessService } from './sales-access.service';
import { badRequest, conflict, type Db, forbidden, notFound } from './sales-errors';
import { SalesMetricsService } from './sales-metrics.service';
import { person } from './sales-views';

type Tx = Prisma.TransactionClient;

/** The transaction lock of one person's day: the log and that day's report never change at the same moment. */
export async function lockSalesDay(tx: Tx, employeeId: string, day: string): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`sales_day:${employeeId}:${day}`}, 0))`;
}

type LogRow = Prisma.SalesDailyLogGetPayload<object>;
export const logCounts = (r: Pick<LogRow, SalesLogField>): Record<SalesLogField, number> => ({ linkedin: r.linkedin, whatsapp: r.whatsapp, fiverr: r.fiverr, calls: r.calls, fieldVisits: r.fieldVisits });

const proofInclude = {
  employee: { select: { id: true, empId: true, fullName: true } },
  requestedBy: { select: { empId: true, fullName: true } },
  closedBy: { select: { empId: true, fullName: true } },
  log: { select: { version: true } },
} satisfies Prisma.SalesProofRequestInclude;
type ProofRow = Prisma.SalesProofRequestGetPayload<{ include: typeof proofInclude }>;

/**
 * Module 15.6, the manual daily log (plan section 20: "a short form, filled in before check-out, for work done outside the
 * connected tools: LinkedIn messages, WhatsApp chats, Fiverr inquiries, normal phone calls and field visits. These counts
 * are marked 'self-reported'") and proof requests ("the sales manager can ask for proof, such as a screenshot, for any day").
 *
 * Log (approved decision 13): a salesperson keeps their own log for today, or yesterday until its report is built. Every
 * save is a new version (insert-only) and names the version it read (409 stale_version otherwise); once the day's report
 * exists nothing changes (409 log_locked; also a database trigger), and the report keeps the version it used. The day's
 * lock is shared with the report, so a save and the report never cross. Check-out is not blocked (Module 7 unchanged).
 *
 * Proof: the sales manager asks about a day that has a log (one request at a time per day); the salesperson answers in
 * words (where the proof is, for example a message with the screenshot: no new file store); the manager closes it with a
 * note. Each step is audited; asking notifies the salesperson (sales_proof_requested, Module 12: in the app, by email
 * unless switched off, delivered with retries, once per request).
 */
@Injectable()
export class SalesDailyLogService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly access: SalesAccessService,
    private readonly metrics: SalesMetricsService,
    private readonly notifications: NotificationService,
    private readonly audit: AuditService,
    private readonly clock: Clock,
  ) {}

  private today(): string {
    return pkDate(this.clock.now());
  }

  // -------------------------------------------------------------------------------------------------------------- log

  /** GET /sales/daily-logs/:day?empId: the caller's own log, or (sales.team) a team member's. */
  async get(actor: Actor, day: string, empId?: string): Promise<SalesDailyLogView | null> {
    const who = await this.viewable(actor, empId);
    return this.view(this.prisma, who, day);
  }

  /** PUT /sales/daily-logs/:day: the caller's own log (a new version). */
  async submit(actor: Actor, day: string, dto: SubmitSalesDailyLogRequest, client: RequestInfo): Promise<SalesDailyLogView> {
    if (!(await this.metrics.isSalesperson(actor.id))) forbidden('not_sales_staff', 'Only the sales staff keep a daily sales log');
    const today = this.today();
    if (day > today) badRequest('log_in_future', 'A day that has not come yet has no log');
    if (day < addDays(today, -1)) conflict('log_locked', 'Only today, or yesterday until its report is built, can be changed');
    const me = await this.prisma.employee.findUniqueOrThrow({ where: { id: actor.id }, select: { id: true, empId: true, fullName: true } });
    const version = await this.prisma.$transaction(async (tx) => {
      await lockSalesDay(tx, actor.id, day);
      if (await tx.salesDailyReport.findUnique({ where: { employeeId_day: { employeeId: actor.id, day: dbDate(day) } }, select: { id: true } })) {
        conflict('log_locked', "This day's report is already built; its log no longer changes");
      }
      const current = await tx.salesDailyLog.findFirst({ where: { employeeId: actor.id, day: dbDate(day) }, orderBy: { version: 'desc' }, select: { version: true } });
      if ((current?.version ?? 0) !== dto.version) conflict('stale_version', 'This log was changed meanwhile (another tab?). Reload it');
      const next = (current?.version ?? 0) + 1;
      await tx.salesDailyLog.create({
        data: { employeeId: actor.id, day: dbDate(day), version: next, linkedin: dto.linkedin, whatsapp: dto.whatsapp, fiverr: dto.fiverr, calls: dto.calls, fieldVisits: dto.fieldVisits, note: dto.note ?? null },
      });
      await this.audit.record(
        { actorId: actor.id, action: 'sales.daily_log.saved', targetType: 'sales_daily_log', targetId: `${me.empId}:${day}`, details: { version: next, counts: logCounts(dto), note: dto.note ? '[text]' : null }, ...client },
        tx,
      );
      return next;
    });
    noteActivity({ target: day, description: `Saved the daily sales log of ${day} (version ${version})` });
    return (await this.view(this.prisma, me, day))!;
  }

  // ------------------------------------------------------------------------------------------------------------ proof

  /** GET /sales/proof-requests?status&empId: the caller's own, or (sales.team) the team's. */
  async proofList(actor: Actor, q: { status?: SalesProofStatus; empId?: string }): Promise<SalesProofRequestView[]> {
    const a = await this.access.of(actor);
    const where: Prisma.SalesProofRequestWhereInput[] = [a.all ? {} : a.team ? { employee: { ancestors: { some: { ancestorId: actor.id } } } } : { employeeId: actor.id }];
    if (q.status) where.push({ status: q.status });
    if (q.empId) where.push({ employee: { empId: q.empId } });
    const rows = await this.prisma.salesProofRequest.findMany({ where: { AND: where }, include: proofInclude, orderBy: { requestedAt: 'desc' }, take: 200 });
    return rows.map(proofView);
  }

  /** POST /sales/proof-requests: the sales manager asks for proof of a team member's day. */
  async requestProof(actor: Actor, dto: { empId: string; day: string; note: string }, client: RequestInfo): Promise<SalesProofRequestView> {
    const a = await this.access.of(actor);
    if (!a.manage) forbidden('not_allowed', 'Only the sales manager asks for proof');
    const emp = await this.prisma.employee.findUnique({ where: { empId: dto.empId }, select: { id: true, empId: true, fullName: true } });
    if (!emp) notFound('Employee not found');
    if (emp.id === actor.id) forbidden('self_approval', 'Nobody checks their own log');
    if (!(await this.access.canManage(a, emp.id))) forbidden('not_allowed', `${dto.empId} is not in your sales team`);
    const id = await this.prisma.$transaction(async (tx) => {
      const log = await tx.salesDailyLog.findFirst({ where: { employeeId: emp.id, day: dbDate(dto.day) }, orderBy: { version: 'desc' }, select: { id: true, version: true } });
      if (!log) conflict('no_log', `${dto.empId} has no daily log for ${dto.day}`);
      const open = await tx.salesProofRequest.findFirst({ where: { employeeId: emp.id, day: dbDate(dto.day), status: { not: 'closed' } }, select: { id: true } });
      if (open) conflict('proof_open', 'Proof for this day was already asked and is not closed yet');
      const row = await tx.salesProofRequest.create({ data: { employeeId: emp.id, day: dbDate(dto.day), logId: log.id, note: dto.note, requestedById: actor.id }, select: { id: true } });
      await this.audit.record({ actorId: actor.id, action: 'sales.proof.requested', targetType: 'sales_proof_request', targetId: row.id, reason: dto.note, details: { employee: emp.empId, day: dto.day, logVersion: log.version }, ...client }, tx);
      await this.notifications.create(tx, {
        recipientId: emp.id,
        type: 'sales_proof_requested',
        title: `Proof asked for your sales log of ${dto.day}`,
        body: dto.note,
        link: `/sales/reports?date=${dto.day}`,
        dedupeKey: `sales_proof_requested:${row.id}`,
      });
      return row.id;
    });
    noteActivity({ target: dto.empId, description: `Asked ${dto.empId} for proof of the sales log of ${dto.day}` });
    return this.proofOne(id);
  }

  /** POST /sales/proof-requests/:id/answer: the salesperson answers their own request (once). */
  async answerProof(actor: Actor, id: string, answer: string, client: RequestInfo): Promise<SalesProofRequestView> {
    const row = await this.prisma.salesProofRequest.findUnique({ where: { id }, select: { employeeId: true, status: true } });
    if (!row) notFound('Proof request not found');
    if (row.employeeId !== actor.id) forbidden('not_allowed', 'Only the person asked answers this request');
    const { count } = await this.prisma.salesProofRequest.updateMany({ where: { id, status: 'open' }, data: { status: 'answered', answer, answeredAt: this.clock.now() } });
    if (!count) conflict('not_open', 'This request was already answered or closed');
    await this.audit.record({ actorId: actor.id, action: 'sales.proof.answered', targetType: 'sales_proof_request', targetId: id, ...client });
    noteActivity({ target: id, description: 'Answered a proof request about a sales log' });
    return this.proofOne(id);
  }

  /** POST /sales/proof-requests/:id/close: the sales manager closes it with a note. */
  async closeProof(actor: Actor, id: string, note: string, client: RequestInfo): Promise<SalesProofRequestView> {
    const a = await this.access.of(actor);
    const row = await this.prisma.salesProofRequest.findUnique({ where: { id }, select: { employeeId: true, status: true } });
    if (!row) notFound('Proof request not found');
    if (!a.manage || row.employeeId === actor.id || !(await this.access.canManage(a, row.employeeId))) forbidden('not_allowed', 'Only the sales manager of this person closes the request');
    const { count } = await this.prisma.salesProofRequest.updateMany({ where: { id, status: { in: ['open', 'answered'] } }, data: { status: 'closed', closeNote: note, closedById: actor.id, closedAt: this.clock.now() } });
    if (!count) conflict('not_open', 'This request is already closed');
    await this.audit.record({ actorId: actor.id, action: 'sales.proof.closed', targetType: 'sales_proof_request', targetId: id, reason: note, details: { from: row.status }, ...client });
    noteActivity({ target: id, description: 'Closed a proof request about a sales log' });
    return this.proofOne(id);
  }

  // --------------------------------------------------------------------------------------------------------- helpers

  /** The caller, or (sales.team / sales.all) someone they see. */
  private async viewable(actor: Actor, empId?: string): Promise<{ id: string; empId: string; fullName: string }> {
    const me = await this.prisma.employee.findUniqueOrThrow({ where: { id: actor.id }, select: { id: true, empId: true, fullName: true } });
    if (!empId || empId === me.empId) return me;
    const a = await this.access.of(actor);
    const p = await this.prisma.employee.findUnique({ where: { empId }, select: { id: true, empId: true, fullName: true } });
    if (!p || !(a.all || (a.team && (await this.access.seesFull(a, p.id))))) forbidden('not_allowed', "Only the sales manager sees someone else's log");
    return p;
  }

  async view(db: Db, who: { id: string; empId: string; fullName: string }, day: string): Promise<SalesDailyLogView | null> {
    const versions = await db.salesDailyLog.findMany({ where: { employeeId: who.id, day: dbDate(day) }, orderBy: { version: 'desc' } });
    if (!versions.length) return null;
    const locked = !!(await db.salesDailyReport.findUnique({ where: { employeeId_day: { employeeId: who.id, day: dbDate(day) } }, select: { id: true } })) || day < addDays(this.today(), -1);
    const [cur, ...older] = versions;
    return {
      person: person(who),
      day: dayOf(cur.day),
      version: cur.version,
      counts: logCounts(cur),
      note: cur.note,
      submittedAt: cur.createdAt.toISOString(),
      locked,
      history: older.map((v) => ({ version: v.version, counts: logCounts(v), submittedAt: v.createdAt.toISOString() })),
    };
  }

  private async proofOne(id: string): Promise<SalesProofRequestView> {
    return proofView(await this.prisma.salesProofRequest.findUniqueOrThrow({ where: { id }, include: proofInclude }));
  }
}

export function proofView(r: ProofRow): SalesProofRequestView {
  return {
    id: r.id,
    person: person(r.employee),
    day: dayOf(r.day),
    logVersion: r.log.version,
    status: r.status as SalesProofStatus,
    note: r.note,
    requestedBy: person(r.requestedBy),
    requestedAt: r.requestedAt.toISOString(),
    answer: r.answer,
    answeredAt: r.answeredAt?.toISOString() ?? null,
    closeNote: r.closeNote,
    closedBy: r.closedBy ? person(r.closedBy) : null,
    closedAt: r.closedAt?.toISOString() ?? null,
  };
}
