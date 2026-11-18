import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, UseFilters } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  addMembersSchema,
  archiveConversationSchema,
  conversationListQuerySchema,
  createConversationSchema,
  editMessageSchema,
  empIdSchema,
  markSeqSchema,
  messageHistoryQuerySchema,
  messageSearchQuerySchema,
  reactionEmojiSchema,
  removeMessageSchema,
  savedMessagesQuerySchema,
  sendMessageSchema,
  threadQuerySchema,
  updateConversationSchema,
  type CreateConversationInput,
} from '@aceva/contracts';
import { z } from 'zod';
import type { Actor } from '../access/access.types';
import { ClientInfo, CurrentActor, RequirePermission, type RequestInfo } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { CommsErrorFilter } from './comms-errors';
import { ConversationService } from './conversation.service';
import { MessageService } from './message.service';

class ListQueryDto extends createZodDto(conversationListQuerySchema) {}
// The body is a union (DM, group or channel). A class cannot extend a union type, so the base is typed as a plain object;
// the global validation pipe still checks the body against the full union schema (the class's static `schema`).
const CreateConversationBase = createZodDto(createConversationSchema) as unknown as { new (): object; readonly schema: typeof createConversationSchema };
class CreateConversationDto extends CreateConversationBase {}
class UpdateConversationDto extends createZodDto(updateConversationSchema) {}
class AddMembersDto extends createZodDto(addMembersSchema) {}
class ArchiveDto extends createZodDto(archiveConversationSchema) {}
class MarkSeqDto extends createZodDto(markSeqSchema) {}
class HistoryQueryDto extends createZodDto(messageHistoryQuerySchema) {}
class ThreadQueryDto extends createZodDto(threadQuerySchema) {}
class SendMessageDto extends createZodDto(sendMessageSchema) {}
class EditMessageDto extends createZodDto(editMessageSchema) {}
class RemoveMessageDto extends createZodDto(removeMessageSchema) {}
class SearchQueryDto extends createZodDto(messageSearchQuerySchema) {}
class SavedQueryDto extends createZodDto(savedMessagesQuerySchema) {}
class EmpIdParamDto extends createZodDto(z.object({ id: z.uuid(), empId: empIdSchema })) {}
class EmojiParamDto extends createZodDto(z.object({ id: z.uuid(), emoji: reactionEmojiSchema })) {}

const USE = 'comms.use';
const ADMIN = 'comms.admin';
const uuid = new ParseUUIDPipe();

/**
 * Module 14, part 1: conversations (DMs, groups, department and project channels) over REST. Every route needs
 * comms.use (everyone has it); what a person may do inside a conversation depends on being a member and on their role
 * there, checked by the services on every request. A conversation the caller is not a member of is "not found".
 * CommsErrorFilter keeps message text out of the logs and error responses.
 */
@ApiTags('comms')
@UseFilters(CommsErrorFilter)
@Controller('comms/conversations')
export class ConversationsController {
  constructor(
    private readonly conversations: ConversationService,
    private readonly messages: MessageService,
  ) {}

  @Get()
  @RequirePermission(USE)
  @ApiOperation({ summary: 'My conversations, most recently active first, with my unread count. ?cursor&limit' })
  list(@CurrentActor() actor: Actor, @Query() q: ListQueryDto) {
    return this.conversations.list(actor, q);
  }

  @Post()
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Start a DM (an existing DM with the same person is returned, 200), a group, or a channel (comms.admin)' })
  async create(@CurrentActor() actor: Actor, @Body() body: CreateConversationDto, @ClientInfo() client: RequestInfo, @Res({ passthrough: true }) res: Response) {
    const result = await this.conversations.create(actor, body as unknown as CreateConversationInput, client);
    res.status(result.created ? 201 : 200);
    return result;
  }

  @Get(':id')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'A conversation: members, my read position, receipts (DMs and groups), pins and what I may do' })
  detail(@CurrentActor() actor: Actor, @Param('id', uuid) id: string) {
    return this.conversations.detail(actor, id);
  }

  @Patch(':id')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Rename, change the topic or the project name/code (moderators; comms admins for channels)' })
  update(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Body() body: UpdateConversationDto, @ClientInfo() client: RequestInfo) {
    return this.conversations.update(actor, id, body, client);
  }

  @Post(':id/archive')
  @HttpCode(200)
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Archive (read-only from then on): channels by comms admins, groups by their moderators. Needs a reason' })
  archive(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Body() body: ArchiveDto, @ClientInfo() client: RequestInfo) {
    return this.conversations.archive(actor, id, body.reason, client);
  }

  @Post(':id/members')
  @HttpCode(200)
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Add current employees (moderators; comms admins for channels)' })
  addMembers(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Body() body: AddMembersDto, @ClientInfo() client: RequestInfo) {
    return this.conversations.addMembers(actor, id, body, client);
  }

  @Delete(':id/members/:empId')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Remove a member (moderators; comms admins for channels), or leave with your own Emp-ID' })
  removeMember(@CurrentActor() actor: Actor, @Param() p: EmpIdParamDto, @ClientInfo() client: RequestInfo) {
    return this.conversations.removeMember(actor, p.id, p.empId, client);
  }

  @Put(':id/moderators/:empId')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Make someone a moderator (comms admins for channels; moderators for groups)' })
  addModerator(@CurrentActor() actor: Actor, @Param() p: EmpIdParamDto, @ClientInfo() client: RequestInfo) {
    return this.conversations.setModerator(actor, p.id, p.empId, true, client);
  }

  @Delete(':id/moderators/:empId')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Stop someone being a moderator (they stay a member)' })
  removeModerator(@CurrentActor() actor: Actor, @Param() p: EmpIdParamDto, @ClientInfo() client: RequestInfo) {
    return this.conversations.setModerator(actor, p.id, p.empId, false, client);
  }

  @Post(':id/read')
  @HttpCode(200)
  @RequirePermission(USE)
  @ApiOperation({ summary: 'I have read up to message number seq (also counts as received). Positions only move forward' })
  read(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Body() body: MarkSeqDto) {
    return this.conversations.mark(actor, id, body.seq, 'read');
  }

  @Post(':id/delivered')
  @HttpCode(200)
  @RequirePermission(USE)
  @ApiOperation({ summary: 'My screen has received up to message number seq' })
  delivered(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Body() body: MarkSeqDto) {
    return this.conversations.mark(actor, id, body.seq, 'delivered');
  }

  @Get(':id/messages')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'History by sequence number: newest page, ?before=N (older) or ?after=N (catching up, oldest first)' })
  history(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Query() q: HistoryQueryDto) {
    return this.messages.history(actor, id, q);
  }

  @Post(':id/messages')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Send a message (plain text, at most 4,000 characters; "@ACV-0006" mentions a member). clientKey makes a retry safe' })
  async send(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Body() body: SendMessageDto, @Res({ passthrough: true }) res: Response) {
    const result = await this.messages.send(actor, id, body);
    res.status(result.created ? 201 : 200);
    return result;
  }

  @Get(':id/pins')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Pinned messages, newest pin first' })
  pins(@CurrentActor() actor: Actor, @Param('id', uuid) id: string) {
    return this.messages.pins(actor, id);
  }
}

@ApiTags('comms')
@UseFilters(CommsErrorFilter)
@Controller('comms/messages')
export class MessagesController {
  constructor(private readonly messages: MessageService) {}

  @Get(':id/thread')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'A message and its replies, oldest first. ?after=N&limit' })
  thread(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Query() q: ThreadQueryDto) {
    return this.messages.thread(actor, id, q);
  }

  @Patch(':id')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Edit my own message (within 24 hours). The older text is kept, never shown' })
  edit(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Body() body: EditMessageDto, @ClientInfo() client: RequestInfo) {
    return this.messages.edit(actor, id, body.body, client);
  }

  @Delete(':id')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Delete my own message (any time): a placeholder stays' })
  remove(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @ClientInfo() client: RequestInfo) {
    return this.messages.deleteOwn(actor, id, client);
  }

  @Post(':id/remove')
  @HttpCode(200)
  @RequirePermission(USE)
  @ApiOperation({ summary: "A moderator removes someone's message, with a reason (audited)" })
  moderate(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Body() body: RemoveMessageDto, @ClientInfo() client: RequestInfo) {
    return this.messages.remove(actor, id, body.reason, client);
  }

  @Put(':id/reactions/:emoji')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Add my reaction (once per emoji)' })
  react(@CurrentActor() actor: Actor, @Param() p: EmojiParamDto) {
    return this.messages.react(actor, p.id, p.emoji, true);
  }

  @Delete(':id/reactions/:emoji')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Take back my reaction' })
  unreact(@CurrentActor() actor: Actor, @Param() p: EmojiParamDto) {
    return this.messages.react(actor, p.id, p.emoji, false);
  }

  @Put(':id/pin')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Pin (DM and group members; moderators in channels)' })
  pin(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @ClientInfo() client: RequestInfo) {
    return this.messages.pin(actor, id, true, client);
  }

  @Delete(':id/pin')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Unpin' })
  unpin(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @ClientInfo() client: RequestInfo) {
    return this.messages.pin(actor, id, false, client);
  }

  @Put(':id/save')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Save for myself' })
  save(@CurrentActor() actor: Actor, @Param('id', uuid) id: string) {
    return this.messages.save(actor, id, true);
  }

  @Delete(':id/save')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Remove from my saved messages' })
  unsave(@CurrentActor() actor: Actor, @Param('id', uuid) id: string) {
    return this.messages.save(actor, id, false);
  }
}

@ApiTags('comms')
@UseFilters(CommsErrorFilter)
@Controller('comms')
export class CommsController {
  constructor(
    private readonly conversations: ConversationService,
    private readonly messages: MessageService,
  ) {}

  @Get('search')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Search message text in the conversations I can see. ?q&conversationId&cursor&limit' })
  search(@CurrentActor() actor: Actor, @Query() q: SearchQueryDto) {
    return this.messages.search(actor, q);
  }

  @Get('saved')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'My saved messages (from conversations I can still see), newest first' })
  saved(@CurrentActor() actor: Actor, @Query() q: SavedQueryDto) {
    return this.messages.saved(actor, q);
  }

  @Get('admin/channels')
  @RequirePermission(USE, ADMIN)
  @ApiOperation({ summary: 'comms.admin: every channel with its members and moderators (never its messages)' })
  adminChannels(@Query() q: ListQueryDto) {
    return this.conversations.adminChannels(q);
  }
}
