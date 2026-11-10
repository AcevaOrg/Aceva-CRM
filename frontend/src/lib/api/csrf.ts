/**
 * The CSRF token (Module 2). The server gives it at login and with GET /auth/me; the page sends it back in the
 * X-CSRF-Token header on every request that changes data. It is kept for this browser tab only (sessionStorage),
 * never in a cookie, so another website cannot make the browser send it.
 */
const KEY = "aceva-csrf";

export function getCsrf(): string | null {
  try {
    return typeof window === "undefined" ? null : window.sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
}

export function setCsrf(token: string | undefined | null) {
  try {
    if (typeof window === "undefined") return;
    if (token) window.sessionStorage.setItem(KEY, token);
    else window.sessionStorage.removeItem(KEY);
  } catch {
    /* storage can be blocked; the next /auth/me call fetches the token again */
  }
}
