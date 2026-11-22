/**
 * Approximate city from the internet address only (plan section 8: "Location is the approximate city from the internet
 * address only, never GPS"). No external GeoIP service is ever called: the city comes from a local list of address
 * ranges, configured in GEOIP_RANGES, for example
 *     GEOIP_RANGES="39.45.0.0/16=Karachi; 110.93.0.0/16=Karachi; 182.185.0.0/16=Lahore"
 * An address in no listed range has no city ("unknown"). Only IPv4 is mapped; IPv6 addresses stay unknown.
 */

export interface IpRange {
  base: number;
  prefix: number;
  city: string;
}

/**
 * 1.2.3.4 (or ::ffff:1.2.3.4) as a 32-bit number; null for anything that is not an IPv4 address. The IPv6 loopback ::1
 * (a browser on the same computer, during development) counts as 127.0.0.1.
 */
export function ipv4ToNumber(ip: string | null | undefined): number | null {
  if (!ip) return null;
  const text = ip.trim() === '::1' ? '127.0.0.1' : ip.trim().replace(/^::ffff:/i, '');
  const parts = text.split('.');
  if (parts.length !== 4) return null;
  let value = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const n = Number(part);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

/**
 * An address as people should read it: an IPv4 address that arrives in its IPv6 form (::ffff:127.0.0.1, which is what
 * Node reports for a connection over IPv4) is shown as plain 127.0.0.1. Anything else is returned as it is.
 */
export function plainIp(ip: string): string {
  const match = ip.trim().match(/^(?:::|(?:0{1,4}:){5})ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i);
  return match ? match[1] : ip;
}

/** Parses "a.b.c.d/n=City; ..." and throws a clear error for a malformed entry. */
export function parseIpRanges(spec: string | undefined): IpRange[] {
  if (!spec?.trim()) return [];
  return spec
    .split(/[;\n]/)
    .map((entry) => entry.trim())
    .filter(Boolean)
    .map((entry) => {
      const match = entry.match(/^([\d.]+)\/(\d{1,2})\s*=\s*(.+)$/);
      const base = match ? ipv4ToNumber(match[1]) : null;
      const prefix = match ? Number(match[2]) : NaN;
      if (!match || base === null || !(prefix >= 0 && prefix <= 32) || !match[3].trim()) {
        throw new Error(`GEOIP_RANGES: "${entry}" is not like 39.45.0.0/16=Karachi`);
      }
      return { base: maskOf(base, prefix), prefix, city: match[3].trim().slice(0, 80) };
    });
}

function maskOf(value: number, prefix: number): number {
  if (prefix === 0) return 0;
  const size = 2 ** (32 - prefix);
  return Math.floor(value / size) * size;
}

/** The city of the most specific matching range, or null. */
export function cityForIp(ranges: IpRange[], ip: string | null | undefined): string | null {
  const value = ipv4ToNumber(ip);
  if (value === null) return null;
  let best: IpRange | null = null;
  for (const range of ranges) {
    if (maskOf(value, range.prefix) === range.base && (!best || range.prefix > best.prefix)) best = range;
  }
  return best?.city ?? null;
}
