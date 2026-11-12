import { Body, Controller, Delete, Get, Param, Patch, Post } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  assignDutyRequestSchema,
  createDepartmentRequestSchema,
  createOfficeRequestSchema,
  deactivateRequestSchema,
  updateDepartmentRequestSchema,
  updateOfficeRequestSchema,
  changeLevelRequestSchema,
  changeReportingLineRequestSchema,
  endDutyRequestSchema,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { Authenticated, ClientInfo, CurrentActor, RequestInfo, RequirePermission, Scope } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { OrgService } from './org.service';
import { StructureService } from './structure.service';

class ChangeLevelDto extends createZodDto(changeLevelRequestSchema) {}
class ChangeReportingLineDto extends createZodDto(changeReportingLineRequestSchema) {}
class AssignDutyDto extends createZodDto(assignDutyRequestSchema) {}
class EndDutyDto extends createZodDto(endDutyRequestSchema) {}
class CreateDepartmentDto extends createZodDto(createDepartmentRequestSchema) {}
class UpdateDepartmentDto extends createZodDto(updateDepartmentRequestSchema) {}
class CreateOfficeDto extends createZodDto(createOfficeRequestSchema) {}
class UpdateOfficeDto extends createZodDto(updateOfficeRequestSchema) {}
class DeactivateDto extends createZodDto(deactivateRequestSchema) {}

@ApiTags('org')
@Controller('org')
export class OrgController {
  constructor(
    private readonly org: OrgService,
    private readonly structure: StructureService,
  ) {}

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

  @Post('departments')
  @RequirePermission('org.manage')
  @ApiOperation({ summary: 'Add a department with its head (Owner or CEO). A reason is required.' })
  createDepartment(@CurrentActor() actor: Actor, @Body() body: CreateDepartmentDto, @ClientInfo() client: RequestInfo) {
    return this.structure.createDepartment(actor, body, client);
  }

  @Patch('departments/:code')
  @RequirePermission('org.manage')
  @ApiOperation({ summary: 'Rename a department or change its head (Owner or CEO). Head changes are audited.' })
  updateDepartment(@CurrentActor() actor: Actor, @Param('code') code: string, @Body() body: UpdateDepartmentDto, @ClientInfo() client: RequestInfo) {
    return this.structure.updateDepartment(actor, code, body, client);
  }

  @Post('departments/:code/deactivate')
  @RequirePermission('org.manage')
  @ApiOperation({ summary: 'Deactivate (archive) a department with nobody in it. Nothing is deleted.' })
  deactivateDepartment(@CurrentActor() actor: Actor, @Param('code') code: string, @Body() body: DeactivateDto, @ClientInfo() client: RequestInfo) {
    return this.structure.deactivateDepartment(actor, code, body.reason, client);
  }

  @Post('offices')
  @RequirePermission('org.manage')
  @ApiOperation({ summary: 'Add an office (Owner or CEO)' })
  createOffice(@CurrentActor() actor: Actor, @Body() body: CreateOfficeDto, @ClientInfo() client: RequestInfo) {
    return this.structure.createOffice(actor, body, client);
  }

  @Patch('offices/:code')
  @RequirePermission('org.manage')
  @ApiOperation({ summary: 'Rename an office or change its city (Owner or CEO)' })
  updateOffice(@CurrentActor() actor: Actor, @Param('code') code: string, @Body() body: UpdateOfficeDto, @ClientInfo() client: RequestInfo) {
    return this.structure.updateOffice(actor, code, body, client);
  }

  @Post('offices/:code/deactivate')
  @RequirePermission('org.manage')
  @ApiOperation({ summary: 'Deactivate (archive) an office with nobody in it' })
  deactivateOffice(@CurrentActor() actor: Actor, @Param('code') code: string, @Body() body: DeactivateDto, @ClientInfo() client: RequestInfo) {
    return this.structure.deactivateOffice(actor, code, body.reason, client);
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
