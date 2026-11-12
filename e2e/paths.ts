import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Where the test backend keeps uploaded files (a throw-away folder, never the real private storage). */
export const E2E_FILES = join(tmpdir(), 'aceva-e2e-private-files');

/** Test-only people added to the test database (the demo seed has no CEO or HR officer). The HR officer is created first. */
export const FIXTURE_HR = 'ACV-0015';
export const FIXTURE_CEO = 'ACV-0016';
