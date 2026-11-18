import { Module } from '@nestjs/common';
import { OrgModule } from '../org/org.module';
import { ATTENDANCE_SOURCE, NotBuiltAttendanceSource } from './attendance-source';
import { PerformanceApprovalsProvider } from './performance-approvals.provider';
import { PerformanceCalculator } from './performance-calculator.service';
import { PerformanceConsumers } from './performance-consumers.service';
import { PerformanceDirectory } from './performance-directory.service';
import { PerformanceMail } from './performance-mail.service';
import { DisputesController, PerformanceController, ScoreWeightsController, ScorecardsController } from './performance.controller';
import { PerformanceService } from './performance.service';
import { SALES_SOURCE, NotBuiltSalesSource } from './sales-source';
import { ScorecardMonthly } from './scorecard-monthly.service';
import { ScoreWeightsService } from './score-weights.service';
import { DisputesService } from './disputes.service';
import { ScorecardsService } from './scorecards.service';

/**
 * Module 6: performance and results (plan section 10, spec 9.6).
 *
 * Shared (foundation): rules/* (pure rules), performance-data.ts (mappers, errors, event payloads), performance-directory.service
 *   (who is who: reviewer, decider), performance-calculator.service (the one place that works out figures for a month).
 * Core: performance.controller (four controllers: /performance, /scorecards, /disputes, /settings/score-weights),
 *   performance.service (live, team), scorecards.service, disputes.service, score-weights.service, performance-approvals.provider.
 * Automation: scorecard-monthly.service (the monthly job), performance-mail.service, performance-consumers.service, and the two
 *   stand-ins attendance-source.ts (Module 7) and sales-source.ts (Module 15): they never invent a number.
 *
 * Imports OrgModule for the approvals inbox. The outbox dispatcher, job runner, clock, mailer, audit log, scope and permission
 * services are global. Module 7 / Module 15 replace the two source providers below (no other change).
 */
@Module({
  imports: [OrgModule],
  controllers: [PerformanceController, ScorecardsController, DisputesController, ScoreWeightsController],
  providers: [
    PerformanceDirectory,
    PerformanceCalculator,
    PerformanceService,
    ScorecardsService,
    DisputesService,
    ScoreWeightsService,
    PerformanceApprovalsProvider,
    ScorecardMonthly,
    PerformanceMail,
    PerformanceConsumers,
    // The attendance and sales figures: stand-ins until Modules 7 and 15 exist (they answer "not available", never a made-up number).
    { provide: ATTENDANCE_SOURCE, useClass: NotBuiltAttendanceSource },
    { provide: SALES_SOURCE, useClass: NotBuiltSalesSource },
  ],
  exports: [PerformanceCalculator, PerformanceDirectory, ScorecardsService, DisputesService, ScoreWeightsService],
})
export class PerformanceModule {}
