import { describe, expect, it } from 'vitest';
import {
  accountLockedAlert,
  ALERT_RULE_DEFAULTS,
  alertRuleSettingsSchema,
  canCheckAlert,
  financeAttemptsAlert,
  flagFor,
  isOutsideWorkingHours,
  isOwnRecord,
  LARGE_EXPORT_WINDOW_MIN,
  largeExportAlert,
  newSignIn,
  newSignInAlert,
  outsideHoursAlert,
  pakistanClock,
  salaryViewsAlert,
  windowBucket,
} from './alert-rules';
import { cityForIp, ipv4ToNumber, parseIpRanges, plainIp } from './ip-ranges';

const pk = (time: string, day = '2026-11-10') => new Date(`${day}T${time}:00+05:00`);

describe('login outside working hours', () => {
  it('reads the time in Pakistan', () => {
    expect(pakistanClock(new Date('2026-11-10T18:10:00Z'))).toBe('23:10');
  });

  it('a window over midnight (20:00 to 07:00, the default)', () => {
    const { outsideFrom: from, outsideTo: to } = ALERT_RULE_DEFAULTS;
    expect(isOutsideWorkingHours(pk('23:10'), from, to)).toBe(true);
    expect(isOutsideWorkingHours(pk('20:00'), from, to)).toBe(true);
    expect(isOutsideWorkingHours(pk('06:59'), from, to)).toBe(true);
    expect(isOutsideWorkingHours(pk('07:00'), from, to)).toBe(false);
    expect(isOutsideWorkingHours(pk('19:59'), from, to)).toBe(false);
    expect(isOutsideWorkingHours(pk('09:02'), from, to)).toBe(false);
  });

  it('a window inside one day, and an empty window', () => {
    expect(isOutsideWorkingHours(pk('13:30'), '13:00', '14:00')).toBe(true);
    expect(isOutsideWorkingHours(pk('14:00'), '13:00', '14:00')).toBe(false);
    expect(isOutsideWorkingHours(pk('13:30'), '09:00', '09:00')).toBe(false);
  });

  it('describes the login', () => {
    expect(outsideHoursAlert(pk('23:10'), { city: 'Karachi', device: 'Chrome 142 on Windows' })).toEqual({
      kind: 'outside_hours',
      rule: 'Login outside working hours',
      severity: 'low',
      details: 'Signed in at 23:10 (Pakistan time) from Karachi, Chrome 142 on Windows.',
    });
  });
});

describe('login from a new device or a new city', () => {
  const laptop = 'windows computer|chrome|windows';
  const phone = 'android phone|chrome|android';

  it('the first sign-in ever sets the baseline and raises nothing', () => {
    expect(newSignIn([], { fingerprint: laptop, city: 'Karachi' })).toEqual({ newDevice: false, newCity: false });
  });

  it('a device not used before', () => {
    expect(newSignIn([{ fingerprint: laptop, city: 'Karachi' }], { fingerprint: phone, city: 'Karachi' })).toEqual({ newDevice: true, newCity: false });
  });

  it('a known city is never new; an unknown city is never new; a city only counts when one was known before', () => {
    expect(newSignIn([{ fingerprint: laptop, city: 'Karachi' }], { fingerprint: laptop, city: 'lahore ' })).toEqual({ newDevice: false, newCity: true });
    expect(newSignIn([{ fingerprint: laptop, city: 'Karachi' }], { fingerprint: laptop, city: 'karachi' })).toEqual({ newDevice: false, newCity: false });
    expect(newSignIn([{ fingerprint: laptop, city: 'Karachi' }], { fingerprint: laptop, city: null })).toEqual({ newDevice: false, newCity: false });
    expect(newSignIn([{ fingerprint: laptop, city: null }], { fingerprint: laptop, city: 'Lahore' })).toEqual({ newDevice: false, newCity: false });
  });

  it('a new city is high severity; a new device alone is medium', () => {
    const city = newSignInAlert({ newDevice: true, newCity: true, device: 'Chrome 142 on Android', city: 'Lahore', ip: '182.185.4.77', usualCities: ['Karachi'] });
    expect(city).toMatchObject({ kind: 'new_device', rule: 'Login from a new city', severity: 'high' });
    expect(city?.details).toBe('Signed in from Lahore on a new device: Chrome 142 on Android (182.185.4.77). Usual: Karachi.');
    expect(newSignInAlert({ newDevice: true, newCity: false, device: 'Chrome 142 on Android', city: null, ip: '10.0.0.5', usualCities: [] })).toMatchObject({
      rule: 'Login from a new device',
      severity: 'medium',
      details: 'Signed in on a device not used before: Chrome 142 on Android (10.0.0.5).',
    });
    expect(newSignInAlert({ newDevice: false, newCity: false, device: 'x', city: null, ip: 'y', usualCities: [] })).toBeNull();
  });

  it('a new city is named once, with or without a new device and a list of usual cities', () => {
    const base = { newDevice: false, newCity: true, device: 'Edge 130 on Windows', city: 'Lahore', ip: '182.185.4.77', usualCities: ['Karachi'] };
    expect(newSignInAlert(base)?.details).toBe('Signed in from Lahore: Edge 130 on Windows (182.185.4.77). Usual: Karachi.');
    expect(newSignInAlert({ ...base, usualCities: ['Karachi', 'Islamabad'] })?.details).toBe('Signed in from Lahore: Edge 130 on Windows (182.185.4.77). Usual: Karachi, Islamabad.');
    expect(newSignInAlert({ ...base, usualCities: [] })?.details).toBe('Signed in from Lahore: Edge 130 on Windows (182.185.4.77).');
    expect(newSignInAlert(base)?.details.match(/Lahore/g)).toHaveLength(1);
  });

  it('shows an IPv4 address that arrives in its IPv6 form as plain IPv4', () => {
    const mapped = { newDevice: true, newCity: false, device: 'Edge 130 on Windows', city: 'Karachi', ip: '::ffff:127.0.0.1', usualCities: [] };
    expect(newSignInAlert(mapped)?.details).toBe('Signed in on a device not used before: Edge 130 on Windows, Karachi (127.0.0.1).');
    expect(newSignInAlert({ ...mapped, newCity: true, city: 'Lahore', usualCities: ['Karachi'] })?.details).toBe(
      'Signed in from Lahore on a new device: Edge 130 on Windows (127.0.0.1). Usual: Karachi.',
    );
  });
});

describe('the other alert texts', () => {
  it('account locked, large export, salary views, finance attempts', () => {
    expect(accountLockedAlert({ attempts: 5, device: 'Chrome 142 on Windows', city: 'Karachi', ip: '39.45.12.20' })).toMatchObject({
      rule: 'Account locked after 5 wrong passwords',
      severity: 'medium',
      details: '5 wrong passwords, the last from Chrome 142 on Windows, Karachi (39.45.12.20). The account stays locked until a manager above the person unlocks it.',
    });
    // A city or an address that is not known is left out, and an IPv4-in-IPv6 address is shown as IPv4
    expect(accountLockedAlert({ attempts: 5, device: 'Chrome 130 on Windows', city: 'Karachi', ip: '::ffff:127.0.0.1' }).details).toBe('5 wrong passwords, the last from Chrome 130 on Windows, Karachi (127.0.0.1). The account stays locked until a manager above the person unlocks it.');
    expect(accountLockedAlert({ attempts: 5, device: 'Chrome 130 on Windows', city: null, ip: '39.45.12.20' }).details).toBe('5 wrong passwords, the last from Chrome 130 on Windows (39.45.12.20). The account stays locked until a manager above the person unlocks it.');
    expect(accountLockedAlert({ attempts: 5, device: null, city: null, ip: null }).details).toBe('5 wrong passwords. The account stays locked until a manager above the person unlocks it.');
    expect(largeExportAlert({ rows: 1240, module: 'Ledger', dataKind: 'finance' })).toEqual({
      kind: 'large_export',
      rule: 'Large export of finance data',
      severity: 'medium',
      details: '1,240 rows exported from Ledger.',
    });
    expect(salaryViewsAlert({ count: 9, minutes: 60 }).details).toBe('9 salary, bank or payslip records opened in 60 minutes.');
    expect(financeAttemptsAlert({ count: 3, minutes: 15, modules: ['Statements', 'Payroll'] })).toMatchObject({ severity: 'high', rule: 'Repeated attempts to open finance screens' });
  });
});

describe('which activity the alert rules look at', () => {
  it('blocked finance attempts, salary/bank/payslip views and exports with a row count', () => {
    expect(flagFor({ action: 'blocked', financeLinked: true })).toBe('finance_blocked');
    expect(flagFor({ action: 'blocked', financeLinked: false })).toBeNull();
    expect(flagFor({ action: 'sensitive_view', financeLinked: false, details: { category: 'salary' } })).toBe('salary_view');
    expect(flagFor({ action: 'sensitive_view', financeLinked: false, details: { category: 'bank' } })).toBe('salary_view');
    expect(flagFor({ action: 'sensitive_view', financeLinked: false, details: { category: 'personal' } })).toBeNull();
    expect(flagFor({ action: 'export', financeLinked: false, details: { rows: 12 } })).toBe('export');
    expect(flagFor({ action: 'export', financeLinked: false })).toBeNull();
    expect(flagFor({ action: 'edit', financeLinked: true })).toBeNull();
  });

  it('counts per window so a rule raises at most one alert per person and window', () => {
    expect(windowBucket(new Date('2026-11-10T10:14:59Z'), 15)).toBe('2026-11-10T10:00:00.000Z');
    expect(windowBucket(new Date('2026-11-10T10:15:00Z'), 15)).toBe('2026-11-10T10:15:00.000Z');
  });

  it('showing yourself your own salary or bank number is not opening other people\'s records', () => {
    const own = { action: 'sensitive_view', financeLinked: true, details: { category: 'salary' }, target: 'ACV-0007', empId: 'ACV-0007' };
    expect(flagFor(own)).toBeNull();
    expect(flagFor({ ...own, details: { category: 'bank' } })).toBeNull();
    expect(flagFor({ ...own, details: { category: 'payslip' } })).toBeNull();
    // Somebody else's record, or an event that does not say whose it is, still counts
    expect(flagFor({ ...own, target: 'ACV-0008' })).toBe('salary_view');
    expect(flagFor({ ...own, target: null })).toBe('salary_view');
    expect(flagFor({ action: 'sensitive_view', financeLinked: true, details: { category: 'salary' } })).toBe('salary_view');
    expect(isOwnRecord({ target: 'ACV-0007', empId: 'ACV-0007' })).toBe(true);
    expect(isOwnRecord({ target: 'ACV-0008', empId: 'ACV-0007' })).toBe(false);
    expect(isOwnRecord({ target: 'ACV-0007' })).toBe(false);
    expect(isOwnRecord({ empId: 'ACV-0007' })).toBe(false);
  });

  it('a burst of large exports falls in one window, so it raises one alert (the key is the same)', () => {
    expect(LARGE_EXPORT_WINDOW_MIN).toBe(60);
    const key = (at: string) => windowBucket(new Date(at), LARGE_EXPORT_WINDOW_MIN);
    expect(key('2026-11-10T10:00:05Z')).toBe(key('2026-11-10T10:59:59Z'));
    expect(key('2026-11-10T11:00:00Z')).not.toBe(key('2026-11-10T10:59:59Z'));
  });
});

describe('who may mark an alert as checked (maker-checker)', () => {
  const director = { id: 'D', roleKey: 'director', permissions: new Set(['activity.security', 'session.force_logout']) };
  const cto = { id: 'C', roleKey: 'cto', permissions: new Set(['activity.security', 'session.force_logout']) };
  const owner = { id: 'O', roleKey: 'owner', permissions: new Set(['activity.security']) };
  const dev = { id: 'E', roleKey: 'employee' };

  it('the Director and the CTO check alerts about people below them', () => {
    expect(canCheckAlert(director, dev, true)).toBe(true);
    expect(canCheckAlert(cto, dev, true)).toBe(true);
    expect(canCheckAlert(cto, { id: 'S', roleKey: 'sales' }, false)).toBe(false); // beside, not below
  });

  it('nobody checks an alert about themselves; the CTO checks the Director, the Director checks the owner', () => {
    expect(canCheckAlert(director, { id: 'D', roleKey: 'director' }, false)).toBe(false);
    expect(canCheckAlert(cto, { id: 'D', roleKey: 'director' }, false)).toBe(true);
    expect(canCheckAlert(director, { id: 'O', roleKey: 'owner' }, false)).toBe(true);
    expect(canCheckAlert(cto, { id: 'O', roleKey: 'owner' }, false)).toBe(false);
  });

  it('the CEO / Founder / Owner sees alerts but checks none', () => {
    expect(canCheckAlert(owner, dev, true)).toBe(false);
    expect(canCheckAlert(owner, { id: 'D', roleKey: 'director' }, true)).toBe(false);
  });
});

describe('alert settings', () => {
  it('accepts the defaults and refuses broken values', () => {
    expect(alertRuleSettingsSchema.safeParse(ALERT_RULE_DEFAULTS).success).toBe(true);
    expect(alertRuleSettingsSchema.safeParse({ ...ALERT_RULE_DEFAULTS, outsideFrom: '25:00' }).success).toBe(false);
    expect(alertRuleSettingsSchema.safeParse({ ...ALERT_RULE_DEFAULTS, financeAttempts: 0 }).success).toBe(false);
    expect(alertRuleSettingsSchema.parse({ ...ALERT_RULE_DEFAULTS, bounceRatePct: 3 })).toMatchObject({ bounceRatePct: 3 }); // other fields are kept
  });
});

describe('approximate city from the internet address (local list, no outside service)', () => {
  const ranges = parseIpRanges('39.45.0.0/16=Karachi; 182.185.0.0/16 = Lahore\n182.185.4.0/24=Lahore (DHA)');

  it('finds the most specific range', () => {
    expect(cityForIp(ranges, '39.45.12.20')).toBe('Karachi');
    expect(cityForIp(ranges, '::ffff:39.45.200.1')).toBe('Karachi');
    expect(cityForIp(ranges, '182.185.9.9')).toBe('Lahore');
    expect(cityForIp(ranges, '182.185.4.77')).toBe('Lahore (DHA)');
  });

  it('a browser on this computer (127.0.0.1, or ::1 over IPv6) can be given a city for local checks', () => {
    const local = parseIpRanges('127.0.0.0/8=Karachi');
    expect(cityForIp(local, '127.0.0.1')).toBe('Karachi');
    expect(cityForIp(local, '::1')).toBe('Karachi');
    expect(cityForIp(local, '::ffff:127.0.0.1')).toBe('Karachi');
  });

  it('writes an IPv4 address that arrives in its IPv6 form as plain IPv4, and leaves every other address alone', () => {
    expect(plainIp('::ffff:127.0.0.1')).toBe('127.0.0.1');
    expect(plainIp('::FFFF:39.45.12.20')).toBe('39.45.12.20');
    expect(plainIp('0:0:0:0:0:ffff:10.0.0.5')).toBe('10.0.0.5');
    expect(plainIp('  ::ffff:10.0.0.5 ')).toBe('10.0.0.5');
    expect(plainIp('127.0.0.1')).toBe('127.0.0.1');
    expect(plainIp('::1')).toBe('::1');
    expect(plainIp('2001:db8::1')).toBe('2001:db8::1');
    expect(plainIp('::ffff:7f00:1')).toBe('::ffff:7f00:1');
    expect(plainIp('::ffff:not-an-address')).toBe('::ffff:not-an-address');
    expect(plainIp('')).toBe('');
  });

  it('anything else is unknown', () => {
    expect(cityForIp(ranges, '10.0.0.1')).toBeNull();
    expect(cityForIp(ranges, '2001:db8::1')).toBeNull();
    expect(cityForIp(ranges, null)).toBeNull();
    expect(cityForIp([], '39.45.12.20')).toBeNull();
    expect(ipv4ToNumber('1.2.3.256')).toBeNull();
    expect(ipv4ToNumber('0.0.1.1')).toBe(257);
  });

  it('refuses a malformed list with a clear message', () => {
    expect(parseIpRanges('')).toEqual([]);
    expect(() => parseIpRanges('39.45.0.0=Karachi')).toThrow(/GEOIP_RANGES/);
    expect(() => parseIpRanges('39.45.0.0/40=Karachi')).toThrow(/GEOIP_RANGES/);
    expect(() => parseIpRanges('39.45.0.0/16=')).toThrow(/GEOIP_RANGES/);
  });
});
