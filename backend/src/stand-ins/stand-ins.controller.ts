import { Body, Controller, Delete, Get, Param, ParseUUIDPipe, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { createStandInRequestSchema, revokeStandInRequestSchema } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { Authenticated, ClientInfo, CurrentActor, RequestInfo, RequirePermission } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { StandInsService } from './stand-ins.service';

class CreateStandInDto extends createZodDto(createStandInRequestSchema) {}
class RevokeStandInDto extends createZodDto(revokeStandInRequestSchema) {}

@ApiTags('stand-ins')
@Controller('stand-ins')
export class StandInsController {
  constructor(private readonly standIns: StandInsService) {}

  @Post()
  @RequirePermission('standin.manage')
  @ApiOperation({ summary: 'I am away for set dates: name a stand-in (or none, so approvals go one level up)' })
  create(@CurrentActor() actor: Actor, @Body() body: CreateStandInDto, @ClientInfo() client: RequestInfo) {
    return this.standIns.create(actor, body, client);
  }

  @Get()
  @Authenticated()
  @ApiOperation({ summary: 'Away periods of people in my reporting line, and the ones where I am the stand-in' })
  list(@CurrentActor() actor: Actor) {
    return this.standIns.list(actor);
  }

  @Delete(':id')
  @RequirePermission('standin.manage')
  @ApiOperation({ summary: 'End an away period early (the manager, or Owner/CEO for people below them)' })
  revoke(
    @CurrentActor() actor: Actor,
    @Param('id', new ParseUUIDPipe()) id: string,
    @Body() body: RevokeStandInDto,
    @ClientInfo() client: RequestInfo,
  ) {
    return this.standIns.revoke(actor, id, body, client);
  }
}
