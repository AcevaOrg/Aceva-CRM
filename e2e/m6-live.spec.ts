import { expect, test } from '@playwright/test';
import { apiAs, openAs } from './auth-helpers';

/**
 * Module 6 (performance and results) driven through the real screens in Chromium and the real API, with the real
 * backend, PostgreSQL and Redis. The screens need Module 6 switched on: NEXT_PUBLIC_LIVE_MODULES must contain m6 for the
 * web server started by playwright.config.ts (m1,m2,m3,m5,m6). Scenario: nothing is invented (attendance and the sales
 * figures are "not available yet", no score for Sales), who may see whose results follows the reporting line, only the
 * Director saves score weights (whole percents that add up to 100, every version kept), a reviewer remark needs at least 3
 * characters on the screen, and an ordinary developer opening Performance leaves no blocked attempts.
 * Scorecards themselves are made by the monthly job and rated tasks; the DB tests (m6-*.test.ts) cover that part.
 */
const DIRECTOR = 'ACV-0003'; // reviews the CTO, Sales and Finance; the only one who saves weights
const CTO = 'ACV-0004'; // reviews Development; never sees Sales or Finance
const DEV = 'ACV-0006'; // developer, reports to the CTO
const SALES = 'ACV-0009'; // sales, reports to the Director
const FINANCE = 'ACV-0010'; // finance, reports to the Director
const OWNER = 'ACV-0001'; // the CEO / Founder / Owner: sees everything, view only

test.describe.configure({ mode: 'serial' });

interface Row {
  empId: string;
  kind: string;
  latest: { id: string; status: string; reviewerEmpId: string | null } | null;
}
interface Version {
  id: string;
  label: string;
  kind: string;
  departmentId?: string;
  weights: Record<string, number>;
  versionNo: number;
  createdBy: string | null;
}

const toast = (page: import('@playwright/test').Page, text: RegExp | string) => page.locator('[data-sonner-toast]').filter({ hasText: text }).first();

test('the developer sees live figures; attendance is "not available yet" and no number is made up', async ({ browser, playwright }) => {
  const dev = await openAs(browser, DEV, '/performance');
  await expect(dev.page.locator('h1').first()).toContainText('Performance');
  await expect(dev.page.getByText('Not available yet').first()).toBeVisible();
  await expect(dev.page.getByText(/Attendance arrives with the Attendance module/).first()).toBeVisible();
  await expect(dev.page.getByRole('tab', { name: /Team/ })).toHaveCount(0); // nobody below a developer
  await dev.context.close();

  const mine = await (await (await apiAs(playwright, DEV)).get('performance/live')).json();
  expect(mine.kind).toBe('standard');
  expect(mine.metrics.attendance).toBeNull();
  expect(mine.unmeasured).toEqual(expect.arrayContaining([{ key: 'attendance', reason: 'attendance_not_available' }]));
  // The weights come as whole percents that add up to exactly 100.
  expect(Object.values(mine.weights.weights as Record<string, number>).reduce((a, b) => a + b, 0)).toBe(100);
});

test('Sales has no sales score until the Sales module exists, and the figures are not invented', async ({ playwright }) => {
  const live = await (await (await apiAs(playwright, DIRECTOR)).get(`performance/live?empId=${SALES}`)).json();
  expect(live.kind).toBe('sales');
  expect(live.score).toBeNull();
  expect(live.band).toBeNull();
  expect(live.metrics.activity).toBeNull();
  expect(live.salesDetail).toBeUndefined();
  expect(live.unmeasured.some((u: { reason: string }) => u.reason === 'sales_not_available')).toBe(true);
});

test('who sees whose results follows the reporting line; the team table never ranks', async ({ playwright }) => {
  const dev = await apiAs(playwright, DEV);
  const cto = await apiAs(playwright, CTO);
  const director = await apiAs(playwright, DIRECTOR);
  const owner = await apiAs(playwright, OWNER);

  expect((await dev.get('performance/live')).status()).toBe(200);
  expect((await dev.get(`performance/live?empId=${CTO}`)).status()).toBe(403); // up the line
  expect((await dev.get('performance/team')).status()).toBe(403); // nobody below
  expect((await cto.get(`performance/live?empId=${DEV}`)).status()).toBe(200);
  expect((await cto.get(`performance/live?empId=${SALES}`)).status()).toBe(403); // Sales is not in the CTO's line
  expect((await cto.get(`performance/live?empId=${FINANCE}`)).status()).toBe(403);
  expect((await owner.get(`performance/live?empId=${DEV}`)).status()).toBe(200); // the Owner views everything

  const team = async (api: typeof cto) => ((await (await api.get('performance/team')).json()) as Row[]).map((r) => r.empId);
  const ctoTeam = await team(cto);
  expect(ctoTeam).toContain(DEV);
  expect(ctoTeam).not.toContain(SALES);
  expect(ctoTeam).not.toContain(FINANCE);
  const directorTeam = await team(director);
  expect(directorTeam).toEqual(expect.arrayContaining([CTO, DEV, SALES, FINANCE]));
  expect(directorTeam).not.toContain(DIRECTOR);
  expect(await team(owner)).toEqual(expect.arrayContaining([DIRECTOR, CTO, DEV, SALES, FINANCE]));
});

test('only the Director saves score weights: whole percents that add up to 100; every version is kept', async ({ browser, playwright }) => {
  const director = await apiAs(playwright, DIRECTOR);
  const cto = await apiAs(playwright, CTO);
  const dev = await apiAs(playwright, DEV);
  const owner = await apiAs(playwright, OWNER);
  const good = { quality: 30, onTime: 30, completion: 20, rework: 10, attendance: 10 };

  expect((await dev.get('settings/score-weights')).status()).toBe(403);
  expect((await cto.get('settings/score-weights')).status()).toBe(200); // may view
  expect((await owner.get('settings/score-weights')).status()).toBe(200);
  const before = (await (await director.get('settings/score-weights')).json()) as Version[];
  const current = before.find((v) => v.kind === 'standard' && !v.departmentId)!;
  expect(Object.values(current.weights).reduce((a, b) => a + b, 0)).toBe(100);
  expect(before.find((v) => v.kind === 'sales')).toBeTruthy();

  for (const who of [cto, owner, dev]) expect((await who.post('settings/score-weights', { kind: 'standard', weights: good, reason: 'E2E not allowed' })).status()).toBe(403);
  const short = await director.post('settings/score-weights', { kind: 'standard', weights: { ...good, attendance: 9 }, reason: 'E2E sum' });
  expect(short.status()).toBe(400);
  expect((await short.json()).code).toBe('weights_sum');
  const fraction = await director.post('settings/score-weights', { kind: 'standard', weights: { ...good, quality: 29.5, onTime: 30.5 }, reason: 'E2E whole' });
  expect(fraction.status()).toBe(400);
  expect((await fraction.json()).code).toBe('weights_whole');

  const saved = await director.post('settings/score-weights', { kind: 'standard', weights: good, reason: 'E2E deadlines matter more' });
  expect(saved.status()).toBe(201);
  const created = (await saved.json()) as Version;
  expect(created.versionNo).toBe(current.versionNo + 1);
  expect(created.createdBy).toBe(DIRECTOR);
  const after = (await (await director.get('settings/score-weights')).json()) as Version[];
  expect(after[0].id).toBe(created.id); // newest first
  expect(after).toHaveLength(before.length + 1);
  expect(after.find((v) => v.id === current.id)!.weights).toEqual(current.weights); // the old version is untouched

  // The Settings screen lists it (whole percents, the version label and who saved it).
  const view = await openAs(browser, DIRECTOR, '/settings?section=score-weights');
  await expect(view.page.getByRole('heading', { name: 'Score weights' })).toBeVisible();
  await expect(view.page.getByText(created.label).first()).toBeVisible();
  await expect(view.page.getByText('30 / 30 / 20 / 10 / 10').first()).toBeVisible();
  await view.context.close();
});

test('a reviewer remark needs at least 3 characters: 1 or 2 block saving and releasing, 3 or more unblock them', async ({ browser, playwright }) => {
  // The draft scorecard of a developer the CTO reviews (made by the monthly job at start-up). Nothing is saved or released here.
  const cto = await apiAs(playwright, CTO);
  let draftId: string | undefined;
  await expect
    .poll(
      async () => {
        const rows = (await (await cto.get('performance/team')).json()) as Row[];
        draftId = rows.find((r) => r.latest?.status === 'draft' && r.latest.reviewerEmpId === CTO)?.latest?.id;
        return draftId;
      },
      { timeout: 30_000, message: 'a draft scorecard waiting for the CTO' },
    )
    .toBeTruthy()
    .catch(() => undefined);
  test.skip(!draftId, 'No draft scorecard is waiting for the CTO (the monthly job has not made one in this database).');

  const view = await openAs(browser, CTO, `/performance/scorecards/${draftId}`);
  const remark = view.page.getByRole('textbox', { name: 'Reviewer remark' });
  const save = view.page.getByRole('button', { name: 'Save remark', exact: true });
  const saveAndRelease = view.page.getByRole('button', { name: 'Save and release', exact: true });
  const release = view.page.getByRole('button', { name: 'Release', exact: true });
  const tooShort = view.page.getByRole('alert').filter({ hasText: 'At least 3 characters.' });
  await expect(remark).toBeVisible();

  // Two characters: the server would refuse it, so the screen blocks saving and releasing and says why.
  await remark.fill('ok');
  await expect(tooShort).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(saveAndRelease).toBeDisabled();
  await expect(release).toBeDisabled();

  // A real remark unblocks them (nothing is clicked: the draft stays a draft).
  await remark.fill('Steady month: keep the reviews small and frequent.');
  await expect(tooShort).toHaveCount(0);
  await expect(save).toBeEnabled();
  await expect(saveAndRelease).toBeEnabled();
  await expect(release).toBeEnabled();
  await view.context.close();
});

test('ordinary staff opening Performance leave no blocked attempts', async ({ browser, playwright }) => {
  const startedAt = Date.now();
  const worker = await openAs(browser, DEV, '/performance');
  await expect(worker.page.locator('h1').first()).toContainText('Performance');
  await expect(toast(worker.page, /could not|couldn't/i)).toHaveCount(0);
  await worker.page.goto('/');
  await expect(worker.page.locator('h1').first()).toBeVisible();
  await worker.context.close();

  // Activity records are written about once a second; give the last request time to land before looking.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const director = await apiAs(playwright, DIRECTOR);
  const res = await director.get(`activity/events?empId=${DEV}&action=blocked`);
  expect(res.status()).toBe(200);
  const events = (await res.json()) as Array<{ at: string; description: string; target?: string }>;
  const fresh = events.filter((e) => new Date(e.at).getTime() >= startedAt - 1_000);
  expect(fresh, 'opening Performance or Home must not request anything the server refuses').toEqual([]);
});
