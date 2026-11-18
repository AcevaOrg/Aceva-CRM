import { Body, Controller, HttpCode, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { approveExtensionRequestSchema, rejectExtensionRequestSchema } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { Authenticated, ClientInfo, CurrentActor, RequestInfo } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { TaskWorkflowService } from './task-workflow.service';

class ApproveExtensionDto extends createZodDto(approveExtensionRequestSchema) {}
class RejectExtensionDto extends createZodDto(rejectExtensionRequestSchema) {}

/** Decisions on extension requests (spec 9.5: POST /extensions/:id/{approve|reject}). */
@ApiTags('tasks')
@Controller('extensions')
export class TaskExtensionsController {
  constructor(private readonly workflow: TaskWorkflowService) {}

  @Post(':id/approve')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve an extension request (the assigner, never the person who asked). The new deadline is saved and the original kept.' })
  approve(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: ApproveExtensionDto, @ClientInfo() client: RequestInfo) {
    return this.workflow.decideExtension(actor, id, 'approve', body.reason, client);
  }

  @Post(':id/reject')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'Reject an extension request with a reason (the assigner)' })
  reject(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: RejectExtensionDto, @ClientInfo() client: RequestInfo) {
    return this.workflow.decideExtension(actor, id, 'reject', body.reason, client);
  }
}
