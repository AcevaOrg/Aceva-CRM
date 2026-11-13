import { Injectable } from '@nestjs/common';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { StepUpService } from '../auth/step-up.service';
import { Clock } from '../common/clock';
import { money } from '../common/money';
import { dayOf, dbDate, PKT_OFFSET_MS } from '../common/pakistan-time';
import { PrismaService } from '../prisma/prisma.service';

/** A CSV cell that a spreadsheet will not run as a formula. */
export function csvCell(value: string | null | undefined): string {
  let v = String(value ?? '');
  if (/^[=+\-@\t\r]/.test(v)) v = `'${v}`;
  return /[",\n\r]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * Export of posted ledger lines (plan section 16, export control): only levels 1 to 3 hold finance.export; it asks for the
 * password again, every file carries the "Confidential, exported by ..." watermark line, and every export is logged.
 */
@Injectable()
export class FinanceExportService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly stepUp: StepUpService,
    private readonly clock: Clock,
  ) {}

  async ledgerCsv(actor: Actor, from: string, to: string, sessionId: string | null, client: RequestInfo): Promise<string> {
    await this.stepUp.require(actor, sessionId, 'finance.export', { type: 'ledger', id: `${from}..${to}` }, client);
    const lines = await this.prisma.journalLine.findMany({
      where: { entry: { status: 'posted', entryDate: { gte: dbDate(from), lte: dbDate(to) } } },
      include: {
        account: { select: { code: true, name: true } },
        party: { select: { name: true } },
        employee: { select: { empId: true } },
        entry: { select: { number: true, entryDate: true, description: true, currency: true, exchangeRate: true, source: true, project: { select: { code: true } } } },
      },
      orderBy: [{ entry: { entryDate: 'asc' } }, { entry: { number: 'asc' } }, { lineNo: 'asc' }],
    });
    const local = new Date(this.clock.now().getTime() + PKT_OFFSET_MS).toISOString().slice(0, 16).replace('T', ' ');
    const out = [
      csvCell(`Confidential, exported by ${actor.empId} on ${local} (Pakistan time)`),
      ['date', 'entry', 'source', 'account_code', 'account', 'description', 'client_or_vendor', 'project', 'employee', 'currency', 'rate', 'debit', 'credit', 'base_debit', 'base_credit'].join(','),
      ...lines.map((l) =>
        [
          dayOf(l.entry.entryDate),
          l.entry.number,
          l.entry.source,
          l.account.code,
          l.account.name,
          l.description ?? l.entry.description,
          l.party?.name ?? '',
          l.entry.project?.code ?? '',
          l.employee?.empId ?? '',
          l.entry.currency,
          l.entry.exchangeRate.toFixed(6),
          money(l.debit),
          money(l.credit),
          money(l.baseDebit),
          money(l.baseCredit),
        ]
          .map(csvCell)
          .join(','),
      ),
    ];
    await this.audit.record({ actorId: actor.id, action: 'finance.export', targetType: 'ledger', targetId: `${from}..${to}`, details: { format: 'csv', rows: lines.length }, ...client });
    return out.join('\r\n') + '\r\n';
  }
}
