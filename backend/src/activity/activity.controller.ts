import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query, Req } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request } from 'express';
import {
  activityEventsQuerySchema,
  alertsQuerySchema,
  checkAlertRequestSchema,
  controlReasonRequestSchema,
  exportLogRequestSchema,
  heartbeatRequestSchema,
  screenViewRequestSchema,
  summariesQuerySchema,
  timelineQuerySchema,
  unlockAccountRequestSchema,
} from '@aceva/contracts';
import type { Actor, ScopeTarget } from '../access/access.types';
import { Authenticated, ClientInfo, CountsAsActivityWhen, CurrentActor, CurrentSessionId, RequestInfo, RequirePermission, Scope, ScopedTarget } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { NotRecorded } from './activity.decorators';
import { ActivityAlertsService } from './activity-alerts.service';
import { ActivityControlsService } from './activity-controls.service';
import { ActivityService } from './activity.service';

class HeartbeatDto extends createZodDto(heartbeatRequestSchema) {}
class ScreenViewDto extends createZodDto(screenViewRequestSchema) {}
class EventsQueryDto extends createZodDto(activityEventsQuerySchema) {}
class SummariesQueryDto extends createZodDto(summariesQuerySchema) {}
class TimelineQueryDto extends createZodDto(timelineQuerySchema) {}
class AlertsQueryDto extends createZodDto(alertsQuerySchema) {}
class CheckAlertDto extends createZodDto(checkAlertRequestSchema) {}
class ExportLogDto extends createZodDto(exportLogRequestSchema) {}
class ControlReasonDto extends createZodDto(controlReasonRequestSchema) {}
class UnlockDto extends createZodDto(unlockAccountRequestSchema) {}

/** Only a minute with mouse or keyboard use keeps the session alive; an open but unused tab still times out. */
const usedThisMinute = (request: Request) => (request.body as { active?: unknown } | undefined)?.active === true;
/** Screens that refresh themselves (polling) must not keep an unused session alive. */
const never = () => false;

const signalInfo = (request: Request) => ({ ip: request.ip ?? null, requestId: request.requestId ?? null });

/** Module 4: employee activity tracking (plan section 8, spec section 9.4). Tracking data is never edited or deleted. */
@ApiTags('activity')
@Controller('activity')
export class ActivityController {
  constructor(
    private readonly activity: ActivityService,
    private readonly alerts: ActivityAlertsService,
  ) {}

  // ----------------------------------------------------------------- signals from the browser

  @Post('heartbeat')
  @Authenticated()
  @NotRecorded()
  @CountsAsActivityWhen(usedThisMinute)
  @HttpCode(200)
  @ApiOperation({ summary: '"Still here", every 60 seconds while the app is open: only whether the mouse or keyboard was used that minute. Nothing else is sent.' })
  heartbeat(@CurrentActor() actor: Actor, @CurrentSessionId() sessionId: string | null, @Body() body: HeartbeatDto) {
    return this.activity.heartbeat(actor, sessionId, body.active);
  }

  @Post('screen')
  @Authenticated()
  @NotRecorded()
  @HttpCode(200)
  @ApiOperation({ summary: 'A screen was opened (its label and page path). A finance screen opened without permission is recorded as a blocked attempt.' })
  screen(@CurrentActor() actor: Actor, @CurrentSessionId() sessionId: string | null, @Body() body: ScreenViewDto, @Req() request: Request) {
    return this.activity.screen(actor, sessionId, body, signalInfo(request));
  }

  @Post('export')
  @Authenticated()
  @NotRecorded()
  @HttpCode(200)
  @ApiOperation({ summary: 'Record an export the screen made (Excel/PDF): rows, format, module. Large exports of finance or employee data raise an alert (one per person, kind of data and hour). At most 10 a minute per session and 20 per person are recorded; more answer recorded: false.' })
  logExport(@CurrentActor() actor: Actor, @CurrentSessionId() sessionId: string | null, @Body() body: ExportLogDto, @Req() request: Request) {
    return this.activity.logExport(actor, sessionId, body, signalInfo(request));
  }

  // ----------------------------------------------------------------- reading

  @Get('online')
  @RequirePermission('activity.view_all')
  @CountsAsActivityWhen(never)
  @ApiOperation({ summary: 'Who is signed in now, below me in my reporting line: since when, current screen, active or idle, device, city' })
  online(@CurrentActor() actor: Actor) {
    return this.activity.online(actor);
  }

  @Get('events')
  @RequirePermission('activity.view_own')
  @ApiOperation({ summary: 'Activity search (?empId&departmentId&module&action&source&from&to). The Director and the CEO / Founder / Owner search their reporting line; everyone else gets their own records. Changes show old and new values from the audit log.' })
  events(@CurrentActor() actor: Actor, @Query() query: EventsQueryDto) {
    return this.activity.events(actor, query);
  }

  @Get('summaries')
  @Authenticated()
  @ApiOperation({ summary: 'Daily summaries (?from&to, at most 31 days) of the people below me: first login, last logout, active and idle minutes, actions' })
  summaries(@CurrentActor() actor: Actor, @Query() query: SummariesQueryDto, @ClientInfo() client: RequestInfo) {
    return this.activity.dailySummaries(actor, query.from, query.to, client);
  }

  @Get('timeline')
  @Authenticated()
  @ApiOperation({ summary: 'One person, one day, in order (?empId&date): my own, or someone below me. Without activity.view_all only the day summary.' })
  timeline(@CurrentActor() actor: Actor, @Query() query: TimelineQueryDto, @ClientInfo() client: RequestInfo) {
    return this.activity.timeline(actor, query.empId, query.date, client);
  }

  @Get('me')
  @Authenticated()
  @CountsAsActivityWhen(never)
  @ApiOperation({ summary: 'My activity: today so far, my records of the last 14 days, the screens and signals of this session' })
  mine(@CurrentActor() actor: Actor, @CurrentSessionId() sessionId: string | null) {
    return this.activity.mine(actor, sessionId);
  }

  // ----------------------------------------------------------------- security alerts

  @Get('alerts')
  @RequirePermission('activity.security')
  @ApiOperation({ summary: 'Security alerts (?status=open|checked|all), newest first: every open alert plus the newest 500 checked ones. The Director, the CTO and the CEO / Founder / Owner' })
  listAlerts(@Query() query: AlertsQueryDto) {
    return this.alerts.list(query.status ?? 'all');
  }

  @Post('alerts/:id/check')
  @RequirePermission('activity.security', 'session.force_logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark an alert as checked with a note. Never an alert about yourself; a manager above the person checks it. Once only.' })
  checkAlert(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: CheckAlertDto, @ClientInfo() client: RequestInfo) {
    return this.alerts.check(actor, id, body.note, client);
  }
}

/** Module 4 controls on sessions and accounts (they reuse Module 2's session and lock code). */
@ApiTags('activity')
@Controller()
export class ActivityControlsController {
  constructor(
    private readonly controls: ActivityControlsService,
    private readonly activity: ActivityService,
  ) {}

  @Post('sessions/:id/force-logout')
  @RequirePermission('session.force_logout')
  @HttpCode(200)
  @ApiOperation({ summary: 'End one session of someone below me now (reason required, confirm-again first). The Director and the CTO.' })
  forceLogout(@CurrentActor() actor: Actor, @CurrentSessionId() sessionId: string | null, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: ControlReasonDto, @ClientInfo() client: RequestInfo) {
    return this.controls.forceLogout(actor, sessionId, id, body.reason, client);
  }

  @Post('employees/:empId/lock')
  @RequirePermission('session.force_logout', 'auth.unlock_account')
  @Scope('empId', 'below')
  @HttpCode(200)
  @ApiOperation({ summary: 'Lock the account of someone below me: every session ends and they cannot sign in until unlocked (reason required, confirm-again first)' })
  lock(@CurrentActor() actor: Actor, @CurrentSessionId() sessionId: string | null, @ScopedTarget() target: ScopeTarget, @Body() body: ControlReasonDto, @ClientInfo() client: RequestInfo) {
    return this.controls.lock(actor, sessionId, target, body.reason, client);
  }

  @Post('employees/:empId/unlock')
  @RequirePermission('auth.unlock_account')
  @HttpCode(200)
  @ApiOperation({ summary: "Unlock a locked account (confirm-again first). Module 2's rule: someone above them in the line, HR duty, or the CEO / Founder / Owner for his direct report only" })
  unlock(@CurrentActor() actor: Actor, @CurrentSessionId() sessionId: string | null, @Param('empId') empId: string, @Body() body: UnlockDto, @ClientInfo() client: RequestInfo) {
    return this.controls.unlock(actor, sessionId, empId, body.reason, client);
  }

  @Get('accounts/locked')
  @Authenticated()
  @ApiOperation({ summary: 'Locked accounts: my own line (me and below), or all of them with activity.security' })
  locks(@CurrentActor() actor: Actor) {
    return this.activity.locks(actor);
  }
}
