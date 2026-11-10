/**
 * HTTP client for the NestJS API (spec §7). Used when a module is switched from
 * mock to live (spec §13). The session is an HTTP-only cookie, so we only send credentials.
 *
 * Live modules: NEXT_PUBLIC_API_MODE=live switches every module; NEXT_PUBLIC_LIVE_MODULES=m1
 * (a comma list) switches just those modules, which is how the app is moved over one module at a time.
 */
import type { ApiErrorBody } from "@/types";
import { useSession } from "@/lib/auth/session";
import { getCsrf } from "./csrf";
import { ApiError } from "./mock";

export const API_MODE = (process.env.NEXT_PUBLIC_API_MODE ?? "mock") as "mock" | "live";
const BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api/v1";
const LIVE_MODULES = (process.env.NEXT_PUBLIC_LIVE_MODULES ?? "")
  .split(",")
  .map((m) => m.trim().toLowerCase())
  .filter(Boolean);

/** Is this module talking to the real API (true) or the in-browser mock data (false)? */
export const isLive = (module: string) => API_MODE === "live" || LIVE_MODULES.includes(module.toLowerCase());

type Params = Record<string, string | number | boolean | undefined | null>;

function url(path: string, params?: Params) {
  const u = new URL(BASE + path, typeof window === "undefined" ? "http://localhost" : window.location.origin);
  Object.entries(params ?? {}).forEach(([k, v]) => v !== undefined && v !== null && u.searchParams.set(k, String(v)));
  return u.toString();
}

const CODE_BY_STATUS: Record<number, string> = { 400: "validation", 401: "unauthenticated", 403: "forbidden", 404: "not_found", 409: "conflict" };

/** Turns the server's error body (validation issues, rule violations or a plain message) into an ApiError. */
export function toApiError(status: number, body: unknown, fallback: string): ApiError {
  const b = (body ?? {}) as {
    code?: string;
    message?: string | string[];
    details?: Record<string, string[]>;
    issues?: Array<{ path: string; message: string }>;
    violations?: Array<{ code: string; message: string }>;
  };
  let message = Array.isArray(b.message) ? b.message.join(" ") : (b.message ?? fallback);
  let details = b.details;
  if (b.violations?.length) message = b.violations.map((v) => v.message).join(" ");
  if (b.issues?.length) {
    message = b.issues.map((i) => (i.path ? `${i.path}: ${i.message}` : i.message)).join(" ");
    details = b.issues.reduce<Record<string, string[]>>((acc, i) => ((acc[i.path || "form"] ||= []).push(i.message), acc), {});
  }
  return new ApiError(b.code ?? CODE_BY_STATUS[status] ?? "http_error", message, status, details);
}

/** Calls that are allowed to fail with 401 without it meaning "your session ended". */
const AUTH_ENTRY_PATHS = new Set(["/auth/login", "/auth/logout", "/auth/password/forgot", "/auth/password/reset", "/auth/me"]);

/**
 * Module 2: when the server says the session is gone (401) or the login is unfinished (403 auth_incomplete), send
 * the person to the right screen. The session store is cleared so no stale screen stays open.
 */
function handleAuthFailure(status: number, path: string, body: { code?: string; stage?: string }) {
  if (typeof window === "undefined") return;
  const here = window.location.pathname;
  const onAuthScreen = here.startsWith("/login") || here.startsWith("/first-login") || here.startsWith("/forgot-password") || here.startsWith("/reset-password");
  if (status === 401 && !AUTH_ENTRY_PATHS.has(path) && !onAuthScreen) {
    useSession.getState().signOutLocal();
    window.location.assign("/login?expired=1");
  } else if (status === 403 && body.code === "auth_incomplete" && !onAuthScreen) {
    const next = body.stage === "password_change_required" ? "/first-login" : body.stage === "2fa_required" ? "/login/verify" : "/login/setup";
    window.location.assign(next);
  }
}

async function request<T>(method: string, path: string, body?: unknown, params?: Params, as: "json" | "blob" = "json"): Promise<T> {
  const headers: Record<string, string> = {};
  const isForm = typeof FormData !== "undefined" && body instanceof FormData;
  // A multipart body sets its own Content-Type (with the boundary).
  if (body !== undefined && !isForm) headers["Content-Type"] = "application/json";
  // Module 2: the session is an HttpOnly cookie; a change request also carries this tab's CSRF token.
  if (method !== "GET") {
    const csrf = getCsrf();
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }
  let res: Response;
  try {
    res = await fetch(url(path, params), {
      method,
      credentials: "include",
      headers,
      body: body === undefined ? undefined : isForm ? (body as FormData) : JSON.stringify(body),
    });
  } catch {
    throw new ApiError("network", "Can't reach the server. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({ code: "http_error", message: res.statusText }))) as ApiErrorBody & { stage?: string };
    if (isLive("m2")) handleAuthFailure(res.status, path, err);
    throw toApiError(res.status, err, res.statusText);
  }
  if (as === "blob") return (await res.blob()) as T;
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const http = {
  get: <T>(path: string, params?: Params) => request<T>("GET", path, undefined, params),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  delete: <T>(path: string, body?: unknown) => request<T>("DELETE", path, body),
  /** Multipart upload (files). */
  upload: <T>(path: string, form: FormData) => request<T>("POST", path, form),
  /** A file download as a Blob (sent with the session cookie, so the server checks permission). */
  blob: (path: string) => request<Blob>("GET", path, undefined, undefined, "blob"),
};
