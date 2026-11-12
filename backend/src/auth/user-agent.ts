export interface DeviceInfo {
  device: string;
  browser: string;
  os: string;
}

/** A small, dependency-free reading of the browser's User-Agent text for the "My devices" screen. */
export function parseUserAgent(userAgent: string | null | undefined): DeviceInfo {
  const ua = userAgent ?? '';
  if (!ua) return { device: 'Unknown device', browser: 'Unknown browser', os: 'Unknown' };

  let os = 'Unknown';
  let device = 'Computer';
  if (/Android/i.test(ua)) {
    os = 'Android';
    device = /Mobile/i.test(ua) ? 'Android phone' : 'Android tablet';
  } else if (/iPhone/i.test(ua)) {
    os = 'iOS';
    device = 'iPhone';
  } else if (/iPad/i.test(ua)) {
    os = 'iPadOS';
    device = 'iPad';
  } else if (/Windows/i.test(ua)) {
    os = 'Windows';
    device = 'Windows computer';
  } else if (/Mac OS X|Macintosh/i.test(ua)) {
    os = 'macOS';
    device = 'Mac';
  } else if (/CrOS/i.test(ua)) {
    os = 'ChromeOS';
    device = 'Chromebook';
  } else if (/Linux/i.test(ua)) {
    os = 'Linux';
    device = 'Linux computer';
  }

  const match = (re: RegExp) => ua.match(re)?.[1]?.split('.')[0];
  let browser = 'Unknown browser';
  if (/Edg\//.test(ua)) browser = `Edge ${match(/Edg\/([\d.]+)/) ?? ''}`.trim();
  else if (/OPR\/|Opera/.test(ua)) browser = `Opera ${match(/OPR\/([\d.]+)/) ?? ''}`.trim();
  else if (/Firefox\//.test(ua)) browser = `Firefox ${match(/Firefox\/([\d.]+)/) ?? ''}`.trim();
  else if (/Chrome\//.test(ua)) browser = `Chrome ${match(/Chrome\/([\d.]+)/) ?? ''}`.trim();
  else if (/Safari\//.test(ua)) browser = `Safari ${match(/Version\/([\d.]+)/) ?? ''}`.trim();
  return { device, browser, os };
}
