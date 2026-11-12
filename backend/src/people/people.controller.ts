import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  approveHireRequestSchema,
  createEmployeeRequestSchema,
  rejectHireRequestSchema,
  directoryQuerySchema,
  offboardRequestSchema,
  reasonSchema,
  revealRequestSchema,
  updateBasicRequestSchema,
  updateJobRequestSchema,
  updatePayRequestSchema,
  updatePersonalRequestSchema,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { Authenticated, ClientInfo, CurrentActor, CurrentSessionId, RequestInfo, RequirePermission } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { z } from 'zod';
import { JoiningService } from './joining.service';
import { OffboardingService } from './offboarding.service';
import { PeopleService } from './people.service';

class DirectoryQueryDto extends createZodDto(directoryQuerySchema) {}
class UpdateBasicDto extends createZodDto(updateBasicRequestSchema) {}
class UpdateJobDto extends createZodDto(updateJobRequestSchema) {}
class UpdatePersonalDto extends createZodDto(updatePersonalRequestSchema) {}
class UpdatePayDto extends createZodDto(updatePayRequestSchema) {}
class RevealDto extends createZodDto(revealRequestSchema) {}
class OffboardDto extends createZodDto(offboardRequestSchema) {}
class CancelOffboardDto extends createZodDto(z.object({ reason: reasonSchema })) {}
class ApproveHireDto extends createZodDto(approveHireRequestSchema) {}
class RejectHireDto extends createZodDto(rejectHireRequestSchema) {}
class CreateEmployeeDto extends createZodDto(createEmployeeRequestSchema) {}

@ApiTags('hire-requests')
@Controller('hire-requests')
export class HireRequestsController {
  constructor(private readonly joining: JoiningService) {}

  @Get()
  @Authenticated()
  @ApiOperation({ summary: 'Hire requests (Owner, CEO, Director, HR). ?status=pending|approved|rejected' })
  list(@CurrentActor() actor: Actor, @Query('status') status?: string) {
    return this.joining.list(actor, status);
  }

  @Post(':id/approve')
  @RequirePermission('org.manage')
  @HttpCode(200)
  @ApiOperation({ summary: 'Owner or CEO authorize the level and reporting line (they may correct them); the employee is created now' })
  approve(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: ApproveHireDto, @ClientInfo() client: RequestInfo) {
    return this.joining.approve(actor, id, body, client);
  }

  @Post(':id/reject')
  @RequirePermission('org.manage')
  @HttpCode(200)
  @ApiOperation({ summary: 'Owner or CEO reject a hire request' })
  reject(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: RejectHireDto, @ClientInfo() client: RequestInfo) {
    return this.joining.reject(actor, id, body.reason, client);
  }
}

@ApiTags('employees')
@Controller('employees')
export class PeopleController {
  constructor(
    private readonly people: PeopleService,
    private readonly joining: JoiningService,
    private readonly offboarding: OffboardingService,
  ) {}

  @Get()
  @RequirePermission('people.view_directory')
  @ApiOperation({ summary: 'The staff directory: basic information about everyone still with the company' })
  directory(@Query() query: DirectoryQueryDto) {
    return this.people.directory(query.q);
  }

  @Get('unresolved-reports')
  @Authenticated()
  @ApiOperation({ summary: 'People who still report to someone who left (the Owner or CEO assign a new manager)' })
  unresolvedReports(@CurrentActor() actor: Actor) {
    return this.people.unresolvedReports(actor);
  }

  @Post()
  @Authenticated()
  @ApiOperation({ summary: 'Joining workflow. Director/HR start a hire (Level 4-5) that waits for the Owner or CEO; Owner/CEO create at once. On creation the Emp-ID is generated and a welcome email with a temporary password is sent.' })
  create(@CurrentActor() actor: Actor, @Body() body: CreateEmployeeDto, @ClientInfo() client: RequestInfo) {
    return this.joining.create(actor, body, client);
  }

  @Post(':empId/resend-welcome')
  @RequirePermission('people.manage')
  @HttpCode(200)
  @ApiOperation({ summary: 'Send the welcome email again with a new temporary password (only before the first login)' })
  resendWelcome(@CurrentActor() actor: Actor, @Param('empId') empId: string, @ClientInfo() client: RequestInfo) {
    return this.joining.resendWelcome(actor, empId, client);
  }

  @Post(':empId/offboard')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'Leaving workflow: set (or move) the last working day (HR or Director). Today or earlier is processed now.' })
  offboard(@CurrentActor() actor: Actor, @Param('empId') empId: string, @Body() body: OffboardDto, @ClientInfo() client: RequestInfo) {
    return this.offboarding.offboard(actor, empId, body, client);
  }

  @Delete(':empId/offboard')
  @Authenticated()
  @ApiOperation({ summary: 'Cancel a leaving date that has not been processed yet' })
  cancelOffboard(@CurrentActor() actor: Actor, @Param('empId') empId: string, @Body() body: CancelOffboardDto, @ClientInfo() client: RequestInfo) {
    return this.offboarding.cancel(actor, empId, body.reason, client);
  }

  @Get(':empId')
  @Authenticated()
  @ApiOperation({ summary: 'One profile: only the sections I am allowed to see, and what I may change' })
  profile(@CurrentActor() actor: Actor, @Param('empId') empId: string) {
    return this.people.profile(actor, empId);
  }

  @Patch(':empId/basic')
  @Authenticated()
  @ApiOperation({ summary: 'Change name, designation, department, office or official email (Director or HR)' })
  updateBasic(@CurrentActor() actor: Actor, @Param('empId') empId: string, @Body() body: UpdateBasicDto, @ClientInfo() client: RequestInfo) {
    return this.people.updateBasic(actor, empId, body, client);
  }

  @Patch(':empId/job')
  @Authenticated()
  @ApiOperation({ summary: 'Change joining date, type or capacity (Director or HR). Levels and reporting lines: Owner or CEO only.' })
  updateJob(@CurrentActor() actor: Actor, @Param('empId') empId: string, @Body() body: UpdateJobDto, @ClientInfo() client: RequestInfo) {
    return this.people.updateJob(actor, empId, body, client);
  }

  @Patch(':empId/personal')
  @Authenticated()
  @ApiOperation({ summary: 'Change personal details: the employee (phone, address, emergency contact) or Director/HR (also CNIC)' })
  updatePersonal(@CurrentActor() actor: Actor, @Param('empId') empId: string, @Body() body: UpdatePersonalDto, @ClientInfo() client: RequestInfo) {
    return this.people.updatePersonal(actor, empId, body, client);
  }

  @Patch(':empId/pay')
  @Authenticated()
  @ApiOperation({ summary: 'Change pay information (the Director only, never their own)' })
  updatePay(@CurrentActor() actor: Actor, @CurrentSessionId() sessionId: string | null, @Param('empId') empId: string, @Body() body: UpdatePayDto, @ClientInfo() client: RequestInfo) {
    return this.people.updatePay(actor, empId, body, client, sessionId);
  }

  @Post(':empId/reveal')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'Show a masked CNIC or bank account number. Every reveal is logged.' })
  reveal(@CurrentActor() actor: Actor, @CurrentSessionId() sessionId: string | null, @Param('empId') empId: string, @Body() body: RevealDto, @ClientInfo() client: RequestInfo) {
    return this.people.reveal(actor, empId, body.field, client, sessionId);
  }
}
