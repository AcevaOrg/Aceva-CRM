import { Injectable, Logger } from '@nestjs/common';
import { Interval } from '@nestjs/schedule';
import { SessionService } from './session.service';

/** Once a minute, ends sessions that timed out while nobody was making requests. */
@Injectable()
export class SessionSweeper {
  private readonly logger = new Logger('SessionSweeper');
  private running = false;

  constructor(private readonly sessions: SessionService) {}

  @Interval(60_000)
  async run(): Promise<void> {
    if (this.running) return; // never overlap
    this.running = true;
    try {
      await this.sessions.sweepExpired();
    } catch (error) {
      this.logger.error(`Sweep failed: ${(error as Error).message}`);
    } finally {
      this.running = false;
    }
  }
}
