import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where the test backend keeps uploaded files (a throw-away folder, never the real private storage). */
export const E2E_FILES = join(tmpdir(), 'aceva-e2e-private-files');
