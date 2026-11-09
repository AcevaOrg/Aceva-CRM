/**
 * The in-memory "database" for mock mode (spec §7.3).
 *
 * Each feature registers its own tables lazily:
 *   const tasks = () => table("tasks", seedTasks);
 * so features never need to edit this file. Mutations change the arrays,
 * which makes the demo behave like a real app until the page reloads.
 * When a module is connected to the real API (spec §13), its tables go away.
 */
const store = new Map<string, unknown[]>();

export function table<T>(name: string, seed: () => T[]): T[] {
  if (!store.has(name)) store.set(name, seed());
  return store.get(name) as T[];
}

/** Simple sequence for human-readable numbers (TSK-0143, JE-2026-0312 …). */
const sequences = new Map<string, number>();
export function nextNumber(key: string, start: number) {
  const n = (sequences.get(key) ?? start) + 1;
  sequences.set(key, n);
  return n;
}
