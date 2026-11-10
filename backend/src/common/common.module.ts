import { Global, Module } from '@nestjs/common';
import { CryptoService } from '../auth/crypto.service';
import { OutboxService } from '../events/outbox.service';
import { Clock, SystemClock } from './clock';

/** Small shared services: the clock, cryptography helpers and the event outbox. */
@Global()
@Module({
  providers: [{ provide: Clock, useClass: SystemClock }, CryptoService, OutboxService],
  exports: [Clock, CryptoService, OutboxService],
})
export class CommonModule {}
