import { Global, Module } from '@nestjs/common';
import { CryptoService } from '../auth/crypto.service';
import { OutboxConsumerRunner } from '../events/outbox-consumer-runner.service';
import { OutboxService } from '../events/outbox.service';
import { Clock, SystemClock } from './clock';

/** Small shared services: the clock, cryptography helpers, the event outbox and the outbox readers' runner (Cycle 3). */
@Global()
@Module({
  providers: [{ provide: Clock, useClass: SystemClock }, CryptoService, OutboxService, OutboxConsumerRunner],
  exports: [Clock, CryptoService, OutboxService, OutboxConsumerRunner],
})
export class CommonModule {}
