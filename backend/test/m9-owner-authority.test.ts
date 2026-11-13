import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Decision D22 and plan s.13 ("all share capital and loan entries need the Owner"):
 *  - a sub-account under an account that needs Owner approval (2500 Loans) inherits the rule, and it cannot be switched off
 *    through the API or directly in the database;
 *  - a loan entry posted through such a sub-account needs the Owner;
 *  - only the Owner removes the rule, after confirming again, and the database accepts the removal only with the Owner's
 *    audit row in the same transaction.
 */
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003';
const DEV = 'ACV-0006';
const FINANCE = 'ACV-0010';
const API = '/api/v1';
let CEO = '';

let t: TestApp;
let prisma: PrismaClient;
const acc: Record<string, string> = {};
let subId = '';

const fin = () => t.as(FINANCE);
const approve = (id: string, who: string) => t.as(who).post(`${API}/journal-entries/${id}/approve`).send({});
const ownerApproval = (who: string, id: string, required: boolean, reason = 'Owner approval rule change') =>
  t.as(who).put(`${API}/accounts/${id}/owner-approval`).send({ required, reason });

beforeAll(async () => {
  prisma = createTestPrisma();
  t = await createTestApp();
  await t.signInAll();
  CEO = t.fixtures.CEO;
  for (const a of await prisma.ledgerAccount.findMany()) acc[a.code] = a.id;
}, 180000);

afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

describe('M9 loan sub-accounts inherit "Owner approves"', () => {
  it('a sub-account created under 2500 Loans needs Owner approval, even when the request asks otherwise', async () => {
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { code: '2500' } })).requiresOwnerApproval).toBe(true);
    const refused = await fin().post(`${API}/accounts`).send({ code: '2520', name: 'Unflagged loan (test)', group: 'liability', currency: 'PKR', parentId: acc['2500'], requiresOwnerApproval: false }).expect(409);
    expect(refused.body.code).toBe('owner_approval_inherited');
    const sub = (await fin().post(`${API}/accounts`).send({ code: '2510', name: 'HBL term loan (test)', group: 'liability', currency: 'PKR', parentId: acc['2500'] }).expect(201)).body;
    expect(sub.requiresOwnerApproval).toBe(true);
    subId = sub.id;
  });

  it('the rule cannot be switched off on the sub-account: not through the API, not directly in the database', async () => {
    expect((await fin().patch(`${API}/accounts/${subId}`).send({ requiresOwnerApproval: false, reason: 'Finance tries to drop it' }).expect(403)).body.code).toBe('owner_only');
    // not even by the Owner while the parent needs Owner approval (inherited)
    await t.stepUp(OWNER);
    expect((await ownerApproval(OWNER, subId, false).expect(409)).body.code).toBe('owner_approval_inherited');
    // the database: inherited, so it can be neither switched off nor inserted without it
    await expect(prisma.ledgerAccount.update({ where: { id: subId }, data: { requiresOwnerApproval: false } })).rejects.toThrow(/owner_approval_inherited/);
    await expect(
      prisma.ledgerAccount.create({ data: { code: '2530', name: 'Direct loan (test)', group: 'liability', parentId: acc['2500'], requiresOwnerApproval: false } }),
    ).rejects.toThrow(/owner_approval_inherited/);
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: subId } })).requiresOwnerApproval).toBe(true);
  });

  it('a loan entry posted through the sub-account needs the Owner: the Director and the CEO are refused', async () => {
    const e = (await fin().post(`${API}/journal-entries`).send({ date: '2026-10-05', description: 'Loan received (test)', submit: true, lines: [{ accountId: acc['1100'], debit: '40000' }, { accountId: subId, credit: '40000' }] }).expect(201)).body;
    expect(e.requiredLevel).toBe(1);
    expect((await approve(e.id, DIRECTOR).expect(403)).body.code).toBe('approval_limit');
    expect((await approve(e.id, CEO).expect(403)).body.code).toBe('approval_limit');
    expect((await approve(e.id, OWNER).expect(200)).body.status).toBe('posted');
  });

  it('flagging an account flags its sub-accounts', async () => {
    const sub = (await fin().post(`${API}/accounts`).send({ code: '5310', name: 'Cloud hosting (test)', group: 'expense', currency: 'PKR', parentId: acc['5300'] }).expect(201)).body;
    expect(sub.requiresOwnerApproval).toBe(false);
    await fin().patch(`${API}/accounts/${acc['5300']}`).send({ requiresOwnerApproval: true, reason: 'Owner wants to see software spend' }).expect(200);
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: sub.id } })).requiresOwnerApproval).toBe(true);
  });
});

describe('M9 only the Owner changes the Owner-approval rule (D22)', () => {
  it('everyone else is refused by the server: Finance, the Director, the CEO and a developer', async () => {
    for (const who of [FINANCE, DIRECTOR, CEO, DEV]) {
      await ownerApproval(who, acc['2500'], false, `${who} tries to remove the rule`).expect(404);
    }
    await t.as(DIRECTOR).patch(`${API}/accounts/${acc['2500']}`).send({ requiresOwnerApproval: false, reason: 'Director tries' }).expect(404);
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { code: '2500' } })).requiresOwnerApproval).toBe(true);
    expect(await prisma.auditLog.count({ where: { action: 'finance.account.owner_approval_removed' } })).toBe(0);
  });

  it('the database refuses a removal without the Owner, even with a forged audit row by someone else', async () => {
    await expect(prisma.ledgerAccount.update({ where: { code: '2500' }, data: { requiresOwnerApproval: false } })).rejects.toThrow(/owner_only/);
    const director = await prisma.employee.findUniqueOrThrow({ where: { empId: DIRECTOR } });
    await expect(
      prisma.$transaction([
        prisma.auditLog.create({ data: { actorId: director.id, action: 'finance.account.owner_approval_removed', targetType: 'ledger_account', targetId: '2500' } }),
        prisma.ledgerAccount.update({ where: { code: '2500' }, data: { requiresOwnerApproval: false } }),
      ]),
    ).rejects.toThrow(/owner_only/);
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { code: '2500' } })).requiresOwnerApproval).toBe(true);
  });

  it('the Owner removes it on a top account after confirming again; it is logged; the sub-account keeps its own rule', async () => {
    t.clock.advance(6 * 60_000); // the earlier "confirm again" has expired
    expect((await ownerApproval(OWNER, acc['3200'], false, 'Owner capital: Owner decision').expect(403)).body.code).toBe('step_up_required');
    await t.stepUp(OWNER);
    expect((await ownerApproval(OWNER, acc['3200'], false, 'Owner capital: Owner decision').expect(200)).body.requiresOwnerApproval).toBe(false);
    expect(await prisma.auditLog.count({ where: { action: 'finance.account.owner_approval_removed', targetId: '3200', reason: 'Owner capital: Owner decision' } })).toBe(1);
    // and adds it back
    expect((await ownerApproval(OWNER, acc['3200'], true, 'Owner capital: back under Owner approval').expect(200)).body.requiresOwnerApproval).toBe(true);
    // removing it from 2500 leaves 2510 flagged (sub-accounts keep it until the Owner removes it there too)
    expect((await ownerApproval(OWNER, acc['2500'], false, 'Loans: Owner decision').expect(200)).body.requiresOwnerApproval).toBe(false);
    expect((await prisma.ledgerAccount.findUniqueOrThrow({ where: { id: subId } })).requiresOwnerApproval).toBe(true);
    await ownerApproval(OWNER, acc['2500'], true, 'Loans: back under Owner approval').expect(200);
  });
});
