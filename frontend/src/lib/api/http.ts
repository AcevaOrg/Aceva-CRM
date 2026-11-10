/**
 * HTTP client for the NestJS API (spec §7). Used when a module is switched from
 * mock to live (spec §13). The session is an HTTP-only cookie, so we only send credentials.
 *
 * Live modules: NEXT_PUBLIC_API_MODE=live switches every module; NEXT_PUBLIC_LIVE_MODULES=m1
 * (a comma list) switches just those modules, which is how the app is moved over one module at a time.
 */
import type { ApiErrorBody } from "@/types";
import { useSession } from "@/lib/auth/session";
import { ApiError } from "./mock";

export const API_MODE = (process.env.NEXT_PUBLIC_API_MODE ?? "mock") as "mock" | "live";
const BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api/v1";
const LIVE_MODULES = (process.env.NEXT_PUBLIC_LIVE_MODULES ?? "")
  .split(",")
  .map((m) => m.trim().toLowerCase())
  .filter(Boolean);
/** DEVELOPMENT ONLY until M2 (real login): send "X-Dev-Emp-Id" so the server knows who is calling. Not security. */
const DEV_IDENTITY = process.env.NEXT_PUBLIC_DEV_IDENTITY === "true";

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

async function request<T>(method: string, path: string, body?: unknown, params?: Params): Promise<T> {
  const headers: Record<string, string> = {};
  if (body !== undefined) headers["Content-Type"] = "application/json";
  if (DEV_IDENTITY) {
    const empId = useSession.getState().empId;
    if (empId) headers["X-Dev-Emp-Id"] = empId;
  }
  let res: Response;
  try {
    res = await fetch(url(path, params), {
      method,
      credentials: "include",
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError("network", "Can't reach the server. Check your connection and try again.", 0);
  }
  if (!res.ok) {
    const err = (await res.json().catch(() => ({ code: "http_error", message: res.statusText }))) as ApiErrorBody;
    throw toApiError(res.status, err, res.statusText);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const http = {
  get: <T>(path: string, params?: Params) => request<T>("GET", path, undefined, params),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  delete: <T>(path: string, body?: unknown) => request<T>("DELETE", path, body),
};
