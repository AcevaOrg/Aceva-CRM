import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SALES_IMPORT_MAX_BYTES } from '@aceva/contracts';
import { AuditService } from '../src/access/audit.service';
import { ActivityRecorder } from '../src/activity/activity-recorder.service';
import type { PrismaClient } from '../src/generated/prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { DncService } from '../src/sales/dnc.service';
import { SalesAccessService } from '../src/sales/sales-access.service';
import { createTestApp, TEST_DNC_HMAC_KEY, type TestApp } from './helpers/app';
import { baseEnv } from './helpers/base-env';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 15.4: the do-not-contact list and the lead import (plan section 20), against the real database.
 * Approved decisions 1-6: a listed email can never become a lead (added, imported or edited in) and outgoing contact on a
 * marked lead is refused (replies and notes are not); entries are never changed or removed and keep only a keyed hash and
 * a masked email; the owner or the sales manager marks a lead, only the sales manager adds a bare email; the import is a
 * checked CSV preview, then an all-or-nothing commit that re-checks every row, once.
 */
const API = '/api/v1';
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003'; // the sales manager
const CTO = 'ACV-0004';
const DEV = 'ACV-0006';
const HIRA = 'ACV-0009';
const FINANCE = 'ACV-0010';
const KAMRAN = 'ACV-0012';

let t: TestApp;
let prisma: PrismaClient;
const ids: Record<string, string> = {};
const lead: Record<string, { id: string; version: number }> = {};

const as = (who: string) => t.as(who);
const hmac = (email: string) => createHmac('sha256', Buffer.from(TEST_DNC_HMAC_KEY, 'base64')).update(email, 'utf8').digest('hex');
const newLead = (who: string, body: Record<string, unknown>) => as(who).post(`${API}/sales/leads`).send({ source: 'linkedin', ...body });
const mark = (who: string, leadId: string, reason = 'Asked us not to write again') => as(who).post(`${API}/sales/leads/${leadId}/do-not-contact`).send({ reason });
const addEmail = (who: string, email: string, reason = 'Unsubscribed by reply') => as(who).post(`${API}/sales/do-not-contact`).send({ email, reason });
const preview = (who: string, csv: string | Buffer, opts: { source?: string; ownerEmpId?: string; name?: string } = {}) => {
  let req = as(who).post(`${API}/sales/leads/import/preview`).field('source', opts.source ?? 'apollo');
  if (opts.ownerEmpId) req = req.field('ownerEmpId', opts.ownerEmpId);
  return req.attach('file', typeof csv === 'string' ? Buffer.from(csv, 'utf8') : csv, opts.name ?? 'leads.csv');
};
const commit = (who: string, batchId: string) => as(who).post(`${API}/sales/leads/import/${batchId}/commit`);
const salesEvents = async () => {
  await t.app.get(ActivityRecorder).flush();
  return prisma.activityEvent.findMany({ where: { module: 'Sales' }, orderBy: { occurredAt: 'asc' } });
};

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  prisma = createTestPrisma();
  for (const e of await prisma.employee.findMany({ select: { id: true, empId: true } })) ids[e.empId] = e.id;
  const mk = async (key: string, who: string, name: string, email: string | null, site: string) => {
    const b = (await newLead(who, { fullName: name, ...(email ? { email } : {}), company: { name: site, website: site } }).expect(201)).body;
    lead[key] = { id: b.id, version: b.version };
  };
  await mk('ayesha', HIRA, 'Ayesha Khan', 'ayesha@northwind-dnc.test', 'northwind-dnc.test');
  await mk('omar', HIRA, 'Omar Farooq', 'omar@contoso-dnc.test', 'contoso-dnc.test');
  await mk('noemail', HIRA, 'Nadia No-Email', null, 'tailspin-dnc.test');
  await mk('lena', KAMRAN, 'Lena Park', 'lena@fabrikam-dnc.test', 'fabrikam-dnc.test');
}, 180000);
afterAll(async () => {
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120000);

// ===================================================================================================== do not contact

describe('M15.4 do-not-contact: who may do what', () => {
  it('people without sales access get nothing; a salesperson cannot mark someone else’s lead; the CEO / Owner only views', async () => {
    for (const who of [FINANCE, CTO, DEV]) {
      await as(who).get(`${API}/sales/do-not-contact`).expect(403);
      await mark(who, lead.ayesha.id).expect(403);
      await addEmail(who, 'x@example-dnc.test').expect(403);
      await preview(who, 'name\nA').expect(403);
    }
    await mark(KAMRAN, lead.ayesha.id).expect(403);
    await mark(OWNER, lead.ayesha.id).expect(403);
    // only the sales manager adds an email that has no lead (approved decision 3)
    await addEmail(HIRA, 'someone@example-dnc.test').expect(403);
    await addEmail(OWNER, 'someone@example-dnc.test').expect(403);
    await as(HIRA).get(`${API}/sales/do-not-contact`).expect(403);
    await as(OWNER).get(`${API}/sales/do-not-contact`).expect(200);
    expect(await prisma.salesDncEntry.count()).toBe(0);
  });

  it('the owner marks their lead: it is flagged for good, the list keeps a keyed hash and a masked email (never the email)', async () => {
    const res = (await mark(HIRA, lead.ayesha.id, 'Asked us by phone not to contact her').expect(200)).body;
    expect(res).toMatchObject({ id: lead.ayesha.id, doNotContact: true });
    await mark(HIRA, lead.ayesha.id).expect(409);
    const entry = await prisma.salesDncEntry.findFirstOrThrow({ where: { leadId: lead.ayesha.id } });
    expect(entry).toMatchObject({ emailHmac: hmac('ayesha@northwind-dnc.test'), keyId: 'test', maskedEmail: 'a***@northwind-dnc.test', source: 'manual', createdBy: ids[HIRA], reason: 'Asked us by phone not to contact her' });
    // no column of the entry holds the email itself
    expect(JSON.stringify(entry)).not.toContain('ayesha@');
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'sales.lead.do_not_contact', targetId: lead.ayesha.id } });
    expect(JSON.stringify(audit.details)).not.toContain('ayesha@');
    // a lead without an email can be marked too (no hash)
    expect((await mark(HIRA, lead.noemail.id).expect(200)).body.doNotContact).toBe(true);
    expect(await prisma.salesDncEntry.findFirstOrThrow({ where: { leadId: lead.noemail.id } })).toMatchObject({ emailHmac: null, keyId: null, maskedEmail: null });
  });

  it('entries are never changed or removed, and a lead’s do-not-contact flag never goes away (database triggers)', async () => {
    const entry = await prisma.salesDncEntry.findFirstOrThrow({ where: { leadId: lead.ayesha.id } });
    await expect(prisma.salesDncEntry.update({ where: { id: entry.id }, data: { reason: 'changed' } })).rejects.toThrow(/insert-only/);
    await expect(prisma.salesDncEntry.delete({ where: { id: entry.id } })).rejects.toThrow(/insert-only/);
    await expect(prisma.salesLead.update({ where: { id: lead.ayesha.id }, data: { dncAt: null } })).rejects.toThrow(/dnc_permanent/);
    await expect(prisma.$executeRawUnsafe('TRUNCATE sales_dnc_entries CASCADE')).rejects.toThrow();
    await expect(prisma.salesDncEntry.create({ data: { reason: 'nothing to match', source: 'manual', createdBy: ids[HIRA] } })).rejects.toThrow();
    await expect(prisma.salesDncEntry.create({ data: { emailHmac: 'not-a-hash', keyId: 'test', maskedEmail: 'a***@x.test', reason: 'bad hash', createdBy: ids[HIRA] } })).rejects.toThrow();
  });

  it('the sales manager adds an email without a lead; a lead with that email (whoever owns it) is marked; the list is masked', async () => {
    const res = (await addEmail(DIRECTOR, '  Lena@Fabrikam-DNC.test ', 'Unsubscribed by email').expect(201)).body;
    expect(res).toMatchObject({ maskedEmail: 'l***@fabrikam-dnc.test', reason: 'Unsubscribed by email', source: 'manual', addedBy: { empId: DIRECTOR }, lead: { id: lead.lena.id } });
    expect((await as(KAMRAN).get(`${API}/sales/leads/${lead.lena.id}`).expect(200)).body.doNotContact).toBe(true);
    await addEmail(DIRECTOR, 'lena@fabrikam-dnc.test').expect(409);
    await addEmail(DIRECTOR, 'not an email').expect(400);
    const standalone = (await addEmail(DIRECTOR, 'nobody@globex-dnc.test', 'Asked at a trade fair').expect(201)).body;
    expect(standalone).toMatchObject({ maskedEmail: 'n***@globex-dnc.test', lead: null });
    const list = (await as(DIRECTOR).get(`${API}/sales/do-not-contact`).expect(200)).body;
    expect(list.total).toBe(4);
    expect(JSON.stringify(list)).not.toMatch(/ayesha@|lena@|nobody@/);
    // the CEO / Owner sees the list; a lead's name only to who sees that lead in full
    const ownerView = (await as(OWNER).get(`${API}/sales/do-not-contact`).expect(200)).body;
    expect(ownerView.items.find((x: { maskedEmail: string }) => x.maskedEmail === 'a***@northwind-dnc.test').lead).toMatchObject({ fullName: 'Ayesha Khan' });
  });
});

describe('M15.4 do-not-contact: what it blocks (server-side)', () => {
  it('a listed email cannot become a lead: not added (any case or spaces), not set as a lead’s email', async () => {
    const r = await newLead(KAMRAN, { fullName: 'Ayesha again', email: ' AYESHA@northwind-dnc.test' });
    // the lead still exists (not archived), so the duplicate rule answers first; a bare listed email is refused as DNC
    expect(r.status).toBe(409);
    expect((await newLead(KAMRAN, { fullName: 'Nobody', email: 'Nobody@Globex-DNC.test' }).expect(409)).body.code).toBe('do_not_contact');
    const omar = (await as(HIRA).get(`${API}/sales/leads/${lead.omar.id}`).expect(200)).body;
    expect((await as(HIRA).patch(`${API}/sales/leads/${lead.omar.id}`).send({ email: 'nobody@globex-dnc.test', version: omar.version }).expect(409)).body.code).toBe('do_not_contact');
    expect(await prisma.salesLead.count({ where: { emailNormalized: 'nobody@globex-dnc.test' } })).toBe(0);
  });

  it('outgoing contact on a marked lead is refused, on the lead and on its deals; a reply and a note are still logged', async () => {
    for (const kind of ['call', 'email_sent', 'linkedin', 'whatsapp']) {
      expect((await as(HIRA).post(`${API}/sales/leads/${lead.ayesha.id}/activities`).send({ kind, summary: 'Tried again' }).expect(409)).body.code).toBe('do_not_contact');
    }
    await as(HIRA).post(`${API}/sales/leads/${lead.ayesha.id}/activities`).send({ kind: 'meeting', summary: 'Meeting', meetingAt: new Date(Date.now() + 86_400_000).toISOString() }).expect(409);
    await as(HIRA).post(`${API}/sales/leads/${lead.ayesha.id}/activities`).send({ kind: 'proposal', summary: 'Proposal', proposalUrl: 'https://docs.example.com/p' }).expect(409);
    await as(HIRA).post(`${API}/sales/leads/${lead.ayesha.id}/activities`).send({ kind: 'reply', summary: 'She wrote back to confirm' }).expect(201);
    await as(HIRA).post(`${API}/sales/leads/${lead.ayesha.id}/activities`).send({ kind: 'note', summary: 'Do not contact again' }).expect(201);
    // the same on a deal of the lead (deals are not blocked by the approved rules; contact on them is)
    const deal = (await as(HIRA).post(`${API}/sales/deals`).send({ leadId: lead.ayesha.id, service: 'website', value: '900.00', currency: 'USD', expectedClose: '2027-03-01', nextStep: 'Wait', nextStepDate: '2027-01-15' }).expect(201)).body;
    await as(HIRA).post(`${API}/sales/deals/${deal.id}/activities`).send({ kind: 'call', summary: 'Call' }).expect(409);
    await as(HIRA).post(`${API}/sales/deals/${deal.id}/activities`).send({ kind: 'reply', summary: 'Reply' }).expect(201);
    expect(await prisma.salesActivity.count({ where: { leadId: lead.ayesha.id, kind: { in: ['call', 'email_sent', 'linkedin', 'whatsapp', 'meeting', 'proposal'] } } })).toBe(0);
    // an unmarked lead is not affected
    await as(HIRA).post(`${API}/sales/leads/${lead.omar.id}/activities`).send({ kind: 'call', summary: 'Call' }).expect(201);
  });

  it('protection outlives the lead: after the lead is archived and its email removed, the email still cannot come back', async () => {
    const z = (await newLead(HIRA, { fullName: 'Zara Archived', email: 'zara@woodgrove-dnc.test', company: { name: 'Woodgrove', website: 'woodgrove-dnc.test' } }).expect(201)).body;
    await mark(HIRA, z.id, 'Unsubscribed').expect(200);
    // what M15.5 archiving will do: archive and clear the contact details
    await prisma.salesLead.update({ where: { id: z.id }, data: { archivedAt: new Date(), email: null, emailNormalized: null, phone: null, linkedinUrl: null } });
    expect((await newLead(KAMRAN, { fullName: 'Zara', email: 'Zara@woodgrove-dnc.test' }).expect(409)).body.code).toBe('do_not_contact');
    const imp = (await preview(KAMRAN, 'name,email\nZara,zara@woodgrove-dnc.test\n').expect(201)).body;
    expect(imp.rows[0]).toMatchObject({ status: 'dnc' });
  });

  it('a list entry and a new lead for the same email at the same moment: the lead is never left unmarked', async () => {
    for (let round = 0; round < 5; round++) {
      const email = `race${round}@raceco-dnc.test`;
      const [created, added] = await Promise.all([newLead(KAMRAN, { fullName: `Race ${round}`, email }), addEmail(DIRECTOR, email, 'Unsubscribed at the same moment')]);
      expect(added.status).toBe(201);
      const rows = await prisma.salesLead.findMany({ where: { emailNormalized: email } });
      if (created.status === 201) expect(rows.map((r) => r.dncAt !== null)).toEqual([true]);
      else {
        expect(created.body.code).toBe('do_not_contact');
        expect(rows).toHaveLength(0);
      }
    }
  });

  it('fail-safe: without the key, or with entries made by a key that is no longer configured, nothing is checked and nothing is saved', async () => {
    const make = (env: Record<string, string | undefined>) =>
      new DncService(t.app.get(PrismaService), t.app.get(SalesAccessService), t.app.get(AuditService), t.clock, baseEnv(env));
    const noKey = make({ SALES_DNC_HMAC_KEY: undefined });
    expect(noKey.available).toBe(false);
    await expect(noKey.listed(t.app.get(PrismaService), ['a@b-dnc.test'])).rejects.toMatchObject({ status: 503, response: { code: 'dnc_unavailable' } });
    // a new key without the old one: the old entries (key id "test") could no longer match, so everything stops
    const rotatedBadly = make({ SALES_DNC_HMAC_KEY: Buffer.alloc(32, 1).toString('base64'), SALES_DNC_HMAC_KEY_ID: 'v2' });
    await expect(rotatedBadly.listed(t.app.get(PrismaService), ['ayesha@northwind-dnc.test'])).rejects.toMatchObject({ status: 503, response: { code: 'dnc_key_missing' } });
    // rotated properly (the old key kept as a previous key): old entries still match
    const rotated = make({ SALES_DNC_HMAC_KEY: Buffer.alloc(32, 1).toString('base64'), SALES_DNC_HMAC_KEY_ID: 'v2', SALES_DNC_HMAC_PREVIOUS_KEYS: `test:${TEST_DNC_HMAC_KEY}` });
    expect([...(await rotated.listed(t.app.get(PrismaService), ['ayesha@northwind-dnc.test', 'free@b-dnc.test']))]).toEqual(['ayesha@northwind-dnc.test']);
    // production refuses to start without the key
    expect(() => baseEnv({ NODE_ENV: 'production', SALES_DNC_HMAC_KEY: undefined, COOKIE_SECURE: 'true' })).toThrow(/SALES_DNC_HMAC_KEY/);
    expect(() => baseEnv({ SALES_DNC_HMAC_KEY: 'too-short' })).toThrow(/32 bytes/);
  });
});

// ============================================================================================================= import

const CSV = [
  'name,email,company,website,country,title,source',
  'Grace Holloway,grace@kestrel-imp.test,Kestrel Dental,kestrel-imp.test,United Kingdom,Practice Manager,',
  'Daniel Price,dan@lakeview-imp.test,Lakeview Realty,lakeview-imp.test,United States,Broker,linkedin',
  ',noname@x-imp.test,No Name Ltd,,,,',
  'Tom Reeves,tom.reeves@,Reeves Plumbing,reeves-imp.test,United Kingdom,Owner,',
  'Sophie Turner,sophie@fern-imp.test,Fern & Fig,fern-imp.test,United Kingdom,Founder,newsletter',
  'Marcus Lee,marcus@ridgeline-imp.test,,ridgeline-imp.test,United States,Ops,',
  'Omar Again,OMAR@contoso-dnc.test,Contoso,contoso-dnc.test,,,',
  'Grace Twice,grace@kestrel-imp.test,Kestrel Dental,kestrel-imp.test,,,',
  'Nobody Listed,nobody@globex-dnc.test,Globex,globex-dnc.test,,,',
  '"Fatima Al Nuaimi","fatima@palm-imp.test","Palm Tech, FZE",palm-imp.test,United Arab Emirates,COO,walk-in',
].join('\r\n');

describe('M15.4 import: the preview', () => {
  it('checks every row (valid, duplicate, repeated, do-not-contact, invalid with reasons) and adds nothing yet', async () => {
    const before = await prisma.salesLead.count();
    const res = (await preview(HIRA, CSV, { source: 'apollo' }).expect(201)).body;
    expect(res).toMatchObject({ fileName: 'leads.csv', source: 'apollo', owner: { empId: HIRA }, counts: { ok: 3, duplicate: 1, repeated: 1, dnc: 1, invalid: 4 } });
    const byLine = Object.fromEntries(res.rows.map((r: { line: number }) => [r.line, r]));
    expect(byLine[2]).toMatchObject({ status: 'ok', source: 'apollo', name: 'Grace Holloway' }); // the file's source
    expect(byLine[3]).toMatchObject({ status: 'ok', source: 'linkedin' }); // the row's own source wins
    expect(byLine[4]).toMatchObject({ status: 'invalid', problems: ['name: required'] });
    expect(byLine[5].status).toBe('invalid');
    expect(byLine[5].problems.join()).toMatch(/email/);
    expect(byLine[6]).toMatchObject({ status: 'invalid', source: null });
    expect(byLine[6].problems.join()).toMatch(/Unknown source "newsletter"/);
    expect(byLine[7]).toMatchObject({ status: 'invalid', problems: ['A website needs a company name'] });
    expect(byLine[8]).toMatchObject({ status: 'duplicate', owner: { empId: HIRA } });
    expect(byLine[9]).toMatchObject({ status: 'repeated' });
    expect(byLine[10]).toMatchObject({ status: 'dnc', problems: ['This email is on the do-not-contact list'] });
    expect(byLine[11]).toMatchObject({ status: 'ok', companyName: 'Palm Tech, FZE', source: 'walk_in' });
    expect(await prisma.salesLead.count()).toBe(before);
    const batch = await prisma.salesImportBatch.findUniqueOrThrow({ where: { id: res.batchId } });
    expect(batch).toMatchObject({ status: 'previewed', createdBy: ids[HIRA], ownerId: ids[HIRA], rowCount: 10 });
    expect(batch.fileSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('accepts the columns in the documented order without a header, and refuses wrong files', async () => {
    const res = (await preview(HIRA, 'Ivy Chen,ivy@woodland-imp.test,Woodland,woodland-imp.test,Canada,CEO,referral\n', { source: 'apollo' }).expect(201)).body;
    expect(res.rows[0]).toMatchObject({ line: 1, status: 'ok', name: 'Ivy Chen', source: 'referral', country: 'Canada' });
    expect((await preview(HIRA, 'name,email,phone\nA,a@b.test,123').expect(400)).body.code).toBe('unknown_columns');
    expect((await preview(HIRA, 'email,company\na@b-imp.test,B').expect(400)).body.code).toBe('missing_name_column');
    expect((await preview(HIRA, 'name,email\nA,a@b-imp.test', { name: 'leads.xlsx' }).expect(400)).body.code).toBe('not_csv');
    expect((await preview(HIRA, Buffer.from('name\nA\u0000B', 'utf8')).expect(400)).body.code).toBe('not_csv');
    expect((await preview(HIRA, Buffer.from([0x6e, 0x61, 0x6d, 0x65, 0x0a, 0xff, 0xfe])).expect(400)).body.code).toBe('not_csv');
    expect((await preview(HIRA, 'name\n').expect(400)).body.code).toBe('empty_file');
    expect((await preview(HIRA, 'name,email\nA,a@b-imp.test', { source: 'newsletter' }).expect(400)).body.code).toBe('validation_failed');
    const tooMany = ['name', ...Array.from({ length: 5001 }, (_, i) => `Person ${i}`)].join('\n');
    expect((await preview(HIRA, tooMany).expect(400)).body.code).toBe('too_many_rows');
    const big = await preview(HIRA, Buffer.alloc(SALES_IMPORT_MAX_BYTES + 10, 'a'));
    expect([400, 413]).toContain(big.status);
    await as(HIRA).post(`${API}/sales/leads/import/preview`).field('source', 'apollo').expect(400); // no file
  });

  it('the owner is the uploader; only the sales manager imports for someone in their team; the CEO / Owner cannot', async () => {
    await preview(HIRA, 'name\nA Person', { ownerEmpId: KAMRAN }).expect(403);
    await preview(OWNER, 'name\nA Person', { ownerEmpId: HIRA }).expect(403);
    expect((await preview(DIRECTOR, 'name\nA Person', { ownerEmpId: HIRA }).expect(201)).body.owner).toMatchObject({ empId: HIRA });
  });
});

describe('M15.4 import: the commit', () => {
  it('adds the good rows for the owner, records who imported and when, and is recorded once by Module 4', async () => {
    const pre = (await preview(HIRA, CSV, { source: 'apollo' }).expect(201)).body;
    const res = (await commit(HIRA, pre.batchId).expect(200)).body;
    expect(res).toMatchObject({ batchId: pre.batchId, created: 3, committedBy: { empId: HIRA } });
    expect(res.skipped.map((s: { line: number; status: string }) => `${s.line}:${s.status}`)).toEqual(['4:invalid', '5:invalid', '6:invalid', '7:invalid', '8:duplicate', '9:repeated', '10:dnc']);
    const made = await prisma.salesLead.findMany({ where: { importBatchId: pre.batchId }, include: { company: true }, orderBy: { fullName: 'asc' } });
    expect(made.map((l) => [l.fullName, l.source, l.ownerId === ids[HIRA], l.createdBy === ids[HIRA], l.company?.domain])).toEqual([
      ['Daniel Price', 'linkedin', true, true, 'lakeview-imp.test'],
      ['Fatima Al Nuaimi', 'walk_in', true, true, 'palm-imp.test'],
      ['Grace Holloway', 'apollo', true, true, 'kestrel-imp.test'],
    ]);
    const batch = await prisma.salesImportBatch.findUniqueOrThrow({ where: { id: pre.batchId } });
    expect(batch).toMatchObject({ status: 'committed', rows: [] }); // the contact details of the preview are gone
    expect(batch.committedAt).not.toBeNull();
    expect(await prisma.auditLog.count({ where: { action: 'sales.lead.created', details: { path: ['importBatch'], equals: pre.batchId } } })).toBe(3);
    expect(await prisma.auditLog.count({ where: { action: 'sales.leads.imported', targetId: pre.batchId } })).toBe(1);
    const events = (await salesEvents()).filter((e) => e.description === 'Imported 3 leads');
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ action: 'create', employeeId: ids[HIRA] });
    // committing again (a retry, a double click) changes nothing and returns the same result
    expect((await commit(HIRA, pre.batchId).expect(200)).body).toEqual(res);
    expect(await prisma.salesLead.count({ where: { importBatchId: pre.batchId } })).toBe(3);
    // someone else's batch does not exist for them
    await commit(KAMRAN, pre.batchId).expect(404);
    await commit(DIRECTOR, pre.batchId).expect(404);
  });

  it('re-checks every row: one that became a duplicate or do-not-contact since the preview is skipped, never forced in', async () => {
    const pre = (await preview(HIRA, 'name,email,company,website\nRita Late,rita@late-imp.test,Late Co,late-imp.test\nSam Late,sam@late2-imp.test,Late2,late2-imp.test\nUma Ok,uma@ok-imp.test,Ok Co,ok-imp.test\n').expect(201)).body;
    expect(pre.counts.ok).toBe(3);
    await newLead(KAMRAN, { fullName: 'Rita (Kamran)', email: 'rita@late-imp.test' }).expect(201);
    await addEmail(DIRECTOR, 'sam@late2-imp.test', 'Unsubscribed meanwhile').expect(201);
    const res = (await commit(HIRA, pre.batchId).expect(200)).body;
    expect(res).toMatchObject({ created: 1, skipped: [{ line: 2, status: 'duplicate' }, { line: 3, status: 'dnc' }] });
    expect(await prisma.salesLead.count({ where: { emailNormalized: 'rita@late-imp.test' } })).toBe(1);
    expect(await prisma.salesLead.count({ where: { emailNormalized: 'sam@late2-imp.test' } })).toBe(0);
  });

  it('a preview older than 30 minutes is refused (upload again); its rows are cleared', async () => {
    const pre = (await preview(HIRA, 'name,email\nOld One,old@expired-imp.test').expect(201)).body;
    await prisma.salesImportBatch.update({ where: { id: pre.batchId }, data: { expiresAt: new Date(Date.now() - 1000) } });
    expect((await commit(HIRA, pre.batchId).expect(409)).body.code).toBe('import_expired');
    expect(await prisma.salesImportBatch.findUniqueOrThrow({ where: { id: pre.batchId } })).toMatchObject({ status: 'expired', rows: [] });
    expect(await prisma.salesLead.count({ where: { emailNormalized: 'old@expired-imp.test' } })).toBe(0);
  });

  it('all or nothing: a commit that fails part-way adds no lead and leaves the preview to try again', async () => {
    const pre = (await preview(HIRA, 'name,email\nAll One,one@atomic-imp.test\nAll Two,two@atomic-imp.test\nAll Three,three@atomic-imp.test').expect(201)).body;
    // break the third stored row so the commit fails after adding the first two
    const batch = await prisma.salesImportBatch.findUniqueOrThrow({ where: { id: pre.batchId } });
    const rows = batch.rows as Array<{ lead: { fullName: string } }>;
    rows[2].lead.fullName = '';
    await prisma.salesImportBatch.update({ where: { id: pre.batchId }, data: { rows } });
    const failed = await commit(HIRA, pre.batchId);
    expect(failed.status).toBeGreaterThanOrEqual(400);
    expect(await prisma.salesLead.count({ where: { emailNormalized: { endsWith: '@atomic-imp.test' } } })).toBe(0);
    expect(await prisma.salesImportBatch.findUniqueOrThrow({ where: { id: pre.batchId } })).toMatchObject({ status: 'previewed', committedAt: null });
    expect(await prisma.auditLog.count({ where: { action: 'sales.leads.imported', targetId: pre.batchId } })).toBe(0);
  });

  it('the same preview committed twice at the same moment adds its leads once', async () => {
    const pre = (await preview(HIRA, 'name,email\nTwin One,one@twin-imp.test\nTwin Two,two@twin-imp.test').expect(201)).body;
    const [a, b] = await Promise.all([commit(HIRA, pre.batchId), commit(HIRA, pre.batchId)]);
    expect([a.status, b.status]).toEqual([200, 200]);
    expect(a.body).toEqual(b.body);
    expect(await prisma.salesLead.count({ where: { emailNormalized: { endsWith: '@twin-imp.test' } } })).toBe(2);
  });

  it('two people importing overlapping files at the same moment: every email becomes exactly one lead', async () => {
    const rows = (from: number, to: number) => ['name,email', ...Array.from({ length: to - from }, (_, i) => `Person ${from + i},p${from + i}@overlap-imp.test`)].join('\n');
    const hira = (await preview(HIRA, rows(0, 60)).expect(201)).body;
    const kamran = (await preview(KAMRAN, rows(30, 90)).expect(201)).body;
    const [h, k] = await Promise.all([commit(HIRA, hira.batchId), commit(KAMRAN, kamran.batchId)]);
    expect([h.status, k.status]).toEqual([200, 200]);
    expect(h.body.created + k.body.created).toBe(90);
    const made = await prisma.salesLead.findMany({ where: { emailNormalized: { endsWith: '@overlap-imp.test' } }, select: { emailNormalized: true } });
    expect(made).toHaveLength(90);
    expect(new Set(made.map((m) => m.emailNormalized)).size).toBe(90);
    // the overlap went to whoever committed first; the other side reports those rows as duplicates
    const dupes = [...h.body.skipped, ...k.body.skipped].filter((s: { status: string }) => s.status === 'duplicate');
    expect(dupes).toHaveLength(30);
  });

  it('an imported lead follows the same rules: marked do not contact later, outgoing contact on it is refused', async () => {
    const imported = await prisma.salesLead.findFirstOrThrow({ where: { emailNormalized: 'grace@kestrel-imp.test' } });
    await addEmail(DIRECTOR, 'grace@kestrel-imp.test', 'Unsubscribed after the import').expect(201);
    expect((await as(HIRA).get(`${API}/sales/leads/${imported.id}`).expect(200)).body.doNotContact).toBe(true);
    await as(HIRA).post(`${API}/sales/leads/${imported.id}/activities`).send({ kind: 'email_sent', summary: 'Intro' }).expect(409);
  });
});
