import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Put, Query, Res, StreamableFile, UploadedFile, UseFilters, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  COMMS_FILE_MAX_BYTES,
  addMembersSchema,
  announcementListQuerySchema,
  archiveConversationSchema,
  cancelMeetingSchema,
  commsAuditQuerySchema,
  createMeetingSchema,
  inviteToMeetingSchema,
  linkTaskSchema,
  meetingListQuerySchema,
  meetingRsvpBodySchema,
  updateMeetingSchema,
  conversationListQuerySchema,
  createConversationSchema,
  editMessageSchema,
  empIdSchema,
  markSeqSchema,
  messageHistoryQuerySchema,
  messageSearchQuerySchema,
  publishAnnouncementSchema,
  reactionEmojiSchema,
  removeMessageSchema,
  savedMessagesQuerySchema,
  sendMessageSchema,
  threadQuerySchema,
  updateConversationSchema,
  type CommsPolicyView,
  type CommsSettings,
  type CreateConversationInput,
} from '@aceva/contracts';
import { ModuleSettingsService } from '../settings/module-settings.service';
import { z } from 'zod';
import type { Actor } from '../access/access.types';
import { ClientInfo, CurrentActor, RequirePermission, type RequestInfo } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { ANNOUNCEMENTS_PUBLISH, AnnouncementService } from './announcement.service';
import { CommsAuditService } from './comms-audit.service';
import { CommsErrorFilter } from './comms-errors';
import { CommsFileService, type CommsUploadedFile } from './comms-file.service';
import { MeetingService } from './meeting.service';
import { ConversationService } from './conversation.service';
import { MessageService } from './message.service';

class ListQueryDto extends createZodDto(conversationListQuerySchema) {}
class CommsAuditQueryDto extends createZodDto(commsAuditQuerySchema) {}
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
class LinkTaskDto extends createZodDto(linkTaskSchema) {}
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

  @Put(':id/task')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Link to a Module 5 task I may see (by number or id; never a personal to-do). Others see it only if Module 5 lets them' })
  linkTask(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Body() body: LinkTaskDto, @ClientInfo() client: RequestInfo) {
    return this.messages.linkTask(actor, id, body.task, client);
  }

  @Delete(':id/task')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Remove the task link (who linked it, the author or a moderator)' })
  unlinkTask(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @ClientInfo() client: RequestInfo) {
    return this.messages.unlinkTask(actor, id, client);
  }

  @Get(':id/link')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'The linked task as I may see it ({ task: null }: linked to a task I may not see)' })
  link(@CurrentActor() actor: Actor, @Param('id', uuid) id: string) {
    return this.messages.link(actor, id);
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
    private readonly settings: ModuleSettingsService,
    private readonly auditEvents: CommsAuditService,
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

  @Get('policy')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'The retention policy everyone is told in conversation details (set by management through the comms admins)' })
  async policy(): Promise<CommsPolicyView> {
    const s = await this.settings.value<CommsSettings>('comms');
    return { messageRetentionDays: s.messageRetentionDays, fileRetentionDays: s.fileRetentionDays, automaticRemoval: false };
  }

  @Get('admin/audit')
  @RequirePermission(USE, ADMIN)
  @ApiOperation({ summary: 'comms.admin: Module 14 security and audit events, newest first (metadata only, never message text). ?action&outcome&from&to&cursor&limit' })
  adminAudit(@Query() q: CommsAuditQueryDto) {
    return this.auditEvents.list(q);
  }

  @Get('admin/channels')
  @RequirePermission(USE, ADMIN)
  @ApiOperation({ summary: 'comms.admin: every channel with its members and moderators (never its messages)' })
  adminChannels(@Query() q: ListQueryDto) {
    return this.conversations.adminChannels(q);
  }
}

class AnnouncementListQueryDto extends createZodDto(announcementListQuerySchema) {}
class PublishAnnouncementDto extends createZodDto(publishAnnouncementSchema) {}

/**
 * Module 14 announcements: everyone reads the ones for them (comms.use); publishing and pinning need
 * announcements.publish (checked here and again by the service). Acknowledging is for the people an announcement is for.
 */
@ApiTags('comms')
@UseFilters(CommsErrorFilter)
@Controller('comms/announcements')
export class AnnouncementsController {
  constructor(private readonly announcements: AnnouncementService) {}

  @Get()
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Announcements for me (and all of them for the CEO / Founder / Owner and the Director), pinned first, newest first' })
  list(@CurrentActor() actor: Actor, @Query() q: AnnouncementListQueryDto) {
    return this.announcements.list(actor, q);
  }

  @Post()
  @RequirePermission(USE, ANNOUNCEMENTS_PUBLISH)
  @ApiOperation({ summary: 'announcements.publish: publish to everyone or to chosen departments; optionally pinned and asking for acknowledgement (audited)' })
  publish(@CurrentActor() actor: Actor, @Body() body: PublishAnnouncementDto, @ClientInfo() client: RequestInfo) {
    return this.announcements.publish(actor, body, client);
  }

  @Get(':id')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'One announcement; for publishers, who it is for and who has acknowledged' })
  detail(@CurrentActor() actor: Actor, @Param('id', uuid) id: string) {
    return this.announcements.detail(actor, id);
  }

  @Put(':id/pin')
  @RequirePermission(USE, ANNOUNCEMENTS_PUBLISH)
  @ApiOperation({ summary: 'Pin to the top (audited)' })
  pin(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @ClientInfo() client: RequestInfo) {
    return this.announcements.setPinned(actor, id, true, client);
  }

  @Delete(':id/pin')
  @RequirePermission(USE, ANNOUNCEMENTS_PUBLISH)
  @ApiOperation({ summary: 'Unpin (audited)' })
  unpin(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @ClientInfo() client: RequestInfo) {
    return this.announcements.setPinned(actor, id, false, client);
  }

  @Post(':id/ack')
  @HttpCode(200)
  @RequirePermission(USE)
  @ApiOperation({ summary: '"I\'ve read this" (once; only for people it is addressed to, when it asks for acknowledgement)' })
  acknowledge(@CurrentActor() actor: Actor, @Param('id', uuid) id: string) {
    return this.announcements.acknowledge(actor, id);
  }
}

class MeetingListQueryDto extends createZodDto(meetingListQuerySchema) {}
class CreateMeetingDto extends createZodDto(createMeetingSchema) {}
class UpdateMeetingDto extends createZodDto(updateMeetingSchema) {}
class InviteDto extends createZodDto(inviteToMeetingSchema) {}
class RsvpDto extends createZodDto(meetingRsvpBodySchema) {}
class CancelMeetingDto extends createZodDto(cancelMeetingSchema) {}

/**
 * Module 14 meetings: private to the organizer and the people invited (anyone else gets "not found"). Everyone with
 * comms.use can organise one; what each person may do is decided by the service (organizer or invitee).
 */
@ApiTags('comms')
@UseFilters(CommsErrorFilter)
@Controller('comms/meetings')
export class MeetingsController {
  constructor(private readonly meetings: MeetingService) {}

  @Get()
  @RequirePermission(USE)
  @ApiOperation({ summary: 'My meetings (organised or invited), soonest first. ?from&to (default: 30 days ago to a year ahead)' })
  list(@CurrentActor() actor: Actor, @Query() q: MeetingListQueryDto) {
    return this.meetings.list(actor, q);
  }

  @Post()
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Organise a meeting: title, start, duration, place or link, agenda, current colleagues invited (audited without the agenda)' })
  create(@CurrentActor() actor: Actor, @Body() body: CreateMeetingDto, @ClientInfo() client: RequestInfo) {
    return this.meetings.create(actor, body, client);
  }

  @Get(':id')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'One meeting with its invitees and their answers' })
  detail(@CurrentActor() actor: Actor, @Param('id', uuid) id: string) {
    return this.meetings.detail(actor, id);
  }

  @Patch(':id')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'The organizer changes the meeting or writes its notes' })
  update(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Body() body: UpdateMeetingDto, @ClientInfo() client: RequestInfo) {
    return this.meetings.update(actor, id, body, client);
  }

  @Post(':id/participants')
  @HttpCode(200)
  @RequirePermission(USE)
  @ApiOperation({ summary: 'The organizer invites more people' })
  invite(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Body() body: InviteDto, @ClientInfo() client: RequestInfo) {
    return this.meetings.invite(actor, id, body.empIds, client);
  }

  @Put(':id/rsvp')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'An invitee answers yes, no or maybe (until the meeting ends)' })
  rsvp(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Body() body: RsvpDto) {
    return this.meetings.rsvp(actor, id, body.rsvp);
  }

  @Post(':id/tasks')
  @HttpCode(200)
  @RequirePermission(USE)
  @ApiOperation({ summary: 'The organizer links a Module 5 task they may see (never a personal to-do)' })
  linkTask(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Body() body: LinkTaskDto, @ClientInfo() client: RequestInfo) {
    return this.meetings.linkTask(actor, id, body.task, client);
  }

  @Delete(':id/tasks/:taskId')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'The organizer removes a linked task' })
  unlinkTask(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Param('taskId', uuid) taskId: string, @ClientInfo() client: RequestInfo) {
    return this.meetings.unlinkTask(actor, id, taskId, client);
  }

  @Post(':id/cancel')
  @HttpCode(200)
  @RequirePermission(USE)
  @ApiOperation({ summary: 'The organizer cancels it, with a reason (audited); it stays, read-only' })
  cancel(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @Body() body: CancelMeetingDto, @ClientInfo() client: RequestInfo) {
    return this.meetings.cancel(actor, id, body.reason, client);
  }
}

/** One file per upload, refused by Multer just above the limit (the service gives the clear answer). */
const uploadOptions = { limits: { fileSize: COMMS_FILE_MAX_BYTES + 1, files: 1 } };

/**
 * Module 14 files: uploads to a conversation (then attached to a message when it is sent) or to a meeting, and the
 * permission-checked download. Every file is checked by ClamAV first: nobody can open it before the check says clean.
 */
@ApiTags('comms')
@UseFilters(CommsErrorFilter)
@Controller('comms')
export class CommsFilesController {
  constructor(private readonly files: CommsFileService) {}

  @Post('conversations/:id/files')
  @RequirePermission(USE)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', uploadOptions))
  @ApiOperation({ summary: 'Upload a file to attach to my next message here (PDF, PNG, JPEG or .docx, 10 MB). Checked for malware before anyone can open it' })
  uploadToConversation(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @UploadedFile() file: CommsUploadedFile | undefined, @ClientInfo() client: RequestInfo) {
    return this.files.uploadToConversation(actor, id, file, client);
  }

  @Post('meetings/:id/files')
  @RequirePermission(USE)
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', uploadOptions))
  @ApiOperation({ summary: 'The organizer adds a file to the meeting (same limits and malware check)' })
  uploadToMeeting(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @UploadedFile() file: CommsUploadedFile | undefined, @ClientInfo() client: RequestInfo) {
    return this.files.uploadToMeeting(actor, id, file, client);
  }

  @Get('files/:id')
  @RequirePermission(USE)
  @ApiOperation({ summary: "A file's details and malware-check state, for the people who may see it" })
  view(@CurrentActor() actor: Actor, @Param('id', uuid) id: string) {
    return this.files.view(actor, id);
  }

  @Get('files/:id/download')
  @RequirePermission(USE)
  @ApiOperation({ summary: 'Download (checked every time; only clean files; audited)' })
  async download(@CurrentActor() actor: Actor, @Param('id', uuid) id: string, @ClientInfo() client: RequestInfo, @Res({ passthrough: true }) res: Response) {
    const file = await this.files.download(actor, id, client);
    res.set({
      'Content-Type': file.mimeType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(file.fileName)}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(file.buffer);
  }
}
