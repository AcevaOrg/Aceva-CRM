import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ApproveHireRequest, ApproveHireResponse, CreateEmployeeRequest, CreateEmployeeResponse, HireRequestView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { HierarchyService } from '../access/hierarchy.service';
import { PermissionService } from '../access/permission.service';
import { checkLevelRules } from '../access/rules/reporting-rules';
import { AuthService } from '../auth/auth.service';
import { CryptoService } from '../auth/crypto.service';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { Prisma } from '../generated/prisma/client';
import { Mailer } from '../mail/mailer';
import { PrismaService } from '../prisma/prisma.service';

/** Levels HR may START a hire at. The Director authorizes the level and reporting line (and hires at Levels 3 to 5 directly). */
const REQUEST_LEVELS = new Set([4, 5]);

type Sensitive = Pick<CreateEmployeeRequest, 'personal' | 'pay'>;
const day = (d: Date): string => d.toISOString().slice(0, 10);

/**
 * The joining workflow (plan section 7, with decision M3-3, in the final company structure):
 *  1. HR fills in the profile. This only STARTS the hire (a request at Level 4 or 5).
 *  2. The Director authorizes the level and reporting line (and may correct them). The Director can also hire directly,
 *     at Levels 3 to 5 (never at or above their own level). The CEO / Founder / Owner sees the requests but hires nobody.
 *  3. On approval the system generates the Emp-ID, creates the login (Module 2) with a temporary password and emails it.
 *  4. The employee must change the temporary password at first login (Module 2 enforces it).
 * No Emp-ID, login or employee record exists before step 2.
 */
@Injectable()
export class JoiningService {
  private readonly logger = new Logger('Joining');

  constructor(
    private readonly prisma: PrismaService,
    private readonly auth: AuthService,
    private readonly crypto: CryptoService,
    private readonly hierarchy: HierarchyService,
    private readonly permissions: PermissionService,
    private readonly audit: AuditService,
    private readonly mailer: Mailer,
    @Inject(ENV) private readonly env: Env,
  ) {}

  // ===================================================================== start a hire / hire directly

  async create(actor: Actor, dto: CreateEmployeeRequest, client: RequestInfo): Promise<CreateEmployeeResponse> {
    const access = await this.permissions.getEffectiveAccess(actor.id);
    const canAuthorize = access.permissions.has('org.manage'); // the Director
    if (!canAuthorize && !access.permissions.has('people.manage')) {
      await this.audit.record({ actorId: actor.id, action: 'access.denied', targetType: 'employee', targetId: null, outcome: 'denied', reason: 'hire_not_allowed', ...client });
      throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message: 'You do not have access to this' });
    }
    if (!canAuthorize && !REQUEST_LEVELS.has(dto.level)) {
      throw new BadRequestException({ statusCode: 400, code: 'level_not_allowed', message: 'You can start a hire at Level 4 or 5. The Director places anyone higher.' });
    }
    if (dto.pay && !access.permissions.has('people.manage_pay')) {
      await this.audit.record({ actorId: actor.id, action: 'access.denied', targetType: 'employee', targetId: null, outcome: 'denied', reason: 'pay_edit_not_allowed', ...client });
      throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message: 'Only the Director enters pay information' });
    }

    if (canAuthorize) {
      const made = await this.materialize(actor, dto, actor.id, null, client);
      return { status: 'created', ...made };
    }

    // HR: validate now (so mistakes show immediately), then wait for the Director.
    const request = await this.prisma.$transaction(async (tx) => {
      await this.validate(tx, dto);
      if (await tx.hireRequest.findFirst({ where: { officialEmail: dto.officialEmail, status: 'pending' } })) {
        throw new ConflictException({ statusCode: 409, code: 'email_taken', message: 'A hire with that official email is already waiting for approval' });
      }
      const row = await tx.hireRequest.create({
        data: {
          name: dto.name,
          designation: dto.designation,
          departmentCode: dto.departmentId,
          officeCode: dto.officeId,
          officialEmail: dto.officialEmail,
          joiningDate: new Date(`${dto.joiningDate}T00:00:00.000Z`),
          employmentType: dto.type,
          weeklyCapacityHours: dto.weeklyCapacityHours ?? null,
          proposedLevel: dto.level,
          proposedReportsTo: dto.reportsToEmpId,
          sensitiveEncrypted: dto.personal || dto.pay ? this.crypto.encrypt(JSON.stringify({ personal: dto.personal, pay: dto.pay } satisfies Sensitive)) : null,
          requestedBy: actor.id,
        },
      });
      await this.audit.record({ actorId: actor.id, action: 'hire.requested', targetType: 'hire_request', targetId: row.id, details: { level: dto.level, reportsTo: dto.reportsToEmpId, department: dto.departmentId }, ...client }, tx);
      return row;
    });
    return { status: 'pending_approval', requestId: request.id, payPending: !dto.pay };
  }

  // ===================================================================== authorize

  /** The Director, HR and the CEO / Founder / Owner (who sees everything, view only) see the requests. */
  async list(actor: Actor, status?: string): Promise<HireRequestView[]> {
    const access = await this.permissions.getEffectiveAccess(actor.id);
    const allowed = ['org.manage', 'people.manage', 'people.view_personal'].some((p) => access.permissions.has(p));
    if (!allowed) throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message: 'You do not have access to this' });
    const rows = await this.prisma.hireRequest.findMany({
      where: status && ['pending', 'approved', 'rejected'].includes(status) ? { status: status as 'pending' } : {},
      orderBy: { requestedAt: 'desc' },
      take: 100,
      include: { requester: { select: { empId: true } }, decider: { select: { empId: true } }, employee: { select: { empId: true } } },
    });
    return rows.map((r) => ({
      id: r.id,
      status: r.status,
      name: r.name,
      designation: r.designation,
      departmentId: r.departmentCode,
      officeId: r.officeCode,
      officialEmail: r.officialEmail,
      joiningDate: day(r.joiningDate),
      type: r.employmentType,
      proposedLevel: r.proposedLevel,
      proposedReportsTo: r.proposedReportsTo,
      requestedBy: r.requester.empId,
      requestedAt: r.requestedAt.toISOString(),
      decidedBy: r.decider?.empId ?? null,
      decidedAt: r.decidedAt?.toISOString() ?? null,
      decisionReason: r.decisionReason,
      empId: r.employee?.empId ?? null,
    }));
  }

  /** The Director authorizes the level and reporting line; only now does the employee come into existence. */
  async approve(actor: Actor, requestId: string, body: ApproveHireRequest, client: RequestInfo): Promise<ApproveHireResponse> {
    const row = await this.prisma.hireRequest.findUnique({ where: { id: requestId } });
    if (!row) throw new NotFoundException('Hire request not found');
    if (row.status !== 'pending') throw new ConflictException({ statusCode: 409, code: 'already_decided', message: `This request was already ${row.status}` });
    await this.assertMayDecide(actor, row.requestedBy, body.level ?? row.proposedLevel, client);
    const extra: Sensitive = row.sensitiveEncrypted ? (JSON.parse(this.crypto.decrypt(row.sensitiveEncrypted)) as Sensitive) : {};
    const dto: CreateEmployeeRequest = {
      name: row.name,
      designation: row.designation,
      departmentId: row.departmentCode,
      officeId: row.officeCode,
      officialEmail: row.officialEmail,
      level: body.level ?? row.proposedLevel,
      reportsToEmpId: body.reportsToEmpId ?? row.proposedReportsTo,
      joiningDate: day(row.joiningDate),
      type: row.employmentType,
      ...(row.weeklyCapacityHours !== null ? { weeklyCapacityHours: row.weeklyCapacityHours } : {}),
      ...extra,
    };
    const made = await this.materialize(actor, dto, row.requestedBy, row.id, client, { corrected: dto.level !== row.proposedLevel || dto.reportsToEmpId !== row.proposedReportsTo });
    return { empId: made.empId, welcomeEmailSent: made.welcomeEmailSent };
  }

  async reject(actor: Actor, requestId: string, reason: string, client: RequestInfo): Promise<{ ok: true }> {
    const found = await this.prisma.hireRequest.findUnique({ where: { id: requestId }, select: { requestedBy: true } });
    if (!found) throw new NotFoundException('Hire request not found');
    await this.assertMayDecide(actor, found.requestedBy, null, client);
    const { count } = await this.prisma.hireRequest.updateMany({ where: { id: requestId, status: 'pending' }, data: { status: 'rejected', decidedBy: actor.id, decidedAt: new Date(), decisionReason: reason } });
    if (count === 0) {
      if (!(await this.prisma.hireRequest.findUnique({ where: { id: requestId }, select: { id: true } }))) throw new NotFoundException('Hire request not found');
      throw new ConflictException({ statusCode: 409, code: 'already_decided', message: 'This request was already decided' });
    }
    await this.audit.record({ actorId: actor.id, action: 'hire.rejected', targetType: 'hire_request', targetId: requestId, reason, ...client });
    return { ok: true };
  }

  /**
   * Who decides a hire request (decision D25, as the project owner decided): the Director decides every request except the
   * Director's own, which the Owner decides. Nobody decides their own request. An approver below the Director never places
   * a new hire at their own level or above.
   */
  private async assertMayDecide(actor: Actor, requestedBy: string, level: number | null, client: RequestInfo): Promise<void> {
    const deny = async (reason: string, message: string): Promise<never> => {
      await this.audit.record({ actorId: actor.id, action: 'access.denied', targetType: 'hire_request', targetId: null, outcome: 'denied', reason, ...client });
      throw new ForbiddenException({ statusCode: 403, code: reason, message });
    };
    if (requestedBy === actor.id) await deny('self_approval', 'You made this hire request; a different person decides it');
    const requester = await this.prisma.employee.findUnique({ where: { id: requestedBy }, select: { role: { select: { key: true } } } });
    const madeByDirector = requester?.role.key === 'director';
    if (actor.levelNumber === 1) {
      if (!madeByDirector) await deny('owner_decides_director_only', 'The Owner decides only the hire requests the Director made');
      return;
    }
    if (madeByDirector) await deny('owner_decides', "The Director's hire requests are decided by the Owner");
    if (actor.levelNumber > 2 && level !== null && level <= actor.levelNumber) {
      await deny('level_not_allowed', 'A hire at your own level or above is authorized by the Director');
    }
  }

  // ===================================================================== creating the employee

  /** Checks department, office, manager and the reporting rules (the same rules as Module 1). Returns what the insert needs. */
  private async validate(tx: Prisma.TransactionClient, dto: CreateEmployeeRequest) {
    const [department, office, manager, level, rules] = await Promise.all([
      tx.department.findFirst({ where: { code: dto.departmentId, archivedAt: null } }),
      tx.office.findFirst({ where: { code: dto.officeId, archivedAt: null } }),
      tx.employee.findUnique({ where: { empId: dto.reportsToEmpId }, select: { id: true, empId: true, status: true, roleId: true, level: { select: { number: true } } } }),
      tx.level.findUnique({ where: { number: dto.level }, select: { id: true } }),
      tx.sameLevelReportingRule.findMany({ select: { managerRoleId: true, employeeRoleId: true } }),
    ]);
    if (!department) throw new BadRequestException({ statusCode: 400, code: 'unknown_department', message: 'That department does not exist or is deactivated' });
    if (!office) throw new BadRequestException({ statusCode: 400, code: 'unknown_office', message: 'That office does not exist or is deactivated' });
    if (!manager) throw new NotFoundException(`Employee ${dto.reportsToEmpId} not found`);
    if (!level) throw new BadRequestException('Unknown level');

    // The role follows the level: the level's default role (L3 cto, L4 sales, L5 employee), except that a Level 4
    // hire in the Finance department gets the finance role (the Finance duty is given separately by the Director).
    const role =
      dto.level === 4 && department.code === 'dep-fin'
        ? await tx.role.findUniqueOrThrow({ where: { key: 'finance' }, select: { id: true } })
        : await tx.role.findFirstOrThrow({ where: { isDefault: true, level: { number: dto.level } }, select: { id: true } });
    const problems = checkLevelRules(
      { id: 'new', empId: 'new', levelNumber: dto.level, roleId: role.id, status: 'active' },
      { id: manager.id, empId: manager.empId, levelNumber: manager.level.number, roleId: manager.roleId, status: manager.status },
      rules,
    );
    if (problems.length) throw new BadRequestException({ statusCode: 400, message: 'This reporting line is not allowed', violations: problems });
    return { department, office, manager, level, role };
  }

  private async materialize(actor: Actor, dto: CreateEmployeeRequest, requestedBy: string, requestId: string | null, client: RequestInfo, meta: { corrected?: boolean } = {}) {
    // Privilege-escalation guard (the same rule as a level change): nobody places a new person at or above their own level.
    if (dto.level <= actor.levelNumber) {
      await this.audit.record({ actorId: actor.id, action: 'access.denied', targetType: 'employee', targetId: null, outcome: 'denied', reason: 'level_not_assignable', details: { requestedLevel: String(dto.level) }, ...client });
      throw new ForbiddenException({ statusCode: 403, code: 'level_not_assignable', message: `You cannot place someone at Level ${dto.level}` });
    }
    const created = await this.prisma.$transaction(async (tx) => {
      await this.hierarchy.lock(tx);
      const { department, office, manager, level, role } = await this.validate(tx, dto);
      if (await tx.employee.findFirst({ where: { officialEmail: dto.officialEmail } })) {
        throw new ConflictException({ statusCode: 409, code: 'email_taken', message: 'That official email is already used' });
      }
      const employee = await tx.employee.create({
        data: {
          // empId is generated by the database sequence: sequential, unique even for simultaneous hires, never reused
          fullName: dto.name,
          designation: dto.designation,
          departmentId: department.id,
          officeId: office.id,
          officialEmail: dto.officialEmail,
          levelId: level.id,
          roleId: role.id,
          reportsToId: manager.id,
          joiningDate: new Date(`${dto.joiningDate}T00:00:00.000Z`),
          employmentType: dto.type,
          weeklyCapacityHours: dto.weeklyCapacityHours ?? (dto.type === 'full_time' ? 40 : 20),
          createdBy: actor.id,
        },
        select: { id: true, empId: true, fullName: true, officialEmail: true },
      });
      await this.hierarchy.addLeaf(tx, employee.id, manager.id);

      if (dto.personal) {
        const p = dto.personal;
        await tx.employeePersonal.create({
          data: {
            employeeId: employee.id,
            cnicEncrypted: p.cnic ? this.crypto.encrypt(p.cnic) : null,
            cnicLast4: p.cnic ? p.cnic.replace(/\D/g, '').slice(-4) : null,
            phone: p.phone ?? null,
            homeAddress: p.homeAddress ?? null,
            emergencyContactName: p.emergencyContact?.name ?? null,
            emergencyContactRelation: p.emergencyContact?.relation ?? null,
            emergencyContactPhone: p.emergencyContact?.phone ?? null,
            createdBy: actor.id,
          },
        });
      }
      if (dto.pay) {
        const pay = dto.pay;
        await tx.employeePay.create({
          data: {
            employeeId: employee.id,
            baseSalary: pay.baseSalary.toFixed(2),
            allowances: (pay.allowances ?? 0).toFixed(2),
            bankName: pay.bankName ?? null,
            bankAccountEncrypted: pay.accountNumber ? this.crypto.encrypt(pay.accountNumber) : null,
            bankAccountLast4: pay.accountNumber ? pay.accountNumber.replace(/[^A-Za-z0-9]/g, '').slice(-4) : null,
            createdBy: actor.id,
          },
        });
      }
      await tx.employmentHistory.create({
        data: { employeeId: employee.id, eventType: 'joined', effectiveOn: new Date(`${dto.joiningDate}T00:00:00.000Z`), details: { designation: dto.designation, department: department.name, reportsTo: manager.empId }, createdBy: actor.id },
      });
      if (requestId) {
        const { count } = await tx.hireRequest.updateMany({ where: { id: requestId, status: 'pending' }, data: { status: 'approved', decidedBy: actor.id, decidedAt: new Date(), employeeId: employee.id } });
        if (count === 0) throw new ConflictException({ statusCode: 409, code: 'already_decided', message: 'This request was already decided' });
      }

      // The login (Module 2): a random temporary password, shown to nobody, sent by email.
      const temporary = await this.auth.provisionCredential(employee.id, actor.id, undefined, tx);
      await this.audit.record(
        {
          actorId: actor.id,
          action: requestId ? 'hire.approved' : 'employee.created',
          targetType: 'employee',
          targetId: employee.empId,
          details: { level: dto.level, department: department.code, reportsTo: manager.empId, requestId, requestedBy, correctedByAuthorizer: !!meta.corrected },
          ...client,
        },
        tx,
      );
      return { employee, temporary };
    });

    const welcomeEmailSent = await this.sendWelcome(created.employee, created.temporary, actor, client);
    return { empId: created.employee.empId, welcomeEmailSent, payPending: !dto.pay };
  }

  // ===================================================================== welcome email

  /** The welcome email did not arrive: issue a new temporary password and send it again (only before first login). */
  async resendWelcome(actor: Actor, empId: string, client: RequestInfo): Promise<{ welcomeEmailSent: boolean }> {
    const employee = await this.prisma.employee.findUnique({ where: { empId }, select: { id: true, empId: true, fullName: true, officialEmail: true, status: true, level: { select: { number: true } } } });
    if (!employee) throw new NotFoundException('Employee not found');
    if (employee.status === 'left') throw new BadRequestException({ statusCode: 400, code: 'employee_left', message: 'This employee has left the company' });
    if (employee.id === actor.id || employee.level.number <= actor.levelNumber) {
      await this.audit.record({ actorId: actor.id, action: 'access.denied', targetType: 'employee', targetId: empId, outcome: 'denied', reason: 'out_of_scope', ...client });
      throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message: 'You do not have access to this' });
    }
    const temporary = await this.auth.issueWelcomePassword(employee.id, actor.id);
    return { welcomeEmailSent: await this.sendWelcome(employee, temporary, actor, client) };
  }

  private async sendWelcome(employee: { empId: string; fullName: string; officialEmail: string | null }, temporary: string, actor: Actor, client: RequestInfo): Promise<boolean> {
    if (!employee.officialEmail) return false;
    try {
      await this.mailer.send({
        to: employee.officialEmail,
        subject: 'Welcome to Aceva',
        text:
          `Hello ${employee.fullName},\n\nWelcome to Aceva. Your account is ready.\n\n` +
          `Emp-ID: ${employee.empId}\nTemporary password: ${temporary}\nSign in at: ${this.env.APP_URL}/login\n\n` +
          `You must choose your own password the first time you sign in. Please do not share this email.`,
      });
      return true;
    } catch (error) {
      this.logger.warn(`Welcome email for ${employee.empId} was not sent: ${(error as Error).message}`);
      await this.audit.record({ actorId: actor.id, action: 'employee.welcome_email_failed', targetType: 'employee', targetId: employee.empId, outcome: 'denied', reason: 'mail_failed', ...client });
      return false;
    }
  }
}
