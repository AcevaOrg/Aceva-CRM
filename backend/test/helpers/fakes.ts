import { Clock } from '../../src/common/clock';
import { Mailer, type MailMessage } from '../../src/mail/mailer';

/** A clock the tests can move, to check 30-minute, 15-minute and 12-hour limits without waiting. */
export class FakeClock extends Clock {
  private offsetMs = 0;

  now(): Date {
    return new Date(Date.now() + this.offsetMs);
  }

  advance(ms: number): void {
    this.offsetMs += ms;
  }

  /** Back to real time. */
  reset(): void {
    this.offsetMs = 0;
  }
}

/** Collects emails instead of sending them. */
export class MemoryMailer extends Mailer {
  readonly sent: MailMessage[] = [];

  async send(message: MailMessage): Promise<void> {
    this.sent.push(message);
  }

  /** The most recent email to an address. */
  lastTo(address: string): MailMessage | undefined {
    return [...this.sent].reverse().find((m) => m.to.toLowerCase() === address.toLowerCase());
  }

  clear(): void {
    this.sent.length = 0;
  }
}
