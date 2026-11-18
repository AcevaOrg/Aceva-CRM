import { Module } from '@nestjs/common';
import { ActivityModule } from '../activity/activity.module';
import { ENV } from '../config/config.module';
import type { Env } from '../config/env';
import { OrgModule } from '../org/org.module';
import { FILE_STORAGE } from '../storage/file-storage';
import { LocalFileStorage } from '../storage/local-file-storage';
import { TaskActivity } from './task-activity.service';
import { TaskApprovalsProvider } from './task-approvals.provider';
import { TaskCommentsService } from './task-comments.service';
import { TaskConsumers } from './task-consumers.service';
import { TaskExtensionsController } from './task-extensions.controller';
import { TaskHandover } from './task-handover.service';
import { TaskMail } from './task-mail.service';
import { TaskReminders } from './task-reminders.service';
import { TaskRepeat } from './task-repeat.service';
import { TaskSettingsController } from './task-settings.controller';
import { TaskSettingsService } from './task-settings.service';
import { TaskWorkflowService } from './task-workflow.service';
import { TasksController } from './tasks.controller';
import { TasksService } from './tasks.service';

/**
 * Module 5: task management, size and deadline (plan section 9, spec 9.5).
 *
 * Core (tasks, assigning, status flow, reviews, extensions, comments, files, settings, approvals items):
 *   tasks.controller, task-extensions.controller, task-settings.controller, tasks.service, task-workflow.service,
 *   task-comments.service, task-settings.service, task-approvals.provider.
 * Automation (reminders, repeating tasks, leaver hand-over, mails, daily-summary hook): task-reminders.service,
 *   task-repeat.service, task-handover.service, task-mail.service, task-activity.service, task-consumers.service.
 * Shared: rules/* (pure rules), task-data.ts (mappers, numbers, history, event payloads).
 *
 * Imports ActivityModule for the daily-summary hook and OrgModule for ApprovalsService and the approvals inbox. The
 * outbox dispatcher, job runner, clock, mailer and audit log are global.
 */
@Module({
  imports: [OrgModule, ActivityModule],
  controllers: [TasksController, TaskExtensionsController, TaskSettingsController],
  providers: [
    TaskSettingsService,
    TaskWorkflowService,
    TasksService,
    TaskCommentsService,
    TaskApprovalsProvider,
    TaskReminders,
    TaskRepeat,
    TaskHandover,
    TaskMail,
    TaskActivity,
    TaskConsumers,
    // Private file storage for task files: the same folder and rules as employee documents (Module 3).
    { provide: FILE_STORAGE, inject: [ENV], useFactory: (env: Env) => new LocalFileStorage(env.FILE_STORAGE_ROOT) },
  ],
  exports: [TasksService, TaskWorkflowService, TaskSettingsService, TaskReminders],
})
export class TasksModule {}
