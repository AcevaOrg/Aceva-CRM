import { expect, type Page, type WebSocket } from '@playwright/test';
import { PASSWORD, nextCode } from './auth-helpers';

/**
 * Opens a page and waits until its live connection is signed in (the server's first event is the presence snapshot).
 * The page that was open before may still open (and then close) a socket of its own, so the one that counts is a socket
 * that received the snapshot and is still open after the navigation. (Same as in m14-live.spec.ts.)
 */
export async function goLive(page: Page, path: string): Promise<WebSocket> {
  const ready = new Set<WebSocket>();
  page.on('websocket', (ws) => {
    if (!ws.url().includes('/socket.io/')) return;
    ws.on('framereceived', (f) => {
      if (String(f.payload).includes('presence.snapshot')) ready.add(ws);
    });
  });
  await page.goto(path);
  let live: WebSocket | undefined;
  await expect
    .poll(() => (live = [...ready].find((ws) => !ws.isClosed())) !== undefined, { timeout: 20_000, message: `a signed-in live connection on ${path}` })
    .toBe(true);
  return live!;
}

/** The row of one message on a conversation screen, found by its exact text. */
export const messageRow = (page: Page, text: string) => page.locator('[id^="msg-"]').filter({ has: page.getByText(text, { exact: true }) });

/** Opens a message's "More actions" menu. */
export async function messageMenu(page: Page, text: string): Promise<void> {
  const row = messageRow(page, text);
  await row.hover();
  await row.getByRole('button', { name: 'More actions' }).click();
}

/** Answers the shared reason dialog. */
export async function giveReason(page: Page, reason: string, confirm: string): Promise<void> {
  // The dialog with the reason box (a "confirm it's you" dialog may still be closing on top of the page).
  const dialog = page.getByRole('dialog').filter({ has: page.locator('textarea') });
  await dialog.locator('textarea').fill(reason);
  await dialog.getByRole('button', { name: confirm, exact: true }).click();
}

/** A real authenticator code (each code works once; wait for the next 30-second window when two were just used). */
async function freshCode(empId: string): Promise<string> {
  for (let i = 0; i < 40; i++) {
    try {
      return await nextCode(empId);
    } catch {
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
  throw new Error('No authenticator code available');
}

/** The "confirm it's you" dialog in the browser: the SERVER checks the password and the code. (As in m3-live.spec.ts.) */
export async function stepUpInUi(page: Page, empId: string): Promise<void> {
  await page.locator('#stepup-pw').fill(PASSWORD);
  await page.locator('input[aria-label="Digit 1"]').click();
  await page.keyboard.type(await freshCode(empId));
  await page.getByRole('button', { name: 'Confirm' }).click();
}
