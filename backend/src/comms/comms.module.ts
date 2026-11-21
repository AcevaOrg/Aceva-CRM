import { Module } from '@nestjs/common';
import { CommsAccessService } from './comms-access.service';
import { CommsController, ConversationsController, MessagesController } from './comms.controller';
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
 * Files, announcements, meetings and Module 14 notifications come in the later parts. Uses the shared authentication,
 * permissions, audit log and outbox; it has no notification system of its own.
 */
@Module({
  controllers: [ConversationsController, MessagesController, CommsController],
  providers: [
    CommsAccessService,
    ConversationService,
    MessageService,
    MessageViewBuilder,
    CommsRealtimePublisher,
    ConnectionRegistry,
    CommsGateway,
    CommsRealtimeDelivery,
    CommsRealtimeOutboxConsumer,
  ],
  exports: [CommsGateway, CommsRealtimeDelivery, ConnectionRegistry],
})
export class CommsModule {}
