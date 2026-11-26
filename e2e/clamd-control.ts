import { execFileSync, spawn } from 'node:child_process';
import { connect } from 'node:net';
import { expect } from '@playwright/test';

/**
 * Stops and starts the LOCAL ClamAV daemon, for the test that checks a file uploaded while the scanner is down is
 * checked later and shown live once clean. It needs where clamd is installed:
 *   CLAMD_EXE   path to clamd(.exe)
 *   CLAMD_CONF  path to its clamd.conf (TCPSocket 3310, TCPAddr 127.0.0.1)
 * (docs/SETUP.md, "Module 14 file scanning"). Without them the test fails with this message instead of being skipped.
 */
export function clamdPaths(): { exe: string; conf: string } {
  const exe = process.env.CLAMD_EXE;
  const conf = process.env.CLAMD_CONF;
  if (!exe || !conf) throw new Error('Set CLAMD_EXE and CLAMD_CONF (docs/SETUP.md) to run the scanner-outage test');
  return { exe, conf };
}

function portOpen(port = 3310): Promise<boolean> {
  return new Promise((resolve) => {
    const s = connect({ host: '127.0.0.1', port });
    s.once('connect', () => {
      s.destroy();
      resolve(true);
    });
    s.once('error', () => resolve(false));
  });
}

export async function stopClamd(): Promise<void> {
  if (process.platform === 'win32') {
    try {
      execFileSync('taskkill', ['/IM', 'clamd.exe', '/F'], { stdio: 'ignore' });
    } catch {
      // not running
    }
  } else {
    try {
      execFileSync('pkill', ['-x', 'clamd'], { stdio: 'ignore' });
    } catch {
      // not running
    }
  }
  await expect.poll(() => portOpen(), { timeout: 30_000, message: 'clamd stopped' }).toBe(false);
}

export async function startClamd(): Promise<void> {
  const { exe, conf } = clamdPaths();
  if (await portOpen()) return;
  spawn(exe, [`--config-file=${conf}`, '--foreground'], { detached: true, stdio: 'ignore' }).unref();
  await expect.poll(() => portOpen(), { timeout: 180_000, intervals: [2_000], message: 'clamd started' }).toBe(true);
}
