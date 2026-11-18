import { createHash, randomUUID } from 'node:crypto';
import { Inject, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import type { AddCommentRequest, AttachmentView, TaskCommentView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { Clock } from '../common/clock';
import { OutboxService } from '../events/outbox.service';
import { PrismaService } from '../prisma/prisma.service';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage';
import { detectFileType, safeFileName } from '../storage/file-type';
import { extractMentions, type Mentionable } from './rules/task-people';
import { isOpen } from './rules/task-status';
import { commentViews, conflict, forbidden, invalid, noteTaskActivity, notAllowed } from './task-access';
import { COMMENT_INCLUDE, taskRefOf, toAttachmentView, toCommentView, type TaskRow } from './task-data';
import { TaskWorkflowService } from './task-workflow.service';
import { TasksService } from './tasks.service';

/** Files on tasks and comments are limited like employee documents: 10 MB; PDF, PNG, JPEG and Word (.docx) only. */
export const MAX_TASK_FILE_BYTES = 10 * 1024 * 1024;

/** A file as multer hands it over (memory storage). */
export interface TaskUploadedFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/**
 * Comments with @mentions, and files on tasks and comments (M3's FileStorage, like employee documents: the storage key is
 * generated and never the uploaded name, the type is detected from the content, the file is removed again when the record
 * cannot be saved, downloads re-check permission and are audited). Visibility is always TasksService.requireVisible (404 for
 * people who cannot see the task). A personal to-do is private: its comments and files are not audited and send no event.
 */
@Injectable()
export class TaskCommentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly workflow: TaskWorkflowService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  /** GET /tasks/:id/comments: the comments of a visible task, oldest first. */
  async list(actor: Actor, idOrNumber: string): Promise<TaskCommentView[]> {
    const task = await this.tasks.requireVisible(actor, idOrNumber);
    return commentViews(this.prisma, task.id);
  }

  /**
   * POST /tasks/:id/comments (JSON { body }, or multipart with `body` and an optional `file`). Anyone who can see the task
   * may comment, except the CEO / Founder / Owner, who only watches. Mentions (@Firstname, @Full Name, @ACV-0007) name only
   * active people who can see the task (the assignee, the assigner and the people above the assignee), never the writer.
   */
  async add(actor: Actor, idOrNumber: string, body: AddCommentRequest, file: TaskUploadedFile | undefined, client: RequestInfo): Promise<TaskCommentView> {
    const task = await this.tasks.requireVisible(actor, idOrNumber);
    if (!task.personal && actor.levelNumber === 1) throw forbidden('The CEO / Founder / Owner can view tasks but not change them.');
    const detected = file ? this.checkFile(file) : null; // refuse a bad file before anything is written

    const people: Array<Mentionable & { id: string }> = task.personal ? [] : await this.mentionable(task);
    const mentioned = extractMentions(body.body, people).filter((empId) => empId !== actor.empId);
    const idOf = new Map(people.map((p) => [p.empId, p.id]));
    const mentionedIds = mentioned.map((empId) => idOf.get(empId) as string); // in the order they were written

    const key = detected ? `tasks/${task.id}/${randomUUID()}${detected.ext}` : null; // generated, never the uploaded name
    if (key) await this.storage.put(key, (file as TaskUploadedFile).buffer);
    const now = this.clock.now();
    try {
      const view = await this.prisma.$transaction(async (tx) => {
        const comment = await tx.taskComment.create({
          data: {
            taskId: task.id,
            authorId: actor.id,
            body: body.body,
            createdAt: now,
            mentions: { create: mentionedIds.map((employeeId) => ({ employeeId })) },
            ...(key && detected && file
              ? {
                  attachments: {
                    create: {
                      taskId: task.id,
                      uploadedById: actor.id,
                      storageKey: key,
                      originalFilename: safeFileName(file.originalname),
                      mimeType: detected.mime,
                      sizeBytes: file.size,
                      sha256: createHash('sha256').update(file.buffer).digest('hex'),
                      createdAt: now,
                    },
                  },
                }
              : {}),
          },
          include: COMMENT_INCLUDE,
        });
        if (!task.personal) {
          await this.audit.record(
            { actorId: actor.id, action: 'task.comment.added', targetType: 'task', targetId: task.number, details: { commentId: comment.id, mentions: mentioned.length, withFile: !!key }, ...client },
            tx,
          );
          await this.outbox.emit(
            { type: 'task.comment_added', actor: actor.empId, payload: { ...taskRefOf(task), commentId: comment.id, assignee: task.assignee.empId, assignedBy: task.assignedBy.empId, mentions: mentioned } },
            tx,
          );
        }
        return toCommentView(comment);
      });
      noteTaskActivity(task, `Commented on task ${task.number}`, 'Commented on a personal to-do');
      return view;
    } catch (error) {
      if (key) await this.storage.remove(key); // nothing is left behind when the record could not be saved
      throw error;
    }
  }

  /** POST /tasks/:id/attachments (multipart `file`): a file on the task itself. The person doing the task or the person who assigned it, task open. */
  async addAttachment(actor: Actor, idOrNumber: string, file: TaskUploadedFile | undefined, client: RequestInfo): Promise<AttachmentView> {
    const task = await this.tasks.requireVisible(actor, idOrNumber);
    if (task.assigneeId !== actor.id && !(await this.isAssigner(actor, task))) throw notAllowed('Only the person doing the task or the person who assigned it can attach files.');
    if (!isOpen(task.status)) throw conflict('task_closed', `This task is ${task.status.replace('_', ' ')}; files can no longer be added.`);
    const detected = this.checkFile(file);
    const upload = file as TaskUploadedFile;
    const key = `tasks/${task.id}/${randomUUID()}${detected.ext}`;
    await this.storage.put(key, upload.buffer);
    try {
      const row = await this.prisma.$transaction(async (tx) => {
        const saved = await tx.taskAttachment.create({
          data: {
            taskId: task.id,
            uploadedById: actor.id,
            storageKey: key,
            originalFilename: safeFileName(upload.originalname),
            mimeType: detected.mime,
            sizeBytes: upload.size,
            sha256: createHash('sha256').update(upload.buffer).digest('hex'),
            createdAt: this.clock.now(),
          },
          include: { uploadedBy: { select: { empId: true } } },
        });
        if (!task.personal) {
          await this.audit.record(
            { actorId: actor.id, action: 'task.attachment.added', targetType: 'task', targetId: task.number, details: { attachmentId: saved.id, sizeBytes: saved.sizeBytes, mimeType: saved.mimeType }, ...client },
            tx,
          );
        }
        return saved;
      });
      noteTaskActivity(task, `Attached a file to task ${task.number}`, 'Attached a file to a personal to-do');
      return toAttachmentView(row);
    } catch (error) {
      await this.storage.remove(key);
      throw error;
    }
  }

  /** GET /tasks/:id/attachments/:attachmentId/download: the bytes, after the visibility check; every download is audited ("task.attachment.downloaded"). */
  async downloadAttachment(actor: Actor, idOrNumber: string, attachmentId: string, client: RequestInfo): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
    const task = await this.tasks.requireVisible(actor, idOrNumber);
    const file = await this.prisma.taskAttachment.findFirst({ where: { id: attachmentId, taskId: task.id, archivedAt: null } });
    if (!file) throw new NotFoundException({ statusCode: 404, code: 'not_found', message: 'File not found' });
    const buffer = await this.storage.get(file.storageKey);
    if (!task.personal) {
      await this.audit.record({ actorId: actor.id, action: 'task.attachment.downloaded', targetType: 'task', targetId: task.number, details: { attachmentId: file.id }, ...client });
    }
    noteTaskActivity(task, `Downloaded a file of task ${task.number}`, 'Downloaded a file of a personal to-do');
    return { buffer, mimeType: file.mimeType, fileName: file.originalFilename };
  }

  /** DELETE /tasks/:id/attachments/:attachmentId: archives (archivedAt), never deletes the file. The uploader or the assigner. Audited. */
  async archiveAttachment(actor: Actor, idOrNumber: string, attachmentId: string, client: RequestInfo): Promise<{ ok: true }> {
    const task = await this.tasks.requireVisible(actor, idOrNumber);
    const file = await this.prisma.taskAttachment.findFirst({ where: { id: attachmentId, taskId: task.id, archivedAt: null }, select: { id: true, uploadedById: true } });
    if (!file) throw new NotFoundException({ statusCode: 404, code: 'not_found', message: 'File not found' });
    if (file.uploadedById !== actor.id && !(await this.isAssigner(actor, task))) throw notAllowed('Only the person who added the file or the person who assigned the task can remove it.');
    const { count } = await this.prisma.taskAttachment.updateMany({ where: { id: file.id, archivedAt: null }, data: { archivedAt: this.clock.now(), updatedBy: actor.id } });
    if (count === 0) throw new NotFoundException({ statusCode: 404, code: 'not_found', message: 'File not found' });
    if (!task.personal) {
      await this.audit.record({ actorId: actor.id, action: 'task.attachment.archived', targetType: 'task', targetId: task.number, details: { attachmentId: file.id }, ...client });
    }
    noteTaskActivity(task, `Removed a file from task ${task.number}`, 'Removed a file from a personal to-do');
    return { ok: true };
  }

  // ------------------------------------------------------------------------------------------------ helpers

  /** The person who assigned the task, or whoever stands in for him once he left (TaskWorkflowService.canActAsAssigner). */
  private isAssigner(actor: Actor, task: TaskRow): Promise<boolean> {
    return this.workflow.canActAsAssigner(actor, task);
  }

  /** The active people who can see a work task: the assignee, the assigner and everyone above the assignee. */
  private mentionable(task: TaskRow): Promise<Array<Mentionable & { id: string }>> {
    return this.prisma.employee.findMany({
      where: { status: { not: 'left' }, OR: [{ id: { in: [task.assigneeId, task.assignedById] } }, { descendants: { some: { descendantId: task.assigneeId } } }] },
      select: { id: true, empId: true, fullName: true },
    });
  }

  private checkFile(file: TaskUploadedFile | undefined) {
    if (!file || file.size === 0) throw invalid('no_file', 'Choose a file to upload');
    if (file.size > MAX_TASK_FILE_BYTES) throw new PayloadTooLargeException(`The file is too large (limit ${Math.round(MAX_TASK_FILE_BYTES / 1024 / 1024)} MB)`);
    const detected = detectFileType(file.buffer);
    if (!detected) throw invalid('file_type_not_allowed', 'Only PDF, PNG, JPEG and Word (.docx) files are accepted');
    return detected;
  }
}
