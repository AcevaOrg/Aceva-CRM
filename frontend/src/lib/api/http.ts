/**
 * HTTP client for the NestJS API (spec §7). Used when a module is switched from
 * mock to live (spec §13). The session is an HTTP-only cookie, so we only send credentials.
 */
import type { ApiErrorBody } from "@/types";
import { ApiError } from "./mock";

export const API_MODE = (process.env.NEXT_PUBLIC_API_MODE ?? "mock") as "mock" | "live";
const BASE = process.env.NEXT_PUBLIC_API_URL ?? "/api/v1";

type Params = Record<string, string | number | boolean | undefined | null>;

function url(path: string, params?: Params) {
  const u = new URL(BASE + path, typeof window === "undefined" ? "http://localhost" : window.location.origin);
  Object.entries(params ?? {}).forEach(([k, v]) => v !== undefined && v !== null && u.searchParams.set(k, String(v)));
  return u.toString();
}

async function request<T>(method: string, path: string, body?: unknown, params?: Params): Promise<T> {
  const res = await fetch(url(path, params), {
    method,
    credentials: "include",
    headers: body ? { "Content-Type": "application/json" } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({ code: "http_error", message: res.statusText }))) as ApiErrorBody;
    throw new ApiError(err.code, err.message, res.status, err.details);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const http = {
  get: <T>(path: string, params?: Params) => request<T>("GET", path, undefined, params),
  post: <T>(path: string, body?: unknown) => request<T>("POST", path, body),
  patch: <T>(path: string, body?: unknown) => request<T>("PATCH", path, body),
  put: <T>(path: string, body?: unknown) => request<T>("PUT", path, body),
  delete: <T>(path: string) => request<T>("DELETE", path),
};
