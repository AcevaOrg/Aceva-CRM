import { Injectable } from '@nestjs/common';
import { dec } from '../common/money';
import { withDbRules } from '../common/db-rules';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { badRequest, conflict, isUuid } from './finance-errors';
import { JournalService, type LineDraft } from './journal.service';
import { LedgerPostingPort, type SystemEntryInput, type SystemEntryResult } from './ledger-posting.port';

/**
 * The M9 implementation of the posting port used by Module 8 (payroll and salary advances).
 * Guarantees (see the port's JSDoc): created as a Draft with its lines, then submitted so it waits for approval at the tier its
 * amount needs (never posted directly); debits = credits or nothing is saved; idempotent on (source, sourceRef, purpose);
 * closed months refused; everything inside the caller's transaction.
 */
@Injectable()
export class LedgerPostingService extends LedgerPostingPort {
  constructor(
    private readonly prisma: PrismaService,
    private readonly journal: JournalService,
  ) {
    super();
  }

  async createSystemEntry(tx: Prisma.TransactionClient, input: SystemEntryInput): Promise<SystemEntryResult> {
    return withDbRules(async () => {
      const existing = await tx.journalEntry.findFirst({
        where: { source: input.source, sourceRef: input.sourceRef, purpose: input.purpose },
        select: { id: true, number: true, status: true },
      });
      if (existing) return existing;

      const roles = [...new Set(input.lines.map((l) => l.accountRole).filter((r): r is NonNullable<typeof r> => !!r))];
      const roleAccounts = roles.length ? await tx.ledgerAccount.findMany({ where: { systemRole: { in: roles } }, select: { id: true, systemRole: true } }) : [];
      const byRole = new Map(roleAccounts.map((a) => [a.systemRole!, a.id]));
      for (const role of roles) {
        if (!byRole.has(role)) throw conflict('account_role_missing', `No account has the role "${role}". The accountant maps it in the chart of accounts.`);
      }
      const lines: LineDraft[] = input.lines.map((l, i) => {
        if (!!l.accountRole === !!l.accountId) throw badRequest('invalid_line', `Line ${i + 1}: give an account role or an account id`);
        return {
          accountId: l.accountRole ? byRole.get(l.accountRole)! : l.accountId!,
          description: l.description ?? null,
          debit: dec(l.debit ?? 0),
          credit: dec(l.credit ?? 0),
          employeeId: l.employeeId ?? null,
        };
      });
      const entry = await this.journal.createAndSubmitTx(
        tx,
        {
          date: input.entryDate,
          description: input.description,
          source: input.source,
          sourceRef: input.sourceRef,
          purpose: input.purpose,
          currency: 'PKR',
          makerId: input.makerId,
          lines,
        },
        { actorId: input.makerId },
      );
      return { id: entry.id, number: entry.number, status: 'pending_approval' as const };
    });
  }

  async entryStatuses(ids: string[]): Promise<Map<string, { number: string; status: SystemEntryResult['status'] }>> {
    const valid = ids.filter(isUuid);
    const rows = valid.length ? await this.prisma.journalEntry.findMany({ where: { id: { in: valid } }, select: { id: true, number: true, status: true } }) : [];
    return new Map(rows.map((r) => [r.id, { number: r.number, status: r.status }]));
  }

  async findBankAccount(accountId: string): Promise<{ id: string; code: string; name: string } | null> {
    if (!isUuid(accountId)) return null;
    return this.prisma.ledgerAccount.findFirst({ where: { id: accountId, isBank: true, archivedAt: null }, select: { id: true, code: true, name: true } });
  }
}
