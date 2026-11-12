import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import type { FileStorage } from './file-storage';

/** Stores files in a private folder on this computer (development). */
export class LocalFileStorage implements FileStorage {
  private readonly root: string;

  constructor(root: string) {
    this.root = resolve(root);
  }

  async put(key: string, data: Buffer): Promise<void> {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
  }

  async get(key: string): Promise<Buffer> {
    return readFile(this.pathFor(key));
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }

  async remove(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  /** Turns a key into a path and refuses anything that would escape the storage folder. */
  private pathFor(key: string): string {
    if (!key || key.includes('\0')) {
      throw new Error('Invalid storage key');
    }
    const path = resolve(this.root, key);
    const rel = relative(this.root, path);
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('Invalid storage key');
    }
    return path;
  }
}
