import { BadRequestException, ConflictException, ForbiddenException, Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { CreateEmployeeRequest, CreateEmployeeResponse } from '@aceva/contracts';
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
import { Mailer } from '../mail/mailer';
import { PrismaService } from '../prisma/prisma.service';

/** Levels the Director or HR may hire into. Level 3 and above are placed by the Owner or CEO (Module 1). */
const HIRE_LEVELS = new Set([4, 5]);

/**
 * The joining workflow (plan section 7):
 *  1. Director or HR fills in the employee profile
 *  2. the system generates the Emp-ID (database sequence, never reused)
 *  3. the system creates the login (Module 2) with a temporary password
 *  4. a welcome message with the temporary password goes to the official email
 *  5. the employee must change the temporary password at first login (Module 2 enforces it)
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

  async create(actor: Actor, dto: CreateEmployeeRequest, client: RequestInfo): Promise<CreateEmployeeResponse> {
    if (!HIRE_LEVELS.has(dto.level)) {
      throw new BadRequestException({ statusCode: 400, code: 'level_not_allowed', message: 'New people join at Level 4 or 5. The Owner or CEO places anyone higher.' });
    }
    const access = await this.permissions.getEffectiveAccess(actor.id);
    if (dto.pay && !access.permissions.has('people.manage_pay')) {
      await this.audit.record({ actorId: actor.id, action: 'access.denied', targetType: 'employee', targetId: null, outcome: 'denied', reason: 'pay_edit_not_allowed', ...client });
      throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message: 'Only the Director enters pay information' });
    }

    const created = await this.prisma.$transaction(async (tx) => {
      await this.hierarchy.lock(tx);
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

      // The role follows the level (and the Sales department's own Level 4 role).
      const roleKey = dto.level === 5 ? 'employee' : department.code === 'dep-sales' ? 'sales' : 'level4_default';
      const role = await tx.role.findUniqueOrThrow({ where: { key: roleKey }, select: { id: true } });

      // Same reporting rules as Module 1: a higher level, or the one configured same-level line.
      const problems = checkLevelRules(
        { id: 'new', empId: 'new', levelNumber: dto.level, roleId: role.id, status: 'active' },
        { id: manager.id, empId: manager.empId, levelNumber: manager.level.number, roleId: manager.roleId, status: manager.status },
        rules,
      );
      if (problems.length) throw new BadRequestException({ statusCode: 400, message: 'This reporting line is not allowed', violations: problems });
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

      // The login (Module 2): a random temporary password, shown to nobody, sent by email.
      const temporary = await this.auth.provisionCredential(employee.id, actor.id, undefined, tx);
      await this.audit.record({ actorId: actor.id, action: 'employee.created', targetType: 'employee', targetId: employee.empId, details: { level: dto.level, department: department.code, reportsTo: manager.empId }, ...client }, tx);
      return { employee, temporary };
    });

    const welcomeEmailSent = await this.sendWelcome(created.employee, created.temporary, actor, client);
    return { empId: created.employee.empId, welcomeEmailSent, payPending: !dto.pay };
  }

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
      // The mailer already logged the failure (without the message body).
      this.logger.warn(`Welcome email for ${employee.empId} was not sent: ${(error as Error).message}`);
      await this.audit.record({ actorId: actor.id, action: 'employee.welcome_email_failed', targetType: 'employee', targetId: employee.empId, outcome: 'denied', reason: 'mail_failed', ...client });
      return false;
    }
  }
}
