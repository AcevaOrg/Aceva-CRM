import { Injectable, OnModuleInit } from '@nestjs/common';
import { OutboxDispatcher } from '../events/outbox-dispatcher.service';
import { TaskHandover } from './task-handover.service';
import { TaskMail } from './task-mail.service';
import { TaskReminders } from './task-reminders.service';
import { TaskRepeat } from './task-repeat.service';

/**
 * Module 5's outbox consumers, registered on the shared OutboxDispatcher (see the contract in
 * events/outbox-dispatcher.service.ts: every handle() must be IDEMPOTENT; throwing means "retry later"). Keep the consumer
 * NAMES: deliveries are recorded per consumer name, and a renamed consumer would receive old events again:
 *
 *   tasks.reminders  task.created, task.status_changed, task.deadline_changed, task.transferred  ->  TaskReminders.sync(taskId)
 *                    (the schedule is worked out from the task's CURRENT state, so the payload only says which task)
 *   tasks.repeat     task.created with a repeatRuleId  ->  TaskRepeat.arm(ruleId)
 *   tasks.handover   task.transfer.requested (Module 3)  ->  TaskHandover.transfer(fromEmpId, toEmpId, event id)
 *   tasks.mail       task.created, task.reminder.due, task.comment_added, task.status_changed,
 *                    task.extension_requested, task.extension_decided  ->  TaskMail
 *
 * Events the core writes (task.approved, task.reworked, ...) that nobody here needs are simply not listed; Module 6
 * will consume them.
 */
@Injectable()
export class TaskConsumers implements OnModuleInit {
  constructor(
    private readonly dispatcher: OutboxDispatcher,
    private readonly reminders: TaskReminders,
    private readonly repeat: TaskRepeat,
    private readonly handover: TaskHandover,
    private readonly mail: TaskMail,
  ) {}

  onModuleInit(): void {
    this.dispatcher.register({
      name: 'tasks.reminders',
      handles: [
        { type: 'task.created', version: 1 },
        { type: 'task.status_changed', version: 1 },
        { type: 'task.deadline_changed', version: 1 },
        { type: 'task.transferred', version: 1 },
      ],
      handle: async (event) => {
        if (event.type === 'task.created' || event.type === 'task.status_changed' || event.type === 'task.deadline_changed' || event.type === 'task.transferred') {
          await this.reminders.sync(event.payload.taskId);
        }
      },
    });

    this.dispatcher.register({
      name: 'tasks.repeat',
      handles: [{ type: 'task.created', version: 1 }],
      handle: async (event) => {
        if (event.type === 'task.created' && event.payload.repeatRuleId) await this.repeat.arm(event.payload.repeatRuleId);
      },
    });

    this.dispatcher.register({
      name: 'tasks.handover',
      handles: [{ type: 'task.transfer.requested', version: 1 }],
      handle: async (event) => {
        if (event.type === 'task.transfer.requested') await this.handover.transfer(event.payload.fromEmpId, event.payload.toEmpId, event.id);
      },
    });

    this.dispatcher.register({
      name: 'tasks.mail',
      handles: [
        { type: 'task.created', version: 1 },
        { type: 'task.reminder.due', version: 1 },
        { type: 'task.comment_added', version: 1 },
        { type: 'task.status_changed', version: 1 },
        { type: 'task.extension_requested', version: 1 },
        { type: 'task.extension_decided', version: 1 },
      ],
      handle: async (event) => {
        switch (event.type) {
          case 'task.created':
            return this.mail.assigned(event);
          case 'task.reminder.due':
            return this.mail.reminder(event);
          case 'task.comment_added':
            return this.mail.mentions(event);
          case 'task.status_changed':
            return this.mail.statusChanged(event);
          case 'task.extension_requested':
          case 'task.extension_decided':
            return this.mail.extension(event);
          default:
            return;
        }
      },
    });
  }
}
