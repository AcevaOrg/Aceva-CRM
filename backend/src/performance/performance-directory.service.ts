import { Injectable } from '@nestjs/common';
import { ScopeService } from '../access/scope.service';
import { PrismaService } from '../prisma/prisma.service';
import type { Db } from './performance-data';
import { disputeDecider, scorecardReviewer, type PersonFacts } from './rules/perf-people';

/** One person as the performance code needs them. `id` is the internal employee id (never sent to a browser). */
export interface DirectoryPerson extends PersonFacts {
  id: string;
  fullName: string;
  /** The role key ("developer", "sales"...). Sales staff are scored with the sales weights. */
  roleKey: string;
  departmentId: string;
  joiningDate: Date;
  status: 'active' | 'on_notice' | 'left';
}

/**
 * Who is who for scorecards: the reporting line, who has left, who reviews work (task.review), and from those the
 * reviewer of a scorecard and the decider of a dispute (rules/perf-people.ts). One query loads everybody (the company is
 * small), so the answers cost no further queries. Used by the core services, the approvals provider and the monthly job.
 */
@Injectable()
export class PerformanceDirectory {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scope: ScopeService,
  ) {}

  /** Everybody, with their manager's Emp-ID and whether they hold task.review (by role or by an active duty). */
  async people(db: Db = this.prisma): Promise<DirectoryPerson[]> {
    const rows = await db.employee.findMany({
      select: {
        id: true,
        empId: true,
        fullName: true,
        status: true,
        departmentId: true,
        joiningDate: true,
        reportsTo: { select: { empId: true } },
        role: { select: { key: true, rolePermissions: { where: { permission: { key: 'task.review' } }, select: { permissionId: true } } } },
        duties: { where: { endedAt: null }, select: { duty: { select: { dutyPermissions: { where: { permission: { key: 'task.review' } }, select: { permissionId: true } } } } } },
      },
      orderBy: { empId: 'asc' },
    });
    return rows.map((r) => ({
      id: r.id,
      empId: r.empId,
      fullName: r.fullName,
      roleKey: r.role.key,
      departmentId: r.departmentId,
      joiningDate: r.joiningDate,
      status: r.status,
      reportsTo: r.reportsTo?.empId ?? null,
      left: r.status === 'left',
      reviewsWork: r.role.rolePermissions.length > 0 || r.duties.some((d) => d.duty.dutyPermissions.length > 0),
    }));
  }

  /**
   * The people who get a scorecard for `month`'s job: everyone who has not left and has a manager (the CEO / Founder /
   * Owner has none and is not scored), and who had joined by the end of the month. `people` saves a second query.
   */
  async scorable(monthEnd: Date, people?: DirectoryPerson[]): Promise<DirectoryPerson[]> {
    const all = people ?? (await this.people());
    return all.filter((p) => !p.left && p.reportsTo !== null && p.joiningDate.getTime() < monthEnd.getTime());
  }

  /** The person who reviews and releases the scorecard of `empId` now (the manager, or the next one up when the manager left or does not review work); null = none. */
  async reviewerOf(empId: string, people?: DirectoryPerson[]): Promise<DirectoryPerson | null> {
    const all = people ?? (await this.people());
    const found = scorecardReviewer(empId, all);
    return found ? (all.find((p) => p.empId === found.empId) ?? null) : null;
  }

  /**
   * Who decides a dispute about a rating `ratedBy` (Emp-ID) gave to a task of `employee` (Emp-ID): the nearest person above
   * `ratedBy` who reviews work and is not the employee, else `ratedBy` again (the Director). Null when nobody can.
   */
  async deciderOf(input: { ratedBy: string | null; employee: string }, people?: DirectoryPerson[]): Promise<DirectoryPerson | null> {
    const all = people ?? (await this.people());
    const empId = disputeDecider(input, all);
    return empId ? (all.find((p) => p.empId === empId) ?? null) : null;
  }

  /** Is `employeeId` (internal id) strictly below `viewerId` in the reporting line? (The hierarchy rule: ScopeService.) */
  isAbove(viewerId: string, employeeId: string): Promise<boolean> {
    return this.scope.canAccess(viewerId, employeeId, 'below');
  }

  /** May the viewer see this person's results: themselves, or someone below them in the reporting line. */
  canSeePerson(viewerId: string, employeeId: string): Promise<boolean> {
    return this.scope.canAccess(viewerId, employeeId, 'self_or_below');
  }
}
