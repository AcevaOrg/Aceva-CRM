import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Patch, Post, Query, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { ApiConsumes, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Response } from 'express';
import {
  addChecklistItemRequestSchema,
  addCommentRequestSchema,
  approveTaskRequestSchema,
  createTaskRequestSchema,
  emptyActionRequestSchema,
  reasonActionRequestSchema,
  requestExtensionRequestSchema,
  resumeTaskRequestSchema,
  stopRepeatRequestSchema,
  taskListQuerySchema,
  updateTaskRequestSchema,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { Authenticated, ClientInfo, CurrentActor, RequestInfo, RequirePermission } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { MAX_TASK_FILE_BYTES, TaskCommentsService, type TaskUploadedFile } from './task-comments.service';
import { TaskWorkflowService } from './task-workflow.service';
import { TasksService } from './tasks.service';

class TaskListQueryDto extends createZodDto(taskListQuerySchema) {}
class CreateTaskDto extends createZodDto(createTaskRequestSchema) {}
class UpdateTaskDto extends createZodDto(updateTaskRequestSchema) {}
class EmptyActionDto extends createZodDto(emptyActionRequestSchema) {}
class ApproveTaskDto extends createZodDto(approveTaskRequestSchema) {}
class ReasonActionDto extends createZodDto(reasonActionRequestSchema) {}
class ResumeTaskDto extends createZodDto(resumeTaskRequestSchema) {}
class AddChecklistItemDto extends createZodDto(addChecklistItemRequestSchema) {}
class AddCommentDto extends createZodDto(addCommentRequestSchema) {}
class RequestExtensionDto extends createZodDto(requestExtensionRequestSchema) {}
class StopRepeatDto extends createZodDto(stopRepeatRequestSchema) {}

const fileOptions = { limits: { fileSize: MAX_TASK_FILE_BYTES + 1, files: 1 } };

/**
 * Module 5 routes (spec 9.5). The paths and the response shapes are the frontend's contract (packages/contracts/src/tasks.ts).
 *
 * Every route is for a logged-in person; the SERVICES decide per task who may do what (assignee, assigner, reviewer,
 * people above), because the same person plays different parts on different tasks. Declared before `:id` so that
 * "workload" is not taken for a task id.
 */
@ApiTags('tasks')
@Controller('tasks')
export class TasksController {
  constructor(
    private readonly tasks: TasksService,
    private readonly workflow: TaskWorkflowService,
    private readonly comments: TaskCommentsService,
  ) {}

  @Get()
  @RequirePermission('task.view_own')
  @ApiOperation({ summary: 'Tasks I may see: scope=mine (mine), team (below me, task.view_team) or all; filters: assignee, status, priority, size, projectId, due range, open=true (no approved or cancelled), closed=all (also tasks closed over 90 days ago)' })
  list(@CurrentActor() actor: Actor, @Query() query: TaskListQueryDto) {
    return this.tasks.list(actor, query);
  }

  @Get('workload')
  @RequirePermission('task.view_team')
  @ApiOperation({ summary: 'Team workload: open estimated hours against weekly capacity for each person below me' })
  workload(@CurrentActor() actor: Actor) {
    return this.tasks.workload(actor);
  }

  @Post()
  @Authenticated()
  @ApiOperation({ summary: 'Create a task (assign it to someone below me) or a personal to-do. Soft warnings answer 409 confirmation_required until confirmWarnings is true.' })
  create(@CurrentActor() actor: Actor, @Body() body: CreateTaskDto, @ClientInfo() client: RequestInfo) {
    return this.tasks.create(actor, body, client);
  }

  @Get(':id')
  @RequirePermission('task.view_own')
  @ApiOperation({ summary: 'One task (id or number) with its comments, extension requests, history and reviewer' })
  get(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.tasks.get(actor, id);
  }

  @Patch(':id')
  @Authenticated()
  @ApiOperation({ summary: 'Edit an open task: fields, reassign down the hierarchy, or move the deadline (a reason is required)' })
  update(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: UpdateTaskDto, @ClientInfo() client: RequestInfo) {
    return this.tasks.update(actor, id, body, client);
  }

  // ------------------------------------------------------------------------------------------------ status actions

  @Post(':id/start')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'Start (Assigned or Rework to In progress): the person doing the task' })
  start(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() _body: EmptyActionDto, @ClientInfo() client: RequestInfo) {
    return this.workflow.perform(actor, id, 'start', {}, client);
  }

  @Post(':id/submit')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'Submit for review (In progress or Rework to Submitted): the person doing the task' })
  submit(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() _body: EmptyActionDto, @ClientInfo() client: RequestInfo) {
    return this.workflow.perform(actor, id, 'submit', {}, client);
  }

  @Post(':id/review')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'Pick a submitted task up for review (Submitted to Under review): the reviewer' })
  review(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() _body: EmptyActionDto, @ClientInfo() client: RequestInfo) {
    return this.workflow.perform(actor, id, 'review', {}, client);
  }

  @Post(':id/approve')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'Approve with a rating 1 to 5 and an optional comment: the reviewer, never for their own task' })
  approve(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: ApproveTaskDto, @ClientInfo() client: RequestInfo) {
    return this.workflow.perform(actor, id, 'approve', { rating: body.rating, comment: body.comment }, client);
  }

  @Post(':id/rework')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'Send back to rework with a reason: the reviewer' })
  rework(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: ReasonActionDto, @ClientInfo() client: RequestInfo) {
    return this.workflow.perform(actor, id, 'rework', { reason: body.reason }, client);
  }

  @Post(':id/hold')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'Put on hold with a reason: the assigner' })
  hold(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: ReasonActionDto, @ClientInfo() client: RequestInfo) {
    return this.workflow.perform(actor, id, 'hold', { reason: body.reason }, client);
  }

  @Post(':id/cancel')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'Cancel with a reason: the assigner (a personal to-do: its owner)' })
  cancel(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: ReasonActionDto, @ClientInfo() client: RequestInfo) {
    return this.workflow.perform(actor, id, 'cancel', { reason: body.reason }, client);
  }

  @Post(':id/resume')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'Resume a task on hold (back to In progress): the assigner' })
  resume(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: ResumeTaskDto, @ClientInfo() client: RequestInfo) {
    return this.workflow.perform(actor, id, 'resume', { reason: body.reason }, client);
  }

  @Post(':id/done')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'Personal to-do only: mark it done (no review, no rating, not scored)' })
  done(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() _body: EmptyActionDto, @ClientInfo() client: RequestInfo) {
    return this.workflow.perform(actor, id, 'done', {}, client);
  }

  @Post(':id/reopen')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'Personal to-do only: reopen a to-do that was marked done' })
  reopen(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() _body: EmptyActionDto, @ClientInfo() client: RequestInfo) {
    return this.workflow.perform(actor, id, 'reopen', {}, client);
  }

  // ------------------------------------------------------------------------------------------------ extensions, repeat

  @Post(':id/extensions')
  @Authenticated()
  @ApiOperation({ summary: 'Ask for more time (the person doing the task). After the deadline the request counts as late.' })
  requestExtension(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: RequestExtensionDto, @ClientInfo() client: RequestInfo) {
    return this.workflow.requestExtension(actor, id, body, client);
  }

  @Post(':id/repeat/stop')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'Stop the repeating series this task belongs to (tasks already made stay)' })
  stopRepeat(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: StopRepeatDto, @ClientInfo() client: RequestInfo) {
    return this.tasks.stopRepeat(actor, id, body, client);
  }

  // ------------------------------------------------------------------------------------------------ checklist

  @Post(':id/checklist')
  @Authenticated()
  @ApiOperation({ summary: 'Add a step to the checklist' })
  addChecklistItem(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: AddChecklistItemDto, @ClientInfo() client: RequestInfo) {
    return this.tasks.addChecklistItem(actor, id, body, client);
  }

  @Patch(':id/checklist/:itemId')
  @Authenticated()
  @ApiOperation({ summary: 'Tick or untick a checklist step (the person doing the task)' })
  toggleChecklistItem(@CurrentActor() actor: Actor, @Param('id') id: string, @Param('itemId', new ParseUUIDPipe()) itemId: string, @ClientInfo() client: RequestInfo) {
    return this.tasks.toggleChecklistItem(actor, id, itemId, client);
  }

  // ------------------------------------------------------------------------------------------------ comments, files

  @Get(':id/comments')
  @RequirePermission('task.view_own')
  @ApiOperation({ summary: 'Comments on a task, oldest first' })
  listComments(@CurrentActor() actor: Actor, @Param('id') id: string) {
    return this.comments.list(actor, id);
  }

  @Post(':id/comments')
  @Authenticated()
  @ApiConsumes('application/json', 'multipart/form-data')
  @UseInterceptors(FileInterceptor('file', fileOptions))
  @ApiOperation({ summary: 'Comment on a task (JSON { body } or multipart body + file). @Firstname and @ACV-0007 mention people who can see the task.' })
  addComment(@CurrentActor() actor: Actor, @Param('id') id: string, @Body() body: AddCommentDto, @UploadedFile() file: TaskUploadedFile | undefined, @ClientInfo() client: RequestInfo) {
    return this.comments.add(actor, id, body, file, client);
  }

  @Post(':id/attachments')
  @Authenticated()
  @ApiConsumes('multipart/form-data')
  @UseInterceptors(FileInterceptor('file', fileOptions))
  @ApiOperation({ summary: 'Attach a file to the task (PDF, PNG, JPEG or .docx, 10 MB). Stored privately.' })
  addAttachment(@CurrentActor() actor: Actor, @Param('id') id: string, @UploadedFile() file: TaskUploadedFile | undefined, @ClientInfo() client: RequestInfo) {
    return this.comments.addAttachment(actor, id, file, client);
  }

  @Get(':id/attachments/:attachmentId/download')
  @RequirePermission('task.view_own')
  @ApiOperation({ summary: 'Download a file. Permission is checked every time, and every download is logged.' })
  async download(
    @CurrentActor() actor: Actor,
    @Param('id') id: string,
    @Param('attachmentId', new ParseUUIDPipe()) attachmentId: string,
    @ClientInfo() client: RequestInfo,
    @Res({ passthrough: true }) res: Response,
  ) {
    const file = await this.comments.downloadAttachment(actor, id, attachmentId, client);
    res.set({
      'Content-Type': file.mimeType,
      'Content-Disposition': `attachment; filename="${encodeURIComponent(file.fileName)}"`,
      'X-Content-Type-Options': 'nosniff',
      'Cache-Control': 'private, no-store',
    });
    return new StreamableFile(file.buffer);
  }

  @Delete(':id/attachments/:attachmentId')
  @Authenticated()
  @ApiOperation({ summary: 'Archive a file (kept, never deleted)' })
  archiveAttachment(@CurrentActor() actor: Actor, @Param('id') id: string, @Param('attachmentId', new ParseUUIDPipe()) attachmentId: string, @ClientInfo() client: RequestInfo) {
    return this.comments.archiveAttachment(actor, id, attachmentId, client);
  }
}
