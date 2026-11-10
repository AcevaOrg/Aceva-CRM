import { z } from 'zod';

/** Response of GET /api/v1/health */
export const healthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  /** Can the API reach PostgreSQL? */
  database: z.enum(['up', 'down']),
  /** Server time in UTC (ISO 8601). */
  time: z.iso.datetime(),
  version: z.string(),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;
