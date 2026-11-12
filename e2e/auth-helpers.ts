import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { type APIRequestContext, type Browser, type BrowserContext, type Page, type PlaywrightWorkerArgs, expect } from '@playwright/test';

type Playwright = PlaywrightWorkerArgs['playwright'];
import { generateSync } from 'otplib';

export const API = 'http://localhost:4100/api/v1';
/** The one password every demo person has in the test database (set when the database is rebuilt). */
export const PASSWORD = 'Demo-Passw0rd-2026';

const AUTH_DIR = join(__dirname, '.auth');
const SECRETS_FILE = join(AUTH_DIR, 'secrets.json');

interface TotpRecord {
  secret: string;
  /** The last 30-second step used, so the same code is never used twice. */
  lastStep: number;
}

function readSecrets(): Record<string, TotpRecord> {
  return existsSync(SECRETS_FILE) ? JSON.parse(readFileSync(SECRETS_FILE, 'utf8')) : {};
}
function writeSecrets(all: Record<string, TotpRecord>) {
  mkdirSync(AUTH_DIR, { recursive: true });
  writeFileSync(SECRETS_FILE, JSON.stringify(all));
}

/** The next usable authenticator code for a person (each code may be used once; one step of drift is accepted). */
export function nextCode(empId: string): string {
  const all = readSecrets();
  const rec = all[empId];
  if (!rec) throw new Error(`No authenticator secret stored for ${empId}`);
  const current = Math.floor(Date.now() / 30_000);
  const step = Math.max(current, rec.lastStep + 1);
  if (step > current + 1) throw new Error(`Too many codes used for ${empId} within 30 seconds`);
  rec.lastStep = step;
  all[empId] = rec;
  writeSecrets(all);
  return generateSync({ secret: rec.secret, epoch: step * 30 + 1 });
}

export function rememberSecret(empId: string, secret: string) {
  const all = readSecrets();
  all[empId] = { secret: secret.replace(/\s/g, ''), lastStep: 0 };
  writeSecrets(all);
}

export const hasSecret = (empId: string) => !!readSecrets()[empId];

/** Logs in through the real login screen, finishing the authenticator step when the server asks for it. */
export async function loginViaUi(page: Page, empId: string, password = PASSWORD): Promise<void> {
  await page.goto('/login');
  await page.locator('#empId').fill(empId.replace('ACV-', ''));
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: /^Sign in/ }).click();
  await page.waitForURL(/\/($|login\/(setup|verify)|first-login)/, { timeout: 30_000 });

  if (page.url().includes('/login/setup')) {
    const keyBox = page.locator('p.font-mono').first();
    await expect(keyBox).toHaveText(/^[A-Z2-7]{4}( [A-Z2-7]{4}){3,}$/); // wait until the key has loaded
    const key = await keyBox.innerText();
    rememberSecret(empId, key);
    await page.locator('input[aria-label="Digit 1"]').click();
    await page.keyboard.type(nextCode(empId));
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  } else if (page.url().includes('/login/verify')) {
    await page.locator('input[aria-label="Digit 1"]').click();
    await page.keyboard.type(nextCode(empId));
    await page.waitForURL((url) => !url.pathname.startsWith('/login'), { timeout: 30_000 });
  }
}

/** A browser window already logged in as this person (logs in once through the screen, then reuses the session). */
export async function openAs(browser: Browser, empId: string, path: string): Promise<{ page: Page; context: BrowserContext }> {
  const stateFile = join(AUTH_DIR, `${empId}.state.json`);
  if (!existsSync(stateFile)) {
    const loginContext = await browser.newContext();
    await loginViaUi(await loginContext.newPage(), empId);
    mkdirSync(AUTH_DIR, { recursive: true });
    await loginContext.storageState({ path: stateFile });
    await loginContext.close();
  }
  const context = await browser.newContext({ storageState: stateFile });
  const page = await context.newPage();
  await page.goto(path);
  return { page, context };
}

export interface ApiClient {
  get: (path: string) => ReturnType<APIRequestContext['get']>;
  post: (path: string, data?: unknown) => ReturnType<APIRequestContext['post']>;
  patch: (path: string, data?: unknown) => ReturnType<APIRequestContext['patch']>;
  delete: (path: string, data?: unknown) => ReturnType<APIRequestContext['delete']>;
}

const clients = new Map<string, ApiClient>();

/** Calls the real API directly as a person (own session, own CSRF token), the way any script or tool could. */
export async function apiAs(playwright: Playwright, empId: string): Promise<ApiClient> {
  const cached = clients.get(empId);
  if (cached) return cached;
  const ctx = await playwright.request.newContext({ baseURL: API + '/' });
  const login = await ctx.post('auth/login', { data: { empId, password: PASSWORD } });
  expect(login.status()).toBe(200);
  const body = await login.json();
  let csrf: string = body.csrfToken;
  let status: string = body.status;
  const h = () => ({ 'X-CSRF-Token': csrf });
  if (status === '2fa_setup_required') {
    const setup = await (await ctx.post('auth/2fa/setup', { headers: h(), data: {} })).json();
    rememberSecret(empId, setup.secret);
    status = '2fa_required';
  }
  if (status === '2fa_required') {
    const res = await ctx.post('auth/2fa/verify', { headers: h(), data: { code: nextCode(empId) } });
    expect(res.status()).toBe(200);
  }
  const rel = (p: string) => p.replace(/^\//, '');
  const client: ApiClient = {
    get: (p) => ctx.get(rel(p)),
    post: (p, data) => ctx.post(rel(p), { headers: h(), data: data ?? {} }),
    patch: (p, data) => ctx.patch(rel(p), { headers: h(), data: data ?? {} }),
    delete: (p, data) => ctx.delete(rel(p), { headers: h(), data: data ?? {} }),
  };
  clients.set(empId, client);
  return client;
}
