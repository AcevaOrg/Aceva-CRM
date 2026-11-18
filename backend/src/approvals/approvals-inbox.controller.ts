import { Body, Controller, Get, Param, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { decideApprovalRequestSchema } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { Authenticated, ClientInfo, CurrentActor, RequestInfo } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { ApprovalsInbox } from './approvals-inbox.service';

class DecideDto extends createZodDto(decideApprovalRequestSchema) {}

/** The approvals inbox (spec 4.5): what is waiting for me, what is waiting for people below me, and the decision. */
@ApiTags('approvals')
@Controller('approvals')
export class ApprovalsInboxController {
  constructor(private readonly inbox: ApprovalsInbox) {}

  @Get()
  @Authenticated()
  @ApiOperation({ summary: 'Everything waiting for my decision (task reviews, extensions, and later leave, payroll...), oldest first' })
  list(@CurrentActor() actor: Actor) {
    return this.inbox.list(actor);
  }

  @Get('oversight')
  @Authenticated()
  @ApiOperation({ summary: 'Read only: what is waiting for the people below me (empty unless I may see all activity)' })
  oversight(@CurrentActor() actor: Actor) {
    return this.inbox.oversight(actor);
  }

  @Post(':id/approve')
  @Authenticated()
  @ApiOperation({ summary: 'Approve an item ("task_review:<id>" needs a rating 1 to 5; the provider checks I am the one who decides)' })
  approve(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: DecideDto, @ClientInfo() client: RequestInfo) {
    return this.inbox.decide(actor, id, 'approve', body, client);
  }

  @Post(':id/reject')
  @Authenticated()
  @ApiOperation({ summary: 'Reject an item ("task_review" = send to rework; a reason is required)' })
  reject(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: DecideDto, @ClientInfo() client: RequestInfo) {
    return this.inbox.decide(actor, id, 'reject', body, client);
  }
}
