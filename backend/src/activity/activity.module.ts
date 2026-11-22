import { Module } from '@nestjs/common';
import { APP_FILTER, APP_INTERCEPTOR } from '@nestjs/core';
import { ActionRecorderInterceptor } from './action-recorder.interceptor';
import { ActivityAlertsService } from './activity-alerts.service';
import { ActivityConsumers } from './activity-consumers.service';
import { ActivityControlsService } from './activity-controls.service';
import { ActivityControlsController, ActivityController } from './activity.controller';
import { ActivityRecorder } from './activity-recorder.service';
import { ActivityService } from './activity.service';
import { ActivitySummaryHooks, ActivitySummaryService } from './activity-summary.service';
import { BlockedAttemptFilter } from './blocked-attempt.filter';

/**
 * Module 4: employee activity tracking (plan section 8). See docs/M4-ACCEPTANCE.md.
 *
 * Not global on purpose: Nest shuts modules down in reverse order and global modules (the database connection) last,
 * so the recorder writes its last buffered records while the database is still open. Later modules that want to record
 * something themselves, or to feed the daily summary (Module 5 tasks touched, Module 7 check-ins), import ActivityModule
 * and inject ActivityRecorder or ActivitySummaryHooks.
 */
@Module({
  controllers: [ActivityController, ActivityControlsController],
  providers: [
    ActivityRecorder,
    ActivityService,
    ActivityAlertsService,
    ActivityControlsService,
    ActivitySummaryService,
    ActivitySummaryHooks,
    ActivityConsumers,
    // The action recorder sees every request of every module, and every refused attempt.
    { provide: APP_INTERCEPTOR, useClass: ActionRecorderInterceptor },
    { provide: APP_FILTER, useClass: BlockedAttemptFilter },
  ],
  exports: [ActivityRecorder, ActivitySummaryHooks],
})
export class ActivityModule {}
