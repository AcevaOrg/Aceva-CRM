import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import type { CreateMeetingInput, MeetingRsvpAnswer, MeetingView, UpdateMeetingInput } from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { AuditService } from '../access/audit.service';
import type { RequestInfo } from '../access/decorators';
import { Clock } from '../common/clock';
import { OutboxService } from '../events/outbox.service';
import { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { commsDb } from './comms-errors';
import { commsFileSelect, toFileView } from './comms-file-view';
import { visibleLinkedTasks } from './comms-task-links';
import { ScopeService } from '../access/scope.service';
import { loadVisibleTask } from '../tasks/task-access';

const DAY = 86_400_000;
/** A meeting may be set up to five minutes in the past (a meeting that is just starting). */
const START_GRACE_MS = 5 * 60_000;

const notFound = (): never => {
  throw new NotFoundException({ statusCode: 404, code: 'not_found', message: 'Meeting not found' });
};
const organizerOnly = (what: string): never => {
  throw new ForbiddenException({ statusCode: 403, code: 'organizer_only', message: `Only the organizer can ${what}` });
};
const cancelled = (): never => {
  throw new ConflictException({ statusCode: 409, code: 'meeting_cancelled', message: 'This meeting was cancelled: it can be read but not changed' });
};

const include = {
  organizer: { select: { empId: true } },
  files: { select: commsFileSelect, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] },
  taskLinks: { select: { taskId: true }, orderBy: { linkedAt: 'asc' } },
  participants: { orderBy: { invitedAt: 'asc' }, select: { rsvp: true, respondedAt: true, employee: { select: { empId: true, fullName: true } } } },
} as const satisfies Prisma.MeetingInclude;
type Row = Prisma.MeetingGetPayload<{ include: typeof include }>;

/**
 * Module 14 meetings (plan section 19: "create a meeting, invite participants, set date/time, share an agenda and attach
 * notes or files"). A meeting is private to its organizer and the people invited: anyone else gets "not found", managers
 * and admins included. The organizer changes it, writes the notes, invites more people and cancels it; invitees answer.
 * Every change is audited WITHOUT the agenda or notes text. Calendar integration needs management approval and is not
 * part of this.
 */
@Injectable()
export class MeetingService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly outbox: OutboxService,
    private readonly clock: Clock,
    private readonly scope: ScopeService,
  ) {}

  async list(actor: Actor, q: { from?: string; to?: string }): Promise<MeetingView[]> {
    const now = this.clock.now().getTime();
    const from = q.from ? new Date(q.from) : new Date(now - 30 * DAY);
    const to = q.to ? new Date(q.to) : new Date(now + 366 * DAY);
    if (to.getTime() - from.getTime() > 400 * DAY || to < from) throw new BadRequestException({ statusCode: 400, code: 'invalid_range', message: 'Choose a range of at most 400 days' });
    const rows = await commsDb(() =>
      this.prisma.meeting.findMany({ where: { AND: [this.visibleWhere(actor), { startsAt: { gte: from, lte: to } }] }, orderBy: [{ startsAt: 'asc' }, { id: 'asc' }], include, take: 500 }),
    );
    return this.views(actor, rows);
  }

  async detail(actor: Actor, id: string): Promise<MeetingView> {
    return (await this.views(actor, [await this.visible(actor, id)]))[0];
  }

  /** Used by the files and links of a meeting: the meeting if the caller is its organizer or invited, else 404. */
  async visible(actor: Actor, id: string, db: Prisma.TransactionClient | PrismaService = this.prisma): Promise<Row> {
    const row = await commsDb(() => db.meeting.findFirst({ where: { AND: [{ id }, this.visibleWhere(actor)] }, include }));
    if (!row) notFound();
    return row!;
  }

  async create(actor: Actor, input: CreateMeetingInput, client: RequestInfo): Promise<MeetingView> {
    const now = this.clock.now();
    const startsAt = new Date(input.startsAt);
    if (startsAt.getTime() < now.getTime() - START_GRACE_MS) throw new BadRequestException({ statusCode: 400, code: 'in_the_past', message: 'Pick a time in the future' });
    const people = await this.activePeople(input.participantEmpIds.filter((e) => e !== actor.empId));
    if (!people.length) throw new BadRequestException({ statusCode: 400, code: 'no_participants', message: 'Invite at least one colleague' });
    const id = await commsDb(() =>
      this.prisma.$transaction(async (tx) => {
        const m = await tx.meeting.create({
          data: { title: input.title, startsAt, durationMin: input.durationMin, location: input.location, agenda: input.agenda, organizerId: actor.id, createdAt: now, updatedAt: now },
          select: { id: true },
        });
        await tx.meetingParticipant.createMany({ data: people.map((p) => ({ meetingId: m.id, employeeId: p.id, invitedById: actor.id, invitedAt: now })) });
        await this.audit.record({ actorId: actor.id, action: 'comms.meeting.created', targetType: 'meeting', targetId: m.id, details: { startsAt: startsAt.toISOString(), durationMin: input.durationMin, invited: people.map((p) => p.empId) }, ...client }, tx);
        await this.outbox.emit({ type: 'comms.meeting.invited', actor: actor.empId, payload: { meetingId: m.id, empIds: people.map((p) => p.empId), byEmpId: actor.empId } }, tx);
        return m.id;
      }),
    );
    return this.detail(actor, id);
  }

  async update(actor: Actor, id: string, input: UpdateMeetingInput, client: RequestInfo): Promise<MeetingView> {
    const row = await this.visible(actor, id);
    if (row.organizerId !== actor.id) organizerOnly('change the meeting');
    if (row.cancelledAt) cancelled();
    const now = this.clock.now();
    if (input.startsAt && new Date(input.startsAt).getTime() < now.getTime() - START_GRACE_MS) {
      throw new BadRequestException({ statusCode: 400, code: 'in_the_past', message: 'Pick a time in the future' });
    }
    const data: Prisma.MeetingUpdateInput = { updatedAt: now };
    if (input.title !== undefined) data.title = input.title;
    if (input.startsAt !== undefined) data.startsAt = new Date(input.startsAt);
    if (input.durationMin !== undefined) data.durationMin = input.durationMin;
    if (input.location !== undefined) data.location = input.location;
    if (input.agenda !== undefined) data.agenda = input.agenda;
    if (input.notes !== undefined) {
      data.notes = input.notes && input.notes.trim() ? input.notes : null;
      data.notesUpdatedAt = now;
      data.notesUpdatedBy = { connect: { id: actor.id } };
    }
    // Which fields changed, never their text (the agenda and notes can be private).
    const changed = (Object.keys(input) as Array<keyof UpdateMeetingInput>).filter((k) => input[k] !== undefined);
    await commsDb(() =>
      this.prisma.$transaction(async (tx) => {
        await tx.meeting.update({ where: { id: row.id }, data });
        await this.audit.record({ actorId: actor.id, action: 'comms.meeting.updated', targetType: 'meeting', targetId: row.id, details: { changed, ...(input.startsAt ? { startsAt: input.startsAt } : {}) }, ...client }, tx);
      }),
    );
    return this.detail(actor, id);
  }

  async invite(actor: Actor, id: string, empIds: string[], client: RequestInfo): Promise<MeetingView> {
    const row = await this.visible(actor, id);
    if (row.organizerId !== actor.id) organizerOnly('invite people');
    if (row.cancelledAt) cancelled();
    const already = new Set(row.participants.map((p) => p.employee.empId));
    const people = (await this.activePeople(empIds.filter((e) => e !== actor.empId))).filter((p) => !already.has(p.empId));
    if (people.length) {
      const now = this.clock.now();
      await commsDb(() =>
        this.prisma.$transaction(async (tx) => {
          await tx.meetingParticipant.createMany({ data: people.map((p) => ({ meetingId: row.id, employeeId: p.id, invitedById: actor.id, invitedAt: now })) });
          await this.audit.record({ actorId: actor.id, action: 'comms.meeting.invited', targetType: 'meeting', targetId: row.id, details: { invited: people.map((p) => p.empId) }, ...client }, tx);
          await this.outbox.emit({ type: 'comms.meeting.invited', actor: actor.empId, payload: { meetingId: row.id, empIds: people.map((p) => p.empId), byEmpId: actor.empId } }, tx);
        }),
      );
    }
    return this.detail(actor, id);
  }

  async rsvp(actor: Actor, id: string, rsvp: MeetingRsvpAnswer): Promise<MeetingView> {
    const row = await this.visible(actor, id);
    if (row.organizerId === actor.id) throw new BadRequestException({ statusCode: 400, code: 'organizer', message: 'You organise this meeting' });
    if (row.cancelledAt) cancelled();
    if (row.startsAt.getTime() + row.durationMin * 60_000 < this.clock.now().getTime()) {
      throw new ConflictException({ statusCode: 409, code: 'meeting_over', message: 'This meeting is over' });
    }
    await commsDb(() =>
      this.prisma.meetingParticipant.update({ where: { meetingId_employeeId: { meetingId: row.id, employeeId: actor.id } }, data: { rsvp, respondedAt: this.clock.now() } }),
    );
    return this.detail(actor, id);
  }

  async cancel(actor: Actor, id: string, reason: string, client: RequestInfo): Promise<MeetingView> {
    const row = await this.visible(actor, id);
    if (row.organizerId !== actor.id) organizerOnly('cancel the meeting');
    if (row.cancelledAt) return this.detail(actor, id);
    const now = this.clock.now();
    await commsDb(() =>
      this.prisma.$transaction(async (tx) => {
        await tx.meeting.update({ where: { id: row.id }, data: { cancelledAt: now, cancelledById: actor.id, updatedAt: now } });
        await this.audit.record({ actorId: actor.id, action: 'comms.meeting.cancelled', targetType: 'meeting', targetId: row.id, reason, ...client }, tx);
        await this.outbox.emit({ type: 'comms.meeting.cancelled', actor: actor.empId, payload: { meetingId: row.id, byEmpId: actor.empId } }, tx);
      }),
    );
    return this.detail(actor, id);
  }

  // ---------- helpers ----------

  private visibleWhere(actor: Actor): Prisma.MeetingWhereInput {
    return { OR: [{ organizerId: actor.id }, { participants: { some: { employeeId: actor.id } } }] };
  }

  /** Current employees by Emp-ID; anyone unknown or gone is refused. */
  private async activePeople(empIds: string[]): Promise<Array<{ id: string; empId: string }>> {
    const unique = [...new Set(empIds)];
    if (!unique.length) return [];
    const rows = await commsDb(() => this.prisma.employee.findMany({ where: { empId: { in: unique }, status: { not: 'left' } }, select: { id: true, empId: true } }));
    const missing = unique.filter((e) => !rows.some((r) => r.empId === e));
    if (missing.length) throw new BadRequestException({ statusCode: 400, code: 'not_current_employee', message: 'Invite current employees only', empIds: missing });
    return rows;
  }

  /** Links a Module 5 task the organizer may see (never a personal to-do). Linking it again changes nothing. */
  async linkTask(actor: Actor, id: string, taskKey: string, client: RequestInfo): Promise<MeetingView> {
    const row = await this.visible(actor, id);
    if (row.organizerId !== actor.id) organizerOnly('link tasks');
    if (row.cancelledAt) cancelled();
    const task = await loadVisibleTask(this.prisma, this.scope, actor, taskKey);
    if (task.personal) throw new BadRequestException({ statusCode: 400, code: 'personal_task', message: 'A personal to-do cannot be linked' });
    await commsDb(() =>
      this.prisma.$transaction(async (tx) => {
        const { count } = await tx.meetingTaskLink.createMany({ data: [{ meetingId: row.id, taskId: task.id, linkedById: actor.id, linkedAt: this.clock.now() }], skipDuplicates: true });
        if (count) await this.audit.record({ actorId: actor.id, action: 'comms.meeting.task_linked', targetType: 'meeting', targetId: row.id, details: { task: task.number }, ...client }, tx);
      }),
    );
    return this.detail(actor, id);
  }

  async unlinkTask(actor: Actor, id: string, taskId: string, client: RequestInfo): Promise<MeetingView> {
    const row = await this.visible(actor, id);
    if (row.organizerId !== actor.id) organizerOnly('unlink tasks');
    if (row.cancelledAt) cancelled();
    await commsDb(() =>
      this.prisma.$transaction(async (tx) => {
        const { count } = await tx.meetingTaskLink.deleteMany({ where: { meetingId: row.id, taskId } });
        if (count) await this.audit.record({ actorId: actor.id, action: 'comms.meeting.task_unlinked', targetType: 'meeting', targetId: row.id, details: { taskId }, ...client }, tx);
      }),
    );
    return this.detail(actor, id);
  }

  /** The screens' view, for this viewer: the linked tasks they may see (Module 5's rule) and how many others are linked. */
  private async views(actor: Actor, rows: Row[]): Promise<MeetingView[]> {
    const seeable = await visibleLinkedTasks(this.prisma, this.scope, actor.id, rows.flatMap((r) => r.taskLinks.map((l) => l.taskId)));
    return rows.map((r) => {
      const view = this.view(actor, r);
      const linked = r.taskLinks.map((l) => seeable.get(l.taskId));
      return { ...view, linkedTasks: linked.filter((t): t is NonNullable<typeof t> => !!t), hiddenLinkedTasks: linked.filter((t) => !t).length };
    });
  }

  private view(actor: Actor, r: Row): Omit<MeetingView, 'linkedTasks' | 'hiddenLinkedTasks'> {
    const organizer = r.organizerId === actor.id;
    const open = !r.cancelledAt;
    const over = r.startsAt.getTime() + r.durationMin * 60_000 < this.clock.now().getTime();
    return {
      id: r.id,
      title: r.title,
      startsAt: r.startsAt.toISOString(),
      durationMin: r.durationMin,
      location: r.location,
      agenda: r.agenda,
      notes: r.notes,
      notesUpdatedAt: r.notesUpdatedAt?.toISOString() ?? null,
      organizerEmpId: r.organizer.empId,
      participants: r.participants.map((p) => ({ empId: p.employee.empId, fullName: p.employee.fullName, rsvp: p.rsvp, respondedAt: p.respondedAt?.toISOString() ?? null })),
      cancelled: !open,
      cancelledAt: r.cancelledAt?.toISOString() ?? null,
      attachments: r.files.map(toFileView),
      can: { edit: organizer && open, invite: organizer && open, cancel: organizer && open, rsvp: !organizer && open && !over, addFiles: organizer && open },
    };
  }
}
