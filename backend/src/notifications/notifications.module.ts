import { Module } from '@nestjs/common';
import { notificationSettingsSchema, type NotificationSettings } from '@aceva/contracts';
import { ModuleSettingsService } from '../settings/module-settings.service';
import { NotificationDeliveryService } from './notification-delivery.service';
import { NotificationEventsConsumer } from './notification-events.consumer';
import { NotificationService } from './notification.service';
import { NotificationsController } from './notifications.controller';

export const NOTIFICATION_SETTINGS_DEFAULTS: NotificationSettings = { emailEnabled: true };

/**
 * Minimal Module 12 notification core (Cycle 3 shared foundation): in-app notifications, each person's email choices,
 * email delivery with retries, and the outbox reader that turns existing events into notifications.
 * Exports NotificationService so Modules 13 to 15 can notify people from their own transactions.
 */
@Module({
  controllers: [NotificationsController],
  providers: [NotificationService, NotificationDeliveryService, NotificationEventsConsumer],
  exports: [NotificationService],
})
export class NotificationsModule {
  constructor(settings: ModuleSettingsService) {
    settings.register({ module: 'notifications', schema: notificationSettingsSchema, defaults: NOTIFICATION_SETTINGS_DEFAULTS, managePermission: 'settings.manage' });
  }
}
