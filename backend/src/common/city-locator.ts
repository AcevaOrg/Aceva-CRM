import { Inject, Injectable } from '@nestjs/common';
import { cityForIp, parseIpRanges, type IpRange } from '../activity/rules/ip-ranges';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';

/**
 * The approximate city of an internet address (plan section 8: "Location is the approximate city from the internet
 * address only, never GPS"). Used for the session record (My devices), activity records and the "new city" alert.
 * Swap the implementation here if Aceva ever buys a GeoIP database; the rest of the app only sees this class.
 */
export abstract class CityLocator {
  /** The city, or null when it is not known. Never throws. */
  abstract cityFor(ip: string | null | undefined): string | null;
}

/**
 * The local stub: a list of address ranges in GEOIP_RANGES (for example "39.45.0.0/16=Karachi"). No outside service is
 * ever called. An address in no listed range has no city.
 */
@Injectable()
export class LocalRangeCityLocator extends CityLocator {
  private readonly ranges: IpRange[];

  constructor(@Inject(ENV) env: Env) {
    super();
    this.ranges = parseIpRanges(env.GEOIP_RANGES); // already validated when the configuration was loaded
  }

  cityFor(ip: string | null | undefined): string | null {
    return cityForIp(this.ranges, ip);
  }
}
