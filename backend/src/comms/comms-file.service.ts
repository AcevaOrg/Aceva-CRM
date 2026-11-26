import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ConflictException, ForbiddenException, GoneException, HttpException, Inject, Injectable, Logger, NotFoundException, PayloadTooLargeException, type OnModuleInit } from '@nestjs/common';
import { COMMS_FILE_MAX_BYTES, COMMS_UPLOADS_PER_HOUR, COMMS_UPLOADS_PER_MINUTE, type CommsFileView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { Clock } from '../common/clock';
import { OutboxService } from '../events/outbox.service';
import { Prisma } from '../generated/prisma/client';
import { JobRunner } from '../jobs/job-runner.service';
import { PrismaService } from '../prisma/prisma.service';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage';
import { detectFileType, safeFileName } from '../storage/file-type';
import { MALWARE_SCANNER, type MalwareScanner } from '../storage/malware-scanner';
import { CommsAccessService } from './comms-access.service';
import { commsDb } from './comms-errors';
import { commsFileSelect, toFileView, type CommsFileRow } from './comms-file-view';
import { MeetingService } from './meeting.service';
import { CommsRealtimePublisher } from './realtime/comms-realtime.publisher';

/** A file as Multer hands it over (memory storage). */
export interface CommsUploadedFile {
  originalname: string;
  size: number;
  buffer: Buffer;
}

export const COMMS_FILE_SCAN_JOB = 'comms.file.scan';
const RESCAN_AFTER_MS = 60_000;

type Tx = Prisma.TransactionClient;
type FileRow = CommsFileRow;
const fileSelect = commsFileSelect;

const notFound = (): never => {
  throw new NotFoundException({ statusCode: 404, code: 'not_found', message: 'File not found' });
};

/**
 * Module 14 file sharing (plan section 19: "File sharing with file-type and size limits, malware scanning, private storage
 * and permission-checked download links").
 *  - Type and size: PDF, PNG, JPEG or Word (.docx), recognised from the first bytes, at most 10 MB.
 *  - Private storage: the bytes go to the FileStorage (a private folder or a cloud bucket), never to a public folder.
 *  - Scanning: every file is checked by ClamAV right after the upload. Until a check says "clean" the file cannot be
 *    opened by anyone. Malware: the file is blocked for good and its bytes are removed (the record and the finding stay,
 *    audited). Scanner down: the file waits, and a job checks it again with growing delays (FAIL CLOSED).
 *  - Downloads: through the API only, checked every time with the same rules as the message or meeting the file belongs
 *    to (a member, within their history; the message not deleted; or the meeting's organizer and invitees). Audited.
 */
@Injectable()
export class CommsFileService implements OnModuleInit {
  private readonly logger = new Logger(CommsFileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly access: CommsAccessService,
    private readonly meetings: MeetingService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly jobs: JobRunner,
    private readonly realtime: CommsRealtimePublisher,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
    @Inject(MALWARE_SCANNER) private readonly scanner: MalwareScanner,
  ) {}

  onModuleInit(): void {
    this.jobs.register(COMMS_FILE_SCAN_JOB, async (payload) => {
      const outcome = await this.scan(String(payload.fileId));
      // Still no answer from the scanner: fail the job so the runner tries again later (with a growing delay).
      if (outcome === 'unavailable') throw new Error('Malware scanner unavailable');
    });
  }

  // ---------- uploads ----------

  /** A file for a message in this conversation (attached when the message is sent). Members who may post only. */
  async uploadToConversation(actor: Actor, conversationId: string, file: CommsUploadedFile | undefined, client: RequestInfo): Promise<CommsFileView> {
    const access = await this.access.memberAccess(actor, conversationId);
    if (access.conversation.archivedAt) throw new ConflictException({ statusCode: 409, code: 'conversation_archived', message: 'This conversation is archived: it can be read but not changed' });
    if (!this.access.capabilities(access).post) throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message: 'You cannot share files here' });
    return this.store(actor, file, { conversationId: access.conversation.id }, `comms/conversations/${access.conversation.id}`, client);
  }

  /** A file for a meeting: its organizer, while it is not cancelled. */
  async uploadToMeeting(actor: Actor, meetingId: string, file: CommsUploadedFile | undefined, client: RequestInfo): Promise<CommsFileView> {
    const meeting = await this.meetings.visible(actor, meetingId);
    if (meeting.organizerId !== actor.id) throw new ForbiddenException({ statusCode: 403, code: 'organizer_only', message: 'Only the organizer can add files' });
    if (meeting.cancelledAt) throw new ConflictException({ statusCode: 409, code: 'meeting_cancelled', message: 'This meeting was cancelled: it can be read but not changed' });
    return this.store(actor, file, { meetingId: meeting.id }, `comms/meetings/${meeting.id}`, client);
  }

  private async store(actor: Actor, file: CommsUploadedFile | undefined, owner: { conversationId?: string; meetingId?: string }, folder: string, client: RequestInfo): Promise<CommsFileView> {
    if (!file?.buffer?.length) throw new BadRequestException({ statusCode: 400, code: 'file_required', message: 'Choose a file' });
    if (file.size > COMMS_FILE_MAX_BYTES || file.buffer.length > COMMS_FILE_MAX_BYTES) {
      throw new PayloadTooLargeException({ statusCode: 413, code: 'file_too_large', message: 'A file can be at most 10 MB' });
    }
    const detected = detectFileType(file.buffer);
    if (!detected) throw new BadRequestException({ statusCode: 400, code: 'file_type_not_allowed', message: 'Only PDF, PNG, JPEG and Word (.docx) files can be shared' });
    await this.checkUploadRate(actor);
    const id = randomUUID();
    const key = `${folder}/${id}${detected.ext}`;
    // Checked in memory BEFORE anything is written: with the scanner up, malware never reaches the storage at all.
    const result = await this.scanner.scan(file.buffer);
    const now = this.clock.now();
    const stored = result.verdict !== 'infected';
    if (stored) await this.storage.put(key, file.buffer);
    try {
      await commsDb(() =>
        this.prisma.$transaction(async (tx) => {
          await tx.commsFile.create({
            data: {
              id,
              ...owner,
              uploaderId: actor.id,
              fileName: safeFileName(file.originalname),
              mimeType: detected.mime,
              sizeBytes: file.buffer.length,
              sha256: createHash('sha256').update(file.buffer).digest('hex'),
              storageKey: key,
              createdAt: now,
            },
          });
          // Ids, size and type only: a file's name can itself be private.
          await this.audit.record({ actorId: actor.id, action: 'comms.file.uploaded', targetType: 'comms_file', targetId: id, details: { ...owner, sizeBytes: file.buffer.length, mimeType: detected.mime }, ...client }, tx);
          if (result.verdict === 'clean') {
            await tx.commsFile.update({ where: { id }, data: { scanStatus: 'clean', scannedAt: now } });
          } else if (result.verdict === 'infected') {
            await tx.commsFile.update({ where: { id }, data: { scanStatus: 'blocked', scanSignature: result.signature, scannedAt: now } });
            await this.audit.record({ actorId: actor.id, action: 'comms.file.blocked', targetType: 'comms_file', targetId: id, outcome: 'denied', details: { signature: result.signature }, ...client }, tx);
          }
        }),
      );
    } catch (error) {
      if (stored) await this.storage.remove(key);
      throw error;
    }
    if (result.verdict === 'unavailable') {
      // Scanner down: the file is kept, unopenable, and checked again later (fail closed).
      this.logger.warn(`comms file ${id}: malware scanner unavailable (${result.reason}); it stays unopenable and is checked again later`);
      await this.jobs.schedule(COMMS_FILE_SCAN_JOB, `${COMMS_FILE_SCAN_JOB}:${id}`, new Date(now.getTime() + RESCAN_AFTER_MS), { fileId: id }, actor.id);
    }
    return this.viewOf(id);
  }

  /**
   * Per person, like the message limit (counted from the database, so every server applies the same limit): at most
   * COMMS_UPLOADS_PER_MINUTE uploads in any minute and COMMS_UPLOADS_PER_HOUR in any hour. Every accepted upload counts
   * (also one later blocked, or never sent). 429 with retryAfterSec.
   */
  private async checkUploadRate(actor: Actor): Promise<void> {
    const now = this.clock.now().getTime();
    for (const [windowMs, max] of [
      [60_000, COMMS_UPLOADS_PER_MINUTE],
      [3_600_000, COMMS_UPLOADS_PER_HOUR],
    ] as const) {
      const recent = await commsDb(() =>
        this.prisma.commsFile.findMany({ where: { uploaderId: actor.id, createdAt: { gt: new Date(now - windowMs) } }, orderBy: { createdAt: 'desc' }, take: max, select: { createdAt: true } }),
      );
      if (recent.length >= max) {
        const oldest = recent[recent.length - 1].createdAt.getTime();
        const retryAfterSec = Math.max(1, Math.ceil((oldest + windowMs - now) / 1000));
        throw new HttpException({ statusCode: 429, code: 'rate_limited', message: 'You are uploading files too quickly. Please wait a moment.', retryAfterSec }, 429);
      }
    }
  }

  // ---------- scanning ----------

  /**
   * Checks again a file that is still "scanning" (the scanner was down when it was uploaded). clean / blocked are final;
   * `unavailable` leaves it waiting, and the job runner tries again later. A file attached to a message tells the open
   * screens when its check finished.
   */
  async scan(fileId: string): Promise<'clean' | 'blocked' | 'unavailable' | 'done'> {
    const file = await commsDb(() =>
      this.prisma.commsFile.findUnique({ where: { id: fileId }, select: { id: true, storageKey: true, scanStatus: true, conversationId: true, messageId: true, discardedAt: true } }),
    );
    if (!file || file.scanStatus !== 'scanning' || file.discardedAt) return 'done';
    let bytes: Buffer;
    try {
      bytes = await this.storage.get(file.storageKey);
    } catch {
      this.logger.error(`comms file ${file.id}: stored bytes are missing; it stays unopenable`);
      return 'unavailable';
    }
    const result = await this.scanner.scan(bytes);
    if (result.verdict === 'unavailable') {
      this.logger.warn(`comms file ${file.id}: malware scanner still unavailable (${result.reason}); checked again later`);
      return 'unavailable';
    }
    const now = this.clock.now();
    const blocked = result.verdict === 'infected';
    const eventId = await commsDb(() =>
      this.prisma.$transaction(async (tx) => {
        const { count } = await tx.commsFile.updateMany({
          where: { id: file.id, scanStatus: 'scanning' },
          data: blocked ? { scanStatus: 'blocked', scanSignature: result.signature, scannedAt: now } : { scanStatus: 'clean', scannedAt: now },
        });
        if (!count) return null; // another server finished it first
        if (blocked) {
          await this.audit.record({ actorId: null, action: 'comms.file.blocked', targetType: 'comms_file', targetId: file.id, outcome: 'denied', details: { signature: result.signature } }, tx);
        }
        if (file.messageId && file.conversationId) {
          return this.outbox.emit({ type: 'comms.message.changed', actor: 'system', payload: { conversationId: file.conversationId, messageId: file.messageId, change: 'file_scanned' } }, tx);
        }
        return undefined;
      }),
    );
    if (eventId === null) return 'done';
    // Malware: the bytes go (the record and the finding stay).
    if (blocked) await this.storage.remove(file.storageKey).catch(() => this.logger.error(`comms file ${file.id}: could not remove the blocked bytes`));
    if (eventId && file.messageId && file.conversationId) await this.realtime.messageUpdated(file.conversationId, file.messageId, eventId);
    return blocked ? 'blocked' : 'clean';
  }

  // ---------- messages ----------

  /** Before a send: the files must be the sender's own, uploaded to this conversation, not attached yet, not blocked. */
  async checkAttachable(actor: Actor, conversationId: string, ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    const n = await commsDb(() =>
      this.prisma.commsFile.count({ where: { id: { in: [...ids] }, uploaderId: actor.id, conversationId, messageId: null, discardedAt: null, scanStatus: { not: 'blocked' } } }),
    );
    if (n !== ids.length) throw new BadRequestException({ statusCode: 400, code: 'invalid_attachments', message: 'A file is not yours to attach here, was already sent, was discarded or was blocked' });
  }

  /** Inside the send transaction: attaches the files to the new message (the same checks again, under the write). */
  async attach(tx: Tx, actor: Actor, conversationId: string, messageId: string, ids: readonly string[]): Promise<void> {
    if (!ids.length) return;
    // Under the row locks of this update: a file attached by a concurrent send, or discarded by the cleanup meanwhile, is
    // not matched, so the count is short and the whole send is rolled back (one file is never on two messages).
    const { count } = await tx.commsFile.updateMany({
      where: { id: { in: [...ids] }, uploaderId: actor.id, conversationId, messageId: null, discardedAt: null, scanStatus: { not: 'blocked' } },
      data: { messageId },
    });
    if (count !== ids.length) throw new BadRequestException({ statusCode: 400, code: 'invalid_attachments', message: 'A file is not yours to attach here, was already sent, was discarded or was blocked' });
  }

  /** The files of these messages, by message. */
  async byMessage(db: Tx | PrismaService, messageIds: readonly string[]): Promise<Map<string, CommsFileView[]>> {
    const out = new Map<string, CommsFileView[]>();
    if (!messageIds.length) return out;
    const rows = await db.commsFile.findMany({ where: { messageId: { in: [...messageIds] } }, select: fileSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
    for (const r of rows) (out.get(r.messageId!) ?? out.set(r.messageId!, []).get(r.messageId!)!).push(toFileView(r));
    return out;
  }

  /** The files of a meeting, oldest first. */
  async byMeeting(meetingId: string): Promise<CommsFileView[]> {
    const rows = await commsDb(() => this.prisma.commsFile.findMany({ where: { meetingId }, select: fileSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] }));
    return rows.map(toFileView);
  }

  // ---------- reading ----------

  /** GET /comms/files/:id: the file's details and scan state, for anyone who may see it. */
  async view(actor: Actor, fileId: string): Promise<CommsFileView> {
    return toFileView(await this.accessible(actor, fileId));
  }

  /** GET /comms/files/:id/download: the bytes, after the access check, only once the scan says clean. Audited. */
  async download(actor: Actor, fileId: string, client: RequestInfo): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
    const file = await this.accessible(actor, fileId);
    if (file.discardedAt) throw new GoneException({ statusCode: 410, code: 'file_discarded', message: 'This file was never sent, so it was removed' });
    if (file.scanStatus === 'scanning') throw new ConflictException({ statusCode: 409, code: 'file_scanning', message: 'This file is still being checked for viruses. Try again in a moment.' });
    if (file.scanStatus === 'blocked') throw new GoneException({ statusCode: 410, code: 'file_blocked', message: 'This file was blocked because malware was found in it' });
    const buffer = await this.storage.get(file.storageKey);
    await this.audit.record({ actorId: actor.id, action: 'comms.file.downloaded', targetType: 'comms_file', targetId: file.id, details: { conversationId: file.conversationId, meetingId: file.meetingId }, ...client });
    return { buffer, mimeType: file.mimeType, fileName: file.fileName };
  }

  private async viewOf(id: string): Promise<CommsFileView> {
    return toFileView(await commsDb(() => this.prisma.commsFile.findUniqueOrThrow({ where: { id }, select: fileSelect })));
  }

  /**
   * The same rules as what the file belongs to. Not attached yet: its uploader only. A message's file: a current member
   * whose history includes the message, which is not deleted. A meeting's file: the organizer and the people invited.
   * Anything else: "not found" (never revealing that the file exists).
   */
  private async accessible(actor: Actor, fileId: string): Promise<FileRow> {
    const file = await commsDb(() => this.prisma.commsFile.findUnique({ where: { id: fileId }, select: fileSelect }));
    if (!file) notFound();
    const f = file!;
    if (f.meetingId) {
      await this.meetings.visible(actor, f.meetingId);
      return f;
    }
    if (!f.messageId) {
      if (f.uploaderId !== actor.id) notFound();
      await this.access.memberAccess(actor, f.conversationId!);
      return f;
    }
    const { fromSeq } = await this.access.memberAccess(actor, f.conversationId!);
    const message = await commsDb(() => this.prisma.message.findUnique({ where: { id: f.messageId! }, select: { seq: true, deletedAt: true } }));
    if (!message || message.deletedAt || message.seq <= fromSeq) notFound();
    return f;
  }
}
