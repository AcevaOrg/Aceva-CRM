import { Injectable } from '@nestjs/common';
import { SALES_DUPLICATE_CHECKS_PER_MINUTE } from '@aceva/contracts';
import { Clock } from '../common/clock';

const WINDOW_MS = 60_000;

/**
 * Each duplicate check says who owns an email, so a person may run only SALES_DUPLICATE_CHECKS_PER_MINUTE of them per
 * minute (sliding window). Kept in memory, like Module 4's signal throttle: with more than one server the limit applies
 * per server, which still stops one person from reading the prospect list through the check.
 */
@Injectable()
export class DuplicateCheckThrottle {
  private readonly hits = new Map<string, number[]>();

  constructor(private readonly clock: Clock) {}

  /** Records one check for the person; false when they are over the limit (the check is then refused). */
  allow(employeeId: string): boolean {
    const now = this.clock.now().getTime();
    const recent = (this.hits.get(employeeId) ?? []).filter((t) => now - t < WINDOW_MS);
    if (recent.length >= SALES_DUPLICATE_CHECKS_PER_MINUTE) {
      this.hits.set(employeeId, recent);
      return false;
    }
    recent.push(now);
    this.hits.set(employeeId, recent);
    if (this.hits.size > 10_000) this.prune(now);
    return true;
  }

  private prune(now: number): void {
    for (const [id, times] of this.hits) {
      if (!times.some((t) => now - t < WINDOW_MS)) this.hits.delete(id);
    }
  }
}
