import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where the test backend keeps uploaded files (a throw-away folder, never the real private storage). */
export const E2E_FILES = join(tmpdir(), 'aceva-e2e-private-files');

/** The test-only HR officer added to the test database (the demo seed has no separate HR person; the Director holds HR duty). */
export const FIXTURE_HR = 'ACV-0015';
