import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type {
  DirectoryEntry,
  DocumentView,
  FieldChangeView,
  ProfileAccessView,
  ProfileResponse,
  UpdateBasicRequest,
  UpdateJobRequest,
  UpdatePayRequest,
  UpdatePersonalRequest,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { PermissionService } from '../access/permission.service';
import { ScopeService } from '../access/scope.service';
import { CryptoService } from '../auth/crypto.service';
import { Prisma } from '../generated/prisma/client';
import { OrgService } from '../org/org.service';
import { PrismaService } from '../prisma/prisma.service';
import { computeProfileAccess } from './profile-access';

type Db = PrismaService | Prisma.TransactionClient;

const targetSelect = {
  id: true,
  empId: true,
  fullName: true,
  designation: true,
  photoKey: true,
  officialEmail: true,
  status: true,
  joiningDate: true,
  employmentType: true,
  weeklyCapacityHours: true,
  lastWorkingDay: true,
  level: { select: { number: true } },
  role: { select: { key: true } },
  reportsTo: { select: { empId: true } },
  department: { select: { id: true, code: true, name: true } },
  office: { select: { id: true, code: true, name: true } },
  personal: true,
  pay: true,
} satisfies Prisma.EmployeeSelect;

export type TargetRow = Prisma.EmployeeGetPayload<{ select: typeof targetSelect }>;

const day = (d: Date): string => d.toISOString().slice(0, 10);
const money = (d: Prisma.Decimal | null | undefined): string => (d ? d.toFixed(2) : '0.00');
/** ********1234: everything but the last four characters hidden. */
export const maskTail = (value: string, keep = 4): string => '*'.repeat(Math.max(0, value.length - keep)) + value.slice(-keep);
const last4 = (value: string): string => value.replace(/[^A-Za-z0-9]/g, '').slice(-4);
/** ********1234: hides everything but the last four letters or digits (dashes ignored). */
const maskId = (value: string): string => '*'.repeat(Math.max(0, value.replace(/[^A-Za-z0-9]/g, '').length - 4)) + last4(value);

/** The labels the history screen shows. */
const LABEL = {
  name: 'Name',
  designation: 'Designation',
  department: 'Department',
  office: 'Office',
  email: 'Official email',
  joining: 'Joining date',
  type: 'Type',
  capacity: 'Weekly capacity',
  cnic: 'CNIC',
  phone: 'Phone',
  address: 'Address',
  emergency: 'Emergency contact',
  salary: 'Base salary',
  allowances: 'Allowances',
  bank: 'Bank',
  account: 'Bank account',
} as const;

const TYPE_LABEL = { full_time: 'Full-time', part_time: 'Part-time', intern: 'Intern' } as const;

interface Change {
  section: 'basic' | 'job' | 'personal' | 'pay';
  field: string;
  oldValue: string;
  newValue: string;
}

/**
 * Employee profiles (plan section 7): one central employee record, visible and editable by section.
 * Every rule is enforced here on the server; the forms only mirror it.
 */
@Injectable()
export class PeopleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly scope: ScopeService,
    private readonly crypto: CryptoService,
    private readonly audit: AuditService,
    private readonly org: OrgService,
  ) {}

  // ===================================================================== reading

  /** The staff directory: basic information about everyone still with the company. */
  async directory(q?: string): Promise<DirectoryEntry[]> {
    const rows = await this.prisma.employee.findMany({
      where: {
        status: { not: 'left' },
        ...(q ? { OR: [{ fullName: { contains: q, mode: 'insensitive' } }, { empId: { contains: q, mode: 'insensitive' } }, { designation: { contains: q, mode: 'insensitive' } }] } : {}),
      },
      orderBy: { empId: 'asc' },
      select: { empId: true, fullName: true, designation: true, officialEmail: true, photoKey: true, department: { select: { code: true } }, office: { select: { code: true } } },
    });
    return rows.map((r) => ({
      empId: r.empId,
      name: r.fullName,
      designation: r.designation,
      departmentId: r.department.code,
      officeId: r.office.code,
      officialEmail: r.officialEmail,
      hasPhoto: !!r.photoKey,
    }));
  }

  /** One profile: only the sections the caller may see. */
  async profile(actor: Actor, empId: string): Promise<ProfileResponse> {
    const target = await this.requireTarget(empId);
    const access = await this.accessFor(actor, target);
    const response: ProfileResponse = { basic: this.basicOf(target), access };

    if (access.see.job) {
      response.job = {
        level: target.level.number,
        roleKey: target.role.key,
        reportsTo: target.reportsTo?.empId ?? null,
        joiningDate: day(target.joiningDate),
        type: target.employmentType,
        status: target.status,
        lastWorkingDay: target.lastWorkingDay ? day(target.lastWorkingDay) : null,
        weeklyCapacityHours: target.weeklyCapacityHours,
      };
    }
    if (access.see.personal) {
      const p = target.personal;
      response.personal = {
        cnicMasked: p?.cnicLast4 ? maskTail(`${'0'.repeat(9)}${p.cnicLast4}`) : null,
        phone: p?.phone ?? null,
        homeAddress: p?.homeAddress ?? null,
        emergencyContact: p?.emergencyContactName ? { name: p.emergencyContactName, relation: p.emergencyContactRelation ?? '', phone: p.emergencyContactPhone ?? '' } : null,
      };
    }
    if (access.see.pay) {
      const p = target.pay;
      response.pay = {
        baseSalary: money(p?.baseSalary),
        allowances: money(p?.allowances),
        currency: 'PKR',
        bankName: p?.bankName ?? null,
        accountMasked: p?.bankAccountLast4 ? maskTail(`${'0'.repeat(8)}${p.bankAccountLast4}`) : null,
      };
    }
    if (access.see.history) response.history = await this.history(target, access);
    if (access.see.documents) response.documents = await this.documentList(target.id);
    return response;
  }

  /** Document records (never the files). */
  async documentList(employeeId: string): Promise<DocumentView[]> {
    const rows = await this.prisma.employeeDocument.findMany({ where: { employeeId, archivedAt: null }, orderBy: { createdAt: 'desc' } });
    const people = await this.prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.createdBy).filter((v): v is string => !!v))] } }, select: { id: true, empId: true } });
    const empIdOf = new Map(people.map((x) => [x.id, x.empId]));
    return rows.map((r) => ({ id: r.id, kind: r.type, title: r.title, fileName: r.originalFilename, mimeType: r.mimeType, sizeBytes: r.sizeBytes, uploadedAt: r.createdAt.toISOString(), uploadedBy: r.createdBy ? (empIdOf.get(r.createdBy) ?? null) : null }));
  }

  /** Field-by-field history the caller may see. Sensitive values were stored encrypted. */
  async history(target: { id: string }, access: ProfileAccessView): Promise<FieldChangeView[]> {
    const rows = await this.prisma.profileChange.findMany({
      where: {
        employeeId: target.id,
        section: { in: ['basic', 'job', ...(access.see.personal ? (['personal'] as const) : []), ...(access.see.pay ? (['pay'] as const) : [])] },
      },
      orderBy: { changedAt: 'desc' },
      take: 200,
    });
    const people = await this.prisma.employee.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.changedBy))] } }, select: { id: true, empId: true } });
    const empIdOf = new Map(people.map((p) => [p.id, p.empId]));
    const reveal = (value: string | null, row: { isSensitive: boolean; field: string }): string => {
      if (!value) return '—';
      const plain = row.isSensitive ? this.crypto.decrypt(value) : value;
      // CNIC and bank account numbers are never shown in full in history.
      return row.field === LABEL.cnic || row.field === LABEL.account ? maskId(plain) : plain;
    };
    return rows.map((r) => ({
      id: r.id,
      section: r.section as FieldChangeView['section'],
      field: r.field,
      oldValue: reveal(r.oldValue, r),
      newValue: reveal(r.newValue, r),
      changedBy: empIdOf.get(r.changedBy) ?? null,
      changedAt: r.changedAt.toISOString(),
      ...(r.reason ? { reason: r.reason } : {}),
    }));
  }

  /** Shows a masked CNIC or bank account number to someone allowed to see that section. Logged EVERY time. */
  async reveal(actor: Actor, empId: string, field: 'cnic' | 'account' | 'salary', client: RequestInfo): Promise<{ value: string }> {
    const target = await this.requireTarget(empId);
    const access = await this.accessFor(actor, target);
    const allowed = field === 'cnic' ? access.revealCnic : access.revealPay;
    if (!allowed) return this.deny(actor, 'reveal_not_allowed', empId, client);
    const label = { cnic: 'CNIC', account: 'bank account', salary: 'salary' }[field];
    let value: string;
    if (field === 'salary') {
      if (!target.pay) throw new NotFoundException('Nothing is stored for this field');
      value = money(target.pay.baseSalary);
    } else {
      const encrypted = field === 'cnic' ? target.personal?.cnicEncrypted : target.pay?.bankAccountEncrypted;
      if (!encrypted) throw new NotFoundException('Nothing is stored for this field');
      value = this.crypto.decrypt(encrypted);
    }
    await this.audit.record({ actorId: actor.id, action: 'employee.sensitive.revealed', targetType: 'employee', targetId: empId, details: { field: label }, ...client });
    return { value };
  }

  // ===================================================================== changing

  /** Name, designation, department, office, official email: Director or HR. */
  async updateBasic(actor: Actor, empId: string, dto: UpdateBasicRequest, client: RequestInfo): Promise<ProfileResponse> {
    const target = await this.requireTarget(empId);
    const access = await this.accessFor(actor, target);
    if (!access.edit.basic) return this.deny(actor, 'profile_edit_not_allowed', empId, client);

    await this.prisma.$transaction(async (tx) => {
      const data: Prisma.EmployeeUncheckedUpdateInput = { updatedBy: actor.id };
      const changes: Change[] = [];
      const history: Array<{ eventType: 'designation_changed' | 'department_changed' | 'office_changed'; from: string; to: string }> = [];

      if (dto.name !== undefined && dto.name !== target.fullName) {
        data.fullName = dto.name;
        changes.push({ section: 'basic', field: LABEL.name, oldValue: target.fullName, newValue: dto.name });
      }
      if (dto.designation !== undefined && dto.designation !== target.designation) {
        data.designation = dto.designation;
        changes.push({ section: 'basic', field: LABEL.designation, oldValue: target.designation, newValue: dto.designation });
        history.push({ eventType: 'designation_changed', from: target.designation, to: dto.designation });
      }
      if (dto.departmentId !== undefined && dto.departmentId !== target.department.code) {
        const dep = await tx.department.findFirst({ where: { code: dto.departmentId, archivedAt: null } });
        if (!dep) throw new BadRequestException({ statusCode: 400, code: 'unknown_department', message: 'That department does not exist or is deactivated' });
        data.departmentId = dep.id;
        changes.push({ section: 'basic', field: LABEL.department, oldValue: target.department.name, newValue: dep.name });
        history.push({ eventType: 'department_changed', from: target.department.name, to: dep.name });
      }
      if (dto.officeId !== undefined && dto.officeId !== target.office.code) {
        const office = await tx.office.findFirst({ where: { code: dto.officeId, archivedAt: null } });
        if (!office) throw new BadRequestException({ statusCode: 400, code: 'unknown_office', message: 'That office does not exist or is deactivated' });
        data.officeId = office.id;
        changes.push({ section: 'basic', field: LABEL.office, oldValue: target.office.name, newValue: office.name });
        history.push({ eventType: 'office_changed', from: target.office.name, to: office.name });
      }
      if (dto.officialEmail !== undefined && dto.officialEmail !== target.officialEmail) {
        if (await tx.employee.findFirst({ where: { officialEmail: dto.officialEmail, id: { not: target.id } } })) {
          throw new ConflictException({ statusCode: 409, code: 'email_taken', message: 'That official email is already used' });
        }
        data.officialEmail = dto.officialEmail;
        changes.push({ section: 'basic', field: LABEL.email, oldValue: target.officialEmail ?? '', newValue: dto.officialEmail });
      }
      if (changes.length === 0) throw new BadRequestException({ statusCode: 400, code: 'nothing_to_change', message: 'Nothing to change' });

      await tx.employee.update({ where: { id: target.id }, data });
      await this.writeHistory(tx, target.id, actor.id, changes, dto.reason);
      for (const h of history) {
        await tx.employmentHistory.create({ data: { employeeId: target.id, eventType: h.eventType, effectiveOn: new Date(), details: { from: h.from, to: h.to }, reason: dto.reason ?? null, createdBy: actor.id } });
      }
      await this.audit.record({ actorId: actor.id, action: 'employee.profile.updated', targetType: 'employee', targetId: empId, reason: dto.reason ?? null, details: { section: 'basic', fields: changes.map((c) => c.field) }, ...client }, tx);
    });
    return this.profile(actor, empId);
  }

  /**
   * Job section. Joining date, type and weekly capacity: Director or HR. Level and reporting line: ONLY the Owner or CEO,
   * through the same validated rules as the org chart. "Left" is set only by the leaving workflow.
   */
  async updateJob(actor: Actor, empId: string, dto: UpdateJobRequest, client: RequestInfo): Promise<ProfileResponse> {
    const target = await this.requireTarget(empId);
    const access = await this.accessFor(actor, target);
    const wantsStructure = dto.level !== undefined || dto.reportsToEmpId !== undefined;
    const wantsFields = dto.joiningDate !== undefined || dto.type !== undefined || dto.weeklyCapacityHours !== undefined;

    if (dto.status !== undefined && dto.status !== target.status) {
      throw new BadRequestException({ statusCode: 400, code: 'use_leaving_workflow', message: 'Status changes through the leaving workflow (last working day)' });
    }
    if (!wantsStructure && !wantsFields) throw new BadRequestException({ statusCode: 400, code: 'nothing_to_change', message: 'Nothing to change' });
    if (target.status === 'left') throw new BadRequestException({ statusCode: 400, code: 'employee_left', message: 'This employee has left the company' });

    if (wantsFields && !access.edit.job) return this.deny(actor, 'profile_edit_not_allowed', empId, client);
    if (wantsStructure && !(await this.permissions.can(actor.id, 'org.manage'))) {
      return this.deny(actor, 'only_owner_or_ceo_change_levels_and_lines', empId, client);
    }

    // Levels and reporting lines: the Module 1 rules (Owner or CEO, validated, audited).
    if (dto.level !== undefined && dto.level !== target.level.number) await this.org.changeLevel(actor, empId, { level: dto.level, reason: dto.reason }, client);
    if (dto.reportsToEmpId !== undefined && dto.reportsToEmpId !== target.reportsTo?.empId) {
      await this.org.changeReportingLine(actor, empId, { reportsToEmpId: dto.reportsToEmpId, reason: dto.reason }, client);
    }

    if (wantsFields) {
      await this.prisma.$transaction(async (tx) => {
        const data: Prisma.EmployeeUncheckedUpdateInput = { updatedBy: actor.id };
        const changes: Change[] = [];
        if (dto.joiningDate !== undefined && dto.joiningDate !== day(target.joiningDate)) {
          data.joiningDate = new Date(`${dto.joiningDate}T00:00:00.000Z`);
          changes.push({ section: 'job', field: LABEL.joining, oldValue: day(target.joiningDate), newValue: dto.joiningDate });
        }
        if (dto.type !== undefined && dto.type !== target.employmentType) {
          data.employmentType = dto.type;
          changes.push({ section: 'job', field: LABEL.type, oldValue: TYPE_LABEL[target.employmentType], newValue: TYPE_LABEL[dto.type] });
          await tx.employmentHistory.create({ data: { employeeId: target.id, eventType: 'employment_type_changed', effectiveOn: new Date(), details: { from: target.employmentType, to: dto.type }, reason: dto.reason, createdBy: actor.id } });
        }
        if (dto.weeklyCapacityHours !== undefined && dto.weeklyCapacityHours !== target.weeklyCapacityHours) {
          data.weeklyCapacityHours = dto.weeklyCapacityHours;
          changes.push({ section: 'job', field: LABEL.capacity, oldValue: `${target.weeklyCapacityHours} h`, newValue: `${dto.weeklyCapacityHours} h` });
        }
        if (changes.length === 0) return;
        await tx.employee.update({ where: { id: target.id }, data });
        await this.writeHistory(tx, target.id, actor.id, changes, dto.reason);
        await this.audit.record({ actorId: actor.id, action: 'employee.profile.updated', targetType: 'employee', targetId: empId, reason: dto.reason, details: { section: 'job', fields: changes.map((c) => c.field) }, ...client }, tx);
      });
    }
    return this.profile(actor, empId);
  }

  /** Personal section: the employee (phone, address, emergency contact) or Director/HR (also CNIC). */
  async updatePersonal(actor: Actor, empId: string, dto: UpdatePersonalRequest, client: RequestInfo): Promise<ProfileResponse> {
    const target = await this.requireTarget(empId);
    const access = await this.accessFor(actor, target);
    if (access.edit.personal === 'none') return this.deny(actor, 'profile_edit_not_allowed', empId, client);
    if (dto.cnic !== undefined && access.edit.personal !== 'all') return this.deny(actor, 'cnic_change_not_allowed', empId, client);

    await this.prisma.$transaction(async (tx) => {
      const current = target.personal;
      const data: Prisma.EmployeePersonalUncheckedUpdateInput = { updatedBy: actor.id };
      const changes: Change[] = [];
      const sensitive = new Set<string>();

      if (dto.cnic !== undefined) {
        const oldCnic = current?.cnicEncrypted ? this.crypto.decrypt(current.cnicEncrypted) : '';
        if (dto.cnic !== oldCnic) {
          data.cnicEncrypted = this.crypto.encrypt(dto.cnic);
          data.cnicLast4 = last4(dto.cnic);
          changes.push({ section: 'personal', field: LABEL.cnic, oldValue: oldCnic, newValue: dto.cnic });
          sensitive.add(LABEL.cnic);
        }
      }
      if (dto.phone !== undefined && dto.phone !== (current?.phone ?? '')) {
        data.phone = dto.phone;
        changes.push({ section: 'personal', field: LABEL.phone, oldValue: current?.phone ?? '', newValue: dto.phone });
      }
      if (dto.homeAddress !== undefined && dto.homeAddress !== (current?.homeAddress ?? '')) {
        data.homeAddress = dto.homeAddress;
        changes.push({ section: 'personal', field: LABEL.address, oldValue: current?.homeAddress ?? '', newValue: dto.homeAddress });
      }
      if (dto.emergencyContact) {
        const fmt = (n?: string | null, r?: string | null, p?: string | null) => (n ? `${n} (${r ?? ''}) ${p ?? ''}` : '');
        const before = fmt(current?.emergencyContactName, current?.emergencyContactRelation, current?.emergencyContactPhone);
        const after = fmt(dto.emergencyContact.name, dto.emergencyContact.relation, dto.emergencyContact.phone);
        if (before !== after) {
          data.emergencyContactName = dto.emergencyContact.name;
          data.emergencyContactRelation = dto.emergencyContact.relation;
          data.emergencyContactPhone = dto.emergencyContact.phone;
          changes.push({ section: 'personal', field: LABEL.emergency, oldValue: before, newValue: after });
        }
      }
      if (changes.length === 0) throw new BadRequestException({ statusCode: 400, code: 'nothing_to_change', message: 'Nothing to change' });

      await tx.employeePersonal.upsert({ where: { employeeId: target.id }, update: data, create: { ...(data as Prisma.EmployeePersonalUncheckedCreateInput), employeeId: target.id, createdBy: actor.id } });
      await this.writeHistory(tx, target.id, actor.id, changes, undefined, sensitive);
      await this.audit.record({ actorId: actor.id, action: 'employee.profile.updated', targetType: 'employee', targetId: empId, details: { section: 'personal', fields: changes.map((c) => c.field), self: access.isSelf }, ...client }, tx);
    });
    return this.profile(actor, empId);
  }

  /** Pay section: the Director only (never their own). */
  async updatePay(actor: Actor, empId: string, dto: UpdatePayRequest, client: RequestInfo): Promise<ProfileResponse> {
    const target = await this.requireTarget(empId);
    const access = await this.accessFor(actor, target);
    if (!access.edit.pay) return this.deny(actor, 'pay_edit_not_allowed', empId, client);

    await this.prisma.$transaction(async (tx) => {
      const current = target.pay;
      const data: Prisma.EmployeePayUncheckedUpdateInput = { updatedBy: actor.id };
      const changes: Change[] = [];
      const fixed = (n: number) => n.toFixed(2);

      if (dto.baseSalary !== undefined && fixed(dto.baseSalary) !== money(current?.baseSalary)) {
        data.baseSalary = fixed(dto.baseSalary);
        changes.push({ section: 'pay', field: LABEL.salary, oldValue: money(current?.baseSalary), newValue: fixed(dto.baseSalary) });
      }
      if (dto.allowances !== undefined && fixed(dto.allowances) !== money(current?.allowances)) {
        data.allowances = fixed(dto.allowances);
        changes.push({ section: 'pay', field: LABEL.allowances, oldValue: money(current?.allowances), newValue: fixed(dto.allowances) });
      }
      if (dto.bankName !== undefined && dto.bankName !== (current?.bankName ?? '')) {
        data.bankName = dto.bankName;
        changes.push({ section: 'pay', field: LABEL.bank, oldValue: current?.bankName ?? '', newValue: dto.bankName });
      }
      if (dto.accountNumber !== undefined) {
        const oldAccount = current?.bankAccountEncrypted ? this.crypto.decrypt(current.bankAccountEncrypted) : '';
        if (dto.accountNumber !== oldAccount) {
          data.bankAccountEncrypted = this.crypto.encrypt(dto.accountNumber);
          data.bankAccountLast4 = last4(dto.accountNumber);
          changes.push({ section: 'pay', field: LABEL.account, oldValue: oldAccount, newValue: dto.accountNumber });
        }
      }
      if (changes.length === 0) throw new BadRequestException({ statusCode: 400, code: 'nothing_to_change', message: 'Nothing to change' });

      await tx.employeePay.upsert({ where: { employeeId: target.id }, update: data, create: { ...(data as Prisma.EmployeePayUncheckedCreateInput), employeeId: target.id, createdBy: actor.id } });
      // every pay value in the history is stored encrypted
      await this.writeHistory(tx, target.id, actor.id, changes, dto.reason, new Set(changes.map((c) => c.field)));
      await this.audit.record({ actorId: actor.id, action: 'employee.pay.updated', targetType: 'employee', targetId: empId, reason: dto.reason, details: { fields: changes.map((c) => c.field) }, ...client }, tx);
    });
    return this.profile(actor, empId);
  }

  // ===================================================================== shared helpers

  /** Keeps the OLD value of every changed field: who, when, old value, new value. Sensitive values are encrypted. */
  async writeHistory(tx: Prisma.TransactionClient, employeeId: string, actorId: string, changes: Change[], reason?: string, sensitive: Set<string> = new Set()): Promise<void> {
    await tx.profileChange.createMany({
      data: changes.map((c) => {
        const isSensitive = sensitive.has(c.field);
        return {
          employeeId,
          section: c.section,
          field: c.field,
          oldValue: c.oldValue === '' ? null : isSensitive ? this.crypto.encrypt(c.oldValue) : c.oldValue,
          newValue: c.newValue === '' ? null : isSensitive ? this.crypto.encrypt(c.newValue) : c.newValue,
          isSensitive,
          reason: reason ?? null,
          changedBy: actorId,
        };
      }),
    });
  }

  async requireTarget(empId: string, db: Db = this.prisma): Promise<TargetRow> {
    const target = await db.employee.findUnique({ where: { empId }, select: targetSelect });
    if (!target) throw new NotFoundException('Employee not found');
    return target;
  }

  async accessFor(actor: Actor, target: Pick<TargetRow, 'id' | 'level'>): Promise<ProfileAccessView> {
    const access = await this.permissions.getEffectiveAccess(actor.id);
    const isSelf = actor.id === target.id;
    return computeProfileAccess({
      isSelf,
      isAbove: !isSelf && (await this.scope.canAccess(actor.id, target.id, 'below')),
      lowerRank: target.level.number > actor.levelNumber,
      can: (p) => access.permissions.has(p),
    });
  }

  basicOf(target: TargetRow): DirectoryEntry {
    return {
      empId: target.empId,
      name: target.fullName,
      designation: target.designation,
      departmentId: target.department.code,
      officeId: target.office.code,
      officialEmail: target.officialEmail,
      hasPhoto: !!target.photoKey,
    };
  }

  private async deny(actor: Actor, reason: string, targetEmpId: string, client: RequestInfo): Promise<never> {
    await this.audit.record({ actorId: actor.id, action: 'access.denied', targetType: 'employee', targetId: targetEmpId, outcome: 'denied', reason, ...client });
    throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message: 'You do not have access to this' });
  }
}
