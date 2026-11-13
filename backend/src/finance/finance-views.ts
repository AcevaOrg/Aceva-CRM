import { Injectable } from '@nestjs/common';
import type { EntryStatus, EntryView, ReceiptView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { PermissionService } from '../access/permission.service';
import { dec, money } from '../common/money';
import { dayOf } from '../common/pakistan-time';
import type { JournalEntryStatus, JournalSource } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { labelFor, levelCovers, requiredApprovalLevel, type Tier } from './approval-tier';

export type { EntryView };

export interface EntryListQuery {
  page: number;
  pageSize: number;
  status?: EntryStatus | 'all';
  month?: string;
  source?: JournalSource | 'all';
  accountId?: string;
  partyId?: string;
  projectId?: string;
  awaitingMe?: 'true' | 'false';
  q?: string;
}

const EVENT_ORDER: Record<string, number> = { created: 0, edited: 1, submitted: 2, approved: 3, rejected: 3, posted: 4, reversal_created: 5 };

/** The status people see: a posted entry whose reversing entry is posted shows as "reversed" (never stored). */
export function shownStatus(status: JournalEntryStatus, reversedByStatus: JournalEntryStatus | null | undefined): EntryStatus {
  return status === 'posted' && reversedByStatus === 'posted' ? 'reversed' : status;
}

export function receiptView(r: { id: string; originalFilename: string; mimeType: string; sizeBytes: number; createdAt: Date }): ReceiptView {
  return { id: r.id, fileName: r.originalFilename, mimeType: r.mimeType, sizeBytes: r.sizeBytes, uploadedAt: r.createdAt.toISOString() };
}

/** Builds API views of journal entries (Emp-IDs, never UUIDs, for people; money as 2-decimal strings). */
@Injectable()
export class FinanceViews {
  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
  ) {}

  async entries(actor: Actor, ids: string[]): Promise<EntryView[]> {
    if (!ids.length) return [];
    const rows = await this.prisma.journalEntry.findMany({
      where: { id: { in: ids } },
      include: {
        lines: {
          orderBy: { lineNo: 'asc' },
          include: { account: { select: { code: true, name: true, requiresOwnerApproval: true } }, party: { select: { name: true } }, employee: { select: { empId: true } } },
        },
        events: { orderBy: [{ createdAt: 'asc' }] },
        project: { select: { code: true } },
        reversalOf: { select: { number: true } },
        reversedBy: { where: { status: { not: 'rejected' } }, take: 1, select: { id: true, number: true, status: true } },
        receipts: { where: { archivedAt: null }, orderBy: { createdAt: 'asc' } },
      },
    });
    const peopleIds = new Set<string>();
    for (const r of rows) {
      peopleIds.add(r.makerId);
      if (r.approvedBy) peopleIds.add(r.approvedBy);
      if (r.rejectedBy) peopleIds.add(r.rejectedBy);
      for (const ev of r.events) if (ev.actorId) peopleIds.add(ev.actorId);
    }
    const people = await this.prisma.employee.findMany({ where: { id: { in: [...peopleIds] } }, select: { id: true, empId: true, fullName: true, level: { select: { number: true } } } });
    const person = new Map(people.map((p) => [p.id, p]));
    const limits = await this.prisma.approvalLimit.findMany();
    const tiers: Tier[] = limits.map((l) => ({ approverLevel: l.approverLevel, maxAmount: l.maxAmount === null ? null : dec(l.maxAmount), label: l.label }));
    const settings = await this.prisma.financeSetting.findUnique({ where: { id: 1 } });
    const stepUpAbove = settings ? dec(settings.stepUpAbove) : dec(0);
    const mayApprove = await this.permissions.can(actor.id, 'finance.entry_approve');

    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids
      .map((id) => byId.get(id))
      .filter((r): r is NonNullable<typeof r> => !!r)
      .map((r) => {
        const maker = person.get(r.makerId);
        let requiredLevel = r.requiredLevel;
        if (requiredLevel === null && r.status === 'draft') {
          const t = requiredApprovalLevel(dec(r.totalBase), tiers, r.lines.some((l) => l.account.requiresOwnerApproval), maker?.level.number ?? null);
          requiredLevel = t.ok ? t.level : null;
        }
        const total = r.lines.reduce((s, l) => s.plus(l.debit), dec(0));
        return {
          id: r.id,
          number: r.number,
          date: dayOf(r.entryDate),
          description: r.description,
          source: r.source,
          sourceRef: r.sourceRef,
          purpose: r.purpose,
          projectId: r.projectId,
          projectCode: r.project?.code ?? null,
          currency: r.currency,
          exchangeRate: dec(r.exchangeRate).toFixed(6),
          total: money(total),
          totalBase: money(r.totalBase),
          status: shownStatus(r.status, r.reversedBy[0]?.status),
          requiredLevel,
          requiredApproverLabel: requiredLevel ? labelFor(requiredLevel, tiers) : null,
          needsStepUp: dec(r.totalBase).gt(stepUpAbove),
          canApprove: mayApprove && r.status === 'pending_approval' && r.makerId !== actor.id && levelCovers(actor.levelNumber, r.requiredLevel ?? 1),
          makerEmpId: maker?.empId ?? '',
          makerName: maker?.fullName ?? '',
          createdAt: r.createdAt.toISOString(),
          submittedAt: r.submittedAt?.toISOString() ?? null,
          approvedByEmpId: r.approvedBy ? (person.get(r.approvedBy)?.empId ?? null) : null,
          postedAt: r.postedAt?.toISOString() ?? null,
          rejectedByEmpId: r.rejectedBy ? (person.get(r.rejectedBy)?.empId ?? null) : null,
          rejectedReason: r.rejectedReason,
          reversalOfId: r.reversalOfId,
          reversalOfNumber: r.reversalOf?.number ?? null,
          reversedById: r.reversedBy[0]?.id ?? null,
          reversedByNumber: r.reversedBy[0]?.number ?? null,
          lines: r.lines.map((l) => ({
            id: l.id,
            lineNo: l.lineNo,
            accountId: l.accountId,
            accountCode: l.account.code,
            accountName: l.account.name,
            description: l.description,
            debit: money(l.debit),
            credit: money(l.credit),
            baseDebit: money(l.baseDebit),
            baseCredit: money(l.baseCredit),
            partyId: l.partyId,
            partyName: l.party?.name ?? null,
            empId: l.employee?.empId ?? null,
          })),
          // Events written in one transaction share its timestamp: break ties by the natural order of the steps.
          events: [...r.events].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || (EVENT_ORDER[a.action] ?? 9) - (EVENT_ORDER[b.action] ?? 9)).map((ev) => {
            const who = ev.actorId ? person.get(ev.actorId) : undefined;
            return { at: ev.createdAt.toISOString(), action: ev.action, byEmpId: who?.empId ?? null, byName: who?.fullName ?? null, note: ev.note };
          }),
          receipts: r.receipts.map(receiptView),
        };
      });
  }
}
