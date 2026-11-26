import { Module } from '@nestjs/common';
import { commsSettingsSchema, type CommsSettings } from '@aceva/contracts';
import { ModuleSettingsService } from '../settings/module-settings.service';
import { NotificationsModule } from '../notifications/notifications.module';
import { CommsAccessService } from './comms-access.service';
import { CommsNotificationsConsumer } from './comms-notifications.consumer';
import { AnnouncementsController, CommsController, CommsFilesController, ConversationsController, MeetingsController, MessagesController } from './comms.controller';
import { CommsFileService } from './comms-file.service';
import { CommsFileMaintenance } from './comms-file-maintenance.service';
import { CommsAuditService } from './comms-audit.service';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { FILE_STORAGE } from '../storage/file-storage';
import { LocalFileStorage } from '../storage/local-file-storage';
import { ClamdScanner, MALWARE_SCANNER } from '../storage/malware-scanner';
import { MeetingService } from './meeting.service';
import { AnnouncementService } from './announcement.service';
import { ConversationService } from './conversation.service';
import { MessageService } from './message.service';
import { MessageViewBuilder } from './message-views';
import { CommsRealtimeOutboxConsumer } from './realtime/comms-realtime.consumer';
import { CommsRealtimeDelivery } from './realtime/comms-realtime.delivery';
import { CommsRealtimePublisher } from './realtime/comms-realtime.publisher';
import { CommsGateway } from './realtime/comms.gateway';
import { ConnectionRegistry } from './realtime/connection-registry.service';

/**
 * Module 14: internal communication and team collaboration (plan section 19).
 *  - Part 1 (M14.1): conversations and messages over REST, the source of truth for messages and for who may see them.
 *  - Part 2 (M14.2): live delivery over a WebSocket (CommsGateway), relayed between servers through Redis, with presence
 *    and connection limits. REST still makes every change; the socket only delivers what is already saved.
 *  - Later parts: notifications for messages, mentions and replies (CommsNotificationsConsumer, through the shared
 *    Module 12 core), announcements, meetings and files. Uses the shared authentication, permissions, audit log, outbox
 *    and notifications; it has no notification system of its own.
 */
export const COMMS_SETTINGS = 'comms';
/** Nothing decided yet: everything is kept. */
export const COMMS_SETTINGS_DEFAULTS: CommsSettings = { messageRetentionDays: null, fileRetentionDays: null };

@Module({
  imports: [NotificationsModule],
  controllers: [ConversationsController, MessagesController, CommsController, AnnouncementsController, MeetingsController, CommsFilesController],
  providers: [
    CommsAccessService,
    AnnouncementService,
    MeetingService,
    CommsFileService,
    CommsFileMaintenance,
    CommsAuditService,
    { provide: FILE_STORAGE, inject: [ENV], useFactory: (env: Env) => new LocalFileStorage(env.FILE_STORAGE_ROOT) },
    { provide: MALWARE_SCANNER, inject: [ENV], useFactory: (env: Env) => new ClamdScanner(env.CLAMD_HOST, env.CLAMD_PORT, env.CLAMD_TIMEOUT_MS) },
    ConversationService,
    MessageService,
    MessageViewBuilder,
    CommsRealtimePublisher,
    ConnectionRegistry,
    CommsGateway,
    CommsRealtimeDelivery,
    CommsRealtimeOutboxConsumer,
    CommsNotificationsConsumer,
  ],
  exports: [CommsGateway, CommsRealtimeDelivery, ConnectionRegistry],
})
export class CommsModule {
  constructor(settings: ModuleSettingsService) {
    // Retention periods: management's decision, kept by comms admins ("confirm again", audited with a reason).
    settings.register({ module: COMMS_SETTINGS, schema: commsSettingsSchema, defaults: COMMS_SETTINGS_DEFAULTS, viewPermission: 'comms.admin', managePermission: 'comms.admin', stepUp: true });
  }
}
