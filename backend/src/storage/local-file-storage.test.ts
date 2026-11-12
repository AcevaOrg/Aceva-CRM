import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LocalFileStorage } from './local-file-storage';

describe('LocalFileStorage', () => {
  let dir: string;
  let storage: LocalFileStorage;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'aceva-storage-'));
    storage = new LocalFileStorage(dir);
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('stores, reads, checks and removes a file', async () => {
    await storage.put('employees/abc/cv/file.pdf', Buffer.from('hello'));
    expect(await storage.exists('employees/abc/cv/file.pdf')).toBe(true);
    expect((await storage.get('employees/abc/cv/file.pdf')).toString()).toBe('hello');
    await storage.remove('employees/abc/cv/file.pdf');
    expect(await storage.exists('employees/abc/cv/file.pdf')).toBe(false);
  });

  it('refuses keys that try to escape the storage folder', async () => {
    await expect(storage.put('../outside.txt', Buffer.from('x'))).rejects.toThrow('Invalid storage key');
    await expect(storage.get('..\\..\\secret.txt')).rejects.toThrow('Invalid storage key');
    await expect(storage.get('')).rejects.toThrow('Invalid storage key');
  });
});
