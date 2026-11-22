import { randomUUID } from 'node:crypto';
import type { ArgumentsHost } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/access/access.types';
import { CommsErrorFilter } from '../src/comms/comms-errors';
import { MessageService } from '../src/comms/message.service';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type SignedIn, type TestApp } from './helpers/app';
import { createEmployee } from './helpers/people';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 14, part 1 (M14.1): conversations and messages over REST, against the real database.
 * The numbered describe blocks follow the M14.1 acceptance list.
 */
const API = '/api/v1/comms';
const OWNER = 'ACV-0001';
const DIRECTOR = 'ACV-0003'; // comms.admin
const CTO = 'ACV-0004'; // comms.admin, head of dep-eng
const DEV1 = 'ACV-0006'; // dep-eng
const DEV2 = 'ACV-0007'; // dep-eng
const DEV3 = 'ACV-0008'; // dep-eng
const SALES1 = 'ACV-0009'; // dep-sales
const FINANCE = 'ACV-0010'; // dep-fin
const SQA = 'ACV-0011'; // dep-eng
let CEO = '';

/** A unique word put in private messages; it must never show up in a log, an audit record or an event. */
const SECRET = `zq${randomUUID().replace(/-/g, '').slice(0, 14)}`;

let t: TestApp;
let prisma: PrismaClient;
const ids: Record<string, string> = {};

// ---- Everything the application writes to the console while this file runs (Nest's logger writes to stdout/stderr) ----
const captured: string[] = [];
const restore: Array<() => void> = [];
function captureOutput() {
  for (const stream of [process.stdout, process.stderr]) {
    const original = stream.write.bind(stream);
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      captured.push(typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk));
      return (original as (...a: unknown[]) => boolean)(chunk, ...rest);
    }) as typeof stream.write;
    restore.push(() => (stream.write = original as typeof stream.write));
  }
  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const original = console[level];
    console[level] = (...args: unknown[]) => {
      captured.push(args.map((a) => (typeof a === 'string' ? a : a instanceof Error ? `${a.message}\n${a.stack}` : JSON.stringify(a))).join(' '));
      original(...args);
    };
    restore.push(() => (console[level] = original));
  }
}

const as = (empId: string) => t.as(empId);
const conv = (id: string) => `${API}/conversations/${id}`;
const msg = (id: string) => `${API}/messages/${id}`;

async function create(who: string, body: Record<string, unknown>, status = 201) {
  const res = await as(who).post(`${API}/conversations`).send(body);
  expect(res.status, JSON.stringify(res.body)).toBe(status);
  return res.body.conversation;
}

async function send(who: string, conversationId: string, body: string, extra: Record<string, unknown> = {}) {
  const res = await as(who).post(`${conv(conversationId)}/messages`).send({ clientKey: randomUUID(), body, ...extra });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body.message;
}

async function actorOf(empId: string): Promise<Actor> {
  const e = await prisma.employee.findUniqueOrThrow({ where: { empId }, select: { id: true, empId: true, fullName: true, level: { select: { number: true } }, role: { select: { key: true } } } });
  return { id: e.id, empId: e.empId, fullName: e.fullName, levelNumber: e.level.number, roleKey: e.role.key };
}

/** A message written straight into the database some hours ago (the clock cannot be moved by a day without ending every session). */
async function oldMessage(conversationId: string, authorEmpId: string, hoursAgo: number, body: string) {
  return prisma.$transaction(async (tx) => {
    const [{ last_seq }] = await tx.$queryRaw<Array<{ last_seq: number }>>`UPDATE "conversations" SET "last_seq" = "last_seq" + 1 WHERE "id" = ${conversationId}::uuid RETURNING "last_seq"`;
    return tx.message.create({
      data: { conversationId, seq: last_seq, authorId: ids[authorEmpId], body, clientKey: randomUUID(), requestHash: 'fixture', createdAt: new Date(t.clock.now().getTime() - hoursAgo * 3_600_000) },
    });
  });
}

/** Move to a fresh minute, so the per-person sending limit of an earlier test does not carry over. */
const nextMinute = () => t.clock.advance(61_000);

async function moveDepartment(empId: string, departmentId: string) {
  const res = await as(DIRECTOR).patch(`/api/v1/employees/${empId}/basic`).send({ departmentId, reason: 'Module 14 test: department move' });
  expect(res.status, JSON.stringify(res.body)).toBe(200);
}

beforeAll(async () => {
  captureOutput();
  t = await createTestApp();
  await t.signInAll();
  CEO = OWNER; // final company structure (main): the CEO, Founder and Owner are one person, ACV-0001
  prisma = createTestPrisma();
  for (const e of await prisma.employee.findMany({ select: { id: true, empId: true } })) ids[e.empId] = e.id;
});

afterAll(async () => {
  for (const r of restore.reverse()) r();
  t.clock.reset();
  await t.close();
  await prisma.$disconnect();
  // Like every file that signs people in: leave a clean test database (authenticator set-ups, sessions) for the next file.
  await resetTestDatabase();
}, 120_000);

// Shared conversations, made by the first tests.
let dm = ''; // DEV1 and DEV2
let dmSecretMessage = '';

describe('1. a DM is visible to its two participants only', () => {
  it('starts a DM and keeps it from everyone else, including managers and admins', async () => {
    const c = await create(DEV1, { kind: 'dm', empId: DEV2 });
    dm = c.id;
    expect(c).toMatchObject({ kind: 'dm', dmWith: { empId: DEV2 }, myRole: 'member' });
    expect(c.members.map((m: { empId: string }) => m.empId)).toEqual([DEV1, DEV2]);
    dmSecretMessage = (await send(DEV1, dm, `Private note ${SECRET} for Mariam`)).id;

    expect((await as(DEV2).get(conv(dm)).expect(200)).body.dmWith.empId).toBe(DEV1);
    const messages = (await as(DEV2).get(`${conv(dm)}/messages`).expect(200)).body;
    expect(messages.items.map((m: { body: string }) => m.body)).toEqual([`Private note ${SECRET} for Mariam`]);

    // The CTO manages both developers, the Director and the CTO are comms admins, the Owner and CEO are at the top:
    // none of them can see the DM.
    for (const outsider of [DEV3, CTO, DIRECTOR, OWNER, CEO, FINANCE]) {
      await as(outsider).get(conv(dm)).expect(404);
      await as(outsider).get(`${conv(dm)}/messages`).expect(404);
      const list = (await as(outsider).get(`${API}/conversations`).expect(200)).body.items as Array<{ id: string }>;
      expect(list.some((x) => x.id === dm)).toBe(false);
      const hits = (await as(outsider).get(`${API}/search?q=${SECRET}`).expect(200)).body.items;
      expect(hits).toEqual([]);
    }
  });

  it('needs a login and the CSRF token', async () => {
    await t.anonymous().get(`${API}/conversations`).expect(401);
    const dev1 = as(DEV1) as SignedIn;
    const noCsrf = await request(t.app.getHttpServer()).post(`${conv(dm)}/messages`).set('Cookie', dev1.cookie).send({ clientKey: randomUUID(), body: 'hello' });
    expect(noCsrf.status).toBe(403);
    expect(noCsrf.body.code).toBe('csrf_invalid');
  });
});

describe('2. non-members get 404 for every operation on a private conversation', () => {
  it('answers 404 to an outsider on every conversation and message route', async () => {
    const outsider = as(DEV3);
    const m = dmSecretMessage;
    const calls: Array<[string, () => request.Test]> = [
      ['detail', () => outsider.get(conv(dm))],
      ['rename', () => outsider.patch(conv(dm)).send({ name: 'Taken' })],
      ['archive', () => outsider.post(`${conv(dm)}/archive`).send({ reason: 'Not mine to archive' })],
      ['add members', () => outsider.post(`${conv(dm)}/members`).send({ empIds: [DEV3] })],
      ['remove member', () => outsider.delete(`${conv(dm)}/members/${DEV2}`)],
      ['add moderator', () => outsider.put(`${conv(dm)}/moderators/${DEV3}`)],
      ['remove moderator', () => outsider.delete(`${conv(dm)}/moderators/${DEV1}`)],
      ['read', () => outsider.post(`${conv(dm)}/read`).send({ seq: 1 })],
      ['delivered', () => outsider.post(`${conv(dm)}/delivered`).send({ seq: 1 })],
      ['history', () => outsider.get(`${conv(dm)}/messages`)],
      ['send', () => outsider.post(`${conv(dm)}/messages`).send({ clientKey: randomUUID(), body: 'let me in' })],
      ['reply', () => outsider.post(`${conv(dm)}/messages`).send({ clientKey: randomUUID(), body: 'reply', parentId: m })],
      ['pins', () => outsider.get(`${conv(dm)}/pins`)],
      ['thread', () => outsider.get(`${msg(m)}/thread`)],
      ['edit', () => outsider.patch(msg(m)).send({ body: 'changed' })],
      ['delete', () => outsider.delete(msg(m))],
      ['remove', () => outsider.post(`${msg(m)}/remove`).send({ reason: 'Moderating a DM' })],
      ['react', () => outsider.put(`${msg(m)}/reactions/${encodeURIComponent('👍')}`)],
      ['unreact', () => outsider.delete(`${msg(m)}/reactions/${encodeURIComponent('👍')}`)],
      ['pin', () => outsider.put(`${msg(m)}/pin`)],
      ['unpin', () => outsider.delete(`${msg(m)}/pin`)],
      ['save', () => outsider.put(`${msg(m)}/save`)],
      ['unsave', () => outsider.delete(`${msg(m)}/save`)],
      ['search in it', () => outsider.get(`${API}/search?q=note&conversationId=${dm}`)],
    ];
    for (const [name, call] of calls) {
      const res = await call();
      expect(res.status, `${name}: ${JSON.stringify(res.body)}`).toBe(404);
      expect(res.body.code, name).toBe('not_found');
    }
    // Unknown ids look exactly the same.
    await outsider.get(conv(randomUUID())).expect(404);
    await outsider.get(`${msg(randomUUID())}/thread`).expect(404);
    // Nothing was changed by any of those calls.
    expect(await prisma.message.count({ where: { conversationId: dm } })).toBe(1);
    expect(await prisma.messageReaction.count({ where: { messageId: m } })).toBe(0);
    expect(await prisma.savedMessage.count({ where: { messageId: m } })).toBe(0);
  });

  it('keeps comms admins out of groups (only channels can be managed by an admin who is not a member)', async () => {
    const g = await create(DEV1, { kind: 'group', name: 'Backend guild', memberEmpIds: [DEV2] });
    await as(DIRECTOR).get(conv(g.id)).expect(404);
    await as(DIRECTOR).post(`${conv(g.id)}/members`).send({ empIds: [DIRECTOR] }).expect(404);
    await as(DIRECTOR).put(`${conv(g.id)}/moderators/${DIRECTOR}`).expect(404);
    await as(DIRECTOR).post(`${conv(g.id)}/archive`).send({ reason: 'Admin archive attempt' }).expect(404);
  });
});

describe('3. starting the same DM twice reuses the conversation', () => {
  it('returns the existing DM, whoever starts it', async () => {
    const again = await as(DEV1).post(`${API}/conversations`).send({ kind: 'dm', empId: DEV2 }).expect(200);
    expect(again.body).toMatchObject({ created: false, conversation: { id: dm } });
    const reverse = await as(DEV2).post(`${API}/conversations`).send({ kind: 'dm', empId: DEV1 }).expect(200);
    expect(reverse.body.conversation.id).toBe(dm);
  });

  it('makes exactly one DM when both people start it at the same moment', async () => {
    const [a, b, c] = await Promise.all([
      as(SQA).post(`${API}/conversations`).send({ kind: 'dm', empId: DEV3 }),
      as(DEV3).post(`${API}/conversations`).send({ kind: 'dm', empId: SQA }),
      as(SQA).post(`${API}/conversations`).send({ kind: 'dm', empId: DEV3 }),
    ]);
    expect([a.status, b.status, c.status].filter((s) => s === 201)).toHaveLength(1);
    expect(new Set([a.body.conversation.id, b.body.conversation.id, c.body.conversation.id]).size).toBe(1);
    const key = [ids[SQA], ids[DEV3]].sort().join(':');
    expect(await prisma.conversation.count({ where: { dmKey: key } })).toBe(1);
    expect(await prisma.conversationMember.count({ where: { conversationId: a.body.conversation.id } })).toBe(2);
  }, 60_000);

  it('refuses a DM with yourself or with someone who is not a current employee', async () => {
    expect((await as(DEV1).post(`${API}/conversations`).send({ kind: 'dm', empId: DEV1 }).expect(400)).body.code).toBe('cannot_message_self');
    expect((await as(DEV1).post(`${API}/conversations`).send({ kind: 'dm', empId: 'ACV-9999' }).expect(400)).body.code).toBe('unknown_or_inactive_employee');
  });
});

describe('4 and 5. retry keys', () => {
  it('saves a retried send once and answers the retry with the same message', async () => {
    nextMinute();
    const key = randomUUID();
    const first = await as(DEV1).post(`${conv(dm)}/messages`).send({ clientKey: key, body: 'Deploy at 5?' }).expect(201);
    const retry = await as(DEV1).post(`${conv(dm)}/messages`).send({ clientKey: key, body: 'Deploy at 5?' }).expect(200);
    expect(retry.body.created).toBe(false);
    expect(retry.body.message.id).toBe(first.body.message.id);
    expect(retry.body.message.seq).toBe(first.body.message.seq);
    expect(await prisma.message.count({ where: { authorId: ids[DEV1], clientKey: key } })).toBe(1);
  });

  it('saves one message when the same send arrives several times at once, without a gap in the numbers', async () => {
    const key = randomUUID();
    const before = (await prisma.conversation.findUniqueOrThrow({ where: { id: dm } })).lastSeq;
    const results = await Promise.all([1, 2, 3, 4].map(() => as(DEV2).post(`${conv(dm)}/messages`).send({ clientKey: key, body: 'Yes, 5 works' })));
    for (const r of results) expect([200, 201]).toContain(r.status);
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(new Set(results.map((r) => r.body.message.id)).size).toBe(1);
    expect(await prisma.message.count({ where: { authorId: ids[DEV2], clientKey: key } })).toBe(1);
    // The losing sends had taken the next number inside their transaction; their rollback gave it back.
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: dm } })).lastSeq).toBe(before + 1);
    expect(results[0].body.message.seq).toBe(before + 1);
  });

  it('refuses a retry key reused with different content, or in another conversation', async () => {
    const key = randomUUID();
    await as(DEV1).post(`${conv(dm)}/messages`).send({ clientKey: key, body: 'Original text' }).expect(201);
    const changed = await as(DEV1).post(`${conv(dm)}/messages`).send({ clientKey: key, body: 'Different text' }).expect(409);
    expect(changed.body.code).toBe('client_key_reused');
    const other = await create(DEV1, { kind: 'dm', empId: DEV3 });
    const elsewhere = await as(DEV1).post(`${conv(other.id)}/messages`).send({ clientKey: key, body: 'Original text' }).expect(409);
    expect(elsewhere.body.code).toBe('client_key_reused');
    const asReply = await as(DEV1).post(`${conv(dm)}/messages`).send({ clientKey: key, body: 'Original text', parentId: dmSecretMessage }).expect(409);
    expect(asReply.body.code).toBe('client_key_reused');
    expect(await prisma.message.count({ where: { authorId: ids[DEV1], clientKey: key } })).toBe(1);
  });
});

describe('6 and 7. sequence numbers', () => {
  it('numbers concurrent messages one after another, with no gaps and no duplicates', async () => {
    nextMinute();
    const g = await create(DEV1, { kind: 'group', name: 'Load test', memberEmpIds: [DEV2, DEV3] });
    const sends = [DEV1, DEV2, DEV3].flatMap((who) => Array.from({ length: 6 }, (_, i) => as(who).post(`${conv(g.id)}/messages`).send({ clientKey: randomUUID(), body: `burst ${who} ${i}` })));
    const results = await Promise.all(sends);
    for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(201);
    const seqs = results.map((r) => r.body.message.seq as number).sort((a, b) => a - b);
    expect(seqs).toEqual(Array.from({ length: 18 }, (_, i) => i + 1));
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: g.id } })).lastSeq).toBe(18);
  }, 60_000);

  it('does not use up a number when the send is rolled back, and the database error carries no message text', async () => {
    const svc = t.app.get(MessageService);
    const actor = await actorOf(DEV1);
    const before = (await prisma.conversation.findUniqueOrThrow({ where: { id: dm } })).lastSeq;
    // Called past the request validation: the database refuses a 4,001-character text after the number was taken.
    const error = (await svc.send(actor, dm, { clientKey: randomUUID(), body: `${SECRET} ${'x'.repeat(4001)}` }).then(() => null, (e: unknown) => e)) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(`${error.message}\n${error.stack}`).not.toContain(SECRET);
    expect(error.message).toContain('rule=message_rule');
    expect((await prisma.conversation.findUniqueOrThrow({ where: { id: dm } })).lastSeq).toBe(before);
    const next = await send(DEV1, dm, 'After the failed one');
    expect(next.seq).toBe(before + 1);
  });

  it('refuses a message number the conversation did not give out, and refuses deleting a message, at the database', async () => {
    const tooFar = prisma.message.create({ data: { conversationId: dm, seq: 9999, authorId: ids[DEV1], body: 'x', clientKey: randomUUID(), requestHash: 'x' } });
    await expect(tooFar).rejects.toThrow(/message_rule/);
    await expect(prisma.message.delete({ where: { id: dmSecretMessage } })).rejects.toThrow(/never deleted/);
    await expect(prisma.conversation.delete({ where: { id: dm } })).rejects.toThrow(/never deleted/);
  });
});

describe('8. replies, reactions, mentions, pins and saved messages enforce membership', () => {
  let group = '';
  let top = '';

  it('accepts replies only to a top-level message of the same conversation', async () => {
    nextMinute();
    group = (await create(DEV1, { kind: 'group', name: 'Release crew', memberEmpIds: [DEV2, DEV3] })).id;
    top = (await send(DEV1, group, 'Release checklist')).id;
    const reply = await send(DEV2, group, 'Tests are green', { parentId: top });
    expect(reply.parentId).toBe(top);
    const bad = async (parentId: string) => (await as(DEV2).post(`${conv(group)}/messages`).send({ clientKey: randomUUID(), body: 'reply', parentId }).expect(400)).body.code;
    expect(await bad(reply.id)).toBe('invalid_reply_target'); // a reply to a reply
    expect(await bad(dmSecretMessage)).toBe('invalid_reply_target'); // a message of another conversation
    expect(await bad(randomUUID())).toBe('invalid_reply_target');
    const thread = (await as(DEV3).get(`${msg(top)}/thread`).expect(200)).body;
    expect(thread.parent.replyCount).toBe(1);
    expect(thread.items.map((m: { id: string }) => m.id)).toEqual([reply.id]);
  });

  it('accepts mentions of members only, by Emp-ID, and records an event without the text', async () => {
    const m = await send(DEV1, group, `@${DEV2} and @${DEV3} please review ${SECRET}`);
    expect(m.mentions).toEqual([DEV2, DEV3]);
    const notMember = await as(DEV1).post(`${conv(group)}/messages`).send({ clientKey: randomUUID(), body: `@${SALES1} can you look?` }).expect(400);
    expect(notMember.body).toMatchObject({ code: 'mention_not_member', empIds: [SALES1] });
    const events = await prisma.outboxEvent.findMany({ where: { type: 'comms.mention' } });
    const mine = events.filter((e) => (e.payload as { messageId: string }).messageId === m.id);
    expect(mine.map((e) => (e.payload as { mentionedEmpId: string }).mentionedEmpId).sort()).toEqual([DEV2, DEV3]);
    const created = (await prisma.outboxEvent.findMany({ where: { type: 'comms.message.created' } })).find((e) => (e.payload as { messageId: string }).messageId === m.id)!;
    expect(created.payload).toEqual({ conversationId: group, conversationKind: 'group', messageId: m.id, seq: m.seq, authorEmpId: DEV1, parentMessageId: null, mentionedEmpIds: [DEV2, DEV3] });
  });

  it('stores one reaction per person and emoji, one pin and one save', async () => {
    const thumbs = encodeURIComponent('👍');
    await as(DEV2).put(`${msg(top)}/reactions/${thumbs}`).expect(200);
    const again = (await as(DEV2).put(`${msg(top)}/reactions/${thumbs}`).expect(200)).body;
    await as(DEV3).put(`${msg(top)}/reactions/${thumbs}`).expect(200);
    expect((await as(DEV1).get(`${conv(group)}/messages`).expect(200)).body.items.find((x: { id: string }) => x.id === top).reactions).toEqual([{ emoji: '👍', empIds: [DEV2, DEV3], count: 2 }]);
    expect(again.reactions[0].count).toBe(1);
    expect(await prisma.messageReaction.count({ where: { messageId: top } })).toBe(2);
    await as(DEV2).delete(`${msg(top)}/reactions/${thumbs}`).expect(200);
    expect(await prisma.messageReaction.count({ where: { messageId: top } })).toBe(1);
    expect((await as(DEV2).put(`${msg(top)}/reactions/not-an-emoji`)).status).toBe(400);

    // In a group, any member may pin.
    await as(DEV3).put(`${msg(top)}/pin`).expect(200);
    await as(DEV2).put(`${msg(top)}/pin`).expect(200);
    expect(await prisma.pinnedMessage.count({ where: { messageId: top } })).toBe(1);
    expect((await as(DEV1).get(`${conv(group)}/pins`).expect(200)).body.map((x: { id: string }) => x.id)).toEqual([top]);

    await as(DEV3).put(`${msg(top)}/save`).expect(200);
    expect((await as(DEV3).put(`${msg(top)}/save`).expect(200)).body.savedByMe).toBe(true);
    expect(await prisma.savedMessage.count({ where: { messageId: top } })).toBe(1);
    expect((await as(DEV3).get(`${API}/saved`).expect(200)).body.items.map((x: { message: { id: string } }) => x.message.id)).toContain(top);
  });

  it('takes everything away from someone removed from the group, including their saved messages', async () => {
    await as(DEV1).delete(`${conv(group)}/members/${DEV3}`).expect(200);
    await as(DEV3).get(conv(group)).expect(404);
    await as(DEV3).get(`${msg(top)}/thread`).expect(404);
    await as(DEV3).put(`${msg(top)}/reactions/${encodeURIComponent('🎉')}`).expect(404);
    await as(DEV3).post(`${conv(group)}/messages`).send({ clientKey: randomUUID(), body: 'still here?' }).expect(404);
    expect((await as(DEV3).get(`${API}/saved`).expect(200)).body.items.map((x: { message: { id: string } }) => x.message.id)).not.toContain(top);
    expect((await as(DEV3).get(`${API}/search?q=checklist`).expect(200)).body.items).toEqual([]);
    // A mention of someone who is no longer a member is refused.
    expect((await as(DEV1).post(`${conv(group)}/messages`).send({ clientKey: randomUUID(), body: `@${DEV3} hi` }).expect(400)).body.code).toBe('mention_not_member');
    const removed = (await prisma.outboxEvent.findMany({ where: { type: 'comms.member.removed' } })).map((e) => e.payload);
    expect(removed).toContainEqual({ conversationId: group, empId: DEV3, byEmpId: DEV1, reason: 'removed' });
  });

  it('lets a member leave a group (and then they are an outsider)', async () => {
    await as(DEV2).delete(`${conv(group)}/members/${DEV2}`).expect(200);
    await as(DEV2).get(conv(group)).expect(404);
    expect((await prisma.outboxEvent.findMany({ where: { type: 'comms.member.removed' } })).map((e) => e.payload)).toContainEqual({ conversationId: group, empId: DEV2, byEmpId: DEV2, reason: 'left' });
  });
});

describe('9. editing is limited to the author and to 24 hours', () => {
  it('lets the author edit within 24 hours and keeps the older text', async () => {
    const m = await send(DEV1, dm, 'Meeting at 3');
    const edited = (await as(DEV1).patch(msg(m.id)).send({ body: 'Meeting at 4' }).expect(200)).body;
    expect(edited).toMatchObject({ body: 'Meeting at 4', seq: m.seq });
    expect(edited.editedAt).not.toBeNull();
    const revisions = await prisma.messageRevision.findMany({ where: { messageId: m.id } });
    expect(revisions.map((r) => [r.revision, r.kind, r.body])).toEqual([[1, 'edited', 'Meeting at 3']]);
    expect((await as(DEV2).patch(msg(m.id)).send({ body: 'Hijacked' }).expect(403)).body.code).toBe('not_author');

    const almost = await oldMessage(dm, DEV1, 23, 'Written 23 hours ago');
    await as(DEV1).patch(msg(almost.id)).send({ body: 'Edited at 23 hours' }).expect(200);
    const tooOld = await oldMessage(dm, DEV1, 24.1, 'Written a day ago');
    expect((await as(DEV1).patch(msg(tooOld.id)).send({ body: 'Too late' }).expect(409)).body.code).toBe('edit_window_closed');
    expect((await prisma.message.findUniqueOrThrow({ where: { id: tooOld.id } })).body).toBe('Written a day ago');
    // ... but deleting is allowed at any time.
    expect((await as(DEV1).delete(msg(tooOld.id)).expect(200)).body.deleted).toBe(true);
  });
});

describe('10. deleting leaves a placeholder and keeps every older version', () => {
  it('keeps the edit and delete history in the database and never shows it', async () => {
    const m = await send(DEV2, dm, `First draft ${SECRET}`);
    await as(DEV2).patch(msg(m.id)).send({ body: 'Second draft' }).expect(200);
    await as(DEV2).put(`${msg(m.id)}/pin`).expect(200);
    await as(DEV1).put(`${msg(m.id)}/save`).expect(200);
    expect((await as(DEV1).delete(msg(m.id)).expect(403)).body.code).toBe('not_author');
    const deleted = (await as(DEV2).delete(msg(m.id)).expect(200)).body;
    expect(deleted).toMatchObject({ id: m.id, seq: m.seq, deleted: true, deletedAs: 'author', body: '', mentions: [], pinned: false });

    const history = (await as(DEV1).get(`${conv(dm)}/messages?limit=100`).expect(200)).body.items as Array<{ id: string; body: string; deleted: boolean }>;
    expect(history.find((x) => x.id === m.id)).toMatchObject({ body: '', deleted: true });
    expect(JSON.stringify(history)).not.toContain('Second draft');
    expect((await as(DEV1).get(`${API}/search?q=draft`).expect(200)).body.items).toEqual([]);

    const revisions = await prisma.messageRevision.findMany({ where: { messageId: m.id }, orderBy: { revision: 'asc' } });
    expect(revisions.map((r) => [r.revision, r.kind, r.body])).toEqual([
      [1, 'edited', `First draft ${SECRET}`],
      [2, 'deleted', 'Second draft'],
    ]);
    expect((await prisma.message.findUniqueOrThrow({ where: { id: m.id } })).body).toBe('');
    // A deleted message cannot be edited or reacted to; deleting again changes nothing.
    expect((await as(DEV2).patch(msg(m.id)).send({ body: 'Back' }).expect(409)).body.code).toBe('message_deleted');
    expect((await as(DEV1).put(`${msg(m.id)}/reactions/${encodeURIComponent('👍')}`).expect(409)).body.code).toBe('message_deleted');
    await as(DEV2).delete(msg(m.id)).expect(200);
    expect(await prisma.messageRevision.count({ where: { messageId: m.id } })).toBe(2);
    // Older versions can never be changed or removed.
    await expect(prisma.messageRevision.update({ where: { id: revisions[0].id }, data: { body: 'rewritten' } })).rejects.toThrow(/insert-only/);
    await expect(prisma.messageRevision.delete({ where: { id: revisions[0].id } })).rejects.toThrow(/insert-only/);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'comms.message.deleted', targetId: m.id } });
    expect(audit.details).toMatchObject({ conversationId: dm, seq: m.seq, authorEmpId: DEV2, revision: 2 });
  }, 60_000);
});

// Department channel for dep-eng (made by the CTO, a comms admin and the head of dep-eng).
let eng = '';

describe('11, 12 and 17. channels: permissions, moderators, department membership', () => {
  it('lets only comms admins create channels', async () => {
    for (const who of [DEV1, OWNER, CEO, FINANCE]) {
      const res = await as(who).post(`${API}/conversations`).send({ kind: 'channel', scope: 'project', name: 'nope', projectName: 'Nope' }).expect(403);
      expect(res.body.code).toBe('forbidden');
    }
    expect((await as(CTO).post(`${API}/conversations`).send({ kind: 'channel', scope: 'department', name: 'x', departmentId: 'dep-nowhere' }).expect(400)).body.code).toBe('unknown_department');
    await as(CTO).post(`${API}/conversations`).send({ kind: 'channel', scope: 'department', name: 'x' }).expect(400);
    await as(CTO).post(`${API}/conversations`).send({ kind: 'channel', scope: 'project', name: 'x', projectName: 'P', departmentId: 'dep-eng' }).expect(400);
  });

  it('makes department channel members from the current employee records', async () => {
    nextMinute();
    const c = await create(CTO, { kind: 'channel', scope: 'department', departmentId: 'dep-eng', name: 'engineering', topic: 'Everything engineering' });
    eng = c.id;
    const members = c.members as Array<{ empId: string; source: string; role: string }>;
    const engPeople = (await prisma.employee.findMany({ where: { department: { code: 'dep-eng' }, status: { not: 'left' } }, select: { empId: true } })).map((e) => e.empId);
    expect(members.map((m) => m.empId).sort()).toEqual([...new Set([...engPeople, CTO])].sort());
    expect(members.find((m) => m.empId === CTO)).toMatchObject({ role: 'moderator', source: 'added' });
    expect(members.find((m) => m.empId === DEV1)).toMatchObject({ role: 'member', source: 'department' });

    await send(DEV1, eng, `Standup notes ${SECRET}`);
    expect((await as(DEV2).get(`${conv(eng)}/messages`).expect(200)).body.items).toHaveLength(1);
    await as(SALES1).get(conv(eng)).expect(404);
    await as(SALES1).get(`${conv(eng)}/messages`).expect(404);
  });

  it('follows department moves at once: the leaver loses access, the joiner gains it', async () => {
    try {
      await moveDepartment(DEV1, 'dep-sales');
      await moveDepartment(SALES1, 'dep-eng');
      await as(DEV1).get(conv(eng)).expect(404);
      await as(DEV1).get(`${conv(eng)}/messages`).expect(404);
      await as(DEV1).post(`${conv(eng)}/messages`).send({ clientKey: randomUUID(), body: 'Am I still here?' }).expect(404);
      expect((await as(DEV1).get(`${API}/search?q=standup`).expect(200)).body.items).toEqual([]);
      expect(((await as(DEV1).get(`${API}/conversations`).expect(200)).body.items as Array<{ id: string }>).some((x) => x.id === eng)).toBe(false);

      // The joiner becomes a member at once, but without the earlier messages (history starts when they join).
      expect(((await as(SALES1).get(`${API}/conversations`).expect(200)).body.items as Array<{ id: string }>).some((x) => x.id === eng)).toBe(true);
      expect((await as(SALES1).get(`${conv(eng)}/messages`).expect(200)).body.items).toEqual([]);
      expect((await as(SALES1).get(`${API}/search?q=standup`).expect(200)).body.items).toEqual([]);
      const welcome = await send(DEV2, eng, 'Standup moved to 10');
      expect((await as(SALES1).get(`${conv(eng)}/messages`).expect(200)).body.items.map((m: { id: string }) => m.id)).toEqual([welcome.id]);
      expect((await as(SALES1).get(`${API}/search?q=standup`).expect(200)).body.items).toHaveLength(1);
    } finally {
      await moveDepartment(DEV1, 'dep-eng');
      await moveDepartment(SALES1, 'dep-sales');
    }
    await as(DEV1).get(conv(eng)).expect(200);
    await as(SALES1).get(conv(eng)).expect(404);
  });

  it('lets moderators add people beyond the department; department members cannot be removed by hand', async () => {
    // A plain member cannot manage the channel.
    expect((await as(DEV2).post(`${conv(eng)}/members`).send({ empIds: [SALES1] }).expect(403)).body.code).toBe('forbidden');
    await as(DEV2).patch(conv(eng)).send({ topic: 'Mine now' }).expect(403);
    await as(DEV2).put(`${conv(eng)}/moderators/${DEV2}`).expect(403);
    await as(DEV2).post(`${conv(eng)}/archive`).send({ reason: 'I want it archived' }).expect(403);

    // The admin makes DEV2 a moderator; a moderator adds people, renames, but cannot appoint moderators or archive.
    await as(CTO).put(`${conv(eng)}/moderators/${DEV2}`).expect(200);
    const added = (await as(DEV2).post(`${conv(eng)}/members`).send({ empIds: [SALES1] }).expect(200)).body;
    expect(added.members.find((m: { empId: string }) => m.empId === SALES1)).toMatchObject({ source: 'added', role: 'member' });
    await as(SALES1).get(`${conv(eng)}/messages`).expect(200);
    await as(DEV2).patch(conv(eng)).send({ topic: 'Builds, releases and reviews' }).expect(200);
    await as(DEV2).put(`${conv(eng)}/moderators/${DEV3}`).expect(403);
    await as(DEV2).post(`${conv(eng)}/archive`).send({ reason: 'Moderator archive attempt' }).expect(403);
    expect((await as(DEV2).post(`${conv(eng)}/members`).send({ empIds: ['ACV-9999'] }).expect(400)).body.code).toBe('unknown_or_inactive_employee');

    expect((await as(DEV2).delete(`${conv(eng)}/members/${DEV3}`).expect(409)).body.code).toBe('department_member');
    expect((await as(DEV3).delete(`${conv(eng)}/members/${DEV3}`).expect(409)).body.code).toBe('department_member');
    await as(DEV2).delete(`${conv(eng)}/members/${SALES1}`).expect(200);
    await as(SALES1).get(conv(eng)).expect(404);
    // Only a comms admin removes a moderator from a channel.
    await as(CTO).put(`${conv(eng)}/moderators/${DEV3}`).expect(200);
    await as(DEV2).delete(`${conv(eng)}/moderators/${DEV3}`).expect(403);
    await as(CTO).delete(`${conv(eng)}/moderators/${DEV3}`).expect(200);

    const actions = (await prisma.auditLog.findMany({ where: { targetId: eng }, orderBy: { occurredAt: 'asc' } })).map((a) => a.action);
    expect(actions).toEqual(expect.arrayContaining(['comms.conversation.created', 'comms.moderator.added', 'comms.member.added', 'comms.conversation.updated', 'comms.member.removed', 'comms.moderator.removed']));
  });

  it('lets an admin manage a channel without being a member, but not read it', async () => {
    const detail = (await as(DIRECTOR).get(conv(eng)).expect(200)).body;
    expect(detail.lastMessage).toBeNull();
    expect(detail.can).toMatchObject({ post: false, manageMembers: true, manageModerators: true, archive: true });
    await as(DIRECTOR).get(`${conv(eng)}/messages`).expect(404);
    await as(DIRECTOR).get(`${conv(eng)}/pins`).expect(404);
    await as(DIRECTOR).post(`${conv(eng)}/messages`).send({ clientKey: randomUUID(), body: 'Hello' }).expect(404);
    const channels = (await as(DIRECTOR).get(`${API}/admin/channels`).expect(200)).body.items as Array<{ id: string; moderatorEmpIds: string[] }>;
    expect(channels.find((c) => c.id === eng)?.moderatorEmpIds).toEqual(expect.arrayContaining([CTO, DEV2]));
    expect(JSON.stringify(channels)).not.toContain(SECRET);
    await as(DEV1).get(`${API}/admin/channels`).expect(403);
  });

  it('lets moderators remove messages with a reason, audited without the text; pins in channels are for moderators', async () => {
    const m = await send(DEV1, eng, `Off-topic rant ${SECRET}`);
    await as(DEV1).put(`${msg(m.id)}/pin`).expect(403);
    await as(DEV3).post(`${msg(m.id)}/remove`).send({ reason: 'Not a moderator here' }).expect(403);
    await as(DEV2).post(`${msg(m.id)}/remove`).send({ reason: 'x' }).expect(400); // a reason is required
    const removed = (await as(DEV2).post(`${msg(m.id)}/remove`).send({ reason: 'Off topic for this channel' }).expect(200)).body;
    expect(removed).toMatchObject({ deleted: true, deletedAs: 'moderator', body: '' });
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'comms.message.removed', targetId: m.id } });
    expect(audit).toMatchObject({ actorId: ids[DEV2], reason: 'Off topic for this channel', targetType: 'message' });
    expect(audit.details).toMatchObject({ conversationId: eng, conversationKind: 'channel', seq: m.seq, authorEmpId: DEV1 });
    expect(JSON.stringify(audit)).not.toContain(SECRET);
    expect((await prisma.messageRevision.findFirstOrThrow({ where: { messageId: m.id } })).kind).toBe('removed');

    const keep = await send(DEV1, eng, 'Release is on Friday');
    await as(CTO).put(`${msg(keep.id)}/pin`).expect(200);
    expect(await prisma.auditLog.count({ where: { action: 'comms.message.pinned', targetId: keep.id } })).toBe(1);
  });

  it('makes an archived conversation read-only', async () => {
    const g = await create(DEV1, { kind: 'group', name: 'Old project', memberEmpIds: [DEV2] });
    const m = await send(DEV2, g.id, 'Wrapping up');
    await as(DEV2).post(`${conv(g.id)}/archive`).send({ reason: 'Not a moderator' }).expect(403);
    await as(DEV1).post(`${conv(g.id)}/archive`).send({ reason: 'Project finished' }).expect(200);
    expect((await as(DEV2).post(`${conv(g.id)}/messages`).send({ clientKey: randomUUID(), body: 'One more' }).expect(409)).body.code).toBe('conversation_archived');
    expect((await as(DEV2).patch(msg(m.id)).send({ body: 'Edited' }).expect(409)).body.code).toBe('conversation_archived');
    expect((await as(DEV1).post(`${conv(g.id)}/members`).send({ empIds: [DEV3] }).expect(409)).body.code).toBe('conversation_archived');
    expect((await as(DEV2).get(`${conv(g.id)}/messages`).expect(200)).body.items).toHaveLength(1);
    expect(await prisma.auditLog.count({ where: { action: 'comms.conversation.archived', targetId: g.id, reason: 'Project finished' } })).toBe(1);
  });

  it('makes a project channel with a free-text project and hand-picked members', async () => {
    const p = await create(DIRECTOR, { kind: 'channel', scope: 'project', name: 'website-relaunch', projectName: 'Website relaunch', projectCode: 'WEB-01', memberEmpIds: [SALES1, DEV1], moderatorEmpIds: [DEV1] });
    expect(p).toMatchObject({ scope: 'project', projectName: 'Website relaunch', projectCode: 'WEB-01', departmentId: null });
    expect(p.members.map((m: { empId: string; role: string }) => `${m.empId}:${m.role}`).sort()).toEqual([`${DIRECTOR}:moderator`, `${DEV1}:moderator`, `${SALES1}:member`]);
    await as(DEV2).get(conv(p.id)).expect(404);
    await as(DEV1).patch(conv(p.id)).send({ projectCode: 'WEB-02' }).expect(200);
    expect((await as(DEV1).patch(conv(eng)).send({ projectName: 'Not a project' })).status).toBe(403);
  });
});

describe('13. search only finds messages in conversations the caller can see', () => {
  it('finds a word in my conversations and nowhere else', async () => {
    nextMinute();
    const word = `kiwi${randomUUID().slice(0, 6)}`;
    await send(DEV1, dm, `Private ${word} plan`);
    await send(DEV1, eng, `Channel ${word} plan`);
    const g = await create(SALES1, { kind: 'group', name: 'Sales only', memberEmpIds: [FINANCE] });
    await send(SALES1, g.id, `Sales ${word} plan`);

    const forDev2 = (await as(DEV2).get(`${API}/search?q=${word}`).expect(200)).body.items as Array<{ conversation: { id: string } }>;
    expect(forDev2.map((h) => h.conversation.id).sort()).toEqual([dm, eng].sort());
    const forDev3 = (await as(DEV3).get(`${API}/search?q=${word}`).expect(200)).body.items as Array<{ conversation: { id: string } }>;
    expect(forDev3.map((h) => h.conversation.id)).toEqual([eng]);
    const forFinance = (await as(FINANCE).get(`${API}/search?q=${word}`).expect(200)).body.items as Array<{ conversation: { id: string } }>;
    expect(forFinance.map((h) => h.conversation.id)).toEqual([g.id]);
    for (const who of [DIRECTOR, OWNER, CEO]) expect((await as(who).get(`${API}/search?q=${word}`).expect(200)).body.items).toEqual([]);
    const inDm = (await as(DEV2).get(`${API}/search?q=${word}&conversationId=${dm}`).expect(200)).body.items;
    expect(inDm).toHaveLength(1);
    await as(DEV3).get(`${API}/search?q=${word}&conversationId=${dm}`).expect(404);
    await as(DEV2).get(`${API}/search?q=a`).expect(400);
  });

  it('pages search results without repeats', async () => {
    const word = `plum${randomUUID().slice(0, 6)}`;
    for (let i = 0; i < 5; i++) await send(DEV2, dm, `${word} number ${i}`);
    const seen: string[] = [];
    let cursor: string | null = null;
    do {
      const page: { items: Array<{ message: { id: string } }>; nextCursor: string | null } = (await as(DEV1).get(`${API}/search?q=${word}&limit=2${cursor ? `&cursor=${cursor}` : ''}`).expect(200)).body;
      seen.push(...page.items.map((h) => h.message.id));
      cursor = page.nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(5);
    expect(new Set(seen).size).toBe(5);
    expect((await as(DEV1).get(`${API}/search?q=${word}&cursor=garbage`).expect(400)).body.code).toBe('invalid_cursor');
  });
});

describe('14. history pages have no missing or repeated messages', () => {
  it('pages backwards and forwards by sequence number, deleted messages included as placeholders', async () => {
    nextMinute();
    const g = await create(DEV3, { kind: 'group', name: 'History', memberEmpIds: [SQA] });
    for (let i = 1; i <= 25; i++) await send(i % 2 ? DEV3 : SQA, g.id, `line ${i}`);
    const page7 = await prisma.message.findFirstOrThrow({ where: { conversationId: g.id, seq: 7 } });
    await as(i7Author(page7.authorId)).delete(msg(page7.id)).expect(200);

    const backwards: number[] = [];
    let page = (await as(DEV3).get(`${conv(g.id)}/messages?limit=10`).expect(200)).body;
    expect(page.hasMoreAfter).toBe(false);
    backwards.unshift(...page.items.map((m: { seq: number }) => m.seq));
    while (page.hasMoreBefore) {
      page = (await as(DEV3).get(`${conv(g.id)}/messages?limit=10&before=${page.items[0].seq}`).expect(200)).body;
      expect(page.hasMoreAfter).toBe(true);
      backwards.unshift(...page.items.map((m: { seq: number }) => m.seq));
    }
    expect(backwards).toEqual(Array.from({ length: 25 }, (_, i) => i + 1));

    const forwards: number[] = [];
    let after = 0;
    let more = true;
    while (more) {
      const p = (await as(SQA).get(`${conv(g.id)}/messages?limit=10&after=${after}`).expect(200)).body;
      forwards.push(...p.items.map((m: { seq: number }) => m.seq));
      expect(p.hasMoreBefore).toBe(after > 0);
      more = p.hasMoreAfter;
      after = p.items[p.items.length - 1].seq;
    }
    expect(forwards).toEqual(backwards);
    const seven = (await as(SQA).get(`${conv(g.id)}/messages?after=6&limit=1`).expect(200)).body.items[0];
    expect(seven).toMatchObject({ seq: 7, deleted: true, body: '' });
    expect((await as(SQA).get(`${conv(g.id)}/messages?after=25`).expect(200)).body).toMatchObject({ items: [], hasMoreAfter: false, lastSeq: 25 });
    await as(SQA).get(`${conv(g.id)}/messages?after=1&before=5`).expect(400);
  }, 120_000);

  it('keeps every conversation gap-free: the last number equals the count and the highest number', async () => {
    const broken = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT c."id" FROM "conversations" c LEFT JOIN "messages" m ON m."conversation_id" = c."id"
      GROUP BY c."id", c."last_seq" HAVING c."last_seq" <> count(m."id") OR c."last_seq" <> COALESCE(max(m."seq"), 0)`;
    expect(broken).toEqual([]);
  });
});

function i7Author(authorId: string): string {
  return Object.entries(ids).find(([, id]) => id === authorId)![0];
}

describe('15. delivered and read positions', () => {
  it('shows each member’s delivered and read position in a DM; positions only move forward', async () => {
    nextMinute();
    const d = await create(SQA, { kind: 'dm', empId: FINANCE });
    const a = await send(SQA, d.id, 'one');
    const b = await send(SQA, d.id, 'two');
    const c = await send(SQA, d.id, 'three');
    expect(a.receipt).toEqual({ deliveredTo: [], readBy: [] });
    const unreadBefore = ((await as(FINANCE).get(`${API}/conversations`).expect(200)).body.items as Array<{ id: string; unread: number }>).find((x) => x.id === d.id)!.unread;
    expect(unreadBefore).toBe(3);

    expect((await as(FINANCE).post(`${conv(d.id)}/delivered`).send({ seq: c.seq }).expect(200)).body).toEqual({ lastDeliveredSeq: c.seq, lastReadSeq: 0, unread: 3 });
    expect((await as(FINANCE).post(`${conv(d.id)}/read`).send({ seq: b.seq }).expect(200)).body).toEqual({ lastDeliveredSeq: c.seq, lastReadSeq: b.seq, unread: 1 });
    expect((await as(FINANCE).post(`${conv(d.id)}/read`).send({ seq: 1 }).expect(200)).body.lastReadSeq).toBe(b.seq);
    const items = (await as(SQA).get(`${conv(d.id)}/messages`).expect(200)).body.items as Array<{ seq: number; receipt: { deliveredTo: string[]; readBy: string[] } }>;
    expect(items.map((m) => [m.seq, m.receipt.deliveredTo, m.receipt.readBy])).toEqual([
      [a.seq, [FINANCE], [FINANCE]],
      [b.seq, [FINANCE], [FINANCE]],
      [c.seq, [FINANCE], []],
    ]);
    const detail = (await as(SQA).get(conv(d.id)).expect(200)).body;
    expect(detail.receipts).toEqual(expect.arrayContaining([{ empId: FINANCE, lastDeliveredSeq: c.seq, lastReadSeq: b.seq }, { empId: SQA, lastDeliveredSeq: c.seq, lastReadSeq: c.seq }]));
    // A position past the end is held at the last message.
    expect((await as(FINANCE).post(`${conv(d.id)}/read`).send({ seq: 999999 }).expect(200)).body).toEqual({ lastDeliveredSeq: c.seq, lastReadSeq: c.seq, unread: 0 });
    await as(FINANCE).post(`${conv(d.id)}/read`).send({ seq: -1 }).expect(400);
  });

  it('shows only my own unread count in a channel, never other people’s positions', async () => {
    const before = (await as(DEV3).get(conv(eng)).expect(200)).body;
    expect(before.receipts).toBeNull();
    const m = await send(DEV1, eng, 'New build is out');
    const items = (await as(DEV3).get(`${conv(eng)}/messages`).expect(200)).body.items as Array<{ id: string; receipt: unknown }>;
    expect(items.every((x) => x.receipt === null)).toBe(true);
    const unread = ((await as(DEV3).get(`${API}/conversations`).expect(200)).body.items as Array<{ id: string; unread: number }>).find((x) => x.id === eng)!.unread;
    expect(unread).toBeGreaterThan(0);
    expect((await as(DEV3).post(`${conv(eng)}/read`).send({ seq: m.seq }).expect(200)).body.unread).toBe(0);
    expect((await as(DEV1).get(conv(eng)).expect(200)).body.receipts).toBeNull();
  });
});

describe('history starts when someone becomes a member', () => {
  const ids_ = (page: { items: Array<{ id: string }> }) => page.items.map((m) => m.id);
  const list = async (who: string, id: string) => ((await as(who).get(`${API}/conversations?limit=100`).expect(200)).body.items as Array<{ id: string; unread: number; lastMessage: unknown }>).find((x) => x.id === id)!;

  it('a person added to a group sees nothing from before, and everything after', async () => {
    nextMinute();
    const word = `fig${randomUUID().slice(0, 6)}`;
    const g = await create(DEV1, { kind: 'group', name: 'Late joiner', memberEmpIds: [DEV2] });
    const before = await send(DEV1, g.id, `Before ${word} joined`);
    const reply = await send(DEV2, g.id, 'An early reply', { parentId: before.id });
    await as(DEV1).put(`${msg(before.id)}/pin`).expect(200);
    await as(DEV2).put(`${msg(before.id)}/reactions/${encodeURIComponent('👍')}`).expect(200);

    const joined = (await as(DEV1).post(`${conv(g.id)}/members`).send({ empIds: [DEV3] }).expect(200)).body;
    expect(joined.members.map((m: { empId: string }) => m.empId)).toContain(DEV3);
    expect((await prisma.conversationMember.findFirstOrThrow({ where: { conversationId: g.id, employeeId: ids[DEV3] } })).joinedSeq).toBe(reply.seq);

    // Nothing from before: history, thread, pins, reactions, saving, replying, search, unread and preview.
    const empty = (await as(DEV3).get(`${conv(g.id)}/messages`).expect(200)).body;
    expect(empty).toMatchObject({ items: [], hasMoreBefore: false, hasMoreAfter: false });
    expect((await as(DEV3).get(`${conv(g.id)}/messages?after=0`).expect(200)).body).toMatchObject({ items: [], hasMoreBefore: false });
    await as(DEV3).get(`${msg(before.id)}/thread`).expect(404);
    await as(DEV3).put(`${msg(before.id)}/reactions/${encodeURIComponent('🎉')}`).expect(404);
    await as(DEV3).put(`${msg(before.id)}/save`).expect(404);
    await as(DEV3).put(`${msg(reply.id)}/pin`).expect(404);
    expect((await as(DEV3).post(`${conv(g.id)}/messages`).send({ clientKey: randomUUID(), body: 'late reply', parentId: before.id }).expect(400)).body.code).toBe('invalid_reply_target');
    expect((await as(DEV3).get(`${conv(g.id)}/pins`).expect(200)).body).toEqual([]);
    expect((await as(DEV3).get(conv(g.id)).expect(200)).body.pinnedMessageIds).toEqual([]);
    expect((await as(DEV3).get(`${API}/search?q=${word}`).expect(200)).body.items).toEqual([]);
    expect(await list(DEV3, g.id)).toMatchObject({ unread: 0, lastMessage: null });

    // Everything after.
    const after = await send(DEV1, g.id, `After ${word} joined`);
    const page = (await as(DEV3).get(`${conv(g.id)}/messages`).expect(200)).body;
    expect(ids_(page)).toEqual([after.id]);
    expect(page.hasMoreBefore).toBe(false);
    expect((await as(DEV3).get(`${conv(g.id)}/messages?before=${after.seq}`).expect(200)).body.items).toEqual([]);
    expect(((await as(DEV3).get(`${API}/search?q=${word}`).expect(200)).body.items as Array<{ message: { id: string } }>).map((h) => h.message.id)).toEqual([after.id]);
    expect(await list(DEV3, g.id)).toMatchObject({ unread: 1, lastMessage: { seq: after.seq } });

    // Receipts: the newcomer never received or read the earlier messages, even after reading everything.
    await as(DEV3).post(`${conv(g.id)}/read`).send({ seq: after.seq }).expect(200);
    const forAuthor = (await as(DEV1).get(`${conv(g.id)}/messages`).expect(200)).body.items as Array<{ id: string; receipt: { readBy: string[]; deliveredTo: string[] } }>;
    expect(forAuthor.find((m) => m.id === before.id)!.receipt.readBy).not.toContain(DEV3);
    expect(forAuthor.find((m) => m.id === before.id)!.receipt.deliveredTo).not.toContain(DEV3);
    expect(forAuthor.find((m) => m.id === after.id)!.receipt.readBy).toContain(DEV3);

    // The people who were already there keep the whole history.
    expect(ids_((await as(DEV2).get(`${conv(g.id)}/messages`).expect(200)).body)).toEqual([before.id, reply.id, after.id]);
  });

  it('someone removed and added again starts from the new add; their saved messages from before are hidden', async () => {
    const g = await create(DEV1, { kind: 'group', name: 'Comeback', memberEmpIds: [DEV2, DEV3] });
    const first = await send(DEV1, g.id, 'First message');
    await as(DEV3).put(`${msg(first.id)}/save`).expect(200);
    await as(DEV1).delete(`${conv(g.id)}/members/${DEV3}`).expect(200);
    const gap = await send(DEV1, g.id, 'Sent while they were away');
    await as(DEV1).post(`${conv(g.id)}/members`).send({ empIds: [DEV3] }).expect(200);
    expect((await as(DEV3).get(`${conv(g.id)}/messages`).expect(200)).body.items).toEqual([]);
    await as(DEV3).get(`${msg(gap.id)}/thread`).expect(404);
    expect(((await as(DEV3).get(`${API}/saved`).expect(200)).body.items as Array<{ message: { id: string } }>).map((s) => s.message.id)).not.toContain(first.id);
    const back = await send(DEV2, g.id, 'Welcome back');
    expect(ids_((await as(DEV3).get(`${conv(g.id)}/messages`).expect(200)).body)).toEqual([back.id]);
  });

  it('a project channel member or a newly appointed moderator starts when added', async () => {
    const p = await create(DIRECTOR, { kind: 'channel', scope: 'project', name: 'mobile-app', projectName: 'Mobile app', memberEmpIds: [SALES1] });
    const early = await send(SALES1, p.id, 'Kick-off notes');
    await as(DIRECTOR).post(`${conv(p.id)}/members`).send({ empIds: [DEV2] }).expect(200);
    await as(DIRECTOR).put(`${conv(p.id)}/moderators/${FINANCE}`).expect(200);
    for (const who of [DEV2, FINANCE]) {
      expect((await as(who).get(`${conv(p.id)}/messages`).expect(200)).body.items).toEqual([]);
      await as(who).get(`${msg(early.id)}/thread`).expect(404);
    }
    // A moderator who joined later cannot remove (or even see) an earlier message.
    await as(FINANCE).post(`${msg(early.id)}/remove`).send({ reason: 'Moderating an old message' }).expect(404);
    expect(ids_((await as(SALES1).get(`${conv(p.id)}/messages`).expect(200)).body)).toEqual([early.id]);
  });

  it('moving out of a department and back starts the department channel history again', async () => {
    const old = await send(DEV2, eng, 'Before the round trip');
    expect(ids_((await as(SQA).get(`${conv(eng)}/messages?limit=100`).expect(200)).body)).toContain(old.id);
    try {
      await moveDepartment(SQA, 'dep-sales');
      await as(SQA).get(conv(eng)).expect(404);
    } finally {
      await moveDepartment(SQA, 'dep-eng');
    }
    const lastSeq = (await prisma.conversation.findUniqueOrThrow({ where: { id: eng } })).lastSeq;
    expect((await prisma.departmentChannelAccess.findUniqueOrThrow({ where: { conversationId_employeeId: { conversationId: eng, employeeId: ids[SQA] } } })).fromSeq).toBe(lastSeq);
    expect((await as(SQA).get(`${conv(eng)}/messages`).expect(200)).body.items).toEqual([]);
    await as(SQA).get(`${msg(old.id)}/thread`).expect(404);
    const next = await send(DEV2, eng, 'After the round trip');
    expect(ids_((await as(SQA).get(`${conv(eng)}/messages`).expect(200)).body)).toEqual([next.id]);
    // People who never left keep everything.
    expect(ids_((await as(DEV2).get(`${conv(eng)}/messages?limit=100`).expect(200)).body)).toEqual(expect.arrayContaining([old.id, next.id]));
  });

  it('a new hire starts at the current message (recorded by the database, whatever made the record)', async () => {
    const lastSeq = (await prisma.conversation.findUniqueOrThrow({ where: { id: eng } })).lastSeq;
    const hire = await createEmployee(prisma, { name: 'Comms New Hire', reportsToEmpId: CTO }); // a direct insert, no API
    const access = await prisma.departmentChannelAccess.findUniqueOrThrow({ where: { conversationId_employeeId: { conversationId: eng, employeeId: hire.id } } });
    expect(access.fromSeq).toBe(lastSeq);
  });

  it('a new department head starts at the current message; a head moving into their own department keeps their history', async () => {
    const fin = await create(DIRECTOR, { kind: 'channel', scope: 'department', departmentId: 'dep-fin', name: 'finance-team' });
    const early = await send(FINANCE, fin.id, 'Month-end checklist');
    const department = await prisma.department.findUniqueOrThrow({ where: { code: 'dep-fin' } });
    const director = await prisma.employee.findUniqueOrThrow({ where: { empId: DIRECTOR } });
    try {
      // The Director heads dep-fin (a member through being its head) and moves into it: no new start.
      await prisma.employee.update({ where: { id: director.id }, data: { departmentId: department.id } });
      expect(await prisma.departmentChannelAccess.count({ where: { conversationId: fin.id, employeeId: director.id } })).toBe(0);
      expect(ids_((await as(DIRECTOR).get(`${conv(fin.id)}/messages`).expect(200)).body)).toEqual([early.id]);
      await prisma.employee.update({ where: { id: director.id }, data: { departmentId: director.departmentId } });

      // Sales1 becomes the head of dep-fin: a member from now on, without the history.
      await as(SALES1).get(conv(fin.id)).expect(404);
      await prisma.department.update({ where: { id: department.id }, data: { headEmployeeId: ids[SALES1] } });
      expect((await prisma.departmentChannelAccess.findUniqueOrThrow({ where: { conversationId_employeeId: { conversationId: fin.id, employeeId: ids[SALES1] } } })).fromSeq).toBe(early.seq);
      expect((await as(SALES1).get(`${conv(fin.id)}/messages`).expect(200)).body.items).toEqual([]);
      const next = await send(FINANCE, fin.id, 'Welcome to our new head');
      expect(ids_((await as(SALES1).get(`${conv(fin.id)}/messages`).expect(200)).body)).toEqual([next.id]);
    } finally {
      await prisma.department.update({ where: { id: department.id }, data: { headEmployeeId: department.headEmployeeId } });
      await prisma.employee.update({ where: { id: director.id }, data: { departmentId: director.departmentId } });
    }
    await as(SALES1).get(conv(fin.id)).expect(404);
  });
});

describe('department history start under concurrent messages and department changes', () => {
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  const seqsSeenBy = async (who: string, id: string) => ((await as(who).get(`${conv(id)}/messages?limit=100`).expect(200)).body.items as Array<{ seq: number }>).map((m) => m.seq);
  const fromSeqOf = async (conversationId: string, employeeId: string) =>
    (await prisma.departmentChannelAccess.findUniqueOrThrow({ where: { conversationId_employeeId: { conversationId, employeeId } } })).fromSeq;
  /** Some database session is waiting for a row lock (here: the department change waiting for the send). */
  const someoneWaitsForALock = async () => {
    for (let i = 0; i < 100; i++) {
      const [row] = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if (row.n > 0) return true;
      await sleep(50);
    }
    return false;
  };
  let sales = '';

  it('a message still being sent when someone joins the department counts as history: the join waits for it', async () => {
    nextMinute();
    sales = (await create(DIRECTOR, { kind: 'channel', scope: 'department', departmentId: 'dep-sales', name: 'sales-floor' })).id;
    const old = await send(SALES1, sales, 'Sent well before the move');

    let allocated!: () => void;
    let release!: () => void;
    const isAllocated = new Promise<void>((r) => (allocated = r));
    const released = new Promise<void>((r) => (release = r));
    // A send in progress, exactly as MessageService.send does it: the number is taken under the conversation's row lock;
    // the commit comes later.
    const inFlight = prisma.$transaction(
      async (tx) => {
        const [{ last_seq }] = await tx.$queryRaw<Array<{ last_seq: number }>>`UPDATE "conversations" SET "last_seq" = "last_seq" + 1 WHERE "id" = ${sales}::uuid RETURNING "last_seq"`;
        const m = await tx.message.create({ data: { conversationId: sales, seq: last_seq, authorId: ids[SALES1], body: 'Sent while Ali is being moved', clientKey: randomUUID(), requestHash: 'fixture', createdAt: t.clock.now() } });
        allocated();
        await released;
        return m;
      },
      { timeout: 60_000, maxWait: 10_000 },
    );
    await isAllocated;

    let moved = false;
    const move = moveDepartment(DEV3, 'dep-sales').then(() => (moved = true));
    try {
      expect(await someoneWaitsForALock()).toBe(true); // the department change waits for the send's lock
      expect(moved).toBe(false);
      release();
      const message = await inFlight;
      await move;
      expect(await fromSeqOf(sales, ids[DEV3])).toBe(message.seq);
      expect(await seqsSeenBy(DEV3, sales)).toEqual([]);
      await as(DEV3).get(`${msg(message.id)}/thread`).expect(404);
      await as(DEV3).get(`${msg(old.id)}/thread`).expect(404);
      const next = await send(SALES1, sales, 'After Ali joined');
      expect(await seqsSeenBy(DEV3, sales)).toEqual([next.seq]);
    } finally {
      release();
      await inFlight.catch(() => undefined);
      await move.catch(() => undefined);
      await moveDepartment(DEV3, 'dep-eng');
    }
  }, 60_000);

  it('a burst of messages around a department move and a hire grants no earlier message to either', async () => {
    nextMinute();
    const before = (await prisma.conversation.findUniqueOrThrow({ where: { id: sales } })).lastSeq;
    const senders = [SALES1, 'ACV-0012', 'ACV-0014'];
    const sends = senders.flatMap((who) => Array.from({ length: 5 }, (_, i) => as(who).post(`${conv(sales)}/messages`).send({ clientKey: randomUUID(), body: `burst ${who} ${i}` })));
    let hireId = '';
    try {
      const [results] = await Promise.all([
        Promise.all(sends),
        (async () => {
          await sleep(30);
          await moveDepartment(SQA, 'dep-sales');
        })(),
        (async () => {
          await sleep(60);
          hireId = (await createEmployee(prisma, { name: 'Comms Burst Hire', reportsToEmpId: SALES1 })).id; // a direct insert into dep-sales
        })(),
      ]);
      for (const r of results) expect(r.status, JSON.stringify(r.body)).toBe(201);

      const all = (await prisma.message.findMany({ where: { conversationId: sales }, orderBy: { seq: 'asc' }, select: { seq: true } })).map((m) => m.seq);
      const lastSeq = (await prisma.conversation.findUniqueOrThrow({ where: { id: sales } })).lastSeq;
      expect(all).toEqual(Array.from({ length: lastSeq }, (_, i) => i + 1)); // no gaps

      const sqaFrom = await fromSeqOf(sales, ids[SQA]);
      expect(sqaFrom).toBeGreaterThanOrEqual(before);
      expect(sqaFrom).toBeLessThanOrEqual(lastSeq);
      expect(await seqsSeenBy(SQA, sales)).toEqual(all.filter((s) => s > sqaFrom)); // exactly the later ones, nothing older
      const hireFrom = await fromSeqOf(sales, hireId);
      expect(hireFrom).toBeGreaterThanOrEqual(before);
      expect(hireFrom).toBeLessThanOrEqual(lastSeq);
      // The people already in the department keep everything.
      expect(await seqsSeenBy(SALES1, sales)).toEqual(all);
    } finally {
      await moveDepartment(SQA, 'dep-eng');
    }
  }, 120_000);
});

describe('rate limit', () => {
  it('refuses more than 30 messages a minute from one person, then allows sending again', async () => {
    nextMinute();
    const d = await create(SQA, { kind: 'dm', empId: SALES1 });
    for (let i = 0; i < 30; i++) await send(SQA, d.id, `ping ${i}`);
    const refused = await as(SQA).post(`${conv(d.id)}/messages`).send({ clientKey: randomUUID(), body: 'one too many' }).expect(429);
    expect(refused.body.code).toBe('rate_limited');
    expect(refused.body.retryAfterSec).toBeGreaterThan(0);
    // The other person is not affected.
    await send(SALES1, d.id, 'I can still talk');
    nextMinute();
    await send(SQA, d.id, 'back again');
  }, 120_000);
});

describe('16. no private message text in logs, audit records or events', () => {
  it('the error filter logs and answers with codes only, even for an error that carries row values', () => {
    const filter = new CommsErrorFilter();
    const res = { code: 0, body: null as unknown, status(c: number) { this.code = c; return this; }, json(b: unknown) { this.body = b; return this; } };
    const host = { switchToHttp: () => ({ getResponse: () => res }) } as unknown as ArgumentsHost;
    const error = Object.assign(new Error(`new row for relation "messages" violates check constraint. Failing row contains (${SECRET}).`), {
      code: 'P2010',
      meta: { driverAdapterError: { cause: { originalCode: '23514', originalMessage: `Failing row contains (${SECRET})` } } },
    });
    const before = captured.length;
    filter.catch(error, host);
    expect(res.code).toBe(500);
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
    const logged = captured.slice(before).join('\n');
    expect(logged).toContain('Request failed: Error prisma=P2010 sqlstate=23514');
    expect(logged).not.toContain(SECRET);
  });

  it('the marker is really in the messages and older versions (so the checks below mean something)', async () => {
    expect(await prisma.message.count({ where: { body: { contains: SECRET } } })).toBeGreaterThan(0);
    expect(await prisma.messageRevision.count({ where: { body: { contains: SECRET } } })).toBeGreaterThan(0);
    expect(captured.length).toBeGreaterThan(0);
  });

  it('finds the marker nowhere in the captured application output, the audit log, the outbox or notifications', async () => {
    expect(captured.join('\n')).not.toContain(SECRET);
    const [audit] = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "audit_log" a WHERE a::text LIKE ${`%${SECRET}%`}`;
    expect(audit.n).toBe(0);
    const [outbox] = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "outbox_events" o WHERE o::text LIKE ${`%${SECRET}%`}`;
    expect(outbox.n).toBe(0);
    const [notes] = await prisma.$queryRaw<Array<{ n: number }>>`SELECT count(*)::int AS n FROM "notifications" x WHERE x::text LIKE ${`%${SECRET}%`}`;
    expect(notes.n).toBe(0);
    // Module 14 audit records exist, and carry ids and numbers only.
    const comms = await prisma.auditLog.findMany({ where: { action: { startsWith: 'comms.' } } });
    expect(comms.length).toBeGreaterThan(5);
  });
});
