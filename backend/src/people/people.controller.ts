import { Body, Controller, Get, HttpCode, Param, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  directoryQuerySchema,
  revealRequestSchema,
  updateBasicRequestSchema,
  updateJobRequestSchema,
  updatePayRequestSchema,
  updatePersonalRequestSchema,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { Authenticated, ClientInfo, CurrentActor, RequestInfo, RequirePermission } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { PeopleService } from './people.service';

class DirectoryQueryDto extends createZodDto(directoryQuerySchema) {}
class UpdateBasicDto extends createZodDto(updateBasicRequestSchema) {}
class UpdateJobDto extends createZodDto(updateJobRequestSchema) {}
class UpdatePersonalDto extends createZodDto(updatePersonalRequestSchema) {}
class UpdatePayDto extends createZodDto(updatePayRequestSchema) {}
class RevealDto extends createZodDto(revealRequestSchema) {}

@ApiTags('employees')
@Controller('employees')
export class PeopleController {
  constructor(private readonly people: PeopleService) {}

  @Get()
  @RequirePermission('people.view_directory')
  @ApiOperation({ summary: 'The staff directory: basic information about everyone still with the company' })
  directory(@Query() query: DirectoryQueryDto) {
    return this.people.directory(query.q);
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
  updatePay(@CurrentActor() actor: Actor, @Param('empId') empId: string, @Body() body: UpdatePayDto, @ClientInfo() client: RequestInfo) {
    return this.people.updatePay(actor, empId, body, client);
  }

  @Post(':empId/reveal')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'Show a masked CNIC or bank account number. Every reveal is logged.' })
  reveal(@CurrentActor() actor: Actor, @Param('empId') empId: string, @Body() body: RevealDto, @ClientInfo() client: RequestInfo) {
    return this.people.reveal(actor, empId, body.field, client);
  }
}
