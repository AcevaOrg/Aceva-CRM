import { Controller, Get, Param, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { approvalRouteQuerySchema } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { Authenticated, CurrentActor, Scope } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { ApprovalsService } from './approvals.service';

class RouteQueryDto extends createZodDto(approvalRouteQuerySchema) {}

@ApiTags('approvals')
@Controller()
export class ApprovalsController {
  constructor(private readonly approvals: ApprovalsService) {}

  @Get('approvals/route/:empId')
  @Authenticated()
  @Scope('empId', 'self_or_below')
  @ApiOperation({ summary: 'Who approves this person\'s request on a date? Follows the real reporting chain and stand-ins.' })
  route(@Param('empId') empId: string, @Query() query: RouteQueryDto) {
    return this.approvals.route(empId, query.date, query.afterSeat);
  }

  @Get('approvals/can-approve/:empId')
  @Authenticated()
  @Scope('empId', 'below')
  @ApiOperation({ summary: 'May I approve this person\'s request right now? (never my own; only the routed approver)' })
  canApprove(@CurrentActor() actor: Actor, @Param('empId') empId: string, @Query() query: RouteQueryDto) {
    return this.approvals.canApprove(actor, empId, query.date, query.afterSeat);
  }

  @Get('access/can-assign-task/:empId')
  @Authenticated()
  @ApiOperation({ summary: 'May I assign a task to this person? Tasks only move down my reporting line.' })
  async canAssignTask(@CurrentActor() actor: Actor, @Param('empId') empId: string) {
    return { allowed: await this.approvals.canAssignTask(actor, empId) };
  }
}
