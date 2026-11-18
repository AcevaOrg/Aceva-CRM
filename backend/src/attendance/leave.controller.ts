import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  approveSchema, archiveSchema, attendanceMonthQuerySchema, cancelSchema, leavePreviewQuerySchema, leaveRequestListQuerySchema, leaveRequestSchema,
  leaveTypeRequestSchema, leaveTypeUpdateSchema, rejectSchema, yearQuerySchema,
} from '@aceva/contracts';
import { z } from 'zod';
import type { Actor, ScopeTarget } from '../access/access.types';
import { Authenticated, ClientInfo, CurrentActor, RequestInfo, RequirePermission, Scope, ScopedTarget } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { AttendanceSettingsService } from './attendance-settings.service';
import { LeaveService } from './leave.service';

class LeaveListDto extends createZodDto(leaveRequestListQuerySchema) {}
class LeaveDto extends createZodDto(leaveRequestSchema) {}
class PreviewDto extends createZodDto(leavePreviewQuerySchema) {}
class ApproveDto extends createZodDto(approveSchema) {}
class RejectDto extends createZodDto(rejectSchema) {}
class CancelDto extends createZodDto(cancelSchema) {}
class MonthQueryDto extends createZodDto(attendanceMonthQuerySchema) {}
class YearQueryDto extends createZodDto(yearQuerySchema) {}
class TypesQueryDto extends createZodDto(z.object({ includeArchived: z.enum(['true', 'false']).optional() })) {}
class LeaveTypeDto extends createZodDto(leaveTypeRequestSchema) {}
class LeaveTypeUpdateDto extends createZodDto(leaveTypeUpdateSchema) {}
class ArchiveDto extends createZodDto(archiveSchema) {}

@ApiTags('leave')
@Controller('leave')
export class LeaveController {
  constructor(
    private readonly leave: LeaveService,
    private readonly settings: AttendanceSettingsService,
  ) {}

  @Get('types')
  @Authenticated()
  @ApiOperation({ summary: 'Leave types in use (?includeArchived=true for the settings screen)' })
  types(@Query() query: TypesQueryDto) {
    return this.leave.types(query.includeArchived === 'true');
  }

  @Post('types')
  @RequirePermission('settings.manage')
  createType(@CurrentActor() actor: Actor, @Body() body: LeaveTypeDto, @ClientInfo() client: RequestInfo) {
    return this.settings.createLeaveType(actor, body, client);
  }

  @Patch('types/:id')
  @RequirePermission('settings.manage')
  updateType(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: LeaveTypeUpdateDto, @ClientInfo() client: RequestInfo) {
    return this.settings.updateLeaveType(actor, id, body, client);
  }

  @Post('types/:id/archive')
  @RequirePermission('settings.manage')
  @HttpCode(200)
  archiveType(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: ArchiveDto, @ClientInfo() client: RequestInfo) {
    return this.settings.archiveLeaveType(actor, id, body.reason, client);
  }

  @Get('balances/:empId')
  @RequirePermission('leave.request')
  @Scope('empId', 'self_or_below')
  @ApiOperation({ summary: 'Leave balances for a year: your own, or someone below you' })
  balances(@ScopedTarget() target: ScopeTarget, @Query() query: YearQueryDto) {
    return this.leave.balances(target, query.year);
  }

  @Get('preview')
  @RequirePermission('leave.request')
  @ApiOperation({ summary: 'Days a request would count (weekends and holidays excluded) and the balance left after it' })
  preview(@CurrentActor() actor: Actor, @Query() query: PreviewDto) {
    return this.leave.preview(actor, { leaveTypeId: query.leaveTypeId, from: query.from, to: query.to, halfDay: query.halfDay === 'true' });
  }

  @Get('calendar')
  @RequirePermission('leave.request')
  @ApiOperation({ summary: 'Leave in a month (waiting and approved) for you and everyone below you' })
  calendar(@CurrentActor() actor: Actor, @Query() query: MonthQueryDto) {
    return this.leave.calendarMonth(actor, query.month);
  }

  @Get('requests')
  @RequirePermission('leave.request')
  @ApiOperation({ summary: 'Leave requests: ?scope=mine (default) or team (people below you, and what is routed to you)' })
  list(@CurrentActor() actor: Actor, @Query() query: LeaveListDto) {
    return this.leave.list(actor, query);
  }

  @Get('requests/:id')
  @RequirePermission('leave.request')
  one(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string) {
    return this.leave.one(actor, id);
  }

  @Post('requests')
  @RequirePermission('leave.request')
  request(@CurrentActor() actor: Actor, @Body() body: LeaveDto, @ClientInfo() client: RequestInfo) {
    return this.leave.create(actor, body, client);
  }

  @Post('requests/:id/approve')
  @RequirePermission('leave.approve')
  @HttpCode(200)
  approve(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: ApproveDto, @ClientInfo() client: RequestInfo) {
    return this.leave.approve(actor, id, body.note, client);
  }

  @Post('requests/:id/reject')
  @RequirePermission('leave.approve')
  @HttpCode(200)
  reject(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: RejectDto, @ClientInfo() client: RequestInfo) {
    return this.leave.reject(actor, id, body.reason, client);
  }

  @Post('requests/:id/cancel')
  @RequirePermission('leave.request')
  @HttpCode(200)
  cancel(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: CancelDto, @ClientInfo() client: RequestInfo) {
    return this.leave.cancel(actor, id, body.reason, client);
  }
}
