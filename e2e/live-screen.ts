import { expect, type Page, type Response } from '@playwright/test';
import { hasSecret, nextCode, PASSWORD, type ApiClient } from './auth-helpers';

/**
 * Shared checks for the M7 to M9 live screens: a screen must load its data from the REAL API (a 2xx answer from the
 * expected endpoint), with no server error and no crash in the page.
 */
export async function screenLoadsFromServer(page: Page, path: string, endpoint: RegExp): Promise<Response[]> {
  const api: Response[] = [];
  const pageErrors: string[] = [];
  page.on('response', (r) => {
    if (r.url().includes('/api/v1/')) api.push(r);
  });
  page.on('pageerror', (e) => pageErrors.push(e.message));
  const expected = page.waitForResponse((r) => endpoint.test(new URL(r.url()).pathname) && r.request().method() === 'GET', { timeout: 30_000 });
  await page.goto(path);
  const res = await expected;
  expect(res.status(), `${path}: ${res.url()}`).toBeLessThan(300);
  await page.waitForLoadState('networkidle');
  expect(api.filter((r) => r.status() >= 500).map((r) => `${r.status()} ${r.url()}`), `${path}: server errors`).toEqual([]);
  expect(pageErrors, `${path}: errors in the page`).toEqual([]);
  await expect(page.getByText(/Something went wrong/i)).toHaveCount(0);
  return api;
}

/** "Confirm again" through the real API for a person's API session (password, and the authenticator code when they use one). */
export async function stepUpApi(client: ApiClient, empId: string): Promise<void> {
  const res = await client.post('/auth/step-up', { password: PASSWORD, ...(hasSecret(empId) ? { code: nextCode(empId) } : {}) });
  expect(res.status(), `step-up for ${empId}`).toBe(200);
}
