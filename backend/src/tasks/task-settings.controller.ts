import { Body, Controller, Get, Param, Patch, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { z } from 'zod';
import { taskSizeSchema, updateSizeRuleRequestSchema } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { ClientInfo, CurrentActor, RequestInfo, RequirePermission } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { TaskSettingsService } from './task-settings.service';

class UpdateSizeRuleDto extends createZodDto(updateSizeRuleRequestSchema) {}
class SizeParamDto extends createZodDto(z.object({ size: taskSizeSchema })) {}

/**
 * Module 5 reference data and settings: projects, the holiday calendar, the size table.
 * Reading needs task.view_own (everyone); changing the size table needs settings.manage (the Director).
 */
@ApiTags('tasks')
@Controller()
export class TaskSettingsController {
  constructor(private readonly settings: TaskSettingsService) {}

  @Get('projects')
  @RequirePermission('task.view_own')
  @ApiOperation({ summary: 'Projects and clients a task can be linked to (minimal, read only for now)' })
  projects(@CurrentActor() actor: Actor) {
    return this.settings.projects(actor);
  }

  @Get('settings/task-sizes')
  @RequirePermission('task.view_own')
  @ApiOperation({ summary: 'The size table: hours, points and suggested working days for XS, S, M, L and XL' })
  sizeRules() {
    return this.settings.sizeRules();
  }

  @Get('settings/task-sizes/changes')
  @RequirePermission('settings.view')
  @ApiOperation({ summary: 'The history of changes to the size table (who, what, why)' })
  sizeRuleChanges() {
    return this.settings.sizeRuleChanges();
  }

  @Patch('settings/task-sizes/:size')
  @RequirePermission('settings.manage')
  @ApiOperation({ summary: 'Change one size row (the Director). A reason is required; old tasks keep the points they were created with.' })
  updateSizeRule(@CurrentActor() actor: Actor, @Param() params: SizeParamDto, @Body() body: UpdateSizeRuleDto, @ClientInfo() client: RequestInfo) {
    return this.settings.updateSizeRule(actor, params.size, body, client);
  }
}
