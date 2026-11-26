import type { LinkedTaskView } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import type { ScopeService } from '../access/scope.service';
import type { Prisma } from '../generated/prisma/client';
import type { PrismaService } from '../prisma/prisma.service';
import { visibleTaskWhere } from '../tasks/task-access';

type Db = PrismaService | Prisma.TransactionClient;

/**
 * Module 14 links to Module 5 tasks follow the Module 5 visibility rule exactly (visibleTaskWhere: the person doing it,
 * the person who assigned it and everyone above the assignee; a personal to-do only its owner). For one viewer, the
 * linked tasks they may see, by task id. Tasks they may not see are simply missing: the screens say "a task you can't
 * open" and nothing else (no number, no title).
 */
export async function visibleLinkedTasks(db: Db, scope: ScopeService, viewerId: string, taskIds: readonly string[]): Promise<Map<string, LinkedTaskView>> {
  const out = new Map<string, LinkedTaskView>();
  const ids = [...new Set(taskIds)];
  if (!ids.length) return out;
  const viewer = { id: viewerId } as Actor; // visibleTaskWhere reads only the id
  const rows = await db.task.findMany({ where: { AND: [{ id: { in: ids } }, visibleTaskWhere(viewer, scope)] }, select: { id: true, number: true, title: true, status: true } });
  for (const r of rows) out.set(r.id, { id: r.id, number: r.number, title: r.title, status: r.status });
  return out;
}
