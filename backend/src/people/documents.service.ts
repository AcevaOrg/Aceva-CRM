import { createHash, randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException, Inject, Injectable, NotFoundException, PayloadTooLargeException } from '@nestjs/common';
import { documentTypeSchema, type DocumentView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { PrismaService } from '../prisma/prisma.service';
import { detectFileType, safeFileName } from '../storage/file-type';
import { FILE_STORAGE, type FileStorage } from '../storage/file-storage';
import { PeopleService } from './people.service';

export const MAX_DOCUMENT_BYTES = 10 * 1024 * 1024;
export const MAX_PHOTO_BYTES = 2 * 1024 * 1024;

export interface UploadedFile {
  originalname: string;
  buffer: Buffer;
  size: number;
}

/** Documents (CV, contract, CNIC copy, certificates) and the profile photo, kept in PRIVATE storage. */
@Injectable()
export class DocumentsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly people: PeopleService,
    private readonly audit: AuditService,
    @Inject(FILE_STORAGE) private readonly storage: FileStorage,
  ) {}

  /** Visible to the employee, HR, Director and above (the same audience as Personal details). */
  async list(actor: Actor, empId: string, client: RequestInfo): Promise<DocumentView[]> {
    const target = await this.people.requireTarget(empId);
    const access = await this.people.accessFor(actor, target);
    if (!access.see.documents) return this.deny(actor, 'documents_not_allowed', empId, client);
    return this.viewsOf(target.id);
  }

  viewsOf(employeeId: string): Promise<DocumentView[]> {
    return this.people.documentList(employeeId);
  }

  async upload(actor: Actor, empId: string, file: UploadedFile | undefined, fields: { type?: string; title?: string }, client: RequestInfo): Promise<DocumentView> {
    const target = await this.people.requireTarget(empId);
    const access = await this.people.accessFor(actor, target);
    if (!access.edit.documents) return this.deny(actor, 'document_upload_not_allowed', empId, client);

    const parsedType = documentTypeSchema.safeParse(fields.type);
    if (!parsedType.success) throw new BadRequestException({ statusCode: 400, code: 'invalid_type', message: 'Choose what kind of document this is' });
    const type = parsedType.data;
    // An employee adds their own CV, CNIC copy and certificates; the contract is added by HR or the Director.
    if (access.isSelf && !access.edit.job && type === 'contract') return this.deny(actor, 'contract_upload_not_allowed', empId, client);

    const detected = this.checkFile(file, MAX_DOCUMENT_BYTES);
    const key = `employees/${target.id}/documents/${randomUUID()}${detected.ext}`; // generated, never the uploaded name
    await this.storage.put(key, file!.buffer);
    try {
      const created = await this.prisma.$transaction(async (tx) => {
        const row = await tx.employeeDocument.create({
          data: {
            employeeId: target.id,
            type,
            title: (fields.title?.trim() || safeFileName(file!.originalname)).slice(0, 120),
            storageKey: key,
            originalFilename: safeFileName(file!.originalname),
            mimeType: detected.mime,
            sizeBytes: file!.size,
            sha256: createHash('sha256').update(file!.buffer).digest('hex'),
            createdBy: actor.id,
          },
        });
        await this.audit.record({ actorId: actor.id, action: 'employee.document.uploaded', targetType: 'employee', targetId: empId, details: { type, sizeBytes: file!.size, documentId: row.id }, ...client }, tx);
        return row;
      });
      return (await this.viewsOf(target.id)).find((d) => d.id === created.id)!;
    } catch (error) {
      await this.storage.remove(key); // nothing is left behind when the record could not be saved
      throw error;
    }
  }

  /** The file, only after the same permission check as the list. Every download is logged. */
  async download(actor: Actor, empId: string, documentId: string, client: RequestInfo): Promise<{ buffer: Buffer; mimeType: string; fileName: string }> {
    const target = await this.people.requireTarget(empId);
    const access = await this.people.accessFor(actor, target);
    if (!access.see.documents) return this.deny(actor, 'documents_not_allowed', empId, client);
    const doc = await this.prisma.employeeDocument.findFirst({ where: { id: documentId, employeeId: target.id, archivedAt: null } });
    if (!doc) throw new NotFoundException('Document not found');
    const buffer = await this.storage.get(doc.storageKey);
    await this.audit.record({ actorId: actor.id, action: 'employee.document.downloaded', targetType: 'employee', targetId: empId, details: { documentId: doc.id, type: doc.type }, ...client });
    return { buffer, mimeType: doc.mimeType, fileName: doc.originalFilename };
  }

  /** Documents are archived, never deleted (the file stays in private storage). */
  async archive(actor: Actor, empId: string, documentId: string, client: RequestInfo): Promise<{ ok: true }> {
    const target = await this.people.requireTarget(empId);
    const access = await this.people.accessFor(actor, target);
    if (!access.edit.documents) return this.deny(actor, 'document_upload_not_allowed', empId, client);
    const { count } = await this.prisma.employeeDocument.updateMany({ where: { id: documentId, employeeId: target.id, archivedAt: null }, data: { archivedAt: new Date(), updatedBy: actor.id } });
    if (count === 0) throw new NotFoundException('Document not found');
    await this.audit.record({ actorId: actor.id, action: 'employee.document.archived', targetType: 'employee', targetId: empId, details: { documentId }, ...client });
    return { ok: true };
  }

  // ----------------------------------------------------------------- photo

  /** The employee, or Director/HR for people of lower rank. JPEG or PNG, at most 2 MB. */
  async setPhoto(actor: Actor, empId: string, file: UploadedFile | undefined, client: RequestInfo): Promise<{ ok: true }> {
    const target = await this.people.requireTarget(empId);
    const access = await this.people.accessFor(actor, target);
    if (!access.isSelf && !access.edit.basic) return this.deny(actor, 'photo_upload_not_allowed', empId, client);
    const detected = this.checkFile(file, MAX_PHOTO_BYTES);
    if (detected.mime !== 'image/jpeg' && detected.mime !== 'image/png') {
      throw new BadRequestException({ statusCode: 400, code: 'not_an_image', message: 'The photo must be a JPEG or PNG image' });
    }
    const key = `employees/${target.id}/photo/${randomUUID()}${detected.ext}`;
    await this.storage.put(key, file!.buffer);
    const previous = target.photoKey;
    await this.prisma.$transaction(async (tx) => {
      await tx.employee.update({ where: { id: target.id }, data: { photoKey: key, updatedBy: actor.id } });
      await tx.profileChange.create({ data: { employeeId: target.id, section: 'basic', field: 'Photo', oldValue: previous ? 'photo' : null, newValue: 'new photo', changedBy: actor.id } });
      await this.audit.record({ actorId: actor.id, action: 'employee.photo.updated', targetType: 'employee', targetId: empId, ...client }, tx);
    });
    if (previous) await this.storage.remove(previous);
    return { ok: true };
  }

  /** The photo is Basic information: any logged-in employee may see it. */
  async photo(empId: string): Promise<{ buffer: Buffer; mimeType: string }> {
    const row = await this.prisma.employee.findUnique({ where: { empId }, select: { photoKey: true } });
    if (!row?.photoKey) throw new NotFoundException('No photo');
    const buffer = await this.storage.get(row.photoKey);
    return { buffer, mimeType: row.photoKey.endsWith('.png') ? 'image/png' : 'image/jpeg' };
  }

  private checkFile(file: UploadedFile | undefined, maxBytes: number) {
    if (!file || file.size === 0) throw new BadRequestException({ statusCode: 400, code: 'no_file', message: 'Choose a file to upload' });
    if (file.size > maxBytes) throw new PayloadTooLargeException(`The file is too large (limit ${Math.round(maxBytes / 1024 / 1024)} MB)`);
    const detected = detectFileType(file.buffer);
    if (!detected) throw new BadRequestException({ statusCode: 400, code: 'file_type_not_allowed', message: 'Only PDF, PNG, JPEG and Word (.docx) files are accepted' });
    return detected;
  }

  private async deny(actor: Actor, reason: string, targetEmpId: string, client: RequestInfo): Promise<never> {
    await this.audit.record({ actorId: actor.id, action: 'access.denied', targetType: 'employee', targetId: targetEmpId, outcome: 'denied', reason, ...client });
    throw new ForbiddenException({ statusCode: 403, code: 'forbidden', message: 'You do not have access to this' });
  }
}
