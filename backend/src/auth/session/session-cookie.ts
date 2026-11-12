import type { CookieOptions } from 'express';
import type { Env } from '../../config/env';

export const SESSION_COOKIE = 'aceva_session';

/**
 * The session cookie: HttpOnly (page scripts cannot read it), SameSite=Lax (not sent on cross-site requests
 * that change data), Secure over HTTPS in production. Without "remember me" it is a browser-session cookie;
 * with it, the cookie survives closing the browser but never outlives the 12-hour session limit.
 */
export function sessionCookieOptions(env: Env, remember: boolean, absoluteExpiresAt: number, nowMs: number): CookieOptions {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: env.COOKIE_SECURE ?? env.NODE_ENV === 'production',
    path: '/',
    ...(remember ? { maxAge: Math.max(0, absoluteExpiresAt - nowMs) } : {}),
  };
}

export function clearCookieOptions(env: Env): CookieOptions {
  return { httpOnly: true, sameSite: 'lax', secure: env.COOKIE_SECURE ?? env.NODE_ENV === 'production', path: '/' };
}
