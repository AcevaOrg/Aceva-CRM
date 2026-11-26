import { Global, Module } from '@nestjs/common';
import { CryptoService } from '../auth/crypto.service';
import { OutboxConsumerRunner } from '../events/outbox-consumer-runner.service';
import { OutboxDispatcher } from '../events/outbox-dispatcher.service';
import { OutboxService } from '../events/outbox.service';
import { JobRunner } from '../jobs/job-runner.service';
import { CityLocator, LocalRangeCityLocator } from './city-locator';
import { Clock, SystemClock } from './clock';

/**
 * Small shared services: the clock, cryptography helpers, the event outbox (writing and dispatching), the job runner and
 * the approximate-city lookup. Global, and each exists ONCE: modules register their job types on the one JobRunner and
 * their event consumers on the one OutboxDispatcher (a second instance would poll the same tables without knowing the
 * handlers).
 */
@Global()
@Module({
  providers: [
    { provide: Clock, useClass: SystemClock },
    CryptoService,
    OutboxService,
    OutboxDispatcher,
    // The Cycle 3 outbox readers (notifications, Modules 13 and 14): own progress table, never touches processed_at.
    OutboxConsumerRunner,
    JobRunner,
    { provide: CityLocator, useClass: LocalRangeCityLocator },
  ],
  exports: [Clock, CryptoService, OutboxService, OutboxDispatcher, OutboxConsumerRunner, JobRunner, CityLocator],
})
export class CommonModule {}
