/**
 * The tracking policy every employee accepts on first login (plan §8 fair-use rules).
 * Shown in the first-login wizard, My account and Activity ("Fair use").
 */
export const POLICY_VERSION = "2026-11";

export const TRACKING_RECORDED = [
  "When you log in and out, and from which device and approximate city",
  "Active and idle time while the app is open",
  "Screens you open and actions you take inside the system",
  "Changes you make (old and new value)",
  "Opening sensitive records such as payslips or bank details",
  "For sales staff: work counts from company accounts on Apollo, MillionVerifier and outreach mailboxes",
];

export const TRACKING_NEVER = [
  "Screen recording or screenshots",
  "Keystrokes, camera or microphone",
  "The text of your emails or private messages",
  "GPS location (only the approximate city from the network)",
  "Personal accounts, other apps or personal devices",
];
