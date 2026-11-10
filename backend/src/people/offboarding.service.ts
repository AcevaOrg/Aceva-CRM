import { BadRequestException, ForbiddenException, Injectable, Logger, OnModuleInit } from '@nestjs/common';
import type { OffboardRequest, OffboardResponse } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { AuthService } from '../auth/auth.service';
import { Clock } from '../common/clock';
import { OutboxService } from '../events/outbox.service';
import { JobRunner } from '../jobs/job-runner.service';
import { PrismaService } from '../prisma/prisma.service';
import { accessEndsAt, isDue } from './leaving-rules';
import { PeopleService } from './people.service';

export const OFFBOARD_JOB = 'employee.offboard';
const day = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The leaving workflow (plan section 7). HR or the Director sets the last working day. On that day the system disables
 * login, ends every session, ends duties and stand-in cover, asks Module 5 (open tasks to the manager) and Module 8
 * (final salary) through versioned outbox events (nothing consumes them yet), and keeps the record forever.
 */
@Injectable()
export class OffboardingService implements OnModuleInit {
  private readonly logger = new Logger('Offboarding');

  constructor(
    private readonly prisma: PrismaService,
    private readonly people: PeopleService,
    private readonly auth: AuthService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly jobs: JobRunner,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.jobs.register(OFFBOARD_JOB, async (payload) => this.process(String(payload.empId)));
  }

  private async requireAdmin(actor: Actor, empId: string, client: RequestInfo) {
    const target = await this.people.requireTarget(empId);
    const access = await this.people.accessFor(actor, target);
    if (!access.edit.basic) {
      await this.audit.record({ actorId: actor.id, action: 'access.denied', targetType: 'employee', targetId: empId, outcome: 'denied', reason: 'offboard_not_allowed', ...client });
      throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message: 'You do not have access to this' });
    }
    return target;
  }

  /** Sets (or moves) the last working day. The person keeps access through that whole day; access ends at 00:00 Pakistan time on the next day. A last working day that is already over is processed straight away, otherwise it is scheduled. */
  async offboard(actor: Actor, empId: string, dto: OffboardRequest, client: RequestInfo): Promise<OffboardResponse> {
    const target = await this.requireAdmin(actor, empId, client);
    if (target.status === 'left') throw new BadRequestException({ statusCode: 400, code: 'employee_left', message: 'This employee has already left' });
    if (dto.lastWorkingDay < day(target.joiningDate)) {
      throw new BadRequestException({ statusCode: 400, code: 'before_joining', message: 'The last working day cannot be before the joining date' });
    }
    const now = this.clock.now();
    const due = isDue(dto.lastWorkingDay, now);
    const previous = target.lastWorkingDay ? day(target.lastWorkingDay) : null;

    await this.prisma.$transaction(async (tx) => {
      await tx.employee.update({ where: { id: target.id }, data: { status: 'on_notice', lastWorkingDay: new Date(`${dto.lastWorkingDay}T00:00:00.000Z`), updatedBy: actor.id } });
      await this.people.writeHistory(
        tx,
        target.id,
        actor.id,
        [
          ...(target.status !== 'on_notice' ? [{ section: 'job' as const, field: 'Status', oldValue: 'Active', newValue: 'On notice' }] : []),
          { section: 'job' as const, field: 'Last working day', oldValue: previous ?? '', newValue: dto.lastWorkingDay },
        ],
        dto.reason,
      );
      await tx.employmentHistory.create({ data: { employeeId: target.id, eventType: 'notice_given', effectiveOn: new Date(`${dto.lastWorkingDay}T00:00:00.000Z`), details: { lastWorkingDay: dto.lastWorkingDay, previous }, reason: dto.reason, createdBy: actor.id } });
      await this.jobs.schedule(OFFBOARD_JOB, `offboard:${empId}`, due ? now : accessEndsAt(dto.lastWorkingDay), { empId }, actor.id, tx);
      await this.audit.record({ actorId: actor.id, action: previous ? 'employee.offboarding.rescheduled' : 'employee.offboarding.set', targetType: 'employee', targetId: empId, reason: dto.reason, details: { lastWorkingDay: dto.lastWorkingDay, previous }, ...client }, tx);
    });

    if (due) await this.jobs.tick();
    const after = await this.prisma.employee.findUniqueOrThrow({ where: { empId }, select: { status: true } });
    return {
      empId,
      lastWorkingDay: dto.lastWorkingDay,
      processed: after.status === 'left' ? 'now' : 'scheduled',
      directReportsNeedingManager: await this.directReports(target.id),
    };
  }

  /** Takes back a leaving date that has not been processed yet. */
  async cancel(actor: Actor, empId: string, reason: string, client: RequestInfo): Promise<{ ok: true }> {
    const target = await this.requireAdmin(actor, empId, client);
    if (target.status !== 'on_notice') throw new BadRequestException({ statusCode: 400, code: 'not_on_notice', message: 'This employee is not on notice' });
    await this.prisma.$transaction(async (tx) => {
      await tx.employee.update({ where: { id: target.id }, data: { status: 'active', lastWorkingDay: null, updatedBy: actor.id } });
      await tx.scheduledJob.updateMany({ where: { dedupeKey: `offboard:${empId}`, status: { in: ['pending', 'failed'] } }, data: { status: 'succeeded', completedAt: this.clock.now(), lastError: 'cancelled' } });
      await this.people.writeHistory(tx, target.id, actor.id, [{ section: 'job', field: 'Status', oldValue: 'On notice', newValue: 'Active' }], reason);
      await this.audit.record({ actorId: actor.id, action: 'employee.offboarding.cancelled', targetType: 'employee', targetId: empId, reason, ...client }, tx);
    });
    return { ok: true };
  }

  /**
   * Runs on the last working day. Safe to run twice (a retry after a failure, or two servers): it does nothing unless the
   * employee is still on notice and the day has come, and the final login lock is applied again every time.
   */
  async process(empId: string): Promise<void> {
    const row = await this.prisma.employee.findUnique({ where: { empId }, select: { id: true, status: true, lastWorkingDay: true } });
    if (!row) return;
    if (row.status === 'on_notice' && row.lastWorkingDay && isDue(day(row.lastWorkingDay), this.clock.now())) {
      await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ status: string }>>`SELECT status FROM employees WHERE id = ${row.id}::uuid FOR UPDATE`;
        if (locked[0]?.status !== 'on_notice') return;
        const lastDay = day(row.lastWorkingDay!);
        const now = this.clock.now();
        const manager = await this.firstActiveManager(tx, row.id);
        const reports = await tx.employee.findMany({ where: { reportsToId: row.id, status: { not: 'left' } }, select: { empId: true } });

        await tx.employee.update({ where: { id: row.id }, data: { status: 'left' } });
        await tx.employmentHistory.create({ data: { employeeId: row.id, eventType: 'left', effectiveOn: row.lastWorkingDay!, details: { lastWorkingDay: lastDay, managerEmpId: manager } } });
        await tx.employeeDuty.updateMany({ where: { employeeId: row.id, endedAt: null }, data: { endedAt: now } });
        await tx.standIn.updateMany({ where: { revokedAt: null, OR: [{ managerId: row.id }, { standInId: row.id }] }, data: { revokedAt: now } });
        const headed = await tx.department.updateMany({ where: { headEmployeeId: row.id }, data: { headEmployeeId: null } });

        await this.outbox.emit({ type: 'employee.offboarded', actor: 'system', payload: { empId, lastWorkingDay: lastDay, managerEmpId: manager } }, tx);
        if (manager) await this.outbox.emit({ type: 'task.transfer.requested', actor: 'system', payload: { fromEmpId: empId, toEmpId: manager, reason: 'employee_left' } }, tx);
        await this.outbox.emit({ type: 'payroll.final_settlement.requested', actor: 'system', payload: { empId, lastWorkingDay: lastDay } }, tx);
        await this.audit.record({ actorId: null, action: 'employee.offboarded', targetType: 'employee', targetId: empId, details: { lastWorkingDay: lastDay, taskTransferTo: manager, departmentsLeftWithoutHead: headed.count, directReportsNeedingManager: reports.map((r) => r.empId) } }, tx);
      });
    }
    const after = await this.prisma.employee.findUnique({ where: { id: row.id }, select: { status: true } });
    // Applied outside the transaction (it also ends sessions in Redis), and again on every retry.
    if (after?.status === 'left') await this.auth.disableLogin(row.id, null);
  }

  private async directReports(id: string): Promise<string[]> {
    const rows = await this.prisma.employee.findMany({ where: { reportsToId: id, status: { not: 'left' } }, orderBy: { empId: 'asc' }, select: { empId: true } });
    return rows.map((r) => r.empId);
  }

  /** The nearest manager above who has not left (open tasks go to them). */
  private async firstActiveManager(tx: Pick<PrismaService, 'employee'>, id: string): Promise<string | null> {
    let current = await tx.employee.findUnique({ where: { id }, select: { reportsToId: true } });
    for (let i = 0; i < 10 && current?.reportsToId; i++) {
      const manager = await tx.employee.findUnique({ where: { id: current.reportsToId }, select: { empId: true, status: true, reportsToId: true } });
      if (!manager) return null;
      if (manager.status !== 'left') return manager.empId;
      current = manager;
    }
    return null;
  }
}
