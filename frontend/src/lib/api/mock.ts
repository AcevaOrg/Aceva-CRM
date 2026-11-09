/**
 * Mock adapter (spec §7.3): fake latency, deep-copied results, optional errors.
 * Add ?mockError=1 to the URL to see every screen's error state.
 */
export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
    public details?: Record<string, string[]>,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function shouldFail() {
  return typeof window !== "undefined" && new URLSearchParams(window.location.search).has("mockError");
}

export async function mock<T>(fn: () => T, opts: { delay?: number } = {}): Promise<T> {
  await sleep(opts.delay ?? 150 + Math.random() * 250);
  if (shouldFail()) throw new ApiError("mock_error", "The server didn't answer. This is a simulated error.", 500);
  const result = fn();
  return result === undefined ? result : structuredClone(result);
}

/** Throw a not-found the same way the server will for finance resources (plan §16). */
export function notFound(what = "Record"): never {
  throw new ApiError("not_found", `${what} not found`, 404);
}

export function forbidden(message: string): never {
  throw new ApiError("forbidden", message, 403);
}
