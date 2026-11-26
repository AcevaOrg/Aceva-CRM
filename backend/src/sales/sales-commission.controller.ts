import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  approveSalesCommissionSchema,
  decideSalesCommissionSchema,
  salesCommissionLeaverDecisionSchema,
  salesCommissionListQuerySchema,
  setSalesCommissionRuleSchema,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { Authenticated, ClientInfo, CurrentActor, CurrentSessionId, FinanceScreen, RequirePermission, type RequestInfo } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { COMMISSION_APPROVE, SalesCommissionService } from './sales-commission.service';

class ListQueryDto extends createZodDto(salesCommissionListQuerySchema) {}
class SetRuleDto extends createZodDto(setSalesCommissionRuleSchema) {}
class ApproveDto extends createZodDto(approveSalesCommissionSchema) {}
class DecideDto extends createZodDto(decideSalesCommissionSchema) {}
class LeaverDecisionDto extends createZodDto(salesCommissionLeaverDecisionSchema) {}

/**
 * Module 15.7 commission (approved scope). A finance screen: 10 minutes idle, and "not found" for anyone without access
 * (the service answers 404 itself where the access depends on more than one permission). Who sees what:
 * the salesperson their own lines, a sales manager their team's, the Director, the Owner and the Finance duty all lines;
 * the rules only the Director (sets them) and the Owner (views them).
 */
@ApiTags('sales')
@FinanceScreen()
@Controller('sales/commission')
export class SalesCommissionController {
  constructor(private readonly commission: SalesCommissionService) {}

  @Get()
  @Authenticated()
  @ApiOperation({ summary: 'Commission lines the caller may see (own, team or all), with totals per status' })
  list(@CurrentActor() actor: Actor, @Query() q: ListQueryDto) {
    return this.commission.list(actor, q);
  }

  @Get('rules')
  @Authenticated()
  @ApiOperation({ summary: 'The commission rule in force and every version (the Director and the Owner)' })
  rules(@CurrentActor() actor: Actor) {
    return this.commission.rules(actor);
  }

  @Put('rules')
  @RequirePermission(COMMISSION_APPROVE)
  @ApiOperation({ summary: 'A new version of the company commission rule (the Director, step-up, reason)' })
  setRule(@CurrentActor() actor: Actor, @CurrentSessionId() sessionId: string | null, @Body() body: SetRuleDto, @ClientInfo() client: RequestInfo) {
    return this.commission.setRule(actor, sessionId, body, client);
  }

  @Get(':id')
  @Authenticated()
  @ApiOperation({ summary: 'One commission line with its history' })
  one(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.commission.one(actor, id);
  }

  @Post(':id/approve')
  @HttpCode(200)
  @Authenticated()
  @ApiOperation({ summary: "Approve (the Director; the Director's own line: the Owner only, with step-up and a reason)" })
  approve(@CurrentActor() actor: Actor, @CurrentSessionId() sessionId: string | null, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: ApproveDto, @ClientInfo() client: RequestInfo) {
    return this.commission.approve(actor, sessionId, id, body, client);
  }

  @Post(':id/reject')
  @HttpCode(200)
  @Authenticated()
  @ApiOperation({ summary: "Reject, with a reason (normal lines: the Director or the Finance duty; the Director's own: the Owner with step-up)" })
  reject(@CurrentActor() actor: Actor, @CurrentSessionId() sessionId: string | null, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: DecideDto, @ClientInfo() client: RequestInfo) {
    return this.commission.reject(actor, sessionId, id, body, client);
  }

  @Post(':id/hold')
  @HttpCode(200)
  @Authenticated()
  @ApiOperation({ summary: 'Put a normal line on hold, with a reason (the Director or the Finance duty)' })
  hold(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: DecideDto, @ClientInfo() client: RequestInfo) {
    return this.commission.hold(actor, id, body, client);
  }

  @Post(':id/leaver-decision')
  @HttpCode(200)
  @Authenticated()
  @ApiOperation({ summary: 'The final-settlement decision on a line held because the earner left (the Owner, step-up, reason)' })
  leaverDecision(@CurrentActor() actor: Actor, @CurrentSessionId() sessionId: string | null, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: LeaverDecisionDto, @ClientInfo() client: RequestInfo) {
    return this.commission.leaverDecision(actor, sessionId, id, body, client);
  }
}
