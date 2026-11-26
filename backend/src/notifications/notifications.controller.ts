import { Body, Controller, Get, HttpCode, Patch, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import { markNotificationsReadSchema, notificationListQuerySchema, notificationPrefsSchema } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { Authenticated, ClientInfo, CurrentActor, RequestInfo } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { NotificationService } from './notification.service';

class ListQueryDto extends createZodDto(notificationListQuerySchema) {}
class MarkReadDto extends createZodDto(markNotificationsReadSchema) {}
class PrefsDto extends createZodDto(notificationPrefsSchema) {}

/** Notifications (minimal Module 12 core). Everyone logged in; each person reaches only their own. */
@ApiTags('notifications')
@Controller('notifications')
export class NotificationsController {
  constructor(private readonly notifications: NotificationService) {}

  @Get()
  @Authenticated()
  @ApiOperation({ summary: 'My notifications, newest first (the latest 100). ?unread=true for unread only' })
  list(@CurrentActor() actor: Actor, @Query() q: ListQueryDto) {
    return this.notifications.list(actor, q.unread === 'true');
  }

  @Post('read')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'Mark some of my notifications read ({ ids }), or all of them (no ids)' })
  markRead(@CurrentActor() actor: Actor, @Body() body: MarkReadDto) {
    return this.notifications.markRead(actor, body);
  }

  @Get('prefs')
  @Authenticated()
  @ApiOperation({ summary: 'My email choices. Approvals and security alerts are always emailed' })
  prefs(@CurrentActor() actor: Actor) {
    return this.notifications.prefs(actor);
  }

  @Patch('prefs')
  @Authenticated()
  @ApiOperation({ summary: 'Turn emails of non-essential types on or off (essential types: 400 essential_notification)' })
  savePrefs(@CurrentActor() actor: Actor, @Body() body: PrefsDto, @ClientInfo() client: RequestInfo) {
    return this.notifications.savePrefs(actor, body, client);
  }
}
