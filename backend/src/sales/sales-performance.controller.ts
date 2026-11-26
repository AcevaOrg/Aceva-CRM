import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  answerSalesProofSchema,
  closeSalesProofSchema,
  requestSalesProofSchema,
  salesDailyLogQuerySchema,
  salesDailyReportQuerySchema,
  salesDashboardQuerySchema,
  salesProofListQuerySchema,
  salesTargetsQuerySchema,
  setSalesDailyTargetsSchema,
  setSalesMonthlyTargetsSchema,
  submitSalesDailyLogSchema,
} from '@aceva/contracts';
import { z } from 'zod';
import type { Actor } from '../access/access.types';
import { ClientInfo, CurrentActor, RequirePermission, type RequestInfo } from '../access/decorators';
import { DAY_PATTERN } from '../common/pakistan-time';
import { createZodDto } from '../common/zod-validation.pipe';
import { SALES_OWN } from './sales-access.service';
import { SalesDailyLogService } from './sales-daily-log.service';
import { SalesDailyReportService } from './sales-daily-report.service';
import { SalesDashboardService } from './sales-dashboard.service';
import { badRequest } from './sales-errors';
import { SalesTargetsService } from './sales-targets.service';

class TargetsQueryDto extends createZodDto(salesTargetsQuerySchema) {}
class SetDailyTargetsDto extends createZodDto(setSalesDailyTargetsSchema) {}
class SetMonthlyTargetsDto extends createZodDto(setSalesMonthlyTargetsSchema) {}
class DailyLogQueryDto extends createZodDto(salesDailyLogQuerySchema) {}
class SubmitDailyLogDto extends createZodDto(submitSalesDailyLogSchema) {}
class RequestProofDto extends createZodDto(requestSalesProofSchema) {}
class AnswerProofDto extends createZodDto(answerSalesProofSchema) {}
class CloseProofDto extends createZodDto(closeSalesProofSchema) {}
class ProofListQueryDto extends createZodDto(salesProofListQuerySchema) {}
class DailyReportQueryDto extends createZodDto(salesDailyReportQuerySchema) {}
class DashboardQueryDto extends createZodDto(salesDashboardQuerySchema.extend({ empId: z.string().optional() })) {}

/** A Pakistan day in a path ("2026-12-08"). */
function day(value: string): string {
  if (!DAY_PATTERN.test(value)) badRequest('validation_failed', 'A day looks like 2026-12-08');
  return value;
}

/**
 * Module 15.6 (plan section 20): targets, the manual daily log, proof requests, the nightly daily report and the dashboard.
 * Every route needs sales.own; the services decide who sees and changes what (own; the team for the sales manager).
 */
@ApiTags('sales')
@Controller('sales/targets')
export class SalesTargetsController {
  constructor(private readonly targets: SalesTargetsService) {}

  @Get()
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: "Daily targets in force today (and any set for later) and a month's targets: own, or the team's (sales manager)" })
  list(@CurrentActor() actor: Actor, @Query() q: TargetsQueryDto) {
    return this.targets.list(actor, q.month);
  }

  @Put('daily')
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: "The sales manager sets a team member's daily targets from a day (today or later); null clears one" })
  setDaily(@CurrentActor() actor: Actor, @Body() body: SetDailyTargetsDto, @ClientInfo() client: RequestInfo) {
    return this.targets.setDaily(actor, body, client);
  }

  @Put('monthly')
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: "The sales manager sets a team member's targets for a month (this month or later); deals won has a currency" })
  setMonthly(@CurrentActor() actor: Actor, @Body() body: SetMonthlyTargetsDto, @ClientInfo() client: RequestInfo) {
    return this.targets.setMonthly(actor, body, client);
  }
}

@ApiTags('sales')
@Controller('sales/daily-logs')
export class SalesDailyLogsController {
  constructor(private readonly logs: SalesDailyLogService) {}

  @Get(':day')
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: "{ log }: a day's log (current version and earlier ones) or null: own, or a team member's for the sales manager" })
  async get(@CurrentActor() actor: Actor, @Param('day') d: string, @Query() q: DailyLogQueryDto) {
    // Wrapped, so that "no log yet" is a JSON answer ({ log: null }) rather than an empty body.
    return { log: await this.logs.get(actor, day(d), q.empId) };
  }

  @Put(':day')
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'Save your own log for today (or yesterday until its report is built): a new version; name the version you read' })
  submit(@CurrentActor() actor: Actor, @Param('day') d: string, @Body() body: SubmitDailyLogDto, @ClientInfo() client: RequestInfo) {
    return this.logs.submit(actor, day(d), body, client);
  }
}

@ApiTags('sales')
@Controller('sales/proof-requests')
export class SalesProofRequestsController {
  constructor(private readonly logs: SalesDailyLogService) {}

  @Get()
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'Proof requests: own, or the team for the sales manager. ?status&empId' })
  list(@CurrentActor() actor: Actor, @Query() q: ProofListQueryDto) {
    return this.logs.proofList(actor, q);
  }

  @Post()
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: "The sales manager asks for proof of a team member's day (the person is notified)" })
  request(@CurrentActor() actor: Actor, @Body() body: RequestProofDto, @ClientInfo() client: RequestInfo) {
    return this.logs.requestProof(actor, body, client);
  }

  @Post(':id/answer')
  @HttpCode(200)
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'The person asked answers (once), for example where the screenshot was sent' })
  answer(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: AnswerProofDto, @ClientInfo() client: RequestInfo) {
    return this.logs.answerProof(actor, id, body.answer, client);
  }

  @Post(':id/close')
  @HttpCode(200)
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'The sales manager closes the request with a note' })
  close(@CurrentActor() actor: Actor, @Param('id', new ParseUUIDPipe()) id: string, @Body() body: CloseProofDto, @ClientInfo() client: RequestInfo) {
    return this.logs.closeProof(actor, id, body.note, client);
  }
}

@ApiTags('sales')
@Controller('sales/reports/daily')
export class SalesDailyReportsController {
  constructor(private readonly reports: SalesDailyReportService) {}

  @Get()
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: "A day's nightly reports, exactly as built: own, or the team's for the sales manager. ?day" })
  list(@CurrentActor() actor: Actor, @Query() q: DailyReportQueryDto) {
    return this.reports.reports(actor, q.day);
  }

  @Get('dates')
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'The days that have reports the caller may see, newest first' })
  dates(@CurrentActor() actor: Actor) {
    return this.reports.dates(actor);
  }
}

@ApiTags('sales')
@Controller('sales')
export class SalesDashboardController {
  constructor(private readonly dashboard: SalesDashboardService) {}

  @Get('dashboard')
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: 'Pipeline, Won and Lost per currency, consecutive stage moves, leads by source and country, and each person’s progress. ?month' })
  get(@CurrentActor() actor: Actor, @Query() q: DashboardQueryDto) {
    return this.dashboard.dashboard(actor, q.month);
  }

  @Get('progress')
  @RequirePermission(SALES_OWN)
  @ApiOperation({ summary: "One person's progress today and this month (own, or a team member's for the sales manager). ?empId" })
  progress(@CurrentActor() actor: Actor, @Query() q: DashboardQueryDto) {
    return this.dashboard.progress(actor, q.empId);
  }
}
