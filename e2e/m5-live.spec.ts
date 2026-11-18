import { expect, test } from '@playwright/test';
import { apiAs, openAs } from './auth-helpers';

/**
 * Module 5 (task management, size and deadline) driven through the real screens in Chromium, with the real backend,
 * PostgreSQL and Redis. The screens need Module 5 switched on: NEXT_PUBLIC_LIVE_MODULES must contain m5 for the web
 * server started by playwright.config.ts. Scenario: the Director assigns a task in the sheet, the developer starts and
 * submits it, the Director approves it with a rating; assigning goes down the hierarchy only; an extension keeps the
 * original deadline; a personal to-do is invisible to managers.
 */
const DIRECTOR = 'ACV-0003'; // assigns to anyone below, reviews, decides extensions
const CTO = 'ACV-0004'; // assigns to the developers
const DEV = 'ACV-0006'; // developer, reports to the CTO
const OWNER = 'ACV-0001'; // the CEO / Founder / Owner: sees everything, assigns and reviews nothing

test.describe.configure({ mode: 'serial' });

const TITLE = 'E2E task from the sheet';
const days = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString();
const toast = (page: import('@playwright/test').Page, text: RegExp | string) => page.locator('[data-sonner-toast]').filter({ hasText: text }).first();

const body = (over: Record<string, unknown> = {}) => ({
  title: 'E2E API task',
  description: '',
  assignee: DEV,
  priority: 'medium',
  size: 'M',
  estimatedHours: 16,
  startDate: new Date().toISOString(),
  deadline: days(10),
  checklist: ['Agree the details', 'Build it'],
  ...over,
});

let taskId = '';

test('the Director assigns a task in the sheet; the developer sees it and the CEO / Founder / Owner has no assign button', async ({ browser, playwright }) => {
  const director = await openAs(browser, DIRECTOR, '/tasks');
  await director.page.getByRole('button', { name: 'Assign task' }).first().click();
  const sheet = director.page.getByRole('dialog');
  await sheet.locator('#t-title').fill(TITLE);
  await sheet.locator('#t-assignee').selectOption(DEV);
  await sheet.getByRole('button', { name: 'Assign task' }).click();
  await expect(toast(director.page, 'Task assigned')).toBeVisible();
  await director.context.close();

  const mine = (await (await (await apiAs(playwright, DEV)).get('tasks?scope=mine')).json()) as Array<{ id: string; title: string; status: string; assignedBy: string; points: number; size: string }>;
  const task = mine.find((t) => t.title === TITLE)!;
  expect(task, 'the developer sees the new task').toBeTruthy();
  expect(task).toMatchObject({ status: 'assigned', assignedBy: DIRECTOR, size: 'M', points: 3 });
  taskId = task.id;

  const owner = await openAs(browser, OWNER, '/tasks');
  await expect(owner.page.getByRole('button', { name: 'Assign task' })).toHaveCount(0);
  await owner.context.close();
});

test('assigning goes down the hierarchy only; soft warnings need a confirmation; hard rules refuse', async ({ playwright }) => {
  const cto = await apiAs(playwright, CTO);
  const dev = await apiAs(playwright, DEV);
  const owner = await apiAs(playwright, OWNER);
  expect((await cto.post('tasks', body({ title: 'E2E up the line', assignee: DIRECTOR }))).status()).toBe(403); // not below the CTO
  expect((await dev.post('tasks', body({ title: 'E2E by a developer' }))).status()).toBe(403); // no task.assign
  expect((await owner.post('tasks', body({ title: 'E2E by the owner' }))).status()).toBe(403); // view only
  expect((await cto.post('tasks', body({ title: 'E2E to a peer team', assignee: 'ACV-0009' }))).status()).toBe(403); // Sales is not in the CTO's line

  const director = await apiAs(playwright, DIRECTOR);
  const xl = await director.post('tasks', body({ title: 'E2E XL', size: 'XL' }));
  expect(xl.status()).toBe(400);
  expect((await xl.json()).code).toBe('size_xl_not_assignable');
  const past = await director.post('tasks', body({ title: 'E2E past', startDate: days(-2), deadline: days(-1) }));
  expect(past.status()).toBe(400);
  expect((await past.json()).code).toBe('deadline_in_past');

  const tooShort = body({ title: 'E2E too short', deadline: new Date(Date.now() + 2 * 3_600_000).toISOString() });
  const warned = await director.post('tasks', tooShort);
  expect(warned.status()).toBe(409);
  const warnedBody = await warned.json();
  expect(warnedBody.code).toBe('confirmation_required');
  expect(warnedBody.warnings.map((w: { code: string }) => w.code)).toContain('deadline_too_short');
  const confirmed = await director.post('tasks', { ...tooShort, confirmWarnings: true });
  expect(confirmed.status()).toBe(201);
});

test('the developer starts and submits; only the reviewer approves, with a rating, in the screen', async ({ browser, playwright }) => {
  const dev = await apiAs(playwright, DEV);
  const cto = await apiAs(playwright, CTO);
  expect((await dev.post(`tasks/${taskId}/approve`, { rating: 5 })).status()).toBeGreaterThanOrEqual(400); // never the assignee
  expect((await cto.post(`tasks/${taskId}/start`)).status()).toBeGreaterThanOrEqual(400); // only the person doing it starts it

  const worker = await openAs(browser, DEV, `/tasks/${taskId}`);
  await worker.page.getByRole('button', { name: 'Start work' }).click();
  await expect(toast(worker.page, 'in progress')).toBeVisible();
  await worker.page.getByRole('button', { name: 'Submit for review' }).click();
  await expect(toast(worker.page, 'submitted')).toBeVisible();
  await worker.context.close();

  const reviewer = await openAs(browser, DIRECTOR, `/tasks/${taskId}`);
  await reviewer.page.getByRole('button', { name: 'Approve with rating' }).click();
  const dialog = reviewer.page.getByRole('dialog');
  await dialog.getByRole('radio', { name: /^4 stars/ }).click();
  await dialog.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(toast(reviewer.page, 'Approved with 4 stars')).toBeVisible();
  await reviewer.context.close();

  const detail = await (await (await apiAs(playwright, DIRECTOR)).get(`tasks/${taskId}`)).json();
  expect(detail.task).toMatchObject({ status: 'approved', rating: 4, points: 3 });
  expect(detail.history.map((h: { to: string }) => h.to)).toEqual(expect.arrayContaining(['assigned', 'in_progress', 'submitted', 'approved']));
});

test('an extension is decided by the assigner and the original deadline is kept', async ({ playwright }) => {
  const director = await apiAs(playwright, DIRECTOR);
  const dev = await apiAs(playwright, DEV);
  const created = await (await director.post('tasks', body({ title: 'E2E extension task', confirmWarnings: true }))).json();
  const later = days(14);
  const requested = await dev.post(`tasks/${created.id}/extensions`, { requestedDeadline: later, reason: 'Waiting for the client files' });
  expect(requested.status()).toBe(201);
  const ext = await requested.json();
  expect(ext.late).toBe(false);
  expect((await dev.post(`extensions/${ext.id}/approve`, {})).status()).toBeGreaterThanOrEqual(400); // nobody decides their own request
  expect((await director.post(`extensions/${ext.id}/approve`, {})).status()).toBe(200);
  const after = (await (await director.get(`tasks/${created.id}`)).json()).task;
  expect(after.originalDeadline).toBe(created.deadline);
  expect(new Date(after.deadline).getTime()).toBe(new Date(later).getTime());
  expect(after.extensionsCount).toBe(1);
});

test('a personal to-do is seen by its owner only and is never scored', async ({ playwright }) => {
  const dev = await apiAs(playwright, DEV);
  const res = await dev.post('tasks', { title: 'E2E my own reminder', description: '', priority: 'low', size: 'XS', estimatedHours: 1, startDate: new Date().toISOString(), deadline: days(1), checklist: [], personal: true });
  expect(res.status()).toBe(201);
  const todo = await res.json();
  expect(todo).toMatchObject({ personal: true, points: 0, assignee: DEV, assignedBy: DEV });
  for (const who of [CTO, DIRECTOR, OWNER]) {
    const api = await apiAs(playwright, who);
    expect((await api.get(`tasks/${todo.id}`)).status(), who).toBe(404);
    const team = (await (await api.get('tasks?scope=all&includePersonal=true')).json()) as Array<{ id: string }>;
    expect(team.some((t) => t.id === todo.id), who).toBe(false);
  }
  expect((await dev.post(`tasks/${todo.id}/done`)).status()).toBe(200);
});

test('task reviews wait in the approvals inbox of the assigner, never in the assignee\'s', async ({ playwright }) => {
  const director = await apiAs(playwright, DIRECTOR);
  const dev = await apiAs(playwright, DEV);
  const created = await (await director.post('tasks', body({ title: 'E2E inbox task', confirmWarnings: true }))).json();
  expect((await dev.post(`tasks/${created.id}/start`)).status()).toBe(200);
  expect((await dev.post(`tasks/${created.id}/submit`)).status()).toBe(200);
  const inbox = (await (await director.get('approvals')).json()) as { items: Array<{ id: string; type: string }> };
  expect(inbox.items.some((i) => i.id === `task_review:${created.id}` && i.type === 'task_review')).toBe(true);
  const own = (await (await dev.get('approvals')).json()) as { items: Array<{ id: string }> };
  expect(own.items.some((i) => i.id === `task_review:${created.id}`)).toBe(false);
  expect((await director.post(`approvals/${encodeURIComponent('task_review:' + created.id)}/approve`, { rating: 5 })).status()).toBe(200);
});

test('ordinary staff opening Tasks and Performance leave no blocked attempts', async ({ browser, playwright }) => {
  const startedAt = Date.now();
  const worker = await openAs(browser, DEV, '/tasks');
  await expect(worker.page.getByRole('heading', { name: 'My tasks', level: 1 })).toBeVisible();
  await worker.page.goto('/performance');
  await expect(worker.page.locator('h1').first()).toBeVisible();
  await worker.context.close();

  // Activity records are written about once a second; give the last request time to land before looking.
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const director = await apiAs(playwright, DIRECTOR);
  const res = await director.get(`activity/events?empId=${DEV}&action=blocked`);
  expect(res.status()).toBe(200);
  const events = (await res.json()) as Array<{ at: string; description: string; target?: string }>;
  // Earlier tests in this file make the developer try forbidden things on purpose (such as assigning a task);
  // only the window of this test counts.
  const fresh = events.filter((e) => new Date(e.at).getTime() >= startedAt - 1_000);
  expect(fresh, 'opening Tasks or Performance must not request anything the server refuses').toEqual([]);
});

test('only the person doing a task, or its assigner, is offered Attach file', async ({ browser, playwright }) => {
  const cto = await apiAs(playwright, CTO);
  const created = await cto.post('tasks', body({ title: 'E2E attach buttons', assignee: DEV, confirmWarnings: true }));
  expect(created.status()).toBe(201);
  const { id } = (await created.json()) as { id: string };

  const expected: Array<[string, number]> = [
    [DIRECTOR, 0], // sees the task (it is in his line) but is neither the assigner nor the assignee; the server answers 403
    [CTO, 1], // the assigner
    [DEV, 1], // the person doing it
  ];
  for (const [who, count] of expected) {
    const view = await openAs(browser, who, `/tasks/${id}`);
    await expect(view.page.getByRole('heading', { name: 'E2E attach buttons', level: 1 })).toBeVisible();
    await expect(view.page.getByRole('button', { name: 'Attach file' }), who).toHaveCount(count);
    await view.context.close();
  }
});
