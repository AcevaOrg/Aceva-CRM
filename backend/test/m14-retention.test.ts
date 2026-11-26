import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 14 retention policy (plan section 19: "Define message and file retention periods with management before launch";
 * "Admins can ... manage retention"). Comms admins record management's periods ("confirm again", audited with a reason);
 * everyone is told the policy; nothing is removed automatically in this release.
 */
const SETTINGS = '/api/v1/settings/modules/comms';
const CTO = 'ACV-0004'; // comms.admin
const DIRECTOR = 'ACV-0003'; // comms.admin
const DEV1 = 'ACV-0006';
const FINANCE = 'ACV-0010';

let t: TestApp;
let prisma: PrismaClient;

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  prisma = createTestPrisma();
});

afterAll(async () => {
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120_000);

describe('retention policy', () => {
  it('starts undecided: everything is kept, and everyone is told so', async () => {
    const policy = await t.as(DEV1).get('/api/v1/comms/policy');
    expect(policy.status).toBe(200);
    expect(policy.body).toEqual({ messageRetentionDays: null, fileRetentionDays: null, automaticRemoval: false });
  });

  it('is kept by comms admins only, after confirming again, with a reason (audited)', async () => {
    for (const who of [DEV1, FINANCE]) expect((await t.as(who).get(SETTINGS)).status).toBe(404);
    const current = (await t.as(CTO).get(SETTINGS)).body;
    expect(current.value).toEqual({ messageRetentionDays: null, fileRetentionDays: null });
    const next = { value: { messageRetentionDays: 730, fileRetentionDays: 365 }, version: current.version, reason: 'Management decision on retention' };
    expect((await t.as(DEV1).put(SETTINGS).send(next)).status).toBe(404);
    const noStepUp = await t.as(CTO).put(SETTINGS).send(next);
    expect(noStepUp.status).toBe(403);
    expect(noStepUp.body.code).toBe('step_up_required');
    await t.stepUp(CTO);
    expect((await t.as(CTO).put(SETTINGS).send({ ...next, value: { messageRetentionDays: 10, fileRetentionDays: null } })).status).toBe(400);
    const saved = await t.as(CTO).put(SETTINGS).send(next);
    expect(saved.status, JSON.stringify(saved.body)).toBe(200);
    expect((await t.as(DEV1).get('/api/v1/comms/policy')).body).toEqual({ messageRetentionDays: 730, fileRetentionDays: 365, automaticRemoval: false });
    expect((await t.as(DIRECTOR).get(SETTINGS)).body.value).toEqual({ messageRetentionDays: 730, fileRetentionDays: 365 });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'settings.module.changed', targetId: 'comms' }, orderBy: { occurredAt: 'desc' } });
    expect(audit.reason).toBe('Management decision on retention');
  });
});
