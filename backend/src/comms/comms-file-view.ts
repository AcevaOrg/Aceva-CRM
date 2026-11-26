import type { CommsFileView } from '@aceva/contracts';
import type { Prisma } from '../generated/prisma/client';

/** What every Module 14 screen needs to know about a shared file (never where its bytes are). */
export const commsFileSelect = {
  id: true,
  conversationId: true,
  messageId: true,
  meetingId: true,
  uploaderId: true,
  fileName: true,
  mimeType: true,
  sizeBytes: true,
  storageKey: true,
  scanStatus: true,
  createdAt: true,
  discardedAt: true,
  uploader: { select: { empId: true } },
} as const satisfies Prisma.CommsFileSelect;
export type CommsFileRow = Prisma.CommsFileGetPayload<{ select: typeof commsFileSelect }>;

export const toFileView = (f: CommsFileRow): CommsFileView => ({
  id: f.id,
  fileName: f.fileName,
  mimeType: f.mimeType,
  sizeBytes: f.sizeBytes,
  scan: f.scanStatus,
  uploaderEmpId: f.uploader.empId,
  uploadedAt: f.createdAt.toISOString(),
  discarded: f.discardedAt !== null,
});
