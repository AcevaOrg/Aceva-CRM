/**
 * "What time is it?" as a service, so session timeouts, lockouts and token expiry can be tested
 * by moving a fake clock instead of waiting 30 minutes. Production uses the real clock.
 */
export abstract class Clock {
  abstract now(): Date;
}

export class SystemClock extends Clock {
  now(): Date {
    return new Date();
  }
}
