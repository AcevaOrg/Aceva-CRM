import { Injectable, Logger } from '@nestjs/common';
import type { z } from 'zod';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Settings by section (the system_settings table, plan section 17). Read-only for now: every reader passes its own
 * defaults and schema, so a missing or broken row never breaks a feature (the defaults apply and a warning is logged).
 * Module 12 adds the settings screen, the audited PATCH /settings/:section and the step-up for starred sections.
 * Until then a section is changed with SQL (docs/M4-ACCEPTANCE.md shows how for "alert-rules").
 */
@Injectable()
export class SettingsService {
  private readonly logger = new Logger('Settings');

  constructor(private readonly prisma: PrismaService) {}

  /** The section's stored values on top of the defaults, validated by the schema. */
  async read<T>(section: string, schema: z.ZodType<T>, defaults: T): Promise<T> {
    const row = await this.prisma.systemSetting.findUnique({ where: { section }, select: { values: true } });
    if (!row) return defaults;
    const stored = row.values && typeof row.values === 'object' && !Array.isArray(row.values) ? row.values : {};
    const parsed = schema.safeParse({ ...defaults, ...stored });
    if (!parsed.success) {
      this.logger.warn(`Settings section "${section}" is not valid (${parsed.error.issues.map((i) => i.path.join('.')).join(', ')}); using the defaults`);
      return defaults;
    }
    return parsed.data;
  }
}
