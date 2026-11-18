import { describe, expect, it } from 'vitest';
import { TaskWorkflowService } from './task-workflow.service';

/**
 * Who may act as the ASSIGNER of a task (hold, cancel, edit, move the deadline, stop its repeat) and who would review a
 * task given to someone. The service is built with small fakes for the database, the permissions, the reporting chain and
 * the approval routing, so the rule can be checked without a database. The database tests (m5-core) run the same rule
 * through the endpoints.
 */
interface Seat {
  id: string;
  empId: string;
  status: 'active' | 'left';
  level: number;
}

const MANAGER: Seat = { id: 'manager-id', empId: 'ACV-0004', status: 'active', level: 3 }; // the CTO
const DIRECTOR: Seat = { id: 'director-id', empId: 'ACV-0003', status: 'active', level: 2 };
const OWNER: Seat = { id: 'owner-id', empId: 'ACV-0001', status: 'active', level: 1 };
const DEV: Seat = { id: 'dev-id', empId: 'ACV-0006', status: 'active', level: 5 };
const OTHER_DEV: Seat = { id: 'other-dev-id', empId: 'ACV-0007', status: 'active', level: 5 };

function build(over: { managerStatus?: 'active' | 'left'; managerCanAssign?: boolean; managerCanReview?: boolean; directorStatus?: 'active' | 'left'; ownerCanReview?: boolean } = {}) {
  const manager: Seat = { ...MANAGER, status: over.managerStatus ?? 'active' };
  const director: Seat = { ...DIRECTOR, status: over.directorStatus ?? 'active' };
  const people = [manager, director, OWNER, DEV, OTHER_DEV];
  const chain = [manager, director, OWNER]; // above DEV, nearest first
  const permissions: Record<string, string[]> = {
    [manager.id]: [...(over.managerCanAssign === false ? [] : ['task.assign']), ...(over.managerCanReview === false ? [] : ['task.review'])],
    [director.id]: ['task.assign', 'task.review'],
    [OWNER.id]: over.ownerCanReview ? ['task.review'] : [], // view only
    [DEV.id]: [],
    [OTHER_DEV.id]: [],
  };
  const prisma = {
    employee: {
      findUnique: async ({ where }: { where: { id?: string; empId?: string } }) => people.find((p) => p.id === where.id || p.empId === where.empId) ?? null,
      findMany: async ({ where }: { where: { id: { in: string[] } } }) =>
        people.filter((p) => where.id.in.includes(p.id)).map((p) => ({ id: p.id, empId: p.empId, status: p.status, level: { number: p.level } })),
    },
  };
  const routeCalls: string[] = [];
  const approvals = {
    // The first seat above the person (after `after`) who has not left.
    route: async (_requester: string, _day: string, after?: string) => {
      routeCalls.push(after ?? '');
      const start = after ? chain.findIndex((s) => s.empId === after) + 1 : 0;
      const seat = chain.slice(start).find((s) => s.status !== 'left');
      return seat ? { approver: seat.empId, seat: seat.empId } : { approver: null, seat: null };
    },
  };
  const service = new TaskWorkflowService(
    prisma as never,
    { can: async (id: string, key: string) => (permissions[id] ?? []).includes(key) } as never,
    approvals as never,
    {} as never,
    {} as never,
    { now: () => new Date('2026-11-17T10:00:00.000Z') } as never,
    {} as never,
    {} as never,
    { getChain: async () => chain.map((s) => s.id) } as never,
  );
  const task = (over2: { assignedById?: string; assigneeId?: string; personal?: boolean } = {}) => ({
    personal: over2.personal ?? false,
    assigneeId: over2.assigneeId ?? DEV.id,
    assignedById: over2.assignedById ?? manager.id,
    assignee: { empId: DEV.empId },
  });
  return { service, task, manager, routeCalls };
}

describe('who may act as the assigner of a task', () => {
  it('the person who assigned it, while he is here and can assign; nobody above him in his place', async () => {
    const { service, task } = build();
    expect(await service.canActAsAssigner(MANAGER, task())).toBe(true);
    expect(await service.canActAsAssigner(DIRECTOR, task())).toBe(false);
    expect(await service.canActAsAssigner(OWNER, task())).toBe(false);
    expect(await service.canActAsAssigner(OTHER_DEV, task())).toBe(false);
  });

  it('says who acts as the assigner now: the assigner, or once he left the Director, or nobody for a personal to-do', async () => {
    const here = build();
    expect(await here.service.actingAssignerOf(here.task())).toBe(MANAGER.empId);
    expect(await here.service.actingAssignerOf(here.task({ personal: true }))).toBeNull();
    const left = build({ managerStatus: 'left' });
    expect(await left.service.actingAssignerOf(left.task())).toBe(DIRECTOR.empId);
    const cannot = build({ managerCanAssign: false });
    expect(await cannot.service.actingAssignerOf(cannot.task())).toBe(DIRECTOR.empId);
  });

  it('never the person doing the task, and never for a personal to-do', async () => {
    const { service, task } = build();
    expect(await service.canActAsAssigner(DEV, task())).toBe(false);
    expect(await service.canActAsAssigner(MANAGER, task({ personal: true }))).toBe(false);
    expect(await service.canActAsAssigner(DEV, task({ personal: true, assignedById: DEV.id }))).toBe(false);
  });

  it('once the assigner left, the next person up the line who holds task.assign stands in: the Director, never the view-only Owner', async () => {
    const { service, task } = build({ managerStatus: 'left' });
    expect(await service.canActAsAssigner(DIRECTOR, task())).toBe(true);
    expect(await service.canActAsAssigner(OWNER, task())).toBe(false);
    expect(await service.canActAsAssigner(DEV, task())).toBe(false);
    expect(await service.canActAsAssigner(OTHER_DEV, task())).toBe(false);
  });

  it('also when the assigner is still here but lost task.assign: the Director stands in', async () => {
    const { service, task } = build({ managerCanAssign: false });
    expect(await service.canActAsAssigner(MANAGER, task())).toBe(false);
    expect(await service.canActAsAssigner(DIRECTOR, task())).toBe(true);
  });

  it("an assigner who is not in the assignee's line and cannot assign is stood in for by the first person up the assignee's line who can", async () => {
    const { service, task } = build({ managerStatus: 'left' });
    expect(await service.canActAsAssigner(DIRECTOR, task({ assignedById: OTHER_DEV.id }))).toBe(true);
    expect(await service.canActAsAssigner(OWNER, task({ assignedById: OTHER_DEV.id }))).toBe(false);
  });
});

describe("who would ever review a task given to someone (used before a leaver's task moves)", () => {
  it('the assigner, when he is above the new owner', async () => {
    const { service } = build();
    expect(await service.standingReviewerIfDoneBy(DEV, MANAGER.id)).toBe(MANAGER.empId);
    expect(await service.standingReviewerIfDoneBy(DEV, DIRECTOR.id)).toBe(DIRECTOR.empId);
  });

  it("never looks at today's away periods: it does not ask the live route at all", async () => {
    const { service, routeCalls } = build();
    await service.standingReviewerIfDoneBy(DEV, MANAGER.id);
    await service.standingReviewerIfDoneBy(DEV, DIRECTOR.id);
    await service.standingReviewerIfDoneBy(DEV, OWNER.id);
    expect(routeCalls).toEqual([]);
  });

  it('the next level up when the assigner left or can no longer review', async () => {
    const left = build({ managerStatus: 'left' });
    expect(await left.service.standingReviewerIfDoneBy(DEV, MANAGER.id)).toBe(DIRECTOR.empId);
    const cannot = build({ managerCanReview: false });
    expect(await cannot.service.standingReviewerIfDoneBy(DEV, MANAGER.id)).toBe(DIRECTOR.empId);
  });

  it('nobody when everybody from the assigner up has left or cannot review', async () => {
    // a person whose only seat above is the view-only Owner has no reviewer
    const viewOnly = build();
    expect(await viewOnly.service.standingReviewerIfDoneBy(DEV, OWNER.id)).toBeNull();
    const allGone = build({ managerStatus: 'left', directorStatus: 'left' });
    expect(await allGone.service.standingReviewerIfDoneBy(DEV, MANAGER.id)).toBeNull();
  });

  it('the Owner is passed over even when he holds task.review: he only reviews for his direct reports', async () => {
    const { service } = build({ managerStatus: 'left', directorStatus: 'left', ownerCanReview: true });
    expect(await service.standingReviewerIfDoneBy(DEV, MANAGER.id)).toBeNull();
  });

  it('an assigner who is not in the line starts the search at the nearest manager', async () => {
    const { service } = build();
    expect(await service.standingReviewerIfDoneBy(DEV, OTHER_DEV.id)).toBe(MANAGER.empId);
  });
});
