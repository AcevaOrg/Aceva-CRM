import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { ModuleSettingsView, UpdateModuleSettings } from '@aceva/contracts';
import type { z } from 'zod';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { PermissionService } from '../access/permission.service';
import { StepUpService } from '../auth/step-up.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

type Db = PrismaService | Prisma.TransactionClient;

/**
 * One module's settings (Cycle 3 shared foundation). The module registers it once, in its own constructor or
 * onModuleInit; the value is always checked against `schema` (on read too, so a bad stored value never leaks out).
 */
export interface ModuleSettingsDefinition<T extends Record<string, unknown>> {
  module: string;
  schema: z.ZodType<T>;
  defaults: T;
  /** Who may read them (default settings.view) and who may change them. */
  viewPermission?: string;
  managePermission: string;
  /** Changing them needs "confirm again" (step-up) as well. */
  stepUp?: boolean;
}

/**
 * Module-owned settings: the pattern for module settings until Module 12's settings screen exists.
 * Stored in module_settings (one row per module) with a version for optimistic locking; version 0 = still the defaults.
 * Every change is checked by the module's schema, needs the module's permission (and step-up when asked), and is
 * written to the audit log with its reason, the old value and the new value, in the same transaction.
 * Secrets never belong here (they would appear in the audit log).
 */
@Injectable()
export class ModuleSettingsService {
  private readonly modules = new Map<string, ModuleSettingsDefinition<Record<string, unknown>>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly permissions: PermissionService,
    private readonly stepUp: StepUpService,
    private readonly audit: AuditService,
  ) {}

  register<T extends Record<string, unknown>>(definition: ModuleSettingsDefinition<T>): void {
    if (this.modules.has(definition.module)) throw new Error(`Module settings "${definition.module}" are registered twice`);
    definition.schema.parse(definition.defaults); // the defaults must be valid themselves
    this.modules.set(definition.module, definition as unknown as ModuleSettingsDefinition<Record<string, unknown>>);
  }

  /** The current value for the module's own code (no permission check; callers inside the server only). */
  async value<T extends Record<string, unknown>>(module: string, db: Db = this.prisma): Promise<T> {
    return (await this.read(this.definition(module), db)).value as T;
  }

  /** GET /settings/modules/:module */
  async view(actor: Actor, module: string): Promise<ModuleSettingsView> {
    const def = this.definition(module);
    if (!(await this.permissions.can(actor.id, def.viewPermission ?? 'settings.view'))) throw this.notFound(module);
    return this.read(def, this.prisma);
  }

  /** PUT /settings/modules/:module */
  async update(actor: Actor, module: string, dto: UpdateModuleSettings, sessionId: string | null, client: RequestInfo): Promise<ModuleSettingsView> {
    const def = this.definition(module);
    if (!(await this.permissions.can(actor.id, def.viewPermission ?? 'settings.view'))) throw this.notFound(module);
    if (!(await this.permissions.can(actor.id, def.managePermission))) {
      await this.audit.record({ actorId: actor.id, action: 'access.denied', targetType: 'module_settings', targetId: module, outcome: 'denied', reason: 'missing_permission', ...client });
      throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message: 'You cannot change these settings' });
    }
    const parsed = def.schema.safeParse(dto.value);
    if (!parsed.success) {
      throw new BadRequestException({ statusCode: 400, code: 'invalid_settings', message: 'These settings are not valid', issues: parsed.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) });
    }
    if (def.stepUp) await this.stepUp.require(actor, sessionId, `settings.${module}.change`, { type: 'module_settings', id: module }, client);

    await this.prisma.$transaction(async (tx) => {
      const before = await this.read(def, tx);
      if (before.version !== dto.version) {
        throw new ConflictException({ statusCode: 409, code: 'stale_version', message: 'Someone changed these settings meanwhile. Reload them and try again', version: before.version });
      }
      const value = parsed.data as Prisma.InputJsonValue;
      if (dto.version === 0) {
        // First change: insert, unless someone else inserted meanwhile (then the version is stale).
        const { count: created } = await tx.moduleSetting.createMany({ data: [{ module, value, version: 1, updatedBy: actor.id }], skipDuplicates: true });
        if (created === 0) throw new ConflictException({ statusCode: 409, code: 'stale_version', message: 'Someone changed these settings meanwhile. Reload them and try again' });
      } else {
        const { count } = await tx.moduleSetting.updateMany({ where: { module, version: dto.version }, data: { value, version: { increment: 1 }, updatedBy: actor.id } });
        if (count === 0) throw new ConflictException({ statusCode: 409, code: 'stale_version', message: 'Someone changed these settings meanwhile. Reload them and try again' });
      }
      await this.audit.record(
        { actorId: actor.id, action: 'settings.module.changed', targetType: 'module_settings', targetId: module, reason: dto.reason, details: { before: before.value, after: parsed.data } as Prisma.InputJsonValue, ...client },
        tx,
      );
    });
    return this.read(def, this.prisma);
  }

  private definition(module: string): ModuleSettingsDefinition<Record<string, unknown>> {
    const def = this.modules.get(module);
    if (!def) throw this.notFound(module);
    return def;
  }

  private notFound(module: string) {
    return new NotFoundException({ statusCode: 404, code: 'not_found', message: `Settings "${module}" not found` });
  }

  private async read(def: ModuleSettingsDefinition<Record<string, unknown>>, db: Db): Promise<ModuleSettingsView> {
    const row = await db.moduleSetting.findUnique({ where: { module: def.module } });
    if (!row) return { module: def.module, value: { ...def.defaults }, version: 0, updatedAt: null, updatedByEmpId: null };
    // Defaults fill keys added to the module's schema after the row was written.
    const value = def.schema.parse({ ...def.defaults, ...(row.value as Record<string, unknown>) });
    const by = row.updatedBy ? await db.employee.findUnique({ where: { id: row.updatedBy }, select: { empId: true } }) : null;
    return { module: def.module, value, version: row.version, updatedAt: row.updatedAt.toISOString(), updatedByEmpId: by?.empId ?? null };
  }
}
