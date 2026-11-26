import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PrismaClient } from '../src/generated/prisma/client';
import { createTestApp, type TestApp } from './helpers/app';
import { createTestPrisma } from './helpers/prisma';
import { resetTestDatabase } from './helpers/reset-db';

/**
 * Module 14 links to Module 5 tasks and projects (plan section 19: "links to related tasks or projects"). Linking and
 * seeing a linked task follow Module 5's visibility rule exactly; personal to-dos are never linked; project channels
 * belong to a real Module 5 project.
 */
const API = '/api/v1/comms';
const DIRECTOR = 'ACV-0003';
const CTO = 'ACV-0004';
const DEV1 = 'ACV-0006';
const DEV2 = 'ACV-0007';
const SALES1 = 'ACV-0009';

let t: TestApp;
let prisma: PrismaClient;
const ids: Record<string, string> = {};
const as = (empId: string) => t.as(empId);
const conv = (id: string) => `${API}/conversations/${id}`;

let workTask = { id: '', number: 'TSK-9701', title: 'Build the payslip screen' };
let todo = { id: '', number: 'TODO-9701' };
let group = '';
let message = '';

async function task(number: string, title: string, assignee: string, assigner: string, personal: boolean) {
  const now = t.clock.now();
  return prisma.task.create({
    data: {
      number,
      title,
      assigneeId: ids[assignee],
      assignedById: ids[assigner],
      personal,
      size: 'M',
      points: 3,
      estimatedHours: 8,
      startDate: now,
      deadline: new Date(now.getTime() + 3 * 86_400_000),
      originalDeadline: new Date(now.getTime() + 3 * 86_400_000),
    },
  });
}

beforeAll(async () => {
  t = await createTestApp();
  await t.signInAll();
  prisma = createTestPrisma();
  for (const e of await prisma.employee.findMany({ select: { id: true, empId: true } })) ids[e.empId] = e.id;
  // A work task the CTO gave DEV1 (seen by DEV1, the CTO and the people above, not by DEV2 or Sales), and DEV1's own to-do.
  const w = await task(workTask.number, workTask.title, DEV1, CTO, false);
  workTask = { ...workTask, id: w.id };
  todo = { ...todo, id: (await task(todo.number, 'Buy a new keyboard', DEV1, DEV1, true)).id };
  group = (await as(DEV1).post(`${API}/conversations`).send({ kind: 'group', name: 'Payslip work', memberEmpIds: [DEV2] })).body.conversation.id;
  message = (await as(DEV2).post(`${conv(group)}/messages`).send({ clientKey: randomUUID(), body: 'Who is building the payslip screen?' })).body.message.id;
});

afterAll(async () => {
  await t.close();
  await prisma.$disconnect();
  await resetTestDatabase();
}, 120_000);

describe('messages linked to tasks', () => {
  it('lets a member link a task they may see; others see it only if Module 5 lets them', async () => {
    const res = await as(DEV1).put(`${API}/messages/${message}/task`).send({ task: workTask.number });
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.link).toEqual({ task: { id: workTask.id, number: workTask.number, title: workTask.title, status: 'assigned' } });
    // DEV2 is in the conversation but may not see the task: told that a task is linked, nothing else.
    const forDev2 = (await as(DEV2).get(`${conv(group)}/messages`)).body.items.find((m: { id: string }) => m.id === message);
    expect(forDev2.link).toEqual({ task: null });
    expect(JSON.stringify(forDev2)).not.toContain(workTask.title);
    expect((await as(DEV2).get(`${API}/messages/${message}/link`)).body).toEqual({ task: null });
    expect((await as(DEV1).get(`${API}/messages/${message}/link`)).body.task.number).toBe(workTask.number);
    // An outsider cannot even ask.
    expect((await as(SALES1).get(`${API}/messages/${message}/link`)).status).toBe(404);
    const audit = await prisma.auditLog.findFirstOrThrow({ where: { action: 'comms.message.task_linked', targetId: message } });
    expect(audit.details).toMatchObject({ task: workTask.number });
    expect(JSON.stringify(audit)).not.toContain(workTask.title);
  });

  it('refuses tasks the person may not see, unknown tasks and personal to-dos', async () => {
    expect((await as(DEV2).put(`${API}/messages/${message}/task`).send({ task: workTask.number })).status).toBe(404);
    expect((await as(DEV1).put(`${API}/messages/${message}/task`).send({ task: 'TSK-0000' })).status).toBe(404);
    expect((await as(DEV1).put(`${API}/messages/${message}/task`).send({ task: todo.number })).body.code).toBe('personal_task');
    await expect(prisma.messageTaskLink.update({ where: { messageId: message }, data: { taskId: todo.id } })).rejects.toThrow(/message_rule/);
  });

  it('lets the linker, the author or a moderator remove the link, nobody else', async () => {
    const other = (await as(DEV1).post(`${conv(group)}/messages`).send({ clientKey: randomUUID(), body: 'On it' })).body.message.id;
    expect((await as(DEV1).put(`${API}/messages/${other}/task`).send({ task: workTask.id })).status).toBe(200);
    // DEV2 is not the linker, not the author (DEV1 wrote it) and not a moderator of DEV1's group.
    expect((await as(DEV2).delete(`${API}/messages/${other}/task`)).status).toBe(403);
    const removed = await as(DEV1).delete(`${API}/messages/${other}/task`);
    expect(removed.status).toBe(200);
    expect(removed.body.link).toBeNull();
    // The author of the first message (DEV2) may remove the link DEV1 put on it.
    expect((await as(DEV2).delete(`${API}/messages/${message}/task`)).body.link).toBeNull();
  });
});

describe('meetings linked to tasks', () => {
  it('are linked by the organizer; invitees see only the tasks Module 5 lets them see', async () => {
    const meeting = (
      await as(DEV1).post(`${API}/meetings`).send({ title: 'Payslip review', startsAt: new Date(t.clock.now().getTime() + 86_400_000).toISOString(), durationMin: 30, location: 'Video call', participantEmpIds: [DEV2, CTO] })
    ).body;
    expect((await as(DEV2).post(`${API}/meetings/${meeting.id}/tasks`).send({ task: workTask.number })).body.code).toBe('organizer_only');
    expect((await as(DEV1).post(`${API}/meetings/${meeting.id}/tasks`).send({ task: todo.number })).body.code).toBe('personal_task');
    const linked = await as(DEV1).post(`${API}/meetings/${meeting.id}/tasks`).send({ task: workTask.number });
    expect(linked.status, JSON.stringify(linked.body)).toBe(200);
    expect(linked.body.linkedTasks.map((x: { number: string }) => x.number)).toEqual([workTask.number]);
    const forDev2 = (await as(DEV2).get(`${API}/meetings/${meeting.id}`)).body;
    expect(forDev2).toMatchObject({ linkedTasks: [], hiddenLinkedTasks: 1 });
    expect(JSON.stringify(forDev2)).not.toContain(workTask.title);
    expect((await as(CTO).get(`${API}/meetings/${meeting.id}`)).body.linkedTasks.map((x: { number: string }) => x.number)).toEqual([workTask.number]);
    const unlinked = await as(DEV1).delete(`${API}/meetings/${meeting.id}/tasks/${workTask.id}`);
    expect(unlinked.body).toMatchObject({ linkedTasks: [], hiddenLinkedTasks: 0 });
    expect(await prisma.auditLog.count({ where: { targetId: meeting.id, action: { in: ['comms.meeting.task_linked', 'comms.meeting.task_unlinked'] } } })).toBe(2);
  });
});

describe('project channels', () => {
  it('belong to a real Module 5 project, whose name and code they take', async () => {
    const project = await prisma.project.findFirstOrThrow({ where: { code: 'prj-northwind' } });
    const res = await as(DIRECTOR).post(`${API}/conversations`).send({ kind: 'channel', scope: 'project', name: 'northwind', projectId: project.id, memberEmpIds: [DEV1] });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    expect(res.body.conversation).toMatchObject({ scope: 'project', projectId: project.id, projectName: project.name, projectCode: project.code });
    expect((await as(DIRECTOR).post(`${API}/conversations`).send({ kind: 'channel', scope: 'project', name: 'nowhere', projectId: randomUUID() })).body.code).toBe('unknown_project');
    expect((await as(DIRECTOR).post(`${API}/conversations`).send({ kind: 'channel', scope: 'department', name: 'mixed', departmentId: 'dep-eng', projectId: project.id })).status).toBe(400);
  });
});
