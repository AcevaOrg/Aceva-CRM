import { Module } from '@nestjs/common';
import { CommsAccessService } from './comms-access.service';
import { CommsController, ConversationsController, MessagesController } from './comms.controller';
import { ConversationService } from './conversation.service';
import { MessageService } from './message.service';
import { MessageViewBuilder } from './message-views';

/**
 * Module 14: internal communication and team collaboration (plan section 19). Part 1 (M14.1): conversations and
 * messages over REST. Live delivery (WebSockets), files, announcements, meetings and Module 14 notifications come in the
 * later parts. Uses the shared authentication, permissions, audit log and outbox; it has no notification system of its own.
 */
@Module({
  controllers: [ConversationsController, MessagesController, CommsController],
  providers: [CommsAccessService, ConversationService, MessageService, MessageViewBuilder],
})
export class CommsModule {}
