import { Injectable, OnModuleInit } from '@nestjs/common';
import { OutboxDispatcher } from '../events/outbox-dispatcher.service';
import { PerformanceMail } from './performance-mail.service';

/**
 * Module 6's outbox consumers, registered on the shared OutboxDispatcher (see the contract in
 * events/outbox-dispatcher.service.ts: every handle() must be IDEMPOTENT; throwing means "retry later"). Keep the consumer
 * NAME: deliveries are recorded per consumer name, and a renamed consumer would receive old events again:
 *
 *   performance.mail   scorecard.released, scorecard.dispute_raised, scorecard.dispute_decided  ->  PerformanceMail
 *
 * The events the core writes that nobody here needs (scorecard.drafted: the reviewer gets ONE digest mail from the monthly
 * job instead of one per draft; scorecard.acknowledged; score_weights.created) are simply not listed. The automation
 * builder may add consumers here (keep the names) but never changes `performance.mail`.
 */
@Injectable()
export class PerformanceConsumers implements OnModuleInit {
  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly mail: PerformanceMail,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register({
      name: 'performance.mail',
      handles: [
        { type: 'scorecard.released', version: 1 },
        { type: 'scorecard.dispute_raised', version: 1 },
        { type: 'scorecard.dispute_decided', version: 1 },
      ],
      handle: async (event) => {
        switch (event.type) {
          case 'scorecard.released':
            return this.mail.released(event);
          case 'scorecard.dispute_raised':
            return this.mail.disputeRaised(event);
          case 'scorecard.dispute_decided':
            return this.mail.disputeDecided(event);
          default:
            return;
        }
      },
    });
  }
}
