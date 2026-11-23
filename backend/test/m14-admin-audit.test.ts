import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createTestApp, type TestApp } from './helpers/app';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 14 security and audit events for comms admins (plan section 19: "Admins can ... review security/audit
 * events"): every Module 14 audit record and the refusals on its routes, newest first, filtered and paged, never the
 * text of a message.
 */
const API = '/api/v1/comms';
const CTO = 'ACV-0004'; // comms.admin
const DIRECTOR = 'ACV-0003'; // comms.admin
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const SALES1 = 'ACV-0009';
const SECRET = `zq${randomUUID().replace(/-/g, '').slice(0, 12)}`;

let t: TestApp;
let group = '';

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  group = (await t.as(DEV1).post(`${API}/conversations`).send({ kind: 'group', name: 'Audit group', memberEmpIds: [DEV2] })).body.conversation.id;
  const sent = await t.as(DEV2).post(`${API}/conversations/${group}/messages`).send({ clientKey: randomUUID(), body: `private ${SECRET}` });
  expect(sent.status).toBe(201);
  // A moderator removal (with a reason) and a refused attempt by an outsider.
  expect((await t.as(DEV1).post(`${API}/messages/${sent.body.message.id}/remove`).send({ reason: 'Off topic for this group' })).status).toBe(200);
  expect((await t.as(SALES1).get(`${API}/admin/channels`)).status).toBe(403);
});

afterAll(async () => {
  await t.close();
  await resetTestDatabase();
}, 120_000);

describe('comms security and audit events', () => {
  it('are for comms admins only', async () => {
    for (const who of [DEV1, SALES1]) expect((await t.as(who).get(`${API}/admin/audit`)).status).toBe(403);
    expect((await t.as(DIRECTOR).get(`${API}/admin/audit`)).status).toBe(200);
  });

  it('list Module 14 records newest first with who, what, reason and refusals; never the message text', async () => {
    const res = await t.as(CTO).get(`${API}/admin/audit?limit=200`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    const items = res.body.items as Array<{ at: string; action: string; actorEmpId: string | null; reason: string | null; outcome: string; targetId: string | null }>;
    const actions = items.map((i) => i.action);
    expect(actions).toEqual(expect.arrayContaining(['comms.conversation.created', 'comms.message.removed', 'access.denied']));
    expect(actions.every((a) => a.startsWith('comms.') || a === 'access.denied' || a === 'settings.module.changed')).toBe(true);
    const removal = items.find((i) => i.action === 'comms.message.removed')!;
    expect(removal).toMatchObject({ actorEmpId: DEV1, reason: 'Off topic for this group' });
    const denied = items.find((i) => i.action === 'access.denied')!;
    expect(denied).toMatchObject({ actorEmpId: SALES1, outcome: 'denied' });
    expect(denied.targetId).toContain('/comms');
    expect([...items].map((i) => i.at)).toEqual([...items].map((i) => i.at).sort().reverse());
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('filter by group, outcome and time, and page with a cursor', async () => {
    const messages = (await t.as(CTO).get(`${API}/admin/audit?action=messages`)).body.items as Array<{ action: string }>;
    expect(messages.length).toBeGreaterThan(0);
    expect(messages.every((i) => i.action.startsWith('comms.message.'))).toBe(true);
    const denied = (await t.as(CTO).get(`${API}/admin/audit?outcome=denied`)).body.items as Array<{ outcome: string }>;
    expect(denied.every((i) => i.outcome === 'denied')).toBe(true);
    expect((await t.as(CTO).get(`${API}/admin/audit?to=2000-01-01T00:00:00.000Z`)).body.items).toEqual([]);
    const first = (await t.as(CTO).get(`${API}/admin/audit?limit=2`)).body;
    expect(first.items).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = (await t.as(CTO).get(`${API}/admin/audit?limit=2&cursor=${first.nextCursor}`)).body;
    expect(second.items[0].id).not.toBe(first.items[1].id);
    expect((await t.as(CTO).get(`${API}/admin/audit?cursor=not-a-cursor`)).status).toBe(400);
  });
});
