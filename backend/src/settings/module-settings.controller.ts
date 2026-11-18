import { Body, Controller, Get, Param, Put } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { settingsModuleKeySchema, updateModuleSettingsSchema } from '@aceva/contracts';
import { BadRequestException } from '@nestjs/common';
import type { Actor } from '../access/access.types';
import { Authenticated, ClientInfo, CurrentActor, CurrentSessionId, RequestInfo } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { ModuleSettingsService } from './module-settings.service';

class UpdateModuleSettingsDto extends createZodDto(updateModuleSettingsSchema) {}

function moduleKey(raw: string): string {
  const parsed = settingsModuleKeySchema.safeParse(raw);
  if (!parsed.success) throw new BadRequestException({ statusCode: 400, code: 'invalid_module', message: 'Unknown settings module' });
  return parsed.data;
}

/** Module-owned settings (Cycle 3 foundation). The permission depends on the module, so the service checks it. */
@ApiTags('settings')
@Controller('settings/modules')
export class ModuleSettingsController {
  constructor(private readonly settings: ModuleSettingsService) {}

  @Get(':module')
  @Authenticated()
  @ApiOperation({ summary: "One module's settings: the value (defaults filled in), its version and who changed it last" })
  view(@CurrentActor() actor: Actor, @Param('module') module: string) {
    return this.settings.view(actor, moduleKey(module));
  }

  @Put(':module')
  @Authenticated()
  @ApiOperation({ summary: 'Change a module\'s settings: the whole value, the version read and a reason. Validated, versioned and audited' })
  update(@CurrentActor() actor: Actor, @Param('module') module: string, @Body() body: UpdateModuleSettingsDto, @CurrentSessionId() sessionId: string | null, @ClientInfo() client: RequestInfo) {
    return this.settings.update(actor, moduleKey(module), body, sessionId, client);
  }
}
