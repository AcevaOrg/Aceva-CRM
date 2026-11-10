import { z } from 'zod';
import { empIdSchema } from './events';

// ---------- requests ----------

const password = z.string().min(1, 'Enter a password').max(128);
const newPassword = z.string().min(10, 'The password must be at least 10 characters').max(128, 'The password must be at most 128 characters');
const code = z.string().regex(/^\d{6}$/, 'Enter the 6-digit code');

/** POST /auth/login */
export const loginRequestSchema = z.object({
  empId: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^ACV-\d{4,}$/, 'Emp-ID looks like ACV-0001'),
  password,
  /** Keep the browser signed in after it is closed. Never allowed for Finance users. */
  rememberMe: z.boolean().optional(),
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/** POST /auth/2fa/verify */
export const verifyTwoFactorRequestSchema = z.object({ code });
export type VerifyTwoFactorRequest = z.infer<typeof verifyTwoFactorRequestSchema>;

/** POST /auth/2fa/disable (only where 2FA is optional) */
export const disableTwoFactorRequestSchema = z.object({ password, code });
export type DisableTwoFactorRequest = z.infer<typeof disableTwoFactorRequestSchema>;

/** POST /auth/password/change. The current password may be left out only while it is a temporary one. */
export const changePasswordRequestSchema = z.object({
  currentPassword: password.optional(),
  newPassword,
});
export type ChangePasswordRequest = z.infer<typeof changePasswordRequestSchema>;

/** POST /auth/password/forgot */
export const forgotPasswordRequestSchema = z.object({
  empId: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^ACV-\d{4,}$/, 'Emp-ID looks like ACV-0001'),
});
export type ForgotPasswordRequest = z.infer<typeof forgotPasswordRequestSchema>;

/** POST /auth/password/reset */
export const resetPasswordRequestSchema = z.object({
  token: z.string().min(20).max(200),
  newPassword,
});
export type ResetPasswordRequest = z.infer<typeof resetPasswordRequestSchema>;

/** POST /auth/employees/:empId/unlock, /force-logout, /temporary-password */
export const adminActionRequestSchema = z.object({ reason: z.string().trim().max(500).optional() });
export type AdminActionRequest = z.infer<typeof adminActionRequestSchema>;

// ---------- responses ----------

export type LoginStatus =
  | 'ok'
  | '2fa_required'
  | '2fa_setup_required'
  | 'password_change_required'
  | 'locked'
  | 'invalid'
  | 'rate_limited';

export type SessionStageName = 'ok' | 'password_change_required' | '2fa_required' | '2fa_setup_required';

export interface LoginResult {
  status: LoginStatus;
  attemptsLeft?: number;
  retryAfterSec?: number;
}

export interface MeResponse {
  empId: string;
  name: string;
  level: number;
  roleKey: string;
  duties: string[];
  permissions: string[];
  twoFactorRequired: boolean;
  twoFactorEnabled: boolean;
  /** How far the login has got; only "ok" may use the app. */
  stage: SessionStageName;
  /** Send this in the X-CSRF-Token header on every request that changes data. */
  csrfToken: string;
  /** Finance users cannot use "remember me". */
  rememberAllowed: boolean;
}

export interface SessionInfo {
  id: string;
  device: string;
  browser: string;
  os: string;
  city: string;
  ip: string;
  startedAt: string;
  lastActiveAt: string;
  current: boolean;
}

export type LogoutReason = 'clicked' | 'timed_out' | 'forced' | 'password_changed';

export interface LoginHistoryItem {
  id: string;
  at: string;
  endedAt?: string;
  success: boolean;
  twoFactor: boolean;
  device: string;
  city: string;
  ip: string;
  endReason?: LogoutReason;
}

export interface TwoFactorSetupResponse {
  /** Shown once, so it can be typed into an authenticator app. */
  secret: string;
  otpauthUrl: string;
}

export interface TwoFactorStatus {
  required: boolean;
  enabled: boolean;
  enabledAt?: string;
}

export const empIdForAuth = empIdSchema;
