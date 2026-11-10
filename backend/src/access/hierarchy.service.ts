import { Injectable } from '@nestjs/common';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Where hierarchy lookups come from. Today the answer is read straight from the PostgreSQL
 * closure table, so it can never be stale. When Redis is introduced, a Redis-backed
 * implementation (with invalidation on every hierarchy change) replaces this class.
 * REDIS NOT YET IMPLEMENTED: plan requirement "hierarchy kept in Redis" is still open.
 */
export abstract class HierarchyCache {
  /** Managers above the person, nearest first: [manager, manager's manager, ...]. */
  abstract getChain(employeeId: string, db?: Db): Promise<string[]>;
  /** Everyone strictly below the person (not including the person). */
  abstract getDownlineIds(employeeId: string, db?: Db): Promise<string[]>;
  /** Called after every change to the reporting tree. */
  abstract invalidate(): Promise<void>;
}

@Injectable()
export class PostgresHierarchyCache extends HierarchyCache {
  constructor(private readonly prisma: PrismaService) {
    super();
  }

  async getChain(employeeId: string, db: Db = this.prisma): Promise<string[]> {
    const rows = await db.reportingClosure.findMany({
      where: { descendantId: employeeId, depth: { gt: 0 } },
      orderBy: { depth: 'asc' },
      select: { ancestorId: true },
    });
    return rows.map((r) => r.ancestorId);
  }

  async getDownlineIds(employeeId: string, db: Db = this.prisma): Promise<string[]> {
    const rows = await db.reportingClosure.findMany({
      where: { ancestorId: employeeId, depth: { gt: 0 } },
      select: { descendantId: true },
    });
    return rows.map((r) => r.descendantId);
  }

  async invalidate(): Promise<void> {
    // Nothing is cached yet.
  }
}

/** Arbitrary constant: all reporting-tree changes take this lock so two changes cannot interleave. */
const HIERARCHY_LOCK_KEY = 726_001;

/** Maintains the closure table. Always call inside a transaction. */
@Injectable()
export class HierarchyService {
  constructor(private readonly cache: HierarchyCache) {}

  /** Serialises hierarchy changes (prevents two simultaneous moves from creating a loop). */
  async lock(tx: Prisma.TransactionClient): Promise<void> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(${HIERARCHY_LOCK_KEY})`;
  }

  /**
   * Moves `employeeId` (and everyone below them) under `newManagerId`, keeping the closure
   * table in step with employees.reports_to_id. The caller has already validated the move.
   */
  async moveUnder(tx: Prisma.TransactionClient, employeeId: string, newManagerId: string): Promise<void> {
    // 1. Remove the links between the old managers above and the moved subtree.
    await tx.$executeRaw`
      DELETE FROM reporting_closure
      WHERE descendant_id IN (SELECT descendant_id FROM reporting_closure WHERE ancestor_id = ${employeeId}::uuid)
        AND ancestor_id IN (SELECT ancestor_id FROM reporting_closure WHERE descendant_id = ${employeeId}::uuid AND depth > 0)`;

    await tx.employee.update({ where: { id: employeeId }, data: { reportsToId: newManagerId } });

    // 2. Link every manager above the new manager (and the new manager) to the moved subtree.
    await tx.$executeRaw`
      INSERT INTO reporting_closure (ancestor_id, descendant_id, depth)
      SELECT up.ancestor_id, down.descendant_id, up.depth + down.depth + 1
      FROM reporting_closure up
      CROSS JOIN reporting_closure down
      WHERE up.descendant_id = ${newManagerId}::uuid
        AND down.ancestor_id = ${employeeId}::uuid`;

    await this.cache.invalidate();
  }

  /** Ids of everyone below the person (used for loop prevention and task direction). */
  downline(tx: Prisma.TransactionClient, employeeId: string): Promise<string[]> {
    return this.cache.getDownlineIds(employeeId, tx);
  }
}
