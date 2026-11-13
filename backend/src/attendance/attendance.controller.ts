import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  approveSchema, archiveSchema, attendanceDayQuerySchema, attendanceMonthQuerySchema, correctionListQuerySchema, correctionRequestSchema,
  entitlementQuerySchema, entitlementRequestSchema, holidayRenameSchema, holidayRequestSchema, holidaysQuerySchema, officeNetworkRequestSchema,
  rejectSchema, workScheduleRequestSchema,
} from '@aceva/contracts';
import type { Actor, ScopeTarget } from '../access/access.types';
import { Authenticated, ClientInfo, CurrentActor, RequestInfo, RequirePermission, Scope, ScopedTarget } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { AttendanceSettingsService } from './attendance-settings.service';
import { AttendanceService } from './attendance.service';
import { CorrectionsService } from './corrections.service';

class MonthQueryDto extends createZodDto(attendanceMonthQuerySchema) {}
class DayQueryDto extends createZodDto(attendanceDayQuerySchema) {}
class CorrectionListDto extends createZodDto(correctionListQuerySchema) {}
class CorrectionDto extends createZodDto(correctionRequestSchema) {}
class ApproveDto extends createZodDto(approveSchema) {}
class RejectDto extends createZodDto(rejectSchema) {}
class ScheduleDto extends createZodDto(workScheduleRequestSchema) {}
class HolidaysQueryDto extends createZodDto(holidaysQuerySchema) {}
class HolidayDto extends createZodDto(holidayRequestSchema) {}
class HolidayRenameDto extends createZodDto(holidayRenameSchema) {}
class ArchiveDto extends createZodDto(archiveSchema) {}
class EntitlementQueryDto extends createZodDto(entitlementQuerySchema) {}
class EntitlementDto extends createZodDto(entitlementRequestSchema) {}
class OfficeNetworkDto extends createZodDto(officeNetworkRequestSchema) {}

@ApiTags('attendance')
@Controller('attendance')
export class AttendanceController {
  constructor(
    private readonly attendance: AttendanceService,
    private readonly corrections: CorrectionsService,
  ) {}

  @Get('today')
  @RequirePermission('attendance.self')
  @ApiOperation({ summary: 'My day today: server time, schedule, check-in/out, whether I can check in from this connection' })
  today(@CurrentActor() actor: Actor, @ClientInfo() client: RequestInfo) {
    return this.attendance.todayFor(actor, client);
  }

  @Post('check-in')
  @RequirePermission('attendance.self')
  @HttpCode(200)
  @ApiOperation({ summary: 'Check in now. The time is the server time; any time in the body is ignored' })
  checkIn(@CurrentActor() actor: Actor, @ClientInfo() client: RequestInfo) {
    return this.attendance.checkIn(actor, client);
  }

  @Post('check-out')
  @RequirePermission('attendance.self')
  @HttpCode(200)
  @ApiOperation({ summary: 'Check out now (server time)' })
  checkOut(@CurrentActor() actor: Actor, @ClientInfo() client: RequestInfo) {
    return this.attendance.checkOut(actor, client);
  }

  @Get('me')
  @RequirePermission('attendance.self')
  @ApiOperation({ summary: 'My month: one row per day' })
  myMonth(@CurrentActor() actor: Actor, @Query() query: MonthQueryDto) {
    return this.attendance.month(actor, { id: actor.id, empId: actor.empId }, query.month);
  }

  @Get('employees/:empId')
  @RequirePermission('attendance.self')
  @Scope('empId', 'self_or_below')
  @ApiOperation({ summary: "One person's month: yourself, or someone below you (needs attendance.view_team)" })
  month(@CurrentActor() actor: Actor, @ScopedTarget() target: ScopeTarget, @Query() query: MonthQueryDto) {
    return this.attendance.month(actor, target, query.month);
  }

  @Get('team')
  @RequirePermission('attendance.view_team')
  @ApiOperation({ summary: 'Today (or ?date=) for the people below you: in, late, not in, on leave' })
  team(@CurrentActor() actor: Actor, @Query() query: DayQueryDto) {
    return this.attendance.teamToday(actor, query.date);
  }

  @Get('team/summary')
  @RequirePermission('attendance.view_team')
  @ApiOperation({ summary: 'Month totals for the people below you, with the average gap between check-in and first login' })
  teamSummary(@CurrentActor() actor: Actor, @Query() query: MonthQueryDto) {
    return this.attendance.teamMonth(actor, query.month);
  }

  @Get('corrections')
  @RequirePermission('attendance.self')
  @ApiOperation({ summary: 'Corrections: ?scope=mine (default) or team (people below you, and what is routed to you)' })
  listCorrections(@CurrentActor() actor: Actor, @Query() query: CorrectionListDto) {
    return this.corrections.list(actor, query);
  }

  @Get('corrections/:id')
  @RequirePermission('attendance.self')
  correction(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.corrections.one(actor, id);
  }

  @Post('corrections')
  @RequirePermission('attendance.self')
  @ApiOperation({ summary: 'Ask your manager to fix a day (today or earlier). The original is kept' })
  requestCorrection(@CurrentActor() actor: Actor, @Body() body: CorrectionDto, @ClientInfo() client: RequestInfo) {
    return this.corrections.create(actor, body, client);
  }

  @Post('corrections/:id/approve')
  @RequirePermission('attendance.approve_correction')
  @HttpCode(200)
  approveCorrection(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: ApproveDto, @ClientInfo() client: RequestInfo) {
    return this.corrections.approve(actor, id, body.note, client);
  }

  @Post('corrections/:id/reject')
  @RequirePermission('attendance.approve_correction')
  @HttpCode(200)
  rejectCorrection(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: RejectDto, @ClientInfo() client: RequestInfo) {
    return this.corrections.reject(actor, id, body.reason, client);
  }

  @Post('corrections/:id/cancel')
  @RequirePermission('attendance.self')
  @HttpCode(200)
  cancelCorrection(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @ClientInfo() client: RequestInfo) {
    return this.corrections.cancel(actor, id, client);
  }
}

@ApiTags('holidays')
@Controller('holidays')
export class HolidaysController {
  constructor(private readonly settings: AttendanceSettingsService) {}

  @Get()
  @Authenticated()
  @ApiOperation({ summary: 'The company holiday calendar for a year (?year=, default this year)' })
  list(@Query() query: HolidaysQueryDto) {
    return this.settings.holidays(query.year, query.includeArchived === 'true');
  }

  @Post()
  @RequirePermission('settings.manage')
  add(@CurrentActor() actor: Actor, @Body() body: HolidayDto, @ClientInfo() client: RequestInfo) {
    return this.settings.createHoliday(actor, body, client);
  }

  @Patch(':id')
  @RequirePermission('settings.manage')
  rename(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: HolidayRenameDto, @ClientInfo() client: RequestInfo) {
    return this.settings.renameHoliday(actor, id, body, client);
  }

  @Post(':id/archive')
  @RequirePermission('settings.manage')
  @HttpCode(200)
  @ApiOperation({ summary: 'Holidays are archived, never deleted' })
  archive(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: ArchiveDto, @ClientInfo() client: RequestInfo) {
    return this.settings.archiveHoliday(actor, id, body.reason, client);
  }
}

@ApiTags('settings')
@Controller('settings')
export class AttendanceSettingsController {
  constructor(private readonly settings: AttendanceSettingsService) {}

  @Get('work-schedule')
  @Authenticated()
  @ApiOperation({ summary: 'Working days, hours and grace period: the one in force today, upcoming ones and the history' })
  schedule() {
    return this.settings.workSchedule();
  }

  @Post('work-schedule')
  @RequirePermission('settings.manage')
  @ApiOperation({ summary: 'A new schedule from today or a later day (history is never rewritten)' })
  newSchedule(@CurrentActor() actor: Actor, @Body() body: ScheduleDto, @ClientInfo() client: RequestInfo) {
    return this.settings.createSchedule(actor, body, client);
  }

  @Get('office-networks')
  @RequirePermission('settings.manage')
  networks() {
    return this.settings.officeNetworks();
  }

  @Post('office-networks')
  @RequirePermission('settings.manage')
  addNetwork(@CurrentActor() actor: Actor, @Body() body: OfficeNetworkDto, @ClientInfo() client: RequestInfo) {
    return this.settings.createOfficeNetwork(actor, body, client);
  }

  @Post('office-networks/:id/archive')
  @RequirePermission('settings.manage')
  @HttpCode(200)
  archiveNetwork(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: ArchiveDto, @ClientInfo() client: RequestInfo) {
    return this.settings.archiveOfficeNetwork(actor, id, body.reason, client);
  }

  @Get('leave-entitlements')
  @RequirePermission('settings.manage')
  @ApiOperation({ summary: 'Personal leave allowances of people below you (?year=&empId=)' })
  entitlements(@CurrentActor() actor: Actor, @Query() query: EntitlementQueryDto) {
    return this.settings.entitlements(actor, query.year, query.empId);
  }

  @Post('leave-entitlements')
  @RequirePermission('settings.manage')
  @HttpCode(200)
  @ApiOperation({ summary: "Set a person's yearly allowance for one leave type (people below you only)" })
  setEntitlement(@CurrentActor() actor: Actor, @Body() body: EntitlementDto, @ClientInfo() client: RequestInfo) {
    return this.settings.setEntitlement(actor, body, client);
  }
}
