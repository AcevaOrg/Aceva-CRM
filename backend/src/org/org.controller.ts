import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  assignDutyRequestSchema,
  changeLevelRequestSchema,
  changeReportingLineRequestSchema,
  endDutyRequestSchema,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { Authenticated, ClientInfo, CurrentActor, RequestInfo, RequirePermission, Scope } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { OrgService } from './org.service';

class ChangeLevelDto extends createZodDto(changeLevelRequestSchema) {}
class ChangeReportingLineDto extends createZodDto(changeReportingLineRequestSchema) {}
class AssignDutyDto extends createZodDto(assignDutyRequestSchema) {}
class EndDutyDto extends createZodDto(endDutyRequestSchema) {}

@ApiTags('org')
@Controller('org')
export class OrgController {
  constructor(private readonly org: OrgService) {}

  @Get('tree')
  @RequirePermission('org.view')
  @ApiOperation({ summary: 'The organisation chart as a tree (reporting relationships)' })
  tree() {
    return this.org.tree();
  }

  @Get('departments')
  @RequirePermission('org.view')
  @ApiOperation({ summary: 'Departments and offices with headcount' })
  departments() {
    return this.org.departments();
  }

  @Get('changes')
  @RequirePermission('audit.view')
  @ApiOperation({ summary: 'Recent access changes (levels, reporting lines, duties, stand-ins) from the audit log' })
  changes() {
    return this.org.recentChanges();
  }

  @Get('team')
  @Authenticated()
  @ApiOperation({ summary: 'My own record and everyone below me (scope applied in the database)' })
  team(@CurrentActor() actor: Actor) {
    return this.org.team(actor);
  }

  @Get('team/:empId')
  @Authenticated()
  @Scope('empId', 'self_or_below')
  @ApiOperation({ summary: 'One person in my scope. Out-of-scope people are refused (403) and the attempt is logged.' })
  teamMember(@CurrentActor() actor: Actor, @Param('empId') empId: string) {
    return this.org.teamMember(actor, empId);
  }

  @Patch('employees/:empId/level')
  @RequirePermission('org.manage')
  @Scope('empId', 'below')
  @ApiOperation({ summary: 'Change an employee level (Owner or CEO only). A reason is required.' })
  changeLevel(
    @CurrentActor() actor: Actor,
    @Param('empId') empId: string,
    @Body() body: ChangeLevelDto,
    @ClientInfo() client: RequestInfo,
  ) {
    return this.org.changeLevel(actor, empId, body, client);
  }

  @Patch('employees/:empId/reporting-line')
  @RequirePermission('org.manage')
  @Scope('empId', 'below')
  @ApiOperation({ summary: 'Change who an employee reports to (Owner or CEO only). Validated before saving.' })
  changeReportingLine(
    @CurrentActor() actor: Actor,
    @Param('empId') empId: string,
    @Body() body: ChangeReportingLineDto,
    @ClientInfo() client: RequestInfo,
  ) {
    return this.org.changeReportingLine(actor, empId, body, client);
  }

  @Post('employees/:empId/duties')
  @RequirePermission('duty.assign')
  @Scope('empId', 'below')
  @ApiOperation({ summary: 'Give an employee an extra duty such as Finance or HR (Director)' })
  assignDuty(
    @CurrentActor() actor: Actor,
    @Param('empId') empId: string,
    @Body() body: AssignDutyDto,
    @ClientInfo() client: RequestInfo,
  ) {
    return this.org.assignDuty(actor, empId, body, client);
  }

  @Delete('employees/:empId/duties/:dutyKey')
  @RequirePermission('duty.assign')
  @Scope('empId', 'below')
  @ApiOperation({ summary: 'End an extra duty (Director). The duty record is kept as history.' })
  endDuty(
    @CurrentActor() actor: Actor,
    @Param('empId') empId: string,
    @Param('dutyKey') dutyKey: string,
    @Body() body: EndDutyDto,
    @ClientInfo() client: RequestInfo,
  ) {
    return this.org.endDuty(actor, empId, dutyKey, body, client);
  }
}
