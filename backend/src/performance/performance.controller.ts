import { Body, Controller, Get, HttpCode, Param, ParseUUIDPipe, Post, Query } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  acknowledgeScorecardRequestSchema,
  decideDisputeRequestSchema,
  disputeListQuerySchema,
  liveQuerySchema,
  raiseDisputeRequestSchema,
  releaseScorecardRequestSchema,
  saveScoreWeightsRequestSchema,
  scorecardListQuerySchema,
  scorecardRemarkRequestSchema,
  scoreWeightsQuerySchema,
} from '@aceva/contracts';
import type { Actor } from '../access/access.types';
import { Authenticated, ClientInfo, CurrentActor, RequestInfo, RequirePermission } from '../access/decorators';
import { createZodDto } from '../common/zod-validation.pipe';
import { DisputesService } from './disputes.service';
import { PerformanceService } from './performance.service';
import { ScoreWeightsService } from './score-weights.service';
import { ScorecardsService } from './scorecards.service';

class LiveQueryDto extends createZodDto(liveQuerySchema) {}
class ScorecardListQueryDto extends createZodDto(scorecardListQuerySchema) {}
class ScorecardRemarkDto extends createZodDto(scorecardRemarkRequestSchema) {}
class ReleaseScorecardDto extends createZodDto(releaseScorecardRequestSchema) {}
class AcknowledgeScorecardDto extends createZodDto(acknowledgeScorecardRequestSchema) {}
class DisputeListQueryDto extends createZodDto(disputeListQuerySchema) {}
class RaiseDisputeDto extends createZodDto(raiseDisputeRequestSchema) {}
class DecideDisputeDto extends createZodDto(decideDisputeRequestSchema) {}
class ScoreWeightsQueryDto extends createZodDto(scoreWeightsQuerySchema) {}
class SaveScoreWeightsDto extends createZodDto(saveScoreWeightsRequestSchema) {}

/**
 * Module 6 routes (spec 9.6). The paths and the response shapes are the frontend's contract
 * (packages/contracts/src/performance.ts). The route-level permission is the entry ticket; the SERVICES decide per scorecard
 * and per dispute who may do what (the reviewer, the employee, the decider, people above), because the same person plays
 * different parts on different scorecards. Four controllers in one file: the foundation wrote them with the final routes,
 * the core builder adjusts only if a rule needs it.
 */
@ApiTags('performance')
@Controller('performance')
export class PerformanceController {
  constructor(private readonly performance: PerformanceService) {}

  @Get('live')
  @RequirePermission('performance.view_own')
  @ApiOperation({ summary: "This month's live figures for a person (default: me): metrics, score, band, 6-month trend, tasks. Me, or someone below me." })
  live(@CurrentActor() actor: Actor, @Query() query: LiveQueryDto) {
    return this.performance.live(actor, query);
  }

  @Get('team')
  @RequirePermission('performance.view_team')
  @ApiOperation({ summary: 'The people below me side by side, sorted by name (never by score: there is no ranking)' })
  team(@CurrentActor() actor: Actor) {
    return this.performance.team(actor);
  }
}

@ApiTags('performance')
@Controller('scorecards')
export class ScorecardsController {
  constructor(private readonly scorecards: ScorecardsService) {}

  @Get()
  @RequirePermission('performance.view_own')
  @ApiOperation({ summary: "A person's monthly scorecards, newest first (latest=1: the newest only). The person sees released ones only; people above also see drafts." })
  list(@CurrentActor() actor: Actor, @Query() query: ScorecardListQueryDto) {
    return this.scorecards.list(actor, query);
  }

  @Get(':id')
  @RequirePermission('performance.view_own')
  @ApiOperation({ summary: 'One scorecard with the weights version it was made with, its disputes and its remark history (404 when not visible)' })
  get(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string) {
    return this.scorecards.get(actor, id);
  }

  @Post(':id/remark')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'The reviewer adds a remark (never changes the numbers)' })
  remark(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: ScorecardRemarkDto, @ClientInfo() client: RequestInfo) {
    return this.scorecards.addRemark(actor, id, body.remark, client);
  }

  @Post(':id/release')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: "The reviewer (the person's manager, or the next level up who reviews work) releases a draft to the employee, optionally with a remark. Nobody releases their own." })
  release(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: ReleaseScorecardDto, @ClientInfo() client: RequestInfo) {
    return this.scorecards.release(actor, id, body.remark, client);
  }

  @Post(':id/acknowledge')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'The employee acknowledges a released scorecard, with an optional comment' })
  acknowledge(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: AcknowledgeScorecardDto, @ClientInfo() client: RequestInfo) {
    return this.scorecards.acknowledge(actor, id, body.comment, client);
  }
}

@ApiTags('performance')
@Controller('disputes')
export class DisputesController {
  constructor(private readonly disputes: DisputesService) {}

  @Get()
  @RequirePermission('performance.view_own')
  @ApiOperation({ summary: 'Rating disputes I raised, must decide, or that belong to people below me' })
  list(@CurrentActor() actor: Actor, @Query() query: DisputeListQueryDto) {
    return this.disputes.list(actor, query);
  }

  @Post()
  @Authenticated()
  @ApiOperation({ summary: 'Dispute the rating of one task on my own released scorecard (one open dispute per task)' })
  raise(@CurrentActor() actor: Actor, @Body() body: RaiseDisputeDto, @ClientInfo() client: RequestInfo) {
    return this.disputes.raise(actor, body, client);
  }

  @Post(':id/decide')
  @Authenticated()
  @HttpCode(200)
  @ApiOperation({ summary: 'The decider upholds the rating or changes it (1 to 5); a change recomputes the scorecard with its original weights version' })
  decide(@CurrentActor() actor: Actor, @Param('id', ParseUUIDPipe) id: string, @Body() body: DecideDisputeDto, @ClientInfo() client: RequestInfo) {
    return this.disputes.decide(actor, id, body, client);
  }
}

@ApiTags('settings')
@Controller('settings/score-weights')
export class ScoreWeightsController {
  constructor(private readonly weights: ScoreWeightsService) {}

  @Get()
  @RequirePermission('settings.view')
  @ApiOperation({ summary: 'Every version of the score weights, newest first (whole percents that add up to 100)' })
  list(@CurrentActor() actor: Actor, @Query() query: ScoreWeightsQueryDto) {
    return this.weights.list(actor, query);
  }

  @Post()
  @RequirePermission('performance.weights')
  @ApiOperation({ summary: 'The Director saves a NEW version of the weights (sum exactly 100; old scorecards keep theirs). Audited.' })
  save(@CurrentActor() actor: Actor, @Body() body: SaveScoreWeightsDto, @ClientInfo() client: RequestInfo) {
    return this.weights.save(actor, body, client);
  }
}
