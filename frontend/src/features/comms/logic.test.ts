import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Module 14 rules the screens apply before asking the server: the retention notice and the file limits. The live limits
 * must be exactly the server's (PDF, PNG, JPEG, Word; 10 MB); the demo keeps its wider list.
 */
async function loadLogic(liveModules: string) {
  vi.resetModules();
  vi.stubEnv('NEXT_PUBLIC_LIVE_MODULES', liveModules);
  vi.stubEnv('NEXT_PUBLIC_API_MODE', 'mock');
  return import('./logic');
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('retentionNotice', () => {
  it('says plainly that nothing is set and everything is kept', async () => {
    const { retentionNotice } = await loadLogic('m14');
    expect(retentionNotice({ messageRetentionDays: null, fileRetentionDays: null })).toBe('Retention: management has not set the periods yet, so messages and files are kept.');
  });

  it('names the periods in years or days, says which is not set, and that nothing is removed automatically yet', async () => {
    const { retentionNotice } = await loadLogic('m14');
    expect(retentionNotice({ messageRetentionDays: 730, fileRetentionDays: 365 })).toBe(
      'Retention set by management: messages 2 years, files 1 year. Automatic removal is not switched on yet.',
    );
    expect(retentionNotice({ messageRetentionDays: 90, fileRetentionDays: null })).toBe(
      'Retention set by management: messages 90 days, files not set yet. Automatic removal is not switched on yet.',
    );
  });
});

describe('checkFile (live: the server rules)', () => {
  it('accepts PDF, PNG, JPEG and Word files up to 10 MB', async () => {
    const { checkFile, FILE_LIMIT_BYTES, ALLOWED_EXTENSIONS } = await loadLogic('m1,m14');
    expect(FILE_LIMIT_BYTES).toBe(10 * 1024 * 1024);
    expect(ALLOWED_EXTENSIONS).toEqual(['pdf', 'png', 'jpg', 'jpeg', 'docx']);
    for (const name of ['plan.pdf', 'screen.PNG', 'photo.jpg', 'photo.jpeg', 'notes.docx']) expect(checkFile(name, 1000)).toBeNull();
    expect(checkFile('big.pdf', 10 * 1024 * 1024)).toBeNull();
  });

  it('refuses other types and anything over 10 MB, saying why', async () => {
    const { checkFile } = await loadLogic('m14');
    expect(checkFile('tool.exe', 10)).toMatch(/can't be shared/);
    expect(checkFile('sheet.xlsx', 10)).toMatch(/can't be shared/);
    expect(checkFile('noextension', 10)).toMatch(/can't be shared/);
    expect(checkFile('big.pdf', 10 * 1024 * 1024 + 1)).toBe('Files must be 10 MB or smaller.');
  });
});

describe('checkFile (demo)', () => {
  it('keeps the demo limits when Module 14 is not live', async () => {
    const { checkFile, FILE_LIMIT_BYTES } = await loadLogic('m1');
    expect(FILE_LIMIT_BYTES).toBe(25 * 1024 * 1024);
    expect(checkFile('sheet.xlsx', 10)).toBeNull();
    expect(checkFile('big.pdf', 25 * 1024 * 1024 + 1)).toBe('Files must be 25 MB or smaller.');
  });
});
