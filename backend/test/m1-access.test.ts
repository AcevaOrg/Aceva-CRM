import { Controller, Get } from '@nestjs/common';
import { MODULE_PATH, PATH_METADATA } from '@nestjs/common/constants';
import { ModulesContainer } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AUTHENTICATED_ONLY, IS_PUBLIC, REQUIRED_PERMISSIONS } from '../src/access/decorators';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/** A route that someone forgot to protect: the guard must refuse it anyway. */
@Controller('test-unprotected')
class UnprotectedController {
  @Get()
  secret() {
    return { secret: 'should never be returned' };
  }
}

// Demo people (see prisma/seed-data.ts)
const OWNER = 'ACV-0001';
const CEO = 'ACV-0002';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const HR = 'ACV-0015';
const FINANCE = 'ACV-0010';
const SALES1 = 'ACV-0009';
const SALES2 = 'ACV-0012';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';

let t: TestApp;
let prisma: PrismaClient;

beforeAll(async () => {
  t = await createTestApp({ extraControllers: [UnprotectedController] });
  await t.signInAll();
  prisma = createTestPrisma();
});
afterAll(async () => {
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
});

const deniedCount = async (actorEmpId: string | null, reason: string) =>
  prisma.auditLog.count({
    where: {
      action: 'access.denied',
      outcome: 'denied',
      reason,
      actor: actorEmpId ? { empId: actorEmpId } : null,
    },
  });

describe('M1 five levels and role mapping', () => {
  it('has a default role for every one of the five levels', async () => {
    const res = await t.as(DEV1).get('/api/v1/access/roles').expect(200);
    const defaults = res.body.filter((r: { isDefault: boolean }) => r.isDefault);
    expect(defaults.map((r: { level: number }) => r.level)).toEqual([1, 2, 3, 4, 5]);
  });

  it('maps permissions to roles (Owner/CEO manage the org, employees do not)', async () => {
    const res = await t.as(DEV1).get('/api/v1/access/roles').expect(200);
    const perms = (key: string): string[] => res.body.find((r: { key: string }) => r.key === key).permissions;
    expect(perms('owner')).toContain('org.manage');
    expect(perms('ceo')).toContain('org.manage');
    expect(perms('director')).not.toContain('org.manage');
    expect(perms('director')).toContain('payroll.approve');
    expect(perms('employee')).not.toContain('org.manage');
    expect(perms('employee')).not.toContain('finance.view');
    expect(perms('sales')).toContain('sales.own'); // a named Level 4 role
    expect(perms('level4_default')).toContain('task.assign');
  });

  it('extends with new permissions without code changes (just a row in the catalogue)', async () => {
    await prisma.permission.upsert({ where: { key: 'future.module.use' }, update: {}, create: { key: 'future.module.use', module: 'future' } });
    const res = await t.as(DEV1).get('/api/v1/access/permissions').expect(200);
    expect(res.body.map((p: { key: string }) => p.key)).toContain('future.module.use');
    await prisma.rolePermission.deleteMany({ where: { permission: { key: 'future.module.use' } } });
    await prisma.permission.delete({ where: { key: 'future.module.use' } });
  });

  it('adds Finance duty permissions on top of the role (kept separate), and 2FA rules follow the plan', async () => {
    const finance = (await t.as(FINANCE).get('/api/v1/access/me').expect(200)).body;
    expect(finance.duties).toEqual(['finance']);
    expect(finance.permissions).toEqual(expect.arrayContaining(['finance.entry_create', 'payroll.prepare', 'task.assign']));
    expect(finance.permissions).not.toContain('payroll.approve'); // finance prepares, never approves
    expect(finance.twoFactorRequired).toBe(true); // Finance duty

    const dev = (await t.as(DEV1).get('/api/v1/access/me').expect(200)).body;
    expect(dev.permissions).not.toContain('finance.entry_create');
    expect(dev.twoFactorRequired).toBe(false); // optional for ordinary employees

    for (const [empId, level] of [[OWNER, 1], [CEO, 2], [DIRECTOR, 3], [CTO, 3]] as const) {
      const me = (await t.as(empId).get('/api/v1/access/me').expect(200)).body;
      expect(me.level).toBe(level);
      expect(me.twoFactorRequired, `${empId} (level ${level})`).toBe(true); // mandatory for levels 1 to 3
    }
    const hr = (await t.as(HR).get('/api/v1/access/me').expect(200)).body;
    expect(hr.duties).toEqual(['hr']);
    expect(hr.twoFactorRequired).toBe(false);
  });
});

describe('M1 hierarchy data scope: own data plus people below, never above or beside', () => {
  const team = async (empId: string): Promise<string[]> =>
    (await t.as(empId).get('/api/v1/org/team').expect(200)).body.map((m: { empId: string }) => m.empId).sort();

  it('a list request returns only the caller and the people below them', async () => {
    expect(await team(DEV1)).toEqual([DEV1]);
    expect(await team(CTO)).toEqual([CTO, DEV1, DEV2, 'ACV-0008', 'ACV-0011', 'ACV-0013'].sort());
    expect((await team(DIRECTOR)).length).toBe(12); // Director + CTO + HR + Finance + 3 Sales + 5 developers
    expect((await team(CEO)).length).toBe(13); // everyone except the Owner
    expect((await team(OWNER)).length).toBe(14); // the whole company
  });

  it('reports the depth of each person below the caller', async () => {
    const members = (await t.as(DIRECTOR).get('/api/v1/org/team').expect(200)).body;
    const depthOf = (e: string) => members.find((m: { empId: string }) => m.empId === e).depth;
    expect([depthOf(DIRECTOR), depthOf(CTO), depthOf(DEV1)]).toEqual([0, 1, 2]);
  });

  it('allows own record and people below on single-record requests', async () => {
    await t.as(DEV1).get(`/api/v1/org/team/${DEV1}`).expect(200);
    await t.as(CTO).get(`/api/v1/org/team/${DEV1}`).expect(200);
    await t.as(OWNER).get(`/api/v1/org/team/${DEV2}`).expect(200); // deep below
  });

  it('blocks people ABOVE, BESIDE and in other branches, and logs every blocked attempt', async () => {
    const cases: Array<[string, string, string]> = [
      [DEV1, CTO, 'above'],
      [DEV1, DIRECTOR, 'above (two levels)'],
      [DEV1, DEV2, 'beside'],
      [CTO, SALES1, 'other branch'],
      [SALES1, SALES2, 'beside'],
      [DIRECTOR, OWNER, 'above'],
      [CEO, OWNER, 'above'],
    ];
    for (const [actor, target, label] of cases) {
      const before = await deniedCount(actor, 'out_of_scope');
      await t.as(actor).get(`/api/v1/org/team/${target}`).expect(403);
      expect(await deniedCount(actor, 'out_of_scope'), `${actor} -> ${target} (${label}) was not logged`).toBeGreaterThan(before);
    }
  });

  it('the denial is recorded with who, what and the route', async () => {
    const entry = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'access.denied', reason: 'out_of_scope', actor: { empId: DEV1 }, details: { path: ['target'], equals: DEV2 } },
      include: { actor: true },
    });
    expect(entry.actor?.empId).toBe(DEV1);
    expect(entry.targetId).toContain('/org/team/:empId');
    expect(entry.outcome).toBe('denied');
  });

  it('the scope is applied in the database query itself (a different user sees different rows from the same call)', async () => {
    const dev = (await t.as(DEV1).get('/api/v1/org/team').expect(200)).body;
    const owner = (await t.as(OWNER).get('/api/v1/org/team').expect(200)).body;
    expect(dev.length).toBeLessThan(owner.length);
  });

  it('returns 404 for an Emp-ID that does not exist', async () => {
    await t.as(OWNER).get('/api/v1/org/team/ACV-9999').expect(404);
  });
});

describe('M1 server-side permission guard', () => {
  it('rejects a request with no identity (401) and logs it', async () => {
    const before = await deniedCount(null, 'unauthenticated');
    await t.as(null).get('/api/v1/org/tree').expect(401);
    expect(await deniedCount(null, 'unauthenticated')).toBeGreaterThan(before);
  });

  it('rejects a forged session cookie', async () => {
    await t.anonymous().get('/api/v1/org/tree').set('Cookie', 'aceva_session=forged-token-value').expect(401);
  });

  it('the old development identity header no longer identifies anybody', async () => {
    await t.anonymous().get('/api/v1/org/tree').set('X-Dev-Emp-Id', OWNER).expect(401);
  });

  it('rejects a missing permission (403), logs it, and names the permission', async () => {
    const before = await deniedCount(DEV1, 'missing_permission');
    await t.as(DEV1).patch(`/api/v1/org/employees/${DEV2}/level`).send({ level: 4, reason: 'trying it' }).expect(403);
    expect(await deniedCount(DEV1, 'missing_permission')).toBeGreaterThan(before);
  });

  it('only Owner and CEO may change levels and reporting lines (plan section 5)', async () => {
    const level = { level: 4, reason: 'permission check' };
    const line = { reportsToEmpId: CTO, reason: 'permission check' };
    for (const actor of [DIRECTOR, CTO, HR, FINANCE, DEV1]) {
      await t.as(actor).patch(`/api/v1/org/employees/${DEV2}/level`).send(level).expect(403);
      await t.as(actor).patch(`/api/v1/org/employees/${DEV2}/reporting-line`).send(line).expect(403);
    }
  });

  it('fails closed: a route nobody protected is refused and logged', async () => {
    const before = await deniedCount(OWNER, 'route_has_no_access_rule');
    await t.as(OWNER).get('/api/v1/test-unprotected').expect(403);
    expect(await deniedCount(OWNER, 'route_has_no_access_rule')).toBeGreaterThan(before);
  });

  it('every real route declares an access rule (public, permission or login-only)', async () => {
    const container = t.app.get(ModulesContainer);
    const unprotected: string[] = [];
    let routes = 0;
    for (const module of container.values()) {
      for (const wrapper of module.controllers.values()) {
        const instance = wrapper.instance as object | undefined;
        if (!instance || instance instanceof UnprotectedController) continue;
        const proto = Object.getPrototypeOf(instance) as Record<string, unknown>;
        for (const name of Object.getOwnPropertyNames(proto)) {
          const handler = proto[name];
          if (typeof handler !== 'function' || Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
          if (name === 'constructor') continue;
          routes++;
          const has = (key: string) =>
            Reflect.getMetadata(key, handler) !== undefined || Reflect.getMetadata(key, wrapper.metatype as object) !== undefined;
          if (!has(IS_PUBLIC) && !has(AUTHENTICATED_ONLY) && !has(REQUIRED_PERMISSIONS)) {
            unprotected.push(`${wrapper.metatype?.name}.${name}`);
          }
        }
      }
    }
    expect(routes).toBeGreaterThan(10);
    expect(unprotected).toEqual([]);
    void MODULE_PATH;
  });
});

/** The CTO node under the Director. */
const cto0 = (director: { children: Array<{ empId: string }> }) => director.children.find((c) => c.empId === CTO);

describe('M1 organisation chart', () => {
  it('returns the reporting tree: Owner > CEO > Director > (CTO, heads) > employees', async () => {
    const tree = (await t.as(DEV1).get('/api/v1/org/tree').expect(200)).body;
    expect(tree).toHaveLength(1);
    const owner = tree[0];
    expect(owner).toMatchObject({ empId: OWNER, level: 1, reportsTo: null });
    const ceo = owner.children[0];
    expect(ceo).toMatchObject({ empId: CEO, level: 2 });
    const director = ceo.children[0];
    expect(director).toMatchObject({ empId: DIRECTOR, level: 3, duties: ['hr'] });
    expect(cto0(director)).toBeDefined();
    const cto = director.children.find((c: { empId: string }) => c.empId === CTO);
    expect(cto).toMatchObject({ level: 3, reportsTo: DIRECTOR }); // same-level reporting, explicitly configured
    expect(cto.children).toHaveLength(5);
    expect(director.children.map((c: { department: string }) => c.department)).toEqual(
      expect.arrayContaining(['Software Development', 'Finance', 'Sales', 'Human Resources']),
    );
  });

  it('shows departments and offices on every person', async () => {
    const tree = (await t.as(OWNER).get('/api/v1/org/tree').expect(200)).body;
    const flat: Array<{ department: string; office: string; children: unknown[] }> = [];
    const walk = (n: (typeof flat)[number]) => { flat.push(n); (n.children as typeof flat).forEach(walk); };
    tree.forEach(walk);
    expect(flat).toHaveLength(14);
    flat.forEach((n) => { expect(n.department).toBeTruthy(); expect(n.office).toBeTruthy(); });
  });
});

describe('M1 departments, offices and the recent changes feed', () => {
  it('lists departments and offices with headcount, head and offices', async () => {
    const res = (await t.as(DEV1).get('/api/v1/org/departments').expect(200)).body;
    expect(res.departments.map((d: { id: string }) => d.id)).toEqual(['dep-eng', 'dep-fin', 'dep-hr', 'dep-mgmt', 'dep-sales']);
    expect(res.offices.map((o: { id: string }) => o.id)).toEqual(['off-dadu', 'off-khi', 'off-remote']);
    expect(res.headcount).toMatchObject({ 'dep-eng': 6, 'dep-sales': 3, 'dep-fin': 1, 'dep-hr': 1, 'dep-mgmt': 3 });
    const eng = res.departments.find((d: { id: string }) => d.id === 'dep-eng');
    expect(eng.headEmpId).toBe(CTO); // most senior person in the department
    expect(eng.officeIds).toEqual(['off-dadu', 'off-khi', 'off-remote']);
  });

  it('gives every org tree node its department and office codes', async () => {
    const [owner] = (await t.as(OWNER).get('/api/v1/org/tree').expect(200)).body;
    expect(owner).toMatchObject({ departmentId: 'dep-mgmt', officeId: 'off-dadu' });
  });

  it('shows the recent changes feed only to people who may view the audit log', async () => {
    await t.as(DIRECTOR).get('/api/v1/org/changes').expect(200);
    await t.as(OWNER).get('/api/v1/org/changes').expect(200);
    await t.as(DEV1).get('/api/v1/org/changes').expect(403);
    await t.as(CTO).get('/api/v1/org/changes').expect(403);
  });
});
