import { z } from 'zod';
import { empIdSchema } from './events';
import { decisionReasonSchema } from './shared';

/**
 * Module-owned settings (Cycle 3 shared foundation). Until Module 12's settings screen exists, each module owns its
 * settings: it registers a schema and defaults with the server, which validates, versions and audits every change.
 * GET /settings/modules/:module and PUT /settings/modules/:module.
 */
export const settingsModuleKeySchema = z.string().regex(/^[a-z][a-z0-9_]{1,40}$/, 'A module key looks like notifications');

export const moduleSettingsViewSchema = z.object({
  module: settingsModuleKeySchema,
  value: z.record(z.string(), z.unknown()),
  /** 0 = never changed (the defaults). Send it back with a change; a stale version is refused (409). */
  version: z.number().int().min(0),
  updatedAt: z.iso.datetime().nullable(),
  updatedByEmpId: empIdSchema.nullable(),
});
export type ModuleSettingsView = z.infer<typeof moduleSettingsViewSchema>;

export const updateModuleSettingsSchema = z
  .object({
    /** The whole new value; the module's own schema checks it. */
    value: z.record(z.string(), z.unknown()),
    version: z.number().int().min(0),
    reason: decisionReasonSchema,
  })
  .strict();
export type UpdateModuleSettings = z.infer<typeof updateModuleSettingsSchema>;
