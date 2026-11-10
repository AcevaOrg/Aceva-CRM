/**
 * Private file storage for employee documents (and later payslips, receipts...).
 *
 * The rest of the app only talks to this interface. Today there is one implementation
 * (LocalFileStorage: a folder outside the web root). A cloud implementation (AWS S3 or
 * Cloudflare R2) can be added later without changing any calling code.
 *
 * Files are never served from a public folder. A download goes through the API, which
 * checks permissions first; a cloud implementation would hand out a short-lived signed link.
 */
export interface FileStorage {
  /** Saves bytes under a key such as "employees/<uuid>/cv/<uuid>.pdf". */
  put(key: string, data: Buffer): Promise<void>;
  /** Reads the bytes back. Throws if the key does not exist. */
  get(key: string): Promise<Buffer>;
  exists(key: string): Promise<boolean>;
  /** Removes a stored file (used only to clean up failed uploads; records are archived, not deleted). */
  remove(key: string): Promise<void>;
}

/** Injection token for the FileStorage implementation. */
export const FILE_STORAGE = Symbol('FILE_STORAGE');
