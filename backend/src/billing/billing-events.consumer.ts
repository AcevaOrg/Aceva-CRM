import { Injectable, type OnModuleInit } from '@nestjs/common';
import type { OutboxEvent } from '@aceva/contracts';
import { Clock } from '../common/clock';
import { dec, ZERO } from '../common/money';
import { dayOf } from '../common/pakistan-time';
import { OutboxConsumerRunner } from '../events/outbox-consumer-runner.service';
import { OutboxService } from '../events/outbox.service';
import { LedgerQueryService } from '../finance/ledger-query.service';
import type { Prisma } from '../generated/prisma/client';
import { BillingService } from './billing.service';

/** The reader's name in outbox_consumers. Never rename it (a new name would start reading from "now" again). */
export const BILLING_CONSUMER = 'billing';

type Tx = Prisma.TransactionClient;

/**
 * Module 13's outbox reader (each event exactly once, in the same transaction as what it writes):
 *  - ledger.entry.posted for an invoice: the Director APPROVED its entry, so its email to the client is queued now, once
 *    (review decision 1: never while the entry waits for approval, never when it is rejected: neither writes this event);
 *  - ledger.entry.posted for a payment: an invoice the payment makes fully paid gets its "invoice paid" event once
 *    (Module 15 calculates commission from it) and its remaining reminders are stopped;
 *  - sales.deal.won_confirmed (Module 15, the connection point): exactly one draft invoice per deal.
 */
@Injectable()
export class BillingEventsConsumer implements OnModuleInit {
  constructor(
    private readonly runner: OutboxConsumerRunner,
    private readonly billing: BillingService,
    private readonly ledger: LedgerQueryService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.runner.register({ name: BILLING_CONSUMER, types: ['ledger.entry.posted', 'sales.deal.won_confirmed'], handle: (event, tx) => this.handle(event, tx) });
  }

  async handle(event: OutboxEvent, tx: Tx): Promise<void> {
    if (event.type === 'sales.deal.won_confirmed') {
      await this.billing.draftFromWonDeal(tx, event);
      return;
    }
    if (event.type !== 'ledger.entry.posted') return;
    if (event.payload.source !== 'payment' && event.payload.source !== 'invoice') return;
    const entry = await tx.journalEntry.findUnique({ where: { number: event.payload.entryNumber }, select: { id: true } });
    if (!entry) return;
    if (event.payload.source === 'invoice') {
      await this.billing.onInvoiceEntryPosted(tx, entry.id, event.payload.entryNumber);
      return;
    }
    const payment = await tx.payment.findUnique({ where: { journalEntryId: entry.id }, include: { allocations: { where: { invoiceId: { not: null } }, select: { invoiceId: true } } } });
    if (!payment || payment.direction !== 'received') return;
    for (const { invoiceId } of payment.allocations) {
      const inv = await tx.invoice.findUnique({ where: { id: invoiceId! } });
      if (!inv || inv.status !== 'issued' || inv.paidEventAt) continue;
      const paid = (await this.ledger.allocationTotals('invoice', [inv.id], tx)).get(inv.id)?.paid ?? ZERO;
      if (paid.lt(dec(inv.total))) continue;
      const { count } = await tx.invoice.updateMany({ where: { id: inv.id, paidEventAt: null }, data: { paidEventAt: this.clock.now() } });
      if (!count) continue;
      const earlierPaid = await tx.invoice.count({ where: { partyId: inv.partyId, paidEventAt: { not: null }, id: { not: inv.id } } });
      await this.billing.stopFollowUps(tx, inv.id, 'Already paid');
      await this.outbox.emit(
        { type: 'billing.invoice.paid', actor: event.actor, payload: { invoiceNumber: inv.number, paidOn: dayOf(payment.paymentDate), sourceDealNumber: inv.sourceDealNumber, firstForClient: earlierPaid === 0 } },
        tx,
      );
    }
  }
}
