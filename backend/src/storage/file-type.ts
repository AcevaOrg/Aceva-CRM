export interface DetectedFile {
  mime: string;
  ext: string;
}

/**
 * What the file REALLY is, from its first bytes (never from the name or the type the browser claims).
 * Only formats employees legitimately need are allowed: PDF, PNG, JPEG and Word (.docx).
 */
export function detectFileType(buffer: Buffer): DetectedFile | null {
  if (buffer.length >= 5 && buffer.subarray(0, 5).toString('latin1') === '%PDF-') return { mime: 'application/pdf', ext: '.pdf' };
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return { mime: 'image/png', ext: '.png' };
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return { mime: 'image/jpeg', ext: '.jpg' };
  // .docx is a zip file that contains word/ entries
  if (buffer.length >= 4 && buffer.subarray(0, 4).equals(Buffer.from([0x50, 0x4b, 0x03, 0x04])) && buffer.includes(Buffer.from('word/'))) {
    return { mime: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', ext: '.docx' };
  }
  return null;
}

/** A file name that is safe to show and to put in a download header (no folders, no control characters). */
export function safeFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? 'file';
  // eslint-disable-next-line no-control-regex -- control characters are exactly what is being removed
  const cleaned = base.replace(/[\u0000-\u001f"<>|:*?\\/]/g, '_').trim().slice(0, 120);
  return cleaned || 'file';
}
